// @ts-check
/**
 * Semantic strategy — hybrid k-NN + BM25 + RRF fusion. Implements the
 * Phase-1 algorithm in
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Semantic
 * (Phase 1)":
 *
 *   1. Embed the query.
 *   2. k-NN against the collection's vectors (k = quota × 3 for headroom).
 *   3. If keyword signal is available (BM25 index supplied), score the
 *      candidate chunks against it.
 *   4. Fuse with reciprocal rank fusion. RRF is parameter-free; this
 *      design intentionally does not introduce learned weights in v1.
 *   5. Apply metadata filters.
 *   6. Return top `quota`.
 *
 * Wraps the **shipped 1.1.2 embedder**
 * ([js/embeddings-client.js](../../../embeddings-client.js)) — the editor
 * has had `EmbeddingsClient.embed()` for four releases. What's new is
 * **chunk-level** retrieval that pairs with the chunkers landed in
 * 1.4.10–1.4.13; the legacy file-level `find_relevant_files` path keeps
 * working through `js/context-manager.js` until the migration PR (1.5.2
 * per the roadmap). To keep this strategy a pure function of injected
 * deps — and to keep node tests free of the browser-only `core.js`
 * import chain — `embedQuery` is a required factory parameter rather
 * than a default-to-`EmbeddingsClient.embed` import. Production callers
 * wire `(text) => EmbeddingsClient.embed(text)` at the call site (the
 * Composer in PR 9 of 1.5.0); tests inject deterministic fakes.
 *
 * The chunk-level vector store does not exist yet either: the chunkers
 * ship as pure functions nobody calls at ingest. So `chunkVectorSearch`
 * is the second injected seam — its real implementation lands with the
 * ingest PR, today it's faked in tests. With both seams external, the
 * strategy itself is ~"given a query embedding and a way to k-NN over
 * chunks, do RRF fusion and metadata filtering correctly."
 *
 * BM25 math (`scoreBM25Doc`) lives here rather than in a separate
 * module because no other strategy needs it today: Structural is a
 * cosine-fed ancestor walk; Thematic is k-means. Promoting BM25 to a
 * shared module is premature factoring until that second consumer
 * arrives.
 *
 * No runtime wire-up: nothing imports `createSemanticStrategy` outside
 * the test suite yet. The Composer placeholder in
 * [`../index.js`](../index.js) still throws on call. With this module
 * deleted, `find_relevant_files` keeps running through the legacy
 * file-level path. Removability holds (Decision §7).
 *
 * @module intelligence/retrieval/strategies/semantic
 */

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
 * @typedef {import('../contracts.js').ScoreKind} ScoreKind
 */

/**
 * Opaque BM25 index handle the strategy consumes. Built by the future
 * ingest pipeline; stays a typedef (and a `null` injection seam) until
 * then. Shape rationale:
 *   - `idfMap` keyed on tokenized form (`tokenizeBM25` output).
 *   - `avgdl` is the average document length in tokens, needed for the
 *     length-normalization term of the BM25 formula.
 *   - `chunks` is the indexed corpus, used only by the
 *     pure-BM25-fallback path (when the embedder is unavailable or the
 *     query is too short for useful semantic signal). The hybrid path
 *     re-scores the cosine candidates rather than the whole corpus.
 *   - `k1` / `b` use BM25's textbook defaults (1.5 / 0.75) when absent.
 *
 * @typedef {Object} BM25Index
 * @property {Map<string, number>} idfMap   Token → IDF (precomputed at ingest).
 * @property {number}              avgdl    Average doc length in tokens.
 * @property {ChunkRef[]}          chunks   Indexed corpus.
 * @property {number}              [k1]     BM25 saturation parameter; default 1.5.
 * @property {number}              [b]      BM25 length-normalization; default 0.75.
 */

/**
 * Caller-supplied query embedder. Returns `null` when the embedder is
 * disabled or the provider is unavailable — the strategy treats this as
 * a degraded path rather than an error. Production callers wire
 * `(text) => EmbeddingsClient.embed(text)`; tests inject deterministic
 * fakes.
 *
 * @typedef {(text: string) => Promise<EmbeddingVector|null>} EmbedQuery
 */

/**
 * Caller-supplied chunk-vector k-NN over a collection. Returns
 * candidates pre-sorted by similarity (descending). The strategy
 * preserves that order as the cosine ranking and never re-sorts on
 * `similarity` — so the contract is "sorted on the way out."
 *
 * @typedef {(queryVec: EmbeddingVector, collection: CollectionName, k: number) => Promise<Array<{chunk: ChunkRef, similarity: number}>>} ChunkVectorSearch
 */

