import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import { DatabaseSync } from 'node:sqlite';
import { trimPayloadArray } from './budget.js';
import { materializeConnection } from './config.js';

const DEFAULT_LIMIT = 200;
const HARD_LIMIT = 1000;
const DEFINITION_MAX_CHARS = 20000;
const OBJECT_TYPES = ['table', 'view', 'function', 'procedure', 'trigger'];

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeObjectType(value) {
  if (!value) return 'all';
  const raw = String(value).trim().toLowerCase();
  if (raw === 'all') return 'all';
  const singular = raw.endsWith('s') ? raw.slice(0, -1) : raw;
  if (!OBJECT_TYPES.includes(singular)) {
    throw new Error(`objectType must be one of: all, ${OBJECT_TYPES.join(', ')}`);
  }
  return singular;
}

function truncateDefinition(definition) {
  if (typeof definition !== 'string') return definition ?? null;
  return definition.length > DEFINITION_MAX_CHARS ? `${definition.slice(0, DEFINITION_MAX_CHARS)}…[truncated]` : definition;
}

function describeConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    target:
      connection.engine === 'sqlite'
        ? connection.file
        : `${connection.host}:${connection.port}/${connection.database}`
  };
}

function groupForeignKeys(rows, columnKey, constraintKey, refSchemaKey, refTableKey, refColumnKey) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row[constraintKey] ?? 'fk';
    if (!grouped.has(key)) {
      grouped.set(key, {
        constraintName: key,
        columns: [],
        references: {
          schema: row[refSchemaKey] ?? null,
          table: row[refTableKey] ?? null,
          columns: []
        }
      });
    }
    const entry = grouped.get(key);
    entry.columns.push(row[columnKey]);
    entry.references.columns.push(row[refColumnKey]);
  }
  return [...grouped.values()];
}

async function pgQuery(materialized, text, values = []) {
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
    return await client.query({ text, values });
  } finally {
    await client.end();
  }
}

async function mysqlQuery(materialized, text, values = []) {
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
    const [rows] = await client.query({ sql: text, values });
    return rows;
  } finally {
    await client.end();
  }
}

async function mssqlQuery(materialized, text, bindParams = {}) {
  const pool = new mssql.ConnectionPool({
    server: materialized.host,
    port: materialized.port,
    database: materialized.database,
    user: materialized.user,
    password: materialized.password ?? undefined,
    options: { encrypt: Boolean(materialized.ssl), trustServerCertificate: true, enableArithAbort: true },
    pool: { max: 1, min: 0 },
    connectionTimeout: 10000,
    requestTimeout: 15000
  });
  await pool.connect();
  try {
    const request = pool.request();
    for (const [name, value] of Object.entries(bindParams)) {
      if (value && typeof value === 'object' && 'type' in value && 'value' in value) {
        request.input(name, value.type, value.value);
      } else {
        request.input(name, value);
      }
    }
    const result = await request.query(text);
    return result.recordset ?? [];
  } finally {
    await pool.close();
  }
}

function sqliteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqliteLiteral(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function sqliteList(materialized) {
  const db = new DatabaseSync(materialized.file, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT type AS kind, name AS name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
      )
      .all();
    return rows.map((row) => ({ schema: 'main', name: row.name, kind: row.kind }));
  } finally {
    db.close();
  }
}

