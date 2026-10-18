import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sql-unit-'));
process.env.LAZY_SQL_DATA_DIR = path.join(tmpDir, 'data');
process.env.LAZY_SQL_UNIT_TEST_HOST = 'db.internal';

const { analyzeSql, classifyStatement, splitStatements, transformOutsideQuotes } = await import('../src/classify.js');
const { resolveSecretValue, toPublicConnection, buildConnectionRecord, getAllowedConnections, isForceReadOnly, materializeConnection } =
  await import('../src/config.js');
const { buildOpenCommand } = await import('../src/openBrowser.js');
const { getResponseBudget, jsonSize, trimPayloadArray } = await import('../src/budget.js');
const { importConfig, buildExport, parseImportPayload } = await import('../src/transfer.js');
const { applyTool, scanWorkspaces, addWorkspace, removeWorkspace, parseJsonc, engineEntryPath } = await import(
  '../src/workspaces.js'
);
const { upsertConnection, saveConfig, listEnabledConnections, loadConfig } = await import('../src/config.js');
const { setProperty, removeProperty } = await import('../src/jsonc-edit.js');
const { saveAppSettings, getAppSettings } = await import('../src/settings.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('unit: classify');
test('splitStatements keeps single statements intact', () => {
  assert.deepEqual(splitStatements('SELECT 1'), ['SELECT 1']);
});
test('splitStatements splits on semicolons and ignores quoted ones', () => {
  assert.deepEqual(splitStatements("SELECT ';' AS x; SELECT 2"), ["SELECT ';' AS x", 'SELECT 2']);
});
test('classifyStatement handles CTEs, DDL and writes', () => {
  assert.equal(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x').type, 'read');
  assert.equal(classifyStatement('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x').type, 'write');
  assert.equal(classifyStatement('DROP TABLE t').stronglyDestructive, true);
  assert.equal(classifyStatement('TRUNCATE TABLE t').stronglyDestructive, true);
});
test('analyzeSql marks updates dangerous and selects read-only', () => {
  const update = analyzeSql('UPDATE t SET a = 1');
  assert.equal(update.dangerous, true);
  assert.equal(update.requiresConfirmation, true);
  assert.equal(analyzeSql('BEGIN; SELECT 1; COMMIT').isReadOnly, true);
  assert.deepEqual(analyzeSql('SELECT 1; DELETE FROM t').keywords.sort(), ['DELETE', 'SELECT']);
});
test('transformOutsideQuotes only rewrites code segments', () => {
  assert.equal(transformOutsideQuotes("SELECT '?' , ?", (code) => code.replace(/\?/g, '@p1')), "SELECT '?' , @p1");
});

console.log('unit: budget');
test('trims large arrays to fit the budget', () => {
  const payload = { status: 'ok', items: Array.from({ length: 100 }, (_, index) => ({ id: index, text: 'x'.repeat(50) })) };
  const { omitted } = trimPayloadArray(payload, 'items', 500);
  assert.ok(omitted > 0);
  assert.ok(jsonSize(payload) <= 500);
});
test('budget env value is clamped (LAZY_SQL prefix)', () => {
  process.env.LAZY_SQL_MAX_RESPONSE_CHARS = '100';
  assert.equal(getResponseBudget(), 5000);
  process.env.LAZY_SQL_MAX_RESPONSE_CHARS = '9999999';
  assert.equal(getResponseBudget(), 500000);
  delete process.env.LAZY_SQL_MAX_RESPONSE_CHARS;
  assert.equal(getResponseBudget(), 50000);
});
test('legacy SQL_CREW_* env names still work as a fallback', () => {
  process.env.SQL_CREW_MAX_RESPONSE_CHARS = '9999999';
  assert.equal(getResponseBudget(), 500000);
  process.env.LAZY_SQL_MAX_RESPONSE_CHARS = '100';
  assert.equal(getResponseBudget(), 5000, 'the new name wins over the legacy one');
  delete process.env.SQL_CREW_MAX_RESPONSE_CHARS;
  delete process.env.LAZY_SQL_MAX_RESPONSE_CHARS;
});

console.log('unit: config');
test('resolves ${ENV} secrets and passes literals through', () => {
  assert.equal(resolveSecretValue('${LAZY_SQL_UNIT_TEST_HOST}'), 'db.internal');
  assert.equal(resolveSecretValue('localhost'), 'localhost');
});
test('public connection never exposes the password', () => {
  const publicConnection = toPublicConnection({ id: '1', name: 'n', engine: 'sqlite', file: 'x.db', password: 'secret' });
  assert.equal(publicConnection.hasPassword, true);
  assert.ok(!('password' in publicConnection));
  assert.equal(publicConnection.enabled, true);
});
test('buildConnectionRecord defaults enabled to true and validates required fields', () => {
  const record = buildConnectionRecord({ name: 'a', engine: 'sqlite', file: 'x.db' }, null);
  assert.equal(record.enabled, true);
  assert.throws(() => buildConnectionRecord({ name: 'b', engine: 'postgres' }, null), /database is required/);
});
test('disabled connections are excluded from the enabled list', () => {
  saveConfig({ connections: [] });
  upsertConnection({ name: 'on-db', engine: 'sqlite', file: 'a.db', enabled: true });
  upsertConnection({ name: 'off-db', engine: 'sqlite', file: 'b.db', enabled: false });
  assert.deepEqual(listEnabledConnections().map((c) => c.name), ['on-db']);
});
test('LAZY_SQL_ALLOWED_CONNECTIONS filters by name', () => {
  delete process.env.LAZY_SQL_ALLOWED_CONNECTIONS;
  assert.equal(getAllowedConnections(), null);
  process.env.LAZY_SQL_ALLOWED_CONNECTIONS = 'ON-DB';
  assert.deepEqual(listEnabledConnections().map((c) => c.name), ['on-db']);
  process.env.LAZY_SQL_ALLOWED_CONNECTIONS = 'missing';
  assert.deepEqual(listEnabledConnections(), []);
  process.env.LAZY_SQL_ALLOWED_CONNECTIONS = '*';
  assert.deepEqual(listEnabledConnections().map((c) => c.name), ['on-db']);
  delete process.env.LAZY_SQL_ALLOWED_CONNECTIONS;
});
test('a malformed allow-list allows nothing instead of everything', () => {
  saveConfig({ connections: [] });
  upsertConnection({ name: 'on-db', engine: 'sqlite', file: 'a.db', enabled: true });
  for (const value of [',', ' , ,']) {
    process.env.LAZY_SQL_ALLOWED_CONNECTIONS = value;
    assert.deepEqual(listEnabledConnections(), [], `"${value}" must not widen access`);
  }
  process.env.LAZY_SQL_ALLOWED_CONNECTIONS = '';
  assert.equal(getAllowedConnections(), null, 'an empty value still means unrestricted');
  delete process.env.LAZY_SQL_ALLOWED_CONNECTIONS;
});
test('allow-list entries match connection ids as well as names', () => {
  saveConfig({ connections: [] });
  const first = upsertConnection({ name: 'first-db', engine: 'sqlite', file: 'a.db' });
  upsertConnection({ name: 'second-db', engine: 'sqlite', file: 'b.db' });
  process.env.LAZY_SQL_ALLOWED_CONNECTIONS = first.id;
  assert.deepEqual(listEnabledConnections().map((c) => c.name), ['first-db']);
  delete process.env.LAZY_SQL_ALLOWED_CONNECTIONS;
});
test('LAZY_SQL_FORCE_READ_ONLY forces read-only materialization', () => {
  assert.equal(isForceReadOnly(), false);
  const record = buildConnectionRecord({ name: 'rw', engine: 'sqlite', file: 'a.db' }, null);
  assert.equal(materializeConnection(record).readOnly, false);
  process.env.LAZY_SQL_FORCE_READ_ONLY = '1';
  assert.equal(materializeConnection(record).readOnly, true);
  delete process.env.LAZY_SQL_FORCE_READ_ONLY;
});
test('legacy SQL_CREW_FORCE_READ_ONLY is honoured too', () => {
  process.env.SQL_CREW_FORCE_READ_ONLY = '1';
  assert.equal(isForceReadOnly(), true);
  delete process.env.SQL_CREW_FORCE_READ_ONLY;
});

console.log('unit: transfer');
test('export strips passwords by default and includes them on request', () => {
  saveConfig({ connections: [] });
  upsertConnection({ name: 'exp-db', engine: 'sqlite', file: 'exp.db' });
  const stored = loadConfig().connections[0];
  stored.password = 'pw';
  saveConfig({ connections: [stored] });

  const without = buildExport({ includePasswords: false });
  assert.equal(without.connections[0].password, null);
  const withPw = buildExport({ includePasswords: true });
  assert.equal(withPw.connections[0].password, 'pw');
});
test('parseImportPayload accepts envelopes, connection lists and rejects junk', () => {
  assert.equal(parseImportPayload([{ name: 'a' }]).connections.length, 1);
  assert.equal(parseImportPayload({ connections: [] }).connections.length, 0);
  assert.throws(() => parseImportPayload({ nope: true }), /Unrecognized/);
});
test('importConfig supports skip / overwrite / rename modes', () => {
  saveConfig({ connections: [] });
  upsertConnection({ name: 'dup', engine: 'sqlite', file: 'one.db' });
  const payload = { connections: [{ name: 'dup', engine: 'sqlite', file: 'two.db' }] };

  assert.equal(importConfig(payload, { mode: 'skip' }).skipped, 1);
  assert.equal(loadConfig().connections[0].file, 'one.db');

  assert.equal(importConfig(payload, { mode: 'overwrite' }).overwritten, 1);
  assert.equal(loadConfig().connections[0].file, 'two.db');

  const renamed = importConfig(payload, { mode: 'rename' });
  assert.equal(renamed.renamed, 1);
  assert.ok(loadConfig().connections.some((c) => c.name === 'dup (imported)'));
});
test('importConfig without passwords keeps the existing password on overwrite', () => {
  saveConfig({ connections: [] });
  upsertConnection({ name: 'pw-db', engine: 'postgres', host: 'localhost', database: 'appdb', user: 'app' });
  const stored = loadConfig().connections[0];
  stored.password = 'keep-me';
  saveConfig({ connections: [stored] });

  importConfig(
    { connections: [{ name: 'pw-db', engine: 'postgres', host: 'localhost', database: 'appdb', user: 'app' }] },
    { mode: 'overwrite', includePasswords: false }
  );
  assert.equal(loadConfig().connections[0].password, 'keep-me');
});
test('importConfig reports per-item errors instead of failing the batch', () => {
  saveConfig({ connections: [] });
  const summary = importConfig(
    { connections: [{ name: 'broken', engine: 'nope' }, { name: 'good', engine: 'sqlite', file: 'g.db' }] },
    { mode: 'skip' }
  );
  assert.equal(summary.imported, 1);
  assert.equal(summary.errors.length, 1);
});

console.log('unit: workspaces');
// fresh connection set for the workspace tests; returns name -> id
function seedConnections(...names) {
  saveConfig({ connections: [] });
  return Object.fromEntries(names.map((name) => [name, upsertConnection({ name, engine: 'sqlite', file: `${name}.db` }).id]));
}

test('parseJsonc handles comments, trailing commas, a BOM and strings that look like comments', () => {
  const raw = '﻿{\n // line comment\n "url": "http://x//y", /* block */ "n": 1,\n}';
  assert.equal(parseJsonc(raw).url, 'http://x//y');
  assert.equal(parseJsonc(raw).n, 1);
  assert.throws(() => parseJsonc('{ nope'), /invalid JSON/);
});
test('applyTool writes an mcpServers entry with env filters (cursor)', () => {
  const ids = seedConnections('alpha', 'beta');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
  const result = applyTool({
    scopeType: 'workspace',
    scopePath: ws,
    tool: 'cursor',
    enabled: true,
    connections: [ids.alpha, ids.beta],
    forceReadOnly: true
  });
  assert.equal(result.ok, true);
  const written = JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8'));
  const entry = written.mcpServers['lazy-sql'];
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, [engineEntryPath()]);
  assert.equal(entry.env.LAZY_SQL_ALLOWED_CONNECTIONS, `${ids.alpha},${ids.beta}`);
  assert.equal(entry.env.LAZY_SQL_FORCE_READ_ONLY, '1');
  assert.ok(entry.env.LAZY_SQL_INSTANCE_LABEL.length > 0);
});
test('scan reports the applied state and toggle-off removes the entry', () => {
  const ids = seedConnections('alpha');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-scan-'));
  addWorkspace(ws);
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: [ids.alpha], forceReadOnly: false });
  let scan = scanWorkspaces();
  const workspace = scan.workspaces.find((w) => path.resolve(w.path) === path.resolve(ws));
  assert.equal(workspace.tools.cursor.registered, true);
  assert.equal(workspace.tools.cursor.enabled, true);
  assert.deepEqual(workspace.tools.cursor.connections, [ids.alpha]);
  assert.deepEqual(workspace.tools.cursor.unknownConnections, []);
  assert.equal(workspace.tools.cursor.needsUpdate, false);

  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: false });
  scan = scanWorkspaces();
  const again = scan.workspaces.find((w) => path.resolve(w.path) === path.resolve(ws));
  assert.equal(again.tools.cursor.registered, false);
  const raw = JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(raw.mcpServers['lazy-sql'], undefined);
  removeWorkspace(ws);
});
test('applyTool preserves existing JSONC content (opencode)', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-opencode-'));
  fs.writeFileSync(
    path.join(ws, 'opencode.jsonc'),
    '{\n  // keep me\n  "skills": { "paths": [".cursor/skills"] },\n}\n'
  );
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'opencode', enabled: true, connections: null, forceReadOnly: false });
  const written = parseJsonc(fs.readFileSync(path.join(ws, 'opencode.jsonc'), 'utf8'));
  assert.deepEqual(written.skills.paths, ['.cursor/skills']);
  assert.equal(written.mcp['lazy-sql'].type, 'local');
  assert.deepEqual(written.mcp['lazy-sql'].command[1], engineEntryPath());
  assert.equal(written.mcp['lazy-sql'].enabled, true);

  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'opencode', enabled: false });
  const disabled = parseJsonc(fs.readFileSync(path.join(ws, 'opencode.jsonc'), 'utf8'));
  assert.equal(disabled.mcp['lazy-sql'].enabled, false);
});
test('entries registered under the pre-rename key are detected and migrated', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-legacy-'));
  fs.mkdirSync(path.join(ws, '.cursor'));
  fs.writeFileSync(
    path.join(ws, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'linkit-sql': { command: 'node', args: ['/old/engine.js'], env: { SQL_CREW_FORCE_READ_ONLY: '1' } }, other: { command: 'x' } } })
  );
  addWorkspace(ws);
  let scan = scanWorkspaces();
  let state = scan.workspaces.find((w) => path.resolve(w.path) === path.resolve(ws)).tools.cursor;
  assert.equal(state.registered, true, 'legacy entry counts as registered');
  assert.equal(state.needsUpdate, true, 'legacy entry is flagged for update');
  assert.equal(state.forceReadOnly, true);

  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: null, forceReadOnly: false });
  const raw = JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(raw.mcpServers['linkit-sql'], undefined, 'legacy key removed');
  assert.deepEqual(raw.mcpServers['lazy-sql'].args, [engineEntryPath()]);
  assert.equal('SQL_CREW_FORCE_READ_ONLY' in raw.mcpServers['lazy-sql'].env, false, 'legacy env key removed');
  assert.ok(raw.mcpServers.other, 'unrelated servers untouched');
  scan = scanWorkspaces();
  state = scan.workspaces.find((w) => path.resolve(w.path) === path.resolve(ws)).tools.cursor;
  assert.equal(state.needsUpdate, false);
  removeWorkspace(ws);
});
test('legacy SQL_CREW_* env entries are read and migrated on the next toggle', () => {
  const ids = seedConnections('alpha');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-legacy-env-'));
  addWorkspace(ws);
  fs.mkdirSync(path.join(ws, '.cursor'));
  fs.writeFileSync(
    path.join(ws, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        'lazy-sql': {
          command: 'node',
          args: [engineEntryPath()],
          env: { SQL_CREW_ALLOWED_CONNECTIONS: 'alpha', SQL_CREW_FORCE_READ_ONLY: '1' }
        }
      }
    })
  );
  let state = scanWorkspaces().workspaces.find((w) => path.resolve(w.path) === path.resolve(ws)).tools.cursor;
  assert.equal(state.registered, true);
  assert.deepEqual(state.connections, [ids.alpha], 'the legacy allow-list still counts');
  assert.equal(state.forceReadOnly, true, 'the legacy read-only flag still counts');
  assert.equal(state.needsUpdate, true, 'legacy env names are flagged for migration');

  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: null, forceReadOnly: false });
  const env = cursorEnv(ws);
  assert.equal('SQL_CREW_ALLOWED_CONNECTIONS' in env, false);
  assert.equal('SQL_CREW_FORCE_READ_ONLY' in env, false);
  assert.ok(env.LAZY_SQL_INSTANCE_LABEL.length > 0);
  state = scanWorkspaces().workspaces.find((w) => path.resolve(w.path) === path.resolve(ws)).tools.cursor;
  assert.equal(state.needsUpdate, false);
  removeWorkspace(ws);
});
test('applyTool returns a snippet when the config file cannot be parsed', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-broken-'));
  fs.writeFileSync(path.join(ws, '.mcp.json'), '{ this is not json !!!');
  const result = applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'claude', enabled: true, connections: null, forceReadOnly: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'parse_error');
  assert.ok(result.snippet.includes('lazy-sql'));
});

