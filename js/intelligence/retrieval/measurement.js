// @ts-check
/**
 * Measurement harness — the integration that drives the 1.5.3 test-query
 * corpus through the 1.5.2 comparison harness against (a) the live legacy
 * `ContextManager.findRelevantFiles` pipeline and (b) a real wired-up
 * Composer + production walker. Twentieth PR in the 1.5.0 stream and the
 * piece that produces the **≥80% legacy-vs-new agreement number** that
 * promotes Retrieval Phase 1 to 1.5.0-final per the §"1.5.0 Retrieval
 * Phase 1" exit criteria in [docs/ROADMAP.md](../../../../docs/ROADMAP.md).
 *
 * **What this module is.** A pure-DI factory that constructs the two
 * runners + the comparison harness. The caller — typically the browser
 * runner at `tests/retrieval-measurement.html` — threads in production
 * `Git`, `EmbeddingsClient`, `ContextManager`, the `{ owner, repo, ref }`
 * project triple, and a pre-filtered `sourceUris` list. The module owns
 * the wiring; the call site owns the environment-coupling.
 *
 * **Why pure-DI again, here at the integration seam?** Same restraint
 * posture every prior 1.5.0 module took (loader, embedder, store,
 * controller, walker, semantic, structural, composer, comparison, corpus,
 * wiring). The legacy `ContextManager` imports `core.js` (browser-bound),
 * but a *closure* that calls `ContextManager.findRelevantFiles` does not —
 * it can be passed in from any environment. Keeping `measurement.js`
 * itself node-test-safe means we can verify the wiring contract under
 * `node --test` with fakes, and the live measurement is the browser
 * runner's job.
 *
 * **Public surface:** `createMeasurementHarness(options) =>
 * Promise<MeasurementHarness>`. The handle exposes:
 *   - `ingest(opts?: { signal? }) => Promise<WalkResult>` — drives the
 *     production walker over the supplied `sourceUris`.
 *   - `run(opts?: { topK?, onProgress?, signal? }) => Promise<ComparisonReport>` —
 *     drives `compareBatch(QUERY_CORPUS)` through both runners.
 *   - `runner.legacy(query)` / `runner.compose(query)` — exposed for ad-hoc
 *     inspection and for callers that want to per-query inspect a single
 *     pipeline without running the full corpus.
 *   - `walker` / `controller` / `store` / `comparison` handles for
 *     diagnostics (chunk count, embed failures, walker stats, comparison
 *     stats).
 *
 * **Algorithm.**
 *   1. `await createProductionIngestWalker({ Git, EmbeddingsClient,
 *      project, modelId, concurrency, onProgress, embeddingCache,
 *      contentTypeOverride })` → `{ walker, controller, store }`.
 *   2. Build the strategies the Composer will dispatch:
 *      `createSemanticStrategy({ embedQuery, chunkVectorSearch })` and
 *      `createStructuralStrategy({ runSemanticRetrieve, getChunkByID })`,
 *      delegating to (a) the production embedder via `EmbeddingsClient.embed`
 *      and (b) the in-memory store the walker populates.
 *   3. Wire `runNew(query)` → `compose({ task: '', query, collections:
 *      [collection], budget: <derived>, history: null, filters: null,
 *      strategy_hints: null, priority_pins: null, task_ledger: null }, {
 *      strategies: [semantic, structural], getChunkByID: store.getChunkByID })`.
 *   4. Wire `runLegacy(query)` → `ContextManager.findRelevantFiles(query, topK)`.
 *   5. Construct the comparison harness via `createComparisonHarness({
 *      runLegacy, runNew, topK })` (default normalizers + Jaccard metric).
 *   6. `ingest()` calls `walker.walk(sourceUris)` once. Running again is
 *      legal but the in-memory store will already be populated; the
 *      controller's `noop` short-circuit handles re-ingest correctly per
 *      the design's incremental-ingest pseudocode.
 *   7. `run()` calls `comparison.compareBatch(QUERY_CORPUS, opts)`.
 *
 * **Phase-1 scope decisions** (called out so future readers don't have to
 * reverse-engineer them from behavior):
 *
 *   1. **File-tree enumeration is the call site's job, not the harness's.**
 *      Different consumers want different filter sets — the legacy
 *      `ContextManager.indexProject` filter (size ceiling + IgnoreManager)
 *      vs. a future workspace-tree walker. The harness takes a `sourceUris:
 *      string[]` and trusts it. The browser runner builds the URI list
 *      against the same filter `ContextManager.indexProject` uses so both
 *      pipelines see the same files.
 *
 *   2. **Default Composer budget tuned for the 80% gate.** The Composer
 *      allocates `total - system - output - history` to retrieval; the
 *      browser runner cares about whether the top-K source URIs match
 *      legacy's top-K paths, not the prompt-budget math. Defaults:
 *      `total_tokens: 8000`, `system_reserve: 0`, `output_reserve: 0`,
 *      `history_reserve: 0` so the full budget is retrieval. Caller can
 *      override every field via `composerBudget`.
 *
 *   3. **No history / pins / ledger / filters in the request.** The
 *      measurement compares pure retrieval shapes. A future per-query
 *      stratification (per-category ledger, per-fixture filters) is the
 *      browser runner's concern; the factory stays minimal.
 *
 *   4. **Same `topK` across both runners.** The legacy `findRelevantFiles`
 *      takes `topK` directly; the new pipeline returns up to
 *      `DEFAULT_TOTAL_QUOTA` chunks but `normalizeComposerResult` caps the
 *      derived path list at the harness's `topK`. Defaults to 5 to match
 *      the legacy default and the corpus author's typical inspection cap.
 *
 *   5. **Errors propagate verbatim from `ingest()`.** If
 *      `EmbeddingsClient.init()` fails or the walker rejects (a defensive
 *      controller throw), the caller sees it. The comparison harness's
 *      per-query error isolation handles runner throws during `run()`,
 *      which is the right granularity for query-level resilience.
 *
 *   6. **Pre-aborted signal short-circuits `ingest()`.** Mirrors the
 *      walker's pre-abort behavior (returns immediately with `total: 0`,
 *      `aborted: true`). `run()`'s comparison harness has no abort
 *      surface in 1.5.2, so a mid-run abort flows through the harness's
 *      sequential loop only between queries, not within.
 *
 *   7. **No re-export of the report shape.** The handle returns the
 *      `ComparisonReport` from 1.5.2 verbatim; consumers already import
 *      that typedef from the barrel. Wrapping it would just gain
 *      typecasting overhead.
 *
 * **Out of scope:**
 *   - The browser runner page itself (`tests/retrieval-measurement.html`) —
 *     ships in this same PR but lives under `tests/`, not under `js/`.
 *   - Per-category agreement aggregation — the browser runner computes
 *     this from `QUERY_FIXTURES` + `perQuery` after `run()` resolves.
 *   - Tuning the Composer if agreement <80% — that's a follow-up patch
 *     series before 1.5.5 / 1.5.6 (Thematic / legacy removal).
 *   - Migration of `find_relevant_files` off legacy
 *     `js/context-manager.js` — that's 1.5.6 in the renumbered schedule.
 *   - Wiring the harness into the in-app Settings/Debug surface — the
 *     standalone HTML runner is sufficient for the one-time ≥80%
 *     measurement.
 *   - Concurrency / retry / per-query embedding cache between runs.
 *   - Persistent chunk store / IDB backing.
 *
 * **No runtime wire-up.** Nothing imports `createMeasurementHarness`
 * outside the test suite and the standalone HTML runner. With this
 * module deleted (and the barrel re-export removed and the HTML runner
 * deleted), `find_relevant_files` keeps running through legacy
 * `ContextManager.findRelevantFiles` exactly as before. Removability
 * holds (Decision §7).
 *
 * @module intelligence/retrieval/measurement
 */

