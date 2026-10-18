import { h, svgIcon, toast, copyText, confirmDialog } from '../lib/dom';
import type { AppContext, View } from '../lib/context';
import { crumb } from '../lib/context';
import type { AppSettings } from '../lib/engine';
import { pickExecutable, quitApp, revealPath, setCloseToTray, IS_TAURI } from '../lib/tauri';

export function createSettingsView(ctx: AppContext): View {
  const container = h('div');
  let settings: AppSettings | null = null;
  let meta: { dataDir: string; engineEntry: string; node: string; version: string; logStats: { bytes: number; file: string } } | null = null;

  function save(patch: Partial<AppSettings>, message: string): void {
    ctx.engine
      .saveSettings(patch)
      .then((payload) => {
        settings = payload.settings;
        if ('closeToTray' in patch) void setCloseToTray(Boolean(patch.closeToTray));
        toast(message, 'ok');
      })
      .catch((error) => toast((error as Error).message, 'error'));
  }

  function formLine(label: string, hint: string, control: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: 'form-line' },
      h('div', { class: 'form-label' }, h('b', { text: label }), h('span', { text: hint })),
      h('div', { class: 'form-control' }, control)
    );
  }

  function toggleLine(label: string, hint: string, value: boolean, onChange: (next: boolean) => void): HTMLElement {
    const input = h('input', { type: 'checkbox', class: 'toggle-input', checked: value }) as HTMLInputElement;
    const toggle = h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' })));
    input.addEventListener('change', () => onChange(input.checked));
    return formLine(label, hint, toggle);
  }

  function render(): void {
    container.replaceChildren();
    if (!settings || !meta) return;

    const timeoutInput = h('input', {
      class: 'input',
      type: 'number',
      value: String(Math.round(settings.reviewTimeoutMs / 1000))
    }) as HTMLInputElement;
    timeoutInput.addEventListener('change', () => {
      save({ reviewTimeoutMs: Math.max(5, Number(timeoutInput.value) || 600) * 1000 }, 'Review timeout saved');
    });

    const maxRowsInput = h('input', { class: 'input', type: 'number', value: String(settings.maxRowsDefault) }) as HTMLInputElement;
    maxRowsInput.addEventListener('change', () => {
      save({ maxRowsDefault: Math.max(1, Number(maxRowsInput.value) || 200) }, 'Default row cap saved');
    });

    const appPathInput = h('input', { class: 'input', value: settings.desktopAppPath ?? '', placeholder: 'D:\\Apps\\LAZY SQL\\lazy-sql.exe' }) as HTMLInputElement;
    const browseBtn = h('button', { class: 'btn small', text: 'Browse…' });
    browseBtn.addEventListener('click', async () => {
      const path = await pickExecutable();
      if (!path) return;
      appPathInput.value = path;
      save({ desktopAppPath: path }, 'Desktop app path saved');
    });
    const savePathBtn = h('button', { class: 'btn small primary', text: 'Save' });
    savePathBtn.addEventListener('click', () => save({ desktopAppPath: appPathInput.value.trim() }, 'Desktop app path saved'));

    const dataDirRow = h('div', { class: 'kv-row' });
    dataDirRow.append(
      h('span', { class: 'kv-label', text: 'Data folder' }),
      h('span', { class: 'kv-value grow', text: meta.dataDir, title: meta.dataDir }),
      h('button', { class: 'btn small', text: 'Open', onclick: () => void revealPath(meta!.dataDir) }),
      h('button', { class: 'btn small', text: 'Copy', onclick: () => copyText(meta!.dataDir, 'Path copied') })
    );

    const engineRow = h('div', { class: 'kv-row' });
    engineRow.append(
      h('span', { class: 'kv-label', text: 'Engine entry' }),
      h('span', { class: 'kv-value grow', text: meta.engineEntry, title: meta.engineEntry }),
      h('button', { class: 'btn small', text: 'Copy', onclick: () => copyText(meta!.engineEntry, 'Path copied') })
    );

    const quitBtn = h('button', { class: 'btn danger' });
    quitBtn.innerHTML = `${svgIcon('power', 13)}<span>Quit LAZY SQL</span>`;
    quitBtn.addEventListener('click', () => void quitApp());

    const clearLogsBtn = h('button', { class: 'btn danger' });
    clearLogsBtn.innerHTML = `${svgIcon('trash', 13)}<span>Clear execution logs</span>`;
    clearLogsBtn.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete the entire execution history (execution-log.jsonl)?', {
        title: 'Clear execution logs',
        confirmLabel: 'Clear',
        danger: true
      });
      if (!ok) return;
      try {
        await ctx.engine.clearLogs();
        toast('Execution logs cleared', 'ok');
        void load();
      } catch (error) {
        toast((error as Error).message, 'error');
      }
    });

    container.append(
      crumb('APP', 'Settings'),
      h('h1', { class: 'page-title', text: 'Settings' }),
      h('p', { class: 'page-sub', html: 'Everything is stored locally in <b>~/.lazy-sql</b>.' }),

      h(
        'div',
        { class: 'card' },
        h('span', { class: 'card-title', text: 'Review behavior' }),
        formLine('Review timeout', 'Auto-reject a review after this long.', timeoutInput),
        toggleLine('Fallback to browser', 'Open reviews in the browser when the desktop app is not installed.', settings.fallbackToBrowser, (next) =>
          save({ fallbackToBrowser: next }, next ? 'Browser fallback enabled' : 'Browser fallback disabled')
        ),
        formLine('Desktop app path', 'Override where the review dialog binary lives (auto-detected by default).', h('span', { class: 'row', style: 'gap:8px' }, appPathInput, browseBtn, savePathBtn)),
        formLine('Default row cap', 'Cap when execute_sql omits maxRows.', maxRowsInput)
      ),

      h(
        'div',
        { class: 'card' },
        h('span', { class: 'card-title', text: 'Engine & storage' }),
        dataDirRow,
        engineRow,
        h(
          'div',
          { class: 'kv-row' },
          h('span', { class: 'kv-label', text: 'Runtime' }),
          h('span', { class: 'kv-value grow', text: `Node ${meta.node} · engine v${meta.version}${IS_TAURI ? ' · desktop shell' : ' · web dev mode'}` })
        ),
        h(
          'div',
          { class: 'kv-row' },
          h('span', { class: 'kv-label', text: 'Execution log size' }),
          h('span', { class: 'kv-value grow', text: `${(meta.logStats.bytes / 1024).toFixed(1)} KB — capped at 10 MB, keeps the last 5000 entries` }),
          clearLogsBtn
        )
      ),

      h(
        'div',
        { class: 'card' },
        h('span', { class: 'card-title', text: 'Application' }),
        toggleLine('Close button hides to tray', 'Keep running in the tray on close.', settings.closeToTray, (next) =>
          save({ closeToTray: next }, next ? 'Close-to-tray enabled' : 'Close-to-tray disabled — closing quits LAZY SQL')
        ),
        formLine('Quit', 'Stop the app and its engine process.', quitBtn)
      ),

      h(
        'div',
        { class: 'card subtle' },
        h('span', { class: 'card-title', text: 'Security notes' }),
        h('p', { class: 'card-sub', html: 'Passwords are stored locally (0600). Prefer <b>${ENV_VAR}</b> for real secrets. The local API is token-guarded and bound to 127.0.0.1.' })
      )
    );
  }

  async function load(): Promise<void> {
    try {
      const payload = await ctx.engine.settings();
      settings = payload.settings;
      meta = { dataDir: payload.dataDir, engineEntry: payload.engineEntry, node: payload.node, version: payload.version, logStats: payload.logStats };
      render();
      void setCloseToTray(settings.closeToTray);
    } catch (error) {
      container.replaceChildren(h('div', { class: 'empty', text: (error as Error).message }));
    }
  }

  void load();

  return { el: container, refresh: () => void load() };
}
