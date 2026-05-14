// @ts-check
/**
 * Tool-classification sets used across the chat tool loop. Every
 * classification axis lives here — co-located so a maintainer adding a new
 * tool can scan all axes at once and decide which apply.
 *
 * Axes (each linked to the export defining it):
 *
 *   Cache axis (dup-detection):
 *   - {@link WRITE_TOOLS} — bypass the dup-cache short-circuit
 *   - {@link STATEFUL_READ_TOOLS} — bypass both caches; result depends on
 *     hidden State
 *
 *   Cache axis (invalidation on success):
 *   - {@link FILE_MUTATING_TOOLS} — stales file-content reads
 *   - {@link PREVIEW_MUTATING_TOOLS} — stales {@link PREVIEW_READ_TOOLS}
 *
 *   Envelope axis (dup-cache hit messaging):
 *   - {@link MUTATING_TOOLS} — remote/persistent mutations get
 *     "prior call SUCCEEDED" envelope instead of the generic don't-retry
 *     warning
 *
 *   FileOp axis (Compression metadata):
 *   - {@link WHOLE_FILE_WRITE_TOOLS} — strict subset of WRITE_TOOLS;
 *     classifies FileOp `op: 'write'` vs `op: 'edit'`
 *
 *   Timeout axis (tool-loop scheduling):
 *   - {@link LONG_RUNNING_TOOLS} — uses settings.longRunningToolTimeout
 *   - {@link USER_PAUSE_TOOLS} — uses the 24h watchdog floor
 *     (settings.userPauseTimeout)
 *
 *   Cache-key helper:
 *   - {@link canonicalArgsKey} — deep-stable JSON for `(toolName, args)`
 *     cache keys
 *
 * The 2.25.0 hoist reverses an earlier (1.14.2-era) decision to keep
 * MUTATING_TOOLS / STATEFUL_READ_TOOLS / LONG_RUNNING_TOOLS /
 * USER_PAUSE_TOOLS inline in `handlers.js`. That decision traded
 * axis-encapsulation for developer-scan cost when adding a new tool. Per
 * audit-2026-Q2 inventory entries [DUP] [M] (handlers.js inline forks)
 * and feedback_prompts_js_parallel_enumeration.md, the inline location was
 * the primary source of "missed an axis" bugs. The matrix-scan
 * convention here is what 2.25.0 codified.
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
 * Whole-file writes — a strict subset of {@link WRITE_TOOLS} containing
 * only tools that REPLACE an entire file (vs. range-scoped edits like
 * `replace_lines` / `edit_file`). Used by `turn-enrich.js#extractFileOps`
 * to mint FileOp `op: 'write'` vs `op: 'edit'` for the Compression
 * subsumption rule (DESIGN-compression §Rule 1).
 *
 * Distinct from {@link WRITE_TOOLS} even though every member also lives
 * there — the questions are different ("does this fully replace prior
 * file content?" vs. "should the dup-cache short-circuit a fresh call?").
 * Hoisted from the inline `WRITE_TOOLS` shadow in `turn-enrich.js` at
 * 2.25.0 (audit-2026-Q2 inventory entry [DUP] [M]).
 *
 * @type {readonly string[]}
 */
