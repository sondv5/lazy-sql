import { buildConnectionRecord, loadConfig, saveConfig } from './config.js';

export const EXPORT_VERSION = 1;

export function buildExport({ includePasswords = false } = {}) {
  const { connections } = loadConfig();
  return {
    app: 'lazy-sql',
    kind: 'config-export',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    includesPasswords: Boolean(includePasswords),
    connections: connections.map((record) => {
      const copy = { ...record };
      if (!includePasswords) copy.password = null;
      return copy;
    })
  };
}

export function parseImportPayload(payload) {
  if (Array.isArray(payload)) return { connections: payload };
  if (payload && typeof payload === 'object' && Array.isArray(payload.connections)) {
    return { connections: payload.connections };
  }
  throw new Error('Unrecognized config file: expected a LAZY SQL export or a { "connections": [...] } payload.');
}

export function importConfig(payload, { mode = 'skip', includePasswords = true } = {}) {
  const { connections: incoming } = parseImportPayload(payload);
  if (!['skip', 'overwrite', 'rename'].includes(mode)) {
    throw new Error('mode must be one of: skip, overwrite, rename');
  }

  const current = loadConfig();
  const byName = new Map(current.connections.map((c) => [String(c.name).toLowerCase(), c]));
  const summary = { imported: 0, overwritten: 0, skipped: 0, renamed: 0, errors: [] };

  for (const item of incoming) {
    try {
      if (!item || typeof item !== 'object') throw new Error('not an object');
      if (!item.name || !item.engine) throw new Error('missing name/engine');

      const originalName = String(item.name).trim();
      const existing = byName.get(originalName.toLowerCase());
      let name = originalName;
      let target = null;

      if (existing) {
        if (mode === 'skip') {
          summary.skipped += 1;
          continue;
        }
        if (mode === 'overwrite') {
          target = existing;
        } else {
          let candidate = `${originalName} (imported)`;
          let n = 2;
          while (byName.has(candidate.toLowerCase())) candidate = `${originalName} (imported ${n++})`;
          name = candidate;
        }
      }

      const input = { ...item, name };
      if (!includePasswords) {
        input.password = target ? undefined : null;
      }

      const record = buildConnectionRecord(input, target);
      if (target) {
        current.connections[current.connections.indexOf(target)] = record;
        byName.set(record.name.toLowerCase(), record);
        summary.overwritten += 1;
      } else {
        current.connections.push(record);
        byName.set(record.name.toLowerCase(), record);
        if (existing) summary.renamed += 1;
        else summary.imported += 1;
      }
    } catch (error) {
      summary.errors.push(`${item?.name ?? 'unknown connection'}: ${error.message}`);
    }
  }

  saveConfig({ connections: current.connections });
  return summary;
}
