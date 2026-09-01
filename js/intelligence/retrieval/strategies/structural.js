// @ts-check
/**
 * Structural strategy — ancestor-walk over chunk `parent_id` metadata.
 * Implements the Phase-1 algorithm in
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Structural
 * (Phase 1: ancestor-walk)":
 *
 *   1. Run semantic retrieval as normal.
 *   2. For each returned chunk, if `metadata.structural` is populated,
 *      walk up `parent_id` to find the smallest ancestor whose token
 *      count fits the per-chunk budget (default: retrieval_budget /
 *      quota).
 *   3. Replace the chunk with its ancestor section. Deduplicate when
 *      multiple hits share an ancestor.
 *   4. Return the expanded chunks with `score_kind:
 *      "structural_expanded"` and provenance pointing to the original
 *      semantic hits.
 *
 * "Smallest ancestor that fits" is read literally: walk one step up to
 * the immediate parent. If it fits the per-chunk budget, return it. If
 * the parent doesn't fit, no larger ancestor will either — return the
 * original chunk (graceful degrade per design §"Failure modes"). Multi-
 * step climbing for the worked example's "fragment → function → class"
 * case is gated on richer code chunking (deferred to 1.5.5).
 *
 * **No LLM, microseconds of work.** The whole expansion is a single
 * `getChunkByID` lookup per candidate over metadata populated at ingest
 * by [`extractStructure`](../structure-extractor.js) (1.4.14). The cheap-
 * but-load-bearing piece between fragment-level RAG and the Composer in
 * PR 9.
 *
 * **Phase-1 reach by content type:**
 *   - **prose** — paragraph chunks expand to their heading-bearing
 *     parent (the chunk that opened the section). Substantive
 *     improvement over fragment-level retrieval.
 *   - **code** — [`extractCode`](../structure-extractor.js) emits flat
 *     top-level declarations with `parent_id = null`, so structural is
 *     a no-op for code in Phase 1. Gains power either when AST chunking
 *     lands (1.5.5, gated) or when the extractor learns to nest
 *     function-inside-class. Documented in StructureExtractor itself.
 *   - **conversation / structured / spec** — pass through unchanged
 *     (no structural meta).
 *
 * **Dependency injection mirrors Semantic (1.4.15).** The strategy
 * takes a `runSemanticRetrieve` function rather than the Semantic
 * strategy object so the contract stays narrow and tests can fake the
 * upstream step without spinning up an embedder + vector store + BM25
 * index. Production callers wire `runSemanticRetrieve = (req, k) =>
 * createSemanticStrategy({...}).retrieve(req, k)` at the Composer call
 * site (PR 9 of 1.5.0). The Composer can later optimize the duplicate
 * semantic call by sharing one result across both strategies; for Phase
 * 1, each strategy is independent.
 *
 * `getChunkByID` is the second injected seam — its real implementation
 * lands with the chunk-store ingest PR. Today it's faked in tests.
 *
 * **Production wiring (since 1.5.14):** [`../manager.js:37`](../manager.js)
 * imports `createStructuralStrategy` and registers it alongside Semantic
 * + Thematic for live `find_relevant_files` calls; the legacy
 * `js/context-manager.js` file-level path retired in the same cutover.
 * Removability is inverted — deleting this module breaks structural
 * ancestor-walk expansion in production retrieval. ICD contract:
 * [`docs/DESIGN-intelligence.md`](../../../../docs/DESIGN-intelligence.md).
 *
 * @module intelligence/retrieval/strategies/structural
 */

/**
 * @typedef {import('../contracts.js').ChunkRef} ChunkRef
 * @typedef {import('../contracts.js').ChunkID} ChunkID
 * @typedef {import('../contracts.js').RetrievalRequest} RetrievalRequest
 * @typedef {import('../contracts.js').Applicability} Applicability
 * @typedef {import('../contracts.js').Strategy} Strategy
 * @typedef {import('../contracts.js').Provenance} Provenance
 */

/**
 * Caller-supplied semantic step. The strategy delegates the embed →
 * k-NN phase entirely so the structural strategy doesn't reinvent
 * embedding/cosine logic — it only owns the ancestor walk.
 *
 * @typedef {(req: RetrievalRequest, k: number) => Promise<ChunkRef[]>} RunSemanticRetrieve
 */

