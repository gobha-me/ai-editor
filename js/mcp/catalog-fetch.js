// @ts-check
/**
 * AI Editor — MCP Catalog Fetch: IO orchestrator with IDB cache (2.15.0)
 *
 * github#27 Phase 2 slice 1. Wraps `catalog-source.js#fetchRemoteList`
 * with a 3-tier fallback so the Browse Catalog picker stays usable when
 * the network is down or the upstream registry is having a bad day:
 *
 *   1. Cache fresh (within `ttlMs`) → return cached, no network call.
 *   2. Cache stale OR missing → fetch fresh, write cache, return fresh.
 *   3. Fetch fails AND cache exists (any age) → return stale cache.
 *   4. Fetch fails AND no cache → return `{entries: [], source: 'bundled'}`.
 *      The merge layer (`catalog-merge.js`) folds in the bundled
 *      `MCP_CATALOG` so the picker still has at least 8 entries to show.
 *
 * The cache lives in the existing `kv` IDB store (`js/storage/idb.js`)
 * under two keys: the entry array (`mcp_catalog_remote_v1`) and a small
 * meta record (`mcp_catalog_remote_meta_v1`) carrying `fetchedAt`. Two
 * keys (vs. one wrapped object) keep the entries fast to read on a warm
 * cache and avoid serializing the meta on every entry mutation later.
 *
 * `getRemoteCatalog` accepts injected `idb` + `fetchImpl` + `now` so the
 * `tests/test-mcp-catalog-fetch.mjs` suite can drive the full lifecycle
 * without IndexedDB or the network.
 *
 * @module mcp/catalog-fetch
 */

import { fetchRemoteList } from './catalog-source.js';
import { IDB } from '../storage/idb.js';

const CACHE_KEY = 'mcp_catalog_remote_v1';
const META_KEY = 'mcp_catalog_remote_meta_v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * @typedef {Object} CatalogFetchResult
 * @property {Array<Object>} entries — possibly empty when source === 'bundled'
 * @property {'fresh'|'cache'|'bundled'} source
 * @property {number} fetchedAt — epoch ms; 0 when no real fetch ever happened
 */

/**
 * Resolve the remote catalog, going cache → fresh → stale-cache → bundled.
 *
 * Never throws. Network and IDB errors are caught + logged via
 * `console.warn`; the return value's `source` field tells callers what
 * tier they got.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   ttlMs?: number,
 *   idb?: { get: (k:string)=>Promise<*>, set: (k:string, v:*)=>Promise<void> },
 *   now?: () => number,
 * }} [opts]
 * @returns {Promise<CatalogFetchResult>}
 */
export async function getRemoteCatalog({
    fetchImpl = globalThis.fetch,
    ttlMs = DEFAULT_TTL_MS,
    idb = IDB,
    now = () => Date.now(),
} = {}) {
    let cached = null;
    let meta = null;
    try {
        cached = await idb.get(CACHE_KEY);
        meta = await idb.get(META_KEY);
    } catch (err) {
        console.warn('[mcp-catalog] IDB read failed:', err);
    }

    const cachedAge = meta && Number.isFinite(meta.fetchedAt) ? now() - meta.fetchedAt : Infinity;
    const cacheFresh = Array.isArray(cached) && cached.length > 0 && cachedAge < ttlMs && cachedAge >= 0;
    if (cacheFresh) {
        return { entries: cached, source: 'cache', fetchedAt: meta.fetchedAt };
    }

    try {
        const entries = await fetchRemoteList({ fetchImpl });
        const fetchedAt = now();
        try {
            await idb.set(CACHE_KEY, entries);
            await idb.set(META_KEY, { fetchedAt });
        } catch (err) {
            console.warn('[mcp-catalog] IDB write failed:', err);
        }
        return { entries, source: 'fresh', fetchedAt };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[mcp-catalog] remote fetch failed:', msg);
    }

    if (Array.isArray(cached) && cached.length > 0) {
        return { entries: cached, source: 'cache', fetchedAt: meta?.fetchedAt || 0 };
    }

    return { entries: [], source: 'bundled', fetchedAt: 0 };
}

/**
 * Force-clear the cache. Intended for the Settings → MCP Servers
 * "Refresh catalog" affordance (deferred for slice 1; ships in slice 2)
 * and for tests.
 *
 * @param {{idb?: { remove: (k:string)=>Promise<void> }}} [opts]
 * @returns {Promise<void>}
 */
export async function clearRemoteCatalogCache({ idb = IDB } = {}) {
    try {
        await idb.remove(CACHE_KEY);
        await idb.remove(META_KEY);
    } catch (err) {
        console.warn('[mcp-catalog] IDB clear failed:', err);
    }
}

// Test-only export of the constants so tests can assert on the storage shape.
export const __test_keys = Object.freeze({ CACHE_KEY, META_KEY, DEFAULT_TTL_MS });
