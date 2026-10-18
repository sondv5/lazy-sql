import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACES_FILE, atomicWrite, readEnv, readJsonFile, writeJsonFile } from './paths.js';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { listConnections, resolveConnectionToken } from './config.js';
import { removeProperty, setProperty } from './jsonc-edit.js';
import { logError } from './logger.js';

export const MCP_NAME = 'lazy-sql';
// Keys used before the app was renamed; existing registrations are recognised and migrated on the next toggle.
const LEGACY_MCP_NAMES = ['linkit-sql', 'sql-crew'];

function findServerEntry(container) {
  if (!container || typeof container !== 'object') return { entry: null, legacy: false };
  if (container[MCP_NAME]) return { entry: container[MCP_NAME], legacy: false };
  const legacyName = LEGACY_MCP_NAMES.find((name) => container[name]);
  return legacyName ? { entry: container[legacyName], legacy: true } : { entry: null, legacy: false };
}

const MCP_DESCRIPTION =
  'LAZY SQL — reviewed SQL execution MCP: execute_sql (approval popup for write statements), get_db_objects, open_db_config.';

export const TOOLS = {
  opencode: {
    label: 'OpenCode',
    kind: 'opencode',
    workspaceFiles: ['opencode.json', 'opencode.jsonc'],
    userFiles: ['~/.config/opencode/opencode.jsonc', '~/.config/opencode/opencode.json'],
    createUserFile: '~/.config/opencode/opencode.json',
    createWorkspaceFile: 'opencode.json'
  },
  claude: {
    label: 'Claude Code',
    kind: 'mcpServers',
    workspaceFiles: ['.mcp.json'],
    userFiles: ['~/.claude.json'],
    createUserFile: '~/.claude.json',
    createWorkspaceFile: '.mcp.json'
  },
  kiro: {
    label: 'Kiro',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.kiro', 'settings', 'mcp.json')],
    userFiles: ['~/.kiro/settings/mcp.json'],
    createUserFile: '~/.kiro/settings/mcp.json',
    createWorkspaceFile: path.join('.kiro', 'settings', 'mcp.json')
  },
  cursor: {
    label: 'Cursor',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.cursor', 'mcp.json')],
    userFiles: ['~/.cursor/mcp.json'],
    createUserFile: '~/.cursor/mcp.json',
    createWorkspaceFile: path.join('.cursor', 'mcp.json')
  }
};

export const TOOL_KEYS = Object.keys(TOOLS);

