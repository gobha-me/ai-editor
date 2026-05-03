// @ts-check
/**
 * Comparison harness — runs queries through two arbitrary retrieval
 * runners (legacy and new) and reports agreement. The measurement
 * infrastructure for the §1.5.0 exit criterion: *"Existing
 * `find_relevant_files` results (legacy) and new Composer results agree
 * for ≥80% of test queries."*
 *
 * **What this PR is.** A pure DI module + the typedef surface +
 * default normalizers + default metrics. Eighteenth PR in the 1.5.0
 * stream and the structural seam for the next two PRs:
 *
 *   - **Next PR (1.5.3 in the renumbered schedule):** the test-query
 *     fixture corpus the harness drives.
 *   - **The PR after (later 1.5.0-betaN):** the actual ≥80%
 *     legacy-vs-new agreement *measurement* — runs the corpus through
 *     this harness against a real wired-up Composer + the live
 *     legacy `js/context-manager.js` and reports the number that
 *     promotes the track to 1.5.0-final.
 *
 * **What this PR is NOT.** It does not run the measurement; it does
 * not ship the corpus; it does not wire up production runners; it
 * does not migrate `find_relevant_files`. Same restraint posture
 * every retrieval Phase-1 module took: one focused, pure, removable
 * factory per PR.
 *
 * **Public surface:** `createComparisonHarness({ runLegacy, runNew,
 * normalizeLegacy?, normalizeNew?, metric?, topK?, now? })`. The
 * runners are opaque callables — the harness does not care whether
 * `runLegacy` is calling `ContextManager.findRelevantFiles` (the
 * legacy file-level path at [`js/context-manager.js`](../../context-manager.js))
 * or a fake; it does not care whether `runNew` is calling
 * `compose(...)` against a wired-up Composer (1.5.1 production
 * wiring) or a fake. That separation is exactly what keeps this
 * module node-test-safe: the legacy module imports `core.js` and is
 * not node-importable, but a runner closure can live in any
 * environment its caller chooses.
 *
 * **Shape contract.** Both runners return some opaque value; the
 * normalizers reduce that to `string[]` (typically file paths or
 * source URIs). The metric scores a pair of normalized lists 0..1.
 * The harness aggregates per-query into a `ComparisonReport`.
 *
 * **Phase-1 scope decisions** (called out so future readers don't
 * have to reverse-engineer them from behavior):
 *
 *   1. **Sequential per-query, sequential within-query.** Both
 *      runners share an embedding provider in production; running
 *      them concurrently — for one query or across many — risks
 *      rate-limit churn against the same backend. The corpus is
 *      O(20-200) queries; a sequential pass finishes in seconds.
 *      Explicit concurrency is a future knob if a corpus consumer
 *      demands it.
 *
 *   2. **Per-query error isolation.** A throw in either runner is
 *      caught; the offending side records `legacyError` /
 *      `newError`, the result records `agreement: null`, and the
 *      batch continues. Same posture the walker took at 1.5.0 for
 *      `controller.ingest` failures.
 *
 *   3. **Both-empty agreement = 1.0** (Jaccard of two empty sets).
 *      Semantically correct ("both pipelines agree nothing is
 *      relevant"), but suspicious-looking in aggregate: if half the
 *      corpus is unindexable for the new pipeline and both happen to
 *      return `[]`, mean agreement looks great. The corpus PR is
 *      where empty-result filtering / weighting belongs — not here.
 *
 *   4. **Default normalizers know two shapes.**
 *      `normalizeLegacyResult` accepts legacy
 *      `Array<{ path, similarity, summary }>` (the
 *      `ContextManager.findRelevantFiles` shape).
 *      `normalizeComposerResult` accepts a `RetrievalResult`
 *      (`{ blocks, chunks_by_id, ... }`) and walks `blocks` in
 *      `position` order, collecting unique `chunks_by_id[id]
 *      .metadata.source_uri` values — attention-aware, dedup'd.
 *      Custom shapes route through the user-supplied normalizer
 *      slot.
 *
 *   5. **Defensive normalizers — never throw.** A malformed entry
 *      is skipped, not raised. The harness's job is *measurement*,
 *      not validation; a misshapen result counts as a zero-overlap
 *      sample and the report keeps moving.
 *
 *   6. **Histogram buckets:** `[0.0, 0.2)`, `[0.2, 0.4)`,
 *      `[0.4, 0.6)`, `[0.6, 0.8)`, `[0.8, 1.0]`. Five buckets, 1.0
 *      included in the last one. The shape the eventual measurement
 *      PR will plot.
 *
 *   7. **`onProgress` errors swallowed.** Diagnostic callbacks must
 *      not abort the comparison. Same posture as the walker.
 *
 *   8. **Injectable `now()`** for deterministic `durationMs`. Same
 *      DI posture every retrieval module took.
 *
 * **Out of scope (later PRs):**
 *
 *   - The fixture corpus the harness drives (next PR).
 *   - The actual ≥80% measurement run (the PR after that).
 *   - Wiring against the real `ContextManager.findRelevantFiles` —
 *     that's a *runner* the consumer constructs at the call site
 *     (browser-bound — legacy module imports `core.js`).
 *   - Wiring against a live Composer + production walker — the
 *     consumer constructs that runner at the call site (1.5.1
 *     `createProductionIngestWalker` is the building block).
 *   - Concurrency / retry / per-query embedding cache between
 *     runs — runners are opaque, so caching belongs at the runner
 *     level if the consumer wants it.
 *   - Migration of `find_relevant_files` off `js/context-manager.js`
 *     — that's 1.5.4 in the renumbered schedule.
 *
 * **No runtime wire-up.** Nothing imports `createComparisonHarness`
 * outside the test suite. With this module deleted, the barrel
 * re-exports removed, and the typedefs removed,
 * `find_relevant_files` keeps running through legacy
 * `ContextManager.findRelevantFiles` exactly as before. Removability
 * holds (Decision §7).
 *
 * @module intelligence/retrieval/comparison
 */

