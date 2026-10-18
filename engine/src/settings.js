import { APP_SETTINGS_FILE, readJsonFile, writeJsonFile } from './paths.js';

const DEFAULTS = {
  reviewTimeoutMs: 600000,
  maxRowsDefault: 200,
  fallbackToBrowser: true,
  desktopAppPath: '',
  closeToTray: true,
  lastSelectedDate: null
};

export function getAppSettings() {
  const stored = readJsonFile(APP_SETTINGS_FILE);
  const settings = { ...DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (stored[key] !== undefined) settings[key] = stored[key];
    }
  }
  return settings;
}

export function saveAppSettings(patch) {
  const current = getAppSettings();
  const next = { ...current };
  if (patch && typeof patch === 'object') {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      next[key] = value;
    }
  }
  if (Number.isFinite(Number(next.reviewTimeoutMs))) {
    next.reviewTimeoutMs = Math.min(Math.max(Number(next.reviewTimeoutMs), 5000), 3600000);
  }
  if (Number.isFinite(Number(next.maxRowsDefault))) {
    next.maxRowsDefault = Math.min(Math.max(Number(next.maxRowsDefault), 1), 5000);
  }
  writeJsonFile(APP_SETTINGS_FILE, next);
  return next;
}
