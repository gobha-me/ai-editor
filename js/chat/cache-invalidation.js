/**
 * Cache invalidation on file mutation.
 *
 * Two caches in `handlers.js` short-circuit duplicate tool calls:
 *  1. `toolCallCache` — local Map per `executeToolLoop` invocation
 *     (same-request dedup).
 *  2. `State.toolActionLog` — last-50 entries persisted across requests
 *     (cross-request dedup; survives summarization).
 *
 * Before this module, only (1) was invalidated when a write tool mutated
 * a file. (2) was never invalidated, so a `read_lines({path:P,…})` entry
 * logged before an `edit_file({path:P,…})` would still match on the
 * post-edit retry — the cross-request dup check returned a synthetic
 * `_cached: true` envelope pointing at pre-mutation content. Combined with
 * the 1.6.11 staleness guard demanding a fresh re-read, this deadlocked
 * real dogfood sessions (gitea#301).
 *
 * This helper does both walks. Pure: no module-level state, no globals.
 */

import {
    FILE_MUTATING_TOOLS,
    PREVIEW_MUTATING_TOOLS,
    PREVIEW_READ_TOOLS,
    canonicalArgsKey,
} from './tool-classifications.js';

/**
 * Invalidate cached reads when a tool mutates (or switches) a file.
 *
 * @param {object} params
 * @param {string} params.toolName            Just-executed tool.
 * @param {object} params.args                Just-executed tool args.
 * @param {string|null} [params.currentFilePath]  Active file path; used as the
 *     fallback affected path when args carry no path (e.g. `open_file` may
 *     leave `read_current_file` reads stale even without an explicit arg).
 * @param {Map<string, any>} params.toolCallCache  Same-request cache (mutated).
 * @param {Array<{tool:string, args:object}>} params.toolActionLog  Cross-request
 *     log; replaced via `.length = …` + push to keep the same array reference.
 * @param {string[]} params.WRITE_TOOLS       Tools whose log entries are kept
 *     for informational history even when their args mention the path.
 * @returns {{evictedCache:number, evictedLog:number}}
 */
export function invalidateCachesForPath({
    toolName,
    args,
    currentFilePath = null,
    toolCallCache,
    toolActionLog,
    WRITE_TOOLS,
}) {
    if (!FILE_MUTATING_TOOLS.includes(toolName)) {
        return { evictedCache: 0, evictedLog: 0 };
    }
    const affectedPath = (args && (args.path || args.file_path)) || currentFilePath;
    if (!affectedPath) {
        return { evictedCache: 0, evictedLog: 0 };
    }

    let evictedCache = 0;
    if (toolCallCache && typeof toolCallCache.delete === 'function') {
        for (const [key] of toolCallCache) {
            if (key.includes(affectedPath) || key.startsWith('read_current_file|')) {
                toolCallCache.delete(key);
                evictedCache++;
            }
        }
    }

    let evictedLog = 0;
    if (Array.isArray(toolActionLog) && toolActionLog.length > 0) {
        const writeSet = new Set(WRITE_TOOLS || []);
        const kept = [];
        for (const entry of toolActionLog) {
            if (!entry || typeof entry !== 'object') {
                kept.push(entry);
                continue;
            }
            // Preserve mutations — they're informational history, not stale reads.
            if (writeSet.has(entry.tool)) {
                kept.push(entry);
                continue;
            }
            // `read_current_file` reads the active file implicitly; evict when
            // the active file changes (or any in-place mutation) — mirrors the
            // same-request `read_current_file|` startsWith rule above.
            if (entry.tool === 'read_current_file') {
                evictedLog++;
                continue;
            }
            const entryPath = entry.args && (entry.args.path || entry.args.file_path);
            if (entryPath && entryPath === affectedPath) {
                evictedLog++;
                continue;
            }
            kept.push(entry);
        }
        if (evictedLog > 0) {
            // Mutate in place so the caller's reference survives.
            toolActionLog.length = 0;
            toolActionLog.push(...kept);
        }
    }

    return { evictedCache, evictedLog };
}