/**
 * @typedef {import('./contracts.js').RetrievalResult} RetrievalResult
 * @typedef {import('./contracts.js').ChunkRef} ChunkRef
 * @typedef {import('./contracts.js').ComparisonResult} ComparisonResult
 * @typedef {import('./contracts.js').ComparisonReport} ComparisonReport
 * @typedef {import('./contracts.js').AgreementHistogram} AgreementHistogram
 */

/**
 * Snapshot of accumulated harness stats. Mutating the returned object
 * does not affect future reads — `stats()` clones on each call.
 * Lifetime totals across every `compare()` and `compareBatch()` call.
 *
 * @typedef {Object} ComparisonHarnessStats
 * @property {number} calls
 * @property {number} runLegacyFailures
 * @property {number} runNewFailures
 * @property {number} batches
 */

/**
 * Public ComparisonHarness handle. Returned by
 * `createComparisonHarness`.
 *
 * @typedef {Object} ComparisonHarness
 * @property {(query: string, opts?: { topK?: number }) => Promise<ComparisonResult>} compare
 * @property {(queries: Iterable<string>|AsyncIterable<string>, opts?: ComparisonBatchOptions) => Promise<ComparisonReport>} compareBatch
 * @property {() => ComparisonHarnessStats} stats
 */

/**
 * Options to `ComparisonHarness.compareBatch()`.
 *
 * @typedef {Object} ComparisonBatchOptions
 * @property {number|undefined} [topK]
 *   Per-batch override of the harness `topK`.
 * @property {((done: number, total: number, latest: ComparisonResult) => void)|undefined} [onProgress]
 *   Optional. Invoked once per completed query. `total` is `-1` for
 *   `AsyncIterable` / non-array streamed inputs.
 */

/**
 * Options to `createComparisonHarness`.
 *
 * @typedef {Object} ComparisonHarnessOptions
 * @property {(query: string) => Promise<*>} runLegacy
 *   Required. Drives the legacy retrieval pipeline. The shape it
 *   resolves to is whatever `normalizeLegacy` understands.
 * @property {(query: string) => Promise<*>} runNew
 *   Required. Drives the new Composer pipeline. The shape it resolves
 *   to is whatever `normalizeNew` understands.
 * @property {((raw: *, opts: { topK: number }) => string[])|undefined} [normalizeLegacy]
 *   Optional. Reduces a legacy raw result to a `string[]` of paths.
 *   Defaults to `normalizeLegacyResult`.
 * @property {((raw: *, opts: { topK: number }) => string[])|undefined} [normalizeNew]
 *   Optional. Reduces a new raw result to a `string[]` of paths.
 *   Defaults to `normalizeComposerResult`.
 * @property {((a: string[], b: string[]) => number)|undefined} [metric]
 *   Optional. Scores a pair of normalized lists 0..1. Defaults to
 *   `jaccardSimilarity`.
 * @property {number|undefined} [topK]
 *   Optional. Positive integer; default 5. The cap normalizers see; a
 *   per-call `opts.topK` overrides for one query.
 * @property {(() => number)|undefined} [now]
 *   Optional. Injectable clock; defaults to `Date.now`. Tests pass a
 *   deterministic stub.
 */

