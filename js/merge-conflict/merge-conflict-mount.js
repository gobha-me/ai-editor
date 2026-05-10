// @ts-check
/**
 * Merge Conflict Resolver — vanilla mount/unmount + middle-pane stage seam.
 *
 * Mirrors [`js/pr-review/pr-review-mount.js`] (2.12.0). One active surface
 * at a time; `body.merge-conflict-active` hides the editor chrome + PR
 * Review while the resolver is up. The CodeMirror instance is untouched.
 *
 * The resolver is normally opened *from* the PR Review surface (the
 * "Resolve conflicts" button on the merge controls). On close we emit
 * `prs:refresh` so the PR Review surface re-fetches and the
 * `mergeable: false → true` transition flows through; we do NOT
 * automatically re-open PR Review here — the user lands back on the
 * editor pane and reopens the PR from the Rail v2 PRs list when they're
 * ready to merge.
 *
 * @since 2.18.0 (Touch 3 Merge Conflict Resolver — slice 1)
 * @module merge-conflict/merge-conflict-mount
 */

import { State } from '../core.js';
import { mountPreact } from '../utils/preact-mount.js';
import { MergeConflictSurface } from './MergeConflictSurface.js';

const MOUNT_ID = 'mergeConflictMount';
const BODY_ACTIVE_CLASS = 'merge-conflict-active';

let _activeMount = null;
let _activePrNumber = null;

/**
 * Open the resolver for `prNumber`. Idempotent — repeat calls with the
 * same number are no-ops; different number swaps in place.
 *
 * @param {number} prNumber
 */
export async function openMergeConflict(prNumber) {
    if (!State.currentProject) {
        console.warn('[merge-conflict] openMergeConflict: no current project');
        return;
    }
    const mountEl = document.getElementById(MOUNT_ID);
    if (!mountEl) {
        console.error('[merge-conflict] openMergeConflict: #' + MOUNT_ID + ' not found in DOM');
        return;
    }
    if (_activePrNumber === prNumber && _activeMount) return;
    if (_activeMount) {
        try { _activeMount(); } catch (e) { console.warn('[merge-conflict] cleanup during swap:', e); }
        _activeMount = null;
    }

    const { owner, repo } = State.currentProject;

    try {
        document.body.classList.add(BODY_ACTIVE_CLASS);
        mountEl.hidden = false;
        _activePrNumber = prNumber;

        try {
            const state = { ...(history.state || {}), mergeConflict: prNumber };
            history.pushState(state, '', location.href);
        } catch { /* non-fatal */ }

        _activeMount = await mountPreact(mountEl, MergeConflictSurface, {
            owner,
            repo,
            prNumber,
            onClose: () => closeMergeConflict()
        });
    } catch (e) {
        console.error('[merge-conflict] mount failed:', e);
        document.body.classList.remove(BODY_ACTIVE_CLASS);
        if (mountEl) mountEl.hidden = true;
        _activeMount = null;
        _activePrNumber = null;
        throw e;
    }
}

/**
 * Close the active resolver. Idempotent.
 *
 * @param {{popstate?: boolean}} [opts]  When called from a popstate
 *   handler, skip the `history.back()` (otherwise we'd loop).
 */
export function closeMergeConflict(opts = {}) {
    if (!_activeMount && !_activePrNumber) return;
    try {
        if (_activeMount) _activeMount();
    } catch (e) {
        console.warn('[merge-conflict] cleanup error (non-fatal):', e);
    } finally {
        _activeMount = null;
        _activePrNumber = null;
        document.body.classList.remove(BODY_ACTIVE_CLASS);
        const mountEl = document.getElementById(MOUNT_ID);
        if (mountEl) mountEl.hidden = true;

        if (!opts.popstate) {
            try {
                if (history.state && history.state.mergeConflict != null) {
                    history.back();
                }
            } catch { /* non-fatal */ }
        }
    }
}

/** @returns {boolean} */
export function isMergeConflictActive() {
    return _activeMount != null;
}

/** Internal — used by app.js popstate handler. */
export function getActivePrNumber() {
    return _activePrNumber;
}
