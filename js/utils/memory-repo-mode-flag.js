/**
 * AI Editor — Memory repo-mode URL flag.
 *
 * Reads `?memoryRepoMode=on` (or `=true`/`=1`/`=enabled`) from
 * `window.location.search` once on first call and caches the result. When
 * set, `js/intelligence/memory/file-layer.js` activates: workspace-scope
 * memory mutations regenerate per-category Markdown files in an in-memory
 * pending buffer, and on workspace mount the existing
 * `.aieditor/memory/*.md` files are read and seeded into the structured
 * store.
 *
 * Why this exists: ROADMAP §1.3.0 Decision §1 says repo-committed
 * `.aieditor/memory/*.md` is **opt-in per workspace**. The Settings → Memory
 * tab toggle that ships in Memory PR #5 is the production opt-in surface.
 * Until then, this URL flag enables manual end-to-end testing of the file
 * layer without code changes — open `editor.gobha.ai/dev?memoryRepoMode=on`
 * against a workspace, exercise memory mutations, inspect the pending
 * content via `window.AIEditor.memoryFileLayer.getPendingContent(...)`.
 *
 * Mirrors the URL-flag pattern from `js/utils/compression-flag.js`
 * (PR #187): URL-only (no localStorage), read-once + cached, logged on
 * first detection.
 *
 * Removability: delete this file + the import in
 * `js/intelligence/memory/file-layer.js`; behavior reverts to "file layer
 * inert until PR #5's Settings toggle activates it."
 *
 * @since 1.3.0 (Memory PR #3)
 */

/** Cached result. `null` = unread; boolean = read. */
let _enabledCache = null;

/**
 * @returns {boolean} true if `?memoryRepoMode=on` (or `=true` / `=1` / `=enabled`) is in the URL.
 */
function _readFlag() {
    try {
        if (typeof window === 'undefined' || !window.location || !window.location.search) {
            return false;
        }
        const params = new URLSearchParams(window.location.search);
        const v = (params.get('memoryRepoMode') || '').trim().toLowerCase();
        return v === 'on' || v === 'true' || v === '1' || v === 'enabled';
    } catch {
        return false;
    }
}

/**
 * Whether the URL flag is set. Cached on first call.
 *
 * @returns {boolean}
 */
export function isMemoryRepoModeEnabled() {
    if (_enabledCache === null) {
        _enabledCache = _readFlag();
        if (_enabledCache && typeof console !== 'undefined') {
            console.log(
                '[AI Editor] Memory repo-mode ENABLED via ?memoryRepoMode=on — ' +
                'workspace-scope memory mutations will project to .aieditor/memory/*.md ' +
                'pending content. Inspect via window.AIEditor.memoryFileLayer.getPendingContent(path). ' +
                'Commit-modal write integration ships in Memory PR #7; until then the pending ' +
                'content is in-memory only.'
            );
        }
    }
    return _enabledCache;
}

/**
 * Test seam: clear the cache so the next `isMemoryRepoModeEnabled()` call
 * re-reads from `window.location.search`. Used by
 * `tests/test-memory-file-layer.mjs` to exercise multiple URL fixtures
 * within one process.
 */
export function _resetCacheForTests() {
    _enabledCache = null;
}
