// @ts-check
/**
 * Thematic strategy — k-means clustering for query-free retrieval.
 * Implements the Phase-2 algorithm in
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Thematic
 * (Phase 2)":
 *
 *   1. Over the filtered vectors, run k-means with k = quota.
 *   2. For each cluster, return the chunk nearest the centroid as the
 *      representative.
 *   3. Score = negative distance to centroid (so larger score is better,
 *      matching the convention Semantic / Structural use elsewhere).
 *
 * The use cases this enables — "summarize this codebase," "what themes
 * are in these documents," "give me a coverage sample of this corpus"
 * — are exactly the ones a query-free retrieval cannot satisfy with
 * Semantic (which needs a query to embed) or Structural (which is a
 * cosine-fed ancestor walk over Semantic candidates). Thematic is the
 * third leg.
 *
 * **Why now (1.5.10).** The §1.5.0 retrieval track has been closing the
 * `mean recall@5 ≥ 0.80` gate against a code-search corpus where every
 * fixture has explicit text — those queries never hit Thematic. The
 * value of this PR is the query-free path the corpus doesn't measure
 * today, not a recall@5 lift on the existing fixtures. (See ROADMAP
 * §"Next" for the residual gap discussion.)
 *
 * **Algorithm interpretation.** "k from the request" reads as the
 * caller-supplied `quota` argument — the same parameter the router
 * allocates per-strategy. No separate `req.thematic_k` field. This
 * means Thematic, like Semantic and Structural, returns up to `quota`
 * representatives.
 *
 * **Cosine distance, not Euclidean.** Embeddings produced by the shipped
 * 1.1.2 client are L2-normalized; cosine distance is the metric the
 * downstream `chunkVectorSearch` already uses (`store.js:107` inline
 * helper). For unit-normalized vectors, cosine distance and Euclidean
 * distance produce equivalent rankings; we use cosine for symmetry
 * with the rest of the retrieval module.
 *
 * **Failure modes (per design lines 388–391):**
 *   - Fewer vectors than k → return all vectors. Caller observes
 *     `chunks.length < quota` and can infer k-reduction.
 *   - Cluster collapse (one cluster has ≥80% of vectors) → still return
 *     k representatives. Caller observes by checking that chunks span
 *     fewer than k unique source_uris (or by silhouette if a future
 *     diagnostics channel surfaces it).
 *   - 50k vector cap hit → uniform sample before clustering.
 *
 * **Diagnostic propagation deferred.** The `Strategy.retrieve` contract
 * is `(req, quota) → Promise<ChunkRef[]>` — no diagnostics channel. The
 * design's "flag low silhouette score in diagnostics" lands when the
 * Composer grows a per-strategy diagnostic channel; for 1.5.10 the
 * algorithmic behaviors are intact (return-all, return-k, sample) and
 * tests verify them via the returned chunks. Same posture Semantic
 * takes for its BM25 fallback "degraded" flag — algorithm runs
 * correctly, signal not yet propagated upstream.
 *
 * **No incremental clustering in v1** (per design line 386).
 * Clustering runs per-request; there's no centroid cache. ai-editor's
 * largest measured workspace at 1.5.8 was 4532 chunks — well under
 * the 50k cap, and a Phase-1 in-memory store reclusters in a few ms
 * even at corpus scale.
 *
 * **Production wiring (since 1.5.14):** the retrieval Manager
 * registers Thematic alongside Semantic + Structural for live
 * `find_relevant_files` calls; the legacy `js/context-manager.js`
 * file-level path retired in the same cutover (slipped from the
 * originally-planned 1.5.11 slot). Removability is inverted — deleting
 * this module would break thematic strategy admission and degrade
 * recall on the topic / onboarding query categories.
 *
 * @module intelligence/retrieval/strategies/thematic
 */

import { applyMetadataFilter } from './semantic.js';