async function sqliteDetail(materialized, name, includeDefinition) {
  const db = new DatabaseSync(materialized.file, { readOnly: true });
  try {
    const master = db
      .prepare("SELECT type AS kind, name, tbl_name, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view','trigger') LIMIT 1")
      .get(name);
    if (!master) return null;

    const detail = {
      schema: 'main',
      name: master.name,
      kind: master.kind,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      indexes: [],
      parameters: [],
      definition: includeDefinition ? truncateDefinition(master.sql) : null
    };

    if (master.kind === 'table' || master.kind === 'view') {
      const columns = db.prepare(`PRAGMA table_info(${sqliteIdent(master.name)})`).all();
      detail.columns = columns.map((column) => ({
        name: column.name,
        type: column.type || null,
        nullable: !column.notnull,
        defaultValue: column.dflt_value ?? null,
        extra: column.pk ? 'pk' : null
      }));
      detail.primaryKey = columns.filter((column) => column.pk).map((column) => column.name);
    }

    if (master.kind === 'table') {
      detail.foreignKeys = db
        .prepare(`PRAGMA foreign_key_list(${sqliteIdent(master.name)})`)
        .all()
        .map((fk) => ({
          constraintName: `fk_${fk.id}`,
          columns: [fk.from],
          references: { schema: 'main', table: fk.table, columns: [fk.to] }
        }));
      detail.indexes = db
        .prepare(`PRAGMA index_list(${sqliteIdent(master.name)})`)
        .all()
        .map((index) => {
          let columns = [];
          try {
            columns = db.prepare(`PRAGMA index_info(${sqliteLiteral(index.name)})`).all().map((info) => info.name);
          } catch {
            columns = [];
          }
          return { name: index.name, unique: Boolean(index.unique), columns, origin: index.origin };
        });
    }

    if (master.kind === 'trigger') {
      detail.definition = includeDefinition ? truncateDefinition(master.sql) : null;
      detail.table = master.tbl_name;
    }

    return detail;
  } finally {
    db.close();
  }
}

async function listObjects(materialized, objectType, filter, limit) {
  let objects = [];

  if (materialized.engine === 'postgres') {
    const result = await pgQuery(
      materialized,
      `SELECT t.table_schema AS schema, t.table_name AS name,
              CASE t.table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE LOWER(t.table_type) END AS kind
       FROM information_schema.tables t
       WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
       UNION ALL
       SELECT r.routine_schema, r.routine_name, LOWER(r.routine_type)
       FROM information_schema.routines r
       WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY kind, schema, name`
    );
    const triggers = await pgQuery(
      materialized,
      `SELECT event_object_schema AS schema, trigger_name AS name, 'trigger' AS kind
       FROM information_schema.triggers
       WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY schema, name`
    );
    objects = [...result.rows, ...triggers.rows];
  } else if (materialized.engine === 'mysql') {
    objects = await mysqlQuery(
      materialized,
      `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name,
              CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE LOWER(TABLE_TYPE) END AS kind
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
       UNION ALL
       SELECT ROUTINE_SCHEMA, ROUTINE_NAME, LOWER(ROUTINE_TYPE)
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
       ORDER BY kind, \`schema\`, name`
    );
    const triggers = await mysqlQuery(
      materialized,
      `SELECT TRIGGER_SCHEMA AS \`schema\`, TRIGGER_NAME AS name, 'trigger' AS kind
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
       ORDER BY \`schema\`, name`
    );
    objects = [...objects, ...triggers];
  } else if (materialized.engine === 'mssql') {
    objects = await mssqlQuery(
      materialized,
      `SELECT s.name AS [schema], o.name AS name,
              CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure'
                          WHEN 'FN' THEN 'function' WHEN 'IF' THEN 'function' WHEN 'TF' THEN 'function'
                          WHEN 'TR' THEN 'trigger' ELSE LOWER(o.type) END AS kind
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U','V','P','FN','IF','TF','TR') AND o.is_ms_shipped = 0
       ORDER BY kind, [schema], name`
    );
  } else if (materialized.engine === 'sqlite') {
    objects = await sqliteList(materialized);
  } else {
    throw new Error(`Unsupported engine: ${materialized.engine}`);
  }

  let filtered = objects;
  if (objectType !== 'all') filtered = filtered.filter((object) => object.kind === objectType);
  if (filter) {
    const needle = String(filter).toLowerCase();
    filtered = filtered.filter((object) => {
      const name = String(object.name ?? '').toLowerCase();
      const schema = String(object.schema ?? '').toLowerCase();
      return name.includes(needle) || schema.includes(needle) || `${schema}.${name}`.includes(needle);
    });
  }
  filtered.sort((a, b) => String(a.schema).localeCompare(String(b.schema)) || String(a.name).localeCompare(String(b.name)));
  return {
    objects: filtered.slice(0, limit),
    count: filtered.length,
    truncated: filtered.length > limit
  };
}

