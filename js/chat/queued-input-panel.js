// @ts-check
/**
 * Queued user input panel — lifecycle wrapper around the
 * `QueuedInputPanel` Preact component (github#33 Phase 2, 1.9.1).
 *
 * Mirrors `js/chat/scratchpad-panel.js` (1.8.4) — singleton root,
 * idempotent mount/unmount, vanilla error banner on Preact load
 * failure. The component subscribes to `EventBus('chat:queueChanged')`
 * itself; this wrapper just owns the slot lookup and the cleanup fn.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm allowed for new
 * state-heavy surfaces from 1.3.0 onward.
 *
 * @since 1.9.1 (github#33 Phase 2)
 * @module chat/queued-input-panel
 */

import { mountPreact } from '../utils/preact-mount.js';

const ROOT_ID = 'queuedInputPanelRoot';

/** @type {(() => void) | null} Preact cleanup fn returned by `mountPreact`. */
let _cleanup = null;

/** @type {boolean} Concurrency guard for the async mount. */
let _mounting = false;

/**
 * Mount the queued-input panel into `#queuedInputPanelRoot`. Idempotent.
 *
 * @returns {Promise<void>}
 */
export async function mountQueuedInputPanel() {
    if (_cleanup || _mounting) return;
    const root = document.getElementById(ROOT_ID);
    if (!root) {
        console.warn(`[queued-input-panel] mount target #${ROOT_ID} not found in DOM; was chat-panel.html injected?`);
        return;
    }
    _mounting = true;
    try {
        const { QueuedInputPanel } = await import('./queued-input-panel/QueuedInputPanel.js');
        _cleanup = await mountPreact(root, QueuedInputPanel, {});
    } catch (err) {
        console.error('[queued-input-panel] mount failed:', err);
        root.innerHTML = '<div class="queued-input-load-error">Failed to load queued-input panel. See console for details.</div>';
    } finally {
        _mounting = false;
    }
}

/**
 * Unmount the queued-input panel. Safe to call when nothing is mounted.
 *
 * @returns {void}
 */
export function unmountQueuedInputPanel() {
    if (!_cleanup) return;
    try { _cleanup(); } catch (err) {
        console.error('[queued-input-panel] unmount failed:', err);
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
