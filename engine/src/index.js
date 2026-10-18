#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { analyzeSql } from './classify.js';
import {
  countConnections,
  findConnection,
  isConnectionAllowed,
  listConnections,
  listEnabledConnections,
  loadConfig,
  migrateLegacyPasswords
} from './config.js';
import { appendExecutionLog } from './exec-logs.js';
import { disposeAllResources, executeSql, sanitizeErrorMessage, testConnection } from './executor.js';
import { findAppDaemon, registerInstance, unregisterInstance } from './instances.js';
import { log, logError } from './logger.js';
import { getDbObjects } from './objects.js';
import { disposeReviewDialogs, ensureReviewSurface, killReviewDialog, openBrowser } from './openBrowser.js';
import { ReviewManager } from './reviews.js';
import { getAppSettings } from './settings.js';
import { WebUI } from './server.js';
import { VERSION } from './version.js';
import { readEnv } from './paths.js';

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};

const SERVE_ONLY = args.includes('--serve');
const PARENT_PID = Number(argValue('--parent-pid')) || null;
const INSTANCE_LABEL = argValue('--label') ?? readEnv('INSTANCE_LABEL') ?? null;
const PREFERRED_PORT = Number.parseInt(argValue('--port') ?? readEnv('PORT') ?? '4788', 10);
const REVIEW_TIMEOUT_MS = Number.parseInt(readEnv('REVIEW_TIMEOUT_MS') ?? '600000', 10);

const reviews = new ReviewManager({ defaultTimeoutMs: REVIEW_TIMEOUT_MS });
const web = new WebUI({ reviews, onConnectionTest: testConnection });

function shutdown(code = 0) {
  unregisterInstance();
  disposeReviewDialogs();
  disposeAllResources().finally(() => process.exit(code));
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => disposeReviewDialogs());

if (PARENT_PID) {
  const timer = setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch {
      log(`Parent process ${PARENT_PID} is gone; shutting down`);
      shutdown(0);
    }
  }, 3000);
  timer.unref?.();
}

await web.start(PREFERRED_PORT);
registerInstance({
  mode: SERVE_ONLY ? 'serve' : 'stdio',
  port: web.port,
  token: web.token,
  label: INSTANCE_LABEL,
  entry: process.argv[1],
  version: VERSION
});

try {
  const legacy = migrateLegacyPasswords();
  if (legacy.migrated > 0) {
    log(`Cleared ${legacy.migrated} credential(s) from a retired encryption scheme — re-enter those passwords in the LAZY SQL app`);
  }
} catch (error) {
  logError('Legacy credential check failed', error);
}

if (SERVE_ONLY) {
  log(`LAZY SQL daemon ready (serve mode). Local API on ${web.baseUrl()}`);
} else {
  await startMcp();
}