/**
 * Optional BM25 index lookup. Returns null when no index exists for the
 * collection. The strategy gracefully degrades to pure-cosine in that
 * case.
 *
 * @typedef {(collection: CollectionName) => BM25Index|null} GetBM25Index
 */

/**
 * Below this query token count, the embedder rarely produces useful
 * signal (per DESIGN-retrieval §"Failure modes": "Query too short for
 * useful embedding (fewer than 3 tokens) → fall back to pure BM25").
 */
const MIN_TOKENS_FOR_SEMANTIC = 3;

/**
 * RRF rank-displacement constant. The textbook value (Cormack et al.
 * 2009); not tuned in v1. Higher values flatten the contribution
 * difference between rank 1 and rank N; the textbook 60 is well-mixed
 * across IR benchmarks.
 */
const RRF_K = 60;

const DEFAULT_BM25_K1 = 1.5;
const DEFAULT_BM25_B = 0.75;

/**
 * Tokenize a string for BM25 scoring: lowercased, ASCII-word-split,
 * empty tokens dropped. Deliberately simple — matching the design's
 * "RRF is parameter-free" stance, BM25 v1 doesn't try to be clever
 * about stemming, stopwords, or Unicode normalization. The future
 * ingest PR will apply the same tokenizer at index build time so the
 * IDF map and content scoring agree.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeBM25(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Score a single document against a tokenized query under BM25. Caller
 * pre-tokenizes the query so the same query can score N documents
 * without re-tokenizing N times.
 *
 * Per DESIGN-retrieval §"Semantic (Phase 1)" the algorithm is BM25 with
 * IDF source = `index.idfMap` and length normalization = `index.avgdl`.
 * The standard formula:
 *
 *     score(D, Q) = Σ IDF(q) × tf(q, D) × (k1 + 1)
 *                       / (tf(q, D) + k1 × (1 − b + b × |D| / avgdl))
 *
 * Tokens absent from `idfMap` contribute 0 (no smoothing) — the future
 * ingest PR is responsible for not pruning rare-but-meaningful tokens
 * from the IDF map. Contentless docs (empty token list) score 0.
 *
 * @param {string[]} queryTokens
 * @param {string}   content
 * @param {BM25Index} index
 * @returns {number}
 */
export function scoreBM25Doc(queryTokens, content, index) {
    if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
    const docTokens = tokenizeBM25(content);
    if (docTokens.length === 0) return 0;
    const k1 = typeof index.k1 === 'number' ? index.k1 : DEFAULT_BM25_K1;
    const b = typeof index.b === 'number' ? index.b : DEFAULT_BM25_B;
    const dl = docTokens.length;
    const avgdl = index.avgdl > 0 ? index.avgdl : dl;
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
        const f = tf.get(q);
        if (!f) continue;
        const idf = index.idfMap.get(q);
        if (typeof idf !== 'number' || idf === 0) continue;
        const num = f * (k1 + 1);
        const den = f + k1 * (1 - b + b * (dl / avgdl));
        score += idf * (num / den);
    }
    return score;
}

/**
 * Reciprocal Rank Fusion over a list of rankings. Each ranking is an
 * ordered array of `ChunkID`s (rank 0 = best). Returns a Map of
 * ChunkID → fused RRF score, summed across rankings. Items appearing
 * in only one ranking still get a score (their contribution from the
 * other ranking is implicitly 0). RRF_K is the textbook 60.
 *
 * @param {ChunkID[][]} rankings
 * @returns {Map<ChunkID, number>}
 */
export function reciprocalRankFusion(rankings) {
    /** @type {Map<ChunkID, number>} */
    const scores = new Map();
    for (const ranking of rankings) {
        for (let rank = 0; rank < ranking.length; rank++) {
            const id = ranking[rank];
            const contribution = 1 / (RRF_K + rank + 1);
            scores.set(id, (scores.get(id) || 0) + contribution);
        }
    }
    return scores;
}

/**
 * Apply a `MetadataFilter` to a candidate chunk list. Phase-1 filter
 * shape per [contracts.js](../contracts.js) `MetadataFilter`:
 *   - `content_types` is an accept-list (omit ⇒ accept all).
 *   - `custom` is an `{[key]: value | function}` map, applied to
 *     `chunk.metadata.custom[key]`. A function value is invoked with
 *     the candidate's value and accepts when truthy; any other value
 *     is accepted on strict-equality. This stays intentionally narrow
 *     — concrete predicates pin themselves when the first filter
 *     consumer lands.
 *
 * Returns a fresh array; input is never mutated.
 *
 * @param {ChunkRef[]} chunks
 * @param {MetadataFilter|null|undefined} filter
 * @returns {ChunkRef[]}
 */
