import { h, svgIcon, chip, engineDot, iconEl, toast, openModal, confirmDialog } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { Connection, ConnectionInput } from '../lib/engine';
import { pickOpenFile, pickSaveFile } from '../lib/tauri';

const ENGINE_LABELS: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mssql: 'SQL Server',
  sqlite: 'SQLite'
};

const ENGINE_PORTS: Record<string, number> = { postgres: 5432, mysql: 3306, mssql: 1433 };

function targetOf(connection: Connection): string {
  if (connection.engine === 'sqlite') return connection.file ?? '';
  return `${connection.host ?? ''}:${connection.port ?? ''}/${connection.database ?? ''}`;
}

export function createConnectionsView(ctx: AppContext): View {
  const listHost = h('div');
  const searchInput = h('input', { class: 'input', placeholder: 'Search connections…' }) as HTMLInputElement;
  let connections: Connection[] = [];
  let search = '';

  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLowerCase();
    renderList();
  });

  async function load(): Promise<void> {
    try {
      const payload = await ctx.engine.connections();
      connections = payload.connections;
    } catch (error) {
      toast(`Failed to load connections: ${(error as Error).message}`, 'error');
    }
    renderList();
  }

  function renderList(): void {
    listHost.replaceChildren();
    const filtered = connections.filter((connection) => {
      if (!search) return true;
      return `${connection.name} ${connection.engine} ${targetOf(connection)}`.toLowerCase().includes(search);
    });

    if (filtered.length === 0) {
      listHost.append(
        h('div', { class: 'empty' }, connections.length === 0 ? 'No connections yet — add your first database above.' : 'No connections match the search.')
      );
      return;
    }

    for (const connection of filtered) {
      listHost.append(renderConnectionCard(connection));
    }
  }

  function renderConnectionCard(connection: Connection): HTMLElement {
    const chips = h(
      'span',
      { class: 'row', style: 'gap:6px' },
      chip(ENGINE_LABELS[connection.engine] ?? connection.engine, 'neutral'),
      connection.readOnly ? chip('read-only', 'warn') : null,
      !connection.enabled ? chip('disabled', 'neutral') : null,
      connection.hasPassword ? null : chip('no password', 'ghost')
    );
    const dot = engineDot(connection.engine);

    const enabledToggle = h('span');
    {
      const input = h('input', { type: 'checkbox', class: 'toggle-input', checked: connection.enabled }) as HTMLInputElement;
      const label = h('label', { class: 'toggle', title: 'Enable / disable for MCP sessions' }, input, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' })));
      input.addEventListener('change', async () => {
        const next = input.checked;
        try {
          const payload = await ctx.engine.saveConnection({ ...(connection as unknown as ConnectionInput), enabled: next });
          Object.assign(connection, payload.connection);
          toast(next ? `"${connection.name}" enabled` : `"${connection.name}" disabled — agents can no longer use it`, 'ok');
          renderList();
        } catch (error) {
          input.checked = !next;
          toast((error as Error).message, 'error');
        }
      });
      enabledToggle.append(label);
    }

    const testBtn = h('button', { class: 'btn small' });
    testBtn.innerHTML = `${svgIcon('play', 12)}<span>Test</span>`;
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      const old = testBtn.innerHTML;
      testBtn.textContent = 'Testing…';
      try {
        const result = await ctx.engine.testConnection({ ...(connection as unknown as ConnectionInput) } as ConnectionInput);
        if (result.ok) {
          const version = (result.serverVersion ?? '').slice(0, 70);
          toast(`Connected in ${result.latencyMs ?? 0} ms — ${version}`, 'ok');
        } else {
          toast(`Connection failed: ${result.error ?? 'unknown error'}`, 'error');
        }
      } catch (error) {
        toast((error as Error).message, 'error');
      }
      testBtn.disabled = false;
      testBtn.innerHTML = old;
    });

    const editBtn = h('button', { class: 'icon-btn', title: 'Edit', html: svgIcon('pencil', 15) });
    editBtn.addEventListener('click', () => openEditor(connection));

    const deleteBtn = h('button', { class: 'icon-btn danger', title: 'Delete', html: svgIcon('trash', 15) });
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete the connection "${connection.name}"? Agents will lose access to it immediately.`, {
        title: 'Delete connection',
        confirmLabel: 'Delete',
        danger: true
      });
      if (!ok) return;
      try {
        await ctx.engine.deleteConnection(connection.id);
        toast('Connection deleted', 'ok');
        await load();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    });

    return h(
      'div',
      { class: 'card tight' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'engine-wrap', style: 'display:inline-flex;align-items:center;gap:8px' }, dot, h('span', { text: connection.name, style: 'font-weight:640;font-size:13.5px' })),
        h('span', { class: 'mono muted truncate grow', text: targetOf(connection) }),
        chips,
        h('span', { class: 'muted', text: connection.enabled ? 'Enabled' : 'Disabled', style: 'font-size:12px' }),
        enabledToggle,
        testBtn,
        editBtn,
        deleteBtn
      )
    );
  }

  function openEditor(existing: Connection | null): void {
    const draft: ConnectionInput = existing
      ? ({ ...(existing as unknown as ConnectionInput) } as ConnectionInput)
      : { name: '', engine: 'postgres', host: 'localhost', port: 5432, database: '', user: '', ssl: false, readOnly: false, enabled: true };
    if (existing) delete (draft as { password?: unknown }).password;

    const nameInput = h('input', { class: 'input', placeholder: 'staging-db', value: draft.name ?? '' }) as HTMLInputElement;
    const engineSelect = h('select', { class: 'input' }) as HTMLSelectElement;
    for (const [value, label] of Object.entries(ENGINE_LABELS)) {
      engineSelect.append(h('option', { value, text: label }));
    }
    engineSelect.value = draft.engine;

    const hostInput = h('input', { class: 'input', placeholder: 'localhost', value: draft.host ?? '' }) as HTMLInputElement;
    const portInput = h('input', { class: 'input', type: 'number', value: String(draft.port ?? ENGINE_PORTS[draft.engine] ?? '') }) as HTMLInputElement;
    const databaseInput = h('input', { class: 'input', placeholder: 'database name', value: draft.database ?? '' }) as HTMLInputElement;
    const userInput = h('input', { class: 'input', placeholder: 'user', value: draft.user ?? '' }) as HTMLInputElement;
    const passwordInput = h('input', {
      class: 'input',
      type: 'password',
      placeholder: existing?.hasPassword ? '•••••••• (leave empty to keep)' : 'password or ${ENV_VAR}'
    }) as HTMLInputElement;
    const fileInput = h('input', { class: 'input', placeholder: 'D:\\data\\app.db', value: draft.file ?? '' }) as HTMLInputElement;
    const sslCheck = h('input', { type: 'checkbox', checked: Boolean(draft.ssl) }) as HTMLInputElement;
    const readOnlyCheck = h('input', { type: 'checkbox', checked: Boolean(draft.readOnly) }) as HTMLInputElement;
    const enabledCheck = h('input', { type: 'checkbox', checked: draft.enabled !== false }) as HTMLInputElement;
    const timeoutInput = h('input', { class: 'input', type: 'number', value: String(draft.queryTimeoutMs ?? 30000) }) as HTMLInputElement;

    const networkFields = h(
      'div',
      null,
      h('div', { class: 'grid-2' }, h('div', null, h('label', { class: 'field-label', text: 'Host' }), hostInput), h('div', null, h('label', { class: 'field-label', text: 'Port' }), portInput)),
      h('div', { class: 'grid-2' }, h('div', null, h('label', { class: 'field-label', text: 'Database' }), databaseInput), h('div', null, h('label', { class: 'field-label', text: 'User' }), userInput)),
      h('label', { class: 'field-label', text: 'Password' }),
      passwordInput
    );
    const sqliteFields = h('div', null, h('label', { class: 'field-label', text: 'SQLite file' }), fileInput);

    function syncEngineFields(): void {
      const engine = engineSelect.value;
      networkFields.classList.toggle('hidden', engine === 'sqlite');
      sqliteFields.classList.toggle('hidden', engine !== 'sqlite');
      if (ENGINE_PORTS[engine] && (!portInput.value || Number(portInput.value) === ENGINE_PORTS[draft.engine as string])) {
        portInput.value = String(ENGINE_PORTS[engine]);
        draft.engine = engine;
      }
    }
    engineSelect.addEventListener('change', syncEngineFields);
    syncEngineFields();

    function collect(): ConnectionInput {
      const input: ConnectionInput = {
        name: nameInput.value.trim(),
        engine: engineSelect.value,
        ssl: sslCheck.checked,
        readOnly: readOnlyCheck.checked,
        enabled: enabledCheck.checked,
        queryTimeoutMs: Number(timeoutInput.value) || 30000
      };
      if (existing) input.id = existing.id;
      if (engineSelect.value === 'sqlite') {
        input.file = fileInput.value.trim();
      } else {
        input.host = hostInput.value.trim();
        input.port = Number(portInput.value) || ENGINE_PORTS[engineSelect.value];
        input.database = databaseInput.value.trim();
        input.user = userInput.value.trim();
        if (passwordInput.value) input.password = passwordInput.value;
      }
      return input;
    }

    const testResult = h('div', { class: 'muted', style: 'margin-right:auto' });
    const testBtn = h('button', { class: 'btn' });
    testBtn.innerHTML = `${svgIcon('play', 13)}<span>Test</span>`;

    const saveBtn = h('button', { class: 'btn primary', text: existing ? 'Save changes' : 'Add connection' });
    const cancelBtn = h('button', { class: 'btn', text: 'Cancel' });

    const body = h(
      'div',
      null,
      h('div', { class: 'grid-2' }, h('div', null, h('label', { class: 'field-label', text: 'Name' }), nameInput), h('div', null, h('label', { class: 'field-label', text: 'Engine' }), engineSelect)),
      networkFields,
      sqliteFields,
      h(
        'div',
        { class: 'row', style: 'margin-top:16px;gap:16px' },
        h('label', { class: 'check-line' }, sslCheck, 'SSL / encrypt'),
        h('label', { class: 'check-line' }, readOnlyCheck, 'Read-only (block writes)'),
        h('label', { class: 'check-line' }, enabledCheck, 'Enabled for agents')
      ),
      h('label', { class: 'field-label', text: 'Query timeout (ms)' }),
      timeoutInput,
      h('p', { class: 'muted', style: 'margin-top:10px' }, 'Tip: use ${ENV_VAR} in host/database/user/password to keep secrets out of the config file.')
    );

    const modal = openModal({
      title: existing ? `Edit "${existing.name}"` : 'Add a connection',
      subtitle: existing ? 'Leave the password empty to keep the saved one.' : 'PostgreSQL, MySQL, SQL Server or SQLite.',
      body,
      width: 600,
      footer: h('div', { class: 'row' }, testResult, cancelBtn, testBtn, saveBtn)
    });

    cancelBtn.addEventListener('click', () => modal.close());
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      const old = testBtn.innerHTML;
      testBtn.textContent = 'Testing…';
      testResult.textContent = '';
      try {
        const result = await ctx.engine.testConnection(collect());
        if (result.ok) {
          testResult.textContent = `Connected · ${result.latencyMs ?? 0} ms · ${(result.serverVersion ?? '').slice(0, 40)}`;
          testResult.style.color = 'var(--ok)';
        } else {
          testResult.textContent = result.error ?? 'Connection failed';
          testResult.style.color = 'var(--err)';
        }
      } catch (error) {
        testResult.textContent = (error as Error).message;
        testResult.style.color = 'var(--err)';
      }
      testBtn.disabled = false;
      testBtn.innerHTML = old;
    });
    saveBtn.addEventListener('click', async () => {
      try {
        const payload = await ctx.engine.saveConnection(collect());
        toast(existing ? 'Connection updated' : `Connection "${payload.connection.name}" added`, 'ok');
        modal.close();
        await load();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    });
  }

  /* ---------- import / export (connections .json) ---------- */

  function openExportModal(): void {
    const passwordsCheck = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const body = h(
      'div',
      null,
      h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Export all connections to one .json file you can move between machines.'),
      h('label', { class: 'check-line' }, passwordsCheck, 'Include passwords (plaintext — only for a trusted destination)')
    );
    const cancel = h('button', { class: 'btn', text: 'Cancel' });
    const save = h('button', { class: 'btn primary', text: 'Export .json…' });
    const modal = openModal({ title: 'Export connections', body, width: 480, footer: h('div', { class: 'row-end' }, cancel, save) });
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', async () => {
      const path = await pickSaveFile(`lazy-sql-connections-${new Date().toISOString().slice(0, 10)}.json`);
      if (!path) return;
      try {
        const result = await ctx.engine.exportConnections(path, passwordsCheck.checked);
        toast(`Exported ${result.connections} connection(s)`, 'ok');
        modal.close();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    });
  }

  function openImportModal(): void {
    const fileLabel = h('div', { class: 'muted mono', text: 'No file selected' });
    let filePath: string | null = null;

    const modeRadios = ['skip', 'overwrite', 'rename'].map((mode) => {
      const input = h('input', { type: 'radio', name: 'import-mode' }) as HTMLInputElement;
      input.value = mode;
      if (mode === 'skip') input.checked = true;
      const labels: Record<string, string> = {
        skip: 'Skip existing names',
        overwrite: 'Overwrite existing connections',
        rename: 'Keep both (rename imported)'
      };
      return h('label', { class: 'check-line', style: 'margin-top:8px' }, input, labels[mode]);
    });

    const passwordsCheck = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;

    const chooseBtn = h('button', { class: 'btn' });
    chooseBtn.innerHTML = `${svgIcon('folder', 13)}<span>Choose .json…</span>`;
    chooseBtn.addEventListener('click', async () => {
      const path = await pickOpenFile();
      if (!path) return;
      filePath = path;
      fileLabel.textContent = path;
    });

    const body = h(
      'div',
      null,
      h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Import connections from a LAZY SQL .json export.'),
      h('div', { class: 'row' }, chooseBtn, fileLabel),
      h('label', { class: 'field-label', text: 'When a connection name already exists' }),
      ...modeRadios,
      h('label', { class: 'check-line', style: 'margin-top:14px' }, passwordsCheck, 'Import passwords when present')
    );

    const cancel = h('button', { class: 'btn', text: 'Cancel' });
    const run = h('button', { class: 'btn primary', text: 'Import' });
    const modal = openModal({ title: 'Import connections', body, width: 520, footer: h('div', { class: 'row-end' }, cancel, run) });

    cancel.addEventListener('click', () => modal.close());
    run.addEventListener('click', async () => {
      if (!filePath) {
        toast('Choose a .json file first', 'error');
        return;
      }
      const mode = (modeRadios.map((label) => label.querySelector('input')).find((input) => input?.checked) as HTMLInputElement | undefined)?.value ?? 'skip';
      try {
        const { summary } = await ctx.engine.importConnections(filePath, mode, passwordsCheck.checked);
        const parts = [
          summary.imported ? `${summary.imported} imported` : '',
          summary.overwritten ? `${summary.overwritten} overwritten` : '',
          summary.renamed ? `${summary.renamed} renamed` : '',
          summary.skipped ? `${summary.skipped} skipped` : ''
        ].filter(Boolean);
        toast(`Import complete: ${parts.join(', ') || 'nothing to do'}${summary.errors.length ? ` — ${summary.errors.length} error(s)` : ''}`, summary.errors.length ? 'error' : 'ok');
        if (summary.errors.length) console.warn('Import errors', summary.errors);
        modal.close();
        await load();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    });
  }

  /* ---------- page ---------- */

  const addBtn = h('button', { class: 'btn small' });
  addBtn.innerHTML = `${svgIcon('plus', 13)}<span>Add connection</span>`;
  addBtn.addEventListener('click', () => openEditor(null));

  const importBtn = h('button', { class: 'btn' });
  importBtn.innerHTML = `${svgIcon('upload', 13)}<span>Import</span>`;
  importBtn.addEventListener('click', openImportModal);

  const exportBtn = h('button', { class: 'btn' });
  exportBtn.innerHTML = `${svgIcon('download', 13)}<span>Export</span>`;
  exportBtn.addEventListener('click', openExportModal);

  const el = h(
    'div',
    null,
    crumb('SET UP', 'Connections'),
    h('h1', { class: 'page-title', text: 'Connections' }),
    h('p', {
      class: 'page-sub',
      html: 'Databases the AI agents can reach. Import/export moves them as a single <b>.json</b> file.'
    }),
    h(
      'div',
      { class: 'row', style: 'margin-bottom:6px' },
      h('span', { class: 'search-box grow', style: 'max-width:320px' }, iconEl('search', 14), searchInput),
      h('span', { class: 'grow' }),
      importBtn,
      exportBtn
    ),
    h('div', { class: 'section-head' }, h('h2', { class: 'section-title', text: 'Databases' }), h('span', { class: 'grow' }), addBtn),
    listHost
  );

  void load();

  return {
    el,
    refresh: () => {
      void load();
    },
    dispose: () => undefined
  };
}
