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
 *     drives `compareBatch(DEFAULT_BATCH_FIXTURES)` (the
 *     `{query, expectedPaths, category}` shape from `QUERY_FIXTURES`)
 *     through both runners. Pass `queries: QUERY_CORPUS` for the
 *     pre-1.5.5 string-only / agreement-only behavior.
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
 *   7. `run()` calls `comparison.compareBatch(DEFAULT_BATCH_FIXTURES, opts)`
 *      so each query's hand-curated `expectedPaths` reaches the harness
 *      and the per-pipeline ground-truth metrics aggregate per category.
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
 *   3. **Default `filters` excludes prose (Composer tuning T1).** The
 *      1.5.4-patch baseline run on 2026-05-03 measured `meanAgreement =
 *      0.2027` against the §1.5.0 ≥0.80 target; the divergence pattern
 *      was the new chunk-level pipeline over-preferring `docs/*.md` and
 *      `html/*.html` (each emitting ~20 well-scoring prose chunks) over
 *      implementation files. T1 ships a default content-type accept-list
 *      (`['code', 'conversation', 'structured', 'spec']`) on
 *      `req.filters` — Semantic's `applyMetadataFilter` already honors
 *      it, so the change is one line at the request-construction site.
 *      Callers can pass `composeFilters: null` to restore pre-T1
 *      behavior, or pass an explicit `MetadataFilter` for T3-style
 *      per-category experimentation. History / pins / ledger / hints
 *      remain pure retrieval shapes — those stay null.
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
import { QUERY_CORPUS, QUERY_FIXTURES, QUERY_CATEGORIES } from './test-corpus.js';

/**
 * Default batch input for `harness.run()` — the richer
 * `{query, expectedPaths, category}` shape from `QUERY_FIXTURES` so
 * the comparison harness computes per-pipeline ground-truth metrics
 * (precision/recall/hit/MRR @5) and per-category aggregates against
 * the curated reference set. Drives the §1.5.0 exit criterion at
 * 1.5.5+ (`mean recall@5 ≥ 0.80`). Callers wanting the pre-1.5.5
 * agreement-only behavior can pass `queries: QUERY_CORPUS` (flat
 * strings, no ground truth) explicitly via `run({ queries })`.
 *
 * Frozen at module load.
 *
 * @type {ReadonlyArray<{ query: string, expectedPaths: string[], category: string }>}
 */
const DEFAULT_BATCH_FIXTURES = Object.freeze(
    QUERY_FIXTURES.map((f) => Object.freeze({
        query: f.query,
        expectedPaths: f.expectedPaths,
        category: f.category,
    })),
);

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
 * Composer tuning T1 — default content-type accept-list passed as
 * `req.filters.content_types` when no per-fixture category is supplied.
 * Excludes `'prose'` (per the 1.5.4-patch divergence pattern: docs/HTML
 * files dominate the new pipeline's top-K because each emits ~20
 * well-scoring chunks). Frozen to prevent caller mutation; callers
 * wanting a different filter pass `composeFilters` explicitly (or `null`
 * to restore pre-T1 behavior).
 *
 * @type {import('./contracts.js').MetadataFilter}
 */
const DEFAULT_COMPOSE_FILTERS = Object.freeze({
    content_types: Object.freeze(['code', 'conversation', 'structured', 'spec']),
});