async function startMcp() {
  const server = new McpServer({ name: 'lazy-sql', version: VERSION });

  const DEFAULT_WAIT_MS = 45000;
  const MAX_WAIT_MS = 55000;
  const REVIEW_POLL_HINT =
    'The review is open in the LAZY SQL desktop app (or your browser as a fallback). After the user approves or rejects it, call execute_sql again with only { "reviewId": "<id>" } (do not resend the sql) to fetch the outcome.';

  function textResult(payload, isError = false) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function resolveConnection(ref) {
    const enabled = listEnabledConnections();
    const all = listConnections();
    if (all.length === 0) {
      return {
        error: {
          status: 'no_connection',
          message:
            'No database connection is configured yet. Ask the user whether they want to configure one; if they agree, call open_db_config to open the connection manager.',
          next: 'open_db_config'
        }
      };
    }
    if (enabled.length === 0) {
      const hidden = all.filter((connection) => !connection.enabled || !isConnectionAllowed(connection));
      return {
        error: {
          status: 'no_connection',
          message: `${hidden.length} connection(s) exist but none is enabled for this session (disabled in LAZY SQL or filtered by LAZY_SQL_ALLOWED_CONNECTIONS). Ask the user to enable one in the LAZY SQL app, or call open_db_config.`,
          next: 'open_db_config'
        }
      };
    }
    if (!ref) {
      if (enabled.length === 1) {
        const connection = findConnection(enabled[0].id);
        return { connection };
      }
      return {
        error: {
          status: 'missing_connection',
          message: 'Multiple connections are enabled; pass the "connection" argument to pick one.',
          availableConnections: enabled.map((c) => c.name)
        }
      };
    }
    const connection = findConnection(ref);
    if (!connection) {
      return {
        error: {
          status: 'unknown_connection',
          message: `No connection named "${ref}" was found. Available: ${enabled.map((c) => c.name).join(', ')}. Call open_db_config to add one.`,
          availableConnections: enabled.map((c) => c.name)
        }
      };
    }
    if (connection.enabled === false || !isConnectionAllowed(connection)) {
      return {
        error: {
          status: 'disabled_connection',
          message: `Connection "${connection.name}" is disabled for this session (disabled in LAZY SQL or filtered by LAZY_SQL_ALLOWED_CONNECTIONS). Ask the user to enable it, or call open_db_config.`
        }
      };
    }
    return { connection };
  }

  async function awaitReviewOutcome(session, waitMs) {
    const deadline = Date.now() + waitMs;
    while (session.status === 'pending' && Date.now() < deadline) {
      await Promise.race([session.decisionPromise, sleep(Math.max(deadline - Date.now(), 1))]);
    }
    if (session.status === 'pending') return { outcome: 'pending' };
    if (session.status === 'rejected') return { outcome: 'rejected' };
    if (session.status === 'timeout') return { outcome: 'review_timeout' };
    while (['approved', 'running'].includes(session.status) && Date.now() < deadline) {
      await Promise.race([session.completionPromise, sleep(Math.max(deadline - Date.now(), 1))]);
    }
    if (session.status === 'done') return { outcome: 'done', result: session.result };
    if (session.status === 'error') return { outcome: 'error', message: session.error };
    return { outcome: 'running' };
  }

  function outcomeToResult(outcome, session) {
    if (outcome.outcome === 'done') return outcome.result;
    if (outcome.outcome === 'error') {
      return { status: 'error', connection: session.connection?.name ?? null, sql: session.sql, message: outcome.message };
    }
    if (outcome.outcome === 'rejected') {
      return { status: 'rejected', message: 'The user rejected the SQL in the review dialog. Nothing was executed.' };
    }
    if (outcome.outcome === 'review_timeout') {
      return { status: 'review_timeout', message: 'The user did not approve the SQL in time. Nothing was executed.' };
    }
    if (outcome.outcome === 'running') {
      return { status: 'running', reviewId: session.id, message: `The SQL was approved and is still executing. ${REVIEW_POLL_HINT}` };
    }
    return { status: 'pending_review', reviewId: session.id, sql: session.sql, message: REVIEW_POLL_HINT };
  }

  function connectionTarget(connection) {
    return connection.engine === 'sqlite'
      ? connection.file
      : `${connection.host}:${connection.port}/${connection.database}`;
  }

  function logExecution(entry) {
    try {
      appendExecutionLog(entry);
    } catch (error) {
      logError('Failed to write the execution log', error);
    }
  }

  function trackReviewLifecycle(session, { connection, params, maxRows, dialog }) {
    session.decisionPromise
      .then(async (decision) => {
        const base = {
          reviewId: session.id,
          reviewed: true,
          purpose: session.purpose ?? null,
          sql: session.sql,
          params: session.params,
          connection: { name: connection.name, engine: connection.engine, target: connectionTarget(connection) }
        };

        if (decision.action === 'reject') {
          // the dialog has nothing left to show — close it with the decision
          killReviewDialog(dialog);
          logExecution({
            ...base,
            status: 'rejected',
            message: 'The user rejected the SQL in the review dialog. Nothing was executed.'
          });
          return;
        }
        if (decision.action === 'timeout') {
          killReviewDialog(dialog);
          logExecution({
            ...base,
            status: 'review_timeout',
            message: 'The user did not approve the SQL in time. Nothing was executed.'
          });
          return;
        }
        if (decision.action !== 'approve') return;

        reviews.markRunning(session.id);
        try {
          const result = await executeSql({ connection, sql: session.sql, params, maxRows });
          result.sql = session.sql;
          result.reviewed = true;
          reviews.attachResult(session.id, result);
          logExecution({
            ...base,
            status: 'ok',
            statementTypes: result.statementTypes,
            durationMs: result.durationMs,
            rowsReturned: result.rowsReturned,
            totalRows: result.totalRows,
            truncated: Boolean(result.truncated),
            responsePreview: JSON.stringify(result, null, 2)
          });
          log(`Review ${session.id} approved and executed in ${result.durationMs} ms (${result.rowsReturned} rows)`);
        } catch (error) {
          const message = sanitizeErrorMessage(error, connection);
          reviews.attachError(session.id, message);
          logExecution({ ...base, status: 'error', message });
          logError(`Query failed after approval (review ${session.id})`, error);
        }
      })
      .catch((error) => logError(`Review execution chain failed (${session.id})`, error));
  }

  server.registerTool(
    'execute_sql',
    {
      title: 'Execute SQL (with review dialog for changes)',
      description:
        'Execute a SQL statement against a configured database connection. Read-only statements (SELECT / WITH…SELECT / SHOW / EXPLAIN / PRAGMA / DESCRIBE) run immediately without any popup. Statements that modify data or schema (INSERT/UPDATE/DELETE/MERGE/DDL, stored-procedure CALLs, anything unclear) ALWAYS open a review dialog in the LAZY SQL desktop app first (browser fallback): nothing runs until the user approves, and they can edit or reject the SQL. Results are capped per statement (maxRows, default 200) and by a total response-size budget. IMPORTANT follow-up: if the response has status "pending_review" (the user is still reviewing) or "running", call execute_sql again passing ONLY the returned reviewId to fetch the outcome. If it returns "no_connection", ask the user whether they want to configure a database and, if they agree, call open_db_config.',
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The SQL to execute (required unless resuming with reviewId). Use driver placeholders ($1 for PostgreSQL, ? for MySQL/SQL Server/SQLite) when passing params.'
          ),
        reviewId: z
          .string()
          .optional()
          .describe('Resume a review that returned status "pending_review" or "running". Pass only the reviewId (and optionally waitMs) — do not pass sql again.'),
        connection: z.string().optional().describe('Connection name or id. Optional when only one connection is enabled.'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe('Positional parameters matching the placeholders in the SQL. Only supported for a single statement.'),
        maxRows: z.number().int().min(1).max(5000).optional().describe('Maximum rows returned per result set (default 200, max 5000).'),
        purpose: z.string().optional().describe('Short explanation of why this query runs; shown in the review dialog (only for statements that need review).'),
        reviewTimeoutMs: z
          .number()
          .int()
          .min(5000)
          .max(3600000)
          .optional()
          .describe('How long the review waits for the user before auto-rejecting (default from LAZY SQL settings, 10 minutes).'),
        waitMs: z
          .number()
          .int()
          .min(1000)
          .max(55000)
          .optional()
          .describe('How long this call waits for the decision/result before returning pending_review or running (default 45000 ms).')
      }
    },
    async ({ sql, reviewId, connection: connectionRef, params, maxRows, purpose, reviewTimeoutMs, waitMs }) => {
      try {
        const effectiveWait = Math.min(Math.max(waitMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);

        if (reviewId) {
          const session = reviews.get(reviewId);
          if (!session) {
            return textResult(
              { status: 'error', message: `No review with id "${reviewId}" was found. It may have expired — start a new execute_sql call.` },
              true
            );
          }
          const outcome = await awaitReviewOutcome(session, effectiveWait);
          const payload = outcomeToResult(outcome, session);
          return textResult(payload, payload.status === 'error');
        }

        if (!sql || !sql.trim()) {
          return textResult({ status: 'error', message: 'The SQL is empty.' }, true);
        }

        const resolved = resolveConnection(connectionRef);
        if (resolved.error) return textResult(resolved.error);
        const connection = resolved.connection;

        const analysis = analyzeSql(sql);
        if (analysis.count === 0) {
          return textResult({ status: 'error', message: 'The SQL is empty.' }, true);
        }
        if (connection.readOnly && !analysis.isReadOnly) {
          const payload = {
            status: 'blocked',
            message: `Connection "${connection.name}" is read-only and this statement (${analysis.summary}) is not a read query. Nothing was executed.`
          };
          logExecution({
            status: 'blocked',
            reviewed: true,
            sql,
            params: params ?? [],
            statementTypes: analysis.summary,
            connection: { name: connection.name, engine: connection.engine, target: connectionTarget(connection) },
            message: payload.message
          });
          return textResult(payload);
        }

        if (analysis.isReadOnly) {
          try {
            const result = await executeSql({ connection, sql, params, maxRows });
            result.sql = sql;
            result.reviewed = false;
            logExecution({
              status: 'ok',
              reviewed: false,
              sql,
              params: params ?? [],
              statementTypes: analysis.summary,
              connection: { name: connection.name, engine: connection.engine, target: connectionTarget(connection) },
              durationMs: result.durationMs,
              rowsReturned: result.rowsReturned,
              totalRows: result.totalRows,
              truncated: Boolean(result.truncated),
              responsePreview: JSON.stringify(result, null, 2)
            });
            log(`Read-only query ran directly on ${connection.name} (${analysis.summary}, ${result.durationMs} ms, ${result.rowsReturned} rows)`);
            return textResult(result);
          } catch (error) {
            const message = sanitizeErrorMessage(error, connection);
            logExecution({
              status: 'error',
              reviewed: false,
              sql,
              params: params ?? [],
              statementTypes: analysis.summary,
              connection: { name: connection.name, engine: connection.engine, target: connectionTarget(connection) },
              message
            });
            logError('Read-only query failed', error);
            return textResult({ status: 'error', connection: connection.name, sql, message }, true);
          }
        }

        const effectiveTimeout = reviewTimeoutMs ?? getAppSettings().reviewTimeoutMs;
        const session = reviews.create({ sql, params, purpose, connection, timeoutMs: effectiveTimeout });
        const surface = ensureReviewSurface({
          pageUrl: web.pageUrl(`/review/${session.id}`),
          base: web.baseUrl(),
          token: web.token,
          reviewId: session.id
        });
        trackReviewLifecycle(session, { connection, params, maxRows, dialog: surface.child ?? null });
        log(`Review ${session.id} (${connection.name}, ${analysis.summary}) surfaced via ${surface.target} at ${web.pageUrl(`/review/${session.id}`)}`);

        const outcome = await awaitReviewOutcome(session, effectiveWait);
        const payload = outcomeToResult(outcome, session);
        return textResult(payload, payload.status === 'error');
      } catch (error) {
        logError('execute_sql failed', error);
        return textResult({ status: 'error', message: String(error?.message ?? error) }, true);
      }
    }
  );

  server.registerTool(
    'get_db_objects',
    {
      title: 'Get database objects',
      description:
        'List or describe database objects (tables, views, functions, stored procedures, triggers, columns, keys, indexes) of a configured connection. Read-only metadata, no approval popup. Call without "name" to list objects (optionally filtered by objectType and a name substring); call with "name" to get full details of one object.',
      inputSchema: {
        connection: z.string().optional().describe('Connection name or id. Optional when only one connection is enabled.'),
        objectType: z
          .enum(['all', 'table', 'view', 'function', 'procedure', 'trigger'])
          .optional()
          .describe('Filter the listing to one kind of object (default all).'),
        name: z.string().optional().describe('Exact object name to fetch details for (columns, keys, indexes, definition).'),
        schema: z.string().optional().describe('Schema/database of the object, when known.'),
        filter: z.string().optional().describe('Case-insensitive substring filter applied to object names in list mode.'),
        includeDefinition: z
          .boolean()
          .optional()
          .describe('Include the object definition (view SQL, function/procedure body) in detail mode.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max objects listed (default 200).')
      }
    },
    async ({ connection: connectionRef, objectType, name, schema, filter, includeDefinition, limit }) => {
      try {
        const resolved = resolveConnection(connectionRef);
        if (resolved.error) return textResult(resolved.error);
        const result = await getDbObjects({
          connection: resolved.connection,
          objectType,
          name,
          schema,
          filter,
          includeDefinition,
          limit
        });
        return textResult(result);
      } catch (error) {
        logError('get_db_objects failed', error);
        return textResult({ status: 'error', message: String(error?.message ?? error) }, true);
      }
    }
  );

  server.registerTool(
    'open_db_config',
    {
      title: 'Open database connection manager',
      description:
        'Open the connection manager (add, edit, test or delete database connections) inside the LAZY SQL desktop app — falling back to the browser if the app is not running. Call this when the user wants to configure a database, or after the user agreed to configure one because execute_sql reported no connection.',
      inputSchema: {
        reason: z.string().optional().describe('Short note describing why the page is opened.'),
        connectionName: z.string().optional().describe('Name to prefill as a new connection draft.')
      }
    },
    async ({ reason, connectionName }) => {
      try {
        const page = connectionName ? `/config?name=${encodeURIComponent(connectionName)}` : '/config';
        const url = web.pageUrl(page);
        const daemon = findAppDaemon();
        if (daemon) {
          web.requestWindowNav(page);
          log(`Connection manager requested in the LAZY SQL app window${reason ? ` (${reason})` : ''}`);
          return textResult({
            status: 'opened',
            url,
            target: 'app-window',
            connectionsConfigured: listConnections().length,
            hint: 'Tell the user the connection manager is open in the LAZY SQL desktop app (it may be in the tray). Saved connections are used immediately, no restart needed.'
          });
        }
        const settings = getAppSettings();
        openBrowser(url);
        log(`Config page opened in the browser at ${url}${reason ? ` (${reason})` : ''}`);
        return textResult({
          status: 'opened',
          url,
          target: 'browser',
          connectionsConfigured: listConnections().length,
          hint: settings.desktopAppPath
            ? 'Tell the user the connection manager is open in their browser (the desktop app was not detected). Saved connections are used immediately, no restart needed.'
            : 'Tell the user the connection manager is open in their browser. Tip: install/open the LAZY SQL desktop app for the full experience. Saved connections are used immediately, no restart needed.'
        });
      } catch (error) {
        logError('open_db_config failed', error);
        return textResult({ status: 'error', message: String(error?.message ?? error) }, true);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const counts = countConnections();
  log(
    `LAZY SQL ready (stdio). ${counts.enabled}/${counts.total} connection(s) enabled, web port ${web.port}, review timeout ${Math.round(
      REVIEW_TIMEOUT_MS / 1000
    )}s`
  );
}
