import { h, svgIcon, chip, engineDot, toast, copyText, appendChildren } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { Connection, ManualExecution } from '../lib/engine';
import { fetchSchema } from '../lib/engine';
import { mountSqlEditor, refreshEditorLanguage, selectedSql, hasSelection } from '../lib/cm';
import { renderExecutionResult } from '../lib/results';
import type { EditorView } from '@codemirror/view';

function targetOf(connection: Connection): string {
  if (connection.engine === 'sqlite') return connection.file ?? '';
  return `${connection.host}:${connection.port}/${connection.database}`;
}

// Database first (the part that matters when picking a target), host after it.
function targetLabel(connection: Connection): string {
  if (connection.engine === 'sqlite') return connection.file ?? '';
  const host = `${connection.host}:${connection.port}`;
  return connection.database ? `${connection.database} @ ${host}` : host;
}

export function createQueryView(ctx: AppContext): View {
  let connections: Connection[] = [];
  let editorView: EditorView | null = null;
  let running = false;

  const connectionSelect = h('select', { class: 'input' }) as HTMLSelectElement;

  const connectionMeta = h('div', { class: 'conn-meta' });
  const schemaState = h('span', { class: 'muted' });
  const statusHost = h('div');
  const resultHost = h('div');
  const editorHost = h('div', { class: 'editor-host' });

  function selectedConnection(): Connection | null {
    return connections.find((connection) => connection.id === connectionSelect.value) ?? null;
  }

  function renderConnectionMeta(): void {
    connectionMeta.replaceChildren();
    const connection = selectedConnection();
    if (!connection) return;
    connectionMeta.append(
      engineDot(connection.engine),
      h('span', { class: 'mono truncate conn-target', text: targetLabel(connection), title: `${connection.engine} · ${targetOf(connection)}` })
    );
    appendChildren(connectionMeta, [
      connection.readOnly ? chip('read-only', 'warn') : null,
      !connection.enabled ? chip('disabled for agents', 'ghost') : null
    ]);
  }

  async function loadSchema(): Promise<void> {
    const connection = selectedConnection();
    if (!connection || !editorView) return;
    schemaState.textContent = 'schema: loading…';
    try {
      const payload = await fetchSchema(ctx.engine.base, ctx.engine.token, connection.id);
      schemaState.textContent = `schema: ${Object.keys(payload.schema).length} tables`;
      if (editorView) refreshEditorLanguage(editorView, payload.engine, payload.schema);
    } catch {
      schemaState.textContent = 'schema: unavailable';
    }
  }

  function renderStatus(children: (Node | string | null)[]): void {
    statusHost.replaceChildren(...children.filter((child): child is Node | string => child !== null));
  }

  async function run(mode: 'smart' | 'selection' = 'smart'): Promise<void> {
    if (running || !editorView) return;
    const connection = selectedConnection();
    if (!connection) {
      toast('Pick a connection first.', 'error');
      return;
    }
    if (mode === 'selection' && !hasSelection(editorView)) {
      toast('Select some SQL in the editor first.', 'error');
      return;
    }
    const sql = selectedSql(editorView);
    if (!sql.trim()) {
      toast('Write some SQL first.', 'error');
      return;
    }

    running = true;
    runBtn.disabled = true;
    const old = runBtn.innerHTML;
    runBtn.innerHTML = '<span class="spinner"></span><span>Running…</span>';
    resultHost.replaceChildren();
    renderStatus([h('div', { class: 'status-panel neutral' }, h('div', { class: 'executing' }, h('span', { class: 'spinner' }), h('span', { text: `Running on ${connection.name}…` })))]);

    try {
      const response = await ctx.engine.execute(connection.id, sql);
      renderStatus([]);

      if ((response as ManualExecution).status === 'blocked') {
        const blocked = response as ManualExecution;
        renderStatus([
          h(
            'div',
            { class: 'review-banner warn', style: 'margin:0 0 12px' },
            h('span', { html: svgIcon('lock', 15) }),
            h('span', { html: `<b>Blocked by read-only mode.</b> ${blocked.message ?? ''}` })
          )
        ]);
        return;
      }

      const result = response as ManualExecution;
      if (result.status !== 'ok') {
        renderStatus([h('div', { class: 'status-panel error' }, h('b', { text: `Status: ${result.status}` }), h('div', { text: result.message ?? '' }))]);
        return;
      }
      renderExecutionResult(resultHost, result);
      toast(`Executed in ${result.durationMs ?? 0} ms`, 'ok');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      renderStatus([
        h(
          'div',
          { class: 'status-panel error' },
          h('b', { text: 'Query failed' }),
          h('div', { class: 'mono', style: 'margin-top:6px;word-break:break-word;font-size:12px' }, message)
        )
      ]);
      toast('Query failed — see the panel below the editor.', 'error');
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.innerHTML = old;
    }
  }

  const runBtn = h('button', { class: 'btn primary', title: 'Runs the selection if any, otherwise the whole editor' });
  runBtn.innerHTML = `${svgIcon('play', 13)}<span>Run (Ctrl+Enter)</span>`;
  runBtn.addEventListener('click', () => void run('smart'));

  const runSelectionBtn = h('button', {
    class: 'btn',
    title: 'Run only the selected SQL',
    disabled: true
  }) as HTMLButtonElement;
  runSelectionBtn.innerHTML = `${svgIcon('play', 13)}<span>Run selection</span>`;
  runSelectionBtn.addEventListener('click', () => void run('selection'));

  function syncSelectionButton(view: EditorView | null): void {
    const enabled = Boolean(view && hasSelection(view));
    runSelectionBtn.disabled = !enabled;
    runSelectionBtn.classList.toggle('selection-armed', enabled);
  }

  const clearBtn = h('button', { class: 'icon-btn', title: 'Clear the editor', html: svgIcon('trash', 15) });
  clearBtn.addEventListener('click', () => {
    editorView?.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: '' } });
    resultHost.replaceChildren();
    renderStatus([]);
    syncSelectionButton(editorView);
  });

  const copyBtn = h('button', { class: 'icon-btn', title: 'Copy SQL', html: svgIcon('copy', 15) });
  copyBtn.addEventListener('click', () => copyText(editorView?.state.doc.toString() ?? '', 'SQL copied'));

  connectionSelect.addEventListener('change', () => {
    renderConnectionMeta();
    void loadSchema();
    schemaState.textContent = 'schema: loading…';
  });

  async function load(): Promise<void> {
    try {
      const payload = await ctx.engine.connections();
      connections = payload.connections;
    } catch (error) {
      toast((error as Error).message, 'error');
      connections = [];
    }
    const previous = connectionSelect.value;
    connectionSelect.replaceChildren();
    if (connections.length === 0) {
      connectionSelect.append(h('option', { value: '', text: 'No connections configured' }));
    } else {
      for (const connection of connections) {
        const suffix = [connection.readOnly ? 'read-only' : '', connection.enabled === false ? 'disabled' : '']
          .filter(Boolean)
          .join(', ');
        connectionSelect.append(
          h('option', { value: connection.id, text: `${connection.name} · ${connection.engine}${suffix ? ` (${suffix})` : ''}` })
        );
      }
      const preferred = connections.find((connection) => connection.id === previous) ?? connections.find((connection) => connection.enabled !== false) ?? connections[0];
      connectionSelect.value = preferred.id;
    }
    renderConnectionMeta();
    await loadSchema();
  }

  const el = h(
    'div',
    null,
    crumb('WORK', 'SQL editor'),
    h('h1', { class: 'page-title', text: 'SQL editor' }),
    h('p', {
      class: 'page-sub',
      html: 'Write SQL yourself — highlighted, with schema autocomplete. <b>Read-only connections block writes</b>; every run is logged.'
    }),
    h(
      'div',
      { class: 'card tight query-bar' },
      h(
        'div',
        { class: 'query-bar-main' },
        h('span', { class: 'query-bar-select' }, connectionSelect),
        h('span', { class: 'grow' }),
        runSelectionBtn,
        runBtn
      ),
      connectionMeta
    ),
    h(
      'div',
      { class: 'editor-card', style: 'margin-top:12px' },
      h(
        'div',
        { class: 'editor-toolbar query-toolbar' },
        h('span', { text: 'SQL' }),
        h('span', { class: 'grow' }),
        schemaState,
        copyBtn,
        clearBtn
      ),
      editorHost
    ),
    h('div', { style: 'margin-top:14px' }, statusHost, resultHost)
  );

  editorView = mountSqlEditor(editorHost, {
    value: '',
    engine: 'postgres',
    minHeight: '160px',
    maxHeight: '380px',
    placeholder: 'SELECT * FROM …    —    Ctrl+Enter to run',
    onRun: () => void run('smart'),
    onSelectionChange: () => syncSelectionButton(editorView)
  });
  syncSelectionButton(editorView);

  void load();

  return { el, refresh: () => void load(), dispose: () => editorView?.destroy() };
}
