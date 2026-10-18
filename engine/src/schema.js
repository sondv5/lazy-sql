import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import { materializeConnection } from './config.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TABLES = 4000;
const MAX_COLUMNS_PER_TABLE = 300;

const cache = new Map();

export async function getCompletionSchema(connection) {
  const key = `${connection.id ?? connection.name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.schema;
  const schema = await fetchSchema(materializeConnection(connection));
  cache.set(key, { at: Date.now(), schema });
  return schema;
}

export function invalidateSchemaCache() {
  cache.clear();
}

function collector() {
  const tables = {};
  let count = 0;
  return {
    add(table, column) {
      if (count >= MAX_TABLES * 10) return;
      if (!tables[table]) tables[table] = [];
      if (column && tables[table].length < MAX_COLUMNS_PER_TABLE) {
        tables[table].push(column);
        count += 1;
      }
    },
    result() {
      return tables;
    }
  };
}

async function fetchSchema(connection) {
  const sink = collector();

  if (connection.engine === 'postgres') {
    const client = new pg.Client({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password ?? undefined,
      ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000
    });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY table_name, ordinal_position
         LIMIT ${MAX_TABLES * MAX_COLUMNS_PER_TABLE}`
      );
      for (const row of result.rows) sink.add(row.table_name, row.column_name);
    } finally {
      await client.end();
    }
    return sink.result();
  }

  if (connection.engine === 'mysql') {
    const client = await mysql.createConnection({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password ?? undefined,
      ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 10000
    });
    try {
      const [rows] = await client.query(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
         ORDER BY TABLE_NAME, ORDINAL_POSITION
         LIMIT ${MAX_TABLES * MAX_COLUMNS_PER_TABLE}`
      );
      for (const row of rows) sink.add(row.table_name, row.column_name);
    } finally {
      await client.end();
    }
    return sink.result();
  }

  if (connection.engine === 'mssql') {
    const pool = new mssql.ConnectionPool({
      server: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password ?? undefined,
      options: { encrypt: Boolean(connection.ssl), trustServerCertificate: true, enableArithAbort: true },
      pool: { max: 1, min: 0 },
      connectionTimeout: 10000,
      requestTimeout: 15000
    });
    await pool.connect();
    try {
      const result = await pool.request().query(
        `SELECT TOP ${MAX_TABLES * MAX_COLUMNS_PER_TABLE} TABLE_NAME AS table_name, COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
         ORDER BY TABLE_NAME, ORDINAL_POSITION`
      );
      for (const row of result.recordset ?? []) sink.add(row.table_name, row.column_name);
    } finally {
      await pool.close();
    }
    return sink.result();
  }

  if (connection.engine === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(connection.file, { readOnly: true });
    try {
      const objects = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ?"
        )
        .all(MAX_TABLES);
      for (const object of objects) {
        try {
          const columns = db.prepare(`PRAGMA table_info("${String(object.name).replace(/"/g, '""')}")`).all();
          for (const column of columns) sink.add(object.name, column.name);
        } catch {
          sink.add(object.name, null);
        }
      }
    } finally {
      db.close();
    }
    return sink.result();
  }

  throw new Error(`Unsupported engine: ${connection.engine}`);
}
