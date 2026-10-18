import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logError } from './logger.js';

const HOME = os.homedir();
const MODERN_DATA_DIR = path.join(HOME, '.lazy-sql');
const LEGACY_DATA_DIR = path.join(HOME, '.sql-crew');

// Environment variables were renamed from SQL_CREW_* to LAZY_SQL_*; the old names still work so
// sessions started by tool configs written before the rename keep their scope.
export function readEnv(suffix) {
  const modern = process.env[`LAZY_SQL_${suffix}`];
  if (modern !== undefined) return modern;
  return process.env[`SQL_CREW_${suffix}`];
}

// One-time move of the data folder from the pre-rename ~/.sql-crew; if it cannot be moved or copied
// (locked files), the legacy folder is kept in use so no data is ever orphaned.
function resolveDataDir() {
  const fromEnv = readEnv('DATA_DIR');
  if (fromEnv) return path.resolve(fromEnv);
  if (fs.existsSync(MODERN_DATA_DIR) || !fs.existsSync(LEGACY_DATA_DIR)) return MODERN_DATA_DIR;
  try {
    fs.renameSync(LEGACY_DATA_DIR, MODERN_DATA_DIR);
    return MODERN_DATA_DIR;
  } catch {
    /* fall through to copying */
  }
  try {
    fs.cpSync(LEGACY_DATA_DIR, MODERN_DATA_DIR, { recursive: true });
    return MODERN_DATA_DIR;
  } catch (error) {
    logError(`Could not migrate ${LEGACY_DATA_DIR} to ${MODERN_DATA_DIR}; continuing with the legacy folder`, error);
    return LEGACY_DATA_DIR;
  }
}

export const DATA_DIR = resolveDataDir();

export const INSTANCES_DIR = path.join(DATA_DIR, 'instances');
export const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
export const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
export const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
export const EXEC_LOG_FILE = path.join(DATA_DIR, 'execution-log.jsonl');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function ensureInstancesDir() {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') logError(`Failed to read ${file}`, error);
    return null;
  }
}

export function atomicWrite(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  const options = mode ? { mode } : undefined;
  fs.writeFileSync(tmpFile, contents, options);
  fs.renameSync(tmpFile, file);
}

export function writeJsonFile(file, value, mode) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}
