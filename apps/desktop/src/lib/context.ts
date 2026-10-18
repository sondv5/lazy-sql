import type { Engine } from './engine';

export interface AppContext {
  engine: Engine;
  platform: 'windows' | 'macos' | 'linux';
  navigate: (viewId: string) => void;

}

export interface View {
  el: HTMLElement;
  dispose?: () => void;
  refresh?: () => void;
}

export function crumb(head: string, tail?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'crumb';
  el.innerHTML = `<span>${head}</span>${tail ? ` <span class="crumb-sep">→</span> <span class="crumb-tail">${tail}</span>` : ''}`;
  return el;
}
