// @ts-check
/**
 * Settings → Memory tab (Memory PR #5 — first Preact + htm consumer).
 *
 * Thin lifecycle surface around the Preact tree in
 * `./memory-tab/MemoryTab.js`. The settings-manager calls
 * `mountMemoryTab()` when the user activates the Memory tab and
 * `unmountMemoryTab()` when the modal closes.
 *
 * Why a wrapper exists instead of importing `mountPreact` directly in
 * settings-manager: the tree subscribes to `MEMORY_EVENTS` on mount and
 * unsubscribes via Preact effect-cleanup on unmount. Centralizing the
 * mount root and the cleanup fn here keeps the EventBus-subscription
 * window pinned to a single open/close cycle of the modal — no leaked
 * listeners across sessions.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm is allowed for new
 * state-heavy surfaces from 1.3.0 onward. Memory tab is the first target.
 *
 * @since 1.3.0 (Memory PR #5)
 * @module settings/memory-tab
 */

import { mountPreact } from '../utils/preact-mount.js';
import { registerOnActivate, registerOnClose } from './tab-activation-registry.js';

const ROOT_ID = 'memoryTabRoot';

/** @type {(() => void) | null} Preact cleanup fn returned by `mountPreact`. */
let _cleanup = null;

/** @type {boolean} Concurrency guard for the async mount. */
let _mounting = false;

/**
 * Mount the Memory tab Preact tree into `#memoryTabRoot`. Idempotent —
 * subsequent calls while a tree is already mounted are a no-op. Resolves
 * when the first render commits (i.e., the user can interact).
 *
 * `MemoryTab.js` is loaded via dynamic import so a Preact bundle/CDN
 * load failure (top-level await inside MemoryTab.js) doesn't cascade
 * into settings-manager's import graph at boot.
 *
 * @returns {Promise<void>}
 */
export async function mountMemoryTab() {
    if (_cleanup || _mounting) return;
    const root = document.getElementById(ROOT_ID);
    if (!root) {
        console.warn(`[memory-tab] mount target #${ROOT_ID} not found in DOM; was settings-tabs.html injected?`);
        return;
    }
    _mounting = true;
    try {
        const { MemoryTab } = await import('./memory-tab/MemoryTab.js');
        _cleanup = await mountPreact(root, MemoryTab, {});
    } catch (err) {
        console.error('[memory-tab] mount failed:', err);
        root.innerHTML = '<div class="mem-load-error">Failed to load Memory tab. See console for details.</div>';
    } finally {
        _mounting = false;
    }
}

/**
 * Unmount the Memory tab Preact tree. Safe to call when nothing is
 * mounted (no-op). Triggers Preact's effect-cleanup, which unsubscribes
 * from `MEMORY_EVENTS`.
 *
 * @returns {void}
 */
export function unmountMemoryTab() {
    if (!_cleanup) return;
    try { _cleanup(); } catch (err) {
        console.error('[memory-tab] unmount failed:', err);
    }
    _cleanup = null;
}

/**
 * Test seam — used by `tests/test-memory-tab.js` to assert idempotency
 * without poking at the module's private state through other means.
 *
 * @returns {boolean}
 */
export function _isMounted() {
    return _cleanup !== null;
}

// 2.44.0.2 — replaces the `tab.dataset.tab === 'tabMemory'` activate
// branch and the explicit `unmountMemoryTab()` call in `closeSettings()`
// (pre-2.44.0.2 `js/settings-manager.js`). Memory is currently the only
// tab that registers an on-close handler — `dispatchAllOnClose()` is
// nonetheless general enough that future Preact-tree tabs route here.
registerOnActivate('tabMemory', mountMemoryTab);
registerOnClose('tabMemory', unmountMemoryTab);