console.log('unit: workspaces (connection scope)');
function cursorEnv(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8')).mcpServers['lazy-sql'].env;
}
test('registering with an empty selection is refused and writes nothing', () => {
  seedConnections('alpha');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-empty-'));
  assert.throws(
    () => applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: [], forceReadOnly: false }),
    /at least one connection/
  );
  assert.equal(fs.existsSync(path.join(ws, '.cursor')), false, 'nothing may be written');
  // null is the only way to allow everything, and it writes no allow-list at all
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: null, forceReadOnly: false });
  assert.equal('LAZY_SQL_ALLOWED_CONNECTIONS' in cursorEnv(ws), false);
});
test('unknown connections are refused before anything is written', () => {
  seedConnections('alpha');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-unknown-'));
  assert.throws(
    () => applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: ['alpha', 'ghost'], forceReadOnly: false }),
    /Unknown connection "ghost"/
  );
  assert.equal(fs.existsSync(path.join(ws, '.cursor')), false);
});
test('names are accepted but always stored as de-duplicated ids', () => {
  const ids = seedConnections('alpha', 'beta');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-names-'));
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: ['ALPHA', ids.beta, 'alpha'], forceReadOnly: false });
  assert.equal(cursorEnv(ws).LAZY_SQL_ALLOWED_CONNECTIONS, `${ids.alpha},${ids.beta}`);
});
test('renaming a connection keeps its allow-list working', () => {
  const ids = seedConnections('alpha', 'beta');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-rename-'));
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: [ids.alpha], forceReadOnly: false });
  const config = loadConfig();
  config.connections.find((connection) => connection.id === ids.alpha).name = 'alpha-renamed';
  saveConfig(config);
  process.env.LAZY_SQL_ALLOWED_CONNECTIONS = cursorEnv(ws).LAZY_SQL_ALLOWED_CONNECTIONS;
  try {
    assert.deepEqual(listEnabledConnections().map((connection) => connection.name), ['alpha-renamed']);
  } finally {
    delete process.env.LAZY_SQL_ALLOWED_CONNECTIONS;
  }
});
test('scan resolves ids and older name entries and flags entries that match nothing', () => {
  const ids = seedConnections('alpha', 'beta');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-resolve-'));
  addWorkspace(ws);
  fs.mkdirSync(path.join(ws, '.cursor'));
  fs.writeFileSync(
    path.join(ws, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'lazy-sql': { command: 'node', args: [engineEntryPath()], env: { LAZY_SQL_ALLOWED_CONNECTIONS: `${ids.alpha},BETA,ghost` } } } })
  );
  const state = scanWorkspaces().workspaces.find((w) => path.resolve(w.path) === path.resolve(ws)).tools.cursor;
  assert.deepEqual(state.connections, [ids.alpha, ids.beta]);
  assert.deepEqual(state.unknownConnections, ['ghost']);
  removeWorkspace(ws);
});
test('turning a registration off still works when the saved selection is stale', () => {
  seedConnections('alpha');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-stale-'));
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: null, forceReadOnly: false });
  assert.doesNotThrow(() => applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: false, connections: [] }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8')).mcpServers['lazy-sql'], undefined);
});

