type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  text?: string;
  html?: string;
  style?: string;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') el.innerHTML = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'value' && el instanceof HTMLInputElement) {
        el.value = String(value);
      } else if (key === 'checked' && el instanceof HTMLInputElement) {
        el.checked = Boolean(value);
      } else if (key === 'disabled' && el instanceof HTMLButtonElement) {
        el.disabled = Boolean(value);
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function svgIcon(name: string, size = 16): string {
  const paths = ICONS[name] ?? ICONS.circle;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export function iconEl(name: string, size = 16): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon-wrap';
  span.innerHTML = svgIcon(name, size);
  return span;
}

const ICONS: Record<string, string> = {
  circle: '<circle cx="12" cy="12" r="8"/>',
  home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5V12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V5.5"/><path d="M5 12v6.5c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V12"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5Z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2.4 2.4 0 0 0 4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M20 5v6h-6"/><path d="M4 19v-6h6"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  pencil: '<path d="M17 3.5 20.5 7 8.5 19l-4.5 1 1-4.5Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/>',
  check: '<path d="M4.5 12.5 10 18 19.5 6.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 15V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 19.5h15"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  play: '<path d="M7 5.5v13l11-6.5Z"/>',
  alert: '<path d="M12 4 3 19h18Z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
  terminal: '<path d="m5 7 5 5-5 5"/><path d="M13 17h6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3.34-3.34a4 4 0 1 0-5.66-5.66l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.66 0L5 13.34a4 4 0 1 0 5.66 5.66l1.5-1.5"/>',
  power: '<path d="M12 3v8"/><path d="M17.6 6.4a7.5 7.5 0 1 1-11.2 0"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z"/><path d="m9.5 12 1.8 1.8 3.4-3.6"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  ghost:
    '<path d="M12 3c-4.5 0-7.5 3.4-7.5 8.5V21l2.7-2 2.4 2 2.4-2 2.4 2 2.4-2 2.7 2V11.5C19.5 6.4 16.5 3 12 3Z"/><ellipse cx="9.2" cy="10.5" rx="1.2" ry="1.7" fill="currentColor" stroke="none"/><ellipse cx="14.8" cy="10.5" rx="1.2" ry="1.7" fill="currentColor" stroke="none"/>',
  cat: '<path fill="currentColor" fill-rule="evenodd" d="M5.44 2.06 3.94 9.94Q3.86 11.59 4.65 11.85L13.05 12.56 13.35 12.6 17.96 10.43 17.33 3.56Q11.25 6.38 5.44 2.06ZM5.1 11.44V22.69H16.43L13.84 15.08 13.35 12.6ZM6 7.05h1.13v2.33H6ZM9.08 7.05h1.13v2.33H9.08Z"/><path d="M15.56 19.31c.94 2.37 3.12 3.49 5.14 2.74 1.95-.75 2.51-3.6 1.31-5.55-.9-1.5-2.77-2.03-4.12-1.42" stroke="currentColor" stroke-width="1.73" fill="none" stroke-linecap="round"/>',
  swap: '<path d="M7 8h13l-3-3"/><path d="M17 16H4l3 3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  filter: '<path d="M4 5h16l-6.5 7.5V19l-3-1.5v-5Z"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>'
};

const toastWrap = (() => {
  let wrap: HTMLElement | null = null;
  return () => {
    if (!wrap) {
      wrap = h('div', { class: 'toast-wrap' });
      document.body.append(wrap);
    }
    return wrap;
  };
})();

export function toast(message: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastWrap().append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, kind === 'error' ? 5200 : 2800);
}

export function copyText(text: string, label = 'Copied'): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${label} to clipboard`, 'ok'))
    .catch(() => toast('Copy failed', 'error'));
}

export interface ModalOptions {
  title: string;
  subtitle?: string;
  body: HTMLElement;
  footer?: HTMLElement;
  width?: number;
  onClose?: () => void;
}

export function openModal(options: ModalOptions): { close: () => void; root: HTMLElement } {
  const overlay = h('div', { class: 'modal-overlay' });
  const card = h('div', { class: 'modal-card', style: options.width ? `width:${options.width}px` : '' });
  const header = h(
    'div',
    { class: 'modal-header' },
    h('div', { class: 'modal-titles' }, h('div', { class: 'modal-title', text: options.title }), options.subtitle ? h('div', { class: 'modal-subtitle', text: options.subtitle }) : null),
    h('button', { class: 'icon-btn', title: 'Close', html: svgIcon('x'), onclick: () => close() })
  );
  card.append(header, h('div', { class: 'modal-body' }, options.body));
  if (options.footer) card.append(h('div', { class: 'modal-footer' }, options.footer));
  overlay.append(card);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close();
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };

  const parent = document.querySelector('#app') ?? document.body;
  parent.append(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('open'));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 180);
    options.onClose?.();
  }
  return { close, root: card };
}

export function confirmDialog(
  message: string,
  { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false }: { title?: string; confirmLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const body = h('div', { class: 'confirm-body', text: message });
    const cancel = h('button', { class: 'btn ghost', text: 'Cancel' });
    const confirm = h('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}`, text: confirmLabel });
    const modal = openModal({
      title,
      body,
      width: 420,
      footer: h('div', { class: 'row-end' }, cancel, confirm),
      onClose: () => {
        if (!decided) {
          decided = true;
          resolve(false);
        }
      }
    });
    cancel.addEventListener('click', () => modal.close());
    confirm.addEventListener('click', () => {
      decided = true;
      resolve(true);
      modal.close();
    });
  });
}

export function chip(text: string, variant = 'violet'): HTMLElement {
  return h('span', { class: `chip chip-${variant}`, text });
}

export function engineDot(engine: string): HTMLElement {
  const colors: Record<string, string> = {
    postgres: '#3b82f6',
    mysql: '#0ea5e9',
    mssql: '#6366f1',
    sqlite: '#10b981'
  };
  const dot = h('span', { class: 'engine-dot' });
  dot.style.background = colors[engine] ?? '#4d6ae0';
  return dot;
}

export function toggleSwitch(checked: boolean, onChange: (value: boolean) => void, disabled = false): HTMLElement {
  const input = h('input', { type: 'checkbox', class: 'toggle-input', checked, disabled }) as HTMLInputElement;
  const wrap = h('label', { class: `toggle${disabled ? ' disabled' : ''}` }, input, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' })));
  input.addEventListener('change', () => onChange(input.checked));
  return wrap;
}

export function statusBadge(status: string): HTMLElement {
  const map: Record<string, [string, string]> = {
    ok: ['ok', 'Executed'],
    error: ['error', 'Error'],
    rejected: ['error', 'Rejected'],
    review_timeout: ['warn', 'Timed out'],
    blocked: ['warn', 'Blocked'],
    pending: ['violet', 'Pending'],
    running: ['violet', 'Running']
  };
  const [variant, label] = map[status] ?? ['neutral', status];
  return h('span', { class: `badge badge-${variant}`, text: label });
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return date.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
