import fs from 'node:fs';
import { EXEC_LOG_FILE, ensureDataDir, atomicWrite } from './paths.js';
import { logError } from './logger.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_KEEP_LINES = 5000;
const MAX_ENTRIES_PER_DAY = 500;
const RESPONSE_PREVIEW_MAX = 20000;

export function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readLines() {
  try {
    return fs.readFileSync(EXEC_LOG_FILE, 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') logError('Failed to read the execution log', error);
    return [];
  }
}

function trimIfNeeded() {
  try {
    const stat = fs.statSync(EXEC_LOG_FILE);
    if (stat.size <= MAX_FILE_BYTES) return;
    const kept = readLines().slice(-MAX_KEEP_LINES);
    atomicWrite(EXEC_LOG_FILE, `${kept.join('\n')}\n`);
  } catch {
    logError('Failed to trim the execution log');
  }
}

export function appendExecutionLog(entry) {
  const record = {
    ts: new Date().toISOString(),
    date: localDateKey(),
    ...entry
  };
  if (typeof record.responsePreview === 'string' && record.responsePreview.length > RESPONSE_PREVIEW_MAX) {
    record.responsePreview = `${record.responsePreview.slice(0, RESPONSE_PREVIEW_MAX)}…[truncated]`;
  }
  ensureDataDir();
  fs.appendFileSync(EXEC_LOG_FILE, `${JSON.stringify(record)}\n`);
  trimIfNeeded();
  return record;
}

function parseEntries() {
  const entries = [];
  for (const line of readLines()) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      logError('Skipped a corrupt execution log line');
    }
  }
  return entries;
}

export function listLogDates() {
  const counts = new Map();
  for (const entry of parseEntries()) {
    const date = entry.date ?? localDateKey(entry.ts);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function listLogsByDate(date) {
  return parseEntries()
    .filter((entry) => (entry.date ?? localDateKey(entry.ts)) === date)
    .slice(-MAX_ENTRIES_PER_DAY)
    .reverse();
}

// Recent entries across days for the SQL workspace history panel. Response previews are dropped —
// the UI only needs the statement, its status and target.
export function listRecentLogs({ limit = 200, connection = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const needle = connection ? String(connection).toLowerCase() : null;
  return parseEntries()
    .reverse()
    .filter((entry) => {
      if (!needle) return true;
      return (
        String(entry.connection?.id ?? '').toLowerCase() === needle ||
        String(entry.connection?.name ?? '').toLowerCase() === needle
      );
    })
    .slice(0, capped)
    .map(({ responsePreview, ...entry }) => entry);
}

export function clearExecutionLogs() {
  try {
    fs.rmSync(EXEC_LOG_FILE, { force: true });
    return true;
  } catch (error) {
    logError('Failed to clear the execution log', error);
    return false;
  }
}

export function executionLogStats() {
  try {
    const stat = fs.statSync(EXEC_LOG_FILE);
    return { bytes: stat.size, file: EXEC_LOG_FILE };
  } catch {
    return { bytes: 0, file: EXEC_LOG_FILE };
  }
}