import { createProductionIngestWalker } from './wiring.js';
import { createSemanticStrategy } from './strategies/semantic.js';
import { createStructuralStrategy } from './strategies/structural.js';
import { compose } from './composer.js';
import { createComparisonHarness } from './comparison.js';
import { QUERY_CORPUS } from './test-corpus.js';

/**
 * @typedef {import('./contracts.js').Project} Project
 * @typedef {import('./contracts.js').CollectionName} CollectionName
 * @typedef {import('./contracts.js').Budget} Budget
 * @typedef {import('./contracts.js').IngestResult} IngestResult
 * @typedef {import('./contracts.js').WalkResult} WalkResult
 * @typedef {import('./contracts.js').ComparisonReport} ComparisonReport
 * @typedef {import('./contracts.js').RetrievalRequest} RetrievalRequest
 * @typedef {import('./contracts.js').RetrievalResult} RetrievalResult
 * @typedef {import('./contracts.js').Strategy} Strategy
 * @typedef {import('./walker.js').IngestWalker} IngestWalker
 * @typedef {import('./ingest-controller.js').IngestController} IngestController
 * @typedef {import('./store.js').ChunkStore} ChunkStore
 * @typedef {import('./comparison.js').ComparisonHarness} ComparisonHarness
 */

/**
 * Default Composer budget. Tuned so the full `total_tokens` is available
 * for retrieval; the comparison cares about top-K source URIs, not
 * system-prompt / output / history accounting. Callers can override any
 * field via `MeasurementHarnessOptions.composerBudget`.
 *
 * @type {Budget}
 */
