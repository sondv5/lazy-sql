import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

// `shell` is only needed for npm (npm.cmd on Windows); node.exe lives under "Program Files" and breaks when shell-joined.
function run(name, command, args, cwd, extraEnv = {}, shell = false) {
  const child = spawn(command, args, {
    cwd,
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv }
  });
  const tag = `[${name}]`;
  child.stdout.on('data', (chunk) => process.stdout.write(`${tag} ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`${tag} ${chunk}`));
  child.on('exit', (code) => {
    console.log(`${tag} exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
}

const children = [];
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const token = process.env.LAZY_SQL_TOKEN || randomBytes(16).toString('hex');
const engine = run('engine', process.execPath, ['src/index.js', '--serve'], path.join(root, 'engine'), {
  LAZY_SQL_PORT: '4788',
  LAZY_SQL_TOKEN: token
});
children.push(engine);

const web = run('web', 'npm', ['run', 'dev', '--workspace', 'apps/desktop'], root, {}, isWin);
children.push(web);

console.log('LAZY SQL dev: engine daemon (http://127.0.0.1:4788) + web UI (http://localhost:1420)');
console.log(`Web dev mode: open http://127.0.0.1:1420/?engine=4788&token=${token}`);
console.log('Or run `npm run dev:app` for the Tauri shell.');
