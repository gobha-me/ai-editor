// @ts-check
/**
 * Chat consent card — mount wrapper around the
 * `MemoryConsentCard` Preact component (Memory PR #6, Touch 1 Flow 1).
 *
 * Mirrors `js/settings/memory-tab.js` (the PR #5 precedent) but takes a
 * caller-supplied root element rather than looking up a fixed id, because
 * each consent card is mounted into a freshly-created chat-message slot
 * (one per `agent_proposed` proposal). `messages.js` owns the slot DOM
 * and the cleanup map; this module owns the Preact lifecycle.
 *
 * Decision §9 (`docs/ROADMAP.md`): Preact + htm is allowed for new
 * state-heavy surfaces from 1.3.0 onward. The consent card is the second
 * Preact consumer (Memory tab was first); the active-tools chip row
 * (1.4.0) and profile picker (2.0) follow.
 *
 * @since 1.3.0 (Memory PR #6)
 * @module chat/consent-card
 */

import { mountPreact } from '../utils/preact-mount.js';

/**
 * Track active mounts by root element so `_isMounted` can answer cheaply
 * and `unmountAll` can drain the entire registry on chat clear without
 * the caller passing every root back. WeakMap so a removed slot can be
 * garbage-collected even before unmount runs.
 *
 * @type {WeakMap<HTMLElement, () => void>}
 */
const _mounts = new WeakMap();

/**
 * Strong-reference set of currently-mounted roots, in insertion order.
 * `unmountAll` iterates this; `mountConsentCard` adds and `cleanup`
 * removes. WeakMap alone wouldn't let us iterate. Set holds the same
 * roots as keys in `_mounts`.
 *
 * @type {Set<HTMLElement>}
 */
const _activeRoots = new Set();

/** Concurrency guard so a duplicate mount call while loading is a no-op. */
const _mounting = new WeakSet();

/**
 * Mount the consent-card Preact tree into `rootEl`. Idempotent per root —
 * calling twice on the same `rootEl` while the first mount is alive is a
 * no-op (the second call resolves to undefined, the original cleanup is
 * still the canonical one).
 *
 * `MemoryConsentCard.js` is loaded via dynamic import so a Preact bundle/
 * CDN load failure doesn't cascade into messages.js's import graph at
 * boot. On import or render failure we fall back to a vanilla error
 * banner so the user still sees that *something* was proposed.
 *
 * @param {HTMLElement} rootEl
 * @param {string} candidateId
 * @returns {Promise<void>}
 */
export async function mountConsentCard(rootEl, candidateId) {
    if (!rootEl) {
        console.warn('[consent-card] mount called with null root');
        return;
    }
    if (typeof candidateId !== 'string' || candidateId.length === 0) {
        console.warn('[consent-card] mount called without candidate_id');
        return;
    }
    if (_mounts.has(rootEl) || _mounting.has(rootEl)) return;

    _mounting.add(rootEl);
    try {
        const { MemoryConsentCard } = await import('./consent-card/MemoryConsentCard.js');
        const cleanup = await mountPreact(rootEl, MemoryConsentCard, { candidateId });
        _mounts.set(rootEl, cleanup);
        _activeRoots.add(rootEl);
    } catch (err) {
        console.error('[consent-card] mount failed:', err);
        rootEl.innerHTML = '<div class="mem-consent mem-consent--error">Memory consent card failed to load. See console for details.</div>';
    } finally {
        _mounting.delete(rootEl);
    }
}

/**
 * Run cleanup for `rootEl` if it has an active mount. Safe to call when
 * nothing is mounted (no-op).
 *
 * @param {HTMLElement} rootEl
 * @returns {void}
 */
export function unmountConsentCard(rootEl) {
    const cleanup = _mounts.get(rootEl);
    if (!cleanup) return;
    try { cleanup(); } catch (err) {
        console.error('[consent-card] unmount failed:', err);
    }
    _mounts.delete(rootEl);
    _activeRoots.delete(rootEl);
}

/**
 * Drain every active mount. Called from `messages.js` `clearChat()` and
 * `renderMessages()` *before* `chatContainer.innerHTML = ''` so Preact's
 * effect-cleanup runs while the DOM still exists. Without this, listeners
 * subscribed inside the component (EventBus, MEMORY_EVENTS) would leak
 * across conversation boundaries.
 *
 * @returns {void}
 */
export function unmountAll() {
    for (const root of Array.from(_activeRoots)) {
        unmountConsentCard(root);
    }
}

/**
 * Test seam — used by `tests/test-memory-consent-card-mount.mjs` to
 * assert idempotency without poking at the WeakMap directly.
 *
 * @param {HTMLElement} rootEl
 * @returns {boolean}
 */
export function _isMounted(rootEl) {
    return _mounts.has(rootEl);
}

/**
 * Test seam — drop every tracked mount without running cleanup. Tests
 * call this between cases so a stub mount left over from a prior case
 * doesn't pin the WeakMap entry.
 *
 * @returns {void}
 */
export function _resetForTests() {
    for (const root of Array.from(_activeRoots)) {
        _mounts.delete(root);
    }
    _activeRoots.clear();
}