/**
 * @typedef {import('../contracts.js').ChunkRef} ChunkRef
 * @typedef {import('../contracts.js').ChunkID} ChunkID
 * @typedef {import('../contracts.js').CollectionName} CollectionName
 * @typedef {import('../contracts.js').RetrievalRequest} RetrievalRequest
 * @typedef {import('../contracts.js').Applicability} Applicability
 * @typedef {import('../contracts.js').Strategy} Strategy
 * @typedef {import('../contracts.js').MetadataFilter} MetadataFilter
 * @typedef {import('../contracts.js').EmbeddingVector} EmbeddingVector
 * @typedef {import('../contracts.js').Provenance} Provenance
 */

/**
 * Caller-supplied "give me every chunk in this collection" lookup.
 * Production wires this to `store.getAllChunksForCollection`; tests
 * inject a static array.
 *
 * @typedef {(collection: CollectionName) => Promise<ChunkRef[]>} GetChunksForClustering
 */

/**
 * Pluggable k-means implementation. The default is the inline Lloyd's
 * algorithm in this module; tests inject deterministic fakes. The
 * `seed` option is honored by `defaultKmeans`; alternative
 * implementations are free to ignore it.
 *
 * @typedef {Object} KmeansOptions
 * @property {number} [maxIter]   Maximum iteration count. Default 50.
 * @property {number} [seed]      PRNG seed for k-means++ init. Default 42.
 *
 * @typedef {Object} KmeansResult
 * @property {EmbeddingVector[]} centers      Length-k. Unit-normalized.
 * @property {number[]}          assignments  Length-N. Each in `[0, k)`.
 *
 * @typedef {(vectors: EmbeddingVector[], k: number, opts?: KmeansOptions) => KmeansResult} KmeansFn
 */

/**
 * DESIGN-retrieval line 386: filtered set is capped before clustering.
 * Above the cap, the strategy uniformly samples down to the cap. Live
 * workspace sizes are O(10³–10⁴) chunks, so the cap is a safety valve;
 * exposed as a named export for tests + tuners.
 */
export const MAX_CLUSTER_VECTORS = 50_000;

/**
 * Pattern matched against `req.task` to decide query-free applicability.
 * Per DESIGN-retrieval line 507: "0.9 if `query` is empty or the task
 * matches patterns like 'summarize,' 'overview,' 'categorize.'" Kept
 * deliberately narrow (the design's exact words) — broaden when a
 * concrete task surface demands it.
 */
export const QUERY_FREE_TASK_PATTERN = /summari[sz]e|overview|categori[sz]e|themes?/i;

/**
 * Cosine similarity between two same-length numeric arrays. Returns 0
 * for any zero-norm input (rather than NaN — same convention as
 * `store.js:107`'s inline helper).
 *
 * @param {EmbeddingVector} a
 * @param {EmbeddingVector} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        dot += ai * bi;
        na += ai * ai;
        nb += bi * bi;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine distance derived from cosine similarity. Lies in [0, 2] for
 * arbitrary vectors; in [0, 1] for non-negatively-correlated ones; 0
 * means identical direction.
 *
 * @param {EmbeddingVector} a
 * @param {EmbeddingVector} b
 * @returns {number}
 */
export function cosineDistance(a, b) {
    return 1 - cosineSimilarity(a, b);
}

/**
 * Mulberry32 — 32-bit seeded PRNG, ~10 LOC, statistically adequate for
 * the k-means++ initialization step. Inlined to avoid a dep; same
 * deferred-promotion stance as `cosineSimilarity` (`store.js:107`):
 * lift to a shared util when a second consumer arrives.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
    let s = seed >>> 0;
    return function next() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    };
}

/**
 * Mean of a list of equal-length vectors. The output is **not**
 * normalized — k-means++ only needs centers as reference points for
 * assignment; the assignment metric (cosine distance) is
 * scale-invariant. Returning unnormalized means avoids a per-iter
 * normalize step (and the zero-norm edge case it introduces).
 *
 * @param {EmbeddingVector[]} vectors
 * @returns {EmbeddingVector}
 */
