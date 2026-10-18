export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface EngineInfo {
  port: number;
  token: string;
  spawned: boolean;
  pid: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

let cachedPlatform: 'windows' | 'macos' | 'linux' | null = null;

export async function getPlatform(): Promise<'windows' | 'macos' | 'linux'> {
  if (cachedPlatform) return cachedPlatform;
  if (IS_TAURI) {
    try {
      const value = await invoke<string>('get_platform');
      cachedPlatform = value === 'macos' ? 'macos' : value === 'linux' ? 'linux' : 'windows';
      return cachedPlatform;
    } catch {
      /* fall through */
    }
  }
  const ua = navigator.userAgent.toLowerCase();
  cachedPlatform = ua.includes('mac') ? 'macos' : ua.includes('linux') ? 'linux' : 'windows';
  return cachedPlatform;
}

/* ---------- engine discovery ---------- */

async function probePort(port: number): Promise<EngineInfo | null> {
  try {
    // generous: the first request after a page load can take close to a second while vite is still serving modules
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json();
    if (!['lazy-sql', 'linkit-sql', 'sql-crew'].includes(body?.app)) return null;
    return { port, token: '', spawned: false, pid: 0 };
  } catch {
    return null;
  }
}

export async function ensureEngine(): Promise<EngineInfo> {
  if (IS_TAURI) {
    const info = await invoke<EngineInfo>('ensure_engine');
    return info;
  }
  // web dev mode: query params win (handy for dev), then localStorage, then a port scan
  const params = new URLSearchParams(window.location.search);
  const paramPort = Number(params.get('engine'));
  const paramToken = params.get('token');
  if (paramPort && paramToken) {
    // An engine pinned in the URL is never swapped for another one: retry it instead of scanning other ports.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const probed = await probePort(paramPort);
      if (probed) {
        window.localStorage.setItem('lazy-sql:web-engine', JSON.stringify({ port: paramPort, token: paramToken }));
        return { ...probed, token: paramToken };
      }
    }
    throw new Error(`The LAZY SQL engine on port ${paramPort} did not respond. Check that it is running, then click Retry.`);
  }
  const stored = window.localStorage.getItem('lazy-sql:web-engine');
  if (stored) {
    const parsed = JSON.parse(stored) as { port: number; token: string };
    const probed = await probePort(parsed.port);
    if (probed) return { ...probed, token: parsed.token };
  }
  for (let port = 4788; port <= 4810; port += 1) {
    const probed = await probePort(port);
    if (probed) {
      const token = window.localStorage.getItem(`lazy-sql:token:${port}`) ?? '';
      window.localStorage.setItem('lazy-sql:web-engine', JSON.stringify({ port, token }));
      return { ...probed, token };
    }
  }
  throw new Error(
    'The LAZY SQL engine is not running. Start it with `npm run serve` (engine folder), then click Retry.'
  );
}

export function rememberWebEngine(port: number, token: string): void {
  if (!IS_TAURI) window.localStorage.setItem('lazy-sql:web-engine', JSON.stringify({ port, token }));
}

/* ---------- window controls ---------- */

export async function minimizeWindow(): Promise<void> {
  if (!IS_TAURI) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!IS_TAURI) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!IS_TAURI) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

export async function isMaximized(): Promise<boolean> {
  if (!IS_TAURI) return false;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow().isMaximized();
}

export async function onMaximizeChange(callback: (maximized: boolean) => void): Promise<void> {
  if (!IS_TAURI) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().onResized(async () => {
    callback(await isMaximized());
  });
}

/* ---------- review window ---------- */

export async function hideReviewWindow(): Promise<void> {
  if (IS_TAURI) {
    // in dialog mode (no main window) the Rust side exits the process instead of hiding
    await invoke('hide_review_window');
    return;
  }
  window.close();
}

/* ---------- app-level ---------- */

export async function quitApp(): Promise<void> {
  if (IS_TAURI) await invoke('quit_app');
}

export async function setCloseToTray(value: boolean): Promise<void> {
  if (IS_TAURI) await invoke('set_close_to_tray', { value });
}

export async function revealPath(path: string): Promise<void> {
  if (IS_TAURI) {
    await invoke('reveal_path', { path });
    return;
  }
  window.open(`file://${path}`, '_blank');
}

/* ---------- file pickers ---------- */

export async function pickFolder(): Promise<string | null> {
  if (IS_TAURI) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title: 'Choose a workspace folder' });
    return typeof result === 'string' ? result : null;
  }
  return window.prompt('Workspace folder path:');
}

export async function pickSaveFile(defaultName: string): Promise<string | null> {
  if (IS_TAURI) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const result = await save({
      defaultPath: defaultName,
      title: 'Export LAZY SQL connections',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    return result ?? null;
  }
  return window.prompt('Destination file path:', defaultName);
}

export async function pickOpenFile(): Promise<string | null> {
  if (IS_TAURI) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: false,
      title: 'Import LAZY SQL connections',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    return typeof result === 'string' ? result : null;
  }
  return window.prompt('Connections .json file to import:');
}

export async function pickExecutable(): Promise<string | null> {
  if (IS_TAURI) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: false,
      title: 'Choose the LAZY SQL app executable',
      filters: undefined
    });
    return typeof result === 'string' ? result : null;
  }
  return window.prompt('Path to the LAZY SQL app executable:');
}
