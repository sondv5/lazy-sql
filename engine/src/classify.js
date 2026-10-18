const KEYWORD_TYPES = new Map(
  Object.entries({
    select: 'read',
    show: 'read',
    describe: 'read',
    desc: 'read',
    explain: 'read',
    pragma: 'read',
    values: 'read',
    table: 'read',
    insert: 'write',
    update: 'write',
    delete: 'write',
    merge: 'write',
    replace: 'write',
    upsert: 'write',
    copy: 'write',
    load: 'write',
    call: 'call',
    exec: 'call',
    execute: 'call',
    begin: 'transaction',
    start: 'transaction',
    commit: 'transaction',
    end: 'transaction',
    rollback: 'transaction',
    savepoint: 'transaction',
    release: 'transaction',
    set: 'session',
    use: 'session',
    lock: 'session',
    unlock: 'session',
    kill: 'session',
    create: 'ddl',
    alter: 'ddl',
    drop: 'ddl',
    truncate: 'ddl',
    rename: 'ddl',
    comment: 'ddl',
    grant: 'ddl',
    revoke: 'ddl',
    vacuum: 'maintenance',
    analyze: 'maintenance',
    reindex: 'maintenance',
    refresh: 'maintenance',
    flush: 'maintenance'
  })
);

const STRONGLY_DESTRUCTIVE = new Set(['drop', 'truncate']);
const DATA_MODIFYING = new Set(['insert', 'update', 'delete', 'merge', 'replace', 'upsert', 'copy', 'load']);

export function scanSegments(sql) {
  const text = typeof sql === 'string' ? sql : '';
  const segments = [];
  let code = '';
  let i = 0;
  const n = text.length;

  const flushCode = () => {
    if (code) segments.push({ type: 'code', text: code });
    code = '';
  };

  while (i < n) {
    const ch = text[i];

    if (ch === '-' && text[i + 1] === '-') {
      flushCode();
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? n : nl + 1;
      segments.push({ type: 'comment', text: text.slice(i, end) });
      i = end;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      flushCode();
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      segments.push({ type: 'comment', text: text.slice(i, end) });
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      flushCode();
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && ch === "'") {
          j += 2;
          continue;
        }
        if (text[j] === ch) {
          if (text[j + 1] === ch) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      segments.push({ type: 'quoted', text: text.slice(i, Math.min(j, n)) });
      i = Math.min(j, n);
      continue;
    }

    if (ch === '[') {
      flushCode();
      const close = text.indexOf(']', i + 1);
      const end = close === -1 ? n : close + 1;
      segments.push({ type: 'quoted', text: text.slice(i, end) });
      i = end;
      continue;
    }

    if (ch === '$') {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (match) {
        flushCode();
        const open = match[0];
        const close = text.indexOf(open, i + open.length);
        const end = close === -1 ? n : close + open.length;
        segments.push({ type: 'quoted', text: text.slice(i, end) });
        i = end;
        continue;
      }
    }

    code += ch;
    i += 1;
  }

  flushCode();
  return segments;
}

export function transformOutsideQuotes(sql, transform) {
  return scanSegments(sql)
    .map((segment) => (segment.type === 'code' ? transform(segment.text) : segment.text))
    .join('');
}

export function splitStatements(sql) {
  const statements = [];
  let current = '';
  for (const segment of scanSegments(sql)) {
    if (segment.type !== 'code') {
      current += segment.text;
      continue;
    }
    const parts = segment.text.split(';');
    for (let idx = 0; idx < parts.length - 1; idx += 1) {
      current += parts[idx];
      statements.push(current);
      current = '';
    }
    current += parts[parts.length - 1];
  }
  statements.push(current);
  return statements.map((s) => s.trim()).filter(Boolean);
}

export function stripLeadingComments(text) {
  let out = String(text ?? '').trimStart();
  for (;;) {
    if (out.startsWith('--')) {
      const nl = out.indexOf('\n');
      if (nl === -1) return '';
      out = out.slice(nl + 1).trimStart();
      continue;
    }
    if (out.startsWith('/*')) {
      const close = out.indexOf('*/');
      if (close === -1) return '';
      out = out.slice(close + 2).trimStart();
      continue;
    }
    break;
  }
  return out;
}

export function classifyStatement(statement) {
  const text = stripLeadingComments(statement);
  const match = /^\(?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  const keyword = match ? match[1].toLowerCase() : '';
  let type = KEYWORD_TYPES.get(keyword) ?? 'unknown';

  if (keyword === 'with') {
    const rest = text.slice(match[0].length);
    type = /\b(insert|update|delete|merge|replace|create|alter|drop|truncate)\b/i.test(rest) ? 'write' : 'read';
  }

  const stronglyDestructive = STRONGLY_DESTRUCTIVE.has(keyword);
  const modifiesData = DATA_MODIFYING.has(keyword);
  return {
    keyword,
    type,
    stronglyDestructive,
    modifiesData,
    text: String(statement).trim()
  };
}

export function analyzeSql(sql) {
  const statements = splitStatements(typeof sql === 'string' ? sql : '').map(classifyStatement);
  const types = [...new Set(statements.map((s) => s.type))];
  const isReadOnly = statements.length > 0 && statements.every((s) => s.type === 'read' || s.type === 'transaction');
  const hasModifications = statements.some((s) =>
    ['write', 'ddl', 'call', 'maintenance', 'unknown', 'session'].includes(s.type)
  );
  const dangerous = statements.some((s) => s.stronglyDestructive || s.modifiesData);
  const keywords = [...new Set(statements.map((s) => (s.keyword || 'unknown').toUpperCase()))];
  return {
    count: statements.length,
    statements,
    types,
    keywords,
    isReadOnly,
    hasModifications,
    dangerous,
    requiresConfirmation: hasModifications,
    summary: keywords.length ? keywords.join(', ') : 'EMPTY'
  };
}
