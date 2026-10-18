import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import { getResponseBudget, jsonSize } from './budget.js';
import { materializeConnection } from './config.js';
import { analyzeSql, transformOutsideQuotes } from './classify.js';
import { log } from './logger.js';

const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 5000;
const CELL_MAX_CHARS = 2000;
const ERROR_MAX_CHARS = 4000;

const resources = new Map();

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function resourceKey(connection) {
  return `${connection.engine}:${connection.id ?? connection.name}`;
}

function getCached(connection, kind) {
  const entry = resources.get(resourceKey(connection));
  if (!entry || entry.kind !== kind || entry.updatedAt !== connection.updatedAt) return null;
  return entry;
}

function evictStale(connection) {
  const key = resourceKey(connection);
  const entry = resources.get(key);
  if (!entry) return;
  resources.delete(key);
  Promise.resolve(entry.dispose()).catch((error) => log(`Failed to dispose stale pool cleanly: ${error.message}`));
}

function pgPool(connection) {
  const cached = getCached(connection, 'pg');
  if (cached) return cached.resource;
  evictStale(connection);
  const pool = new pg.Pool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password ?? undefined,
    ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 60000
  });
  pool.on('connect', (client) => {
    const setup = [`SET statement_timeout = ${clampInt(connection.queryTimeoutMs, 1000, 600000)}`];
    if (connection.readOnly) setup.push('SET default_transaction_read_only = on');
    client.query(setup.join('; ')).catch((error) => log(`PostgreSQL session setup failed: ${error.message}`));
  });
  pool.on('error', (error) => log(`PostgreSQL pool error (${connection.name}): ${error.message}`));
  resources.set(resourceKey(connection), {
    kind: 'pg',
    updatedAt: connection.updatedAt,
    resource: pool,
    dispose: () => pool.end()
  });
  return pool;
}

function mysqlPool(connection) {
  const cached = getCached(connection, 'mysql');
  if (cached) return cached.resource;
  evictStale(connection);
  const pool = mysql.createPool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password ?? undefined,
    ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 2,
    connectTimeout: 10000,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  });
  resources.set(resourceKey(connection), {
    kind: 'mysql',
    updatedAt: connection.updatedAt,
    resource: pool,
    dispose: () => pool.end()
  });
  return pool;
}

async function mssqlPool(connection) {
  const cached = getCached(connection, 'mssql');
  if (cached) return cached.resource;
  evictStale(connection);
  const pool = new mssql.ConnectionPool({
    server: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password ?? undefined,
    options: {
      encrypt: Boolean(connection.ssl),
      trustServerCertificate: true,
      enableArithAbort: true
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 60000 },
    connectionTimeout: 10000,
    requestTimeout: clampInt(connection.queryTimeoutMs, 1000, 600000)
  });
  await pool.connect();
  resources.set(resourceKey(connection), {
    kind: 'mssql',
    updatedAt: connection.updatedAt,
    resource: pool,
    dispose: () => pool.close()
  });
  return pool;
}

export async function disposeAllResources() {
  const entries = [...resources.values()];
  resources.clear();
  await Promise.allSettled(entries.map((entry) => entry.dispose()));
}

function isOkPacket(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'affectedRows' in value;
}

function objectColumns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return Object.keys(rows[0] ?? {});
}

function translateMssqlParams(sql, params, request) {
  const usingDollar = /\$\d+/.test(sql);
  if (usingDollar) {
    return transformOutsideQuotes(sql, (code) =>
      code.replace(/\$(\d+)/g, (match, digits) => {
        const index = Number(digits);
        request.input(`p${index}`, params[index - 1]);
        return `@p${index}`;
      })
    );
  }
  let index = 0;
  return transformOutsideQuotes(sql, (code) =>
    code.replace(/\?/g, () => {
      index += 1;
      request.input(`p${index}`, params[index - 1]);
      return `@p${index}`;
    })
  );
}

async function runPg(connection, sql, params) {
  const pool = pgPool(connection);
  const response = await pool.query(params.length ? { text: sql, values: params } : { text: sql });
  const results = Array.isArray(response) ? response : [response];
  return results.map((result) => {
    const fields = result.fields ?? [];
    return {
      command: result.command,
      columns: fields.map((field) => field.name),
      rows: (result.rows ?? []).map((row) => fields.map((field) => row[field.name])),
      rowCount: result.rowCount ?? (result.rows ? result.rows.length : 0)
    };
  });
}

