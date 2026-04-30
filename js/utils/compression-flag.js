/**
 * AI Editor — Tier 2 compression-disable URL flag.
 *
 * Reads `?compression=off` (or `=false`, `=0`) from `window.location.search`
 * once on first call and caches the result. When set, the
 * `chat/compactor-integration.js` seam short-circuits past the Compactor
 * entirely — chat messages flow straight into `ChatSummarizer.getContextMessages()`
 * exactly as they did pre-1.2.0.
 *
 * Why this exists: ROADMAP Decision §8 gates compression follow-ups on
 * **measured savings** from the cost dashboard, not calendar time. With
 * light usage on `editor.gobha.ai`, organic dashboard data accumulates
 * slowly. This flag enables a deterministic A/B: open two tabs, one
 * with the flag and one without, run the same 50-turn synthetic session
 * (mirroring `tests/test-compression-synthetic-savings.mjs` Scenario 5),
 * compare the per-conversation totals on Settings → Cost. The synthetic
 * baseline is 90.3% reduction on that fixture; the deployed dashboard
 * should land near it. If it lands materially lower, the deployed
 * Compactor is mis-wired or organic input doesn't match the synthetic
 * shape — either is worth digging into before Rule 3 ships.
 *
 * Designed to be:
 *   - **URL-only**, no localStorage (per kickoff plan; easy to share via
 *     link, easy to A/B by opening two tabs).
 *   - **Read-once**, cached for the rest of the session (no SPA
 *     navigation surprises mid-conversation).
 *   - **Logged on first detection**, so the dual-session operator sees
 *     in DevTools which mode each tab is in.
 *
 * Removability: delete this file + the 4-line guard in
 * `compactor-integration.js`; behavior reverts to "always compress."
 *
 * @since 1.3.0 (kicked in alongside Memory Phase 1 to satisfy
 *   Decision §8 without waiting on organic usage).
 */

/** Cached result. `null` = unread; boolean = read. */
let _disabledCache = null;

/**
 * @returns {boolean} true if `?compression=off` (or `=false` / `=0`) is in the URL.
 */
function _readFlag() {
    try {
        // SSR / node:test land — no window or location.
        if (typeof window === 'undefined' || !window.location || !window.location.search) {
            return false;
        }
        const params = new URLSearchParams(window.location.search);
        const v = (params.get('compression') || '').trim().toLowerCase();
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
export function isCompressionDisabled() {
    if (_disabledCache === null) {
        _disabledCache = _readFlag();
        if (_disabledCache && typeof console !== 'undefined') {
            console.log(
                '[AI Editor] Compression DISABLED via ?compression=off — ' +
                'Rules 1+2 bypassed; conversation history flows straight into ChatSummarizer ' +
                '(pre-1.2.0 baseline). Use this tab as the control side of the dual-session ' +
                'A/B; numbers from the dashboard cost panel are directly comparable to the ' +
                'no-flag tab.'
            );
        }
    }
    return _disabledCache;
}

/**
 * Test seam: clear the cache so the next `isCompressionDisabled()` call
 * re-reads from `window.location.search`. Used by
 * `tests/test-compression-flag.mjs` to exercise multiple URL fixtures
 * within one process.
 */
export function _resetCacheForTests() {
    _disabledCache = null;
}
