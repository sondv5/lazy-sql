import { randomUUID } from 'node:crypto';
import { CONNECTIONS_FILE, atomicWrite, readEnv, readJsonFile } from './paths.js';
import { logError } from './logger.js';

export const ENGINES = ['postgres', 'mysql', 'mssql', 'sqlite'];
export const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433, sqlite: null };
export const DEFAULT_QUERY_TIMEOUT_MS = clampInt(readEnv('QUERY_TIMEOUT_MS') ?? 30000, 1000, 600000);

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

export function loadConfig() {
  const parsed = readJsonFile(CONNECTIONS_FILE);
  return { connections: Array.isArray(parsed?.connections) ? parsed.connections : [] };
}

export function saveConfig(config) {
  atomicWrite(CONNECTIONS_FILE, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function toPublicConnection(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    file: connection.file,
    ssl: Boolean(connection.ssl),
    readOnly: Boolean(connection.readOnly),
    enabled: connection.enabled !== false,
    queryTimeoutMs: connection.queryTimeoutMs,
    hasPassword: Boolean(connection.password),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

export function resolveSecretValue(value) {
  if (typeof value !== 'string') return value;
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  if (!match) return value;
  return process.env[match[1]] ?? '';
}

export function isForceReadOnly() {
  return readEnv('FORCE_READ_ONLY') === '1';
}

export function materializeConnection(connection) {
  if (!connection) return null;
  const materialized = { ...connection };
  for (const key of ['host', 'database', 'user', 'file']) {
    materialized[key] = resolveSecretValue(connection[key]);
  }
  materialized.password = connection.password ? resolveSecretValue(connection.password) : null;
  if (isForceReadOnly()) materialized.readOnly = true;
  return materialized;
}

export function listConnections() {
  return loadConfig().connections.map(toPublicConnection);
}

// null = no restriction (unset, empty or "*"). Anything else is an allow-list of connection ids or names;
// a list that holds no usable entry (e.g. ",") allows nothing, so a malformed value never widens access.
export function getAllowedConnections() {
  const raw = String(readEnv('ALLOWED_CONNECTIONS') ?? '').trim();
  if (!raw || raw === '*') return null;
  return new Set(
    raw
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Matches an allow-list token against the given connections: id first, then name (case-insensitive).
export function resolveConnectionToken(connections, token) {
  const needle = String(token ?? '').trim().toLowerCase();
  if (!needle) return null;
  return (
    connections.find((connection) => String(connection.id).toLowerCase() === needle) ??
    connections.find((connection) => String(connection.name).toLowerCase() === needle) ??
    null
  );
}

export function isConnectionAllowed(connection) {
  const allowed = getAllowedConnections();
  if (!allowed) return true;
  return allowed.has(String(connection.name).toLowerCase()) || allowed.has(String(connection.id).toLowerCase());
}

export function listEnabledConnections() {
  return loadConfig()
    .connections.filter((connection) => connection.enabled !== false && isConnectionAllowed(connection))
    .map(toPublicConnection);
}

export function findConnection(ref) {
  const { connections } = loadConfig();
  if (!ref) return connections.length === 1 ? connections[0] : null;
  const needle = String(ref).trim().toLowerCase();
  return (
    connections.find((c) => c.id === ref) ??
    connections.find((c) => String(c.name).toLowerCase() === needle) ??
    null
  );
}

export function buildConnectionRecord(input, existing) {
  const engine = String(input.engine ?? existing?.engine ?? '').toLowerCase();
  if (!ENGINES.includes(engine)) throw new Error(`engine must be one of: ${ENGINES.join(', ')}`);

  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('name is required');

  const now = new Date().toISOString();
  const record = {
    id: existing?.id ?? randomUUID(),
    name,
    engine,
    host: null,
    port: null,
    database: null,
    user: null,
    password: null,
    file: null,
    ssl: Boolean(input.ssl ?? existing?.ssl ?? false),
    readOnly: Boolean(input.readOnly ?? existing?.readOnly ?? false),
    enabled: Boolean(input.enabled ?? existing?.enabled ?? true),
    queryTimeoutMs: clampInt(input.queryTimeoutMs ?? existing?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS, 1000, 600000),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  if (engine === 'sqlite') {
    record.file = String(input.file ?? existing?.file ?? '').trim();
    if (!record.file) throw new Error('file is required for sqlite connections');
  } else {
    record.host = String(input.host ?? existing?.host ?? '').trim() || 'localhost';
    record.port = clampInt(input.port ?? existing?.port ?? DEFAULT_PORTS[engine], 1, 65535);
    record.database = String(input.database ?? existing?.database ?? '').trim();
    if (!record.database) throw new Error('database is required');
    record.user = String(input.user ?? existing?.user ?? '').trim();
    if (!record.user) throw new Error('user is required');
    const incomingPassword = input.password;
    const keepExisting =
      incomingPassword === undefined || incomingPassword === null || incomingPassword === '';
    record.password = keepExisting ? existing?.password ?? null : String(incomingPassword);
  }

  return record;
}

export function upsertConnection(input) {
  const { connections } = loadConfig();
  const existing = input.id ? connections.find((c) => c.id === input.id) : null;
  const record = buildConnectionRecord(input, existing);
  const index = existing ? connections.indexOf(existing) : -1;
  if (index >= 0) connections[index] = record;
  else connections.push(record);
  saveConfig({ connections });
  return toPublicConnection(record);
}

export function deleteConnection(id) {
  const { connections } = loadConfig();
  const next = connections.filter((c) => c.id !== id);
  if (next.length === connections.length) return false;
  saveConfig({ connections: next });
  return true;
}

export function countConnections() {
  const { connections } = loadConfig();
  return {
    total: connections.length,
    enabled: connections.filter((c) => c.enabled !== false).length
  };
}

export function migrateLegacyPasswords() {
  const { connections } = loadConfig();
  let migrated = 0;
  for (const connection of connections) {
    if (typeof connection.password === 'string' && connection.password.startsWith('enc:v1:')) {
      connection.password = null;
      migrated += 1;
    }
    if (connection.enabled === undefined) connection.enabled = true;
  }
  if (migrated > 0) saveConfig({ connections });
  return { migrated };
}