/**
 * Resolve a chunk by ID. Returns null when the ID is unknown (stale
 * `parent_id` reference after a re-ingest, etc.) — the strategy
 * gracefully degrades to the original chunk in that case.
 *
 * @typedef {(id: ChunkID) => Promise<ChunkRef|null>} GetChunkByID
 */

/**
 * Multiplier on `quota` used as the headroom for the upstream semantic
 * step. Mirrors Semantic strategy's own `k = quota * 3` k-NN headroom
 * — after dedup-by-shared-ancestor + per-chunk-budget rejection, the
 * working set typically thins by ~3×.
 */
const SEMANTIC_HEADROOM_MULT = 3;

/**
 * Build a Structural-strategy `Provenance` record for an expanded
 * chunk. Carries the original semantic candidate's `score` forward so
 * a downstream consumer can still rank by relevance, but stamps
 * `score_kind: "structural_expanded"` and `retrieved_by: "structural"`
 * per the design contract.
 *
 * `byte_range` / `line_range` come from the **parent** chunk because
 * the result references a different region than the semantic hit
 * (a section, not a fragment). `source_uri` likewise reflects the
 * parent (almost always the same source as the candidate, but the
 * design treats this as a parent property).
 *
 * @param {ChunkRef} parent      The expanded ancestor chunk.
 * @param {ChunkRef} candidate   Original semantic candidate.
 * @returns {ChunkRef}
 */
function withStructuralProvenance(parent, candidate) {
    /** @type {Provenance} */
    const provenance = {
        source_uri: parent.metadata.source_uri,
        byte_range: parent.provenance ? parent.provenance.byte_range : null,
        line_range: parent.provenance ? parent.provenance.line_range : null,
        retrieved_by: 'structural',
        score: candidate.provenance ? candidate.provenance.score : 0,
        score_kind: 'structural_expanded',
    };
    return {
        id: parent.id,
        collection: parent.collection,
        content: parent.content,
        tokens: parent.tokens,
        metadata: parent.metadata,
        provenance,
        embedding: null,
    };
}

/**
 * Compute the per-chunk token budget for ancestor expansion. Per
 * DESIGN-retrieval §"Structural (Phase 1: ancestor-walk)":
 * "default: retrieval_budget / quota" where retrieval_budget = total
 * - system_reserve - output_reserve - history_reserve.
 *
 * Returns 0 (which disables expansion downstream) on degenerate input
 * — non-positive budget after reserves, missing budget fields, or
 * non-positive quota. Parents with `tokens > 0` will then be rejected
 * by the budget check, leaving candidates pass through unchanged.
 *
 * @param {RetrievalRequest} req
 * @param {number}           quota
 * @returns {number}
 */
function computePerChunkBudget(req, quota) {
    if (!req || !req.budget) return 0;
    if (!Number.isFinite(quota) || quota <= 0) return 0;
    const total = Number(req.budget.total_tokens) || 0;
    const sys = Number(req.budget.system_reserve) || 0;
    const out = Number(req.budget.output_reserve) || 0;
    const hist = Number(req.budget.history_reserve) || 0;
    const retrieval = total - sys - out - hist;
    if (retrieval <= 0) return 0;
    return Math.floor(retrieval / quota);
}

/**
 * Build a Structural strategy bound to a caller-supplied semantic step
 * and a chunk-by-ID lookup. The returned object satisfies the
 * `Strategy` typedef pinned by [contracts.js](../contracts.js).
 *
 * Required deps:
 *   - `runSemanticRetrieve(req, k)`: produces semantic-strategy output
 *     for the same request at headroom `k`.
 *   - `getChunkByID(id)`: resolves a chunk by ID; returns `null` when
 *     unknown.
 *
 * `applies_to(req)` returns:
 *   - `{score: 0, ...}` when `req.query` is null/empty/whitespace
 *     (structural piggybacks on the semantic step, which itself
 *     requires a query — that's thematic territory, deferred to Phase
 *     2).
 *   - `{score: 0.8, ...}` otherwise. The design's full rule
 *     ("0.8 if the target collection has >20% of chunks carrying
 *     structural metadata and a query is present") needs a corpus
 *     probe the strategy can't do from `req` alone — the router
 *     consumer (PR 9) is responsible for that gate.
 *
 * @param {Object} deps
 * @param {RunSemanticRetrieve} deps.runSemanticRetrieve
 * @param {GetChunkByID}        deps.getChunkByID
 * @returns {Strategy}
 */