async function detailPg(materialized, name, schema, includeDefinition) {
  const target = await pgQuery(
    materialized,
    `SELECT table_schema AS schema, table_name AS name,
            CASE table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE LOWER(table_type) END AS kind
     FROM information_schema.tables
     WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2)
     LIMIT 1`,
    [name, schema ?? null]
  );
  let found = target.rows[0];

  if (!found) {
    const routine = await pgQuery(
      materialized,
      `SELECT routine_schema AS schema, routine_name AS name, LOWER(routine_type) AS kind,
              data_type AS return_type
       FROM information_schema.routines
       WHERE routine_name = $1 AND ($2::text IS NULL OR routine_schema = $2)
       LIMIT 1`,
      [name, schema ?? null]
    );
    found = routine.rows[0];
    if (!found) return null;
    const parameters = await pgQuery(
      materialized,
      `SELECT parameter_name AS name, data_type AS data_type, parameter_mode AS mode, ordinal_position AS position
       FROM information_schema.parameters
       WHERE specific_schema = $1 AND specific_name = (
         SELECT specific_name FROM information_schema.routines
         WHERE routine_schema = $1 AND routine_name = $2 LIMIT 1
       )
       ORDER BY ordinal_position`,
      [found.schema, found.name]
    );
    let definition = null;
    if (includeDefinition) {
      const definitionResult = await pgQuery(
        materialized,
        `SELECT pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`,
        [found.schema, found.name]
      );
      definition = definitionResult.rows[0]?.definition ?? null;
    }
    return {
      schema: found.schema,
      name: found.name,
      kind: found.kind,
      returnType: found.return_type ?? null,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      indexes: [],
      parameters: parameters.rows.map((row) => ({
        name: row.name,
        type: row.data_type,
        mode: row.mode,
        position: row.position
      })),
      definition: truncateDefinition(definition)
    };
  }

  const columns = await pgQuery(
    materialized,
    `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS default_value
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [found.schema, found.name]
  );
  const constraints = await pgQuery(
    materialized,
    `SELECT tc.constraint_type, kcu.column_name, tc.constraint_name,
            ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema AND tc.table_name = kcu.table_name
     LEFT JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY')`,
    [found.schema, found.name]
  );
  const indexes = await pgQuery(
    materialized,
    `SELECT indexname AS name, indexdef AS definition
     FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
    [found.schema, found.name]
  );
  let definition = null;
  if (includeDefinition) {
    if (found.kind === 'view') {
      const result = await pgQuery(
        materialized,
        `SELECT pg_get_viewdef((quote_ident($1) || '.' || quote_ident($2))::regclass, true) AS definition`,
        [found.schema, found.name]
      );
      definition = result.rows[0]?.definition ?? null;
    }
  }
  const fkRows = constraints.rows.filter((row) => row.constraint_type === 'FOREIGN KEY');
  return {
    schema: found.schema,
    name: found.name,
    kind: found.kind,
    columns: columns.rows.map((row) => ({
      name: row.name,
      type: row.type,
      nullable: row.nullable === 'YES',
      defaultValue: row.default_value,
      extra: null
    })),
    primaryKey: constraints.rows.filter((row) => row.constraint_type === 'PRIMARY KEY').map((row) => row.column_name),
    foreignKeys: groupForeignKeys(fkRows, 'column_name', 'constraint_name', 'ref_schema', 'ref_table', 'ref_column'),
    indexes: indexes.rows.map((row) => ({ name: row.name, unique: /UNIQUE/i.test(row.definition ?? ''), columns: [], definition: row.definition })),
    parameters: [],
    definition: truncateDefinition(definition)
  };
}

async function detailMysql(materialized, name, schema, includeDefinition) {
  const targets = await mysqlQuery(
    materialized,
    `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name,
            CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' ELSE 'view' END AS kind
     FROM information_schema.TABLES
     WHERE TABLE_NAME = ? AND (? IS NULL OR TABLE_SCHEMA = ?)
     UNION ALL
     SELECT ROUTINE_SCHEMA, ROUTINE_NAME, LOWER(ROUTINE_TYPE)
     FROM information_schema.ROUTINES
     WHERE ROUTINE_NAME = ? AND (? IS NULL OR ROUTINE_SCHEMA = ?)
     LIMIT 1`,
    [name, schema ?? null, schema ?? null, name, schema ?? null, schema ?? null]
  );
  const found = targets[0];
  if (!found) return null;

  const detail = {
    schema: found.schema,
    name: found.name,
    kind: found.kind,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    parameters: [],
    definition: null
  };

  if (found.kind === 'table' || found.kind === 'view') {
    const columns = await mysqlQuery(
      materialized,
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS default_value, COLUMN_KEY AS column_key, EXTRA AS extra
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [found.schema, found.name]
    );
    detail.columns = columns.map((row) => ({
      name: row.name,
      type: row.type,
      nullable: row.nullable === 'YES',
      defaultValue: row.default_value,
      extra: row.extra || null
    }));
    detail.primaryKey = columns.filter((row) => row.column_key === 'PRI').map((row) => row.name);
    detail.foreignKeys = (
      await mysqlQuery(
        materialized,
        `SELECT CONSTRAINT_NAME AS constraint_name, COLUMN_NAME AS column_name,
                REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [found.schema, found.name]
      )
    ).map((row) => ({
      constraintName: row.constraint_name,
      columns: [row.column_name],
      references: { schema: row.ref_schema, table: row.ref_table, columns: [row.ref_column] }
    }));
    detail.indexes = (
      await mysqlQuery(
        materialized,
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         GROUP BY INDEX_NAME, NON_UNIQUE`,
        [found.schema, found.name]
      )
    ).map((row) => ({
      name: row.name,
      unique: Number(row.non_unique) === 0,
      columns: String(row.columns ?? '').split(','),
      definition: null
    }));
  }

  if (found.kind === 'function' || found.kind === 'procedure') {
    detail.parameters = (
      await mysqlQuery(
        materialized,
        `SELECT PARAMETER_NAME AS name, DATA_TYPE AS data_type, PARAMETER_MODE AS mode, ORDINAL_POSITION AS position
         FROM information_schema.PARAMETERS
         WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND PARAMETER_NAME IS NOT NULL
         ORDER BY ORDINAL_POSITION`,
        [found.schema, found.name]
      )
    ).map((row) => ({ name: row.name, type: row.data_type, mode: row.mode, position: row.position }));
  }

  if (includeDefinition) {
    const qualified = `\`${String(found.schema).replace(/`/g, '``')}\`.\`${String(found.name).replace(/`/g, '``')}\``;
    const kindWord = found.kind === 'view' ? 'VIEW' : found.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    try {
      const rows = await mysqlQuery(materialized, `SHOW CREATE ${kindWord} ${qualified}`);
      const row = rows[0] ?? {};
      detail.definition = truncateDefinition(
        row['Create View'] ?? row['Create Function'] ?? row['Create Procedure'] ?? null
      );
    } catch {
      detail.definition = null;
    }
  }

  return detail;
}