console.log('unit: workspaces (config editing)');
test('comments, key order and indentation of an existing JSONC file survive (opencode)', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-jsonc-'));
  const file = path.join(ws, 'opencode.jsonc');
  const original = [
    '{',
    '    // keep me: my own comment',
    '    "theme": "dark",',
    '    /* block comment */',
    '    "mcp": {',
    '        "other": { "type": "local", "command": ["x"] },',
    '    },',
    '}',
    ''
  ].join('\n');
  fs.writeFileSync(file, original);
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'opencode', enabled: true, connections: null, forceReadOnly: false });

  const after = fs.readFileSync(file, 'utf8');
  for (const kept of ['// keep me: my own comment', '/* block comment */', '"theme": "dark",', '"other": { "type": "local", "command": ["x"] },']) {
    assert.ok(after.includes(kept), `lost: ${kept}`);
  }
  assert.ok(after.startsWith(original.split('"mcp"')[0]), 'text before the edited node is byte-identical');
  assert.ok(after.includes('\n        "lazy-sql": {'), 'new entry follows the file indentation (4 spaces)');
  assert.equal(parseJsonc(after).mcp['lazy-sql'].enabled, true);
  assert.ok(parseJsonc(after).mcp.other);

  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'opencode', enabled: false });
  const off = fs.readFileSync(file, 'utf8');
  assert.ok(off.includes('// keep me: my own comment'));
  assert.equal(parseJsonc(off).mcp['lazy-sql'].enabled, false);
});
test('line endings and a UTF-8 BOM are preserved', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-crlf-'));
  const file = path.join(ws, '.mcp.json');
  fs.writeFileSync(file, '﻿{\r\n  "mcpServers": {\r\n    "other": { "command": "x" }\r\n  }\r\n}\r\n');
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'claude', enabled: true, connections: null, forceReadOnly: false });
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith('﻿'));
  assert.equal(/(^|[^\r])\n/.test(after), false, 'no bare LF inside a CRLF file');
  assert.equal(parseJsonc(after).mcpServers.other.command, 'x');
  assert.equal(parseJsonc(after).mcpServers['lazy-sql'].command, 'node');
});
test('the first backup is the untouched original and later edits never overwrite it', () => {
  const ids = seedConnections('alpha');
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-backup-'));
  const file = path.join(ws, '.mcp.json');
  const original = '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n';
  fs.writeFileSync(file, original);
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'claude', enabled: true, connections: null, forceReadOnly: false });
  assert.equal(fs.readFileSync(`${file}.lazy-sql-backup`, 'utf8'), original);
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'claude', enabled: true, connections: [ids.alpha], forceReadOnly: true });
  applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'claude', enabled: false });
  assert.equal(fs.readFileSync(`${file}.lazy-sql-backup`, 'utf8'), original, 'the pristine backup survives every later edit');
});
test('re-applying the same registration changes nothing and says so', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-same-'));
  const args = { scopeType: 'workspace', scopePath: ws, tool: 'cursor', enabled: true, connections: null, forceReadOnly: false };
  assert.equal(applyTool(args).changed, true);
  const file = path.join(ws, '.cursor', 'mcp.json');
  const before = fs.readFileSync(file, 'utf8');
  const again = applyTool(args);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(`${file}.lazy-sql-backup`), false, 'a file LAZY SQL created itself needs no backup');
});
test('an empty config file is treated as an empty object and an unparsable one is left alone', () => {
  const ws = fs.mkdtempSync(path.join(tmpDir, 'ws-empty-file-'));
  fs.writeFileSync(path.join(ws, '.mcp.json'), '');
  const ok = applyTool({ scopeType: 'workspace', scopePath: ws, tool: 'claude', enabled: true, connections: null, forceReadOnly: false });
  assert.equal(ok.ok, true);
  assert.equal(parseJsonc(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).mcpServers['lazy-sql'].command, 'node');

  const broken = fs.mkdtempSync(path.join(tmpDir, 'ws-broken-file-'));
  fs.writeFileSync(path.join(broken, '.mcp.json'), '{ not json');
  const refused = applyTool({ scopeType: 'workspace', scopePath: broken, tool: 'claude', enabled: true, connections: null, forceReadOnly: false });
  assert.equal(refused.ok, false);
  assert.equal(fs.readFileSync(path.join(broken, '.mcp.json'), 'utf8'), '{ not json');
  assert.equal(fs.existsSync(path.join(broken, '.mcp.json.lazy-sql-backup')), false);
});