export const WHOLE_FILE_WRITE_TOOLS = Object.freeze([
    'write_file', 'create_file', 'delete_file', 'write_plugin_source',
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
 * Preview-surface mutators — invalidate cached preview reads on success.
 * github#39: `preview_stop` tears down a server, but the dup-cache still
 * holds the old `preview_start` envelope pointing at the dead `serverId`.
 * Without invalidation the next `preview_start` returns the cached dead
 * `serverId`, the model retries, and the dup-refusal guard kicks in —
 * second instance of the recurring cache-invalidation-on-mutation pattern
 * (gitea#301 / 1.7.1 was the first, on `edit_file` / `read_lines`).
 *
 * 2.10.0 — Tier 3a expansion. The driving tools (`preview_click`,
 * `preview_fill`, `preview_resize`) all mutate state visible to subsequent
 * reads: click triggers handlers that may rewrite the DOM; fill changes
 * input values + dispatches input/change events; resize changes the
 * iframe element's CSS dimensions, which moves every `bbox` in a
 * subsequent snapshot/inspect. **Without these in the mutator set, the
 * canonical workflow `preview_snapshot → preview_click → preview_snapshot`
 * returns the cached pre-click snapshot on the second call** — exactly
 * the github#39 wedge surfaced again. Validated by 2026-05-10
 * qwen-3-6-plus dogfood on HTML-Games (Sokoban, Tetris).
 *
 * `preview_inspect` and `preview_snapshot` themselves are NOT mutators
 * even though snapshot writes `data-preview-uid` attributes — the
 * uids are stable across calls (deterministic by document order) and
 * adding snapshot to mutators would invalidate its own cache entry,
 * defeating the dup-refusal guard for legitimate same-args probes.
 *
 * Session-keyed (not path-keyed) — see `invalidateCachesForPreviewMutation`
 * in `./cache-invalidation.js`. Drops *all* PREVIEW_READ_TOOLS entries
 * regardless of args; coarser than path-keyed, but the active server set is
 * bounded by ~1.
 *
 * @type {readonly string[]}
 */
export const PREVIEW_MUTATING_TOOLS = Object.freeze([
    'preview_stop',
    // 2.10.0 — Tier 3a driving tools mutate iframe state (DOM / input
    // values / iframe dimensions); subsequent snapshot/inspect reads
    // become stale.
    'preview_click',
    'preview_fill',
    'preview_resize',
]);

/**
 * Cached preview reads invalidated by any PREVIEW_MUTATING_TOOLS call.
 * Tier 1 (1.22.0) shipped `preview_start` + `preview_list`. Tier 2
 * (2.7.0) added four capture readers. Tier 3a (2.10.0) added five
 * selector-shaped drivers — same invalidation semantics apply: once
 * the server is torn down, prior buffered logs / snapshot uids /
 * inspected styles no longer correspond to a live preview, so dup-
 * cache hits would mislead the model.
 *
 * @type {readonly string[]}
 */
export const PREVIEW_READ_TOOLS = Object.freeze([
    'preview_start',  // returns {serverId,url,reused} — wrong after stop
    'preview_list',   // server set just changed
    // Tier 2 (2.7.0) — capture buffers cleared on preview_stop, so any
    // cached read for a torn-down serverId returns content the host has
    // already dropped.
    'preview_console_logs',
    'preview_errors',
    'preview_logs',
    'preview_network',
    // Tier 3a (2.10.0) — driveable tools. Snapshot uids and inspected
    // styles refer to a live DOM that no longer exists post-stop;
    // re-driving stale uids is exactly the github#39 deadlock shape.
    'preview_snapshot',
    'preview_click',
    'preview_fill',
    'preview_inspect',
    'preview_resize',
]);

/**
 * Remote/persistent mutations whose dup-cache hit gets a "your prior call
 * SUCCEEDED" envelope instead of the generic don't-retry warning. These
 * tools deliberately STAY in the cache (so accidental double-commits /
 * double-comments are caught) — the envelope just reassures the model
 * the prior mutation happened.
 *
 * The qwen-3-6-plus PR #289 trace showed the model panicking on the
 * generic don't-retry note for `commit_files` and entering a 3-turn
 * confirmation loop; the targeted envelope here resolved it. github#35.
 *
 * Keep this in sync as new mutating tools land — the matrix-scan
 * convention is exactly what the 2.25.0 hoist was about.
 *
 * @type {readonly string[]}
 */
export const MUTATING_TOOLS = Object.freeze([
    'commit_files',
    'create_issue',
    'create_pull_request',
    'merge_pull_request',
    'add_pr_review',
    'memory_remember',
    'memory_revise',
    'scratchpad_write',
    'scratchpad_clear',
    'write_plugin_source',
]);

/**
 * Tools whose result depends on implicit State (not on args alone). The
 * dup-detection key is `(toolName, sortedArgs)`, so a stateful read like
 * `read_current_file` collides across calls when the active file changes
 * between them — the second call gets a stale-cache hit pointing at the
 * previous file's content. Bypass both the cross-request and same-request
 * caches for these.
 *
 * `ask_user` is included because the cross-request log would otherwise
 * synth a "you already asked this; here was the answer" hit on identical
 * args — but the model may legitimately want to re-ask after the
 * conversation moves on.
 *
 * Surfaced 2026-05-06 testing PR #293 against issue #23 (qwen-3-6-plus).
 *
 * @type {readonly string[]}
 */
export const STATEFUL_READ_TOOLS = Object.freeze([
    'read_current_file',
    'ask_user',
]);

/**
 * Tools that legitimately run longer than the standard tool timeout. The
 * tool loop swaps in `settings.longRunningToolTimeout` (default 300s) for
 * these, leaving the standard `settings.toolTimeout` (default 30s) for
 * everything else.
 *
 * @type {readonly string[]}
 */
export const LONG_RUNNING_TOOLS = Object.freeze(['wait_for_ci']);

/**
 * Tools that block on the user's response via an inline Preact card. The
 * chat loop's `isToolLoopCancelled` cancel path calls
 * `cancelUserResponse()` / `cancelPlanApproval()` to release the awaited
 * Promise. The user can sit with a question or plan for as long as they
 * want — but if the card fails to mount (DOM error, Preact crash, race
 * during conversation switch) the user never sees it and the Promise
 * hangs forever. The 1.14.2 watchdog floor (`settings.userPauseTimeout`,
 * default 24h) is a defensive last-resort: long enough that no real user
 * hits it, bounded so the loop can't deadlock indefinitely.
 *
 * `ask_user` — github#33. `submit_plan_for_approval` — github#25.
 * `submit_script_for_approval` — 1.16.0. `delegate_task` — 2.49.0.0
 * slice 1 of github#24 Phase 1; the approval-card lifecycle plus the
 * sub-agent run share the same user-pause budget per
 * [`docs/DESIGN-sub-agents.md`](../../docs/DESIGN-sub-agents.md)
 * §"Gap 6 — No per-invocation gate template that doesn't auto-execute
 * on Approve". Slice 1 adds the name to the set ahead of the handler
 * registration in slice 2; the set is consulted by name and is safe to
 * extend with a not-yet-registered tool.
 *
 * @type {readonly string[]}
 */
export const USER_PAUSE_TOOLS = Object.freeze([
    'ask_user',
    'submit_plan_for_approval',
    'submit_script_for_approval',
    'delegate_task',
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