const DEFAULT_COMPOSER_BUDGET = Object.freeze({
    total_tokens: 8000,
    system_reserve: 0,
    output_reserve: 0,
    history_reserve: 0,
});

const DEFAULT_TOP_K = 5;
const DEFAULT_COLLECTION = 'default';

/**
 * The narrow `ContextManager` surface the harness needs. Lifted into a
 * typedef so node tests can fake it without dragging the full module's
 * surface (which imports browser-bound `core.js`).
 *
 * @typedef {Object} ContextManagerHandle
 * @property {(query: string, topK?: number) => Promise<Array<{path: string, similarity: number, summary: string}>>} findRelevantFiles
 */

/**
 * Per-runner introspection seam. Exposes the two pipeline runners the
 * harness drives so callers can inspect a single pipeline's raw output
 * for one query without going through `compareBatch`.
 *
 * @typedef {Object} MeasurementRunner
 * @property {(query: string) => Promise<Array<{path: string, similarity: number, summary: string}>>} legacy
 * @property {(query: string) => Promise<RetrievalResult>} compose
 */

/**
 * Options to `createMeasurementHarness`.
 *
 * @typedef {Object} MeasurementHarnessOptions
 * @property {{ getFile: (owner: string, repo: string, path: string, ref: string) => Promise<{ content: string }> }} Git
 *   Production `Git` namespace (or a node-test fake exposing the same
 *   `getFile` signature). Threaded to `createProductionIngestWalker`.
 * @property {{ init: () => Promise<*>, embed: (text: string) => Promise<number[]|null> }} EmbeddingsClient
 *   Production `EmbeddingsClient` (or a node-test fake exposing the same
 *   two methods). Threaded to `createProductionIngestWalker` and used
 *   directly by `createSemanticStrategy.embedQuery`.
 * @property {ContextManagerHandle} ContextManager
 *   Production `ContextManager` namespace (or a node-test fake). Drives
 *   `runLegacy(query) => ContextManager.findRelevantFiles(query, topK)`.
 *   Browser-bound in production (imports `core.js`); the harness itself
 *   does not reach into it beyond `findRelevantFiles`.
 * @property {Project} project
 *   `{ owner, repo, ref }` triple closed over by the production loader.
 * @property {string} modelId
 *   Embedder model id (participates in the embedder cache key).
 * @property {string[]} sourceUris
 *   In-repo paths the walker will ingest. Caller pre-filters (size /
 *   IgnoreManager / extension) so both pipelines see the same files.
 * @property {number|undefined} [topK]
 *   Optional. Positive integer; default 5. Drives both legacy
 *   `findRelevantFiles(query, topK)` and the new pipeline's
 *   normalization cap.
 * @property {Budget|undefined} [composerBudget]
 *   Optional. Overrides the default Composer budget. Defaults to
 *   `{ total_tokens: 8000, system_reserve: 0, output_reserve: 0, history_reserve: 0 }`.
 * @property {CollectionName|undefined} [collection]
 *   Optional. Logical collection name threaded to the controller and
 *   the new-pipeline `RetrievalRequest.collections`. Defaults to
 *   `"default"`.
 * @property {number|undefined} [concurrency]
 *   Optional. Walker concurrency; default 4. Threaded to the walker.
 * @property {((done: number, total: number, latestResult: IngestResult) => void)|undefined} [onIngestProgress]
 *   Optional. Walker progress callback for ingest. The browser runner
 *   wires this to a UI progress bar.
 * @property {ChunkStore|undefined} [store]
 *   Optional store override. Defaults to a fresh `createInMemoryChunkStore`
 *   inside `createProductionIngestWalker`.
 * @property {((source_uri: string) => (string|null))|undefined} [contentTypeOverride]
 *   Optional. Threaded to the loader.
 * @property {AbortSignal|undefined} [signal]
 *   Optional. A pre-aborted signal supplied here is honored at
 *   construction time — `ingest()` will return immediately with a
 *   pre-aborted `WalkResult`.
 */

