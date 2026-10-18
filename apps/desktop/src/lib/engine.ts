import { ensureEngine, rememberWebEngine, IS_TAURI } from './tauri';

export interface Connection {
  id: string;
  name: string;
  engine: 'postgres' | 'mysql' | 'mssql' | 'sqlite';
  host: string | null;
  port: number | null;
  database: string | null;
  user: string | null;
  file: string | null;
  ssl: boolean;
  readOnly: boolean;
  enabled: boolean;
  queryTimeoutMs: number;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  allowed?: boolean;
}

export interface ConnectionInput {
  id?: string;
  name: string;
  engine: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  file?: string;
  ssl?: boolean;
  readOnly?: boolean;
  enabled?: boolean;
  queryTimeoutMs?: number;
}

export interface LogEntry {
  ts: string;
  date: string;
  status: 'ok' | 'error' | 'rejected' | 'review_timeout' | 'blocked';
  reviewed: boolean;
  origin?: 'agent' | 'manual';
  sql: string;
  params: unknown[];
  statementTypes?: string;
  connection?: { name: string; engine: string; target: string };
  durationMs?: number;
  rowsReturned?: number;
  totalRows?: number;
  truncated?: boolean;
  message?: string;
  responsePreview?: string;
  purpose?: string | null;
  reviewId?: string;
}

export interface SqlAnalysis {
  count: number;
  keywords: string[];
  types: string[];
  isReadOnly: boolean;
  hasModifications: boolean;
  dangerous: boolean;
  requiresConfirmation: boolean;
  summary: string;
}

export interface ResultSet {
  command: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated?: boolean;
  rowsOmitted?: number;
  notice?: string;
}

export interface ExecutionResult {
  status: string;
  connection?: { id: string; name: string; engine: string; target: string };
  statementTypes?: string;
  resultSets?: ResultSet[];
  rowsReturned?: number;
  totalRows?: number;
  durationMs?: number;
  reviewed?: boolean;
  origin?: string;
  sql?: string;
  truncated?: boolean;
  responseTrimmed?: boolean;
  hint?: string;
  message?: string;
}

export interface ManualExecution extends ExecutionResult {
  analysis?: SqlAnalysis;
}

export interface ReviewSession {
  id: string;
  sql: string;
  params: unknown[];
  purpose: string | null;
  connection: Connection;
  status: 'pending' | 'approved' | 'running' | 'done' | 'error' | 'rejected' | 'timeout';
  createdAt: number;
  expiresAt: number;
  timeoutMs: number;
  analysis: SqlAnalysis;
  result: ExecutionResult | null;
  error: string | null;
}

export interface InstanceState {
  review: { id: string; status: string; createdAt: number } | null;
  nav: { path: string; id: string; at: number } | null;
}

export interface InstanceRecord {
  id: string;
  app: string;
  version: string | null;
  mode: 'stdio' | 'serve';
  pid: number;
  ppid: number;
  port: number;
  token: string;
  label: string | null;
  entry: string | null;
  cwd: string;
  startedAt: string;
  heartbeatAt: number;
  isSelf: boolean;
  state?: InstanceState | null;
}

export interface WorkspaceToolState {
  configPath: string;
  exists: boolean;
  registered: boolean;
  enabled: boolean;
  /** Allowed connection ids; null = all connections. */
  connections: string[] | null;
  /** Saved allow-list entries that match no connection (deleted, or renamed in older registrations). */
  unknownConnections: string[];
  forceReadOnly: boolean;
  registeredEntry: string | null;
  needsUpdate: boolean;
  parseError: boolean;
  error: string | null;
  candidates: string[];
  desired: { enabled: boolean; connections: string[] | null; forceReadOnly: boolean } | null;
}

export interface WorkspaceEntry {
  path: string;
  label: string;
  addedAt: string | null;
  exists: boolean;
  tools: Record<string, WorkspaceToolState>;
}

export interface WorkspaceScan {
  mcpName: string;
  engineEntry: string;
  node: string;
  tools: Record<string, { label: string }>;
  connections: Array<{ id: string; name: string; engine: string; enabled: boolean; readOnly: boolean }>;
  user: Record<string, WorkspaceToolState>;
  workspaces: WorkspaceEntry[];
}

export interface AppSettings {
  reviewTimeoutMs: number;
  maxRowsDefault: number;
  fallbackToBrowser: boolean;
  desktopAppPath: string;
  closeToTray: boolean;
  lastSelectedDate: string | null;
}

export interface TransferSummary {
  imported: number;
  overwritten: number;
  skipped: number;
  renamed: number;
  errors: string[];
}

