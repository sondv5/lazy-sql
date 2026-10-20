import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { analyzeSql } from './classify.js';
import {
  countConnections,
  deleteConnection,
  findConnection,
  isConnectionAllowed,
  listConnections,
  upsertConnection
} from './config.js';
import { clearExecutionLogs, executionLogStats, listLogDates, listLogsByDate, listRecentLogs, appendExecutionLog } from './exec-logs.js';
import { executeSql, sanitizeErrorMessage } from './executor.js';
import { listInstances } from './instances.js';
import { log, logError } from './logger.js';
import { getDbObjects } from './objects.js';
import { DATA_DIR, readEnv } from './paths.js';
import { getCompletionSchema } from './schema.js';
import { getAppSettings, saveAppSettings } from './settings.js';
import { buildExport, importConfig } from './transfer.js';
import { VERSION } from './version.js';
import { addWorkspace, applyTool, engineEntryPath, removeWorkspace, scanWorkspaces } from './workspaces.js';
import { launchDesktopApp, resolveDesktopAppPath } from './openBrowser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

export class WebUI {
  constructor({ reviews, onConnectionTest } = {}) {
    this.reviews = reviews;
    this.onConnectionTest = onConnectionTest;
    this.token = readEnv('TOKEN') || crypto.randomBytes(16).toString('hex');
    this.port = null;
    this.server = null;
    this.windowNav = null;
    this.app = this.#buildApp();
  }

  requestWindowNav(pagePath) {
    this.windowNav = { path: pagePath, id: crypto.randomUUID(), at: Date.now() };
  }

  #buildApp() {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '5mb' }));

    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-lazy-sql-token, x-sql-crew-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    const requireToken = (req, res, next) => {
      // x-sql-crew-token is accepted from front ends loaded before the rename
      const token = req.get('x-lazy-sql-token') || req.get('x-sql-crew-token') || req.query.t;
      if (token !== this.token) return res.status(401).json({ error: 'unauthorized' });
      next();
    };

    const pageGuard = (req, res, next) => {
      if ((req.query.t ?? '') !== this.token) {
        return res
          .status(401)
          .type('html')
          .send(
            '<!doctype html><body style="font:14px system-ui;padding:40px"><h2>LAZY SQL</h2><p>This page requires the access token from the app.</p></body>'
          );
      }
      next();
    };

    app.get('/health', (req, res) => {
      const connections = countConnections();
      res.json({
        ok: true,
        app: 'lazy-sql',
        version: VERSION,
        node: process.version,
        connections,
        dataDir: DATA_DIR
      });
    });

