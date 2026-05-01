/**
 * AI Editor — Tools Composer disable URL flag.
 *
 * Reads `?toolsCompose=off` (or `=false`, `=0`, `=disabled`) from
 * `window.location.search` once on first call and caches the result.
 * When set, `LLMTools.getToolsForRole()` short-circuits past the
 * Composer entirely — every registered tool ships per call exactly as
 * it did pre-1.3.14.
 *
 * Why this exists: 1.4.0 PR 2 (this patch) is the first PR that *changes
 * runtime behavior* on the tools track — 1.3.4 was data-only with an
 * implicit removability check ("delete `js/intelligence/tools/`"). With
 * the Composer wired into the chat path, the roadmap's removability
 * check (ROADMAP §1.4.0 line 396) requires an explicit in-product kill-
 * switch so an operator can A/B the admission against the legacy path
 * without redeploying. Same shape as `?compression=off` from the
 * compression track.
 *
 * Designed to be:
 *   - **URL-only**, no localStorage (per the same kickoff plan that gave
 *     `?compression=off` its shape; easy to share via link, easy to A/B
 *     by opening two tabs).
 *   - **Read-once**, cached for the rest of the session (no SPA
 *     navigation surprises mid-conversation).
 *   - **Logged on first detection**, so the dual-session operator sees
 *     in DevTools which mode each tab is in.
 *
 * Removability: delete this file + the 3-line guard in
 * `js/llm/api.js` `getToolsForRole()`; behavior reverts to "Composer
 * always on."
 *
 * @since 1.3.14 (kicked in alongside the Tools Composer to satisfy the
 *   §1.4.0 removability check without redeploying).
 */

/** Cached result. `null` = unread; boolean = read. */
let _disabledCache = null;

/**
 * @returns {boolean} true if `?toolsCompose=off` (or `=false` / `=0` / `=disabled`) is in the URL.
 */
function _readFlag() {
    try {
        if (typeof window === 'undefined' || !window.location || !window.location.search) {
            return false;
        }
        const params = new URLSearchParams(window.location.search);
        const v = (params.get('toolsCompose') || '').trim().toLowerCase();
        return v === 'off' || v === 'false' || v === '0' || v === 'disabled';
    } catch {
        return false;
    }
}

/**
 * Whether the URL flag is set. Cached on first call.
 *
 * @returns {boolean}
 */
export function isToolsComposeDisabled() {
    if (_disabledCache === null) {
        _disabledCache = _readFlag();
        if (_disabledCache && typeof console !== 'undefined') {
            console.log(
                '[AI Editor] Tools Composer DISABLED via ?toolsCompose=off — ' +
                'every registered tool ships per call (pre-1.3.14 baseline). ' +
                'Use this tab as the control side of the dual-session A/B; ' +
                'the LLM debug modal\'s "Tools" count is directly comparable ' +
                'to the no-flag tab.'
            );
        }
    }
    return _disabledCache;
}

/**
 * Test seam: clear the cache so the next `isToolsComposeDisabled()` call
 * re-reads from `window.location.search`. Used by
 * `tests/test-tools-composer.mjs` to exercise multiple URL fixtures
 * within one process.
 */
export function _resetCacheForTests() {
    _disabledCache = null;
}
