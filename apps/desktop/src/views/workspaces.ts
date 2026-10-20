import { h, svgIcon, chip, toast, openModal, confirmDialog, copyText, engineDot, appendChildren } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { WorkspaceScan, WorkspaceToolState } from '../lib/engine';

// a registration that is really in effect: present, switched on and readable
function isActive(tool: WorkspaceToolState | undefined): boolean {
  return Boolean(tool && tool.registered && tool.enabled && !tool.parseError);
}

function describeConnections(connections: string[] | null, forceReadOnly: boolean): string {
  const base = connections === null ? 'all connections' : `${connections.length} connection${connections.length === 1 ? '' : 's'}`;
  return forceReadOnly ? `${base}, force read-only` : base;
}

export function createWorkspacesView(ctx: AppContext): View {
  let scan: WorkspaceScan | null = null;
  const expanded = new Set<string>();
  // tools whose registration changed in this session: they only read MCP settings when they start
  const restartNeeded = new Set<string>();
  const container = h('div');
  const listHost = h('div');
  let filterText = '';

  const filterInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter tools…',
    'aria-label': 'Filter AI tools'
  }) as HTMLInputElement;
  filterInput.addEventListener('input', () => {
    filterText = filterInput.value;
    renderToolList();
  });

  // Saved selections hold connection ids (or names from older registrations); null means "all connections".
  function restoreConnections(saved: string[] | null): string[] | null {
    if (saved === null) return null;
    const known = scan?.connections ?? [];
    const ids: string[] = [];
    for (const token of saved) {
      const match = known.find((connection) => connection.id === token || connection.name.toLowerCase() === String(token).toLowerCase());
      if (match && !ids.includes(match.id)) ids.push(match.id);
    }
    return ids;
  }

  function applySettings(body: Record<string, unknown>, successMessage: string): void {
    container.classList.add('is-busy');
    ctx.engine
      .workspaceAction(body)
      .then((payload) => {
        scan = payload.scan;
        const result = payload.result as { ok?: boolean; changed?: boolean; reason?: string; message?: string; file?: string; snippet?: string } | undefined;
        if (result && result.ok === false) {
          showSnippetModal(result.message ?? 'The config file could not be edited automatically.', result.file ?? '', result.snippet ?? '');
          render();
          return;
        }
        if (body.action === 'apply' && result?.changed !== false) {
          const toolLabel = scan.tools[String(body.tool)]?.label;
          if (toolLabel) restartNeeded.add(toolLabel);
        }
        toast(result?.changed === false && result.reason ? result.reason : successMessage, 'ok');
        render();
      })
      .catch((error) => {
        toast((error as Error).message, 'error');
        render(); // put every control back to what is really on disk
      })
      .finally(() => container.classList.remove('is-busy'));
  }

  function showSnippetModal(message: string, file: string, snippet: string): void {
    const body = h(
      'div',
      null,
      h('p', { class: 'muted', style: 'margin:0 0 10px' }, message),
      file ? h('div', { class: 'mono muted', style: 'margin-bottom:8px;word-break:break-all' }, file) : null,
      h('div', { class: 'code-block', text: snippet })
    );
    const copyBtn = h('button', { class: 'btn primary', text: 'Copy snippet' });
    const closeBtn = h('button', { class: 'btn', text: 'Close' });
    const modal = openModal({ title: 'Manual registration needed', body, width: 560, footer: h('div', { class: 'row-end' }, closeBtn, copyBtn) });
    closeBtn.addEventListener('click', () => modal.close());
    copyBtn.addEventListener('click', () => copyText(snippet, 'Snippet copied'));
  }

  function statusChipFor(tool: WorkspaceToolState): HTMLElement {
    if (tool.parseError) {
      const parseChip = chip('Not editable', 'warn');
      parseChip.title = tool.error ?? 'The config file could not be parsed — LAZY SQL will show a snippet to paste instead.';
      return parseChip;
    }
    if (!tool.registered) return chip('Not registered', 'ghost');
    if (tool.needsUpdate) return chip('Needs update', 'violet');
    if (!tool.enabled) return chip('Turned off', 'neutral');
    return chip('Registered', 'ok');
  }

  /* ---------- tool row ---------- */

  function renderToolRow(toolKey: string, label: string, tool: WorkspaceToolState): HTMLElement {
    const key = `user:${toolKey}`;
    const active = isActive(tool);
    const isOpen = active && expanded.has(key);

    const restoreHint = !tool.registered && tool.desired ? ` (restores: ${describeConnections(tool.desired.connections, tool.desired.forceReadOnly)})` : '';
    const toggleInput = h('input', {
      type: 'checkbox',
      class: 'toggle-input',
      checked: active,
      'aria-label': `LAZY SQL in ${label}`
    }) as HTMLInputElement;
    const toggle = h(
      'label',
      { class: 'toggle', title: active ? `Remove LAZY SQL from ${label}` : `Register LAZY SQL in ${label}${restoreHint}` },
      toggleInput,
      h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' }))
    );
    toggleInput.addEventListener('change', () => {
      const next = toggleInput.checked;
      let connections = tool.connections;
      let forceReadOnly = tool.forceReadOnly;
      if (next && !tool.registered && tool.desired) {
        // Turning a tool back on re-applies what was chosen for it before; it never silently falls back to "all".
        forceReadOnly = tool.desired.forceReadOnly;
        connections = restoreConnections(tool.desired.connections);
        if (connections !== null && connections.length === 0) {
          // Nothing left to restore (connections were deleted, or an older version saved an empty list). Widening to
          // "all connections" must be a conscious choice, so ask instead of doing it silently or leaving no way forward.
          toggleInput.checked = false;
          const restoredForce = forceReadOnly;
          void confirmDialog(
            `The connections previously chosen for ${label} no longer exist. Register it for all connections instead? You can narrow it down afterwards with Configure.`,
            { title: 'Saved connections not found', confirmLabel: 'Register for all connections', danger: true }
          ).then((ok) => {
            if (!ok) return;
            applySettings(
              { action: 'apply', scopeType: 'user', scopePath: null, tool: toolKey, enabled: true, connections: null, forceReadOnly: restoredForce },
              `LAZY SQL registered in ${label}`
            );
          });
          return;
        }
      }
      if (next && connections !== null && connections.length === 0) {
        // A registration written by an older build can hold an allow-list whose connections are gone.
        toggleInput.checked = false;
        const keptForceReadOnly = forceReadOnly;
        void confirmDialog(
          `The saved connection scope for ${label} is empty. Register it for all connections instead? You can narrow it down afterwards with Configure.`,
          { title: 'Empty connection scope', confirmLabel: 'Register for all connections', danger: true }
        ).then((ok) => {
          if (!ok) return;
          applySettings(
            { action: 'apply', scopeType: 'user', scopePath: null, tool: toolKey, enabled: true, connections: null, forceReadOnly: keptForceReadOnly },
            `LAZY SQL registered in ${label}`
          );
        });
        return;
      }
      applySettings(
        { action: 'apply', scopeType: 'user', scopePath: null, tool: toolKey, enabled: next, connections, forceReadOnly },
        next ? `LAZY SQL registered in ${label}` : `LAZY SQL removed from ${label}`
      );
    });

    const chips: (HTMLElement | null)[] = [statusChipFor(tool)];
    if (tool.registered) {
      chips.push(chip(tool.connections ? `${tool.connections.length} selected` : 'All connections', tool.connections && tool.connections.length === 0 ? 'warn' : 'neutral'));
      if ((tool.unknownConnections?.length ?? 0) > 0) chips.push(chip(`${tool.unknownConnections.length} missing`, 'warn'));
      if (tool.forceReadOnly) chips.push(chip('force read-only', 'warn'));
    }

    const actions: HTMLElement[] = [];
    if (tool.registered && tool.needsUpdate && !tool.parseError) {
      const updateBtn = h('button', {
        class: 'btn small primary',
        text: 'Update',
        title: `Point this registration at the engine of this app${tool.registeredEntry ? ` (now: ${tool.registeredEntry})` : ''}`
      });
      updateBtn.addEventListener('click', () => {
        const applyUpdate = (connections: string[] | null): void => {
          applySettings(
            { action: 'apply', scopeType: 'user', scopePath: null, tool: toolKey, enabled: true, connections, forceReadOnly: tool.forceReadOnly },
            `${label} registration updated`
          );
        };
        if (tool.connections !== null && tool.connections.length === 0) {
          void confirmDialog(
            `The saved connection scope for ${label} is empty. Update it to allow all connections? You can narrow it down afterwards with Configure.`,
            { title: 'Empty connection scope', confirmLabel: 'Allow all connections', danger: true }
          ).then((ok) => {
            if (ok) applyUpdate(null);
          });
          return;
        }
        applyUpdate(tool.connections);
      });
      actions.push(updateBtn);
    }
    if (active) {
      const configBtn = h('button', {
        class: 'btn small',
        title: 'Choose which connections this entry may use',
        'aria-label': `Configure ${label}`,
        'aria-expanded': String(isOpen)
      });
      configBtn.innerHTML = `<span>Configure</span>${svgIcon(isOpen ? 'chevronDown' : 'chevronRight', 13)}`;
      configBtn.addEventListener('click', () => {
        if (isOpen) expanded.delete(key);
        else expanded.add(key);
        render();
      });
      actions.push(configBtn);
    }

    const row = h(
      'div',
      { class: `tool-row${active ? ' is-active' : ''}` },
      h('span', { class: 'tool-name', title: tool.configPath, text: label }),
      h('span', { class: 'tool-status grow' }, ...chips),
      ...actions,
      toggle
    );

    const wrap = h('div', null, row);
    if (isOpen) wrap.append(renderToolPanel(toolKey, tool));
    return wrap;
  }

  /* ---------- configure panel ---------- */

  function renderToolPanel(toolKey: string, tool: WorkspaceToolState): HTMLElement {
    const panel = h('div', { class: 'tool-panel' });

    const connections = scan?.connections ?? [];
    const allowAll = tool.connections === null;
    const selected = new Set(tool.connections ?? []);
    const unknown = tool.unknownConnections ?? [];

    // Every change is computed from the state this panel was rendered with (never read back from the DOM)
    // and re-renders from the engine's answer, so what is shown is always what is written.
    function apply(next: string[] | null, forceReadOnly: boolean, message: string): void {
      applySettings(
        { action: 'apply', scopeType: 'user', scopePath: null, tool: toolKey, enabled: true, connections: next, forceReadOnly },
        message
      );
    }

    const radioName = `mode-${toolKey}`;
    const allRadio = h('input', { type: 'radio', name: radioName, checked: allowAll }) as HTMLInputElement;
    const someRadio = h('input', { type: 'radio', name: radioName, checked: !allowAll, disabled: connections.length === 0 }) as HTMLInputElement;

    allRadio.addEventListener('change', () => apply(null, tool.forceReadOnly, 'Scope updated — all connections allowed'));
    // "Only selected" starts from everything allowed today, so the list is never empty; untick what to exclude.
    someRadio.addEventListener('change', () => apply(connections.map((connection) => connection.id), tool.forceReadOnly, 'Scope updated — only the selected connections'));

    const connGrid = h('div', { class: 'conn-grid' });
    for (const connection of connections) {
      const checkbox = h('input', {
        type: 'checkbox',
        checked: allowAll || selected.has(connection.id),
        disabled: allowAll
      }) as HTMLInputElement;
      checkbox.addEventListener('change', () => {
        const next = connections.filter((entry) => (entry.id === connection.id ? checkbox.checked : selected.has(entry.id))).map((entry) => entry.id);
        if (next.length === 0) {
          checkbox.checked = true;
          toast('Select at least one connection, or choose "All connections".', 'error');
          return;
        }
        apply(next, tool.forceReadOnly, 'Connection scope updated');
      });
      const line = h('label', { class: 'check-line' }, checkbox, engineDot(connection.engine), connection.name);
      if (!connection.enabled) line.style.opacity = '0.55';
      if (connection.readOnly) line.append(chip('ro', 'warn'));
      connGrid.append(line);
    }
    if (connections.length === 0) {
      connGrid.append(h('span', { class: 'muted', text: 'No connections configured yet.' }));
    }

    const forceToggleInput = h('input', { type: 'checkbox', class: 'toggle-input', checked: tool.forceReadOnly, 'aria-label': 'Force read-only mode' }) as HTMLInputElement;
    const forceToggle = h(
      'label',
      { class: 'toggle' },
      forceToggleInput,
      h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' }))
    );
    forceToggleInput.addEventListener('change', () =>
      apply(tool.connections, forceToggleInput.checked, forceToggleInput.checked ? 'Forced read-only mode enabled' : 'Forced read-only mode disabled')
    );

    panel.append(
      h('div', { class: 'muted', text: 'Connections this entry may use' }),
      h(
        'div',
        { class: 'row', style: 'margin-top:8px;gap:18px' },
        h('label', { class: 'check-line' }, allRadio, 'All connections (current & future)'),
        h('label', { class: 'check-line' }, someRadio, 'Only selected')
      )
    );

    if (unknown.length > 0) {
      const nothingAllowed = !allowAll && (tool.connections?.length ?? 0) === 0;
      const cleanBtn = tool.connections && tool.connections.length > 0 ? h('button', { class: 'btn small', text: 'Remove' }) : null;
      cleanBtn?.addEventListener('click', () => apply(tool.connections, tool.forceReadOnly, 'Removed entries that matched no connection'));
      panel.append(
        h(
          'div',
          { class: 'row', style: 'margin-top:10px;align-items:flex-start' },
          h('span', { html: svgIcon('alert', 14), style: 'color:var(--warn);display:inline-flex;margin-top:2px' }),
          h('span', {
            class: 'grow muted',
            text: `${unknown.length === 1 ? '1 saved entry matches' : `${unknown.length} saved entries match`} no connection and ${unknown.length === 1 ? 'is' : 'are'} ignored (${unknown.join(', ')}).${
              nothingAllowed ? ' Nothing is allowed here until you pick connections below or choose "All connections".' : ''
            }`
          }),
          cleanBtn
        )
      );
    }

    const copyPathBtn = h('button', { class: 'icon-btn', title: 'Copy path', 'aria-label': 'Copy config file path', html: svgIcon('copy', 14) });
    copyPathBtn.addEventListener('click', () => copyText(tool.configPath, 'Path copied'));

    panel.append(
      connGrid,
      h(
        'div',
        { class: 'row', style: 'margin-top:14px;gap:12px' },
        h('span', { class: 'grow' }, h('b', { text: 'Force read-only mode', style: 'font-size:12.5px' }), h('div', { class: 'muted', text: 'Block every write for this entry (e.g. production).' })),
        forceToggle
      ),
      h(
        'details',
        { class: 'tool-details' },
        h('summary', { text: 'Details' }),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'muted', text: 'Config file' }), h('span', { class: 'mono grow truncate', title: tool.configPath, text: tool.configPath }), copyPathBtn)
      )
    );
    return panel;
  }

  /* ---------- page chrome ---------- */

  function renderRestartNotice(): HTMLElement | null {
    if (restartNeeded.size === 0) return null;
    const names = [...restartNeeded].join(', ');
    const dismiss = h('button', { class: 'btn small', text: 'Got it' });
    dismiss.addEventListener('click', () => {
      restartNeeded.clear();
      render();
    });
    return h(
      'div',
      { class: 'notice', role: 'status' },
      h('span', { class: 'notice-icon', html: svgIcon('refresh', 16) }),
      h(
        'div',
        { class: 'grow' },
        h('b', { text: `Restart ${names} to apply the change` }),
        h('div', { class: 'muted', text: 'AI tools read their MCP settings when they start, so a session that is already open keeps the old setup.' })
      ),
      dismiss
    );
  }

  function renderAdvanced(): HTMLElement | null {
    if (!scan) return null;
    return h(
      'details',
      { class: 'advanced' },
      h('summary', { text: 'Advanced — how registration works' }),
      h('p', {
        class: 'card-sub',
        html: `Turning a tool on writes an entry named <b>${scan.mcpName}</b> into that tool's MCP config and runs <span class="mono">node ${scan.engineEntry}</span>. The connection scope is saved as <b>LAZY_SQL_ALLOWED_CONNECTIONS</b> (connection ids, so renaming a connection never changes who can use it) and force read-only as <b>LAZY_SQL_FORCE_READ_ONLY</b>.`
      }),
      h('p', {
        class: 'card-sub',
        html: 'Only that entry is edited — comments, order and formatting of the rest of the file stay as they are (JSON/JSONC and Codex TOML). The first time LAZY SQL changes a file, the original is kept next to it as <span class="mono">&lt;file&gt;.lazy-sql-backup</span> and never overwritten.'
      })
    );
  }

  function renderToolList(): void {
    listHost.replaceChildren();
    if (!scan) return;

    const needle = filterText.trim().toLowerCase();
    const entries = Object.entries(scan.user).filter(([key, tool]) => {
      if (!needle) return true;
      return (scan?.tools[key]?.label ?? key).toLowerCase().includes(needle);
    });
    const activeCount = entries.filter(([, tool]) => isActive(tool)).length;

    if (entries.length === 0) {
      listHost.append(h('div', { class: 'empty' }, `No AI tools match "${filterInput.value}".`));
      return;
    }

    const card = h(
      'div',
      { class: 'scope-card' },
      h(
        'div',
        { class: 'scope-head' },
        h('span', { class: 'scope-icon', html: svgIcon('grid', 16) }),
        h('b', { class: 'scope-title', text: 'Your AI tools' }),
        h('span', { class: 'scope-sub grow truncate', text: 'Applies to every project on this machine' }),
        chip(`${activeCount} of ${entries.length} on`, activeCount > 0 ? 'ok' : 'ghost')
      )
    );
    for (const [toolKey, tool] of entries) {
      card.append(renderToolRow(toolKey, scan.tools[toolKey]?.label ?? toolKey, tool));
    }
    listHost.append(card);
  }

  function render(): void {
    const wasFocused = document.activeElement === filterInput;
    container.replaceChildren();
    if (!scan) {
      container.append(h('div', { class: 'muted', text: 'Loading…' }));
      return;
    }

    appendChildren(container, [
      crumb('SET UP', 'AI tools'),
      h('h1', { class: 'page-title', text: 'AI tools' }),
      h('p', {
        class: 'page-sub',
        text: 'Let your AI coding tools use LAZY SQL. Turn a tool on once for your user account — it then works in every project, with the connections you choose.'
      }),
      h('div', { class: 'row', style: 'margin-bottom:14px;gap:10px' }, h('span', { class: 'search-box grow' }, h('span', { class: 'icon-wrap', html: svgIcon('search', 14) }), filterInput)),
      renderRestartNotice(),
      listHost,
      renderAdvanced()
    ]);
    renderToolList();
    if (wasFocused) {
      filterInput.focus();
      filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
    }
  }

  ctx.engine
    .workspaces()
    .then((payload) => {
      scan = payload;
      render();
    })
    .catch((error) => {
      container.replaceChildren(h('div', { class: 'empty', text: (error as Error).message }));
    });

  return {
    el: container,
    refresh: () =>
      void ctx.engine.workspaces().then((payload) => {
        scan = payload;
        render();
      })
  };
}
