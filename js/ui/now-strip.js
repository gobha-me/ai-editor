/**
 * Files "Now strip" — Touch 3 1.x candidate C (2.17.0).
 *
 * Tiny read-only indicator above the file tree in the Rail v2 Files view.
 * Surfaces what's "in flight" right now without making the user open
 * other panels:
 *
 *   ┌─────────────────────────────────────┐
 *   │ CHANGES  4 files            Stage…  │
 *   │ AGENT    ● 2 notes, 1 todo          │
 *   └─────────────────────────────────────┘
 *
 * Data sources (all already-shipped state — no new tracking):
 *   - Changes      = State.openTabs.filter(t => t.dirty).length
 *   - scratchpad   = Object.keys(State.scratchpad).length
 *   - todos active = State.todo.filter(in_progress|pending).length
 *   - queued       = getUserMessageQueueLength()
 *
 * The "Stage…" link calls window.openCommitModal() (already exposed).
 *
 * Refresh is event-driven — `scratchpad:changed`, `todo:changed` (newly
 * emitted by todo-tools / conversations in this same release),
 * `chat:queueChanged`, plus the existing tab/editor signals
 * (`tab:switched`, `tab:closed`, `tab:contentChanged`, `file:opened`,
 * `file:reverted`, `editor:change`). Editor keystroke flips are debounced
 * 250 ms so we don't re-render per keypress.
 *
 * Pattern mirrors `js/ui/left-pane-rail.js` (2.11.0): pure render
 * helpers (HTML-in / HTML-out, no DOM) + an idempotent `mountNowStrip()`
 * that no-ops when the host slot is missing.
 */

import { State, EventBus } from '../core.js';
import { escapeHtml } from '../utils/html.js';
import { getUserMessageQueueLength } from '../chat/state.js';

const HOST_ID = 'filesNowStrip';
const EDITOR_DEBOUNCE_MS = 250;

/**
 * Pure — read all four buckets off State + the queue accessor.
 *
 * @param {Object} state - the global State object
 * @param {number} queueLen - length from getUserMessageQueueLength()
 * @returns {{dirtyCount: number, scratchpadCount: number, todoActive: number, queuedCount: number}}
 */
export function computeNowSummary(state, queueLen) {
    const tabs = Array.isArray(state?.openTabs) ? state.openTabs : [];
    const dirtyCount = tabs.reduce((n, t) => (t && t.dirty ? n + 1 : n), 0);

    const scratch = (state && typeof state.scratchpad === 'object' && state.scratchpad)
        ? state.scratchpad : {};
    const scratchpadCount = Object.keys(scratch).length;

    const todos = Array.isArray(state?.todo) ? state.todo : [];
    const todoActive = todos.reduce((n, t) => {
        const s = t && t.status;
        return (s === 'pending' || s === 'in_progress') ? n + 1 : n;
    }, 0);

    return {
        dirtyCount,
        scratchpadCount,
        todoActive,
        queuedCount: Number.isFinite(queueLen) ? queueLen : 0,
    };
}

/**
 * Pure — format the right-hand value of the Changes row.
 *
 * @param {number} dirtyCount
 * @returns {string}
 */
export function formatChangesText(dirtyCount) {
    if (!dirtyCount) return 'clean';
    return dirtyCount === 1 ? '1 file' : `${dirtyCount} files`;
}

/**
 * Pure — format the right-hand value of the Agent row.
 *
 * Returns `"idle"` when all three buckets are empty (no dot in the row).
 * Otherwise joins only the non-zero buckets with `, ` so the row stays
 * compact in the narrow rail. The dot itself is added by the renderer
 * based on whether the bucket sum is > 0.
 *
 * @param {{scratchpadCount: number, todoActive: number, queuedCount: number}} buckets
 * @returns {string}
 */
export function formatAgentText({ scratchpadCount, todoActive, queuedCount }) {
    const parts = [];
    if (scratchpadCount > 0) {
        parts.push(`${scratchpadCount} note${scratchpadCount === 1 ? '' : 's'}`);
    }
    if (todoActive > 0) {
        parts.push(`${todoActive} todo${todoActive === 1 ? '' : 's'}`);
    }
    if (queuedCount > 0) {
        parts.push(`${queuedCount} queued`);
    }
    return parts.length === 0 ? 'idle' : parts.join(', ');
}

/**
 * Pure — render the strip's inner HTML from a precomputed summary.
 *
 * Uses `escapeHtml` defensively even though all interpolated values are
 * numbers/strings we control — guards future drift if a count ever
 * becomes a string from upstream.
 *
 * @param {{dirtyCount: number, scratchpadCount: number, todoActive: number, queuedCount: number}} summary
 * @returns {string}
 */
export function renderNowStripHtml(summary) {
    const { dirtyCount, scratchpadCount, todoActive, queuedCount } = summary;
    const changesText = escapeHtml(formatChangesText(dirtyCount));
    const stageLink = dirtyCount > 0
        ? `<button type="button" class="lp2__now-link" data-now-action="stage">Stage…</button>`
        : '';

    const agentBusy = (scratchpadCount + todoActive + queuedCount) > 0;
    const agentText = escapeHtml(formatAgentText({ scratchpadCount, todoActive, queuedCount }));
    const agentDot = agentBusy
        ? `<span class="lp2__now-val lp2__now-val--run" aria-hidden="true">●</span>`
        : '';

    return (
        `<div class="lp2__now-row">`
        + `<span class="lp2__now-label">Changes</span>`
        + `<span class="lp2__now-val">${changesText}</span>`
        + stageLink
        + `</div>`
        + `<div class="lp2__now-row">`
        + `<span class="lp2__now-label">Agent</span>`
        + agentDot
        + `<span class="lp2__now-val">${agentText}</span>`
        + `</div>`
    );
}

let _mounted = false;

/**
 * Mount the Now strip into `#filesNowStrip` and wire refresh listeners.
 *
 * Idempotent — calling twice is a no-op (event listeners are attached
 * once for the lifetime of the page). No-ops when the host slot is
 * missing, so callers don't have to guard.
 */
export function mountNowStrip() {
    if (_mounted) return;
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    _mounted = true;

    const refresh = () => {
        const summary = computeNowSummary(State, getUserMessageQueueLength());
        host.innerHTML = renderNowStripHtml(summary);
        host.hidden = false;
    };

    // Click delegation — currently just the "Stage…" link.
    host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-now-action]');
        if (!btn || !host.contains(btn)) return;
        const action = btn.getAttribute('data-now-action');
        if (action === 'stage') {
            try {
                if (typeof window !== 'undefined' && typeof window.openCommitModal === 'function') {
                    window.openCommitModal();
                }
            } catch (err) {
                console.warn('[now-strip] openCommitModal failed:', err);
            }
        }
    });

    // High-signal channels — render-on-change.
    EventBus.on('scratchpad:changed', refresh);
    EventBus.on('todo:changed', refresh);
    EventBus.on('chat:queueChanged', refresh);
    EventBus.on('tab:switched', refresh);
    EventBus.on('tab:closed', refresh);
    EventBus.on('tab:contentChanged', refresh);
    EventBus.on('file:opened', refresh);
    EventBus.on('file:reverted', refresh);

    // Editor keystrokes can flip `tab.dirty` per-press; coalesce.
    let editorTimer = null;
    EventBus.on('editor:change', () => {
        if (editorTimer) return;
        editorTimer = setTimeout(() => {
            editorTimer = null;
            refresh();
        }, EDITOR_DEBOUNCE_MS);
    });

    refresh();
}
