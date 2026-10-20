import { h, svgIcon, chip, copyText, toast, engineDot } from '../lib/dom';
import type { ReviewSession } from '../lib/engine';
import { decideReview, fetchReview, fetchSchema } from '../lib/engine';
import { mountSqlEditor, refreshEditorLanguage, selectedSql } from '../lib/cm';
import { renderExecutionResult } from '../lib/results';
import { hideReviewWindow, IS_TAURI } from '../lib/tauri';
import type { EditorView } from '@codemirror/view';

const DESTRUCTIVE_KEYWORDS = new Set(['DROP', 'TRUNCATE', 'DELETE']);
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'MERGE', 'REPLACE', 'UPSERT']);

function keywordChip(keyword: string): HTMLElement {
  const upper = keyword.toUpperCase();
  if (DESTRUCTIVE_KEYWORDS.has(upper)) return chip(upper, 'err');
  if (WRITE_KEYWORDS.has(upper)) return chip(upper, 'warn');
  if (upper === 'CALL' || upper === 'EXEC' || upper === 'EXECUTE') return chip(upper, 'warn');
  if (upper === 'UNKNOWN') return chip('UNSURE', 'neutral');
  return chip(upper, 'violet');
}

export function mountReviewApp(root: HTMLElement, base: string, token: string, reviewId: string): void {
  root.replaceChildren();

  const shell = h('div', { class: 'review-root' });
  const titlebar = h('div', { class: 'review-titlebar', ...(IS_TAURI ? { 'data-tauri-drag-region': '' } : {}) });
  const dragZone = h('div', { class: 'drag-zone', ...(IS_TAURI ? { 'data-tauri-drag-region': '' } : {}) });
  dragZone.innerHTML = `${svgIcon('cat', 15)}<span>LAZY SQL — Review</span>`;
  const closeBtn = h('button', { class: 'icon-btn', title: 'Hide (keeps the review pending)', html: svgIcon('x', 15) });
  closeBtn.addEventListener('click', () => void hideReviewWindow());
  titlebar.append(dragZone, closeBtn);

  const body = h('div', { class: 'review-body' });
  const footer = h('div', { class: 'review-footer' });
  shell.append(titlebar, body, footer);
  root.append(shell);

  let view: EditorView | null = null;
  let pollTimer: number | null = null;
  let countdownTimer: number | null = null;

  function stopTimers(): void {
    if (pollTimer) window.clearTimeout(pollTimer);
    if (countdownTimer) window.clearInterval(countdownTimer);
    pollTimer = null;
    countdownTimer = null;
  }

  async function load(): Promise<void> {
    let review: ReviewSession;
    try {
      review = await fetchReview(base, token, reviewId);
    } catch {
      body.replaceChildren(
        h('div', { class: 'status-panel neutral' }, h('b', { text: 'This review is no longer available.' }), h('div', { text: 'It may have expired or the agent session ended.' }))
      );
      footer.replaceChildren(h('span', { class: 'grow' }), h('button', { class: 'btn', text: 'Close', onclick: () => void hideReviewWindow() }));
      if (IS_TAURI) window.setTimeout(() => void hideReviewWindow(), 2500);
      return;
    }
    render(review);
  }

  function render(review: ReviewSession): void {
    body.replaceChildren();
    footer.replaceChildren();
    stopTimers();

    const connection = review.connection;
    const analysis = review.analysis;
    const stronglyDestructive = (analysis.keywords ?? []).some((keyword) => DESTRUCTIVE_KEYWORDS.has(keyword.toUpperCase()));

    body.append(
      h(
        'div',
        { class: 'crumb', style: 'margin-top:10px' },
        h('span', { text: `REVIEW · ${connection.name}` }),
        analysis.requiresConfirmation ? h('span', { class: 'crumb-sep', text: '→' }) : null,
        analysis.requiresConfirmation ? h('span', { class: 'crumb-tail', text: 'changes data' }) : null
      ),
      h('h1', { class: 'page-title', text: stronglyDestructive ? 'Destructive statement' : analysis.dangerous ? 'Confirm data change' : 'Confirm statement' }),
      h(
        'div',
        { class: 'row muted', style: 'gap:8px;font-size:12.5px' },
        engineDot(connection.engine),
        h('span', { text: connection.engine }),
        h('span', { class: 'mono truncate', text: connection.engine === 'sqlite' ? (connection.file ?? '') : `${connection.host}:${connection.port}/${connection.database}` })
      )
    );

    if (review.purpose) {
      body.append(h('div', { class: 'muted', style: 'margin-top:6px' }, `Purpose: ${review.purpose}`));
    }

    const meta = h('div', { class: 'review-meta' });
    for (const keyword of analysis.keywords ?? []) meta.append(keywordChip(keyword));
    if (connection.readOnly) meta.append(chip('read-only connection', 'warn'));
    body.append(meta);

    if (stronglyDestructive) {
      body.append(
        h('div', { class: 'review-banner danger' }, h('span', { html: svgIcon('alert', 15) }), h('span', { html: `<b>Destroys data or schema</b> (${analysis.keywords.join(', ')}). Check what it affects.` }))
      );
    } else if (analysis.dangerous) {
      body.append(
        h('div', { class: 'review-banner warn' }, h('span', { html: svgIcon('alert', 15) }), h('span', { html: '<b>This changes data.</b> Edit if needed — the edited SQL is what runs and gets logged.' }))
      );
    } else {
      body.append(
        h('div', { class: 'review-banner warn' }, h('span', { html: svgIcon('alert', 15) }), h('span', { html: '<b>Needs review</b> before it runs.' }))
      );
    }

    // editor
    const editorCard = h('div', { class: 'editor-card' });
    const toolbar = h('div', { class: 'editor-toolbar' });
    const schemaState = h('span', { class: 'muted', text: 'schema: loading…' });
    const copyBtn = h('button', { class: 'icon-btn', title: 'Copy SQL', html: svgIcon('copy', 14) });
    const resetBtn = h('button', { class: 'icon-btn', title: 'Reset to original SQL', html: svgIcon('refresh', 14) });
    toolbar.append(h('span', { text: 'SQL — Ctrl+Enter to run' }), h('span', { class: 'grow' }), schemaState, resetBtn, copyBtn);
    const editorHost = h('div', { class: 'editor-host' });
    editorCard.append(toolbar, editorHost);
    body.append(editorCard);

    copyBtn.addEventListener('click', () => copyText(view?.state.doc.toString() ?? review.sql, 'SQL copied'));
    resetBtn.addEventListener('click', () => {
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: review.sql } });
    });

    view = mountSqlEditor(editorHost, {
      value: review.sql,
      engine: connection.engine,
      readOnly: review.status !== 'pending',
      minHeight: '150px',
      maxHeight: '300px',
      onRun: () => void run()
    });

    fetchSchema(base, token, connection.id)
      .then((payload) => {
        schemaState.textContent = `schema: ${Object.keys(payload.schema).length} tables`;
        if (view) refreshEditorLanguage(view, payload.engine, payload.schema);
      })
      .catch(() => {
        schemaState.textContent = 'schema: unavailable';
      });

    if (review.params.length > 0) {
      const paramsLine = h('div', { class: 'params-line' }, h('span', { text: 'Params:' }));
      for (const param of review.params) paramsLine.append(h('span', { class: 'param-chip', text: JSON.stringify(param) }));
      body.append(paramsLine);
    }

    const statusHost = h('div');
    body.append(statusHost);

    // footer with countdown + actions
    const countdown = h('div', { class: 'countdown' });
    const countdownLabel = h('div', { class: 'countdown-label' });
    const countdownFill = h('div', { class: 'countdown-fill', style: 'width:100%' });
    countdown.append(countdownLabel, h('div', { class: 'countdown-track' }, countdownFill));

    const rejectBtn = h('button', { class: 'btn', text: 'Reject' });
    const runBtn = h('button', { class: 'btn primary run-btn' });
    runBtn.innerHTML = `${svgIcon('play', 14)}<span>Run query</span>`;

    async function run(): Promise<void> {
      if (!view) return;
      const sql = selectedSql(view);
      if (!sql.trim()) {
        toast('The SQL is empty.', 'error');
        return;
      }
      runBtn.disabled = true;
      rejectBtn.disabled = true;
      try {
        await decideReview(base, token, reviewId, 'approve', sql);
        // The decision is now owned by the engine session: it runs the SQL and returns the result
        // to the agent. There is nothing left for this dialog to show, so close it right away.
        stopTimers();
        await hideReviewWindow();
      } catch (error) {
        toast((error as Error).message, 'error');
        runBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    }

    rejectBtn.addEventListener('click', async () => {
      rejectBtn.disabled = true;
      runBtn.disabled = true;
      try {
        await decideReview(base, token, reviewId, 'reject');
        // nothing left to show — close with the decision
        stopTimers();
        await hideReviewWindow();
      } catch (error) {
        toast((error as Error).message, 'error');
        runBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    });

    runBtn.addEventListener('click', () => void run());

    footer.append(countdown, rejectBtn, runBtn);

    function showExecuting(): void {
      runBtn.replaceChildren(h('span', { class: 'spinner' }), h('span', { text: 'Running…' }));
      statusHost.replaceChildren(h('div', { class: 'status-panel neutral' }, h('div', { class: 'executing' }, h('span', { class: 'spinner' }), h('span', { text: 'Executing…' }))));
      stopCountdown();
    }

    function showDone(result: ReviewSession['result']): void {
      if (!result) return;
      const panel = h('div', { class: 'status-panel ok' }, h('b', { text: result.status === 'ok' ? 'Executed successfully' : `Status: ${result.status}` }));
      statusHost.replaceChildren(panel);
      const card = h('div', { class: 'card' });
      renderExecutionResult(card as HTMLElement, result);
      statusHost.append(card);
      stopCountdown();
      const closeButton = h('button', { class: 'btn primary', text: 'Close', onclick: () => void hideReviewWindow() });
      const copyButton = h('button', { class: 'btn', html: `${svgIcon('copy', 13)}<span>Copy result</span>` });
      copyButton.addEventListener('click', () => copyText(JSON.stringify(result, null, 2), 'Result JSON copied'));
      footer.replaceChildren(h('span', { class: 'grow muted', text: 'Execution logged — the agent has been notified.' }), copyButton, closeButton);
    }

    function showServerError(message: string | null, { autoClose = false } = {}): void {
      statusHost.replaceChildren(
        h('div', { class: 'status-panel error' }, h('b', { text: 'Execution failed' }), h('div', { class: 'mono', style: 'margin-top:6px;word-break:break-word;font-size:12px' }, message ?? 'Unknown error'))
      );
      stopCountdown();
      const closeButton = h('button', { class: 'btn primary', text: 'Close', onclick: () => void hideReviewWindow() });
      footer.replaceChildren(h('span', { class: 'grow' }), closeButton);
      // lost contact: the dialog has nothing to act on anymore
      if (autoClose && IS_TAURI) window.setTimeout(() => void hideReviewWindow(), 3000);
    }

    // rejected / expired reviews have nothing left to show — close the dialog right away
    function settleAndClose(): void {
      stopTimers();
      void hideReviewWindow();
    }

    function stopCountdown(): void {
      if (countdownTimer) window.clearInterval(countdownTimer);
      countdownTimer = null;
      countdownLabel.textContent = '';
      countdownFill.style.width = '0%';
    }

    function startCountdown(expiresAt: number, total: number): void {
      const tick = () => {
        const left = Math.max(0, expiresAt - Date.now());
        const seconds = Math.ceil(left / 1000);
        const minutes = Math.floor(seconds / 60);
        countdownLabel.innerHTML = `${svgIcon('clock', 12)}<span>expires in ${minutes}:${String(seconds % 60).padStart(2, '0')}</span>`;
        const percent = Math.max(0, Math.min(100, (left / total) * 100));
        countdownFill.style.width = `${percent}%`;
        countdownFill.classList.toggle('danger', percent < 20);
        if (left <= 0) settleAndClose();
      };
      tick();
      countdownTimer = window.setInterval(tick, 500);
    }

    function pollUntilResolved(): void {
      const tick = async () => {
        try {
          const fresh = await fetchReview(base, token, reviewId);
          if (fresh.status === 'pending') {
            // still waiting (e.g. our approve raced with a timeout)
            return;
          }
          if (fresh.status === 'done') {
            showDone(fresh.result);
            return;
          }
          if (fresh.status === 'error') {
            showServerError(fresh.error);
            return;
          }
          if (fresh.status === 'rejected' || fresh.status === 'timeout') {
            settleAndClose();
            return;
          }
          // approved / running → keep polling
          pollTimer = window.setTimeout(() => void tick(), 700);
        } catch {
          showServerError('Lost contact with the engine — the app session that requested this review may have ended.', {
            autoClose: true
          });
        }
      };
      void tick();
    }

    // initial state
    if (review.status === 'pending') {
      startCountdown(review.expiresAt, review.timeoutMs);
    } else if (review.status === 'done') {
      showDone(review.result);
      if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: review.sql } });
    } else if (review.status === 'error') {
      showServerError(review.error);
    } else if (review.status === 'rejected' || review.status === 'timeout') {
      settleAndClose();
    } else {
      showExecuting();
      pollUntilResolved();
    }
  }

  void load();
}
