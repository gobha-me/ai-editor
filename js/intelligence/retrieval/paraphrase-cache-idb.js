// @ts-check
/**
 * IDB-backed paraphrase cache. Satisfies the `ParaphraseCache` contract
 * from [./query-paraphraser.js](./query-paraphraser.js) — but its
 * `get` / `set` / `size` are async (return Promises).
 *
 * **Why this exists.** The default in-memory `Map` cache in
 * `query-paraphraser.js` is per-instance and dies at every page reload.
 * Paraphrase calls hit a chat model — a real round-trip that bills
 * tokens. Persisting paraphrases across sessions converts the second
 * invocation of any previously-seen query into a zero-token lookup.
 *
 * **Storage layout.** Reuses the existing `kv` object store in IDB.
 * Keys are `retrieval-paraphrase-cache::${cacheKey}` where `cacheKey`
 * is the same `${modelId}::${fnv1a8(query)}::${fnv1a8(prompt)}` value
 * the paraphraser already computes. Values are stored as
 * `{ paraphrases: string[], expiresAt: number }`. Expired entries are
 * evicted lazily on `get` — no background sweep.
 *
 * **TTL.** 7 days, matching the retrieval-index expiry pattern
 * (`embeddingCacheExpiry`). After expiry the entry is removed and
 * `get` returns `null`.
 *
 * **Failure mode.** Any IDB error (open failure, transaction abort,
 * structured-clone reject) is caught and degraded to a cache miss.
 * The paraphraser then runs the live LLM path; behavior is unchanged
 * versus pre-1.6.9.
 *
 * @module intelligence/retrieval/paraphrase-cache-idb
 */

import { IDB } from '../../storage/idb.js';

const KEY_PREFIX = 'retrieval-paraphrase-cache::';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Build an IDB-backed paraphrase cache. Returns `null` when IDB is not
 * available in the current runtime (Node tests, locked-down browsers
 * with IDB disabled) — caller should fall back to the in-memory
 * default.
 *
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs] Override the 7-day default.
 * @returns {{ get: (key: string) => Promise<string[]|null>, set: (key: string, value: string[]) => Promise<void>, size: () => Promise<number> }|null}
 */
export function createParaphraseIdbCache(opts = {}) {
    if (typeof indexedDB === 'undefined') return null;
    const ttl = Number.isFinite(opts.ttlMs) && /** @type {number} */ (opts.ttlMs) > 0
        ? /** @type {number} */ (opts.ttlMs)
        : DEFAULT_TTL_MS;

    /**
     * @param {string} key
     * @returns {string}
     */
    function storageKey(key) {
        return `${KEY_PREFIX}${key}`;
    }

    /**
     * @param {string} key
     * @returns {Promise<string[]|null>}
     */
    async function get(key) {
        try {
            const stored = await IDB.get(storageKey(key));
            if (!stored || !Array.isArray(stored.paraphrases)) return null;
            const expiresAt = Number(stored.expiresAt) || 0;
            if (expiresAt > 0 && expiresAt < Date.now()) {
                // Expired — drop lazily. Best-effort; failure here is harmless.
                IDB.remove(storageKey(key)).catch(() => {});
                return null;
            }
            return stored.paraphrases.slice();
        } catch (_err) {
            return null;
        }
    }

    /**
     * @param {string} key
     * @param {string[]} value
     * @returns {Promise<void>}
     */
    async function set(key, value) {
        if (!Array.isArray(value)) return;
        try {
            await IDB.set(storageKey(key), {
                paraphrases: value.slice(),
                expiresAt: Date.now() + ttl,
            });
        } catch (_err) {
            // Quota or transaction failure — silently drop the write.
            // Reads will miss next time and re-populate.
        }
    }

    /**
     * @returns {Promise<number>}
     */
    async function size() {
        try {
            const keys = await IDB.keys(KEY_PREFIX);
            return keys.length;
        } catch (_err) {
            return 0;
        }
    }

    return { get, set, size };
}