function vectorMean(vectors) {
    if (vectors.length === 0) return [];
    const dim = vectors[0].length;
    const out = new Array(dim).fill(0);
    for (const v of vectors) {
        for (let i = 0; i < dim; i++) out[i] += v[i];
    }
    const inv = 1 / vectors.length;
    for (let i = 0; i < dim; i++) out[i] *= inv;
    return out;
}

/**
 * Default k-means implementation — Lloyd's algorithm with k-means++
 * initialization, cosine distance, deterministic via injectable seed.
 * Caller is expected to have already validated `vectors.length >= k`
 * and `k > 0`; the strategy guards both.
 *
 * @param {EmbeddingVector[]} vectors
 * @param {number}            k
 * @param {KmeansOptions}     [opts]
 * @returns {KmeansResult}
 */
export function defaultKmeans(vectors, k, opts) {
    const maxIter = opts && Number.isFinite(opts.maxIter) && opts.maxIter > 0
        ? Math.floor(opts.maxIter)
        : 50;
    const seed = opts && Number.isFinite(opts.seed) ? Number(opts.seed) : 42;
    const rand = mulberry32(seed);
    const n = vectors.length;

    // k-means++ init: first center uniform, subsequent weighted by D².
    /** @type {EmbeddingVector[]} */
    const centers = [];
    const firstIdx = Math.floor(rand() * n);
    centers.push(vectors[firstIdx].slice());

    /** @type {number[]} */
    const minDistSq = new Array(n);
    for (let i = 0; i < n; i++) {
        const d = cosineDistance(vectors[i], centers[0]);
        minDistSq[i] = d * d;
    }

    for (let c = 1; c < k; c++) {
        let total = 0;
        for (let i = 0; i < n; i++) total += minDistSq[i];
        let pick;
        if (total === 0) {
            // All remaining vectors coincide with existing centers; just
            // pick uniformly. Cluster collapse is the documented signal.
            pick = Math.floor(rand() * n);
        } else {
            const target = rand() * total;
            let cum = 0;
            pick = n - 1;
            for (let i = 0; i < n; i++) {
                cum += minDistSq[i];
                if (cum >= target) { pick = i; break; }
            }
        }
        centers.push(vectors[pick].slice());
        // Update D² for the next pick.
        for (let i = 0; i < n; i++) {
            const d = cosineDistance(vectors[i], centers[c]);
            const dsq = d * d;
            if (dsq < minDistSq[i]) minDistSq[i] = dsq;
        }
    }

    /** @type {number[]} */
    const assignments = new Array(n).fill(0);

    for (let iter = 0; iter < maxIter; iter++) {
        // Assign: each vector → nearest center.
        let changed = false;
        for (let i = 0; i < n; i++) {
            let best = 0;
            let bestDist = cosineDistance(vectors[i], centers[0]);
            for (let c = 1; c < k; c++) {
                const d = cosineDistance(vectors[i], centers[c]);
                if (d < bestDist) { bestDist = d; best = c; }
            }
            if (assignments[i] !== best) {
                assignments[i] = best;
                changed = true;
            }
        }
        if (!changed) break;
        // Update: center = mean of assigned vectors. Empty cluster
        // keeps its prior center (don't re-seed mid-Lloyd's).
        for (let c = 0; c < k; c++) {
            /** @type {EmbeddingVector[]} */
            const members = [];
            for (let i = 0; i < n; i++) {
                if (assignments[i] === c) members.push(vectors[i]);
            }
            if (members.length > 0) centers[c] = vectorMean(members);
        }
    }

    return { centers, assignments };
}

/**
 * Build a Thematic-strategy `Provenance` record for a cluster
 * representative. Carries the chunk's own `byte_range` / `line_range`
 * forward (representative *is* the chunk, unlike Structural's
 * parent-walk) and stamps `retrieved_by: "thematic"` /
 * `score_kind: "cluster_distance"`.
 *
 * Score is the **negative** distance to the cluster centroid (per
 * DESIGN-retrieval line 384). Larger scores indicate tighter cluster
 * fit, matching the rest of the strategy outputs where larger score
 * is better.
 *
 * @param {ChunkRef} chunk
 * @param {number}   distance  Cosine distance to centroid (≥ 0).
 * @returns {ChunkRef}
 */
