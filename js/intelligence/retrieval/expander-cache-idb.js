// @ts-check
/**
 * IDB-backed cache for cross-file query expansion (1.8.1, lever B).
 * Satisfies the `ExpanderCache` contract from
 * [./query-expander.js](./query-expander.js) — same shape as the
 * paraphrase cache, distinct storage namespace.
 *
 * **Why a separate cache from the paraphraser.** Paraphrase output and
 * expansion output are not interchangeable — the paraphraser emits
 * vocabulary-different rewordings while the expander emits identifier-
 * vocabulary alts. Sharing storage would let a paraphrase warm an
 * expansion miss (or vice versa) with the wrong shape, surfacing as
 * worse retrieval that's hard to diagnose. The runtime overhead of two
 * tiny K-V scopes is negligible; correctness wins.
 *
 * **Storage layout.** Reuses the existing `kv` object store in IDB.
 * Keys are `retrieval-expansion-cache::${cacheKey}` where `cacheKey`
 * is the same `${modelId}::${fnv1a8(query)}::${fnv1a8(prompt)}` value
 * the expander already computes. Values are stored as
 * `{ alts: string[], expiresAt: number }`. Expired entries are evicted
 * lazily on `get` — no background sweep.
 *
 * **TTL.** 7 days, matching the paraphrase cache.
 *
 * **Failure mode.** Any IDB error (open failure, transaction abort,
 * structured-clone reject) is caught and degraded to a cache miss; the
 * expander runs the live LLM path. The IDB layer never throws upward.
 *
 * @module intelligence/retrieval/expander-cache-idb
 */

import { IDB } from '../../storage/idb.js';

const KEY_PREFIX = 'retrieval-expansion-cache::';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Build an IDB-backed expansion cache. Returns `null` when IDB is not
 * available in the current runtime (Node tests, locked-down browsers
 * with IDB disabled) — caller should fall back to the in-memory
 * default.
 *
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs] Override the 7-day default.
 * @returns {{ get: (key: string) => Promise<string[]|null>, set: (key: string, value: string[]) => Promise<void>, size: () => Promise<number> }|null}
 */
export function createExpanderIdbCache(opts = {}) {
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
            if (!stored || !Array.isArray(stored.alts)) return null;
            const expiresAt = Number(stored.expiresAt) || 0;
            if (expiresAt > 0 && expiresAt < Date.now()) {
                IDB.remove(storageKey(key)).catch(() => {});
                return null;
            }
            return stored.alts.slice();
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
                alts: value.slice(),
                expiresAt: Date.now() + ttl,
            });
        } catch (_err) {
            // Quota or transaction failure — silently drop the write.
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