function normalizeMysql(rows, fields) {
  if (isOkPacket(rows)) {
    return [{ command: 'OK', columns: [], rows: [], rowCount: rows.affectedRows ?? 0, notice: rows.info || undefined }];
  }
  const list = Array.isArray(rows) ? rows : [];
  const multi = list.some((element) => Array.isArray(element) || isOkPacket(element));
  if (multi) {
    return list.map((element) => {
      if (isOkPacket(element)) {
        return { command: 'OK', columns: [], rows: [], rowCount: element.affectedRows ?? 0, notice: element.info || undefined };
      }
      const columns = objectColumns(element);
      return { command: 'SELECT', columns, rows: element.map((row) => columns.map((c) => row[c])), rowCount: element.length };
    });
  }
  const columns = fields?.length ? fields.map((field) => field.name) : objectColumns(list);
  return [{ command: 'SELECT', columns, rows: list.map((row) => columns.map((c) => row[c])), rowCount: list.length }];
}

async function runMysql(connection, sql, params) {
  const pool = mysqlPool(connection);
  const client = await pool.getConnection();
  try {
    if (connection.readOnly) await client.query('SET SESSION TRANSACTION READ ONLY');
    const [rows, fields] = await client.query({
      sql,
      values: params,
      timeout: clampInt(connection.queryTimeoutMs, 1000, 600000)
    });
    return normalizeMysql(rows, fields);
  } finally {
    client.release();
  }
}

async function runMssql(connection, sql, params) {
  const pool = await mssqlPool(connection);
  const request = pool.request();
  request.requestTimeout = clampInt(connection.queryTimeoutMs, 1000, 600000);
  const text = params.length ? translateMssqlParams(sql, params, request) : sql;
  const result = await request.query(text);
  const sets = (result.recordsets ?? []).map((recordset) => {
    const columns = recordset.columns ? Object.keys(recordset.columns) : objectColumns(recordset);
    return {
      command: 'SELECT',
      columns,
      rows: recordset.map((row) => columns.map((c) => row[c])),
      rowCount: recordset.length
    };
  });
  if (sets.length === 0) {
    const affected = (result.rowsAffected ?? []).reduce((total, count) => total + count, 0);
    sets.push({ command: 'OK', columns: [], rows: [], rowCount: affected, notice: 'Statement executed' });
  }
  return sets;
}

async function runSqlite(connection, sql, params, analysis) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(connection.file, { readOnly: Boolean(connection.readOnly) });
  try {
    if (analysis.statements.length > 1) {
      db.exec(sql);
      return [
        {
          command: 'OK',
          columns: [],
          rows: [],
          rowCount: 0,
          notice: `${analysis.statements.length} statements executed (sqlite exec mode; no rows returned)`
        }
      ];
    }
    const statement = db.prepare(sql);
    let columns = [];
    try {
      columns = statement.columns().map((column) => column.name);
    } catch {
      columns = [];
    }

    const selectSet = (rows) => {
      if (columns.length === 0) columns = objectColumns(rows);
      return [{ command: 'SELECT', columns, rows: rows.map((row) => columns.map((c) => row[c])), rowCount: rows.length }];
    };

    if (analysis.statements[0]?.type === 'read') {
      return selectSet(statement.all(...params));
    }

    try {
      const info = statement.run(...params);
      return [
        {
          command: 'OK',
          columns: [],
          rows: [],
          rowCount: Number(info.changes ?? 0),
          notice: `lastInsertRowid=${info.lastInsertRowid}`
        }
      ];
    } catch (error) {
      if (!/returns data|use all\(\)|use get\(\)/i.test(error.message)) throw error;
      return selectSet(statement.all(...params));
    }
  } finally {
    db.close();
  }
}

function serializeCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (typeof value === 'string') {
    return value.length > CELL_MAX_CHARS ? `${value.slice(0, CELL_MAX_CHARS)}…[truncated]` : value;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > CELL_MAX_CHARS ? `${json.slice(0, CELL_MAX_CHARS)}…[truncated]` : json;
    } catch {
      return String(value);
    }
  }
  return value;
}

function finalizeSet(set, rowLimit) {
  const serialized = set.rows.map((row) => row.map(serializeCell));
  const rows = serialized.slice(0, rowLimit);
  return {
    command: set.command ?? 'OK',
    rowCount: set.rowCount ?? serialized.length,
    columns: set.columns ?? [],
    rows,
    truncated: serialized.length > rows.length,
    notice: set.notice
  };
}

function applyResponseBudget(result) {
  const budget = getResponseBudget();
  if (jsonSize(result) <= budget) return result;

  const reserve = 500;
  let used = jsonSize({ ...result, resultSets: result.resultSets.map((set) => ({ ...set, rows: [] })) });
  let omitted = 0;
  for (const set of result.resultSets) {
    const kept = [];
    for (const row of set.rows) {
      const size = JSON.stringify(row).length + 1;
      if (used + size > budget - reserve) break;
      used += size;
      kept.push(row);
    }
    if (kept.length < set.rows.length) {
      set.rowsOmitted = set.rows.length - kept.length;
      omitted += set.rowsOmitted;
      set.rows = kept;
      set.truncated = true;
    }
  }

  if (omitted > 0) {
    result.responseTrimmed = true;
    result.truncated = true;
    result.hint = `Response exceeded the ~${budget}-char context budget: ${omitted} row(s) omitted. Narrow the columns or filters, add LIMIT, or page through the data.`;
  }
  return result;
}

