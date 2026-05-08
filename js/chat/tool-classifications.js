// @ts-check
/**
 * Tool-classification sets used across the chat tool loop. Hoisted into one
 * module in 1.14.2 so the same membership doesn't drift across sites.
 *
 * The three axes are *not* the same question. Each set answers a different
 * one — keep that in mind before merging or deriving them from each other:
 *
 *   - {@link WRITE_TOOLS} — "should the dup-detection cache short-circuit a
 *     fresh call to this tool?" Answer: no, because a "your prior call
 *     already happened" envelope misrepresents semantics for fresh writes
 *     (the writer intends a new mutation; the cache would silently swallow
 *     it). Used at two sites in `handlers.js`: the cross-request dup-skip
 *     check and the same-request result-cache write.
 *
 *   - {@link FILE_MUTATING_TOOLS} — "does this tool's successful execution
 *     stale file-content reads in the caches?" Answer: yes for any tool
 *     that mutates a file on disk, AND for `open_file` (which doesn't
 *     mutate anything but changes which file `read_current_file` reads, so
 *     prior `read_current_file` results become stale). Used by
 *     `cache-invalidation.js`. NOT a side-effects axis — `open_file`
 *     is included for cache-key reasons, not because it has side effects.
 *
 *   - {@link canonicalArgsKey} — stable JSON for cache-key purposes.
 *     `JSON.stringify(value, Object.keys(value).sort())` only orders
 *     top-level keys; nested object keys come out in insertion order, so
 *     `{q:{a:1,b:2}}` and `{q:{b:2,a:1}}` produce different keys despite
 *     being equivalent. Latent today (most tool args are flat); will bite
 *     the first nested-arg tool. Use this helper at every cache-key site.
 *
 * `MUTATING_TOOLS` and `STATEFUL_READ_TOOLS` (also in `handlers.js`) are
 * deliberately NOT hoisted here. `MUTATING_TOOLS` is a remote-mutation set
 * used only for refusal-envelope messaging; it's internally cohesive and
 * not duplicated. `STATEFUL_READ_TOOLS` is a cache-key axis (does the
 * result depend on hidden State?), structurally distinct from the
 * write/read axis above and won't migrate to a future `ToolDef.side_effects`
 * field. They stay where they are.
 */

/**
 * Tools the dup-detection cache should NOT serve from. The "your prior call
 * already happened" envelope misrepresents semantics for fresh writes.
 *
 * Frozen so a downstream `.push` accident becomes a `TypeError` at the
 * accident site rather than silent membership drift.
 *
 * @type {readonly string[]}
 */
export const WRITE_TOOLS = Object.freeze([
    'replace_lines', 'insert_lines', 'delete_lines',
    'create_file', 'edit_file', 'write_file', 'delete_file',
    'update_issue', 'add_issue_comment',
]);

/**
 * Tools whose successful execution stales file-content caches. Includes
 * `open_file` because switching the active file stales `read_current_file`
 * results, even though `open_file` itself doesn't mutate disk.
 *
 * @type {readonly string[]}
 */
export const FILE_MUTATING_TOOLS = Object.freeze([
    'replace_lines', 'insert_lines', 'delete_lines',
    'create_file', 'edit_file', 'write_file', 'delete_file',
    'open_file',
]);

/**
 * Stable JSON for cache-key purposes. Recursively sorts object keys so
 * `{q:{a:1,b:2}}` and `{q:{b:2,a:1}}` produce the same string. Arrays
 * preserve order (semantically meaningful). Primitives, null, and unknown
 * types pass through `JSON.stringify` directly.
 *
 * Cycles cause `JSON.stringify` to throw, same as the prior implementation;
 * tool args are not expected to contain cycles.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function canonicalArgsKey(args) {
    return JSON.stringify(canonicalize(args));
}

/**
 * Recursive deep-sort. Returns a new value that serializes identically
 * regardless of original key order.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
        sorted[k] = canonicalize(/** @type {Record<string, unknown>} */ (value)[k]);
    }
    return sorted;
}
