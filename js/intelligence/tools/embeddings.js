// @ts-check
/**
 * Tool-embedding side-table for semantic `find_tool` (1.4.1).
 *
 * The Catalog rebuilds `ToolDef[]` on every `listAll()` call (registry is
 * mutable; plugins can register at any time), so embeddings cannot live on
 * the def itself — they'd be recomputed every call. This module owns the
 * cache: a `Map<ToolID, number[]>` populated lazily on first `find_tool`
 * use, invalidated when `EmbeddingsClient` clears its own cache (model
 * swap, manual wipe).
 *
 * Public surface (consumed by `js/tools/meta-tools.js`):
 *   - `findToolsBySemantic(query, defs, opts) → {ranked, mode}`
 *   - `getToolEmbedding(td) → Promise<number[]|null>` (test seam mostly)
 *   - constants used by callers (e.g. `DISCOVERY_ADMISSION_CAP`).
 *
 * Fallback contract:
 *   - `mode: "semantic"` — `EmbeddingsClient.embed` worked for query + tools,
 *     ranked array is non-null (may be empty if all below threshold).
 *   - `mode: "disabled"` — `EmbeddingsClient.isEnabled() === false`. No work
 *     done; caller falls back to categorical.
 *   - `mode: "unavailable"` — embed call failed (auth, network, init).
 *     No exception bubbles; caller falls back to categorical.
 *
 * @module intelligence/tools/embeddings
 */

import { EventBus, State } from '../../core.js';
// EmbeddingsClient is imported lazily inside the helper so node test
// environments that don't load the embedder module can stub it via
// dependency injection without pulling in Transformers.js eval-time setup.

/** @typedef {import('./contracts.js').ToolDef} ToolDef */
/** @typedef {import('./contracts.js').ToolID} ToolID */

export const DEFAULT_THRESHOLD = 0.4;
export const DEFAULT_TOP_K = 8;
export const DISCOVERY_ADMISSION_CAP = 3;

/** @type {Map<ToolID, number[]>} */
const _cache = new Map();

/** @type {(() => void) | null} */
let _unsubscribeCacheCleared = null;

/**
 * Default embedder accessor. Resolved lazily per call so test code can
 * monkey-patch via `_setEmbedderForTests`.
 */
let _embedder = null;

async function _getEmbedder() {
    if (_embedder) return _embedder;
    const mod = await import('../../embeddings-client.js');
    _embedder = mod.default || mod.EmbeddingsClient || null;
    return _embedder;
}

function _ensureCacheClearedSubscription() {
    if (_unsubscribeCacheCleared) return;
    _unsubscribeCacheCleared = EventBus.on('embeddings:cacheCleared', () => {
        _cache.clear();
    });
}

/**
 * Text canonicalization for tool embeddings — name + description + category.
 * Mirrors the `embedding` field doc in `contracts.js`.
 *
 * @param {ToolDef} td
 * @returns {string}
 */
function _toolEmbedText(td) {
    return `${td.name} ${td.description || ''} ${td.category || ''}`.trim();
}

/**
 * Resolve the cached embedding for a tool, computing on miss. Returns null
 * when embeddings are disabled or the embed call fails.
 *
 * @param {ToolDef} td
 * @returns {Promise<number[]|null>}
 */
export async function getToolEmbedding(td) {
    if (!td || typeof td.id !== 'string') return null;
    const cached = _cache.get(td.id);
    if (cached) return cached;

    const embedder = await _getEmbedder();
    if (!embedder || typeof embedder.embed !== 'function') return null;
    if (typeof embedder.isEnabled === 'function' && !embedder.isEnabled()) return null;

    let vec = null;
    try {
        vec = await embedder.embed(_toolEmbedText(td));
    } catch (e) {
        console.warn('[ToolEmbeddings] embed failed for', td.name, ':', e?.message || e);
        return null;
    }
    if (!Array.isArray(vec) || vec.length === 0) return null;

    _cache.set(td.id, vec);
    return vec;
}

/**
 * Read the configured threshold from `State.settings.tools.findToolThreshold`
 * (1.4.8 nested namespace), with fallback to the legacy flat
 * `State.settings.findToolThreshold` (the undocumented escape hatch shipped
 * before Settings → Tools existed). Default `DEFAULT_THRESHOLD` if both are
 * absent or non-numeric.
 */
