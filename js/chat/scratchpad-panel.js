// @ts-check
/**
 * Chat scratchpad visibility panel — lifecycle wrapper around the
 * `ScratchpadPanel` Preact component (github#34, 1.8.4).
 *
 * Mirrors `js/settings/memory-tab.js` — singleton root, idempotent
 * mount/unmount, vanilla error banner on Preact load failure. The
 * component subscribes to `EventBus('scratchpad:changed')` and
 * `EventBus('conversation:loaded'|'conversation:created')` itself; this
 * wrapper just owns the slot lookup and the Preact cleanup fn.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm allowed for new
 * state-heavy surfaces from 1.3.0 onward. Scratchpad panel joins Memory
 * tab, consent card, and the @memory chip on that list.
 *
 * @since 1.8.4 (github#34)
 * @module chat/scratchpad-panel
 */

import { mountPreact } from '../utils/preact-mount.js';

const ROOT_ID = 'scratchpadPanelRoot';

/** @type {(() => void) | null} Preact cleanup fn returned by `mountPreact`. */
let _cleanup = null;

/** @type {boolean} Concurrency guard for the async mount. */
let _mounting = false;

/**
 * Mount the scratchpad panel Preact tree into `#scratchpadPanelRoot`.
 * Idempotent — subsequent calls while a tree is already mounted are a
 * no-op. Resolves when the first render commits.
 *
 * `ScratchpadPanel.js` is loaded via dynamic import so a Preact bundle/
 * CDN load failure doesn't cascade into chat/index.js's import graph at
 * boot.
 *
 * @returns {Promise<void>}
 */
export async function mountScratchpadPanel() {
    if (_cleanup || _mounting) return;
    const root = document.getElementById(ROOT_ID);
    if (!root) {
        console.warn(`[scratchpad-panel] mount target #${ROOT_ID} not found in DOM; was chat-panel.html injected?`);
        return;
    }
    _mounting = true;
    try {
        const { ScratchpadPanel } = await import('./scratchpad-panel/ScratchpadPanel.js');
        _cleanup = await mountPreact(root, ScratchpadPanel, {});
    } catch (err) {
        console.error('[scratchpad-panel] mount failed:', err);
        root.innerHTML = '<div class="scratchpad-load-error">Failed to load scratchpad panel. See console for details.</div>';
    } finally {
        _mounting = false;
    }
}

/**
 * Unmount the scratchpad panel Preact tree. Safe to call when nothing is
 * mounted (no-op). Triggers Preact's effect-cleanup, which unsubscribes
 * the EventBus listeners.
 *
 * @returns {void}
 */
export function unmountScratchpadPanel() {
    if (!_cleanup) return;
    try { _cleanup(); } catch (err) {
        console.error('[scratchpad-panel] unmount failed:', err);
    }
    _cleanup = null;
}

/**
 * Test seam — used by `tests/test-scratchpad-panel.js` to assert
 * idempotency without poking at the module's private state directly.
 *
 * @returns {boolean}
 */
export function _isMounted() {
    return _cleanup !== null;
}
