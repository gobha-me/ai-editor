// @ts-check
/**
 * Test-loop UI surfaces (1.4.5).
 *
 * Two pieces of DOM:
 *
 *   1. **Trigger button** (`#btnTestLoop` in `html/chat-panel.html`) — visible
 *      only on the coder profile and only when `State.settings.testLoop.enabled`.
 *      Clicking opens a small inline form below the chat input where the user
 *      enters a goal + optional test-file hint, then starts the loop.
 *
 *   2. **Progress card** — appended to the chat-messages stream while a loop
 *      is in flight. Shows iteration N/M, current sub-state, last commit/CI,
 *      and an Abort button. On loop completion the card collapses to a
 *      one-line summary expandable by chevron.
 *
 * Both surfaces re-render in response to `loop:state-changed` from
 * `./state.js`. The orchestrator is invoked from this module with the
 * `runChatTurn` callback wired to `handleGeneralRequest` (chat send-path).
 */

import { State, EventBus } from '../../core.js';
import { handleGeneralRequest } from '../../chat/handlers.js';
import { runTestLoop } from './orchestrator.js';
import * as LoopState from './state.js';

const BTN_ID = 'btnTestLoop';
const FORM_ID = 'testLoopForm';
const CARD_ID_PREFIX = 'test-loop-card-';

let _formOpen = false;
let _activeCardId = /** @type {string|null} */ (null);

/**
 * Mount the trigger button visibility wiring + form / card subscriptions.
 * Called once at boot from `js/app.js`.
 */
export function installTestLoopUi() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) {
        console.warn('[test-loop] Trigger button not found; UI not installed.');
        return;
    }
    btn.addEventListener('click', _toggleForm);

    // Visibility tracks role + setting.
    const refreshVisibility = () => {
        const enabled = !!State.settings?.testLoop?.enabled;
        const isCoder = State.settings?.role === 'coder';
        btn.style.display = enabled && isCoder ? '' : 'none';
        if (!(enabled && isCoder)) _closeForm();
    };
    refreshVisibility();
    EventBus.on('settings:changed', refreshVisibility);
    EventBus.on('settings:loaded', refreshVisibility);
    EventBus.on('workspaceSettings:changed', refreshVisibility);

    // Loop card subscriptions.
    EventBus.on('loop:state-changed', _onLoopStateChanged);
}

function _toggleForm() {
    if (_formOpen) _closeForm();
    else _openForm();
}

function _openForm() {
    if (document.getElementById(FORM_ID)) return;
    const inputArea = document.querySelector('.chat-input-area');
    if (!inputArea) return;

    const draftEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('chatInput'));
    const initialGoal = draftEl?.value?.trim() || '';

    const form = document.createElement('div');
    form.id = FORM_ID;
    form.className = 'test-loop-form';
    form.innerHTML = `
      <div class="test-loop-form__title">Test-driven loop</div>
      <label class="test-loop-form__label" for="testLoopGoal">Goal</label>
      <textarea id="testLoopGoal" rows="2" placeholder="e.g. make tests/test-foo.mjs pass">${_escape(initialGoal)}</textarea>
      <label class="test-loop-form__label" for="testLoopHint">Failing test path (optional)</label>
      <input id="testLoopHint" type="text" placeholder="tests/test-foo.mjs">
      <div class="test-loop-form__bounds" id="testLoopBoundsLine"></div>
      <div class="test-loop-form__actions">
        <button type="button" id="testLoopCancel" class="btn-secondary">Cancel</button>
        <button type="button" id="testLoopStart" class="btn-primary">Start loop</button>
      </div>
    `;
    inputArea.appendChild(form);
    _formOpen = true;

    _renderBoundsLine(form.querySelector('#testLoopBoundsLine'));
    form.querySelector('#testLoopCancel')?.addEventListener('click', _closeForm);
    form.querySelector('#testLoopStart')?.addEventListener('click', _onStartClicked);
    /** @type {HTMLTextAreaElement|null} */ (form.querySelector('#testLoopGoal'))?.focus();
}

function _closeForm() {
    document.getElementById(FORM_ID)?.remove();
    _formOpen = false;
}

function _renderBoundsLine(el) {
    if (!el) return;
    const cfg = State.settings?.testLoop || {};
    const max = cfg.maxIterations ?? 10;
    const wall = cfg.maxWallClockMinutes ?? 30;
    const tok = cfg.maxTokensPerIteration ?? 8000;
    el.textContent = `Bounds: ${max} iterations · ${wall} min wall-clock · ${tok} tokens/iter (Settings → Test Loop to change)`;
}

