import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const mode = process.argv[2] ?? 'update';
const sql =
  mode === 'delete'
    ? "DELETE FROM orders WHERE status = 'cancelled'"
    : "UPDATE users SET email = 'an.updated@example.com' WHERE name = 'An'";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(pkgRoot, 'src', 'index.js')],
  env: {
    ...process.env,
    LAZY_SQL_PORT: '4791',
    LAZY_SQL_INSTANCE_LABEL: 'opencode (demo)'
  },
  stderr: 'pipe'
});

const client = new Client({ name: 'lazy-sql-demo', version: '0.0.1' });
await client.connect(transport);

const result = await client.callTool(
  {
    name: 'execute_sql',
    arguments: {
      connection: 'demo-sqlite',
      sql,
      purpose: 'Demo review for UI verification',
      waitMs: 1000
    }
  },
  undefined,
  { timeout: 30000 }
);

const payload = JSON.parse(result.content[0].text);
console.log(JSON.stringify(payload, null, 2));

// keep the stdio session (and its review) alive so the desktop UI can pick it up
setTimeout(() => {
  void client.close().finally(() => process.exit(0));
}, 900000);