function homePath(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function engineEntryPath() {
  const entry = readEnv('ENGINE_ENTRY') || process.argv[1] || '';
  return path.resolve(entry);
}

export function parseJsonc(text) {
  const errors = [];
  const value = parse(String(text).replace(/^﻿/, ''), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`invalid JSON (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})`);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ---------- editing a tool config as text ----------
 * The registration is changed with minimal text edits instead of parse → stringify, so comments,
 * key order, trailing commas and the file's own indentation / line endings all survive. */

function containerKeyFor(tool) {
  return tool.kind === 'opencode' ? 'mcp' : 'mcpServers';
}

function buildEntry(tool, env) {
  if (tool.kind === 'opencode') {
    return {
      type: 'local',
      command: ['node', engineEntryPath()],
      enabled: true,
      ...(Object.keys(env).length ? { environment: env } : {})
    };
  }
  return {
    command: 'node',
    args: [engineEntryPath()],
    ...(Object.keys(env).length ? { env } : {}),
    description: MCP_DESCRIPTION
  };
}

// Returns the new config text for the requested registration change (unchanged text when there is nothing to do).
function editConfigText(text, tool, { enabled, env }) {
  const containerKey = containerKeyFor(tool);
  let current = text;

  let container = parseJsonc(current)[containerKey];
  if (!isPlainObject(container)) {
    if (!enabled) return text;
    current = setProperty(current, [containerKey], {});
    container = {};
  }

  // registrations made before the app was renamed move to the current key
  for (const legacyName of LEGACY_MCP_NAMES) {
    if (!(legacyName in container)) continue;
    if (!(MCP_NAME in container)) current = setProperty(current, [containerKey, MCP_NAME], container[legacyName]);
    current = removeProperty(current, [containerKey, legacyName]);
  }
  container = parseJsonc(current)[containerKey];

  if (enabled) {
    current = setProperty(current, [containerKey, MCP_NAME], buildEntry(tool, env));
  } else if (tool.kind === 'opencode') {
    if (isPlainObject(container[MCP_NAME])) current = setProperty(current, [containerKey, MCP_NAME, 'enabled'], false);
  } else if (MCP_NAME in container) {
    current = removeProperty(current, [containerKey, MCP_NAME]);
  }
  return current;
}

// The backup is the file exactly as it was before LAZY SQL first touched it; later edits never overwrite it.
// A backup made under the pre-rename suffix counts as the pristine original.
function backupOnce(file) {
  const backup = `${file}.lazy-sql-backup`;
  if (fs.existsSync(backup) || fs.existsSync(`${file}.sqlcrew-backup`)) return;
  try {
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    logError('Failed to back up the config file', error);
  }
}

/* ---------- connection scope ---------- */

// Allow-lists are stored as connection ids, so renaming a connection never silently revokes (or grants) access.
// `strict` (registering) rejects unknown entries and an empty selection instead of widening access to everything.
function normalizeConnectionScope(connections, { strict }) {
  if (connections === null || connections === undefined) return null;
  if (!Array.isArray(connections)) {
    throw new Error('connections must be a list of connection ids, or null to allow all connections.');
  }
  const known = listConnections();
  const ids = [];
  for (const token of connections) {
    const match = resolveConnectionToken(known, token);
    if (!match) {
      if (strict && String(token ?? '').trim()) throw new Error(`Unknown connection "${String(token).trim()}".`);
      continue;
    }
    if (!ids.includes(match.id)) ids.push(match.id);
  }
  if (strict && ids.length === 0) throw new Error('Select at least one connection, or allow all connections.');
  return ids;
}

// Reads an allow-list written in a tool config: ids (current) or names (older registrations).
function readAllowList(raw, known) {
  const text = String(raw ?? '').trim();
  if (!text || text === '*') return { ids: null, unknown: [] };
  const ids = [];
  const unknown = [];
  for (const token of text.split(',').map((part) => part.trim()).filter(Boolean)) {
    const match = resolveConnectionToken(known, token);
    if (!match) unknown.push(token);
    else if (!ids.includes(match.id)) ids.push(match.id);
  }
  return { ids, unknown };
}

function loadStore() {
  const stored = readJsonFile(WORKSPACES_FILE);
  return {
    workspaces: Array.isArray(stored?.workspaces) ? stored.workspaces : [],
    desired: stored?.desired && typeof stored.desired === 'object' ? stored.desired : {}
  };
}

function saveStore(store) {
  writeJsonFile(WORKSPACES_FILE, store);
}

function scopeKey(scopeType, scopePath) {
  return scopeType === 'user' ? 'user' : path.resolve(scopePath);
}

function buildEnv({ connections, forceReadOnly, scopeType, scopePath }) {
  const env = {};
  env.LAZY_SQL_INSTANCE_LABEL = scopeType === 'user' ? 'user' : path.basename(scopePath);
  if (Array.isArray(connections) && connections.length > 0) {
    env.LAZY_SQL_ALLOWED_CONNECTIONS = connections.join(',');
  }
  if (forceReadOnly) env.LAZY_SQL_FORCE_READ_ONLY = '1';
  return env;
}

function entrySnippet(tool, env) {
  return JSON.stringify({ [containerKeyFor(tool)]: { [MCP_NAME]: buildEntry(tool, env) } }, null, 2);
}

function readToolState(tool, file, known) {
  const state = {
    configPath: file,
    exists: false,
    registered: false,
    enabled: false,
    connections: null,
    unknownConnections: [],
    forceReadOnly: false,
    registeredEntry: null,
    needsUpdate: false,
    parseError: false,
    error: null
  };
  if (!file || !fs.existsSync(file)) return state;
  state.exists = true;
  try {
    const data = parseJsonc(fs.readFileSync(file, 'utf8'));
    const { entry, legacy } = findServerEntry(tool.kind === 'opencode' ? data?.mcp : data?.mcpServers);
    if (entry) {
      state.registered = true;
      state.enabled = tool.kind === 'opencode' ? entry.enabled !== false : entry.disabled !== true;
      const env = entry.environment ?? entry.env ?? {};
      // env values written before the rename live under SQL_CREW_*; they still count as registered scope
      const legacyEnv = Object.keys(env).some((key) => key.startsWith('SQL_CREW_'));
      const allowList = readAllowList(env.LAZY_SQL_ALLOWED_CONNECTIONS ?? env.SQL_CREW_ALLOWED_CONNECTIONS, known);
      state.connections = allowList.ids;
      state.unknownConnections = allowList.unknown;
      state.forceReadOnly = (env.LAZY_SQL_FORCE_READ_ONLY ?? env.SQL_CREW_FORCE_READ_ONLY) === '1';
      const args = tool.kind === 'opencode' ? (Array.isArray(entry.command) ? entry.command.slice(1) : []) : entry.args ?? [];
      state.registeredEntry = args[0] ? path.resolve(String(args[0])) : null;
      state.needsUpdate = legacy || legacyEnv || (Boolean(state.registeredEntry) && state.registeredEntry !== engineEntryPath());
    }
  } catch (error) {
    state.parseError = true;
    state.error = error.message;
  }
  return state;
}

function scanScope(scopeType, scopePath, store, known) {
  const tools = {};
  for (const [toolKey, tool] of Object.entries(TOOLS)) {
    const candidates =
      scopeType === 'user'
        ? tool.userFiles.map(homePath)
        : tool.workspaceFiles.map((file) => path.join(scopePath, file));
    const file = candidates.find((candidate) => fs.existsSync(candidate)) ?? homePath(candidates[0]);
    const state = readToolState(tool, file, known);
    state.candidates = candidates;
    state.desired = store.desired[scopeKey(scopeType, scopePath)]?.[toolKey] ?? null;
    tools[toolKey] = state;
  }
  return tools;
}

export function scanWorkspaces() {
  const store = loadStore();
  const known = listConnections();
  return {
    mcpName: MCP_NAME,
    engineEntry: engineEntryPath(),
    node: process.version,
    tools: Object.fromEntries(Object.entries(TOOLS).map(([key, tool]) => [key, { label: tool.label }])),
    connections: known.map((connection) => ({
      id: connection.id,
      name: connection.name,
      engine: connection.engine,
      enabled: connection.enabled,
      readOnly: connection.readOnly
    })),
    user: scanScope('user', null, store, known),
    workspaces: store.workspaces.map((workspace) => ({
      path: workspace.path,
      label: workspace.label ?? path.basename(workspace.path),
      addedAt: workspace.addedAt ?? null,
      exists: fs.existsSync(workspace.path),
      tools: scanScope('workspace', workspace.path, store, known)
    }))
  };
}

export function addWorkspace(folderPath) {
  const resolved = path.resolve(String(folderPath ?? '').trim());
  if (!resolved) throw new Error('A folder path is required.');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Folder not found: ${resolved}`);
  }
  const store = loadStore();
  if (!store.workspaces.some((workspace) => path.resolve(workspace.path) === resolved)) {
    store.workspaces.push({ path: resolved, label: path.basename(resolved), addedAt: new Date().toISOString() });
    saveStore(store);
  }
  return { path: resolved };
}

export function removeWorkspace(folderPath) {
  const resolved = path.resolve(String(folderPath ?? '').trim());
  const store = loadStore();
  const before = store.workspaces.length;
  store.workspaces = store.workspaces.filter((workspace) => path.resolve(workspace.path) !== resolved);
  delete store.desired[resolved];
  if (store.workspaces.length !== before) saveStore(store);
  return { removed: store.workspaces.length !== before };
}

export function applyTool({ scopeType, scopePath, tool: toolKey, enabled, connections, forceReadOnly }) {
  const tool = TOOLS[toolKey];
  if (!tool) throw new Error(`Unknown tool: ${toolKey}`);
  if (!['user', 'workspace'].includes(scopeType)) throw new Error('scopeType must be user or workspace');

  const resolvedScope = scopeType === 'workspace' ? path.resolve(String(scopePath ?? '')) : null;
  if (scopeType === 'workspace' && (!resolvedScope || !fs.existsSync(resolvedScope))) {
    throw new Error('The workspace folder does not exist.');
  }

  // validated before anything is written: an empty or unknown selection is refused, never turned into "all"
  const scopeIds = normalizeConnectionScope(connections, { strict: Boolean(enabled) });
  const env = buildEnv({ connections: scopeIds, forceReadOnly, scopeType, scopePath: resolvedScope });
  const candidates =
    scopeType === 'user'
      ? tool.userFiles.map(homePath)
      : tool.workspaceFiles.map((file) => path.join(resolvedScope, file));

  let file = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  const creating = !file && Boolean(enabled);
  if (creating) {
    file = scopeType === 'user' ? homePath(tool.createUserFile) : path.join(resolvedScope, tool.createWorkspaceFile);
  }
  if (!file) {
    return { ok: true, changed: false, reason: 'Nothing to disable — no config file found.' };
  }

  const existed = fs.existsSync(file);
  const originalText = existed ? fs.readFileSync(file, 'utf8') : '';
  const bom = originalText.startsWith('﻿') ? '﻿' : '';
  const hasContent = originalText.slice(bom.length).trim().length > 0;
  const baseText = hasContent ? originalText.slice(bom.length) : '{}\n';

  try {
    if (!isPlainObject(parseJsonc(baseText))) throw new Error('config root must be a JSON object');
  } catch (error) {
    return {
      ok: false,
      changed: false,
      reason: 'parse_error',
      message: `Could not edit ${file}: ${error.message}`,
      file,
      snippet: entrySnippet(tool, env)
    };
  }

  const nextText = bom + editConfigText(baseText, tool, { enabled: Boolean(enabled), env });
  try {
    parseJsonc(nextText);
  } catch (error) {
    // never write a file we could not read back
    return { ok: false, changed: false, reason: 'parse_error', message: `Could not edit ${file}: ${error.message}`, file, snippet: entrySnippet(tool, env) };
  }
  const changed = nextText !== originalText;
  if (changed) {
    if (hasContent) backupOnce(file);
    atomicWrite(file, nextText);
  }

  const store = loadStore();
  const scope = scopeKey(scopeType, resolvedScope);
  store.desired[scope] = store.desired[scope] ?? {};
  store.desired[scope][toolKey] = {
    enabled: Boolean(enabled),
    connections: scopeIds,
    forceReadOnly: Boolean(forceReadOnly)
  };
  saveStore(store);

  return changed ? { ok: true, changed: true, file } : { ok: true, changed: false, reason: 'Already up to date.', file };
}
