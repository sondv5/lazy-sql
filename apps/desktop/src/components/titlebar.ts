import { h, svgIcon } from '../lib/dom';
import { IS_TAURI, closeWindow, minimizeWindow, toggleMaximizeWindow } from '../lib/tauri';

export interface TitlebarHandle {
  el: HTMLElement;
}

export function createTitlebar(
  platform: 'windows' | 'macos' | 'linux',
  options: { title?: string } = {}
): TitlebarHandle {
  const dragProps = IS_TAURI ? { 'data-tauri-drag-region': '' } : {};

  let maxButton: HTMLButtonElement | null = null;
  const isMac = platform === 'macos';

  const controls = h('div', { class: 'win-controls' });
  if (isMac) {
    const closeDot = h('button', { class: 'mac-dot close', title: 'Close' });
    const minDot = h('button', { class: 'mac-dot min', title: 'Minimize' });
    const maxDot = h('button', { class: 'mac-dot max', title: 'Maximize' });
    closeDot.addEventListener('click', () => void closeWindow());
    minDot.addEventListener('click', () => void minimizeWindow());
    maxDot.addEventListener('click', () => void toggleMaximizeWindow());
    controls.append(closeDot, minDot, maxDot);
  } else {
    const minBtn = h('button', { class: 'win-btn', title: 'Minimize' }) as HTMLButtonElement;
    minBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2.5 7h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
    maxButton = h('button', { class: 'win-btn', title: 'Maximize' }) as HTMLButtonElement;
    maxButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2.8" y="2.8" width="8.4" height="8.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
    const closeBtn = h('button', { class: 'win-btn close', title: 'Close' });
    closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
    minBtn.addEventListener('click', () => void minimizeWindow());
    maxButton.addEventListener('click', () => void toggleMaximizeWindow());
    closeBtn.addEventListener('click', () => void closeWindow());
    controls.append(minBtn, maxButton, closeBtn);
  }

  const title = h('span', { class: 'title', text: options.title ?? 'LAZY SQL', ...dragProps });
  const spacer = h('div', { class: 'spacer', ...dragProps });
  const el = h('div', { class: 'titlebar', ...dragProps });
  if (isMac) {
    el.append(controls, title, spacer);
  } else {
    el.append(title, spacer, controls);
  }

  el.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    void toggleMaximizeWindow();
  });
  el.addEventListener('mousedown', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.detail === 2) return;
  });

  return { el };
}
