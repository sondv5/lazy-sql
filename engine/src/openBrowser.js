import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppSettings } from './settings.js';
import { log } from './logger.js';
import { readEnv } from './paths.js';

export function buildOpenCommand(url, platform = process.platform) {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

function isDryRun() {
  return readEnv('NO_OPEN') === '1' || readEnv('DRY_RUN') === '1';
}

export function openBrowser(url) {
  if (isDryRun()) {
    log(`Would open browser: ${url}`);
    return { opened: false, dryRun: true, mode: 'browser', url };
  }
  const { command, args } = buildOpenCommand(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { opened: true, dryRun: false, mode: 'browser', url };
  } catch (error) {
    log(`Failed to open browser for ${url}: ${error.message}`);
    return { opened: false, dryRun: false, mode: 'browser', url, error: error.message };
  }
}

export function launchDesktopApp(appPath) {
  if (!appPath) return { launched: false, reason: 'no desktop app path configured' };
  if (isDryRun()) {
    log(`Would launch desktop app: ${appPath}`);
    return { launched: false, dryRun: true };
  }
  try {
    if (!fs.existsSync(appPath)) return { launched: false, reason: `not found: ${appPath}` };
    const child =
      process.platform === 'darwin' && appPath.endsWith('.app')
        ? spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' })
        : spawn(appPath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    log(`Desktop app launched: ${appPath}`);
    return { launched: true };
  } catch (error) {
    log(`Failed to launch the desktop app: ${error.message}`);
    return { launched: false, reason: error.message };
  }
}

/* ---------- locating the desktop app ---------- */

function devCheckoutAppPath() {
  const entry = readEnv('ENGINE_ENTRY') || process.argv[1] || '';
  if (!entry) return null;
  const root = path.resolve(path.dirname(path.resolve(entry)), '..', '..');
  const binary = process.platform === 'win32' ? 'lazy-sql.exe' : 'lazy-sql';
  return path.join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', binary);
}

// Returns the executable that can render review dialogs (a .app is resolved to its inner binary,
// which is what `--review` args must be handed to). null = not installed.
export function resolveDesktopAppPath(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'LAZY SQL', 'lazy-sql.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'LAZY SQL', 'lazy-sql.exe'));
    }
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'LAZY SQL', 'lazy-sql.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/LAZY SQL.app', path.join(os.homedir(), 'Applications', 'LAZY SQL.app'));
  }
  const dev = devCheckoutAppPath();
  if (dev) candidates.push(dev);

  for (const candidate of candidates) {
    try {
      if (!candidate) continue;
      const binary = process.platform === 'darwin' && candidate.endsWith('.app')
        ? path.join(candidate, 'Contents', 'MacOS', 'lazy-sql')
        : candidate;
      if (fs.existsSync(binary)) return binary;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/* ---------- review dialogs (spawned by the engine session itself) ---------- */

const activeDialogs = new Set();

function trackDialog(child) {
  activeDialogs.add(child);
  child.once('exit', () => activeDialogs.delete(child));
  child.once('error', (error) => {
    activeDialogs.delete(child);
    log(`Review dialog failed to start: ${error.message}`);
  });
  return child;
}

// Spawns the desktop app in dialog mode: only the frameless review window, no main window,
// no tray, no engine supervision. Returns null when the app is not available.
export function spawnReviewDialog({ base, token, reviewId }) {
  if (isDryRun()) return null;
  const appPath = resolveDesktopAppPath(getAppSettings().desktopAppPath);
  if (!appPath) return null;
  try {
    const child = spawn(appPath, ['--review', base, token, reviewId], { detached: true, stdio: 'ignore' });
    child.unref();
    return trackDialog(child);
  } catch (error) {
    log(`Could not open the review dialog: ${error.message}`);
    return null;
  }
}

export function killReviewDialog(child) {
  if (!child) return;
  activeDialogs.delete(child);
  if (child.killed) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

export function disposeReviewDialogs() {
  for (const child of [...activeDialogs]) killReviewDialog(child);
}

/**
 * Decide where a review should surface:
 *  - 'app-dialog' — the app was spawned in dialog mode by this engine session
 *  - 'browser'    — the app is not available; the fallback review page opens in the browser
 *  - 'none'       — neither available (dry run, or fallback disabled)
 */
export function ensureReviewSurface({ pageUrl, base, token, reviewId }) {
  const dialog = spawnReviewDialog({ base, token, reviewId });
  if (dialog) return { target: 'app-dialog', child: dialog };

  const settings = getAppSettings();
  if (settings.fallbackToBrowser) {
    openBrowser(pageUrl);
    return { target: 'browser' };
  }

  return { target: 'none' };
}