async function detailMssql(materialized, name, schema, includeDefinition) {
  const targets = await mssqlQuery(
    materialized,
    `SELECT s.name AS [schema], o.name AS name, o.object_id AS object_id,
            CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure'
                        WHEN 'FN' THEN 'function' WHEN 'IF' THEN 'function' WHEN 'TF' THEN 'function'
                        WHEN 'TR' THEN 'trigger' ELSE LOWER(o.type) END AS kind
     FROM sys.objects o
     JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.name = @name AND (@schema IS NULL OR s.name = @schema)
       AND o.type IN ('U','V','P','FN','IF','TF','TR')
     ORDER BY CASE o.type WHEN 'U' THEN 0 WHEN 'V' THEN 1 ELSE 2 END`,
    { name: { type: mssql.NVarChar, value: name }, schema: { type: mssql.NVarChar, value: schema ?? null } }
  );
  const found = targets[0];
  if (!found) return null;

  const detail = {
    schema: found.schema,
    name: found.name,
    kind: found.kind,
    columns: [],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
    parameters: [],
    definition: null
  };

  if (found.kind === 'table' || found.kind === 'view') {
    detail.columns = (
      await mssqlQuery(
        materialized,
        `SELECT c.name AS name, t.name AS type, c.is_nullable AS nullable, c.is_identity AS is_identity
         FROM sys.columns c
         JOIN sys.types t ON c.user_type_id = t.user_type_id
         WHERE c.object_id = @objectId
         ORDER BY c.column_id`,
        { objectId: { type: mssql.Int, value: found.object_id } }
      )
    ).map((row) => ({
      name: row.name,
      type: row.type,
      nullable: Boolean(row.nullable),
      defaultValue: null,
      extra: row.is_identity ? 'identity' : null
    }));
    detail.primaryKey = (
      await mssqlQuery(
        materialized,
        `SELECT COL_NAME(ic.object_id, ic.column_id) AS name
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         WHERE i.is_primary_key = 1 AND i.object_id = @objectId
         ORDER BY ic.key_ordinal`,
        { objectId: { type: mssql.Int, value: found.object_id } }
      )
    ).map((row) => row.name);
    detail.foreignKeys = (
      await mssqlQuery(
        materialized,
        `SELECT fk.name AS constraint_name,
                COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
                OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema,
                OBJECT_NAME(fk.referenced_object_id) AS ref_table,
                COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column
         FROM sys.foreign_key_columns fkc
         JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
         WHERE fkc.parent_object_id = @objectId`,
        { objectId: { type: mssql.Int, value: found.object_id } }
      )
    ).map((row) => ({
      constraintName: row.constraint_name,
      columns: [row.column_name],
      references: { schema: row.ref_schema, table: row.ref_table, columns: [row.ref_column] }
    }));
    detail.indexes = (
      await mssqlQuery(
        materialized,
        `SELECT i.name AS name, i.is_unique AS is_unique, i.type_desc AS type,
                STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = @objectId AND i.name IS NOT NULL
         GROUP BY i.name, i.is_unique, i.type_desc`,
        { objectId: { type: mssql.Int, value: found.object_id } }
      )
    ).map((row) => ({
      name: row.name,
      unique: Boolean(row.is_unique),
      columns: String(row.columns ?? '').split(', '),
      definition: row.type
    }));
    detail.parameters = (
      await mssqlQuery(
        materialized,
        `SELECT p.name AS name, t.name AS type, p.is_output AS is_output
         FROM sys.parameters p
         JOIN sys.types t ON p.user_type_id = t.user_type_id
         WHERE p.object_id = @objectId
         ORDER BY p.parameter_id`,
        { objectId: { type: mssql.Int, value: found.object_id } }
      )
    ).map((row) => ({ name: row.name, type: row.type, mode: row.is_output ? 'OUT' : 'IN', position: null }));
  }

  if (includeDefinition) {
    const definition = await mssqlQuery(
      materialized,
      `SELECT OBJECT_DEFINITION(@objectId) AS definition`,
      { objectId: { type: mssql.Int, value: found.object_id } }
    );
    detail.definition = truncateDefinition(definition[0]?.definition ?? null);
  }

  return detail;
}