/**
 * Public MeasurementHarness handle. Returned by `createMeasurementHarness`.
 *
 * @typedef {Object} MeasurementHarness
 * @property {(opts?: { signal?: AbortSignal }) => Promise<WalkResult>} ingest
 * @property {(opts?: { topK?: number, onProgress?: (done: number, total: number, latest: import('./contracts.js').ComparisonResult) => void, queries?: Iterable<string>|AsyncIterable<string> }) => Promise<ComparisonReport>} run
 * @property {MeasurementRunner} runner
 * @property {IngestWalker} walker
 * @property {IngestController} controller
 * @property {ChunkStore} store
 * @property {ComparisonHarness} comparison
 */

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
function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}

/**
 * Validate `MeasurementHarnessOptions`. Throws `TypeError` on misshapen
 * input — mirrors the validation posture every other 1.5.0 factory took
 * (errors at the top, real work after).
 *
 * @param {MeasurementHarnessOptions} options
 */
function validateOptions(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createMeasurementHarness: options must be an object');
    }
    const {
        Git,
        EmbeddingsClient,
        ContextManager,
        project,
        modelId,
        sourceUris,
        topK,
        composerBudget,
        collection,
        concurrency,
        onIngestProgress,
        contentTypeOverride,
    } = options;

    if (!Git || typeof Git.getFile !== 'function') {
        throw new TypeError(
            'createMeasurementHarness: Git must expose getFile(owner, repo, path, ref)',
        );
    }
    if (
        !EmbeddingsClient ||
        typeof EmbeddingsClient.init !== 'function' ||
        typeof EmbeddingsClient.embed !== 'function'
    ) {
        throw new TypeError(
            'createMeasurementHarness: EmbeddingsClient must expose init() and embed()',
        );
    }
    if (!ContextManager || typeof ContextManager.findRelevantFiles !== 'function') {
        throw new TypeError(
            'createMeasurementHarness: ContextManager must expose findRelevantFiles(query, topK)',
        );
    }
    if (!project || typeof project !== 'object') {
        throw new TypeError('createMeasurementHarness: project must be an object');
    }
    if (!isNonEmptyString(/** @type {any} */ (project).owner)) {
        throw new TypeError(
            'createMeasurementHarness: project.owner must be a non-empty string',
        );
    }
    if (!isNonEmptyString(/** @type {any} */ (project).repo)) {
        throw new TypeError(
            'createMeasurementHarness: project.repo must be a non-empty string',
        );
    }
    if (!isNonEmptyString(/** @type {any} */ (project).ref)) {
        throw new TypeError(
            'createMeasurementHarness: project.ref must be a non-empty string',
        );
    }
    if (!isNonEmptyString(modelId)) {
        throw new TypeError(
            'createMeasurementHarness: modelId must be a non-empty string',
        );
    }
    if (!Array.isArray(sourceUris)) {
        throw new TypeError(
            'createMeasurementHarness: sourceUris must be an array of strings',
        );
    }
    for (const uri of sourceUris) {
        if (!isNonEmptyString(uri)) {
            throw new TypeError(
                'createMeasurementHarness: sourceUris entries must be non-empty strings',
            );
        }
    }
    if (topK !== undefined && !isPositiveInteger(topK)) {
        throw new TypeError(
            'createMeasurementHarness: topK must be a positive integer when provided',
        );
    }
    if (composerBudget !== undefined) {
        if (!composerBudget || typeof composerBudget !== 'object') {
            throw new TypeError(
                'createMeasurementHarness: composerBudget must be an object when provided',
            );
        }
        for (const k of ['total_tokens', 'system_reserve', 'output_reserve', 'history_reserve']) {
            const v = /** @type {any} */ (composerBudget)[k];
            if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
                throw new TypeError(
                    `createMeasurementHarness: composerBudget.${k} must be a non-negative finite number when provided`,
                );
            }
        }
    }
    if (collection !== undefined && !isNonEmptyString(collection)) {
        throw new TypeError(
            'createMeasurementHarness: collection must be a non-empty string when provided',
        );
    }
    if (concurrency !== undefined && !isPositiveInteger(concurrency)) {
        throw new TypeError(
            'createMeasurementHarness: concurrency must be a positive integer when provided',
        );
    }
    if (onIngestProgress !== undefined && typeof onIngestProgress !== 'function') {
        throw new TypeError(
            'createMeasurementHarness: onIngestProgress must be a function when provided',
        );
    }
    if (contentTypeOverride !== undefined && typeof contentTypeOverride !== 'function') {
        throw new TypeError(
            'createMeasurementHarness: contentTypeOverride must be a function when provided',
        );
    }
}