export interface EngineHealth {
  ok: boolean;
  app: string;
  version: string;
  node: string;
  connections: { total: number; enabled: number };
  dataDir: string;
}

async function request<T>(base: string, token: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-lazy-sql-token': token
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const message = (data as { error?: string })?.error ?? `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

export class Engine {
  constructor(
    public base: string,
    public token: string
  ) {}

  api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    return request<T>(this.base, this.token, path, options);
  }

  health(): Promise<EngineHealth> {
    return fetch(`${this.base}/health`).then((response) => response.json());
  }

  connections(): Promise<{ connections: Connection[] }> {
    return this.api('/api/connections');
  }

  saveConnection(input: ConnectionInput): Promise<{ connection: Connection }> {
    return this.api('/api/connections', { method: 'POST', body: input });
  }

  deleteConnection(id: string): Promise<{ ok: boolean }> {
    return this.api(`/api/connections/${id}`, { method: 'DELETE' });
  }

  testConnection(input: ConnectionInput): Promise<{ ok: boolean; serverVersion?: string; latencyMs?: number; error?: string }> {
    return this.api('/api/connections/test', { method: 'POST', body: input });
  }

  settings(): Promise<{
    settings: AppSettings;
    dataDir: string;
    engineEntry: string;
    node: string;
    version: string;
    logStats: { bytes: number; file: string };
  }> {
    return this.api('/api/settings');
  }

  saveSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings }> {
    return this.api('/api/settings', { method: 'POST', body: patch });
  }

  logDates(): Promise<{ dates: Array<{ date: string; count: number }> }> {
    return this.api('/api/logs/dates');
  }

  logs(date: string): Promise<{ date: string; entries: LogEntry[] }> {
    return this.api(`/api/logs?date=${encodeURIComponent(date)}`);
  }

  clearLogs(): Promise<{ ok: boolean }> {
    return this.api('/api/logs', { method: 'DELETE' });
  }

  instances(probe: boolean): Promise<{ instances: InstanceRecord[] }> {
    return this.api(`/api/instances${probe ? '?probe=1' : ''}`);
  }

  execute(connectionId: string, sql: string, maxRows?: number): Promise<ManualExecution> {
    return this.api('/api/execute', { method: 'POST', body: { connection: connectionId, sql, ...(maxRows ? { maxRows } : {}) } });
  }

  workspaces(): Promise<WorkspaceScan> {
    return this.api('/api/workspaces');
  }

  workspaceAction(body: Record<string, unknown>): Promise<{ result?: unknown; scan: WorkspaceScan }> {
    return this.api('/api/workspaces', { method: 'POST', body });
  }

  exportConnections(path: string, includePasswords: boolean): Promise<{ ok: boolean; path: string; connections: number }> {
    return this.api('/api/transfer/export-file', {
      method: 'POST',
      body: { path, includePasswords }
    });
  }

  importConnections(path: string, mode: string, includePasswords: boolean): Promise<{ summary: TransferSummary }> {
    return this.api('/api/transfer/import', {
      method: 'POST',
      body: { path, mode, includePasswords }
    });
  }

  launchDesktop(path?: string): Promise<{ launched: boolean; reason?: string }> {
    return this.api('/api/desktop/launch', { method: 'POST', body: { path } });
  }
}

export async function connectEngine(): Promise<Engine> {
  const info = await ensureEngine();
  if (!IS_TAURI && !info.token) {
    throw new Error('Engine found but no token is known. Start the engine via `npm run serve` and open the URL from its console output.');
  }
  rememberWebEngine(info.port, info.token);
  return new Engine(`http://127.0.0.1:${info.port}`, info.token);
}

/* cross-instance helpers (the review dialog talks to the instance that owns the review) */

export function instanceBase(instance: InstanceRecord): string {
  return `http://127.0.0.1:${instance.port}`;
}

export function fetchReview(base: string, token: string, reviewId: string): Promise<ReviewSession> {
  return request<ReviewSession>(base, token, `/api/reviews/${reviewId}`);
}

export function decideReview(base: string, token: string, reviewId: string, action: 'approve' | 'reject', sql?: string): Promise<{ ok: boolean }> {
  return request(base, token, `/api/reviews/${reviewId}/${action}`, { method: 'POST', body: action === 'approve' ? { sql } : {} });
}

export function fetchSchema(base: string, token: string, connectionId: string): Promise<{ engine: string; schema: Record<string, string[]> }> {
  return request(base, token, `/api/schema?connection=${encodeURIComponent(connectionId)}`);
}

export function analyze(base: string, token: string, sql: string): Promise<{ analysis: SqlAnalysis }> {
  return request(base, token, '/api/analyze', { method: 'POST', body: { sql } });
}
