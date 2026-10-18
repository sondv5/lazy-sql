import { h, svgIcon, chip, engineDot, toast, confirmDialog, copyText, statusBadge, formatTime, appendChildren } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { LogEntry } from '../lib/engine';
import { mountSqlEditor } from '../lib/cm';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'ok', label: 'Executed' },
  { id: 'error', label: 'Errors' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'review_timeout', label: 'Timed out' },
  { id: 'blocked', label: 'Blocked' }
];

export function createLogsView(ctx: AppContext): View {
  let dates: Array<{ date: string; count: number }> = [];
  let selectedDate = '';
  let entries: LogEntry[] = [];
  let statusFilter = 'all';
  const expanded = new Set<string>();

  const datesHost = h('div', { class: 'logs-dates' });
  const entriesHost = h('div', { class: 'log-entries' });
  const filterHost = h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;margin-bottom:14px' });

  function entryKey(entry: LogEntry, index: number): string {
    return `${entry.ts}-${index}`;
  }

  async function loadDates(): Promise<void> {
    try {
      const payload = await ctx.engine.logDates();
      dates = payload.dates;
    } catch (error) {
      toast((error as Error).message, 'error');
      dates = [];
    }
    if (!selectedDate || !dates.some((date) => date.date === selectedDate)) {
      selectedDate = dates[0]?.date ?? new Date().toISOString().slice(0, 10);
    }
    renderDates();
  }

  async function loadEntries(): Promise<void> {
    try {
      const payload = await ctx.engine.logs(selectedDate);
      entries = payload.entries;
    } catch (error) {
      toast((error as Error).message, 'error');
      entries = [];
    }
    renderEntries();
  }

  function renderDates(): void {
    datesHost.replaceChildren();
    if (dates.length === 0) {
      datesHost.append(h('div', { class: 'muted', style: 'padding:8px 10px' }, 'No history yet.'));
      return;
    }
    for (const date of dates) {
      const item = h('button', { class: `date-item${date.date === selectedDate ? ' active' : ''}`, type: 'button' });
      item.append(h('span', { text: date.date }), chip(String(date.count), date.date === selectedDate ? 'neutral' : 'ghost'));
      item.addEventListener('click', () => {
        selectedDate = date.date;
        expanded.clear();
        renderDates();
        void loadEntries();
      });
      datesHost.append(item);
    }
  }

  function renderFilters(): void {
    filterHost.replaceChildren();
    for (const filter of STATUS_FILTERS) {
      const button = h('button', { class: `btn small${statusFilter === filter.id ? ' primary' : ''}`, text: filter.label, type: 'button' });
      button.addEventListener('click', () => {
        statusFilter = filter.id;
        renderFilters();
        renderEntries();
      });
      filterHost.append(button);
    }
    const count = entries.filter((entry) => statusFilter === 'all' || entry.status === statusFilter).length;
    filterHost.append(h('span', { class: 'grow' }), h('span', { class: 'results-count', text: `${count} entr${count === 1 ? 'y' : 'ies'}` }));
  }

  function renderEntries(): void {
    renderFilters();
    entriesHost.replaceChildren();
    const filtered = entries.filter((entry) => statusFilter === 'all' || entry.status === statusFilter);
    if (filtered.length === 0) {
      entriesHost.append(h('div', { class: 'empty' }, entries.length === 0 ? `No executions on ${selectedDate}.` : 'No entries match this filter.'));
      return;
    }
    filtered.forEach((entry, index) => {
      const key = entryKey(entry, index);
      const isOpen = expanded.has(key);
      const card = h('div', { class: 'log-card' });

      const head = h('div', { class: 'log-head' });
      appendChildren(head, [
        h('span', { class: 'mono muted', text: formatTime(entry.ts), style: 'flex:none' }),
        engineDot(entry.connection?.engine ?? ''),
        h('b', { text: entry.connection?.name ?? '—' }),
        statusBadge(entry.status),
        entry.statementTypes ? chip(entry.statementTypes, 'neutral') : null,
        entry.reviewed ? chip('reviewed', 'violet') : null,
        entry.origin === 'manual' ? chip('manual', 'violet') : null,
        h('span', { class: 'grow' }),
        entry.durationMs !== undefined ? h('span', { class: 'muted', text: `${entry.durationMs} ms` }) : null,
        entry.rowsReturned !== undefined ? h('span', { class: 'muted', text: `${entry.rowsReturned} rows` }) : null,
        h('span', { class: 'icon-wrap muted', html: svgIcon(isOpen ? 'chevronDown' : 'chevronRight', 15) })
      ]);
      head.addEventListener('click', () => {
        if (isOpen) expanded.delete(key);
        else expanded.add(key);
        renderEntries();
      });
      card.append(head);

      if (isOpen) {
        card.append(renderBody(entry));
      }
      entriesHost.append(card);
    });
  }

  function renderBody(entry: LogEntry): HTMLElement {
    const body = h('div', { class: 'log-body' });

    if (entry.connection?.target) {
      body.append(h('div', { class: 'muted mono', style: 'margin-bottom:10px;word-break:break-all' }, `target: ${entry.connection.target}`));
    }
    if (entry.purpose) {
      body.append(h('div', { class: 'muted', style: 'margin-bottom:10px' }, `purpose: ${entry.purpose}`));
    }

    const sqlLabel = h('div', { class: 'row', style: 'margin-bottom:6px' }, h('span', { class: 'muted', text: 'Final SQL (as executed)' }), h('span', { class: 'grow' }));
    const copyBtn = h('button', { class: 'btn small', html: `${svgIcon('copy', 12)}<span>Copy</span>` });
    copyBtn.addEventListener('click', () => copyText(entry.sql, 'SQL copied'));
    sqlLabel.append(copyBtn);
    body.append(sqlLabel);

    const editorHost = h('div', { class: 'editor-host', style: 'border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff' });
    body.append(editorHost);
    queueMicrotask(() => {
      mountSqlEditor(editorHost, {
        value: entry.sql ?? '',
        engine: entry.connection?.engine ?? 'postgres',
        readOnly: true,
        minHeight: '60px',
        maxHeight: '260px'
      });
    });

    if (Array.isArray(entry.params) && entry.params.length > 0) {
      const paramsLine = h('div', { class: 'params-line' }, h('span', { text: 'Params:' }));
      for (const param of entry.params) {
        paramsLine.append(h('span', { class: 'param-chip', text: JSON.stringify(param) }));
      }
      body.append(paramsLine);
    }

    if (entry.message) {
      body.append(
        h('div', {
          class: 'code-block',
          style: `margin-top:10px;${entry.status === 'error' ? 'background:var(--err-bg);border-color:var(--err-border);color:#7f1d1d' : ''}`,
          text: entry.message
        })
      );
    }

    if (entry.responsePreview) {
      body.append(renderPreview(entry));
    }
    return body;
  }

  function renderPreview(entry: LogEntry): HTMLElement {
    const wrap = h('div', { style: 'margin-top:12px' });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(entry.responsePreview ?? '');
    } catch {
      parsed = null;
    }
    const resultSets = (parsed as { resultSets?: Array<{ columns: string[]; rows: unknown[][]; rowCount: number; command: string; notice?: string }> })?.resultSets;

    const tabs = h('div', { class: 'tabs' });
    const tableTab = h('button', { class: 'tab active', text: 'Table', type: 'button' });
    const rawTab = h('button', { class: 'tab', text: 'Raw', type: 'button' });
    tabs.append(tableTab, rawTab);

    const content = h('div', { style: 'margin-top:10px' });

    function showTable(): void {
      content.replaceChildren();
      if (Array.isArray(resultSets) && resultSets.length > 0) {
        for (const set of resultSets) {
          if (set.columns?.length) {
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
            const info = h('div', { class: 'muted', style: 'margin:6px 2px' }, `${set.rowCount} row(s)${(set as { truncated?: boolean }).truncated ? ' (truncated)' : ''} — ${set.command}`);
            content.append(h('div', { class: 'table-wrap' }, table), info);
          } else {
            content.append(
              h('div', { class: 'code-block', text: set.notice ?? `${set.command} — ${set.rowCount} affected` })
            );
          }
        }
      } else {
        content.append(h('div', { class: 'muted', text: 'No result rows (see Raw for the exact payload sent to the agent).' }));
      }
    }
    function showRaw(): void {
      content.replaceChildren(h('pre', { class: 'code-block', style: 'max-height:320px;overflow:auto', text: entry.responsePreview ?? '' }));
    }
    tableTab.addEventListener('click', () => {
      tableTab.classList.add('active');
      rawTab.classList.remove('active');
      showTable();
    });
    rawTab.addEventListener('click', () => {
      rawTab.classList.add('active');
      tableTab.classList.remove('active');
      showRaw();
    });

    wrap.append(h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Payload returned to the agent' }), h('span', { class: 'grow' }), tabs));
    wrap.append(content);
    showTable();
    return wrap;
  }

  const clearBtn = h('button', { class: 'btn small danger' });
  clearBtn.innerHTML = `${svgIcon('trash', 12)}<span>Clear history</span>`;
  clearBtn.addEventListener('click', async () => {
    const ok = await confirmDialog('Delete the entire execution history? This cannot be undone.', {
      title: 'Clear execution history',
      confirmLabel: 'Clear everything',
      danger: true
    });
    if (!ok) return;
    try {
      await ctx.engine.clearLogs();
      toast('Execution history cleared', 'ok');
      entries = [];
      await loadDates();
      await loadEntries();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  });

  const refreshBtn = h('button', { class: 'btn small', html: `${svgIcon('refresh', 12)}<span>Refresh</span>` });
  refreshBtn.addEventListener('click', () => {
    void loadDates().then(() => loadEntries());
  });

  const el = h(
    'div',
    null,
    crumb('WORK', 'Logs'),
    h('h1', { class: 'page-title', text: 'Logs' }),
    h('p', {
      class: 'page-sub',
      html: 'Every run is recorded locally with the final SQL and the payload sent to the agent.'
    }),
    h('div', { class: 'row', style: 'margin-bottom:14px' }, h('span', { class: 'grow' }), refreshBtn, clearBtn),
    h('div', { class: 'logs-layout' }, datesHost, h('div', { class: 'grow', style: 'min-width:0' }, filterHost, entriesHost))
  );

  void loadDates().then(() => loadEntries());

  return { el, refresh: () => void loadDates().then(() => loadEntries()), dispose: () => undefined };
}