const DEFAULT_TOP_K = 5;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPositiveInteger(v) {
    return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isAsyncIterable(v) {
    return v != null && typeof (/** @type {any} */ (v)[Symbol.asyncIterator]) === 'function';
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isSyncIterable(v) {
    return v != null && typeof (/** @type {any} */ (v)[Symbol.iterator]) === 'function';
}

/**
 * Adapt a sync `Iterable<T>` to an `AsyncIterator<T>` so `compareBatch`
 * can drive arrays, sets, generators, and async streams through one
 * loop. Lifted verbatim from the walker for parity.
 *
 * @template T
 * @param {Iterable<T>} iterable
 * @returns {AsyncIterator<T>}
 */
function syncToAsyncIterator(iterable) {
    const iter = iterable[Symbol.iterator]();
    return {
        async next() {
            const r = iter.next();
            return r.done
                ? { value: undefined, done: true }
                : { value: r.value, done: false };
        },
    };
}

/**
 * Default legacy normalizer. Accepts the shape
 * `ContextManager.findRelevantFiles` returns at
 * [`js/context-manager.js`](../../context-manager.js): an array of
 * `{ path, similarity, summary }`. Returns dedup'd paths in input
 * order, capped at `topK`. Also tolerates an envelope of
 * `{ files: [...] }` (the shape the `find_relevant_files` LLM tool
 * wraps the result in at [`js/tools/context-tools.js`](../../tools/context-tools.js))
 * so callers can run either without re-shaping.
 *
 * Defensive: a non-array / missing-`path` / non-string-`path` entry
 * is silently skipped. Empty input → `[]`.
 *
 * @param {unknown} raw
 * @param {{ topK: number }} opts
 * @returns {string[]}
 */
export function normalizeLegacyResult(raw, opts) {
    const topK = opts && typeof opts.topK === 'number' ? opts.topK : DEFAULT_TOP_K;
    /** @type {unknown[]} */
    let arr;
    if (Array.isArray(raw)) {
        arr = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).files)) {
        arr = /** @type {any} */ (raw).files;
    } else {
        return [];
    }
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const entry of arr) {
        if (out.length >= topK) break;
        if (!entry || typeof entry !== 'object') continue;
        const path = /** @type {any} */ (entry).path;
        if (typeof path !== 'string' || path.length === 0) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push(path);
    }
    return out;
}

/**
 * Default new-Composer normalizer. Accepts a `RetrievalResult` (the
 * shape `compose()` resolves to per [`contracts.js`](./contracts.js))
 * and reduces it to a dedup'd `string[]` of `metadata.source_uri`
 * values, ranked by **best chunk score per source**, capped at `topK`.
 *
 * **Composer tuning T2 — source-uri rollup at the normalizer**
 * (1.5.4-patch baseline run on 2026-05-03 measured `meanAgreement =
 * 0.2027` against the §1.5.0 ≥0.80 target; one of the named tuning
 * items in [docs/ROADMAP.md](../../../docs/ROADMAP.md) §"1.5.x —
 * Retrieval follow-ups"). The previous attachment-order dedup let a
 * docs file with 20 chunks scoring 0.7 each crowd a code file with
 * one chunk scoring 0.85 out of the top-K because the docs file's
 * first chunk was added before the code file's chunk was seen. The
 * rollup walks every block / chunk first, tracks the **max
 * `provenance.score` per `source_uri`** (with `firstPosition` as
 * tiebreak for back-compat), then sorts and truncates.
 *
 * Two-pass:
 *   1. **Collect.** Walk `blocks` in arrival order. For each chunk
 *      with a valid `metadata.source_uri`, record `firstPosition`
 *      (the index this URI was first seen at) and `maxScore` (max
 *      `provenance.score`, treating missing / non-finite as `0`).
 *   2. **Rank + cap.** Sort by `maxScore` DESC, then `firstPosition`
 *      ASC; take first `topK`.
 *
 * Score-less fixtures (the existing `composerResult([...])` test
 * helper does not set `provenance.score`) all tie at `maxScore = 0`
 * and fall back to `firstPosition` — observable behavior matches the
 * pre-T2 attachment-order dedup. The contract change is "code chunks
 * with real scores can outrank earlier-positioned prose chunks"; the
 * change is invisible to callers that don't populate `provenance`.
 *
 * Defensive: a missing / non-object `chunks_by_id`, a missing /
 * non-array `blocks`, a chunk without `metadata.source_uri`, or a
 * non-string `source_uri` all skip silently — `[]` is the documented
 * "I have nothing for you" response.
 *
 * @param {unknown} raw
 * @param {{ topK: number }} opts
 * @returns {string[]}
 */
