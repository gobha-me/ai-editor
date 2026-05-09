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