/**
 * Find the most-recent successful tool-action-log entry that matches a
 * `(toolName, args)` pair. Returns the entry or `undefined`.
 *
 * Used by the cross-request dup-cache path in `handlers.js` to build the
 * `_cache_note` envelope. **2.10.1 fix:** the previous implementation was
 * `find(e => e.tool === toolName && e.success)` — which picked up the
 * latest entry of the same tool name regardless of args. When the same
 * tool was called with different arg shapes earlier in the conversation
 * (e.g. `preview_start path=index.html` followed by
 * `preview_start path=tetris/index.html`), re-issuing the first arg shape
 * would surface the second entry's result in the cache_note. Surfaced by
 * the 2026-05-10 qwen-3-6-plus dogfood on HTML-Games (`xcaliber/HTML-Games`).
 *
 * Pure: no module-level state, no globals.
 *
 * @param {object} params
 * @param {Array<{tool:string, args:object, success:boolean, resultSummary?:string}>} params.toolActionLog
 * @param {string} params.toolName
 * @param {object} params.args
 * @param {number} [params.lookback=30]  Most-recent N entries to scan; mirrors handlers.js.
 * @returns {object|undefined}
 */
export function findMatchingCrossRequestEntry({ toolActionLog, toolName, args, lookback = 30 }) {
    if (!Array.isArray(toolActionLog) || toolActionLog.length === 0) return undefined;
    const argsStr = canonicalArgsKey(args || {});
    const slice = toolActionLog.slice(-lookback);
    for (let i = slice.length - 1; i >= 0; i--) {
        const e = slice[i];
        if (e && e.tool === toolName && e.success && canonicalArgsKey(e.args || {}) === argsStr) {
            return e;
        }
    }
    return undefined;
}

/**
 * Per-entry cap on the persisted `result` payload (post-`JSON.stringify`).
 *
 * 64 KB × 50 entries = ~3.2 MB max in the cross-request log, well under IDB
 * practical limits and small enough that a long-running session won't bloat
 * the conversation save path. Oversized results fall back to the legacy
 * summary-stub envelope at the read site.
 */
export const TOOL_ACTION_LOG_RESULT_CAP_BYTES = 64000;

/**
 * Build a `toolActionLog` entry for a just-executed tool call, optionally
 * carrying the full `result` payload so cross-request dup-cache hits can
 * return real data (gitea#421).
 *
 * Before this helper, the entry held only `resultSummary` (a short string
 * like `"189 lines"`). The cross-request branch at the read site could
 * therefore only return a stub envelope — the model was told "you already
 * called this" but never given the data back, so it pivoted (often
 * wasting 2-3 requests before `DUP_REFUSE_THRESHOLD` fired).
 *
 * The `result` field is gated to non-write, non-stateful-read tools so:
 *  - Write tools (`edit_file`, `create_file`, etc.) never serve cached
 *    results — every retry must re-execute or hit the refusal branch.
 *  - Stateful reads (`read_current_file`, `ask_user`) depend on hidden
 *    State and must not be cached cross-request.
 *
 * Pure: no module-level state, no globals. Caller supplies the
 * classification sets so the helper doesn't reach into `tool-classifications.js`
 * (avoids a load-time cycle with `tool-loop-core.js`).
 *
 * @param {object} params
 * @param {string} params.toolName              Just-executed tool.
 * @param {object} params.args                  Already-summarized args (caller passes `summarizeArgs(args)`).
 * @param {object} params.toolResult            Raw tool result object.
 * @param {string} params.resultSummary         Already-built short summary string.
 * @param {readonly string[]} params.WRITE_TOOLS
 * @param {readonly string[]} params.STATEFUL_READ_TOOLS
 * @param {number} [params.maxResultBytes]      Override the default 64 KB cap (tests).
 * @returns {{tool:string, args:object, resultSummary:string, timestamp:number, success:boolean, result?:object}}
 */
export function buildToolActionLogEntry({
    toolName,
    args,
    toolResult,
    resultSummary,
    WRITE_TOOLS,
    STATEFUL_READ_TOOLS,
    maxResultBytes = TOOL_ACTION_LOG_RESULT_CAP_BYTES,
}) {
    const entry = {
        tool: toolName,
        args,
        resultSummary,
        timestamp: Date.now(),
        success: !toolResult?.error,
    };
    const canPersist = !toolResult?.error
        && Array.isArray(WRITE_TOOLS) && !WRITE_TOOLS.includes(toolName)
        && Array.isArray(STATEFUL_READ_TOOLS) && !STATEFUL_READ_TOOLS.includes(toolName);
    if (canPersist) {
        try {
            const serialized = JSON.stringify(toolResult);
            if (serialized && serialized.length <= maxResultBytes) {
                entry.result = toolResult;
            }
        } catch (_) {
            // Circular reference or non-serializable result — skip persistence.
            // The summary stub branch at the read site will still fire as a fallback.
        }
    }
    return entry;
}

