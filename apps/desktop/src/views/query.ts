import {
  h,
  svgIcon,
  chip,
  engineDot,
  toast,
  copyText,
  openModal,
  confirmDialog,
  statusBadge,
  relativeTime,
  appendChildren
} from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { Connection, DbObjectDetail, DbObjectSummary, LogEntry, ManualExecution } from '../lib/engine';
import { fetchSchema } from '../lib/engine';
import { mountSqlEditor, refreshEditorLanguage, selectedSql, hasSelection } from '../lib/cm';
import { renderExecutionResult } from '../lib/results';
import type { EditorView } from '@codemirror/view';

type TabStatus = 'idle' | 'running' | 'ok' | 'blocked' | 'error';
type SideMode = 'objects' | 'history' | 'saved';

interface QueryTab {
  id: string;
  title: string;
  sql: string;
  connectionId: string | null;
  result: ManualExecution | null;
  error: string | null;
  status: TabStatus;
  lastMode?: 'run' | 'explain';
}

interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connectionId: string | null;
  createdAt: number;
}

const DEFAULT_ROWS = 200;
const SAVED_KEY = 'lazy-sql.saved-queries.v1';
const KIND_ORDER = ['table', 'view', 'function', 'procedure', 'trigger'];
const KIND_LABELS: Record<string, string> = {
  table: 'Tables',
  view: 'Views',
  function: 'Functions',
  procedure: 'Procedures',
  trigger: 'Triggers'
};
const KIND_ICONS: Record<string, string> = {
  table: 'grid',
  view: 'eye',
  function: 'sparkle',
  procedure: 'terminal',
  trigger: 'refresh'
};

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

function quotePart(engine: string, value: string): string {
  if (engine === 'mssql') return `[${value.replace(/]/g, ']]')}]`;
  if (engine === 'mysql') return `\`${value.replace(/`/g, '``')}\``;
  return `"${value.replace(/"/g, '""')}"`;
}

function qualifiedName(engine: string, object: DbObjectSummary): string {
  const schema = object.schema && object.schema !== 'main' ? object.schema : engine === 'sqlite' ? null : object.schema;
  return schema ? `${quotePart(engine, schema)}.${quotePart(engine, object.name)}` : quotePart(engine, object.name);
}

function previewSql(engine: string, object: DbObjectSummary, limit = DEFAULT_ROWS): string {
  const target = qualifiedName(engine, object);
  if (engine === 'mssql') return `SELECT TOP (${limit}) * FROM ${target};`;
  return `SELECT * FROM ${target} LIMIT ${limit};`;
}

function selectTemplate(engine: string, object: DbObjectSummary): string {
  return `SELECT * FROM ${qualifiedName(engine, object)};`;
}

function callTemplate(engine: string, object: DbObjectSummary): string {
  const target = qualifiedName(engine, object);
  if (engine === 'mssql') return `EXEC ${target};`;
  if (engine === 'mysql' && object.kind === 'procedure') return `CALL ${target}();`;
  return `SELECT ${target}();`;
}

function explainSql(engine: string, sql: string): string | null {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!trimmed) return null;
  if (engine === 'sqlite') return `EXPLAIN QUERY PLAN ${trimmed};`;
  if (engine === 'postgres' || engine === 'mysql') return `EXPLAIN ${trimmed};`;
  return null;
}

function firstLine(sql: string, length = 84): string {
  const line = sql.trim().split(/\r?\n/).find((entry) => entry.trim())?.trim() ?? '';
  return line.length > length ? `${line.slice(0, length)}…` : line;
}

function objectKey(connectionId: string, object: DbObjectSummary): string {
  return `${connectionId}:${object.kind}:${object.schema}:${object.name}`;
}

function loadSavedQueries(): SavedQuery[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SavedQuery => Boolean(entry) && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.sql === 'string');
  } catch {
    return [];
  }
}

function storeSavedQueries(queries: SavedQuery[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(queries));
  } catch {
    /* storage can be unavailable; the current session still works */
  }
}