/**
 * Composer tuning T3 — default per-category content-type accept-list. Used
 * by the default `composeFilters` resolver when a fixture supplies a
 * `category`.
 *
 * **Every entry is `['code']`.** The first T3 cut (2026-05-03 a.m.)
 * admitted `'prose'` for the three mixed categories that have at least
 * one prose canonical (`bug-investigation` → `CHANGELOG.md`,
 * `onboarding` / `topic` → `docs/PLUGIN.md`) on the theory that the T2
 * source-uri max-score rollup would prevent prose dilution. The
 * canonical T4 measurement (2026-05-03 20:20,
 * `docs/measurements/2026-05-03-retrieval-recall-ground-truth.json`)
 * falsified that theory:
 *
 *   - `bug-investigation` 0.324 → 0.276 (-0.048)
 *   - `onboarding`        0.583 → 0.417 (-0.166)
 *   - `topic`             0.455 → 0.359 (-0.096)
 *   - `task-related`      0.331 → 0.386 (+0.055) ← narrowing helped
 *   - headline            0.541 → 0.497 (-0.044) ← net regression
 *
 * The prose admission *did* retrieve the prose canonicals (e.g. T4's
 * `write-new-plugin` got `docs/PLUGIN.md` at rank 1, `plugins-register-hooks`
 * got it at rank 2), but the cost was prose chunks displacing code
 * canonicals on other queries in the same bucket: T4's
 * `how do I add a new role?` returned `docs/ROLES_AND_TOOLS.md` +
 * `docs/PLUGIN.md` instead of `js/settings/roles-tab.js`, scoring 0%.
 *
 * Verdict: the T2 max-score rollup is not strong enough to neutralize
 * prose dominance across a category. The map is therefore narrowed to
 * `['code']` everywhere — the three prose canonicals become unreachable
 * (they were already unreachable under T1's default), but the
 * regression on the rest of the bucket is recovered. The `task-related`
 * +0.055 from narrowing is preserved.
 *
 * `'conversation'` / `'spec'` / `'structured'` are absent because they
 * don't appear as canonicals in this corpus (verified 2026-05-03
 * against `QUERY_FIXTURES`); `'conversation'` is `memory://` only and
 * `'spec'` is post-Phase-1 per `js/intelligence/retrieval/loader.js`.
 * The no-category fallback `DEFAULT_COMPOSE_FILTERS` keeps the
 * historical T1 list for cosmetic back-compat.
 *
 * Frozen at module load (outer object and each entry's `content_types`
 * array) so a downstream caller can't mutate the default map.
 *
 * @type {Readonly<Object<string, import('./contracts.js').MetadataFilter>>}
 */
export const DEFAULT_COMPOSE_FILTERS_BY_CATEGORY = Object.freeze({
    [QUERY_CATEGORIES.FUNCTION_DISCOVERY]: Object.freeze({
        content_types: Object.freeze(['code']),
    }),
    [QUERY_CATEGORIES.FILE_DISCOVERY]: Object.freeze({
        content_types: Object.freeze(['code']),
    }),
    [QUERY_CATEGORIES.TASK_RELATED]: Object.freeze({
        content_types: Object.freeze(['code']),
    }),
    [QUERY_CATEGORIES.BUG_INVESTIGATION]: Object.freeze({
        content_types: Object.freeze(['code']),
    }),
    [QUERY_CATEGORIES.ONBOARDING]: Object.freeze({
        content_types: Object.freeze(['code']),
    }),
    [QUERY_CATEGORIES.TOPIC]: Object.freeze({
        content_types: Object.freeze(['code']),
    }),
});

/**
 * Default `composeFilters` resolver — consulted per-call when a caller
 * doesn't pass `composeFilters` explicitly. Looks up the per-category
 * map above and falls back to the no-category T1 default. Pure function;
 * tested in isolation.
 *
 * @param {{ category?: string|null }|null|undefined} opts
 * @returns {import('./contracts.js').MetadataFilter}
 */
