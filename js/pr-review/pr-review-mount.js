// @ts-check
/**
 * PR Review surface — vanilla mount/unmount + middle-pane stage seam.
 *
 * The middle pane (`<main class="editor-panel">`) normally hosts the
 * CodeMirror editor (`#editorContainer`) plus its tab strip and status
 * bar. The PR Review surface needs the whole pane: file tree on the
 * left, side-by-side diff in the center, its own back/status chrome.
 *
 * Two seams considered:
 *   A. Pseudo-tab in `#editorTabs` — rejected: PR review's own chrome
 *      conflicts with the file-tab strip.
 *   B. Stage-swap — peer `<div id="prReviewMount">` next to
 *      `#editorContainer` inside `#editorSplit`. `body.pr-review-active`
 *      hides `.editor-tabs-bar` + `.editor-status` via CSS while the
 *      surface is mounted. The CodeMirror instance is untouched —
 *      no destroy, no re-create, no scroll-state loss.
 *
 * This module owns the seam (B): one active surface at a time, push
 * `history.state.prReview = n` so browser-back closes cleanly,
 * `try/finally` guarantees `body.pr-review-active` clears even if
 * Preact render throws.
 *
 * @since 2.12.0 (Touch 3 PR Review surface — slice 1)
 * @module pr-review/pr-review-mount
 */

import { State } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';
import { PrReviewSurface } from './PrReviewSurface.js';

const MOUNT_ID = 'prReviewMount';
const BODY_ACTIVE_CLASS = 'pr-review-active';

let _activeMount = null;
let _activePrNumber = null;

/**
 * Open the PR Review surface for `prNumber`. Idempotent — calling
 * twice with the same number is a no-op; calling with a different
 * number swaps the active surface in place.
 *
 * @param {number} prNumber
 */
export async function openPrReview(prNumber) {
    if (!State.currentProject) {
        console.warn('[pr-review] openPrReview: no current project');
        return;
    }
    const mountEl = document.getElementById(MOUNT_ID);
    if (!mountEl) {
        console.error('[pr-review] openPrReview: #' + MOUNT_ID + ' not found in DOM');
        return;
    }

    // Same PR already open → noop. Different PR → swap by tearing
    // down the active mount first; render will re-init from props.
    if (_activePrNumber === prNumber && _activeMount) return;
    if (_activeMount) {
        try { _activeMount(); } catch (e) { console.warn('[pr-review] cleanup during swap:', e); }
        _activeMount = null;
    }

    const { owner, repo } = State.currentProject;

    try {
        document.body.classList.add(BODY_ACTIVE_CLASS);
        mountEl.hidden = false;
        _activePrNumber = prNumber;

        // Push a history entry so the browser back-button + Esc both
        // route through `closePrReview`. `popstate` listener is wired
        // in app.js — it calls closePrReview without re-pushing.
        try {
            const state = { ...(history.state || {}), prReview: prNumber };
            history.pushState(state, '', location.href);
        } catch { /* history API can fail in some sandbox modes; non-fatal */ }

        _activeMount = await mountPreact(mountEl, PrReviewSurface, {
            owner,
            repo,
            prNumber,
            onClose: () => closePrReview()
        });
    } catch (e) {
        // Stage-seam recovery antibody: never leave the editor pane
        // hidden if mount throws. Reverses everything `try` set.
        console.error('[pr-review] mount failed:', e);
        document.body.classList.remove(BODY_ACTIVE_CLASS);
        if (mountEl) mountEl.hidden = true;
        _activeMount = null;
        _activePrNumber = null;
        throw e;
    }
}

/**
 * Close the active PR Review surface and restore the editor pane.
 * Idempotent.
 *
 * @param {{popstate?: boolean}} [opts]  When called from a popstate
 *   handler, skip the `history.back()` (otherwise we'd loop).
 */
export function closePrReview(opts = {}) {
    if (!_activeMount && !_activePrNumber) return;
    try {
        if (_activeMount) _activeMount();
    } catch (e) {
        console.warn('[pr-review] cleanup error (non-fatal):', e);
    } finally {
        _activeMount = null;
        _activePrNumber = null;
        document.body.classList.remove(BODY_ACTIVE_CLASS);
        const mountEl = document.getElementById(MOUNT_ID);
        if (mountEl) mountEl.hidden = true;

        if (!opts.popstate) {
            try {
                if (history.state && history.state.prReview != null) {
                    history.back();
                }
            } catch { /* non-fatal */ }
        }
    }
}

/**
 * @returns {boolean} Whether a PR Review surface is currently mounted.
 */
export function isPrReviewActive() {
    return _activeMount != null;
}

/**
 * Internal: which PR is currently open (or null).
 * Used by app.js popstate handler to decide whether to close.
 */
export function getActivePrNumber() {
    return _activePrNumber;
}
