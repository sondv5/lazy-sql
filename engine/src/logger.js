const PREFIX = '[lazy-sql]';

export function log(message) {
  process.stderr.write(`${PREFIX} ${message}\n`);
}

export function logError(message, error) {
  const detail = error?.stack || error?.message || String(error ?? '');
  process.stderr.write(`${PREFIX} ERROR ${message}${detail ? `: ${detail}` : ''}\n`);
}
