import { h, chip } from './dom';
import type { ExecutionResult } from './engine';

export function renderExecutionResult(container: HTMLElement, result: ExecutionResult): void {
  const summary = h('div', { class: 'result-summary' });
  summary.append(
    chip('executed', 'ok'),
    h('span', { class: 'muted', text: `${result.durationMs ?? 0} ms · ${result.rowsReturned ?? 0} row(s) returned` })
  );
  if (result.truncated) summary.append(chip('truncated', 'warn'));
  container.append(summary);

  for (const set of result.resultSets ?? []) {
    const block = h('div', { class: 'result-set' });
    if (set.columns && set.columns.length > 0) {
      const table = h('table', { class: 'table' });
      const thead = h('thead');
      const headRow = h('tr');
      for (const column of set.columns) headRow.append(h('th', { text: column }));
      thead.append(headRow);
      const tbody = h('tbody');
      for (const row of set.rows ?? []) {
        const tr = h('tr');
        for (const cell of row) {
          const value = cell === null || cell === undefined ? '' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
          tr.append(h('td', { title: value, text: value }));
        }
        tbody.append(tr);
      }
      table.append(thead, tbody);
      block.append(h('div', { class: 'table-wrap', style: 'max-height:360px' }, table));
      const meta = `${set.rowCount} row(s)${set.truncated ? ` (${set.rowsOmitted ?? 0} omitted)` : ''} — ${set.command}`;
      block.append(h('div', { class: 'muted', style: 'margin-top:6px' }, meta));
    } else {
      block.append(h('div', { class: 'code-block', text: set.notice ?? `${set.command} — ${set.rowCount} affected` }));
    }
    container.append(block);
  }
  if (result.hint) container.append(h('div', { class: 'muted', style: 'margin-top:8px' }, result.hint));
}