function withThematicProvenance(chunk, distance) {
    /** @type {Provenance} */
    const provenance = {
        source_uri: chunk.metadata.source_uri,
        byte_range: chunk.provenance ? chunk.provenance.byte_range : null,
        line_range: chunk.provenance ? chunk.provenance.line_range : null,
        retrieved_by: 'thematic',
        // `distance === 0` (k-reduced or perfect-fit rep) collapses
        // `-0` to `+0`. Functionally identical, but `Object.is(-0, 0)` is
        // `false` so consumers / tests that strict-equality-check zero
        // would otherwise see a phantom mismatch.
        score: distance === 0 ? 0 : -distance,
        score_kind: 'cluster_distance',
    };
    return {
        id: chunk.id,
        collection: chunk.collection,
        content: chunk.content,
        tokens: chunk.tokens,
        metadata: chunk.metadata,
        provenance,
        embedding: null,
    };
}

/**
 * Filter a candidate list to chunks that have a non-empty embedding
 * vector. Chunks without embeddings cannot participate in clustering
 * (the metric is cosine over the embedding). Same posture as
 * `store.js:194`: skip silently rather than throwing.
 *
 * @param {ChunkRef[]} chunks
 * @returns {ChunkRef[]}
 */
function filterEmbedded(chunks) {
    /** @type {ChunkRef[]} */
    const out = [];
    for (const c of chunks) {
        if (Array.isArray(c.embedding) && c.embedding.length > 0) out.push(c);
    }
    return out;
}

/**
 * Uniform-without-replacement sample of size `k` from `arr`,
 * deterministic under `rand`. Used only at the 50k cap, so the
 * O(n)-shuffle cost is bounded by the cap, not the corpus.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} k
 * @param {() => number} rand
 * @returns {T[]}
 */
function uniformSample(arr, k, rand) {
    if (k >= arr.length) return arr.slice();
    const indices = arr.map((_, i) => i);
    // Partial Fisher–Yates: enough swaps to fix the first k positions.
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rand() * (indices.length - i));
        const tmp = indices[i];
        indices[i] = indices[j];
        indices[j] = tmp;
    }
    /** @type {T[]} */
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = arr[indices[i]];
    return out;
}

/**
 * Build a Thematic strategy bound to a caller-supplied corpus iterator
 * and (optional) k-means implementation. The returned object satisfies
 * the `Strategy` typedef pinned by [contracts.js](../contracts.js).
 *
 * Required deps:
 *   - `getChunksForClustering(collection)`: produces every chunk in the
 *     collection. Tests inject a static array; production wires
 *     `store.getAllChunksForCollection`.
 *
 * Optional deps:
 *   - `kmeans`: alternative clustering implementation. Defaults to
 *     `defaultKmeans` (k-means++ + Lloyd's, cosine distance).
 *   - `seed`: PRNG seed forwarded to both `defaultKmeans` and the
 *     50k-cap uniform sample. Default 42.
 *
 * `applies_to(req)` returns:
 *   - `{score: 0.9, ...}` when `req.query` is null/empty/whitespace
 *     (semantic territory is empty; Thematic's natural range).
 *   - `{score: 0.9, ...}` when `req.task` matches the query-free
 *     pattern (`summarize|overview|categorize|themes`) regardless of
 *     query — the design's "summarize this codebase" entrypoint.
 *   - `{score: 0, ...}` otherwise (a present query that doesn't match
 *     the query-free task pattern is Semantic / Structural territory).
 *
 * @param {Object} deps
 * @param {GetChunksForClustering} deps.getChunksForClustering
 * @param {KmeansFn}               [deps.kmeans]
 * @param {number}                 [deps.seed]
 * @returns {Strategy}
 */
