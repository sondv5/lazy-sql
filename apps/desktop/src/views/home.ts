import { h, svgIcon, chip, relativeTime } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { InstanceRecord, WorkspaceScan } from '../lib/engine';

interface SetupState {
  health: { node: string; version: string; connections: { total: number; enabled: number }; dataDir: string } | null;
  engineError: string | null;
  scan: WorkspaceScan | null;
  instances: InstanceRecord[];
}

function stepCard(options: {
  icon: string;
  title: string;
  text: string;
  badge?: HTMLElement;
  highlight?: boolean;
  actions?: HTMLElement[];
}): HTMLElement {
  const iconBox = h('div', { class: 'step-icon' });
  iconBox.innerHTML = svgIcon(options.icon, 18);
  const body = h(
    'div',
    { class: 'step-body' },
    h('div', { class: 'row' }, h('div', { class: 'step-title grow', text: options.title }), options.badge ?? null),
    h('div', { class: 'step-text', text: options.text }),
    options.actions ? h('div', { class: 'step-actions' }, ...options.actions) : null
  );
  return h('div', { class: `card step-card${options.highlight ? ' highlight' : ''}` }, iconBox, body);
}

export function createHomeView(ctx: AppContext): View {
  const state: SetupState = { health: null, engineError: null, scan: null, instances: [] };
  const container = h('div');

  async function load(): Promise<void> {
    try {
      const [health, scan, instances] = await Promise.all([
        ctx.engine.health(),
        ctx.engine.workspaces().catch(() => null),
        ctx.engine.instances(true).catch(() => ({ instances: [] }))
      ]);
      state.health = health;
      state.engineError = null;
      state.scan = scan;
      state.instances = instances.instances;
    } catch (error) {
      state.engineError = (error as Error).message;
    }
    render();
  }

  function registeredCount(): number {
    if (!state.scan) return 0;
    let count = 0;
    for (const tool of Object.values(state.scan.user)) if (tool.registered && tool.enabled) count += 1;
    for (const workspace of state.scan.workspaces) {
      for (const tool of Object.values(workspace.tools)) if (tool.registered && tool.enabled) count += 1;
    }
    return count;
  }

  function render(): void {
    container.replaceChildren();

    if (state.engineError) {
      const retry = h('button', { class: 'btn primary', text: 'Retry connection' });
      retry.addEventListener('click', () => void load());
      container.append(
        crumb('WELCOME', 'Setup'),
        h('h1', { class: 'page-title', text: 'Set up LAZY SQL' }),
        h('p', { class: 'page-sub', text: 'The local engine is not running. Start it, then retry.' }),
        stepCard({
          icon: 'terminal',
          title: 'Start the LAZY SQL engine',
          text: state.engineError,
          badge: h('span', { class: 'badge badge-warn', text: 'Required' }),
          highlight: true,
          actions: [retry]
        }),
        h('div', { class: 'code-block mono' }, 'npm run serve   # from the project root')
      );
      return;
    }

    const health = state.health;
    const connectionsBadge =
      health && health.connections.total > 0
        ? h('span', { class: 'badge badge-ok', text: `${health.connections.enabled} enabled / ${health.connections.total}` })
        : h('span', { class: 'badge badge-violet', text: 'Required' });
    const registered = registeredCount();
    const workspacesBadge =
      registered > 0
        ? h('span', { class: 'badge badge-ok', text: `${registered} registration${registered === 1 ? '' : 's'}` })
        : h('span', { class: 'badge badge-violet', text: 'Recommended' });

    const openConnections = h('button', { class: 'btn small' });
    openConnections.innerHTML = `${svgIcon('plus', 13)}<span>Add a connection</span>`;
    openConnections.addEventListener('click', () => ctx.navigate('connections'));

    const openWorkspaces = h('button', { class: 'btn small' });
    openWorkspaces.innerHTML = `${svgIcon('grid', 13)}<span>Set up AI tools</span>`;
    openWorkspaces.addEventListener('click', () => ctx.navigate('workspaces'));

    const steps = h(
      'div',
      { class: 'mt' },
      stepCard({
        icon: 'terminal',
        title: 'Node.js runtime',
        text: health ? `Detected ${health.node}` : 'Checking…',
        badge: h('span', { class: 'badge badge-ok', text: 'Complete' })
      }),
      stepCard({
        icon: 'sparkle',
        title: 'LAZY SQL engine',
        text: health ? `v${health.version} on this machine — data in ${health.dataDir}` : 'Checking…',
        badge: h('span', { class: 'badge badge-ok', text: 'Complete' })
      }),
      stepCard({
        icon: 'database',
        title: 'Database connections',
        text: connectionsBadge.textContent === 'Required' ? 'Add at least one database for agents to query.' : 'Enabled and read-only are controlled per connection.',
        badge: connectionsBadge,
        highlight: connectionsBadge.textContent === 'Required',
        actions: [openConnections]
      }),
      stepCard({
        icon: 'grid',
        title: 'AI tools',
        text: registered > 0 ? 'LAZY SQL is registered in your AI tools.' : 'Register LAZY SQL in OpenCode, Claude Code, Kiro or Cursor.',
        badge: workspacesBadge,
        actions: [openWorkspaces]
      })
    );

    const sessionsCard = h('div', { class: 'card' });
    const sessionRows = state.instances.filter((instance) => !instance.isSelf);
    if (sessionRows.length === 0) {
      sessionsCard.append(
        h('div', { class: 'row' }, h('span', { class: 'card-title grow', text: 'Live agent sessions' })),
        h('p', { class: 'card-sub', text: 'No agent sessions right now.' })
      );
    } else {
      sessionsCard.append(h('div', { class: 'row' }, h('span', { class: 'card-title grow', text: 'Live agent sessions' }), chip(`${sessionRows.length} active`)));
      for (const instance of sessionRows) {
        const pending = instance.state?.review;
        const row = h(
          'div',
          { class: 'card tight mt', style: 'box-shadow:none' },
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'mono grow truncate', text: `${instance.label ?? 'session'} · pid ${instance.pid} · port ${instance.port}` }),
            chip(instance.mode, 'neutral'),
            pending ? chip('review pending', 'warn') : null,
            h('span', { class: 'muted', text: relativeTime(instance.startedAt) })
          )
        );
        sessionsCard.append(row);
      }
    }

    const headline = !health
      ? 'Checking your setup…'
      : health.connections.total === 0
        ? 'Add your first database.'
        : registered === 0
          ? 'Connect your AI tools.'
          : "You're all set.";

    const footer = h(
      'div',
      { class: 'footer-bar' },
      h('span', { class: 'grow', text: 'Reads run instantly. Data changes wait for your review.' }),
      h('button', { class: 'btn primary small', html: `${svgIcon('database', 13)}<span>Open connections</span>` })
    );
    footer.querySelector('button')?.addEventListener('click', () => ctx.navigate('connections'));

    container.append(
      crumb('OVERVIEW'),
      h('h1', { class: 'page-title', text: headline }),
      h('p', {
        class: 'page-sub',
        html: 'Reviewed SQL access for your AI tools. <b>Reads run instantly</b>; data changes open a review dialog first.'
      }),
      steps,
      h('div', { class: 'mt' }, sessionsCard),
      footer
    );
  }

  const timer = window.setInterval(() => void load(), 6000);
  void load();

  return {
    el: container,
    dispose: () => window.clearInterval(timer),
    refresh: () => void load()
  };
}