export function normalizeComposerResult(raw, opts) {
    const topK = opts && typeof opts.topK === 'number' ? opts.topK : DEFAULT_TOP_K;
    if (!raw || typeof raw !== 'object') return [];
    const blocks = /** @type {any} */ (raw).blocks;
    const chunksById = /** @type {any} */ (raw).chunks_by_id;
    if (!Array.isArray(blocks) || !chunksById || typeof chunksById !== 'object') return [];
    /** @type {Map<string, { firstPosition: number, maxScore: number }>} */
    const perSource = new Map();
    let position = 0;
    // Pass 1 — collect per-source max-score + first-position. The
    // Composer assigns `block.position` ∈
    // {'head','task','retrieved','history','tail'}; we honor whatever
    // order the result arrived in (the design's "callers concatenate
    // by position order" contract is the caller's job, not the
    // harness's). `position` advances on every visited chunk so ties
    // on `maxScore` resolve to the order chunks appeared across all
    // blocks.
    for (const block of blocks) {
        if (!block || !Array.isArray(block.chunks)) continue;
        for (const id of block.chunks) {
            if (typeof id !== 'string' || id.length === 0) continue;
            const chunk = chunksById[id];
            if (!chunk || typeof chunk !== 'object') continue;
            const meta = /** @type {any} */ (chunk).metadata;
            if (!meta || typeof meta !== 'object') continue;
            const uri = meta.source_uri;
            if (typeof uri !== 'string' || uri.length === 0) continue;
            const prov = /** @type {any} */ (chunk).provenance;
            const rawScore = prov && typeof prov === 'object' ? prov.score : undefined;
            const score = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 0;
            const existing = perSource.get(uri);
            if (existing === undefined) {
                perSource.set(uri, { firstPosition: position, maxScore: score });
            } else if (score > existing.maxScore) {
                existing.maxScore = score;
            }
            position += 1;
        }
    }
    if (perSource.size === 0) return [];
    // Pass 2 — rank and cap.
    /** @type {Array<{ uri: string, firstPosition: number, maxScore: number }>} */
    const entries = [];
    for (const [uri, rec] of perSource) {
        entries.push({ uri, firstPosition: rec.firstPosition, maxScore: rec.maxScore });
    }
    entries.sort((a, b) => {
        if (b.maxScore !== a.maxScore) return b.maxScore - a.maxScore;
        return a.firstPosition - b.firstPosition;
    });
    /** @type {string[]} */
    const out = [];
    for (let i = 0; i < entries.length && out.length < topK; i++) {
        out.push(entries[i].uri);
    }
    return out;
}

/**
 * Symmetric set Jaccard: `|A ∩ B| / |A ∪ B|`. Both arrays empty →
 * `1.0` (the textbook empty-set convention; semantically: "both
 * pipelines agree nothing is relevant"). Exactly one empty → `0.0`.
 *
 * Inputs are coerced to sets — duplicates within an array don't
 * inflate or deflate the score.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccardSimilarity(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const x of setA) if (setB.has(x)) inter += 1;
    const union = setA.size + setB.size - inter;
    return inter / union;
}

/**
 * Asymmetric precision-at-k: `|Set(predicted ∩ reference)| / k`.
 * Useful when treating one side (typically legacy) as the reference
 * baseline and asking "what fraction of the predicted top-k is in
 * the reference set?". Note that the divisor is `k`, not
 * `predicted.length` — a runner returning fewer than `k` results
 * still gets scored against the full quota, so a half-empty result
 * cannot achieve precision 1.0.
 *
 * `k <= 0` → `0`. `predicted` longer than `k` → only the first `k`
 * are considered.
 *
 * @param {string[]} predicted
 * @param {string[]} reference
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(predicted, reference, k) {
    if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) return 0;
    if (!Array.isArray(predicted) || !Array.isArray(reference)) return 0;
    const refSet = new Set(reference);
    const seen = new Set();
    let hits = 0;
    let considered = 0;
    for (const p of predicted) {
        if (considered >= k) break;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        considered += 1;
        if (refSet.has(p)) hits += 1;
    }
    return hits / k;
}

/**
 * Asymmetric recall-at-k: `|Set(predicted ∩ reference)| / |reference|`.
 * Useful when treating `reference` as a hand-curated ground-truth set
 * and asking "what fraction of the relevant files landed in the
 * predicted top-k?". Companion to `precisionAtK` for the 1.5.5
 * ground-truth measurement reframe — when `reference` is short (1-2
 * canonical paths), `precisionAtK` is naturally pegged to a low
 * ceiling (1/k); `recallAtK` reaches 1.0 once all the relevant files
 * are recovered.
 *
 * `k <= 0` → `0`. `predicted` longer than `k` → only the first `k`
 * (after dedup) are considered. Empty `reference` → `0` (no relevant
 * set to recall against; semantically: "we can't measure recall
 * without ground truth"; differs from `precisionAtK`'s convention
 * because there's no analogous "both-empty agree" case here).
 *
 * @param {string[]} predicted
 * @param {string[]} reference
 * @param {number} k
 * @returns {number}
 */