/**
 * Build the `toolResult` envelope returned by the cross-request dup-cache
 * branch — full payload when `lastEntry.result` is present, summary stub
 * otherwise (legacy entries pre-dating `buildToolActionLogEntry`, oversized
 * results, write tools).
 *
 * Companion to {@link buildToolActionLogEntry} and {@link findMatchingCrossRequestEntry}.
 *
 * @param {object} params
 * @param {string} params.toolName
 * @param {object|undefined} params.lastEntry   Result of `findMatchingCrossRequestEntry`.
 * @param {readonly string[]} params.MUTATING_TOOLS
 * @returns {object}
 */
export function buildCrossRequestCacheResult({ toolName, lastEntry, MUTATING_TOOLS }) {
    const isMutating = Array.isArray(MUTATING_TOOLS) && MUTATING_TOOLS.includes(toolName);
    if (lastEntry && lastEntry.result) {
        return {
            ...lastEntry.result,
            _cached: true,
            _cache_note: isMutating
                ? `[Your prior ${toolName} call already SUCCEEDED — the result above is from that call. The mutation has happened; do not retry to confirm.]`
                : `[Cached across requests — same ${toolName} call with identical arguments. Data above is from the prior call; it is still current (no mutation invalidated it).]`,
        };
    }
    const summary = lastEntry?.resultSummary || 'unknown';
    return {
        _cached: true,
        _cache_note: isMutating
            ? `[Your prior ${toolName} call already SUCCEEDED earlier in this conversation. Outcome: ${summary}. The mutation has happened — treat the prior result as authoritative and continue. Do not retry to confirm; that would re-attempt the mutation or loop on this same cache.]`
            : `[You already called ${toolName} with these arguments earlier in this conversation. The result was: ${summary}. Do NOT call this tool again with the same args.]`,
        error: null,
    };
}

/**
 * Invalidate cached preview reads when a preview-surface mutator runs.
 *
 * github#39 — `preview_stop` tears down the preview server, but the
 * dup-cache (both same-request `toolCallCache` and cross-request
 * `State.toolActionLog`) still holds the prior `preview_start` envelope
 * pointing at the now-dead `serverId`. The next `preview_start` returns
 * the cached dead `serverId`, the model retries, the dup-refusal guard
 * kicks in. Same shape as gitea#301 (1.7.1) for `edit_file`/`read_lines`.
 *
 * Session-keyed, not path-keyed: `preview_stop({serverId})` doesn't carry
 * the original `preview_start({path})` arg, so we can't match by args.
 * Coarse-grained eviction of *all* PREVIEW_READ_TOOLS entries is fine
 * because the active server set is bounded by ~1 in practice.
 *
 * @param {object} params
 * @param {string} params.toolName            Just-executed tool.
 * @param {Map<string, any>} params.toolCallCache  Same-request cache (mutated).
 * @param {Array<{tool:string, args:object}>} params.toolActionLog  Cross-request
 *     log; replaced via `.length = 0` + push to keep the same array reference.
 * @returns {{evictedCache:number, evictedLog:number}}
 */
export function invalidateCachesForPreviewMutation({
    toolName,
    toolCallCache,
    toolActionLog,
}) {
    if (!PREVIEW_MUTATING_TOOLS.includes(toolName)) {
        return { evictedCache: 0, evictedLog: 0 };
    }
    const readSet = new Set(PREVIEW_READ_TOOLS);

    let evictedCache = 0;
    if (toolCallCache && typeof toolCallCache.delete === 'function') {
        for (const [key] of toolCallCache) {
            // Cache keys are `${toolName}|${canonicalArgsKey(args)}`. Match
            // the tool prefix so any args-shape gets evicted.
            const tool = key.split('|', 1)[0];
            if (readSet.has(tool)) {
                toolCallCache.delete(key);
                evictedCache++;
            }
        }
    }

    let evictedLog = 0;
    if (Array.isArray(toolActionLog) && toolActionLog.length > 0) {
        const kept = [];
        for (const entry of toolActionLog) {
            if (!entry || typeof entry !== 'object') {
                kept.push(entry);
                continue;
            }
            if (readSet.has(entry.tool)) {
                evictedLog++;
                continue;
            }
            kept.push(entry);
        }
        if (evictedLog > 0) {
            // Mutate in place so the caller's reference survives.
            toolActionLog.length = 0;
            toolActionLog.push(...kept);
        }
    }

    return { evictedCache, evictedLog };
}