/**
 * Construct a measurement harness. Async because
 * `createProductionIngestWalker` awaits `EmbeddingsClient.init()` per the
 * design's "library startup, not per-call" rule.
 *
 * @param {MeasurementHarnessOptions} options
 * @returns {Promise<MeasurementHarness>}
 */
export async function createMeasurementHarness(options) {
    validateOptions(options);

    const {
        Git,
        EmbeddingsClient,
        ContextManager,
        project,
        modelId,
        sourceUris,
        topK,
        composerBudget,
        collection,
        concurrency,
        onIngestProgress,
        store: storeOverride,
        contentTypeOverride,
    } = options;

    const finalTopK = topK ?? DEFAULT_TOP_K;
    const finalCollection = collection ?? DEFAULT_COLLECTION;
    const finalBudget = {
        total_tokens: composerBudget && typeof composerBudget.total_tokens === 'number'
            ? composerBudget.total_tokens : DEFAULT_COMPOSER_BUDGET.total_tokens,
        system_reserve: composerBudget && typeof composerBudget.system_reserve === 'number'
            ? composerBudget.system_reserve : DEFAULT_COMPOSER_BUDGET.system_reserve,
        output_reserve: composerBudget && typeof composerBudget.output_reserve === 'number'
            ? composerBudget.output_reserve : DEFAULT_COMPOSER_BUDGET.output_reserve,
        history_reserve: composerBudget && typeof composerBudget.history_reserve === 'number'
            ? composerBudget.history_reserve : DEFAULT_COMPOSER_BUDGET.history_reserve,
    };

    const { walker, controller, store } = await createProductionIngestWalker({
        Git,
        EmbeddingsClient,
        project,
        modelId,
        store: storeOverride,
        collection: finalCollection,
        concurrency,
        onProgress: onIngestProgress,
        contentTypeOverride,
    });

    const semantic = createSemanticStrategy({
        embedQuery: (text) => EmbeddingsClient.embed(text),
        chunkVectorSearch: store.chunkVectorSearch,
    });
    const structural = createStructuralStrategy({
        runSemanticRetrieve: (req, k) => semantic.retrieve(req, k),
        getChunkByID: store.getChunkByID,
    });
    /** @type {Strategy[]} */
    const strategies = [semantic, structural];

    /**
     * @param {string} query
     * @returns {Promise<RetrievalResult>}
     */
    async function runCompose(query) {
        /** @type {RetrievalRequest} */
        const req = {
            task: '',
            query,
            collections: [finalCollection],
            budget: finalBudget,
            history: null,
            filters: null,
            strategy_hints: null,
            priority_pins: null,
            task_ledger: null,
        };
        return compose(req, { strategies, getChunkByID: store.getChunkByID });
    }

    /**
     * @param {string} query
     * @returns {Promise<Array<{path: string, similarity: number, summary: string}>>}
     */
    async function runLegacy(query) {
        return ContextManager.findRelevantFiles(query, finalTopK);
    }

    const comparison = createComparisonHarness({
        runLegacy,
        runNew: runCompose,
        topK: finalTopK,
    });

    /** @type {MeasurementHarness} */
    const handle = {
        async ingest(opts) {
            const signal = opts && opts.signal;
            return walker.walk(sourceUris, signal ? { signal } : undefined);
        },
        async run(opts) {
            const queries = opts && opts.queries !== undefined ? opts.queries : QUERY_CORPUS;
            /** @type {{ topK?: number, onProgress?: (done: number, total: number, latest: import('./contracts.js').ComparisonResult) => void }} */
            const batchOpts = {};
            if (opts && opts.topK !== undefined) batchOpts.topK = opts.topK;
            if (opts && typeof opts.onProgress === 'function') batchOpts.onProgress = opts.onProgress;
            return comparison.compareBatch(queries, batchOpts);
        },
        runner: {
            legacy: runLegacy,
            compose: runCompose,
        },
        walker,
        controller,
        store,
        comparison,
    };

    return handle;
}