export function applyMetadataFilter(chunks, filter) {
    if (!filter) return chunks.slice();
    const accept = [];
    const allowedTypes = filter.content_types;
    const customPreds = filter.custom;
    for (const c of chunks) {
        if (allowedTypes && !allowedTypes.includes(c.metadata.content_type)) continue;
        if (customPreds) {
            let pass = true;
            for (const key of Object.keys(customPreds)) {
                const want = customPreds[key];
                const got = c.metadata.custom ? c.metadata.custom[key] : undefined;
                if (typeof want === 'function') {
                    if (!want(got)) { pass = false; break; }
                } else if (got !== want) {
                    pass = false; break;
                }
            }
            if (!pass) continue;
        }
        accept.push(c);
    }
    return accept;
}

/**
 * Replace a candidate chunk's `provenance` with a Semantic-strategy
 * record. Carries forward `byte_range` / `line_range` from ingest (the
 * chunk store populated those at ingest time) and overwrites
 * `retrieved_by` / `score` / `score_kind`.
 *
 * @param {ChunkRef} chunk
 * @param {number}   score
 * @param {ScoreKind} score_kind
 * @returns {ChunkRef}
 */
function withSemanticProvenance(chunk, score, score_kind) {
    /** @type {Provenance} */
    const provenance = {
        source_uri: chunk.metadata.source_uri,
        byte_range: chunk.provenance ? chunk.provenance.byte_range : null,
        line_range: chunk.provenance ? chunk.provenance.line_range : null,
        retrieved_by: 'semantic',
        score,
        score_kind,
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
 * Pure-BM25 path: score every chunk in the indexed corpus, return top
 * `quota` after metadata filtering. Used when the embedder is
 * unavailable or the query is too short for useful semantic signal.
 *
 * @param {string[]}                queryTokens
 * @param {BM25Index}               index
 * @param {MetadataFilter|null|undefined} filter
 * @param {number}                  quota
 * @returns {ChunkRef[]}
 */
function pureBM25Path(queryTokens, index, filter, quota) {
    const filtered = applyMetadataFilter(index.chunks, filter);
    const scored = [];
    for (const chunk of filtered) {
        const s = scoreBM25Doc(queryTokens, chunk.content, index);
        if (s > 0) scored.push({ chunk, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, quota).map(({ chunk, score }) => withSemanticProvenance(chunk, score, 'bm25'));
}

/**
 * Hybrid path: cosine k-NN candidates fused with BM25 over the same
 * candidate set via RRF. The BM25 ranking is over the cosine
 * candidates only — not the whole corpus — so the index needs at most
 * to score `quota * 3` chunks per call.
 *
 * @param {string[]}                queryTokens
 * @param {Array<{chunk: ChunkRef, similarity: number}>} candidates  Pre-sorted by similarity desc.
 * @param {BM25Index}               index
 * @param {MetadataFilter|null|undefined} filter
 * @param {number}                  quota
 * @returns {ChunkRef[]}
 */
function hybridPath(queryTokens, candidates, index, filter, quota) {
    const filtered = applyMetadataFilter(candidates.map(c => c.chunk), filter);
    if (filtered.length === 0) return [];
    const allowedIds = new Set(filtered.map(c => c.id));
    const cosineRanking = candidates
        .filter(c => allowedIds.has(c.chunk.id))
        .map(c => c.chunk.id);
    const bm25Scored = filtered.map(chunk => ({
        id: chunk.id,
        score: scoreBM25Doc(queryTokens, chunk.content, index),
    }));
    bm25Scored.sort((a, b) => b.score - a.score);
    const bm25Ranking = bm25Scored.filter(s => s.score > 0).map(s => s.id);
    const fused = reciprocalRankFusion([cosineRanking, bm25Ranking]);
    /** @type {Map<ChunkID, ChunkRef>} */
    const byId = new Map();
    for (const c of filtered) byId.set(c.id, c);
    const ordered = [...fused.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, quota);
    return ordered.map(([id, score]) => {
        const chunk = /** @type {ChunkRef} */ (byId.get(id));
        return withSemanticProvenance(chunk, score, 'hybrid');
    });
}

/**
 * Pure-cosine path: cosine k-NN candidates with no BM25 fusion. Used
 * when no BM25 index is supplied for the collection.
 *
 * @param {Array<{chunk: ChunkRef, similarity: number}>} candidates  Pre-sorted by similarity desc.
 * @param {MetadataFilter|null|undefined} filter
 * @param {number}                  quota
 * @returns {ChunkRef[]}
 */
function pureCosinePath(candidates, filter, quota) {
    const filtered = applyMetadataFilter(candidates.map(c => c.chunk), filter);
    if (filtered.length === 0) return [];
    const allowedIds = new Set(filtered.map(c => c.id));
    const ordered = candidates.filter(c => allowedIds.has(c.chunk.id));
    return ordered.slice(0, quota).map(c => withSemanticProvenance(c.chunk, c.similarity, 'cosine'));
}

/**
 * Build a Semantic strategy bound to caller-supplied embedder, vector
 * store, and (optional) BM25 index. The returned object satisfies the
 * `Strategy` typedef pinned by [contracts.js](../contracts.js).
 *
 * Required deps:
 *   - `embedQuery`: text → vector (or null when degraded).
 *   - `chunkVectorSearch`: query vector → ranked `{chunk, similarity}`
 *     list.
 *
 * Optional deps:
 *   - `getBM25Index`: collection → BM25Index | null. When absent the
 *     strategy degrades gracefully to pure-cosine (and the BM25
 *     fallback path returns empty + degraded if the embedder is
 *     unavailable too).
 *
 * `applies_to(req)` returns:
 *   - `{score: 0, ...}` when `req.query` is null/empty/whitespace
 *     (semantic requires a query — thematic territory).
 *   - `{score: 0.9, ...}` otherwise. Phase 1 is "semantic is the
 *     default for keyword/semantic queries"; the router consumer (PR
 *     8/9) will handle quota normalization.
 *
 * @param {Object} deps
 * @param {EmbedQuery} deps.embedQuery
 * @param {ChunkVectorSearch} deps.chunkVectorSearch
 * @param {GetBM25Index} [deps.getBM25Index]
 * @returns {Strategy}
 */
export function createSemanticStrategy({ embedQuery, chunkVectorSearch, getBM25Index }) {
    if (typeof embedQuery !== 'function') {
        throw new TypeError('createSemanticStrategy: embedQuery must be a function');
    }
    if (typeof chunkVectorSearch !== 'function') {
        throw new TypeError('createSemanticStrategy: chunkVectorSearch must be a function');
    }
    if (getBM25Index !== undefined && typeof getBM25Index !== 'function') {
        throw new TypeError('createSemanticStrategy: getBM25Index must be a function when supplied');
    }

    /**
     * @param {RetrievalRequest} req
     * @returns {Applicability}
     */
    function applies_to(req) {
        const q = typeof req.query === 'string' ? req.query.trim() : '';
        if (q.length === 0) {
            return { score: 0, reason: 'semantic requires a non-empty query' };
        }
        return { score: 0.9, reason: 'Phase-1 default for keyword/semantic queries' };
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
        // v1 supports a single-collection query. Multi-collection fan-out
        // is the router's job (PR 9 of 1.5.0); a strategy isolated to
        // one corpus per call keeps quota math local.
        const collection = collections[0];
        const rawQuery = typeof req.query === 'string' ? req.query : '';
        const query = rawQuery.trim();
        if (query.length === 0) return [];

        const queryTokens = tokenizeBM25(query);
        const tooShort = queryTokens.length < MIN_TOKENS_FOR_SEMANTIC;
        const bm25Index = getBM25Index ? getBM25Index(collection) : null;

        // Pure-BM25 fallback: query too short for useful semantic signal.
        if (tooShort) {
            if (bm25Index) {
                return pureBM25Path(queryTokens, bm25Index, req.filters, quota);
            }
            return [];
        }

        const queryVec = await embedQuery(query);
        // Embedder unavailable / disabled. Pure BM25 fallback if available,
        // empty + degraded otherwise.
        if (!queryVec) {
            if (bm25Index) {
                return pureBM25Path(queryTokens, bm25Index, req.filters, quota);
            }
            return [];
        }

        const k = Math.max(1, quota * 3);
        const candidates = await chunkVectorSearch(queryVec, collection, k);
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        if (bm25Index) {
            return hybridPath(queryTokens, candidates, bm25Index, req.filters, quota);
        }
        return pureCosinePath(candidates, req.filters, quota);
    }

    return {
        name: 'semantic',
        applies_to,
        retrieve,
    };
}