function _readThreshold() {
    const nested = State?.settings?.tools?.findToolThreshold;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested >= 0 && nested <= 1) {
        return nested;
    }
    const legacy = State?.settings?.findToolThreshold;
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 0 && legacy <= 1) {
        return legacy;
    }
    return DEFAULT_THRESHOLD;
}

/**
 * Read the configured top-K from `State.settings.tools.findToolTopK`. Falls
 * back to `DEFAULT_TOP_K` (8). Range gate: positive integer ≤ 25 (a sane
 * upper bound — beyond ~25 the budget would never seat them all anyway).
 */
export function _readTopK() {
    const nested = State?.settings?.tools?.findToolTopK;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0 && nested <= 25) {
        return Math.floor(nested);
    }
    return DEFAULT_TOP_K;
}

/**
 * Read the configured discovery-admission cap from
 * `State.settings.tools.discoveryAdmissionCap`. Falls back to
 * `DISCOVERY_ADMISSION_CAP` (3). Range gate: positive integer ≤ topK.
 */
export function _readDiscoveryCap() {
    const nested = State?.settings?.tools?.discoveryAdmissionCap;
    if (typeof nested === 'number' && Number.isFinite(nested) && nested > 0 && nested <= 25) {
        return Math.floor(nested);
    }
    return DISCOVERY_ADMISSION_CAP;
}

/**
 * Rank tools by cosine similarity to `query`. Returns `mode` so the caller
 * can decide between "use these results" and "fall back to categorical."
 *
 * @param {string} query
 * @param {ToolDef[]} defs
 * @param {{topK?: number, threshold?: number}} [opts]
 * @returns {Promise<{ranked: Array<{td: ToolDef, score: number}>, mode: "semantic"|"disabled"|"unavailable"}>}
 */
export async function findToolsBySemantic(query, defs, opts) {
    _ensureCacheClearedSubscription();

    if (typeof query !== 'string' || query.trim().length === 0 || !Array.isArray(defs) || defs.length === 0) {
        return { ranked: [], mode: 'unavailable' };
    }

    const embedder = await _getEmbedder();
    if (!embedder || typeof embedder.embed !== 'function') {
        return { ranked: [], mode: 'unavailable' };
    }
    if (typeof embedder.isEnabled === 'function' && !embedder.isEnabled()) {
        return { ranked: [], mode: 'disabled' };
    }

    let queryVec = null;
    try {
        queryVec = await embedder.embed(query);
    } catch (e) {
        console.warn('[ToolEmbeddings] query embed failed:', e?.message || e);
        return { ranked: [], mode: 'unavailable' };
    }
    if (!Array.isArray(queryVec) || queryVec.length === 0) {
        return { ranked: [], mode: 'unavailable' };
    }

    // Fan out per-tool embedding lookups concurrently. Cached entries
    // resolve immediately; misses each pay one embed call. The embedder
    // itself sequences when it has to (Transformers.js JS thread; remote
    // does parallel HTTP).
    const vecs = await Promise.all(defs.map(td => getToolEmbedding(td)));

    const sim = typeof embedder.cosineSimilarity === 'function'
        ? embedder.cosineSimilarity.bind(embedder)
        : null;
    if (!sim) return { ranked: [], mode: 'unavailable' };

    const threshold = typeof opts?.threshold === 'number' ? opts.threshold : _readThreshold();
    const topK = typeof opts?.topK === 'number' && opts.topK > 0 ? opts.topK : _readTopK();

    /** @type {Array<{td: ToolDef, score: number}>} */
    const scored = [];
    for (let i = 0; i < defs.length; i++) {
        const v = vecs[i];
        if (!v) continue;
        const s = sim(queryVec, v);
        if (typeof s === 'number' && s >= threshold) {
            scored.push({ td: defs[i], score: s });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return { ranked: scored.slice(0, topK), mode: 'semantic' };
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** @type {{_clearCacheForTests: () => void, _setEmbedderForTests: (e: any) => void, _getCacheSize: () => number}} */
export const _testing = {
    _clearCacheForTests() {
        _cache.clear();
    },
    _setEmbedderForTests(stub) {
        _embedder = stub;
    },
    _getCacheSize() {
        return _cache.size;
    },
};