console.log('unit: jsonc-edit');
const ENTRY = { command: 'node', args: ['engine.js'], env: { A: '1' } };
test('setProperty builds the missing path inside an empty object', () => {
  const out = setProperty('{}\n', ['mcpServers', 'lazy-sql'], ENTRY);
  assert.deepEqual(parseJsonc(out), { mcpServers: { 'lazy-sql': ENTRY } });
  assert.ok(out.endsWith('}\n'), 'trailing newline kept');
  assert.ok(out.includes('\n  "mcpServers": {\n    "lazy-sql": {\n      "command": "node"'), 'pretty-printed with the default indent');
});
test('setProperty follows tab indentation', () => {
  const original = '{\n\t"mcpServers": {\n\t\t"other": { "command": "x" }\n\t}\n}\n';
  const out = setProperty(original, ['mcpServers', 'lazy-sql'], ENTRY);
  assert.ok(out.includes('\n\t\t"lazy-sql": {\n\t\t\t"command": "node"'));
  assert.ok(out.includes('"other": { "command": "x" },'), 'sibling untouched, comma added');
  assert.deepEqual(Object.keys(parseJsonc(out).mcpServers), ['other', 'lazy-sql']);
});
test('setProperty keeps a trailing comma and a comment after the last property', () => {
  const withComma = '{\n  "s": {\n    "a": 1, // note\n  },\n}\n';
  const out = setProperty(withComma, ['s', 'b'], 2);
  assert.ok(out.includes('"a": 1, // note'));
  assert.ok(/"b": 2,\n/.test(out), 'trailing-comma style is kept');
  assert.deepEqual(parseJsonc(out).s, { a: 1, b: 2 });

  const withoutComma = '{\n  "s": {\n    "a": 1 // note\n  }\n}\n';
  const out2 = setProperty(withoutComma, ['s', 'b'], 2);
  assert.deepEqual(parseJsonc(out2).s, { a: 1, b: 2 });
  assert.ok(out2.includes('// note'));
});
test('setProperty copes with single-line objects and replaces an existing value in place', () => {
  const oneLine = '{ "mcpServers": { "a": 1 } }\n';
  assert.deepEqual(parseJsonc(setProperty(oneLine, ['mcpServers', 'lazy-sql'], ENTRY)).mcpServers['lazy-sql'], ENTRY);

  const existing = '{\n  // head\n  "mcpServers": {\n    "lazy-sql": { "command": "old" },\n    "z": 1\n  }\n}\n';
  const out = setProperty(existing, ['mcpServers', 'lazy-sql'], ENTRY);
  assert.ok(out.startsWith('{\n  // head\n  "mcpServers": {\n    "lazy-sql": {\n      "command": "node"'));
  assert.ok(out.endsWith('    "z": 1\n  }\n}\n'), 'text after the replaced node is untouched');
  assert.deepEqual(parseJsonc(out).mcpServers.z, 1);
});
test('setProperty replaces a non-object parent and refuses a non-object root', () => {
  assert.deepEqual(parseJsonc(setProperty('{ "mcp": null }', ['mcp', 'lazy-sql'], 1)), { mcp: { 'lazy-sql': 1 } });
  assert.throws(() => setProperty('[1, 2]', ['a'], 1), /JSON object/);
});
test('removeProperty drops one property and leaves the rest of the text alone', () => {
  const original = '{\n  // keep\n  "s": {\n    "a": 1,\n    "gone": { "x": 1 },\n    "b": 2\n  }\n}\n';
  const out = removeProperty(original, ['s', 'gone']);
  assert.equal(out, '{\n  // keep\n  "s": {\n    "a": 1,\n    "b": 2\n  }\n}\n');
  assert.equal(removeProperty(original, ['s', 'missing']), original);
});

