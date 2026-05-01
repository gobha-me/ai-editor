// @ts-check
/**
 * Virtual CI log cache (1.4.6).
 *
 * `get_ci_logs` no longer returns a tail. Instead it downloads the full job
 * log into this in-memory cache under a virtual path
 * (`.aieditor/ci-cache/<runId>-<jobId>-<slug>.log`) and returns the path.
 * The model then drives `read_lines` / `search_in_files` / `scan_file` over
 * that path the same way it scans source files.
 *
 * The cache is read by `Git.getFile()` (js/git.js): when a path enters the
 * `.aieditor/ci-cache/` namespace and is present here, the facade
 * short-circuits the provider call and returns a synthetic file object.
 *
 * Lifecycle:
 *   - Per-entry cap: 10MB. Anything beyond is sliced (keeping the tail —
 *     CI failures usually surface near the end) and the entry is flagged
 *     `truncatedAtCap`.
 *   - 5-entry LRU as a memory-pressure backstop.
 *   - The orchestrator listens for `loop:finished` and calls `evictAll()`
 *     so a completed loop doesn't leak megabytes between runs.
 */

const NAMESPACE = '.aieditor/ci-cache/';
const PER_ENTRY_CAP_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 5;

/** @typedef {{ content: string, totalBytes: number, truncatedAtCap: boolean, writtenAt: number }} CacheEntry */

/** @type {Map<string, CacheEntry>} */
const _store = new Map();

/**
 * Path for a job log given a workflow run + job. Slug is stripped to safe
 * chars so the path stays portable through tool args.
 *
 * @param {number|string} runId
 * @param {number|string} jobId
 * @param {string} jobName
 * @returns {string}
 */
export function pathFor(runId, jobId, jobName) {
    const slug = String(jobName || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';
    return `${NAMESPACE}${runId}-${jobId}-${slug}.log`;
}

/** @param {string} path */
export function isCachePath(path) {
    return typeof path === 'string' && path.startsWith(NAMESPACE);
}

/**
 * Write a full log into the cache. Caps content at PER_ENTRY_CAP_BYTES
 * (keeps the tail since CI failures cluster near the end). Evicts the
 * least-recently-written entry once MAX_ENTRIES is exceeded.
 *
 * @param {string} path
 * @param {string} content
 * @returns {{ path: string, totalBytes: number, truncatedAtCap: boolean }}
 */
export function write(path, content) {
    const raw = typeof content === 'string' ? content : '';
    const totalBytes = raw.length;
    let stored = raw;
    let truncatedAtCap = false;
    if (totalBytes > PER_ENTRY_CAP_BYTES) {
        stored = raw.slice(totalBytes - PER_ENTRY_CAP_BYTES);
        truncatedAtCap = true;
    }
    // Re-insert to move to end of insertion order (LRU = oldest at head).
    if (_store.has(path)) _store.delete(path);
    _store.set(path, { content: stored, totalBytes, truncatedAtCap, writtenAt: Date.now() });
    while (_store.size > MAX_ENTRIES) {
        const oldest = _store.keys().next().value;
        if (oldest === undefined) break;
        _store.delete(oldest);
    }
    return { path, totalBytes, truncatedAtCap };
}

/**
 * Read a cached log. Returns a `Git.getFile`-shaped object so call-sites
 * (read_lines, scan_file, etc.) can consume it without branching. Returns
 * null if the path isn't in the cache — the caller falls back to the
 * provider.
 *
 * @param {string} path
 * @returns {{ path: string, content: string, sha: string, size: number, encoding: string } | null}
 */
export function read(path) {
    const entry = _store.get(path);
    if (!entry) return null;
    return {
        path,
        content: entry.content,
        sha: 'virtual',
        size: entry.content.length,
        encoding: 'utf-8',
    };
}

/** @param {string} path */
export function has(path) {
    return _store.has(path);
}

/** Drop everything. Called from the orchestrator on `loop:finished`. */
export function evictAll() {
    _store.clear();
}

// Test seam.
export const __test__ = {
    NAMESPACE,
    PER_ENTRY_CAP_BYTES,
    MAX_ENTRIES,
    _store,
};
