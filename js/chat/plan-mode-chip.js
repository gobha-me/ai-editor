// @ts-check
/**
 * Plan Mode chip — lifecycle wrapper around the `PlanModeChip` Preact
 * component (github#25, 1.10.0).
 *
 * Same shape as `js/chat/queued-input-panel.js` (1.9.1) and
 * `js/chat/scratchpad-panel.js` (1.8.4): singleton root, idempotent
 * mount/unmount, vanilla error banner on Preact load failure. The
 * component itself subscribes to `EventBus('plan-mode:changed')` to
 * re-render when the user toggles the mode (or when issue-start auto-
 * enables it).
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm allowed for new
 * state-heavy surfaces from 1.3.0 onward.
 *
 * @since 1.10.0 (github#25)
 * @module chat/plan-mode-chip
 */

import { mountPreact } from '../utils/preact-mount.js';

const ROOT_ID = 'planModeChipRoot';

/** @type {(() => void) | null} Preact cleanup fn returned by `mountPreact`. */
let _cleanup = null;

/** @type {boolean} Concurrency guard for the async mount. */
let _mounting = false;

/**
 * Mount the Plan Mode chip into `#planModeChipRoot`. Idempotent.
 *
 * @returns {Promise<void>}
 */
export async function mountPlanModeChip() {
    if (_cleanup || _mounting) return;
    const root = document.getElementById(ROOT_ID);
    if (!root) {
        console.warn(`[plan-mode-chip] mount target #${ROOT_ID} not found in DOM; was chat-panel.html injected?`);
        return;
    }
    _mounting = true;
    try {
        const { PlanModeChip } = await import('./plan-mode-chip/PlanModeChip.js');
        _cleanup = await mountPreact(root, PlanModeChip, {});
    } catch (err) {
        console.error('[plan-mode-chip] mount failed:', err);
        root.innerHTML = '<div class="plan-mode-chip-load-error">Failed to load Plan Mode chip. See console for details.</div>';
    } finally {
        _mounting = false;
    }
}

/**
 * Unmount the chip. Safe when nothing is mounted.
 *
 * @returns {void}
 */
export function unmountPlanModeChip() {
    if (!_cleanup) return;
    try { _cleanup(); } catch (err) {
        console.error('[plan-mode-chip] unmount failed:', err);
    }
    _cleanup = null;
}

/**
 * Test seam.
 *
 * @returns {boolean}
 */
export function _isMounted() {
    return _cleanup !== null;
}