console.log('unit: transfer (json file)');
test('exported file is plain connections JSON that importConfig accepts back', () => {
  saveConfig({ connections: [] });
  upsertConnection({ name: 'roundtrip-db', engine: 'sqlite', file: 'rt.db' });
  const text = JSON.stringify(buildExport({ includePasswords: false }), null, 2);
  assert.equal('settings' in JSON.parse(text), false);

  saveConfig({ connections: [] });
  const summary = importConfig(JSON.parse(text), { mode: 'skip' });
  assert.equal(summary.imported, 1);
  assert.ok(loadConfig().connections.some((connection) => connection.name === 'roundtrip-db'));
});
test('importConfig ignores settings embedded by older exports', () => {
  saveConfig({ connections: [] });
  saveAppSettings({ maxRowsDefault: 200 });
  const summary = importConfig(
    {
      app: 'lazy-sql',
      connections: [{ name: 'legacy-db', engine: 'sqlite', file: 'l.db' }],
      settings: { maxRowsDefault: 77, vpnProfiles: [{ id: 'v1', name: 'Old', type: 'aws' }] }
    },
    { mode: 'skip' }
  );
  assert.equal(summary.imported, 1);
  assert.equal(getAppSettings().maxRowsDefault, 200);
  assert.equal('vpnProfiles' in getAppSettings(), false);
});

console.log('unit: openBrowser');
test('builds the right command per platform', () => {
  assert.deepEqual(buildOpenCommand('http://x', 'win32'), { command: 'cmd', args: ['/c', 'start', '', 'http://x'] });
  assert.deepEqual(buildOpenCommand('http://x', 'darwin'), { command: 'open', args: ['http://x'] });
  assert.deepEqual(buildOpenCommand('http://x', 'linux'), { command: 'xdg-open', args: ['http://x'] });
});

console.log(`unit: ${passed} checks passed`);

fs.rmSync(tmpDir, { recursive: true, force: true });
