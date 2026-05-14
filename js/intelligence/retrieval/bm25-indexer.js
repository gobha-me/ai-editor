// @ts-check
/**
 * BM25 index producer (1.5.11) — Phase-1 fulfillment of the
 * `getBM25Index` injection seam shipped at 1.4.15 in
 * [`strategies/semantic.js`](./strategies/semantic.js). Promotes the test-
 * fixture `buildBM25Index` from `tests/test-retrieval-semantic-strategy.mjs`
 * (lines 80-98) into production code with the same algorithm.
 *
 * **What this module is.** A pure transform `(chunks: ChunkRef[], opts?) →
 * BM25Index`. The strategy's hybrid path (`score_kind: "hybrid"`) and pure-
 * BM25 fallback path (`score_kind: "bm25"`) have been wired since 1.4.15;
 * they fall back to pure-cosine because every call site has null-injected
 * `getBM25Index`. This producer is what fills that slot — the measurement
 * harness materializes one over `store.getAllChunksForCollection(...)`
 * after ingest finishes.
 *
 * **Algorithm.** Matches what `scoreBM25Doc` ([semantic.js:168-190](./strategies/semantic.js))
 * expects to consume — same tokenizer, same IDF formula, same `avgdl`
 * convention:
 *
 *   1. Tokenize each chunk's `content` with the strategy's exported
 *      `tokenizeBM25` (importing rather than re-implementing prevents
 *      tokenizer drift between index build and query path).
 *   2. Compute document frequency `df[term] = count of distinct chunks
 *      containing term`.
 *   3. `avgdl = Σ(token count per chunk) / N`. Empty corpus → `avgdl = 0`
 *      (the strategy collapses BM25 contribution to 0 when avgdl is 0).
 *   4. `idf[term] = ln(((N - df + 0.5) / (df + 0.5)) + 1)` — the BM25 IDF
 *      with +1 inside the log to keep IDF non-negative. Verified by the
 *      shipped test fixture at line 95 of `tests/test-retrieval-semantic-strategy.mjs`.
 *   5. Return `{ idfMap, avgdl, chunks, k1, b }` matching the `BM25Index`
 *      typedef pinned at [semantic.js:78-84](./strategies/semantic.js).
 *
 * **Phase-1 scope decisions:**
 *
 *   1. **Pure function, no I/O, no async.** Same posture every other
 *      retrieval module took. The caller materializes chunks (via
 *      `store.getAllChunksForCollection` or any other source) and threads
 *      them in; the producer transforms.
 *
 *   2. **Reuses `tokenizeBM25` from the strategy, never duplicates.** The
 *      strategy's `scoreBM25Doc` re-tokenizes every doc on every query;
 *      a separately-defined index-time tokenizer would silently drift and
 *      score 0 against a corpus it indexed. Importing pins the contract.
 *
 *   3. **Treats non-string `content` as empty content.** `scoreBM25Doc`
 *      already returns 0 for contentless docs at query time, and
 *      `tokenizeBM25('')` returns `[]`; coercing missing content to `''`
 *      at index time matches what the strategy would compute and keeps
 *      the chunks in `index.chunks` so the pure-BM25 fallback path's
 *      `applyMetadataFilter(index.chunks, ...)` still sees them. They
 *      contribute 0 to DF (no terms) and 0 to `totalLen`, but `N`
 *      counts every input chunk so `avgdl` matches what the test
 *      fixture at `tests/test-retrieval-semantic-strategy.mjs:80-98`
 *      computes against the same corpus.
 *
 *   4. **`k1`/`b` carry through from `opts` if supplied; otherwise
 *      omitted.** The strategy applies its textbook defaults (1.5 / 0.75)
 *      when `index.k1` / `index.b` are absent — passing `undefined`
 *      through preserves that contract. Callers can override per-index
 *      for tuning experiments without reaching into the strategy.
 *
 *   5. **No persistence; no incremental rebuild.** This PR's only consumer
 *      was the measurement harness, which built the index once after
 *      ingest finished (corpus static during a measurement run). The
 *      1.5.14 cutover wired `buildBM25Index` into the production
 *      retrieval Manager (`manager.js`); incremental updates remain
 *      a separate scoping decision and have not landed.
 *
 *   6. **No RRF tuning surface.** The strategy hardcodes `RRF_K = 60`
 *      (Cormack et al. 2009). If T7 measurement shows BM25 helping, RRF
 *      tuning is a same-branch follow-up. If not, this PR didn't introduce
 *      a knob to clean up.
 *
 * **Out of scope:**
 *   - Persistent / IDB-backed BM25 index storage.
 *   - Incremental index updates as chunks `upsert` / `markStale`.
 *   - Settings UI for `k1` / `b` tuning.
 *   - Production wire-up to `find_relevant_files` — that's the legacy-
 *     retirement decision.
 *
 * **Removability check.** Delete `bm25-indexer.js`, drop the barrel export,
 * drop the four-line wire-up in `measurement.js`. The `getBM25Index` slot
 * returns to null-injected, the strategy falls back to pure cosine, recall@5
 * returns to the 1.5.10 baseline. No production code path runs through any
 * of this. Removability holds (Decision §7).
 *
 * @module intelligence/retrieval/bm25-indexer
 */

import { tokenizeBM25 } from './strategies/semantic.js';

/**
 * @typedef {import('./contracts.js').ChunkRef} ChunkRef
 * @typedef {import('./strategies/semantic.js').BM25Index} BM25Index
 */

/**
 * @typedef {Object} BM25IndexerOptions
 * @property {number} [k1] BM25 saturation parameter override (default 1.5
 *   applied at the strategy via `DEFAULT_BM25_K1`).
 * @property {number} [b]  BM25 length-normalization override (default 0.75
 *   applied at the strategy via `DEFAULT_BM25_B`).
 */

/**
 * Build a BM25 index over a chunk corpus. Pure function — no I/O, no
 * async, no mutation of the input array.
 *
 * @param {ChunkRef[]} chunks
 * @param {BM25IndexerOptions} [opts]
 * @returns {BM25Index}
 */
export function buildBM25Index(chunks, opts) {
    if (!Array.isArray(chunks)) {
        throw new TypeError('buildBM25Index: chunks must be an array');
    }
    const k1 = opts && typeof opts.k1 === 'number' ? opts.k1 : undefined;
    const b = opts && typeof opts.b === 'number' ? opts.b : undefined;

    /** @type {Map<string, number>} */
    const df = new Map();
    let totalLen = 0;

    for (const chunk of chunks) {
        const content = chunk && typeof chunk.content === 'string' ? chunk.content : '';
        const toks = tokenizeBM25(content);
        totalLen += toks.length;
        const seen = new Set(toks);
        for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }

    const N = chunks.length;
    const avgdl = N === 0 ? 0 : totalLen / N;

    /** @type {Map<string, number>} */
    const idfMap = new Map();
    for (const [t, n] of df) {
        idfMap.set(t, Math.log(((N - n + 0.5) / (n + 0.5)) + 1));
    }

    /** @type {BM25Index} */
    const index = { idfMap, avgdl, chunks, k1, b };
    return index;
}