export function recallAtK(predicted, reference, k) {
    if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) return 0;
    if (!Array.isArray(predicted) || !Array.isArray(reference)) return 0;
    if (reference.length === 0) return 0;
    const refSet = new Set(reference);
    const seen = new Set();
    let hits = 0;
    let considered = 0;
    for (const p of predicted) {
        if (considered >= k) break;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        considered += 1;
        if (refSet.has(p)) hits += 1;
    }
    return hits / refSet.size;
}

/**
 * Hit-at-k: `1` iff at least one entry in `predicted[:k]` is in
 * `reference`, else `0`. The simplest binary "did the retrieval find
 * anything correct in the top-k?" signal — useful as a sanity floor
 * even when `precisionAtK` / `recallAtK` are noisy due to small
 * reference sets.
 *
 * `k <= 0` → `0`. Empty `reference` → `0`.
 *
 * @param {string[]} predicted
 * @param {string[]} reference
 * @param {number} k
 * @returns {number}
 */
export function hitAtK(predicted, reference, k) {
    if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) return 0;
    if (!Array.isArray(predicted) || !Array.isArray(reference)) return 0;
    if (reference.length === 0) return 0;
    const refSet = new Set(reference);
    const seen = new Set();
    let considered = 0;
    for (const p of predicted) {
        if (considered >= k) break;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        considered += 1;
        if (refSet.has(p)) return 1;
    }
    return 0;
}

/**
 * Reciprocal rank of the first `predicted` entry in `reference`,
 * capped at rank `k` (`1 / rank`, rank ∈ {1, …, k}). The "good
 * ranking" signal: a top-1 hit scores `1.0`; a top-5 hit scores
 * `0.2`; no hit in the top-`k` scores `0`. Mean across queries is
 * the standard MRR aggregate.
 *
 * `k <= 0` → `0`. Empty `reference` → `0`. Dedup is applied to
 * `predicted` before counting positions (so a duplicate URI doesn't
 * shift the rank).
 *
 * @param {string[]} predicted
 * @param {string[]} reference
 * @param {number} k
 * @returns {number}
 */
export function reciprocalRankAtK(predicted, reference, k) {
    if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) return 0;
    if (!Array.isArray(predicted) || !Array.isArray(reference)) return 0;
    if (reference.length === 0) return 0;
    const refSet = new Set(reference);
    const seen = new Set();
    let rank = 0;
    for (const p of predicted) {
        if (rank >= k) break;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        rank += 1;
        if (refSet.has(p)) return 1 / rank;
    }
    return 0;
}

/**
 * Bucket boundary: returns the histogram key for an agreement value
 * in `[0, 1]`. Buckets are left-closed, right-open except the last
 * (`0.8-1.0`) which includes 1.0.
 *
 * @param {number} v
 * @returns {keyof AgreementHistogram}
 */
function bucketFor(v) {
    if (v < 0.2) return '0.0-0.2';
    if (v < 0.4) return '0.2-0.4';
    if (v < 0.6) return '0.4-0.6';
    if (v < 0.8) return '0.6-0.8';
    return '0.8-1.0';
}

/**
 * @returns {AgreementHistogram}
 */
function emptyHistogram() {
    return {
        '0.0-0.2': 0,
        '0.2-0.4': 0,
        '0.4-0.6': 0,
        '0.6-0.8': 0,
        '0.8-1.0': 0,
    };
}

