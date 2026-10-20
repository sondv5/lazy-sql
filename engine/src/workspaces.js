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

/* ---------- config locations ---------- */

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function xdgConfigDir() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

// VS Code (and the VS Code based extensions) keep user data here on every platform.
function vscodeConfigDir() {
  if (process.platform === 'win32') return path.join(appDataDir(), 'Code');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code');
  return path.join(xdgConfigDir(), 'Code');
}

function vscodeUserFile(file) {
  return path.join(vscodeConfigDir(), 'User', file);
}

function vscodeInsidersUserFile(file) {
  const base = process.platform === 'win32' ? appDataDir() : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : xdgConfigDir();
  return path.join(base, 'Code - Insiders', 'User', file);
}

function vscodeGlobalStorage(extension, file) {
  return path.join(vscodeConfigDir(), 'User', 'globalStorage', extension, 'settings', file);
}

function devinConfigFile() {
  return process.platform === 'win32'
    ? path.join(appDataDir(), 'devin', 'mcp_config.json')
    : path.join(xdgConfigDir(), 'devin', 'mcp_config.json');
}

function zedConfigFile() {
  return process.platform === 'win32'
    ? path.join(appDataDir(), 'Zed', 'settings.json')
    : path.join(xdgConfigDir(), 'zed', 'settings.json');
}

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
  cursor: {
    label: 'Cursor',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.cursor', 'mcp.json')],
    userFiles: ['~/.cursor/mcp.json'],
    createUserFile: '~/.cursor/mcp.json',
    createWorkspaceFile: path.join('.cursor', 'mcp.json')
  },
  windsurf: {
    label: 'Windsurf',
    kind: 'mcpServers',
    workspaceFiles: [],
    userFiles: [devinConfigFile(), '~/.codeium/windsurf/mcp_config.json'],
    createUserFile: devinConfigFile()
  },
  vscode: {
    label: 'VS Code (Copilot)',
    kind: 'vscode',
    workspaceFiles: [path.join('.vscode', 'mcp.json')],
    userFiles: [vscodeUserFile('mcp.json'), vscodeInsidersUserFile('mcp.json')],
    createUserFile: vscodeUserFile('mcp.json'),
    createWorkspaceFile: path.join('.vscode', 'mcp.json')
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.github', 'mcp.json')],
    userFiles: ['~/.copilot/mcp-config.json'],
    createUserFile: '~/.copilot/mcp-config.json',
    createWorkspaceFile: path.join('.github', 'mcp.json')
  },
  codex: {
    label: 'OpenAI Codex',
    kind: 'codex',
    workspaceFiles: [path.join('.codex', 'config.toml')],
    userFiles: ['~/.codex/config.toml'],
    createUserFile: '~/.codex/config.toml',
    createWorkspaceFile: path.join('.codex', 'config.toml')
  },
  gemini: {
    label: 'Gemini CLI',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.gemini', 'settings.json')],
    userFiles: ['~/.gemini/settings.json'],
    createUserFile: '~/.gemini/settings.json',
    createWorkspaceFile: path.join('.gemini', 'settings.json')
  },
  qwen: {
    label: 'Qwen Code',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.qwen', 'settings.json')],
    userFiles: ['~/.qwen/settings.json'],
    createUserFile: '~/.qwen/settings.json',
    createWorkspaceFile: path.join('.qwen', 'settings.json')
  },
  kiro: {
    label: 'Kiro',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.kiro', 'settings', 'mcp.json')],
    userFiles: ['~/.kiro/settings/mcp.json'],
    createUserFile: '~/.kiro/settings/mcp.json',
    createWorkspaceFile: path.join('.kiro', 'settings', 'mcp.json')
  },
  cline: {
    label: 'Cline',
    kind: 'mcpServers',
    workspaceFiles: [],
    userFiles: [
      vscodeGlobalStorage('saoudrizwan.claude-dev', 'cline_mcp_settings.json'),
      '~/.cline/data/settings/cline_mcp_settings.json'
    ],
    createUserFile: vscodeGlobalStorage('saoudrizwan.claude-dev', 'cline_mcp_settings.json')
  },
  roo: {
    label: 'Roo Code',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.roo', 'mcp.json')],
    userFiles: [vscodeGlobalStorage('rooveterinaryinc.roo-cline', 'mcp_settings.json')],
    createUserFile: vscodeGlobalStorage('rooveterinaryinc.roo-cline', 'mcp_settings.json'),
    createWorkspaceFile: path.join('.roo', 'mcp.json')
  },
  kilo: {
    label: 'Kilo Code',
    kind: 'mcpServers',
    workspaceFiles: [],
    userFiles: [vscodeGlobalStorage('kilocode.kilo-code', 'mcp_settings.json')],
    createUserFile: vscodeGlobalStorage('kilocode.kilo-code', 'mcp_settings.json')
  },
  junie: {
    label: 'JetBrains Junie',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.junie', 'mcp', 'mcp.json')],
    userFiles: ['~/.junie/mcp/mcp.json'],
    createUserFile: '~/.junie/mcp/mcp.json',
    createWorkspaceFile: path.join('.junie', 'mcp', 'mcp.json')
  },
  droid: {
    label: 'Factory Droid',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.factory', 'mcp.json')],
    userFiles: ['~/.factory/mcp.json'],
    createUserFile: '~/.factory/mcp.json',
    createWorkspaceFile: path.join('.factory', 'mcp.json')
  },
  zed: {
    label: 'Zed',
    kind: 'zed',
    workspaceFiles: [path.join('.zed', 'settings.json')],
    userFiles: [zedConfigFile()],
    createUserFile: zedConfigFile(),
    createWorkspaceFile: path.join('.zed', 'settings.json')
  },
  amazonq: {
    label: 'Amazon Q Developer',
    kind: 'mcpServers',
    workspaceFiles: [path.join('.amazonq', 'default.json'), path.join('.amazonq', 'mcp.json')],
    userFiles: ['~/.aws/amazonq/default.json', '~/.aws/amazonq/mcp.json'],
    createUserFile: '~/.aws/amazonq/default.json',
    createWorkspaceFile: path.join('.amazonq', 'default.json')
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

const CONTAINER_KEYS = { opencode: 'mcp', vscode: 'servers', zed: 'context_servers' };

function containerKeyFor(tool) {
  return CONTAINER_KEYS[tool.kind] ?? 'mcpServers';
}

function buildEntry(tool, env) {
  const entryPath = engineEntryPath();
  switch (tool.kind) {
    case 'opencode':
      return {
        type: 'local',
        command: ['node', entryPath],
        enabled: true,
        ...(Object.keys(env).length ? { environment: env } : {})
      };
    case 'vscode':
      return {
        type: 'stdio',
        command: 'node',
        args: [entryPath],
        ...(Object.keys(env).length ? { env } : {})
      };
    case 'zed':
      return {
        source: 'custom',
        command: {
          path: 'node',
          args: [entryPath],
          ...(Object.keys(env).length ? { env } : {})
        }
      };
    default:
      return {
        command: 'node',
        args: [entryPath],
        ...(Object.keys(env).length ? { env } : {}),
        description: MCP_DESCRIPTION
      };
  }
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

/* ---------- Codex TOML ----------
 * Codex is the only supported client that reads TOML. Only the `[mcp_servers.lazy-sql]` table is
 * rewritten (other tables, comments and formatting are left alone), which keeps this dependency-free. */

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlString(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}

function parseTomlString(value) {
  return String(value).replace(/\\(u[0-9a-fA-F]{4}|["\\bfnrt])/g, (match, code) => {
    switch (code) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    }
  });
}

function codexNamePattern(name) {
  const key = escapeRegExp(name);
  return `(?:"${key}"|'${key}'|${key})`;
}

function codexHeader(name) {
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${codexNamePattern(name)}\\s*\\]\\s*(?:#.*)?$`, 'i');
}

function codexChildHeader(name) {
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${codexNamePattern(name)}\\s*\\.`, 'i');
}

function findCodexSection(text, name) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const matcher = codexHeader(name);
  const childMatcher = codexChildHeader(name);
  const start = lines.findIndex((line) => matcher.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (!/^\s*\[/.test(lines[index])) continue;
    if (childMatcher.test(lines[index])) continue;
    end = index;
    break;
  }
  return { start, end, lines };
}

function removeCodexSection(text, name) {
  let current = String(text);
  for (;;) {
    const found = findCodexSection(current, name);
    if (!found) return current;
    found.lines.splice(found.start, found.end - found.start);
    current = found.lines.join('\n');
  }
}

function readCodexSection(text, name) {
  const found = findCodexSection(text, name);
  if (!found) return null;
  const body = found.lines.slice(found.start + 1, found.end).join('\n');
  const command = body.match(/\bcommand\s*=\s*"((?:\\.|[^"\\])*)"/);
  const argsMatch = body.match(/\bargs\s*=\s*\[([\s\S]*?)\]/);
  const args = argsMatch ? [...argsMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => parseTomlString(match[1])) : [];
  const env = {};
  const envMatch = body.match(/\benv\s*=\s*\{([\s\S]*?)\}/);
  let envBody = envMatch ? envMatch[1] : '';
  if (!envMatch) {
    const envHeader = new RegExp(`\\[\\s*mcp_servers\\s*\\.\\s*${codexNamePattern(name)}\\s*\\.\\s*(?:"env"|'env'|env)\\s*\\]`, 'i').exec(body);
    if (envHeader) envBody = body.slice(envHeader.index + envHeader[0].length);
  }
  for (const match of envBody.matchAll(/([A-Za-z0-9_.-]+)\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
    env[match[1]] = parseTomlString(match[2]);
  }
  return { command: command ? parseTomlString(command[1]) : null, args, env };
}

function codexEntryText(env) {
  const lines = ['[mcp_servers."lazy-sql"]', 'command = "node"', `args = [${tomlString(engineEntryPath())}]`];
  const entries = Object.entries(env);
  if (entries.length > 0) {
    lines.push(`env = { ${entries.map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`);
  }
  lines.push('startup_timeout_sec = 20');
  return lines.join('\n');
}

function editCodexText(text, { enabled, env }) {
  let current = String(text);
  for (const name of [MCP_NAME, ...LEGACY_MCP_NAMES]) current = removeCodexSection(current, name);
  if (!enabled) return current.replace(/^\s*\n/, '');
  const base = current.replace(/\s+$/, '');
  return `${base ? `${base}\n\n` : ''}${codexEntryText(env)}\n`;
}

function hasInlineMcpServers(text) {
  return /^\s*mcp_servers\s*=/m.test(String(text));
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
  if (tool.kind === 'codex') return codexEntryText(env);
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
    const text = fs.readFileSync(file, 'utf8');
    if (!text.replace(/^﻿/, '').trim()) return state;
    if (tool.kind === 'codex') {
      const current = [MCP_NAME, ...LEGACY_MCP_NAMES].map((name) => ({ name, parsed: readCodexSection(text, name) })).find((entry) => entry.parsed);
      if (!current) return state;
      state.registered = true;
      state.enabled = true;
      const env = current.parsed.env ?? {};
      const allowList = readAllowList(env.LAZY_SQL_ALLOWED_CONNECTIONS ?? env.SQL_CREW_ALLOWED_CONNECTIONS, known);
      state.connections = allowList.ids;
      state.unknownConnections = allowList.unknown;
      state.forceReadOnly = (env.LAZY_SQL_FORCE_READ_ONLY ?? env.SQL_CREW_FORCE_READ_ONLY) === '1';
      state.registeredEntry = current.parsed.args[0] ? path.resolve(String(current.parsed.args[0])) : null;
      state.needsUpdate = current.name !== MCP_NAME || (Boolean(state.registeredEntry) && state.registeredEntry !== engineEntryPath());
      return state;
    }

    const data = parseJsonc(text);
    const { entry, legacy } = findServerEntry(data?.[containerKeyFor(tool)]);
    if (entry) {
      state.registered = true;
      state.enabled = tool.kind === 'opencode' ? entry.enabled !== false : entry.disabled !== true;
      const env = (tool.kind === 'zed' ? entry.command?.env : entry.environment ?? entry.env) ?? {};
      const args = tool.kind === 'opencode'
        ? (Array.isArray(entry.command) ? entry.command.slice(1) : [])
        : tool.kind === 'zed'
          ? (Array.isArray(entry.command?.args) ? entry.command.args : [])
          : entry.args ?? [];
      // env values written before the rename live under SQL_CREW_*; they still count as registered scope
      const legacyEnv = Object.keys(env).some((key) => key.startsWith('SQL_CREW_'));
      const allowList = readAllowList(env.LAZY_SQL_ALLOWED_CONNECTIONS ?? env.SQL_CREW_ALLOWED_CONNECTIONS, known);
      state.connections = allowList.ids;
      state.unknownConnections = allowList.unknown;
      state.forceReadOnly = (env.LAZY_SQL_FORCE_READ_ONLY ?? env.SQL_CREW_FORCE_READ_ONLY) === '1';
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
    const file = candidates.find((candidate) => fs.existsSync(candidate)) ?? (candidates[0] ? homePath(candidates[0]) : null);
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
    const target = scopeType === 'user' ? tool.createUserFile : tool.createWorkspaceFile;
    if (!target) throw new Error(`${tool.label} has no ${scopeType === 'user' ? 'user' : 'project'} MCP config file.`);
    file = scopeType === 'user' ? homePath(target) : path.join(resolvedScope, target);
  }
  if (!file) {
    return { ok: true, changed: false, reason: 'Nothing to disable — no config file found.' };
  }

  const existed = fs.existsSync(file);
  const originalText = existed ? fs.readFileSync(file, 'utf8') : '';
  const bom = originalText.startsWith('﻿') ? '﻿' : '';
  const hasContent = originalText.slice(bom.length).trim().length > 0;
  const baseText = hasContent ? originalText.slice(bom.length) : tool.kind === 'codex' ? '' : '{}\n';

  let nextText;
  try {
    if (tool.kind === 'codex') {
      if (hasInlineMcpServers(baseText)) {
        throw new Error('mcp_servers is defined as an inline table; add the LAZY SQL table manually.');
      }
      nextText = bom + editCodexText(baseText, { enabled: Boolean(enabled), env });
    } else {
      if (!isPlainObject(parseJsonc(baseText))) throw new Error('config root must be a JSON object');
      nextText = bom + editConfigText(baseText, tool, { enabled: Boolean(enabled), env });
      // never write a file we could not read back
      parseJsonc(nextText);
    }
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
