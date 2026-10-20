import { h, svgIcon } from '../lib/dom';

export interface NavItem {
  id: string;
  label: string;
  icon: string;
}

export interface NavGroup {
  title: string | null;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  { title: null, items: [{ id: 'home', label: 'Overview', icon: 'home' }] },
  {
    title: 'Work',
    items: [
      { id: 'query', label: 'SQL', icon: 'terminal' },
      { id: 'logs', label: 'Logs', icon: 'book' }
    ]
  },
  {
    title: 'Set up',
    items: [
      { id: 'connections', label: 'Connections', icon: 'database' },
      { id: 'workspaces', label: 'AI tools', icon: 'grid' }
    ]
  }
];

export const SETTINGS_ITEM: NavItem = { id: 'settings', label: 'Settings', icon: 'gear' };

function catSvg(width: number): string {
  return `<svg width="${width}" height="${width}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M13.6 29.8 L13.6 60.5 L43.8 60.5 L36.9 40.2 L35.6 33.6 Z" fill="#ffffff"/>
    <path d="M14.5 5.5 L10.5 26.5 Q10.3 30.9 12.4 31.6 L34.8 33.5 L35.6 33.6 L47.9 27.8 L46.2 9.5 Q30 17 14.5 5.5 Z" fill="#ffffff"/>
    <rect x="16" y="19.2" width="3" height="5.4" rx="1.3" fill="#1f2b57"/>
    <rect x="24.2" y="19.2" width="3" height="5.4" rx="1.3" fill="#1f2b57"/>
    <path d="M41.5 51.5 C 44 57.8 49.8 60.8 55.2 58.8 C 60.4 56.8 61.9 49.2 58.7 44 C 56.3 40 51.3 38.6 47.7 40.2" stroke="#ffffff" stroke-width="4.6" fill="none" stroke-linecap="round"/>
  </svg>`;
}

export interface SidebarHandle {
  el: HTMLElement;
  setActive: (id: string) => void;
  setBadge: (id: string, count: number) => void;
  setEngineStatus: (online: boolean, version?: string) => void;
}

export function createSidebar(onNavigate: (id: string) => void): SidebarHandle {
  const buttons = new Map<string, HTMLButtonElement>();
  const badges = new Map<string, HTMLElement>();

  function navButton(item: NavItem): HTMLButtonElement {
    const badge = h('span', { class: 'nav-badge hidden', text: '0' });
    const button = h('button', { class: 'nav-item', type: 'button' }) as HTMLButtonElement;
    button.innerHTML = `${svgIcon(item.icon, 16)}<span>${item.label}</span>`;
    button.append(badge);
    button.addEventListener('click', () => onNavigate(item.id));
    buttons.set(item.id, button);
    badges.set(item.id, badge);
    return button;
  }

  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  for (const group of NAV_GROUPS) {
    const section = h('div', { class: 'nav-group', ...(group.title ? { role: 'group', 'aria-label': group.title } : {}) });
    if (group.title) section.append(h('div', { class: 'nav-group-title', 'aria-hidden': 'true', text: group.title }));
    for (const item of group.items) section.append(navButton(item));
    nav.append(section);
  }

  const brand = h('div', { class: 'brand' });
  brand.innerHTML = `${catSvg(20)}<span>LAZY SQL</span>`;

  const engineText = h('span', { class: 'engine-text', text: 'Engine running' });
  const engineStatus = h('div', { class: 'engine-status online', role: 'status', title: 'Local engine' }, h('span', { class: 'dot' }), engineText);
  const footer = h('nav', { class: 'sidebar-footer', 'aria-label': 'App' }, navButton(SETTINGS_ITEM), engineStatus);

  const el = h('aside', { class: 'sidebar' }, brand, nav, footer);

  let engineVersion = '';

  return {
    el,
    setActive(id: string) {
      for (const [key, button] of buttons) {
        const active = key === id;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    },
    setBadge(id: string, count: number) {
      const badge = badges.get(id);
      if (!badge) return;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    },
    setEngineStatus(online: boolean, version?: string) {
      if (version) engineVersion = version;
      engineStatus.classList.toggle('online', online);
      engineStatus.classList.toggle('offline', !online);
      engineText.textContent = online ? `Engine running${engineVersion ? ` · v${engineVersion}` : ''}` : 'Engine not responding';
    }
  };
}
