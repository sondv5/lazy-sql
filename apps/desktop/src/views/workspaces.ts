import { h, svgIcon, chip, toast, openModal, confirmDialog, copyText, engineDot, appendChildren } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { WorkspaceScan, WorkspaceToolState } from '../lib/engine';
import { pickFolder } from '../lib/tauri';

type ScopeType = 'user' | 'workspace';

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

  function renderToolRow(scopeType: ScopeType, scopePath: string | null, toolKey: string, label: string, tool: WorkspaceToolState): HTMLElement {
    const key = `${scopeType}:${scopePath ?? 'user'}:${toolKey}`;
    const active = isActive(tool);
    const isOpen = active && expanded.has(key);

    const globalTool = scopeType === 'workspace' ? scan?.user[toolKey] : undefined;
    const alsoGlobal = scopeType === 'workspace' && active && isActive(globalTool);
    const overriddenIn = scopeType === 'user' && active ? (scan?.workspaces.filter((workspace) => isActive(workspace.tools[toolKey])).length ?? 0) : 0;

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
              { action: 'apply', scopeType, scopePath, tool: toolKey, enabled: true, connections: null, forceReadOnly: restoredForce },
              `LAZY SQL registered in ${label}`
            );
          });
          return;
        }
      }
      applySettings(
        { action: 'apply', scopeType, scopePath, tool: toolKey, enabled: next, connections, forceReadOnly },
        next ? `LAZY SQL registered in ${label}` : `LAZY SQL removed from ${label}`
      );
    });

    const chips: (HTMLElement | null)[] = [statusChipFor(tool)];
    if (tool.registered) {
      chips.push(chip(tool.connections ? `${tool.connections.length} selected` : 'All connections', tool.connections && tool.connections.length === 0 ? 'warn' : 'neutral'));
      if ((tool.unknownConnections?.length ?? 0) > 0) chips.push(chip(`${tool.unknownConnections.length} missing`, 'warn'));
      if (tool.forceReadOnly) chips.push(chip('force read-only', 'warn'));
    }
    if (alsoGlobal) {
      const dup = chip('Also in All projects', 'warn');
      dup.title = 'Registered here and for all projects. Open Configure for details.';
      chips.push(dup);
    }
    if (overriddenIn > 0) {
      const over = chip(`Overridden in ${overriddenIn} project${overriddenIn === 1 ? '' : 's'}`, 'ghost');
      over.title = 'Those project folders have their own registration, which usually takes precedence.';
      chips.push(over);
    }

    const actions: HTMLElement[] = [];
    if (tool.registered && tool.needsUpdate && !tool.parseError) {
      const updateBtn = h('button', {
        class: 'btn small primary',
        text: 'Update',
        title: `Point this registration at the engine of this app${tool.registeredEntry ? ` (now: ${tool.registeredEntry})` : ''}`
      });
      updateBtn.addEventListener('click', () => {
        applySettings(
          { action: 'apply', scopeType, scopePath, tool: toolKey, enabled: true, connections: tool.connections, forceReadOnly: tool.forceReadOnly },
          `${label} registration updated`
        );
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
    if (isOpen) wrap.append(renderToolPanel(scopeType, scopePath, toolKey, tool));
    return wrap;
  }

  /* ---------- configure panel ---------- */

  function renderToolPanel(scopeType: ScopeType, scopePath: string | null, toolKey: string, tool: WorkspaceToolState): HTMLElement {
    const panel = h('div', { class: 'tool-panel' });

    const globalTool = scopeType === 'workspace' ? scan?.user[toolKey] : undefined;
    if (globalTool && isActive(globalTool)) {
      panel.append(
        h(
          'div',
          { class: 'row', style: 'margin-bottom:12px;align-items:flex-start' },
          h('span', { html: svgIcon('alert', 14), style: 'color:var(--warn);display:inline-flex;margin-top:2px' }),
          h(
            'span',
            { class: 'grow muted' },
            h('b', { text: 'Also registered for all projects. ' }),
            `Most tools let the project entry win, so this one applies here. All projects: ${describeConnections(globalTool.connections, globalTool.forceReadOnly)} · This project: ${describeConnections(tool.connections, tool.forceReadOnly)}. Turn one of them off if that is not what you want.`
          )
        )
      );
    }

    const connections = scan?.connections ?? [];
    const allowAll = tool.connections === null;
    const selected = new Set(tool.connections ?? []);
    const unknown = tool.unknownConnections ?? [];

    // Every change is computed from the state this panel was rendered with (never read back from the DOM)
    // and re-renders from the engine's answer, so what is shown is always what is written.
    function apply(next: string[] | null, forceReadOnly: boolean, message: string): void {
      applySettings(
        { action: 'apply', scopeType, scopePath, tool: toolKey, enabled: true, connections: next, forceReadOnly },
        message
      );
    }

    const radioName = `mode-${toolKey}-${scopePath ?? 'u'}`;
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
      apply(tool.connections, forceToggleInput.checked, forceToggleInput.checked ? 'Forced read-only mode enabled for this scope' : 'Forced read-only mode disabled')
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

  /* ---------- scope cards ---------- */

  interface ScopeCardOptions {
    scopeType: ScopeType;
    scopePath: string | null;
    icon: string;
    title: string;
    subtitle: string;
    subtitleTitle?: string;
    tools: Record<string, WorkspaceToolState>;
    missing?: boolean;
    actions?: HTMLElement[];
  }

  function renderScopeCard(options: ScopeCardOptions): HTMLElement {
    const entries = Object.entries(options.tools);
    const activeCount = entries.filter(([, tool]) => isActive(tool)).length;
    const head = h(
      'div',
      { class: 'scope-head' },
      h('span', { class: 'scope-icon', html: svgIcon(options.icon, 16) }),
      h('b', { class: 'scope-title', text: options.title }),
      h('span', { class: 'scope-sub grow truncate', title: options.subtitleTitle ?? options.subtitle, text: options.subtitle }),
      options.missing ? chip('folder missing', 'err') : null,
      chip(`${activeCount} of ${entries.length} active`, activeCount > 0 ? 'ok' : 'ghost'),
      ...(options.actions ?? [])
    );
    const card = h('div', { class: 'scope-card' }, head);
    for (const [toolKey, tool] of entries) {
      card.append(renderToolRow(options.scopeType, options.scopePath, toolKey, scan?.tools[toolKey]?.label ?? toolKey, tool));
    }
    return card;
  }

  function renderUserScope(): HTMLElement | null {
    if (!scan) return null;
    return renderScopeCard({
      scopeType: 'user',
      scopePath: null,
      icon: 'grid',
      title: 'All projects',
      subtitle: 'Applies everywhere, unless a project folder has its own entry',
      tools: scan.user
    });
  }

  function renderWorkspacesSection(): HTMLElement {
    const section = h('div');
    if (!scan) return section;

    const addBtn = h('button', { class: 'btn' });
    addBtn.innerHTML = `${svgIcon('folder', 13)}<span>Add project folder</span>`;
    addBtn.addEventListener('click', async () => {
      const folder = await pickFolder();
      if (!folder) return;
      ctx.engine
        .workspaceAction({ action: 'add', path: folder })
        .then((payload) => {
          scan = payload.scan;
          toast(`Project added: ${folder}`, 'ok');
          render();
        })
        .catch((error) => toast((error as Error).message, 'error'));
    });

    section.append(h('div', { class: 'section-head' }, h('h2', { class: 'section-title', text: 'Project folders' }), h('span', { class: 'grow' }), addBtn));

    if (scan.workspaces.length === 0) {
      section.append(h('div', { class: 'empty' }, 'Add a project folder to register LAZY SQL inside it.'));
      return section;
    }

    for (const workspace of scan.workspaces) {
      const removeBtn = h('button', { class: 'icon-btn danger', title: 'Remove from LAZY SQL (does not touch files)', 'aria-label': `Remove ${workspace.label}`, html: svgIcon('trash', 15) });
      removeBtn.addEventListener('click', async () => {
        const ok = await confirmDialog(`Remove "${workspace.label}" from LAZY SQL? Tool config files are left untouched.`, {
          title: 'Remove project folder',
          confirmLabel: 'Remove',
          danger: true
        });
        if (!ok) return;
        ctx.engine
          .workspaceAction({ action: 'remove', path: workspace.path })
          .then((payload) => {
            scan = payload.scan;
            toast('Project removed', 'ok');
            render();
          })
          .catch((error) => toast((error as Error).message, 'error'));
      });

      section.append(
        renderScopeCard({
          scopeType: 'workspace',
          scopePath: workspace.path,
          icon: 'folder',
          title: workspace.label,
          subtitle: workspace.path,
          tools: workspace.tools,
          missing: !workspace.exists,
          actions: [removeBtn]
        })
      );
    }
    return section;
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
        html: 'Only that entry is edited — comments, order and formatting of the rest of the file stay as they are. The first time LAZY SQL changes a file, the original is kept next to it as <span class="mono">&lt;file&gt;.lazy-sql-backup</span> and never overwritten.'
      })
    );
  }

  function render(): void {
    container.replaceChildren();
    if (!scan) {
      container.append(h('div', { class: 'muted', text: 'Loading…' }));
      return;
    }

    container.append(
      crumb('SET UP', 'AI tools'),
      h('h1', { class: 'page-title', text: 'AI tools' }),
      h('p', {
        class: 'page-sub',
        text: 'Let your AI coding tools use LAZY SQL. Register it for all projects, or only for specific project folders, and choose which connections each entry may use.'
      })
    );
    appendChildren(container, [renderRestartNotice(), renderUserScope(), renderWorkspacesSection(), renderAdvanced()]);
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
