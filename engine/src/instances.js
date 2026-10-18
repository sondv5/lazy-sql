import fs from 'node:fs';
import path from 'node:path';
import { INSTANCES_DIR, ensureInstancesDir } from './paths.js';
import { log, logError } from './logger.js';

const HEARTBEAT_MS = 2000;
const STALE_MS = 8000;

let current = null;

function instanceFile(id) {
  return path.join(INSTANCES_DIR, `${id}.json`);
}

function writeRecord(record) {
  try {
    ensureInstancesDir();
    const file = instanceFile(record.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (error) {
    logError('Failed to write the instance heartbeat file', error);
  }
}

export function registerInstance({ mode, port, token, label, entry, version }) {
  if (current) return current;
  const id = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const record = {
    id,
    app: 'lazy-sql',
    version: version ?? null,
    mode,
    pid: process.pid,
    ppid: process.ppid,
    port,
    token,
    label: label ?? null,
    entry: entry ?? null,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    heartbeatAt: Date.now()
  };
  writeRecord(record);
  const timer = setInterval(() => {
    record.heartbeatAt = Date.now();
    writeRecord(record);
    cleanupStale(record.id);
  }, HEARTBEAT_MS);
  timer.unref?.();
  current = { id, record, timer, update: (patch) => {
    Object.assign(record, patch ?? {});
    record.heartbeatAt = Date.now();
    writeRecord(record);
  } };
  process.once('exit', () => unregisterInstance());
  return current;
}

export function unregisterInstance() {
  if (!current) return;
  clearInterval(current.timer);
  try {
    fs.rmSync(instanceFile(current.id), { force: true });
  } catch {
    /* ignore */
  }
  current = null;
}

export function currentRecord() {
  return current?.record ?? null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupStale(keepId) {
  let files = [];
  try {
    files = fs.readdirSync(INSTANCES_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of files) {
    const file = path.join(INSTANCES_DIR, name);
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const fresh = record && now - Number(record.heartbeatAt ?? 0) < STALE_MS && pidAlive(Number(record.pid));
      if (!fresh && record?.id !== keepId) fs.rmSync(file, { force: true });
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export function listInstances() {
  cleanupStale(current?.id);
  let files = [];
  try {
    files = fs.readdirSync(INSTANCES_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const now = Date.now();
  const instances = [];
  for (const name of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, name), 'utf8'));
      if (!record || !['lazy-sql', 'linkit-sql', 'sql-crew'].includes(record.app)) continue;
      const fresh = now - Number(record.heartbeatAt ?? 0) < STALE_MS && pidAlive(Number(record.pid));
      if (!fresh) continue;
      instances.push({ ...record, isSelf: current ? record.id === current.id : false });
    } catch {
      /* ignore corrupt record */
    }
  }
  instances.sort((a, b) => String(a.mode).localeCompare(String(b.mode)) || (a.startedAt > b.startedAt ? 1 : -1));
  return instances;
}

export function findAppDaemon() {
  return listInstances().find((record) => record.mode === 'serve') ?? null;
}

export function logInstances(instances) {
  for (const record of instances) {
    log(`instance ${record.mode} pid=${record.pid} port=${record.port}${record.label ? ` label=${record.label}` : ''}`);
  }
}