export function defaultComposeFiltersResolver(opts) {
    const cat = opts && typeof opts.category === 'string' ? opts.category : null;
    if (cat !== null && Object.prototype.hasOwnProperty.call(DEFAULT_COMPOSE_FILTERS_BY_CATEGORY, cat)) {
        return DEFAULT_COMPOSE_FILTERS_BY_CATEGORY[cat];
    }
    return DEFAULT_COMPOSE_FILTERS;
}

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
 * @property {(query: string, opts?: { category?: string|null }) => Promise<Array<{path: string, similarity: number, summary: string}>>} legacy
 * @property {(query: string, opts?: { category?: string|null }) => Promise<RetrievalResult>} compose
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
 * @property {import('./contracts.js').MetadataFilter|null|((opts: { category?: string|null }) => (import('./contracts.js').MetadataFilter|null))|undefined} [composeFilters]
 *   Optional. Threaded to the new pipeline as `RetrievalRequest.filters`
 *   on every `runCompose(query, opts)` invocation. Three accepted shapes:
 *
 *   - **Function** `(opts: { category?: string|null }) => MetadataFilter|null`
 *     (Composer tuning T3). Resolved per-call with the per-fixture
 *     `category` (or `null` for bare-string queries). The default value
 *     is `defaultComposeFiltersResolver`, which consults
 *     `DEFAULT_COMPOSE_FILTERS_BY_CATEGORY` and falls back to
 *     `DEFAULT_COMPOSE_FILTERS` when category is absent.
 *   - **Object** `MetadataFilter`. Used as-is for every call (back-compat
 *     with T1; behaves identically to passing a constant resolver).
 *   - **`null`**. Restores the pre-T1 behavior of `filters: null`.
 *
 *   The function form is the T3 seam — callers wanting per-fixture
 *   experimentation supply a custom resolver without touching the
 *   harness itself. Live `find_relevant_files` (still on legacy
 *   `js/context-manager.js` until 1.5.9) is unaffected.
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
        composeFilters,
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
    if (composeFilters !== undefined && composeFilters !== null) {
        if (typeof composeFilters === 'function') {
            // Function form (T3): resolved per-call. Cannot validate the
            // resolver's return shape here; defer to runCompose's per-call
            // type guard.
        } else if (typeof composeFilters === 'object') {
            const ct = /** @type {any} */ (composeFilters).content_types;
            if (ct !== undefined && !Array.isArray(ct)) {
                throw new TypeError(
                    'createMeasurementHarness: composeFilters.content_types must be an array when provided',
                );
            }
        } else {
            throw new TypeError(
                'createMeasurementHarness: composeFilters must be a MetadataFilter object, a (opts) => MetadataFilter|null function, null, or undefined',
            );
        }
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
        composeFilters,
    } = options;

    const finalTopK = topK ?? DEFAULT_TOP_K;
    const finalCollection = collection ?? DEFAULT_COLLECTION;
    /**
     * Per-call resolver for `req.filters`. Three caller-supplied shapes
     * collapse to a single function here so `runCompose` doesn't branch:
     *
     *   - `undefined` → `defaultComposeFiltersResolver` (T3 per-category map)
     *   - `null`      → constant `() => null` (pre-T1 behavior)
     *   - `function`  → used as-is (T3 caller-supplied resolver)
     *   - `object`    → wrapped in `() => obj` (T1 back-compat: same filter every call)
     *
     * @type {(opts: { category?: string|null }) => (import('./contracts.js').MetadataFilter|null)}
     */
    let resolveComposeFilters;
    if (composeFilters === undefined) {
        resolveComposeFilters = defaultComposeFiltersResolver;
    } else if (composeFilters === null) {
        resolveComposeFilters = () => null;
    } else if (typeof composeFilters === 'function') {
        resolveComposeFilters = composeFilters;
    } else {
        const constant = composeFilters;
        resolveComposeFilters = () => constant;
    }
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
     * @param {{ category?: string|null }} [opts] Per-call options. The
     *   comparison harness threads each fixture's `category` through here
     *   so the T3 resolver can pick a per-category content-type filter.
     *   Single-arg invocation is supported (the resolver sees `category:
     *   null`) for ad-hoc callers via `harness.runner.compose(query)`.
     * @returns {Promise<RetrievalResult>}
     */
    async function runCompose(query, opts) {
        const filters = resolveComposeFilters(opts || {});
        /** @type {RetrievalRequest} */
        const req = {
            task: '',
            query,
            collections: [finalCollection],
            budget: finalBudget,
            history: null,
            filters,
            strategy_hints: null,
            priority_pins: null,
            task_ledger: null,
        };
        return compose(req, { strategies, getChunkByID: store.getChunkByID });
    }

    /**
     * @param {string} query
     * @param {{ category?: string|null }} [_opts] Accepted for symmetry
     *   with the new `runNew(query, opts)` runner contract; the legacy
     *   `findRelevantFiles` API has no per-fixture seam, so opts is
     *   ignored.
     * @returns {Promise<Array<{path: string, similarity: number, summary: string}>>}
     */
    async function runLegacy(query, _opts) {
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
            const queries = opts && opts.queries !== undefined ? opts.queries : DEFAULT_BATCH_FIXTURES;
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
