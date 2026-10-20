import { h, chip, copyText, svgIcon, toast, appendChildren } from './dom';
import type { ExecutionResult, ResultSet } from './engine';

export interface RenderResultOptions {
  maxHeight?: number;
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${filename}`, 'ok');
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resultSetToCsv(set: ResultSet): string {
  const lines = [set.columns.map(csvCell).join(',')];
  for (const row of set.rows ?? []) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

export function resultSetToJson(set: ResultSet): string {
  const rows = (set.rows ?? []).map((row) => Object.fromEntries(set.columns.map((column, index) => [column, row[index]])));
  return JSON.stringify(rows.length > 0 ? rows : set.rows ?? [], null, 2);
}

function cellNode(value: unknown): HTMLElement {
  const text = value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const cell = h('td', { title: text, text });
  if (value === null || value === undefined) cell.classList.add('cell-null');
  else if (typeof value === 'number' || typeof value === 'bigint') cell.classList.add('cell-number');
  else if (typeof value === 'boolean') cell.classList.add('cell-bool');
  return cell;
}

function renderSet(set: ResultSet, maxHeight: number): HTMLElement {
  const block = h('div', { class: 'result-set' });

  if (!set.columns || set.columns.length === 0) {
    block.append(h('div', { class: 'code-block', text: set.notice ?? `${set.command} — ${set.rowCount} affected` }));
    return block;
  }

  const head = h('div', { class: 'result-set-head' });
  appendChildren(head, [
    h('span', { class: 'result-set-command', text: set.command }),
    h('span', { class: 'muted', text: `${set.rowCount} row(s)${set.truncated ? ` · ${set.rowsOmitted ?? 0} omitted` : ''}` }),
    set.truncated ? chip('truncated', 'warn') : null,
    h('span', { class: 'grow' })
  ]);

  const copyBtn = h('button', { class: 'btn small', html: `${svgIcon('copy', 12)}<span>Copy</span>` });
  copyBtn.addEventListener('click', () => {
    const text = (set.rows ?? []).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell))).join('\t')).join('\n');
    copyText(`${set.columns.join('\t')}\n${text}`, 'Rows copied');
  });
  const csvBtn = h('button', { class: 'btn small', html: `${svgIcon('download', 12)}<span>CSV</span>` });
  csvBtn.addEventListener('click', () => downloadText(`lazy-sql-${timestamp()}.csv`, resultSetToCsv(set), 'text/csv;charset=utf-8'));
  const jsonBtn = h('button', { class: 'btn small', html: `${svgIcon('download', 12)}<span>JSON</span>` });
  jsonBtn.addEventListener('click', () => downloadText(`lazy-sql-${timestamp()}.json`, resultSetToJson(set), 'application/json'));
  head.append(copyBtn, csvBtn, jsonBtn);

  const table = h('table', { class: 'table' });
  const thead = h('thead');
  const headRow = h('tr');
  headRow.append(h('th', { class: 'row-index', text: '#' }));
  for (const column of set.columns) headRow.append(h('th', { text: column }));
  thead.append(headRow);
  const tbody = h('tbody');
  for (const [index, row] of (set.rows ?? []).entries()) {
    const tr = h('tr');
    tr.append(h('td', { class: 'row-index', text: String(index + 1) }));
    for (const cell of row) tr.append(cellNode(cell));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  block.append(head, h('div', { class: 'table-wrap', style: `max-height:${maxHeight}px` }, table));
  return block;
}

export function renderExecutionResult(container: HTMLElement, result: ExecutionResult, options: RenderResultOptions = {}): void {
  const summary = h('div', { class: 'result-summary' });
  appendChildren(summary, [
    chip('executed', 'ok'),
    h('span', { class: 'muted', text: `${result.durationMs ?? 0} ms · ${result.rowsReturned ?? 0} row(s) returned` }),
    result.truncated ? chip('truncated', 'warn') : null,
    h('span', { class: 'grow' })
  ]);

  const copyAll = h('button', { class: 'btn small', html: `${svgIcon('copy', 12)}<span>Copy JSON</span>` });
  copyAll.addEventListener('click', () => copyText(JSON.stringify(result, null, 2), 'Result JSON copied'));
  const exportAll = h('button', { class: 'btn small', html: `${svgIcon('download', 12)}<span>Export JSON</span>` });
  exportAll.addEventListener('click', () => downloadText(`lazy-sql-result-${timestamp()}.json`, JSON.stringify(result, null, 2), 'application/json'));
  summary.append(copyAll, exportAll);

  container.append(summary);

  for (const set of result.resultSets ?? []) {
    container.append(renderSet(set, options.maxHeight ?? 360));
  }
  if (result.hint) container.append(h('div', { class: 'muted', style: 'margin-top:8px' }, result.hint));
}