export function createStructuralStrategy({ runSemanticRetrieve, getChunkByID }) {
    if (typeof runSemanticRetrieve !== 'function') {
        throw new TypeError('createStructuralStrategy: runSemanticRetrieve must be a function');
    }
    if (typeof getChunkByID !== 'function') {
        throw new TypeError('createStructuralStrategy: getChunkByID must be a function');
    }

    // 1.6.9 — ancestor-walk memo. Keyed by `${candidate.id}::${perChunkBudget}`
    // since the same candidate at a different budget may resolve to a different
    // ancestor (oversized parent at a tight budget passes the candidate
    // through unchanged). The chunk store is mutable across re-ingests, so the
    // manager calls `clearMemo()` on every index-fingerprint bump.
    /** @type {Map<string, ChunkRef>} */
    const expandMemo = new Map();
    /** Loose cap to bound memory across long sessions; cleared by `clearMemo()` on real invalidation. */
    const MEMO_CAP = 1024;
    let memoHits = 0;
    let memoMisses = 0;

    /**
     * @param {RetrievalRequest} req
     * @returns {Applicability}
     */
    function applies_to(req) {
        const q = typeof req.query === 'string' ? req.query.trim() : '';
        if (q.length === 0) {
            return { score: 0, reason: 'structural requires a non-empty query' };
        }
        return { score: 0.8, reason: 'Phase-1 default for queries with structural-meta corpus' };
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
        const rawQuery = typeof req.query === 'string' ? req.query : '';
        if (rawQuery.trim().length === 0) return [];

        const k = Math.max(1, quota * SEMANTIC_HEADROOM_MULT);
        const candidates = await runSemanticRetrieve(req, k);
        if (!Array.isArray(candidates) || candidates.length === 0) return [];

        const perChunkBudget = computePerChunkBudget(req, quota);

        /** @type {ChunkRef[]} */
        const out = [];
        /** @type {Set<ChunkID>} */
        const seenIds = new Set();

        for (const candidate of candidates) {
            const expanded = await expandOne(candidate, perChunkBudget);
            if (seenIds.has(expanded.id)) continue;
            seenIds.add(expanded.id);
            out.push(expanded);
            if (out.length >= quota) break;
        }
        return out;
    }

    /**
     * Expand a single candidate to its immediate parent if the parent
     * fits the per-chunk budget. Per design §"Failure modes": chunks
     * without structural meta or with a null parent_id pass through
     * unchanged; an oversized parent also passes the original through
     * (Phase-1 silent — diagnostics surface lands with the Composer in
     * PR 9).
     *
     * @param {ChunkRef} candidate
     * @param {number}   perChunkBudget
     * @returns {Promise<ChunkRef>}
     */
    async function expandOne(candidate, perChunkBudget) {
        const memoKey = `${candidate.id}::${perChunkBudget}`;
        const cached = expandMemo.get(memoKey);
        if (cached !== undefined) {
            memoHits += 1;
            return cached;
        }
        memoMisses += 1;

        const structural = candidate.metadata && candidate.metadata.structural;
        let result;
        if (!structural) {
            result = candidate;
        } else {
            const parentId = structural.parent_id;
            if (!parentId) {
                result = candidate;
            } else {
                const parent = await getChunkByID(parentId);
                if (!parent) {
                    result = candidate;
                } else if (perChunkBudget <= 0) {
                    result = candidate;
                } else if (parent.tokens > perChunkBudget) {
                    result = candidate;
                } else {
                    result = withStructuralProvenance(parent, candidate);
                }
            }
        }

        if (expandMemo.size >= MEMO_CAP) {
            // Drop the oldest entry — Map iteration is insertion order.
            const oldest = expandMemo.keys().next().value;
            if (oldest !== undefined) expandMemo.delete(oldest);
        }
        expandMemo.set(memoKey, result);
        return result;
    }

    /**
     * Drop the ancestor-walk memo. Called by the manager whenever the
     * chunk store mutates (full re-ingest, single-file ingest, file
     * deletion, branch switch, index clear).
     */
    function clearMemo() {
        expandMemo.clear();
    }

    /**
     * Diagnostics seam — memo hit / miss / size for the LLM debug
     * modal. Stable across calls; counters reset only when the strategy
     * is rebuilt.
     */
    function memoStats() {
        return { hits: memoHits, misses: memoMisses, size: expandMemo.size };
    }

    return {
        name: 'structural',
        applies_to,
        retrieve,
        clearMemo,
        memoStats,
    };
}