export async function getDbObjects({ connection, objectType, name, schema, filter, includeDefinition = false, limit }) {
  const materialized = materializeConnection(connection);
  const normalizedType = normalizeObjectType(objectType);
  const effectiveLimit = clampInt(limit ?? DEFAULT_LIMIT, 1, HARD_LIMIT);
  const base = {
    status: 'ok',
    connection: describeConnection(materialized),
    engine: materialized.engine
  };

  if (name) {
    let detail = null;
    if (materialized.engine === 'postgres') detail = await detailPg(materialized, name, schema, includeDefinition);
    else if (materialized.engine === 'mysql') detail = await detailMysql(materialized, name, schema, includeDefinition);
    else if (materialized.engine === 'mssql') detail = await detailMssql(materialized, name, schema, includeDefinition);
    else if (materialized.engine === 'sqlite') detail = await sqliteDetail(materialized, name, includeDefinition);
    else throw new Error(`Unsupported engine: ${materialized.engine}`);

    if (!detail) {
      return { ...base, mode: 'detail', found: false, message: `No object named "${name}"${schema ? ` in schema "${schema}"` : ''}.` };
    }
    const payload = { ...base, mode: 'detail', found: true, object: detail };
    const { omitted } = trimPayloadArray(detail, 'columns');
    if (omitted > 0) payload.note = `Detail response was trimmed to fit the agent context (${omitted} more columns).`;
    return payload;
  }

  const listed = await listObjects(materialized, normalizedType, filter, effectiveLimit);
  const payload = {
    ...base,
    mode: 'list',
    objectType: normalizedType,
    filter: filter ?? null,
    count: listed.count,
    truncated: listed.truncated,
    objects: listed.objects
  };
  const { omitted } = trimPayloadArray(payload, 'objects');
  if (omitted > 0) {
    payload.truncated = true;
    payload.note = `Object list was trimmed to fit the agent context (${omitted} more objects). Use objectType/filter/limit to narrow the search.`;
  }
  return payload;
}