export function createThematicStrategy({ getChunksForClustering, kmeans, seed }) {
    if (typeof getChunksForClustering !== 'function') {
        throw new TypeError('createThematicStrategy: getChunksForClustering must be a function');
    }
    if (kmeans !== undefined && typeof kmeans !== 'function') {
        throw new TypeError('createThematicStrategy: kmeans must be a function when supplied');
    }
    if (seed !== undefined && !Number.isFinite(seed)) {
        throw new TypeError('createThematicStrategy: seed must be a finite number when supplied');
    }
    const kmeansFn = kmeans || defaultKmeans;
    const baseSeed = seed === undefined ? 42 : Number(seed);

    /**
     * @param {RetrievalRequest} req
     * @returns {Applicability}
     */
    function applies_to(req) {
        const q = typeof req.query === 'string' ? req.query.trim() : '';
        if (q.length === 0) {
            return { score: 0.9, reason: 'thematic default for query-free retrieval' };
        }
        const task = typeof req.task === 'string' ? req.task : '';
        if (QUERY_FREE_TASK_PATTERN.test(task)) {
            return { score: 0.9, reason: 'thematic match on query-free task pattern' };
        }
        return { score: 0, reason: 'thematic skipped — query present and task is not query-free' };
    }

    /**
     * @param {RetrievalRequest} req
     * @param {number} quota
     * @returns {Promise<ChunkRef[]>}
     */
    async function retrieve(req, quota) {
        if (!Number.isFinite(quota) || quota <= 0) return [];
        const collections = Array.isArray(req.collections) ? req.collections : [];
        if (collections.length === 0) return [];
        // v1 supports a single-collection clustering. Multi-collection
        // fan-out is router territory.
        const collection = collections[0];

        const all = await getChunksForClustering(collection);
        if (!Array.isArray(all) || all.length === 0) return [];

        const filtered = applyMetadataFilter(all, req.filters);
        if (filtered.length === 0) return [];

        const embedded = filterEmbedded(filtered);
        if (embedded.length === 0) return [];

        // 50k cap → uniform sample. Deterministic under the seed.
        let pool = embedded;
        if (pool.length > MAX_CLUSTER_VECTORS) {
            const sampleRand = mulberry32(baseSeed >>> 0);
            pool = uniformSample(pool, MAX_CLUSTER_VECTORS, sampleRand);
        }

        // Fewer vectors than k → return all (k-reduced path).
        if (pool.length <= quota) {
            return pool.map(c => withThematicProvenance(c, 0));
        }

        const vectors = pool.map(c => /** @type {EmbeddingVector} */ (c.embedding));
        const { centers, assignments } = kmeansFn(vectors, quota, {
            maxIter: 50,
            seed: baseSeed,
        });

        if (
            !Array.isArray(centers) ||
            !Array.isArray(assignments) ||
            centers.length !== quota ||
            assignments.length !== pool.length
        ) {
            // Defensive: a custom kmeans returned a malformed result.
            // Better to degrade to "all chunks, no ranking" than throw.
            return pool.slice(0, quota).map(c => withThematicProvenance(c, 0));
        }

        // For each cluster, pick the member chunk nearest its centroid.
        /** @type {Array<{ chunk: ChunkRef, distance: number } | null>} */
        const reps = new Array(quota).fill(null);
        for (let i = 0; i < pool.length; i++) {
            const c = assignments[i];
            if (c < 0 || c >= quota) continue;
            const d = cosineDistance(vectors[i], centers[c]);
            const cur = reps[c];
            if (!cur || d < cur.distance) {
                reps[c] = { chunk: pool[i], distance: d };
            }
        }

        /** @type {Array<{ chunk: ChunkRef, distance: number }>} */
        const present = [];
        for (const r of reps) {
            if (r) present.push(r);
        }
        // Best representative first (smallest distance / largest -score).
        present.sort((a, b) => a.distance - b.distance);
        return present.map(r => withThematicProvenance(r.chunk, r.distance));
    }

    return {
        name: 'thematic',
        applies_to,
        retrieve,
    };
}
