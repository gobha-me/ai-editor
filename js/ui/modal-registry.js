/**
 * ModalRegistry — single source of truth for what overlays exist and how to
 * close them without enumerating selectors at each call site.
 *
 * Replaces the pre-2.33.0 hand-rolled chain in `js/app.js` Esc handler
 * (5 stacked `if (isXxxActive()) { closeXxx(); return; }`) and popstate
 * handler (2 stacked) plus the magic-selector body of
 * `js/ui-helpers.js#closeAllModals`.
 *
 * Every overlay registers once at boot via `registerOverlay({...})`. Esc
 * and popstate handlers then call `closeTopmostOverlay()` /
 * `closeTopmostOverlay({popstate:true})` — the registry picks the
 * highest-priority active entry and dispatches.
 *
 * The stacking invariant Merge-Conflict layers on top of PR Review (see
 * `js/merge-conflict/merge-conflict-mount.js` + `js/pr-review/`) lives
 * here as priority numbers, not as a hand-coded chain in two places.
 *
 * Shape:
 *   id        unique identifier
 *   isActive  () => boolean
 *   close     (opts?) => void
 *   priority  number, higher closes earlier when multiple active
 *   poppable  boolean, true = participates in popstate (default false)
 */

/** @typedef {{
 *   id: string,
 *   isActive: () => boolean,
 *   close: (opts?: object) => void,
 *   priority: number,
 *   poppable: boolean
 * }} OverlayEntry */

/** @type {OverlayEntry[]} — sorted descending by priority on insert. */
const _overlays = [];

/**
 * Register an overlay. Stable sort on insert so `closeTopmostOverlay` is
 * an O(n) scan rather than a per-call sort.
 *
 * @param {{
 *   id: string,
 *   isActive: () => boolean,
 *   close: (opts?: object) => void,
 *   priority?: number,
 *   poppable?: boolean
 * }} entry
 */
export function registerOverlay({ id, isActive, close, priority = 50, poppable = false }) {
    _overlays.push({ id, isActive, close, priority, poppable });
    _overlays.sort((a, b) => b.priority - a.priority);
}

/**
 * Close the highest-priority active overlay. With `{popstate: true}`,
 * only `poppable` entries are considered. Returns true if something
 * closed; false if nothing was active.
 *
 * The `opts` object is forwarded to `close` verbatim, so popstate's
 * `{popstate:true}` reaches `closeMergeConflict({popstate:true})` to
 * suppress the back-nav loop.
 *
 * @param {object} [opts]
 * @returns {boolean}
 */
export function closeTopmostOverlay(opts = {}) {
    const filter = opts.popstate ? (o) => o.poppable : () => true;
    const topmost = _overlays.find((o) => filter(o) && o.isActive());
    if (!topmost) return false;
    topmost.close(opts);
    return true;
}

/**
 * Snapshot of registered overlays, sorted descending by priority.
 * Mutation of the return value does not affect the registry.
 *
 * @returns {OverlayEntry[]}
 */
export function listOverlays() {
    return _overlays.slice();
}

/**
 * Test-only reset. Not for production use — would defeat the registry's
 * one-shot-at-boot registration contract.
 */
export function _resetForTests() {
    _overlays.length = 0;
}
