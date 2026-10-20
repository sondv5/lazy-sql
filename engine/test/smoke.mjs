import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-sql-smoke-'));
const dbFile = path.join(tmpDir, 'test.db');
const dataDir = path.join(tmpDir, 'data');
const wsDir = path.join(tmpDir, 'workspace');
const TOKEN = 'smoke-token';

fs.mkdirSync(wsDir, { recursive: true });

function seedDatabase() {
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO users (name, email) VALUES
      ('An', 'an@example.com'),
      ('Binh', 'binh@example.com'),
      ('Chi', 'chi@example.com');
    CREATE VIEW user_names AS SELECT id, name FROM users;
    CREATE INDEX idx_users_email ON users(email);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
  `);
  const insertNote = db.prepare('INSERT INTO notes (body) VALUES (?)');
  for (let index = 1; index <= 40; index += 1) {
    insertNote.run(`note-${index}: ${'lorem ipsum dolor sit amet '.repeat(12)}`);
  }
  db.close();
}

const stderrLines = [];
const stderrWaiters = [];
let stderrBuffer = '';

function feedStderr(chunk) {
  stderrBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stderrBuffer.indexOf('\n')) >= 0) {
    const line = stderrBuffer.slice(0, newlineIndex);
    stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
    stderrLines.push(line);
    for (const waiter of [...stderrWaiters]) waiter(line);
  }
}

function waitForLine(pattern, { from = 0, timeoutMs = 20000 } = {}) {
  const existing = stderrLines.slice(from).find((line) => pattern.test(line));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remove();
      reject(new Error(`Timed out waiting for stderr line matching ${pattern}`));
    }, timeoutMs);
    const waiter = (line) => {
      if (pattern.test(line)) {
        clearTimeout(timer);
        remove();
        resolve(line);
      }
    };
    const remove = () => {
      const index = stderrWaiters.indexOf(waiter);
      if (index >= 0) stderrWaiters.splice(index, 1);
    };
    stderrWaiters.push(waiter);
  });
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function extractReview(resultLine) {
  const url = resultLine.match(/http:\/\/127\.0\.0\.1:\d+\/review\/[0-9a-f-]+/)?.[0];
  assert.ok(url, `review url not found in: ${resultLine}`);
  return { url, id: url.split('/review/')[1] };
}

let passed = 0;
let client = null;

function step(name) {
  passed += 1;
  console.log(`  ok - ${name}`);
}

async function main() {
  seedDatabase();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pkgRoot, 'src', 'index.js')],
    env: {
      ...process.env,
      LAZY_SQL_NO_OPEN: '1',
      LAZY_SQL_TOKEN: TOKEN,
      LAZY_SQL_PORT: '4799',
      LAZY_SQL_REVIEW_TIMEOUT_MS: '60000',
      LAZY_SQL_MAX_RESPONSE_CHARS: '5000',
      LAZY_SQL_DATA_DIR: dataDir,
      LAZY_SQL_INSTANCE_LABEL: 'smoke'
    },
    stderr: 'pipe'
  });
  transport.stderr.on('data', (chunk) => feedStderr(chunk.toString()));

  client = new Client({ name: 'lazy-sql-smoke', version: '0.0.1' });
  await client.connect(transport);

  const listenLine = await waitForLine(/Local API listening on http:\/\/127\.0\.0\.1:(\d+)/);
  const port = Number(listenLine.match(/:(\d+)/)[1]);
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-lazy-sql-token': TOKEN,
        ...(options.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };

  const instanceFiles = fs.readdirSync(path.join(dataDir, 'instances'));
  assert.equal(instanceFiles.length, 1);
  const instanceRecord = JSON.parse(fs.readFileSync(path.join(dataDir, 'instances', instanceFiles[0]), 'utf8'));
  assert.equal(instanceRecord.mode, 'stdio');
  assert.equal(instanceRecord.label, 'smoke');
  assert.equal(instanceRecord.port, port);
  step('stdio instance registers itself with a heartbeat file');

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ['execute_sql', 'get_db_objects', 'open_db_config']);
  step('lists exactly 3 tools');

  const noConnection = parseToolResult(await client.callTool({ name: 'execute_sql', arguments: { sql: 'SELECT 1' } }));
  assert.equal(noConnection.status, 'no_connection');
  step('execute_sql asks to configure when no connection exists');

  const created = await api('/api/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'test-sqlite', engine: 'sqlite', file: dbFile })
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.connection.enabled, true);
  const connectionId = created.body.connection.id;
  step('creates a connection through the config API');

  const pgStored = await api('/api/connections', {
    method: 'POST',
    body: JSON.stringify({
      name: 'test-pg',
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'appdb',
      user: 'app',
      password: 'sup3r-secret'
    })
  });
  assert.equal(pgStored.status, 200);
  assert.equal(pgStored.body.connection.hasPassword, true);
  const pgId = pgStored.body.connection.id;
  const rawConfig = fs.readFileSync(path.join(dataDir, 'connections.json'), 'utf8');
  assert.ok(rawConfig.includes('sup3r-secret'), 'passwords are stored plaintext by design');
  const listedPg = (await api('/api/connections')).body.connections.find((c) => c.id === pgId);
  assert.ok(!('password' in listedPg), 'the API never returns passwords');
  step('credentials are stored plaintext locally, never exposed via the API');

  const deletedPg = await api(`/api/connections/${pgId}`, { method: 'DELETE' });
  assert.equal(deletedPg.status, 200);

  const draftTest = await api('/api/connections/test', {
    method: 'POST',
    body: JSON.stringify({ engine: 'sqlite', name: 'draft', file: dbFile })
  });
  assert.equal(draftTest.status, 200);
  assert.equal(draftTest.body.ok, true);
  assert.ok(String(draftTest.body.serverVersion).length > 0);
  step('tests a draft connection without saving');

  const tableList = parseToolResult(
    await client.callTool({ name: 'get_db_objects', arguments: { connection: 'test-sqlite', objectType: 'table' } })
  );
  assert.deepEqual(tableList.objects.map((object) => object.name), ['notes', 'users']);
  step('lists tables via get_db_objects');

  const tableDetail = parseToolResult(
    await client.callTool({ name: 'get_db_objects', arguments: { connection: 'test-sqlite', name: 'users' } })
  );
  assert.deepEqual(tableDetail.object.columns.map((column) => column.name), ['id', 'name', 'email']);
  assert.deepEqual(tableDetail.object.primaryKey, ['id']);
  step('describes a table with columns, PK and indexes');

  const schemaResponse = await api('/api/schema?connection=test-sqlite');
  assert.equal(schemaResponse.status, 200);
  assert.deepEqual(Object.keys(schemaResponse.body.schema).sort(), ['notes', 'user_names', 'users']);
  assert.ok(schemaResponse.body.schema.users.includes('email'));
  step('exposes a completion schema for the SQL editor');

  const objectsResponse = await api('/api/objects?connection=test-sqlite&limit=50');
  assert.equal(objectsResponse.status, 200);
  assert.equal(objectsResponse.body.mode, 'list');
  assert.ok(objectsResponse.body.objects.some((object) => object.kind === 'table' && object.name === 'users'));
  const objectDetailResponse = await api('/api/objects/detail?connection=test-sqlite&name=users&definition=1');
  assert.equal(objectDetailResponse.body.found, true);
  assert.deepEqual(objectDetailResponse.body.object.columns.map((column) => column.name), ['id', 'name', 'email']);
  assert.ok(objectDetailResponse.body.object.definition.includes('CREATE TABLE'));
  step('object browser endpoints list objects and return table details');

  const marker1 = stderrLines.length;
  const directRead = parseToolResult(
    await client.callTool(
      { name: 'execute_sql', arguments: { connection: 'test-sqlite', sql: 'SELECT name FROM users ORDER BY id' } },
      undefined,
      { timeout: 30000 }
    )
  );
  assert.equal(directRead.status, 'ok');
  assert.equal(directRead.reviewed, false);
  assert.deepEqual(directRead.resultSets[0].rows, [['An'], ['Binh'], ['Chi']]);
  assert.ok(!stderrLines.slice(marker1).some((line) => /surfaced via/.test(line)), 'reads must not open a review');
  step('read-only SQL runs directly without a review');

  const marker2 = stderrLines.length;
  const pendingApproval = client.callTool(
    {
      name: 'execute_sql',
      arguments: {
        connection: 'test-sqlite',
        sql: "UPDATE users SET email = 'an.old@example.com' WHERE name = 'An'",
        purpose: 'smoke test approve flow'
      }
    },
    undefined,
    { timeout: 120000 }
  );
  const reviewLine1 = await waitForLine(/surfaced via browser at .*\/review\//, { from: marker2 });
  const review1 = extractReview(reviewLine1);
  const pendingSession = await api(`/api/reviews/${review1.id}`);
  assert.equal(pendingSession.body.status, 'pending');
  assert.ok(pendingSession.body.sql.includes('UPDATE users'));
  assert.equal((await api('/api/reviews/active')).body.review?.id, review1.id);
  assert.equal((await api('/api/window/state')).body.review?.id, review1.id);

  const probed = await api('/api/instances?probe=1');
  const self = probed.body.instances.find((entry) => entry.port === port);
  assert.equal(self.state.review?.id, review1.id);
  step('app-side instance probe sees the pending review');

  const editedSql = "UPDATE users SET email = 'an.edited@example.com' WHERE name = 'An'";
  const approved = await api(`/api/reviews/${review1.id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ sql: editedSql })
  });
  assert.equal(approved.status, 200);
  const executed = parseToolResult(await pendingApproval);
  assert.equal(executed.status, 'ok');
  assert.equal(executed.reviewed, true);
  assert.equal(executed.sql, editedSql);
  const emailCheck = parseToolResult(
    await client.callTool(
      { name: 'execute_sql', arguments: { connection: 'test-sqlite', sql: "SELECT email FROM users WHERE name = 'An'" } },
      undefined,
      { timeout: 30000 }
    )
  );
  assert.deepEqual(emailCheck.resultSets[0].rows, [['an.edited@example.com']]);
  step('data-changing SQL opens a review and runs the user-edited statement');

  const marker3 = stderrLines.length;
  const pendingReject = client.callTool(
    { name: 'execute_sql', arguments: { connection: 'test-sqlite', sql: "DELETE FROM users WHERE name = 'An'" } },
    undefined,
    { timeout: 120000 }
  );
  const reviewLine2 = await waitForLine(/surfaced via browser at .*\/review\//, { from: marker3 });
  const review2 = extractReview(reviewLine2);
  await api(`/api/reviews/${review2.id}/reject`, { method: 'POST' });
  const rejectResult = parseToolResult(await pendingReject);
  assert.equal(rejectResult.status, 'rejected');
  step('execute_sql respects a user rejection');

  const marker4 = stderrLines.length;
  const firstCall = parseToolResult(
    await client.callTool(
      {
        name: 'execute_sql',
        arguments: {
          connection: 'test-sqlite',
          sql: "INSERT INTO users (name, email) VALUES ('TwoPhase', 'tp@example.com')",
          waitMs: 1000
        }
      },
      undefined,
      { timeout: 30000 }
    )
  );
  assert.equal(firstCall.status, 'pending_review');
  const slowLine = await waitForLine(/surfaced via browser at .*\/review\//, { from: marker4 });
  assert.equal(extractReview(slowLine).id, firstCall.reviewId);
  await api(`/api/reviews/${firstCall.reviewId}/approve`, { method: 'POST' });
  const resumed = parseToolResult(
    await client.callTool({ name: 'execute_sql', arguments: { reviewId: firstCall.reviewId, waitMs: 20000 } }, undefined, {
      timeout: 60000
    })
  );
  assert.equal(resumed.status, 'ok');
  assert.equal(resumed.resultSets[0].rowCount, 1);
  const missingReview = parseToolResult(
    await client.callTool({ name: 'execute_sql', arguments: { reviewId: 'deadbeef-0000-0000-0000-0000000000' } })
  );
  assert.equal(missingReview.status, 'error');
  step('two-phase flow: pending_review then resume returns the executed result');

  const budgetRead = parseToolResult(
    await client.callTool({ name: 'execute_sql', arguments: { connection: 'test-sqlite', sql: 'SELECT * FROM notes ORDER BY id' } }, undefined, {
      timeout: 30000
    })
  );
  assert.equal(budgetRead.responseTrimmed, true);
  assert.ok(JSON.stringify(budgetRead).length < 6000);
  step('oversized responses are trimmed to the context budget');

  const readOnlyConnection = await api('/api/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'test-readonly', engine: 'sqlite', file: dbFile, readOnly: true })
  });
  const blocked = parseToolResult(
    await client.callTool({ name: 'execute_sql', arguments: { connection: 'test-readonly', sql: 'UPDATE users SET name = name' } })
  );
  assert.equal(blocked.status, 'blocked');
  step('write statements are blocked on read-only connections');

  const manualRead = await api('/api/execute', {
    method: 'POST',
    body: JSON.stringify({ connection: 'test-sqlite', sql: 'SELECT COUNT(*) AS n FROM users' })
  });
  assert.equal(manualRead.status, 200);
  assert.equal(manualRead.body.status, 'ok');
  assert.equal(manualRead.body.origin, 'manual');
  assert.deepEqual(manualRead.body.resultSets[0].rows, [[4]]);

  const manualWrite = await api('/api/execute', {
    method: 'POST',
    body: JSON.stringify({ connection: 'test-sqlite', sql: "UPDATE users SET email = lower(email) WHERE name = 'Binh'" })
  });
  assert.equal(manualWrite.status, 200);
  assert.equal(manualWrite.body.status, 'ok');
  assert.equal(manualWrite.body.reviewed, false);

  const manualBlocked = await api('/api/execute', {
    method: 'POST',
    body: JSON.stringify({ connection: 'test-readonly', sql: 'UPDATE users SET name = name' })
  });
  assert.equal(manualBlocked.status, 200);
  assert.equal(manualBlocked.body.status, 'blocked');
  assert.ok(manualBlocked.body.analysis);

  const manualError = await api('/api/execute', {
    method: 'POST',
    body: JSON.stringify({ connection: 'test-sqlite', sql: 'SELECT * FROM does_not_exist' })
  });
  assert.equal(manualError.status, 400);
  assert.equal(manualError.body.status, 'error');
  assert.ok(String(manualError.body.error).length > 0);
  step('manual SQL runner: executes reads+writes, blocks read-only, reports errors');

  const disabledConnection = await api('/api/connections', {
    method: 'POST',
    body: JSON.stringify({ name: 'test-disabled', engine: 'sqlite', file: dbFile, enabled: false })
  });
  const disabledResult = parseToolResult(
    await client.callTool({ name: 'execute_sql', arguments: { connection: 'test-disabled', sql: 'SELECT 1' } })
  );
  assert.equal(disabledResult.status, 'disabled_connection');
  step('disabled connections are blocked for the MCP session');

  const unknown = parseToolResult(await client.callTool({ name: 'execute_sql', arguments: { connection: 'ghost', sql: 'SELECT 1' } }));
  assert.equal(unknown.status, 'unknown_connection');
  assert.deepEqual(unknown.availableConnections.sort(), ['test-readonly', 'test-sqlite']);
  step('unknown connection name lists only enabled connections');

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dates = await api('/api/logs/dates');
  assert.ok(dates.body.dates.some((entry) => entry.date === today && entry.count >= 6));
  const logs = await api(`/api/logs?date=${today}`);
  const statuses = new Set(logs.body.entries.map((entry) => entry.status));
  assert.ok(statuses.has('ok'));
  assert.ok(statuses.has('rejected'));
  assert.ok(statuses.has('blocked'));
  const logRaw = fs.readFileSync(path.join(dataDir, 'execution-log.jsonl'), 'utf8');
  assert.ok(!logRaw.includes('sup3r-secret'), 'execution log must not contain credentials');
  const manualEntries = logs.body.entries.filter((entry) => entry.origin === 'manual');
  assert.ok(manualEntries.length >= 3, 'manual runs must be logged with origin=manual');
  assert.ok(manualEntries.some((entry) => entry.status === 'blocked'));
  assert.ok(manualEntries.some((entry) => entry.status === 'ok'));
  assert.equal((await api('/api/logs?date=not-a-date')).status, 400);
  const recentHistory = await api('/api/history?limit=10&connection=test-sqlite');
  assert.equal(recentHistory.status, 200);
  assert.ok(recentHistory.body.entries.length > 0);
  assert.ok(recentHistory.body.entries.every((entry) => entry.connection?.name === 'test-sqlite'));
  assert.equal('responsePreview' in recentHistory.body.entries[0], false, 'history omits response previews');
  step('execution history is logged locally and queryable by date and by recent history');

  const exported = await api('/api/transfer/export?passwords=0');
  assert.equal(exported.body.payload.kind, 'config-export');
  assert.ok(!exported.body.payload.connections.some((connection) => connection.password));
  assert.equal(exported.body.payload.settings, undefined, 'exports carry connections only');
  const importSkip = await api('/api/transfer/import', {
    method: 'POST',
    body: JSON.stringify({ payload: exported.body.payload, mode: 'skip', includePasswords: false })
  });
  assert.ok(importSkip.body.summary.skipped >= 3);
  const importRename = await api('/api/transfer/import', {
    method: 'POST',
    body: JSON.stringify({ payload: exported.body.payload, mode: 'rename', includePasswords: false })
  });
  assert.equal(importRename.body.summary.renamed, 3);
  const connectionCount = (await api('/api/connections')).body.connections.length;
  assert.equal(connectionCount, 6);
  step('import/export config round-trips through the API (skip & rename modes)');

  const exportPath = path.join(tmpDir, 'connections-export.json');
  const fileExport = await api('/api/transfer/export-file', {
    method: 'POST',
    body: JSON.stringify({ path: exportPath, includePasswords: true })
  });
  assert.equal(fileExport.status, 200);
  assert.equal(fileExport.body.ok, true);
  assert.ok(fileExport.body.connections >= 3);
  const exportedFile = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(exportedFile.kind, 'config-export');
  assert.equal(exportedFile.includesPasswords, true);
  assert.equal(exportedFile.settings, undefined);
  const fileImport = await api('/api/transfer/import', {
    method: 'POST',
    body: JSON.stringify({ path: exportPath, mode: 'rename', includePasswords: true })
  });
  assert.equal(fileImport.status, 200);
  assert.equal(fileImport.body.summary.renamed >= 3, true);
  const notJsonPath = path.join(tmpDir, 'not-json.json');
  fs.writeFileSync(notJsonPath, 'definitely { not json');
  const notJson = await api('/api/transfer/import', { method: 'POST', body: JSON.stringify({ path: notJsonPath, mode: 'skip' }) });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /not valid JSON/);
  const missingFile = await api('/api/transfer/import', {
    method: 'POST',
    body: JSON.stringify({ path: path.join(tmpDir, 'nope.json'), mode: 'skip' })
  });
  assert.equal(missingFile.status, 400);
  assert.equal((await api('/api/transfer/export-zip', { method: 'POST', body: JSON.stringify({ path: exportPath }) })).status, 404);
  step('json file export/import round-trips (connections only)');

  const added = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ action: 'add', path: wsDir }) });
  assert.equal(added.body.scan.workspaces.some((workspace) => path.resolve(workspace.path) === path.resolve(wsDir)), true);
  const sqliteId = (await api('/api/connections')).body.connections.find((connection) => connection.name === 'test-sqlite').id;
  const applyBody = (extra) =>
    JSON.stringify({ action: 'apply', scopeType: 'workspace', scopePath: wsDir, tool: 'cursor', enabled: true, forceReadOnly: false, ...extra });
  const emptyScope = await api('/api/workspaces', { method: 'POST', body: applyBody({ connections: [] }) });
  assert.equal(emptyScope.status, 400);
  assert.match(emptyScope.body.error, /at least one connection/);
  const ghostScope = await api('/api/workspaces', { method: 'POST', body: applyBody({ connections: ['ghost'] }) });
  assert.equal(ghostScope.status, 400);
  assert.match(ghostScope.body.error, /Unknown connection/);
  assert.equal(fs.existsSync(path.join(wsDir, '.cursor', 'mcp.json')), false, 'refused requests must not write the tool config');
  const applied = await api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      action: 'apply',
      scopeType: 'workspace',
      scopePath: wsDir,
      tool: 'cursor',
      enabled: true,
      connections: [sqliteId],
      forceReadOnly: true
    })
  });
  assert.equal(applied.body.result.ok, true);
  const cursorConfig = JSON.parse(fs.readFileSync(path.join(wsDir, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursorConfig.mcpServers['lazy-sql'].env.LAZY_SQL_ALLOWED_CONNECTIONS, sqliteId, 'the allow-list is stored as the connection id');
  assert.equal(cursorConfig.mcpServers['lazy-sql'].env.LAZY_SQL_FORCE_READ_ONLY, '1');
  const workspace = applied.body.scan.workspaces.find((entry) => path.resolve(entry.path) === path.resolve(wsDir));
  assert.equal(workspace.tools.cursor.registered, true);
  assert.deepEqual(workspace.tools.cursor.connections, [sqliteId]);
  assert.deepEqual(workspace.tools.cursor.unknownConnections, []);
  const disabled = await api('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ action: 'apply', scopeType: 'workspace', scopePath: wsDir, tool: 'cursor', enabled: false })
  });
  assert.equal(disabled.body.result.ok, true);
  const afterOff = JSON.parse(fs.readFileSync(path.join(wsDir, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(afterOff.mcpServers['lazy-sql'], undefined);
  await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ action: 'remove', path: wsDir }) });
  step('workspace MCP toggles write/remove tool config entries with connection filters');

  const configPage = parseToolResult(await client.callTool({ name: 'open_db_config', arguments: {} }));
  assert.equal(configPage.status, 'opened');
  assert.equal(configPage.target, 'browser');
  assert.ok(configPage.url.includes('/config?t='));
  step('open_db_config falls back to the browser when no app daemon is running');

  const historyPage = await fetch(`${baseUrl}/history?t=${TOKEN}`);
  assert.equal(historyPage.status, 200);
  assert.equal((await fetch(`${baseUrl}/history`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/connections`)).status, 401);
  step('pages and API are token-guarded');

  const settingsPatch = await api('/api/settings', { method: 'POST', body: JSON.stringify({ reviewTimeoutMs: 123456 }) });
  assert.equal(settingsPatch.body.settings.reviewTimeoutMs, 123456);
  step('app settings are persisted through the API');

  const clearedLogs = await api('/api/logs', { method: 'DELETE' });
  assert.equal(clearedLogs.body.ok, true);
  assert.equal((await api('/api/logs/dates')).body.dates.length, 0);
  step('execution history can be cleared');

  await api(`/api/connections/${connectionId}`, { method: 'DELETE' });

  await client.close();
  console.log(`smoke: ${passed} checks passed`);
}

main()
  .catch((error) => {
    console.error('smoke: FAILED');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await client?.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    process.exit(process.exitCode ?? 0);
  });