async function _onStartClicked() {
    const goalEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('testLoopGoal'));
    const hintEl = /** @type {HTMLInputElement|null} */ (document.getElementById('testLoopHint'));
    const goal = goalEl?.value?.trim() || '';
    const testHint = hintEl?.value?.trim() || null;
    if (!goal) {
        goalEl?.focus();
        return;
    }
    _closeForm();

    try {
        await runTestLoop({
            goal,
            testHint,
            runChatTurn: async (prompt, _chatOptions) => {
                // Reuse the existing chat turn pipeline — the orchestrator's
                // prompt enters as if the user typed it, so all tool admission
                // / streaming / cost recording behaves identically.
                await handleGeneralRequest(prompt);
            },
        });
    } catch (err) {
        console.error('[test-loop] runTestLoop failed:', err);
        EventBus.emit('toast', { type: 'error', message: `Test loop failed: ${err.message || String(err)}` });
    }
}

function _onLoopStateChanged(state) {
    if (!state) return;
    if (state.status === 'idle') {
        // No card to render for idle.
        _activeCardId = null;
        return;
    }
    if (!_activeCardId || _activeCardId !== `${CARD_ID_PREFIX}${state.loopId}`) {
        _activeCardId = `${CARD_ID_PREFIX}${state.loopId}`;
        _ensureCard(_activeCardId);
    }
    _renderCard(_activeCardId, state);
}

function _ensureCard(cardId) {
    if (document.getElementById(cardId)) return;
    const messages = document.getElementById('chatMessages');
    if (!messages) return;
    const card = document.createElement('div');
    card.id = cardId;
    card.className = 'message message-tool test-loop-card';
    messages.appendChild(card);
    messages.scrollTop = messages.scrollHeight;
}

function _renderCard(cardId, state) {
    const card = document.getElementById(cardId);
    if (!card) return;

    const finished = state.status === 'finished';
    const ciBadge = state.lastCiState ? `<span class="test-loop-card__ci test-loop-card__ci--${_safeClass(state.lastCiState)}">CI: ${_escape(state.lastCiState)}</span>` : '';
    const summaryLine = finished
        ? _escape(`Loop ${_humanExitReason(state.exitReason)} after ${state.iteration} iteration${state.iteration === 1 ? '' : 's'} in ${_humanDuration(state.startedAt, state.finishedAt)}`)
        : _escape(`Iteration ${state.iteration}/${state.maxIterations} — ${_humanStatus(state.status)}`);
    const abortBtn = finished
        ? `<button type="button" class="btn-secondary test-loop-card__dismiss" data-loop-action="dismiss">Dismiss</button>`
        : `<button type="button" class="btn-secondary test-loop-card__abort" data-loop-action="abort">Abort</button>`;

    card.innerHTML = `
      <div class="test-loop-card__header">
        <span class="test-loop-card__icon" aria-hidden="true">🔁</span>
        <span class="test-loop-card__summary">${summaryLine}</span>
        ${ciBadge}
        ${abortBtn}
      </div>
      <div class="test-loop-card__body">
        <div class="test-loop-card__row"><strong>Goal:</strong> ${_escape(state.goal || '')}</div>
        ${state.testHint ? `<div class="test-loop-card__row"><strong>Test:</strong> <code>${_escape(state.testHint)}</code></div>` : ''}
        ${state.lastCommitSha ? `<div class="test-loop-card__row"><strong>Last commit:</strong> <code>${_escape(state.lastCommitSha.slice(0, 8))}</code></div>` : ''}
        ${state.lastCiSummary ? `<div class="test-loop-card__row"><strong>CI:</strong> ${_escape(state.lastCiSummary)}</div>` : ''}
      </div>
    `;

    card.querySelector('[data-loop-action="abort"]')?.addEventListener('click', () => {
        LoopState.requestAbort();
    });
    card.querySelector('[data-loop-action="dismiss"]')?.addEventListener('click', () => {
        LoopState.reset();
        card.remove();
    });
}

function _humanStatus(status) {
    if (status === 'iterating') return 'editing & committing';
    if (status === 'awaiting_ci') return 'awaiting CI';
    if (status === 'finished') return 'finished';
    return status;
}

function _humanExitReason(reason) {
    switch (reason) {
        case 'ci_pass': return 'succeeded';
        case 'ci_fail': return 'gave up after CI failure';
        case 'no_progress': return 'stopped (no commits made)';
        case 'max_iterations': return 'hit the iteration cap';
        case 'wall_clock': return 'hit the wall-clock cap';
        case 'user_abort': return 'aborted by you';
        case 'error': return 'errored out';
        default: return reason || 'finished';
    }
}

function _humanDuration(start, end) {
    if (!start || !end) return '–';
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m ${r}s`;
}

function _safeClass(s) {
    return String(s).replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function _escape(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Test seam.
export const __test__ = {
    _humanStatus,
    _humanExitReason,
    _humanDuration,
    _escape,
};