    const sendFallback = (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'fallback.html'));
    app.get('/config', pageGuard, sendFallback);
    app.get('/history', pageGuard, sendFallback);
    app.get('/review/:id', pageGuard, sendFallback);
    app.get('/', pageGuard, sendFallback);

    // ---- connections ----
    app.get('/api/connections', requireToken, (req, res) => {
      res.json({
        connections: listConnections().map((connection) => ({
          ...connection,
          allowed: isConnectionAllowed(connection)
        }))
      });
    });

    app.post('/api/connections', requireToken, (req, res) => {
      try {
        res.json({ connection: upsertConnection(req.body ?? {}) });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.delete('/api/connections/:id', requireToken, (req, res) => {
      const removed = deleteConnection(req.params.id);
      if (!removed) return res.status(404).json({ error: 'connection not found' });
      res.json({ ok: true });
    });

    const testBody = (req, res) => {
      const input = req.body ?? {};
      if (input.id && !input.password) {
        const stored = findConnection(input.id);
        if (stored?.password) input.password = stored.password;
      }
      return this.onConnectionTest(input)
        .then((result) => res.json(result))
        .catch((error) => res.status(400).json({ error: error.message }));
    };

    app.post('/api/connections/:id/test', requireToken, (req, res) => {
      const connection = findConnection(req.params.id);
      if (!connection) return res.status(404).json({ error: 'connection not found' });
      this.onConnectionTest(connection)
        .then((result) => res.json(result))
        .catch((error) => res.status(400).json({ error: error.message }));
    });

    app.post('/api/connections/test', requireToken, testBody);

    // ---- settings ----
    app.get('/api/settings', requireToken, (req, res) => {
      res.json({
        settings: getAppSettings(),
        dataDir: DATA_DIR,
        engineEntry: engineEntryPath(),
        node: process.version,
        version: VERSION,
        logStats: executionLogStats()
      });
    });

    app.post('/api/settings', requireToken, (req, res) => {
      try {
        res.json({ settings: saveAppSettings(req.body ?? {}) });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // ---- logs ----
    app.get('/api/logs/dates', requireToken, (req, res) => {
      res.json({ dates: listLogDates() });
    });

    app.get('/api/logs', requireToken, (req, res) => {
      const date = String(req.query.date ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      res.json({ date, entries: listLogsByDate(date) });
    });

    app.get('/api/history', requireToken, (req, res) => {
      try {
        res.json({
          entries: listRecentLogs({
            limit: Number(req.query.limit) || 200,
            connection: req.query.connection ? String(req.query.connection) : null
          })
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.delete('/api/logs', requireToken, (req, res) => {
      res.json({ ok: clearExecutionLogs() });
    });

    // ---- reviews ----
    app.get('/api/reviews/active', requireToken, (req, res) => {
      const session = this.reviews?.getActive();
      res.json({
        review: session ? { id: session.id, status: session.status, createdAt: session.createdAt } : null
      });
    });

    app.get('/api/reviews/pending', requireToken, (req, res) => {
      res.json({ reviews: this.reviews?.listPending() ?? [] });
    });

    app.get('/api/window/state', requireToken, (req, res) => {
      const session = this.reviews?.getActive();
      res.json({
        review: session ? { id: session.id, status: session.status, createdAt: session.createdAt } : null,
        nav: this.windowNav
      });
    });

    app.get('/api/reviews/:id', requireToken, (req, res) => {
      const session = this.reviews?.getPublic(req.params.id);
      if (!session) return res.status(404).json({ error: 'review not found' });
      res.json(session);
    });

    app.post('/api/reviews/:id/approve', requireToken, (req, res) => {
      const sql = typeof req.body?.sql === 'string' ? req.body.sql : null;
      const ok = this.reviews.decide(req.params.id, {
        action: 'approve',
        ...(sql && sql.trim() ? { sql } : {})
      });
      if (!ok) return res.status(409).json({ error: 'review is not pending' });
      res.json({ ok: true });
    });

    app.post('/api/reviews/:id/reject', requireToken, (req, res) => {
      const ok = this.reviews.decide(req.params.id, { action: 'reject' });
      if (!ok) return res.status(409).json({ error: 'review is not pending' });
      res.json({ ok: true });
    });

    // ---- misc ----
    app.post('/api/analyze', requireToken, (req, res) => {
      const sql = typeof req.body?.sql === 'string' ? req.body.sql : '';
      res.json({ analysis: analyzeSql(sql) });
    });

    // ---- manual SQL runner (the SQL editor view in the desktop app) ----
    app.post('/api/execute', requireToken, async (req, res) => {
      const body = req.body ?? {};
      const connection = findConnection(String(body.connection ?? ''));
      if (!connection) return res.status(404).json({ error: 'connection not found' });
      const sql = typeof body.sql === 'string' ? body.sql : '';
      if (!sql.trim()) return res.status(400).json({ error: 'The SQL is empty.' });

      const analysis = analyzeSql(sql);
      if (analysis.count === 0) return res.status(400).json({ error: 'The SQL is empty.' });
      const maxRows = Number.isFinite(Number(body.maxRows)) ? Number(body.maxRows) : undefined;
      const params = Array.isArray(body.params) ? body.params : [];
      const target = connection.engine === 'sqlite' ? connection.file : `${connection.host}:${connection.port}/${connection.database}`;
      const baseLog = {
        origin: 'manual',
        reviewed: false,
        sql,
        params,
        statementTypes: analysis.summary,
        connection: { name: connection.name, engine: connection.engine, target }
      };

      if (connection.readOnly && !analysis.isReadOnly) {
        const message = `Connection "${connection.name}" is read-only — ${analysis.summary} statements are blocked. Nothing was executed.`;
        appendExecutionLog({ ...baseLog, status: 'blocked', message });
        return res.json({ status: 'blocked', connection: connection.name, message, analysis });
      }

      try {
        const result = await executeSql({ connection, sql, params, maxRows });
        result.sql = sql;
        result.reviewed = false;
        result.origin = 'manual';
        appendExecutionLog({
          ...baseLog,
          status: 'ok',
          durationMs: result.durationMs,
          rowsReturned: result.rowsReturned,
          totalRows: result.totalRows,
          truncated: Boolean(result.truncated),
          responsePreview: JSON.stringify(result, null, 2)
        });
        return res.json(result);
      } catch (error) {
        const message = sanitizeErrorMessage(error, connection);
        appendExecutionLog({ ...baseLog, status: 'error', message });
        return res.status(400).json({ status: 'error', connection: connection.name, sql, message, analysis });
      }
    });

    app.get('/api/schema', requireToken, async (req, res) => {
      const connection = findConnection(String(req.query.connection ?? ''));
      if (!connection) return res.status(404).json({ error: 'connection not found' });
      try {
        res.json({ connection: connection.name, engine: connection.engine, schema: await getCompletionSchema(connection) });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // ---- object browser (SQL workspace) ----
    app.get('/api/objects/detail', requireToken, async (req, res) => {
      const connection = findConnection(String(req.query.connection ?? ''));
      if (!connection) return res.status(404).json({ error: 'connection not found' });
      const name = String(req.query.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      try {
        res.json(
          await getDbObjects({
            connection,
            name,
            schema: req.query.schema ? String(req.query.schema) : undefined,
            includeDefinition: req.query.definition === '1'
          })
        );
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.get('/api/objects', requireToken, async (req, res) => {
      const connection = findConnection(String(req.query.connection ?? ''));
      if (!connection) return res.status(404).json({ error: 'connection not found' });
      try {
        res.json(
          await getDbObjects({
            connection,
            objectType: req.query.objectType ? String(req.query.objectType) : 'all',
            filter: req.query.filter ? String(req.query.filter) : undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined
          })
        );
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.get('/api/instances', requireToken, async (req, res) => {
      const instances = listInstances();
      if (req.query.probe === '1') {
        await Promise.all(
          instances.map(async (instance) => {
            instance.state = await probeInstance(instance);
          })
        );
      }
      res.json({ instances });
    });

    // ---- workspaces ----
    app.get('/api/workspaces', requireToken, (req, res) => {
      try {
        res.json(scanWorkspaces());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.post('/api/workspaces', requireToken, (req, res) => {
      try {
        const body = req.body ?? {};
        if (body.action === 'add') return res.json({ result: addWorkspace(body.path), scan: scanWorkspaces() });
        if (body.action === 'remove') return res.json({ result: removeWorkspace(body.path), scan: scanWorkspaces() });
        if (body.action === 'apply') {
          const result = applyTool({
            scopeType: body.scopeType,
            scopePath: body.scopePath,
            tool: body.tool,
            enabled: Boolean(body.enabled),
            connections: Array.isArray(body.connections) ? body.connections : null,
            forceReadOnly: Boolean(body.forceReadOnly)
          });
          return res.json({ result, scan: scanWorkspaces() });
        }
        res.status(400).json({ error: 'action must be one of: add, remove, apply' });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // ---- import / export (connections as a single .json file) ----
    app.get('/api/transfer/export', requireToken, (req, res) => {
      res.json({ payload: buildExport({ includePasswords: req.query.passwords === '1' }) });
    });

    app.post('/api/transfer/export-file', requireToken, (req, res) => {
      try {
        const body = req.body ?? {};
        if (!body.path) throw new Error('A destination path is required.');
        const payload = buildExport({ includePasswords: Boolean(body.includePasswords) });
        fs.writeFileSync(path.resolve(String(body.path)), `${JSON.stringify(payload, null, 2)}
`, 'utf8');
        res.json({ ok: true, path: body.path, connections: payload.connections.length });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.post('/api/transfer/import', requireToken, (req, res) => {
      try {
        const body = req.body ?? {};
        let payload = body.payload ?? null;
        if (!payload && body.path) {
          const text = fs.readFileSync(path.resolve(String(body.path)), 'utf8').replace(/^﻿/, '');
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error('The selected file is not valid JSON.');
          }
        }
        if (!payload) throw new Error('Provide a payload or a file path.');
        const summary = importConfig(payload, {
          mode: body.mode ?? 'skip',
          includePasswords: body.includePasswords !== false
        });
        res.json({ summary });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    // ---- desktop app ----
    app.post('/api/desktop/launch', requireToken, (req, res) => {
      const settings = getAppSettings();
      const requested = String(req.body?.path ?? '').trim();
      const appPath = resolveDesktopAppPath(requested || settings.desktopAppPath);
      if (!appPath) {
        return res.json({ launched: false, reason: 'LAZY SQL desktop app not found — set the app path in Settings.' });
      }
      res.json(launchDesktopApp(appPath));
    });

    app.use((error, req, res, next) => {
      logError('Web request failed', error);
      if (res.headersSent) return next(error);
      res.status(error.type === 'entity.parse.failed' ? 400 : 500).json({ error: error.message });
    });

    return app;
  }

  async start(preferredPort = 4788) {
    if (this.server) return { port: this.port, url: this.baseUrl() };
    if (this._starting) return this._starting;
    this._starting = this.#listen(preferredPort);
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async #listen(preferredPort) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = preferredPort + attempt;
      try {
        await new Promise((resolve, reject) => {
          const server = this.app.listen(port, '127.0.0.1');
          server.once('listening', () => {
            this.server = server;
            this.port = port;
            resolve();
          });
          server.once('error', reject);
        });
        log(`Local API listening on ${this.baseUrl()}`);
        return { port: this.port, url: this.baseUrl() };
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error(`No free port found starting at ${preferredPort}`);
  }

  baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  pageUrl(pagePath) {
    const separator = pagePath.includes('?') ? '&' : '?';
    return `${this.baseUrl()}${pagePath}${separator}t=${this.token}`;
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = null;
  }
}

async function probeInstance(instance, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/window/state`, {
      headers: { 'x-lazy-sql-token': instance.token },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