export async function executeSql({ connection, sql, params, maxRows }) {
  const startedAt = Date.now();
  const materialized = materializeConnection(connection);
  const analysis = analyzeSql(sql);
  if (analysis.count === 0) throw new Error('SQL is empty');
  const rowLimit = clampInt(maxRows ?? DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS);
  const values = Array.isArray(params) ? params : [];

  let rawSets;
  switch (materialized.engine) {
    case 'postgres':
      rawSets = await runPg(materialized, sql, values);
      break;
    case 'mysql':
      rawSets = await runMysql(materialized, sql, values);
      break;
    case 'mssql':
      rawSets = await runMssql(materialized, sql, values);
      break;
    case 'sqlite':
      rawSets = await runSqlite(materialized, sql, values, analysis);
      break;
    default:
      throw new Error(`Unsupported engine: ${materialized.engine}`);
  }

  const resultSets = rawSets.map((set) => finalizeSet(set, rowLimit));
  const rowsCapped = resultSets.some((set) => set.truncated);
  const result = {
    status: 'ok',
    connection: {
      id: materialized.id,
      name: materialized.name,
      engine: materialized.engine,
      target: materialized.engine === 'sqlite' ? materialized.file : `${materialized.host}:${materialized.port}/${materialized.database}`
    },
    statementTypes: analysis.summary,
    params: values,
    resultSets,
    totalRows: resultSets.reduce((total, set) => total + set.rowCount, 0),
    rowsReturned: resultSets.reduce((total, set) => total + set.rows.length, 0),
    durationMs: Date.now() - startedAt
  };

  if (rowsCapped) {
    result.hint = `Rows were capped at ${rowLimit} per statement; increase maxRows (up to ${HARD_MAX_ROWS}) to see more.`;
  }
  applyResponseBudget(result);
  result.truncated = Boolean(result.truncated || rowsCapped);
  return result;
}

export function sanitizeErrorMessage(error, connection) {
  let text = String(error?.message ?? error ?? 'Unknown error');
  const secret = connection?.password;
  if (secret && secret.length >= 3) text = text.split(secret).join('***');
  if (text.length > ERROR_MAX_CHARS) text = `${text.slice(0, ERROR_MAX_CHARS)}…`;
  return text;
}

export async function testConnection(connection) {
  const startedAt = Date.now();
  const materialized = materializeConnection(connection);
  try {
    let serverVersion = '';
    if (materialized.engine === 'postgres') {
      const client = new pg.Client({
        host: materialized.host,
        port: materialized.port,
        database: materialized.database,
        user: materialized.user,
        password: materialized.password ?? undefined,
        ssl: materialized.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 10000
      });
      await client.connect();
      try {
        const result = await client.query('SELECT version() AS version');
        serverVersion = result.rows[0]?.version ?? '';
      } finally {
        await client.end();
      }
    } else if (materialized.engine === 'mysql') {
      const client = await mysql.createConnection({
        host: materialized.host,
        port: materialized.port,
        database: materialized.database,
        user: materialized.user,
        password: materialized.password ?? undefined,
        ssl: materialized.ssl ? { rejectUnauthorized: false } : undefined,
        connectTimeout: 10000
      });
      try {
        const [rows] = await client.query('SELECT VERSION() AS version');
        serverVersion = rows[0]?.version ?? '';
      } finally {
        await client.end();
      }
    } else if (materialized.engine === 'mssql') {
      const pool = new mssql.ConnectionPool({
        server: materialized.host,
        port: materialized.port,
        database: materialized.database,
        user: materialized.user,
        password: materialized.password ?? undefined,
        options: { encrypt: Boolean(materialized.ssl), trustServerCertificate: true, enableArithAbort: true },
        pool: { max: 1, min: 0 },
        connectionTimeout: 10000,
        requestTimeout: 10000
      });
      await pool.connect();
      try {
        const result = await pool.request().query('SELECT @@VERSION AS version');
        serverVersion = String(result.recordset?.[0]?.version ?? '').split('\n')[0];
      } finally {
        await pool.close();
      }
    } else if (materialized.engine === 'sqlite') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(materialized.file, { readOnly: true });
      try {
        const row = db.prepare('SELECT sqlite_version() AS version').get();
        serverVersion = row?.version ?? '';
      } finally {
        db.close();
      }
    }
    return {
      ok: true,
      engine: materialized.engine,
      serverVersion,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      engine: materialized.engine,
      latencyMs: Date.now() - startedAt,
      error: sanitizeErrorMessage(error, materialized)
    };
  }
}