export function createQueryView(ctx: AppContext): View {
  let connections: Connection[] = [];
  let tabs: QueryTab[] = [];
  let activeTabId = '';
  let tabCounter = 0;
  let running = false;
  let suppressEditorChange = false;
  let sideMode: SideMode = 'objects';
  let sideCollapsed = false;
  let objectsFilter = '';
  let historyFilter = '';
  let objectsLoading = false;
  let historyLoading = false;
  let objectsError: string | null = null;
  let historyError: string | null = null;
  let activeRows = DEFAULT_ROWS;
  let objectSearchResults: DbObjectSummary[] | null = null;
  let objectSearchQuery = '';
  let objectSearchLoading = false;
  let objectSearchError: string | null = null;
  let objectSearchTimer: number | null = null;
  let objectSearchRequest = 0;
  let objectSearchCount = 0;
  let objectSearchTruncated = false;
  let objectScopeId = '';
  const objectCache = new Map<string, DbObjectSummary[]>();
  const objectTotals = new Map<string, { count: number; truncated: boolean }>();
  const detailCache = new Map<string, DbObjectDetail>();
  const schemaCache = new Map<string, Record<string, string[]>>();
  const expandedObjects = new Set<string>();
  const collapsedKinds = new Set<string>();
  let historyEntries: LogEntry[] = [];
  let savedQueries = loadSavedQueries();
  let objectsRequest = 0;
  let historyRequest = 0;
  let schemaRequest = 0;
  let editorView: EditorView | null = null;

  /* ---------- stable DOM ---------- */

  const tabsBar = h('div', { class: 'query-tabs', role: 'tablist', 'aria-label': 'Query tabs' });
  const connectionSelect = h('select', { class: 'input', 'aria-label': 'Connection' }) as HTMLSelectElement;
  const rowsInput = h('input', { class: 'input rows-input', type: 'number', min: '1', max: '5000', value: String(activeRows), 'aria-label': 'Row limit' }) as HTMLInputElement;
  const connectionMeta = h('div', { class: 'conn-meta' });
  const schemaState = h('span', { class: 'muted' });
  const statusHost = h('div');
  const resultHost = h('div');
  const editorHost = h('div', { class: 'editor-host sql-editor-host' });
  const sideTabs = h('div', { class: 'side-tabs', role: 'tablist', 'aria-label': 'SQL workspace panels' });
  const sideTools = h('div', { class: 'side-tools' });
  const sideBody = h('div', { class: 'side-body' });

  const objectsSearch = h('input', { class: 'input', type: 'search', placeholder: 'Search all objects…', 'aria-label': 'Search database objects' }) as HTMLInputElement;
  objectsSearch.addEventListener('input', () => {
    objectsFilter = objectsSearch.value;
    if (objectSearchTimer) window.clearTimeout(objectSearchTimer);
    objectSearchTimer = null;

    if (!objectsFilter.trim()) {
      objectSearchRequest += 1;
      objectSearchResults = null;
      objectSearchQuery = '';
      objectSearchLoading = false;
      objectSearchError = null;
      renderSideBody();
      return;
    }

    // The explorer only keeps the first page of objects (agent response budget), so filtering
    // locally would miss objects further down the alphabet. Ask the engine for matches instead.
    objectSearchRequest += 1;
    objectSearchLoading = true;
    objectSearchError = null;
    renderSideBody();
    objectSearchTimer = window.setTimeout(() => void searchObjects(), 250);
  });
  const historySearch = h('input', { class: 'input', type: 'search', placeholder: 'Filter history…', 'aria-label': 'Filter query history' }) as HTMLInputElement;
  historySearch.addEventListener('input', () => {
    historyFilter = historySearch.value;
    renderSideBody();
  });

  /* ---------- helpers ---------- */

  function activeTab(): QueryTab | null {
    return tabs.find((tab) => tab.id === activeTabId) ?? null;
  }

  function findConnection(id: string | null | undefined): Connection | null {
    return connections.find((connection) => connection.id === id) ?? null;
  }

  function activeConnection(): Connection | null {
    return findConnection(activeTab()?.connectionId);
  }

  function persistEditorText(): void {
    const tab = activeTab();
    if (tab && editorView) tab.sql = editorView.state.doc.toString();
  }

  function syncEditorText(): void {
    const tab = activeTab();
    if (!tab || !editorView) return;
    if (editorView.state.doc.toString() === tab.sql) return;
    suppressEditorChange = true;
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: tab.sql },
      selection: { anchor: tab.sql.length }
    });
    suppressEditorChange = false;
  }

  function applyEditorLanguage(): void {
    if (!editorView) return;
    const connection = activeConnection();
    refreshEditorLanguage(editorView, connection?.engine ?? 'postgres', connection ? schemaCache.get(connection.id) ?? null : null);
    schemaState.textContent = connection
      ? schemaCache.has(connection.id)
        ? `schema: ${Object.keys(schemaCache.get(connection.id) ?? {}).length} tables`
        : 'schema: loading…'
      : 'schema: —';
  }

  function renderConnectionMeta(): void {
    connectionMeta.replaceChildren();
    const connection = activeConnection();
    if (!connection) {
      connectionMeta.append(h('span', { class: 'muted', text: connections.length === 0 ? 'No connections configured yet.' : 'Pick a connection to start.' }));
      return;
    }
    appendChildren(connectionMeta, [
      engineDot(connection.engine),
      h('span', { class: 'mono truncate conn-target', text: targetLabel(connection), title: `${connection.engine} · ${targetOf(connection)}` }),
      connection.readOnly ? chip('read-only', 'warn') : null,
      !connection.enabled ? chip('disabled for agents', 'ghost') : null
    ]);
  }

  function renderTabs(): void {
    tabsBar.replaceChildren();
    for (const tab of tabs) {
      const label = h('button', { class: 'query-tab-label', role: 'tab', 'aria-selected': String(tab.id === activeTabId), title: tab.sql.trim() ? firstLine(tab.sql, 120) : tab.title });
      label.textContent = tab.title;
      if (tab.status === 'running') label.append(h('span', { class: 'tab-status running' }));
      else if (tab.status === 'error') label.append(h('span', { class: 'tab-status error' }));
      label.addEventListener('click', () => activateTab(tab.id));
      const close = h('button', { class: 'query-tab-close', title: 'Close tab', 'aria-label': `Close ${tab.title}`, html: svgIcon('x', 11) });
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      tabsBar.append(h('div', { class: `query-tab${tab.id === activeTabId ? ' active' : ''}` }, label, close));
    }
    const add = h('button', { class: 'query-tab-add', title: 'New query tab (Ctrl+T)', 'aria-label': 'New query tab', html: svgIcon('plus', 14) });
    add.addEventListener('click', () => newTab('', activeConnection()?.id ?? connections[0]?.id ?? null));
    tabsBar.append(add);
  }

  /* ---------- tabs ---------- */

  function makeTab(sql: string, connectionId: string | null, title?: string): QueryTab {
    tabCounter += 1;
    return {
      id: `query-tab-${Date.now()}-${tabCounter}`,
      title: title ?? `Query ${tabCounter}`,
      sql,
      connectionId,
      result: null,
      error: null,
      status: 'idle'
    };
  }

  function activateTab(id: string): void {
    if (id === activeTabId) return;
    persistEditorText();
    activeTabId = id;
    const tab = activeTab();
    if (!tab) return;
    renderTabs();
    syncEditorText();
    syncToolbar();
    renderConnectionMeta();
    renderResult();
    applyEditorLanguage();
    void ensureActiveSchema();
    void loadObjects();
    void loadHistory();
  }

  function newTab(sql: string, connectionId: string | null, options: { title?: string; runNow?: boolean } = {}): QueryTab {
    persistEditorText();
    const tab = makeTab(sql, connectionId, options.title);
    tabs.push(tab);
    activeTabId = tab.id;
    renderTabs();
    syncEditorText();
    syncToolbar();
    renderConnectionMeta();
    renderResult();
    applyEditorLanguage();
    void ensureActiveSchema();
    void loadObjects();
    void loadHistory();
    if (options.runNow) void run('smart');
    return tab;
  }

  function closeTab(id: string): void {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = activeTabId === id;
    if (wasActive) persistEditorText();
    tabs.splice(index, 1);
    if (tabs.length === 0) {
      const fallback = makeTab('', connections.find((connection) => connection.enabled !== false)?.id ?? connections[0]?.id ?? null, 'Query 1');
      tabs.push(fallback);
      activeTabId = fallback.id;
    } else if (wasActive) {
      activeTabId = tabs[Math.min(index, tabs.length - 1)]!.id;
    }
    renderTabs();
    if (wasActive) {
      syncEditorText();
      syncToolbar();
      renderConnectionMeta();
      renderResult();
      applyEditorLanguage();
      void ensureActiveSchema();
      void loadObjects();
      void loadHistory();
    }
  }

  /* ---------- data loading ---------- */

  async function ensureActiveSchema(): Promise<void> {
    const connection = activeConnection();
    if (!connection) {
      schemaState.textContent = 'schema: —';
      return;
    }
    if (schemaCache.has(connection.id)) {
      applyEditorLanguage();
      return;
    }
    const request = ++schemaRequest;
    schemaState.textContent = 'schema: loading…';
    try {
      const payload = await fetchSchema(ctx.engine.base, ctx.engine.token, connection.id);
      schemaCache.set(connection.id, payload.schema);
      if (request === schemaRequest && activeConnection()?.id === connection.id) applyEditorLanguage();
    } catch {
      if (request === schemaRequest && activeConnection()?.id === connection.id) schemaState.textContent = 'schema: unavailable';
    }
  }

  function resetObjectSearch(): void {
    if (objectSearchTimer) window.clearTimeout(objectSearchTimer);
    objectSearchTimer = null;
    objectSearchRequest += 1;
    objectsFilter = '';
    objectSearchResults = null;
    objectSearchQuery = '';
    objectSearchLoading = false;
    objectSearchError = null;
    objectSearchCount = 0;
    objectSearchTruncated = false;
    if (objectsSearch.value) objectsSearch.value = '';
  }

  function syncObjectScope(connectionId: string | null): void {
    const next = connectionId ?? '';
    if (objectScopeId === next) return;
    objectScopeId = next;
    resetObjectSearch();
  }

  async function searchObjects(): Promise<void> {
    const connection = activeConnection();
    const filter = objectsFilter.trim();
    if (!connection || !filter) return;
    const request = ++objectSearchRequest;
    objectSearchLoading = true;
    objectSearchError = null;
    renderSideBody();
    try {
      const payload = await ctx.engine.objects(connection.id, 1000, filter);
      if (request !== objectSearchRequest || activeConnection()?.id !== connection.id || objectsFilter.trim() !== filter) return;
      objectSearchResults = payload.objects;
      objectSearchQuery = filter.toLowerCase();
      objectSearchCount = payload.count;
      objectSearchTruncated = payload.truncated;
    } catch (error) {
      if (request !== objectSearchRequest) return;
      objectSearchError = (error as Error).message;
    } finally {
      if (request === objectSearchRequest) {
        objectSearchLoading = false;
        renderSideBody();
      }
    }
  }

  async function loadObjects(force = false): Promise<void> {
    const connection = activeConnection();
    syncObjectScope(connection?.id ?? null);
    if (!connection) {
      objectsLoading = false;
      objectsError = null;
      renderSideBody();
      return;
    }
    if (!force && objectCache.has(connection.id)) {
      renderSideBody();
      return;
    }
    const request = ++objectsRequest;
    objectsLoading = true;
    objectsError = null;
    renderSideBody();
    try {
      const payload = await ctx.engine.objects(connection.id, 1000);
      if (request !== objectsRequest || activeConnection()?.id !== connection.id) return;
      objectCache.set(connection.id, payload.objects);
      objectTotals.set(connection.id, { count: payload.count, truncated: payload.truncated });
      detailCache.clear();
    } catch (error) {
      if (request !== objectsRequest) return;
      objectsError = (error as Error).message;
    } finally {
      if (request === objectsRequest) {
        objectsLoading = false;
        renderSideBody();
      }
    }
  }

  async function loadHistory(): Promise<void> {
    const connection = activeConnection();
    const request = ++historyRequest;
    if (!connection) {
      historyEntries = [];
      historyLoading = false;
      if (sideMode === 'history') renderSideBody();
      return;
    }
    historyLoading = true;
    historyError = null;
    if (sideMode === 'history') renderSideBody();
    try {
      const payload = await ctx.engine.history(300, connection.name);
      if (request !== historyRequest) return;
      historyEntries = payload.entries;
    } catch (error) {
      if (request !== historyRequest) return;
      historyError = (error as Error).message;
    } finally {
      if (request === historyRequest) {
        historyLoading = false;
        if (sideMode === 'history') renderSideBody();
      }
    }
  }

  /* ---------- results ---------- */

  function renderResult(): void {
    const tab = activeTab();
    statusHost.replaceChildren();
    resultHost.replaceChildren();
    if (!tab) return;

    if (tab.status === 'running') {
      statusHost.append(h('div', { class: 'status-panel neutral' }, h('div', { class: 'executing' }, h('span', { class: 'spinner' }), h('span', { text: 'Running…' }))));
      return;
    }

    if (tab.status === 'blocked') {
      statusHost.append(
        h(
          'div',
          { class: 'review-banner warn', style: 'margin:0 0 12px' },
          h('span', { html: svgIcon('lock', 15) }),
          h('span', { html: `<b>Blocked by read-only mode.</b> ${tab.error ?? ''}` })
        )
      );
      return;
    }

    if (tab.status === 'error') {
      statusHost.append(
        h(
          'div',
          { class: 'status-panel error' },
          h('b', { text: 'Query failed' }),
          h('div', { class: 'mono', style: 'margin-top:6px;word-break:break-word;font-size:12px' }, tab.error ?? 'Unknown error')
        )
      );
      return;
    }

    if (tab.result && tab.result.status === 'ok') {
      if (tab.lastMode === 'explain') statusHost.append(h('div', { class: 'row', style: 'margin-bottom:2px' }, chip('query plan', 'violet'), h('span', { class: 'muted', text: 'EXPLAIN — the statement was not executed' })));
      renderExecutionResult(resultHost, tab.result, { maxHeight: 430 });
      return;
    }

    const connection = activeConnection();
    const empty = h(
      'div',
      { class: 'sql-empty' },
      h('span', { class: 'sql-empty-icon', html: svgIcon('terminal', 22) }),
      h('b', { text: connection ? `Ready on ${connection.name}` : 'Pick a connection' }),
      h('span', { class: 'muted', text: connection ? 'Run SQL with Ctrl+Enter, or open a table from the object explorer to preview its rows.' : 'Add a connection first, then run SQL here.' })
    );
    if (!connection) {
      const connect = h('button', { class: 'btn small primary', text: 'Open connections' });
      connect.addEventListener('click', () => ctx.navigate('connections'));
      empty.append(connect);
    }
    resultHost.append(empty);
  }

  /* ---------- actions ---------- */

  function syncToolbar(): void {
    const tab = activeTab();
    const connection = activeConnection();
    const canRun = Boolean(connection && tab && !running);
    runBtn.disabled = !canRun;
    explainBtn.disabled = !canRun;
    saveBtn.disabled = !tab || !tab.sql.trim();
    runSelectionBtn.disabled = !canRun || !editorView || !hasSelection(editorView);
    connectionSelect.value = tab?.connectionId ?? '';
    if (tab?.status === 'running') {
      runBtn.innerHTML = '<span class="spinner"></span><span>Running…</span>';
    } else {
      runBtn.innerHTML = `${svgIcon('play', 13)}<span>Run</span><span class="kbd-hint">Ctrl+↵</span>`;
    }
  }

  async function run(mode: 'smart' | 'selection' | 'explain' = 'smart'): Promise<void> {
    if (running || !editorView) return;
    const tab = activeTab();
    if (!tab) return;
    const connection = activeConnection();
    if (!connection) {
      toast('Pick a connection first.', 'error');
      return;
    }
    if (mode === 'selection' && !hasSelection(editorView)) {
      toast('Select some SQL in the editor first.', 'error');
      return;
    }
    const selected = selectedSql(editorView);
    if (!selected.trim()) {
      toast('Write some SQL first.', 'error');
      return;
    }
    let sql = selected;
    if (mode === 'explain') {
      const explained = explainSql(connection.engine, selected);
      if (!explained) {
        toast('Explain is available for PostgreSQL, MySQL and SQLite connections.', 'error');
        return;
      }
      sql = explained;
    }

    tab.sql = editorView.state.doc.toString();
    running = true;
    tab.status = 'running';
    tab.error = null;
    tab.result = null;
    tab.lastMode = mode === 'explain' ? 'explain' : 'run';
    renderTabs();
    renderResult();
    syncToolbar();

    try {
      const response = await ctx.engine.execute(connection.id, sql, activeRows);
      if (!tabs.includes(tab)) return;
      tab.result = response;
      if (response.status === 'blocked') {
        tab.status = 'blocked';
        tab.error = response.message ?? null;
      } else if (response.status === 'ok') {
        tab.status = 'ok';
        tab.error = null;
        toast(`Executed in ${response.durationMs ?? 0} ms`, 'ok');
        void loadHistory();
      } else {
        tab.status = 'error';
        tab.error = response.message ?? `Status: ${response.status}`;
      }
      if (activeTabId === tab.id) renderResult();
    } catch (error) {
      if (!tabs.includes(tab)) return;
      tab.status = 'error';
      tab.error = error instanceof Error ? error.message : String(error);
      if (activeTabId === tab.id) renderResult();
      toast('Query failed — see the panel below the editor.', 'error');
    } finally {
      running = false;
      renderTabs();
      if (activeTabId === tab.id) renderResult();
      syncToolbar();
    }
  }

  function explain(): void {
    void run('explain');
  }

  /* ---------- saved queries ---------- */

  function saveCurrent(): void {
    const tab = activeTab();
    if (!tab || !editorView) return;
    const sql = editorView.state.doc.toString();
    if (!sql.trim()) {
      toast('Write some SQL first.', 'error');
      return;
    }
    const input = h('input', { class: 'input', value: firstLine(sql, 60) || 'Saved query', 'aria-label': 'Query name' }) as HTMLInputElement;
    const body = h('div', null, h('label', { class: 'field-label', text: 'Name' }), input, h('p', { class: 'muted', style: 'margin:8px 0 0' }, 'Saved queries stay on this machine.'));
    const cancel = h('button', { class: 'btn', text: 'Cancel' });
    const save = h('button', { class: 'btn primary', text: 'Save query' });
    const modal = openModal({
      title: 'Save query',
      subtitle: 'Keep this statement for later',
      body,
      width: 460,
      footer: h('div', { class: 'row-end' }, cancel, save)
    });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', () => {
      const name = input.value.trim() || firstLine(sql, 60) || 'Saved query';
      savedQueries = [
        { id: `saved-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, sql, connectionId: tab.connectionId, createdAt: Date.now() },
        ...savedQueries
      ];
      storeSavedQueries(savedQueries);
      modal.close();
      toast('Query saved', 'ok');
      if (sideMode === 'saved') renderSideBody();
    });
    window.setTimeout(() => input.focus(), 30);
  }

  function openSaved(query: SavedQuery): void {
    const connectionId = findConnection(query.connectionId)?.id ?? activeConnection()?.id ?? connections[0]?.id ?? null;
    newTab(query.sql, connectionId, { title: query.name.slice(0, 32) });
  }

  async function deleteSaved(query: SavedQuery): Promise<void> {
    const ok = await confirmDialog(`Delete the saved query "${query.name}"?`, { title: 'Delete saved query', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    savedQueries = savedQueries.filter((entry) => entry.id !== query.id);
    storeSavedQueries(savedQueries);
    renderSideBody();
    toast('Saved query deleted', 'ok');
  }

  /* ---------- object explorer ---------- */

  function renderSide(): void {
    const wasObjectsSearch = document.activeElement === objectsSearch;
    const wasHistorySearch = document.activeElement === historySearch;

    sideTabs.replaceChildren(
      sideTab('objects', 'Objects', 'database'),
      sideTab('history', 'History', 'clock'),
      sideTab('saved', 'Saved', 'book')
    );

    sideTools.replaceChildren();
    if (sideMode === 'objects') {
      sideTools.append(h('div', { class: 'search-box grow' }, h('span', { class: 'icon-wrap', html: svgIcon('search', 13) }), objectsSearch));
      const refresh = h('button', { class: 'icon-btn', title: 'Refresh objects', 'aria-label': 'Refresh objects', html: svgIcon('refresh', 14) });
      refresh.addEventListener('click', () => {
        if (objectsFilter.trim()) void searchObjects();
        else void loadObjects(true);
      });
      sideTools.append(refresh);
    } else if (sideMode === 'history') {
      sideTools.append(h('div', { class: 'search-box grow' }, h('span', { class: 'icon-wrap', html: svgIcon('search', 13) }), historySearch));
      const refresh = h('button', { class: 'icon-btn', title: 'Refresh history', 'aria-label': 'Refresh history', html: svgIcon('refresh', 14) });
      refresh.addEventListener('click', () => void loadHistory());
      sideTools.append(refresh);
    } else {
      const save = h('button', { class: 'btn small primary grow', html: `${svgIcon('plus', 12)}<span>Save current query</span>` });
      save.addEventListener('click', saveCurrent);
      sideTools.append(save);
    }

    renderSideBody();

    if (wasObjectsSearch) {
      objectsSearch.focus();
      objectsSearch.setSelectionRange(objectsSearch.value.length, objectsSearch.value.length);
    } else if (wasHistorySearch) {
      historySearch.focus();
      historySearch.setSelectionRange(historySearch.value.length, historySearch.value.length);
    }
  }

  function sideTab(mode: SideMode, label: string, icon: string): HTMLElement {
    const button = h('button', { class: `side-tab${sideMode === mode ? ' active' : ''}`, role: 'tab', 'aria-selected': String(sideMode === mode) });
    button.innerHTML = `${svgIcon(icon, 13)}<span>${label}</span>`;
    button.addEventListener('click', () => {
      sideMode = mode;
      renderSide();
      if (mode === 'history') void loadHistory();
    });
    return button;
  }

  function renderSideBody(): void {
    const connection = activeConnection();
    syncObjectScope(connection?.id ?? null);
    sideBody.replaceChildren();
    if (!connection) {
      sideBody.append(h('div', { class: 'side-empty' }, 'Pick a connection to browse objects and history.'));
      return;
    }
    if (sideMode === 'objects') renderObjects();
    else if (sideMode === 'history') renderHistory();
    else renderSaved();
  }

  function objectGroups(): Array<{ kind: string; objects: DbObjectSummary[] }> {
    const connection = activeConnection();
    const needle = objectsFilter.trim().toLowerCase();
    const cached = connection ? objectCache.get(connection.id) ?? [] : [];
    // While a search is running (or before it returns), narrow the cached page locally for instant
    // feedback. The server response replaces it with matches from the whole schema.
    const hasServerResults = Boolean(needle && objectSearchResults && objectSearchQuery === needle);
    const filtered = hasServerResults
      ? objectSearchResults!
      : needle
        ? cached.filter((object) => object.name.toLowerCase().includes(needle) || String(object.schema ?? '').toLowerCase().includes(needle))
        : cached;
    const groups: Array<{ kind: string; objects: DbObjectSummary[] }> = [];
    for (const kind of KIND_ORDER) {
      const entries = filtered.filter((object) => object.kind === kind);
      if (entries.length > 0) groups.push({ kind, objects: entries });
    }
    for (const object of filtered) {
      if (!KIND_ORDER.includes(object.kind)) {
        const group = groups.find((entry) => entry.kind === object.kind);
        if (group) group.objects.push(object);
        else groups.push({ kind: object.kind, objects: [object] });
      }
    }
    return groups;
  }

  function renderObjects(): void {
    const connection = activeConnection();
    if (!connection) return;
    const searching = Boolean(objectsFilter.trim());
    const searchCurrent = searching && objectSearchQuery === objectsFilter.trim().toLowerCase() && objectSearchResults !== null;

    if (searching && objectSearchError) {
      const retry = h('button', { class: 'btn small', text: 'Retry' });
      retry.addEventListener('click', () => void searchObjects());
      sideBody.append(h('div', { class: 'side-empty' }, h('div', { text: objectSearchError }), retry));
      return;
    }

    if ((searching && objectSearchLoading && !searchCurrent) || (!searching && objectsLoading && !objectCache.has(connection.id))) {
      sideBody.append(h('div', { class: 'side-empty' }, h('span', { class: 'spinner' }), searching ? ' Searching all objects…' : ' Loading objects…'));
      return;
    }
    if (!searching && objectsError) {
      const retry = h('button', { class: 'btn small', text: 'Retry' });
      retry.addEventListener('click', () => void loadObjects(true));
      sideBody.append(h('div', { class: 'side-empty' }, h('div', { text: objectsError }), retry));
      return;
    }

    const groups = objectGroups();
    if (groups.length === 0) {
      const total = objectSearchCount || objectTotals.get(connection.id)?.count || 0;
      sideBody.append(
        h(
          'div',
          { class: 'side-empty' },
          searching ? `No objects match "${objectsFilter}"${total > 0 ? ` (searched ${total} objects)` : ''}.` : 'No tables, views or routines found.'
        )
      );
      return;
    }

    for (const group of groups) {
      const collapsed = collapsedKinds.has(group.kind);
      const head = h('button', { class: 'tree-group', 'aria-expanded': String(!collapsed) });
      head.innerHTML = `${svgIcon(collapsed ? 'chevronRight' : 'chevronDown', 12)}${svgIcon(KIND_ICONS[group.kind] ?? 'grid', 13)}<span class="grow">${KIND_LABELS[group.kind] ?? group.kind}</span><span class="tree-count">${group.objects.length}</span>`;
      head.addEventListener('click', () => {
        if (collapsed) collapsedKinds.delete(group.kind);
        else collapsedKinds.add(group.kind);
        renderSideBody();
      });
      sideBody.append(head);
      if (collapsed) continue;

      for (const object of group.objects) {
        const key = objectKey(connection.id, object);
        const expanded = expandedObjects.has(key);
        const row = h('button', { class: `tree-item${expanded ? ' expanded' : ''}`, title: `${object.kind} ${object.schema}.${object.name}` });
        const schemaName = object.schema && object.schema !== 'main' ? `<span class="tree-schema">${object.schema}</span>` : '';
        row.innerHTML = `${svgIcon(expanded ? 'chevronDown' : 'chevronRight', 11)}${svgIcon(KIND_ICONS[object.kind] ?? 'grid', 13)}<span class="tree-name grow">${schemaName}${object.name}</span>`;
        row.addEventListener('click', () => {
          if (expanded) expandedObjects.delete(key);
          else expandedObjects.add(key);
          renderSideBody();
        });
        sideBody.append(row);
        if (expanded) {
          const detailHost = h('div', { class: 'tree-detail' });
          sideBody.append(detailHost);
          renderDetail(connection, object, detailHost);
        }
      }
    }

    const shown = groups.reduce((total, group) => total + group.objects.length, 0);
    if (searching) {
      const total = objectSearchCount || shown;
      if (objectSearchLoading) sideBody.append(h('div', { class: 'side-note' }, h('span', { class: 'spinner' }), ' Searching all objects…'));
      else if (objectSearchTruncated || total > shown) sideBody.append(h('div', { class: 'side-note' }, `Showing ${shown} of ${total} matches — refine the search.`));
      else sideBody.append(h('div', { class: 'side-note' }, `${shown} object${shown === 1 ? '' : 's'} across the whole database.`));
      return;
    }

    const totals = objectTotals.get(connection.id);
    const cachedCount = objectCache.get(connection.id)?.length ?? shown;
    if (totals?.truncated) {
      sideBody.append(h('div', { class: 'side-note' }, `Showing ${cachedCount} of ${totals.count} objects — type above to search the rest.`));
    }
  }

  function renderDetail(connection: Connection, object: DbObjectSummary, host: HTMLElement): void {
    const key = objectKey(connection.id, object);
    const cached = detailCache.get(key);
    if (cached) {
      renderDetailInto(host, connection, object, cached);
      return;
    }
    host.append(h('div', { class: 'muted' }, h('span', { class: 'spinner' }), ' Loading details…'));
    ctx.engine
      .objectDetail(connection.id, object, true)
      .then((payload) => {
        if (!payload.found || !payload.object) {
          host.replaceChildren(h('div', { class: 'muted' }, payload.message ?? 'Object details are not available.'));
          return;
        }
        detailCache.set(key, payload.object);
        renderDetailInto(host, connection, object, payload.object);
      })
      .catch((error) => host.replaceChildren(h('div', { class: 'muted' }, (error as Error).message)));
  }

  function renderDetailInto(host: HTMLElement, connection: Connection, object: DbObjectSummary, detail: DbObjectDetail): void {
    host.replaceChildren();
    const actions = h('div', { class: 'tree-actions' });
    if (object.kind === 'table' || object.kind === 'view') {
      const preview = h('button', { class: 'btn small primary', text: 'Preview rows' });
      preview.addEventListener('click', () => openQuery(previewSql(connection.engine, object, activeRows), connection.id, { title: `${object.name} preview`, runNow: true }));
      const select = h('button', { class: 'btn small', text: 'SELECT' });
      select.addEventListener('click', () => openQuery(selectTemplate(connection.engine, object), connection.id, { title: object.name }));
      actions.append(preview, select);
    }
    if (object.kind === 'function' || object.kind === 'procedure') {
      const call = h('button', { class: 'btn small', text: 'Call' });
      call.addEventListener('click', () => openQuery(callTemplate(connection.engine, object), connection.id, { title: object.name }));
      actions.append(call);
    }
    const copyName = h('button', { class: 'btn small', text: 'Copy name' });
    copyName.addEventListener('click', () => copyText(qualifiedName(connection.engine, object), 'Object name copied'));
    actions.append(copyName);
    if (detail.definition) {
      const copyDdl = h('button', { class: 'btn small', text: 'Copy DDL' });
      copyDdl.addEventListener('click', () => copyText(detail.definition ?? '', 'Definition copied'));
      actions.append(copyDdl);
    }
    host.append(actions);

    if (detail.columns.length > 0) {
      const table = h('table', { class: 'table detail-table' });
      const head = h('tr');
      for (const label of ['Column', 'Type', 'Null', 'Default']) head.append(h('th', { text: label }));
      const top = h('thead', null, head);
      const body = h('tbody');
      for (const column of detail.columns) {
        const row = h('tr');
        row.append(
          h('td', { class: 'mono', text: column.name }),
          h('td', { class: 'mono', text: column.type ?? '—' }),
          h('td', { text: column.nullable ? 'yes' : 'no' }),
          h('td', { class: 'mono', text: column.defaultValue ?? '—' })
        );
        body.append(row);
      }
      table.append(top, body);
      host.append(h('div', { class: 'table-wrap', style: 'max-height:220px' }, table));
    }

    if (detail.primaryKey.length > 0) {
      host.append(h('div', { class: 'detail-line' }, h('span', { class: 'muted', text: 'Primary key' }), ...detail.primaryKey.map((column) => chip(column, 'violet'))));
    }
    if (detail.indexes.length > 0) {
      const line = h('div', { class: 'detail-line' }, h('span', { class: 'muted', text: 'Indexes' }));
      for (const index of detail.indexes) line.append(chip(`${index.name}${index.unique ? ' · unique' : ''}`, 'neutral'));
      host.append(line);
    }
    if (detail.foreignKeys.length > 0) {
      const line = h('div', { class: 'detail-line' }, h('span', { class: 'muted', text: 'Foreign keys' }));
      for (const fk of detail.foreignKeys) line.append(chip(`${fk.columns.join(', ')} → ${fk.references.table}(${fk.references.columns.join(', ')})`, 'neutral'));
      host.append(line);
    }
    if (detail.parameters.length > 0) {
      const line = h('div', { class: 'detail-line' }, h('span', { class: 'muted', text: 'Parameters' }));
      for (const parameter of detail.parameters) line.append(chip(`${parameter.name ?? '?'} ${parameter.type ?? ''}${parameter.mode ? ` (${parameter.mode})` : ''}`, 'neutral'));
      host.append(line);
    }
    if (detail.definition) {
      host.append(
        h(
          'details',
          { class: 'tool-details' },
          h('summary', { text: 'Definition' }),
          h('div', { class: 'code-block', style: 'max-height:280px;overflow:auto;margin-top:6px', text: detail.definition })
        )
      );
    }
  }

  function renderHistory(): void {
    if (historyLoading && historyEntries.length === 0) {
      sideBody.append(h('div', { class: 'side-empty' }, h('span', { class: 'spinner' }), ' Loading history…'));
      return;
    }
    if (historyError) {
      const retry = h('button', { class: 'btn small', text: 'Retry' });
      retry.addEventListener('click', () => void loadHistory());
      sideBody.append(h('div', { class: 'side-empty' }, h('div', { text: historyError }), retry));
      return;
    }

    const needle = historyFilter.trim().toLowerCase();
    const entries = needle
      ? historyEntries.filter((entry) => entry.sql.toLowerCase().includes(needle) || (entry.connection?.name ?? '').toLowerCase().includes(needle) || entry.status.includes(needle))
      : historyEntries;
    if (entries.length === 0) {
      sideBody.append(h('div', { class: 'side-empty' }, needle ? `No history matches "${historyFilter}".` : 'No queries yet for this connection.'));
      return;
    }

    for (const entry of entries.slice(0, 150)) {
      const row = h('button', { class: 'history-item', title: entry.sql });
      const top = h('div', { class: 'history-top' });
      top.append(statusBadge(entry.status), h('span', { class: 'grow' }), h('span', { class: 'muted', text: relativeTime(entry.ts) }));
      const sqlLine = h('div', { class: 'history-sql', text: firstLine(entry.sql, 120) });
      const bottom = h('div', { class: 'history-bottom' });
      appendChildren(bottom, [
        h('span', { class: 'muted', text: entry.connection?.name ?? 'unknown' }),
        entry.origin ? chip(entry.origin, 'ghost') : null,
        entry.durationMs !== undefined ? h('span', { class: 'muted', text: `${entry.durationMs} ms` }) : null
      ]);
      row.append(top, sqlLine, bottom);
      row.addEventListener('click', () => {
        const connectionId = connections.find((connection) => connection.name === entry.connection?.name)?.id ?? activeConnection()?.id ?? null;
        newTab(entry.sql, connectionId, { title: firstLine(entry.sql, 24) || 'History query' });
      });
      sideBody.append(row);
    }
  }

  function renderSaved(): void {
    if (savedQueries.length === 0) {
      sideBody.append(h('div', { class: 'side-empty' }, 'No saved queries yet. Save the current tab to keep it here.'));
      return;
    }
    for (const query of savedQueries) {
      const row = h('div', { class: 'saved-item' });
      const open = h('button', { class: 'saved-open', title: query.sql });
      open.append(h('b', { text: query.name }), h('span', { class: 'history-sql', text: firstLine(query.sql, 100) }));
      open.addEventListener('click', () => openSaved(query));
      const remove = h('button', { class: 'icon-btn danger', title: 'Delete saved query', 'aria-label': `Delete ${query.name}`, html: svgIcon('trash', 13) });
      remove.addEventListener('click', () => void deleteSaved(query));
      row.append(open, remove);
      sideBody.append(row);
    }
  }

  function openQuery(sql: string, connectionId: string | null, options: { title?: string; runNow?: boolean } = {}): void {
    newTab(sql, connectionId, options);
  }

  /* ---------- toolbar ---------- */

  const runBtn = h('button', { class: 'btn primary', title: 'Runs the selection if any, otherwise the whole editor' });
  runBtn.addEventListener('click', () => void run('smart'));

  const runSelectionBtn = h('button', { class: 'btn', title: 'Run only the selected SQL' }) as HTMLButtonElement;
  runSelectionBtn.innerHTML = `${svgIcon('play', 12)}<span>Selection</span>`;
  runSelectionBtn.addEventListener('click', () => void run('selection'));

  const explainBtn = h('button', { class: 'btn', title: 'Show the query plan (EXPLAIN)' });
  explainBtn.innerHTML = `${svgIcon('sparkle', 12)}<span>Explain</span>`;
  explainBtn.addEventListener('click', explain);

  const saveBtn = h('button', { class: 'icon-btn', title: 'Save this query', 'aria-label': 'Save this query', html: svgIcon('bookmark', 15) });
  saveBtn.addEventListener('click', saveCurrent);

  const copyBtn = h('button', { class: 'icon-btn', title: 'Copy SQL', html: svgIcon('copy', 15) });
  copyBtn.addEventListener('click', () => copyText(editorView?.state.doc.toString() ?? '', 'SQL copied'));

  const clearBtn = h('button', { class: 'icon-btn', title: 'Clear the editor', html: svgIcon('trash', 15) });
  clearBtn.addEventListener('click', () => {
    editorView?.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: '' } });
    const tab = activeTab();
    if (tab) {
      tab.result = null;
      tab.error = null;
      tab.status = 'idle';
      tab.lastMode = undefined;
    }
    renderResult();
    syncToolbar();
  });

  const collapseBtn = h('button', { class: 'icon-btn', title: 'Toggle object explorer', 'aria-label': 'Toggle object explorer', html: svgIcon('panelLeft', 15) });
  collapseBtn.addEventListener('click', () => {
    sideCollapsed = !sideCollapsed;
    workspace.classList.toggle('side-collapsed', sideCollapsed);
  });

  connectionSelect.addEventListener('change', () => {
    const tab = activeTab();
    if (!tab) return;
    tab.connectionId = connectionSelect.value || null;
    renderConnectionMeta();
    applyEditorLanguage();
    renderResult();
    syncToolbar();
    void ensureActiveSchema();
    void loadObjects(true);
    void loadHistory();
  });

  rowsInput.addEventListener('change', () => {
    activeRows = Math.min(Math.max(Number(rowsInput.value) || DEFAULT_ROWS, 1), 5000);
    rowsInput.value = String(activeRows);
  });

  /* ---------- layout ---------- */

  const workspace = h(
    'div',
    { class: 'sql-workspace' },
    h(
      'aside',
      { class: 'sql-side' },
      h('div', { class: 'side-head' }, h('b', { text: 'Explorer' }), h('span', { class: 'grow' }), chip('live', 'ok')),
      sideTabs,
      sideTools,
      sideBody
    ),
    h(
      'div',
      { class: 'sql-main' },
      tabsBar,
      h(
        'div',
        { class: 'card tight query-bar sql-toolbar' },
        h(
          'div',
          { class: 'query-bar-main' },
          collapseBtn,
          h('span', { class: 'query-bar-select' }, connectionSelect),
          h('span', { class: 'rows-wrap', title: 'Maximum rows returned per statement' }, h('span', { class: 'muted', text: 'Rows' }), rowsInput),
          h('span', { class: 'grow' }),
          saveBtn,
          explainBtn,
          runSelectionBtn,
          runBtn
        ),
        connectionMeta
      ),
      h(
        'div',
        { class: 'editor-card sql-editor-card' },
        h(
          'div',
          { class: 'editor-toolbar query-toolbar' },
          h('span', { text: 'SQL' }),
          h('span', { class: 'muted', text: 'Ctrl+Enter run · Ctrl+Shift+Enter selection' }),
          h('span', { class: 'grow' }),
          schemaState,
          copyBtn,
          clearBtn
        ),
        editorHost
      ),
      h('div', { class: 'sql-results' }, statusHost, resultHost)
    )
  );

  const el = h(
    'div',
    { class: 'sql-view' },
    crumb('WORK', 'SQL'),
    h('h1', { class: 'page-title', text: 'SQL workspace' }),
    h('p', {
      class: 'page-sub',
      html: 'Explore objects, write and run SQL, inspect plans, reuse history and export results. <b>Read-only connections block writes</b>; every run is logged.'
    }),
    workspace
  );

  editorView = mountSqlEditor(editorHost, {
    value: '',
    engine: 'postgres',
    minHeight: '210px',
    maxHeight: '46vh',
    placeholder: 'SELECT * FROM …    —    Ctrl+Enter to run',
    onChange: () => {
      if (suppressEditorChange) return;
      const tab = activeTab();
      if (tab) {
        tab.sql = editorView?.state.doc.toString() ?? '';
        saveBtn.disabled = !tab.sql.trim();
      }
    },
    onSelectionChange: () => {
      runSelectionBtn.disabled = !(editorView && hasSelection(editorView)) || running;
    },
    onRun: () => void run('smart'),
    onRunSelection: () => void run('selection')
  });

  /* ---------- keyboard shortcuts ---------- */

  el.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 't') {
      event.preventDefault();
      newTab('', activeConnection()?.id ?? connections[0]?.id ?? null);
    } else if (event.key.toLowerCase() === 'w') {
      event.preventDefault();
      const tab = activeTab();
      if (tab) closeTab(tab.id);
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveCurrent();
    }
  });

  /* ---------- boot ---------- */

  async function load(): Promise<void> {
    try {
      const payload = await ctx.engine.connections();
      connections = payload.connections;
    } catch (error) {
      toast((error as Error).message, 'error');
      connections = [];
    }

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
    }

    if (tabs.length === 0) {
      const preferred = connections.find((connection) => connection.enabled !== false) ?? connections[0] ?? null;
      const tab = makeTab('', preferred?.id ?? null, 'Query 1');
      tabs.push(tab);
      activeTabId = tab.id;
    } else {
      for (const tab of tabs) {
        if (tab.connectionId && !findConnection(tab.connectionId)) tab.connectionId = connections[0]?.id ?? null;
      }
    }

    renderTabs();
    syncEditorText();
    syncToolbar();
    renderConnectionMeta();
    renderResult();
    renderSide();
    applyEditorLanguage();
    void ensureActiveSchema();
    void loadObjects(true);
    void loadHistory();
  }

  void load();

  return {
    el,
    refresh: () => void load(),
    dispose: () => editorView?.destroy()
  };
}
