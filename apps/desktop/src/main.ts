import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/app.css';
import './styles/dialog.css';

import { h, svgIcon, toast } from './lib/dom';
import { IS_TAURI, getPlatform, isMaximized, onMaximizeChange } from './lib/tauri';
import { connectEngine } from './lib/engine';
import type { Engine, InstanceRecord } from './lib/engine';
import { createTitlebar } from './components/titlebar';
import { createSidebar } from './components/sidebar';
import { createHomeView } from './views/home';
import { createConnectionsView } from './views/connections';
import { createQueryView } from './views/query';
import { createLogsView } from './views/logs';
import { createWorkspacesView } from './views/workspaces';
import { createSettingsView } from './views/settings';
import { mountReviewApp } from './review/dialog';
import type { AppContext, View } from './lib/context';

const params = new URLSearchParams(window.location.search);
const appRoot = document.getElementById('app') as HTMLElement;

async function boot(): Promise<void> {
  if (params.get('view') === 'review') {
    const base = params.get('base') ?? '';
    const token = params.get('token') ?? '';
    const reviewId = params.get('review') ?? '';
    mountReviewApp(appRoot, base, token, reviewId);
    return;
  }
  await bootMain();
}

async function bootMain(): Promise<void> {
  if (!IS_TAURI) document.body.classList.add('web-mode');

  const platform = await getPlatform();
  let engine: Engine;
  try {
    engine = await connectEngine();
  } catch (error) {
    renderEngineError(errorMessage(error), platform);
    return;
  }

  const root = h('div', { class: `app-root platform-${platform}` });
  if (await isMaximized()) root.classList.add('maximized');
  void onMaximizeChange((maximized) => root.classList.toggle('maximized', maximized));

  /* ---------- shell ---------- */

  const lastNavByInstance = new Map<string, string>();
  const titlebar = createTitlebar(platform, {});

  const content = h('div', { class: 'content' });
  let currentViewId = '';
  const viewCache = new Map<string, View>();

  const ctx: AppContext = {
    engine,
    platform,
    navigate
  };

  function createView(id: string): View {
    switch (id) {
      case 'connections':
        return createConnectionsView(ctx);
      case 'query':
        return createQueryView(ctx);
      case 'logs':
        return createLogsView(ctx);
      case 'workspaces':
        return createWorkspacesView(ctx);
      case 'settings':
        return createSettingsView(ctx);
      default:
        return createHomeView(ctx);
    }
  }

  function navigate(id: string): void {
    if (!id) id = 'home';
    if (id === currentViewId) return;
    currentViewId = id;
    const view = viewCache.get(id) ?? createView(id);
    viewCache.set(id, view);
    content.replaceChildren(view.el);
    sidebar.setActive(id);
    view.refresh?.();
    if (window.location.hash !== `#/${id}`) {
      window.history.replaceState(null, '', `#/${id}`);
    }
    content.scrollTop = 0;
  }

  const sidebar = createSidebar((id) => navigate(id));
  void engine
    .settings()
    .then((payload) => sidebar.setEngineStatus(true, payload.version))
    .catch(() => sidebar.setEngineStatus(false));

  const body = h('div', { class: 'app-body' }, sidebar.el, content);
  root.append(titlebar.el, body);
  appRoot.replaceChildren(root);

  window.addEventListener('hashchange', () => {
    const id = window.location.hash.replace(/^#\/?/, '') || 'home';
    navigate(id);
  });

  const initial = window.location.hash.replace(/^#\/?/, '') || 'home';
  navigate(initial);

  /* ---------- instance watcher (nav requests from agents; reviews are engine-managed) ---------- */

  async function pollInstances(): Promise<void> {
    try {
      const { instances } = await engine.instances(true);
      for (const instance of instances as InstanceRecord[]) {
        const nav = instance.state?.nav;
        if (nav?.id && lastNavByInstance.get(instance.id) !== nav.id) {
          lastNavByInstance.set(instance.id, nav.id);
          if (nav.path.startsWith('/config')) {
            navigate('connections');
            toast('An agent opened the connection manager.');
          }
        }
      }
      sidebar.setEngineStatus(true);
    } catch {
      /* engine hiccup — flag it and try again next tick */
      sidebar.setEngineStatus(false);
    }
    window.setTimeout(() => void pollInstances(), 1500);
  }
  void pollInstances();

  /* ---------- connect the sidebar count ---------- */

  async function refreshConnectionBadge(): Promise<void> {
    try {
      const connections = await engine.connections();
      sidebar.setBadge('connections', connections.connections.length);
    } catch {
      /* ignore */
    }
  }
  void refreshConnectionBadge();
  window.setInterval(() => void refreshConnectionBadge(), 15000);
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown error');
}

function renderEngineError(message: string, platform: 'windows' | 'macos' | 'linux'): void {
  const root = h('div', { class: `app-root platform-${platform}` });
  const titlebar = createTitlebar(platform, {});
  const body = h(
    'div',
    { style: 'padding:36px 48px;max-width:760px;overflow-y:auto;flex:1' },
    h('div', { class: 'crumb' }, 'SETUP → ENGINE'),
    h('h1', { class: 'page-title', text: 'Set up LAZY SQL' }),
    h('p', { class: 'page-sub', text: 'The local engine is not running. Start it, then retry.' }),
    h(
      'div',
      { class: 'card step-card highlight' },
      h('div', { class: 'step-icon', html: svgIcon('terminal', 18) }),
      h(
        'div',
        { class: 'step-body' },
        h('div', { class: 'row' }, h('span', { class: 'step-title grow', text: 'Start the LAZY SQL engine' }), h('span', { class: 'badge badge-warn', text: 'Required' })),
        h('div', { class: 'step-text', text: message || 'The engine did not report back.' }),
        h(
          'div',
          { class: 'step-actions' },
          (() => {
            const retry = h('button', { class: 'btn primary', text: 'Retry' });
            retry.addEventListener('click', () => window.location.reload());
            return retry;
          })()
        )
      )
    ),
    h('div', { class: 'code-block mono', style: 'margin-top:14px' }, 'npm run serve        # starts the engine daemon (or run the desktop app again)\nnpm run dev:app      # desktop app in dev mode'),
    h('p', { class: 'muted', style: 'margin-top:12px' }, 'Requires Node.js 22 or newer on PATH. The engine ships as a single bundled file inside the desktop app.')
  );
  root.append(titlebar.el, body);
  appRoot.replaceChildren(root);
}

void boot();