/**
 * Construct a comparison harness. The returned handle exposes
 * `compare(query, opts?)` (one query, both pipelines), `compareBatch(
 * queries, opts?)` (many queries, aggregated), and `stats()` (a
 * lifetime snapshot across every comparison made on this handle).
 *
 * @param {ComparisonHarnessOptions} options
 * @returns {ComparisonHarness}
 */
export function createComparisonHarness(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createComparisonHarness: options must be an object');
    }
    const {
        runLegacy,
        runNew,
        normalizeLegacy,
        normalizeNew,
        metric,
        topK,
        now,
    } = options;
    if (typeof runLegacy !== 'function') {
        throw new TypeError('createComparisonHarness: runLegacy must be a function');
    }
    if (typeof runNew !== 'function') {
        throw new TypeError('createComparisonHarness: runNew must be a function');
    }
    if (normalizeLegacy !== undefined && typeof normalizeLegacy !== 'function') {
        throw new TypeError(
            'createComparisonHarness: normalizeLegacy must be a function when provided',
        );
    }
    if (normalizeNew !== undefined && typeof normalizeNew !== 'function') {
        throw new TypeError(
            'createComparisonHarness: normalizeNew must be a function when provided',
        );
    }
    if (metric !== undefined && typeof metric !== 'function') {
        throw new TypeError(
            'createComparisonHarness: metric must be a function when provided',
        );
    }
    if (topK !== undefined && !isPositiveInteger(topK)) {
        throw new TypeError(
            'createComparisonHarness: topK must be a positive integer when provided',
        );
    }
    if (now !== undefined && typeof now !== 'function') {
        throw new TypeError(
            'createComparisonHarness: now must be a function when provided',
        );
    }

    const normLegacy = normalizeLegacy ?? normalizeLegacyResult;
    const normNew = normalizeNew ?? normalizeComposerResult;
    const score = metric ?? jaccardSimilarity;
    const defaultTopK = topK ?? DEFAULT_TOP_K;
    const clock = now ?? Date.now;

    let calls = 0;
    let runLegacyFailures = 0;
    let runNewFailures = 0;
    let batches = 0;

    /**
     * Score one pipeline's paths against a ground-truth reference. Returns
     * `null` when paths are null (runner errored). Used for the 1.5.5
     * ground-truth metrics computed from `opts.expectedPaths`.
     *
     * @param {string[]|null} paths
     * @param {string[]|null} expected
     * @returns {import('./contracts.js').GroundTruthScores|null}
     */
    function scoreAgainstGroundTruth(paths, expected) {
        if (paths === null || expected === null) return null;
        return {
            precisionAt5: precisionAtK(paths, expected, 5),
            recallAt5: recallAtK(paths, expected, 5),
            hitAt5: hitAtK(paths, expected, 5),
            mrr: reciprocalRankAtK(paths, expected, 5),
        };
    }

    /**
     * @param {string} query
     * @param {{ topK?: number, expectedPaths?: string[]|null, category?: string|null }} [opts]
     * @returns {Promise<ComparisonResult>}
     */
    async function compare(query, opts) {
        if (typeof query !== 'string') {
            throw new TypeError('ComparisonHarness.compare: query must be a string');
        }
        const k = opts && opts.topK !== undefined ? opts.topK : defaultTopK;
        if (!isPositiveInteger(k)) {
            throw new TypeError(
                'ComparisonHarness.compare: opts.topK must be a positive integer when provided',
            );
        }
        /** @type {string[]|null} */
        let expectedPaths = null;
        if (opts && opts.expectedPaths !== undefined && opts.expectedPaths !== null) {
            if (!Array.isArray(opts.expectedPaths)) {
                throw new TypeError(
                    'ComparisonHarness.compare: opts.expectedPaths must be an array of strings or null',
                );
            }
            expectedPaths = opts.expectedPaths;
        }
        /** @type {string|null} */
        let category = null;
        if (opts && opts.category !== undefined && opts.category !== null) {
            if (typeof opts.category !== 'string') {
                throw new TypeError(
                    'ComparisonHarness.compare: opts.category must be a string or null',
                );
            }
            category = opts.category;
        }

        const startedAt = clock();
        calls += 1;

        /** @type {string[]|null} */
        let legacyPaths = null;
        /** @type {string[]|null} */
        let newPaths = null;
        /** @type {Error|null} */
        let legacyError = null;
        /** @type {Error|null} */
        let newError = null;

        try {
            const raw = await runLegacy(query);
            legacyPaths = normLegacy(raw, { topK: k });
            if (!Array.isArray(legacyPaths)) legacyPaths = [];
        } catch (err) {
            runLegacyFailures += 1;
            legacyError = err instanceof Error ? err : new Error(String(err));
        }

        try {
            const raw = await runNew(query);
            newPaths = normNew(raw, { topK: k });
            if (!Array.isArray(newPaths)) newPaths = [];
        } catch (err) {
            runNewFailures += 1;
            newError = err instanceof Error ? err : new Error(String(err));
        }

        /** @type {number|null} */
        let agreement = null;
        if (legacyPaths !== null && newPaths !== null) {
            agreement = score(legacyPaths, newPaths);
            if (typeof agreement !== 'number' || !Number.isFinite(agreement)) {
                agreement = 0;
            } else if (agreement < 0) {
                agreement = 0;
            } else if (agreement > 1) {
                agreement = 1;
            }
        }

        const legacyGroundTruth = scoreAgainstGroundTruth(legacyPaths, expectedPaths);
        const newGroundTruth = scoreAgainstGroundTruth(newPaths, expectedPaths);

        const endedAt = clock();
        return {
            query,
            legacyPaths,
            newPaths,
            legacyError,
            newError,
            agreement,
            durationMs: Math.max(0, endedAt - startedAt),
            expectedPaths,
            category,
            legacyGroundTruth,
            newGroundTruth,
        };
    }

    /**
     * Coerce a `compareBatch` input item to a normalized
     * `{ query, expectedPaths, category }` triple. Strings stay
     * back-compatible (no ground truth, no category). Objects must
     * carry `query: string` and may carry optional
     * `expectedPaths: string[]` / `category: string`.
     *
     * @param {unknown} item
     * @returns {{ query: string, expectedPaths: string[]|null, category: string|null }}
     */
    function normalizeBatchItem(item) {
        if (typeof item === 'string') {
            return { query: item, expectedPaths: null, category: null };
        }
        if (item && typeof item === 'object') {
            const obj = /** @type {any} */ (item);
            if (typeof obj.query !== 'string') {
                throw new TypeError(
                    'ComparisonHarness.compareBatch: fixture object must have a string `query`',
                );
            }
            const ep = obj.expectedPaths;
            if (ep !== undefined && ep !== null && !Array.isArray(ep)) {
                throw new TypeError(
                    'ComparisonHarness.compareBatch: fixture `expectedPaths` must be an array or null',
                );
            }
            const cat = obj.category;
            if (cat !== undefined && cat !== null && typeof cat !== 'string') {
                throw new TypeError(
                    'ComparisonHarness.compareBatch: fixture `category` must be a string or null',
                );
            }
            return {
                query: obj.query,
                expectedPaths: Array.isArray(ep) ? ep : null,
                category: typeof cat === 'string' ? cat : null,
            };
        }
        throw new TypeError(
            `ComparisonHarness.compareBatch: items must be strings or { query, expectedPaths?, category? } objects (got ${typeof item})`,
        );
    }

    /**
     * Aggregator for ground-truth scores across a batch. Sums per
     * metric, counts non-null contributions, then divides at the end.
     * Tracks both an overall pool and an optional per-category pool.
     *
     * @returns {{
     *   add: (gt: import('./contracts.js').GroundTruthScores|null, category: string|null) => void,
     *   finalizeOverall: () => import('./contracts.js').GroundTruthAggregate|null,
     *   finalizeByCategory: () => import('./contracts.js').GroundTruthByCategory,
     * }}
     */
    function makeGroundTruthAggregator() {
        const overall = { p: 0, r: 0, h: 0, m: 0, n: 0 };
        /** @type {Object<string, { p: number, r: number, h: number, m: number, n: number }>} */
        const byCat = {};
        return {
            add(gt, category) {
                if (gt === null) return;
                overall.p += gt.precisionAt5 ?? 0;
                overall.r += gt.recallAt5 ?? 0;
                overall.h += gt.hitAt5 ?? 0;
                overall.m += gt.mrr ?? 0;
                overall.n += 1;
                if (category) {
                    if (!byCat[category]) byCat[category] = { p: 0, r: 0, h: 0, m: 0, n: 0 };
                    byCat[category].p += gt.precisionAt5 ?? 0;
                    byCat[category].r += gt.recallAt5 ?? 0;
                    byCat[category].h += gt.hitAt5 ?? 0;
                    byCat[category].m += gt.mrr ?? 0;
                    byCat[category].n += 1;
                }
            },
            finalizeOverall() {
                if (overall.n === 0) return null;
                return {
                    meanPrecisionAt5: overall.p / overall.n,
                    meanRecallAt5: overall.r / overall.n,
                    meanHitAt5: overall.h / overall.n,
                    meanMRR: overall.m / overall.n,
                    sampleCount: overall.n,
                };
            },
            finalizeByCategory() {
                /** @type {import('./contracts.js').GroundTruthByCategory} */
                const out = {};
                for (const [cat, sums] of Object.entries(byCat)) {
                    out[cat] = {
                        meanPrecisionAt5: sums.p / sums.n,
                        meanRecallAt5: sums.r / sums.n,
                        meanHitAt5: sums.h / sums.n,
                        meanMRR: sums.m / sums.n,
                        sampleCount: sums.n,
                    };
                }
                return out;
            },
        };
    }

    /**
     * @param {Iterable<string|{query: string, expectedPaths?: string[]|null, category?: string|null}>|AsyncIterable<string|{query: string, expectedPaths?: string[]|null, category?: string|null}>} queries
     * @param {ComparisonBatchOptions} [opts]
     * @returns {Promise<ComparisonReport>}
     */
    async function compareBatch(queries, opts) {
        const batchK = opts && opts.topK !== undefined ? opts.topK : defaultTopK;
        if (!isPositiveInteger(batchK)) {
            throw new TypeError(
                'ComparisonHarness.compareBatch: opts.topK must be a positive integer when provided',
            );
        }
        const onProgress = opts && opts.onProgress;
        if (onProgress !== undefined && typeof onProgress !== 'function') {
            throw new TypeError(
                'ComparisonHarness.compareBatch: opts.onProgress must be a function when provided',
            );
        }

        /** @type {number} */
        let knownTotal;
        /** @type {AsyncIterator<unknown>} */
        let iter;
        if (Array.isArray(queries)) {
            knownTotal = queries.length;
            iter = syncToAsyncIterator(queries);
        } else if (isAsyncIterable(queries)) {
            knownTotal = -1;
            iter = /** @type {AsyncIterable<unknown>} */ (queries)[Symbol.asyncIterator]();
        } else if (isSyncIterable(queries)) {
            knownTotal = -1;
            iter = syncToAsyncIterator(/** @type {Iterable<unknown>} */ (queries));
        } else {
            throw new TypeError(
                'ComparisonHarness.compareBatch: queries must be an Iterable or AsyncIterable',
            );
        }

        batches += 1;
        const startedAt = clock();
        /** @type {ComparisonResult[]} */
        const perQuery = [];
        let legacyFailures = 0;
        let newFailures = 0;
        let agreementSum = 0;
        let agreementCount = 0;
        const histogram = emptyHistogram();
        let dispatched = 0;
        const legacyAgg = makeGroundTruthAggregator();
        const newAgg = makeGroundTruthAggregator();

        while (true) {
            const next = await iter.next();
            if (next.done) break;
            const item = normalizeBatchItem(next.value);
            const result = await compare(item.query, {
                topK: batchK,
                expectedPaths: item.expectedPaths,
                category: item.category,
            });
            perQuery.push(result);
            if (result.legacyError) legacyFailures += 1;
            if (result.newError) newFailures += 1;
            if (result.agreement !== null) {
                agreementSum += result.agreement;
                agreementCount += 1;
                histogram[bucketFor(result.agreement)] += 1;
            }
            legacyAgg.add(result.legacyGroundTruth, result.category);
            newAgg.add(result.newGroundTruth, result.category);
            dispatched += 1;
            if (onProgress) {
                try {
                    onProgress(dispatched, knownTotal, result);
                } catch {
                    // Diagnostic callbacks must not abort the batch.
                }
            }
        }

        const endedAt = clock();
        return {
            total: perQuery.length,
            perQuery,
            meanAgreement: agreementCount > 0 ? agreementSum / agreementCount : null,
            histogram,
            legacyFailures,
            newFailures,
            durationMs: Math.max(0, endedAt - startedAt),
            legacyGroundTruth: legacyAgg.finalizeOverall(),
            newGroundTruth: newAgg.finalizeOverall(),
            legacyByCategory: legacyAgg.finalizeByCategory(),
            newByCategory: newAgg.finalizeByCategory(),
        };
    }

    return {
        compare,
        compareBatch,
        stats() {
            return {
                calls,
                runLegacyFailures,
                runNewFailures,
                batches,
            };
        },
    };
}
