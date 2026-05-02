// @ts-check
/**
 * Parallel-execution ingest walker — the Phase-1 harness layered over the
 * single-source `createIngestController` shipped at 1.4.23. Runs
 * `controller.ingest(sourceUri)` across N source URIs with bounded
 * concurrency, per-source error isolation, optional progress reporting,
 * and abort support.
 *
 * **Why this module exists.** The 1.4.23 controller owns the *protocol* —
 * Loader → Chunker pipeline → Embedder → Store per `docs/DESIGN-retrieval.md`
 * lines 313-328 — but it is single-source by design (one `sourceUri` per
 * call). The walker owns the *iteration*: bounded parallelism, result
 * aggregation, abort semantics, progress notification. This is the first
 * PR opening the 1.5.0 minor; subsequent 1.5.0-betaN PRs add (a) production
 * wiring to `Git.getFile()` / `EmbeddingsClient.embed()`, (b) the
 * comparison harness that runs queries through both legacy
 * `js/context-manager.js` and the new Composer, (c) a test-query fixture
 * corpus, and (d) the actual ≥80% legacy-vs-new agreement measurement that
 * promotes the track. Each is a focused module, matching the established
 * Phase-1 PR cadence (one DI-friendly factory per PR, removability holds
 * for each).
 *
 * **Public surface:** `createIngestWalker({ controller, concurrency?,
 * onProgress?, now? }) => IngestWalker`. The handle exposes `walk(sourceUris,
 * opts?)` and `stats()` — same shape pattern the controller uses for
 * `ingest(...)` and `stats()`.
 *
 * **Phase-1 scope decisions** (called out so future readers don't have to
 * reverse-engineer them from behavior):
 *
 *   1. **Worker-pool over a shared async iterator.** No queue library, no
 *      external dependency. `concurrency` workers each loop
 *      `iter.next()` → `controller.ingest(uri)` → push result → onProgress.
 *      `Promise.all(workers)` settles when the iterator drains or the
 *      signal aborts. Pure vanilla JS, node-test-safe.
 *
 *   2. **Default `concurrency = 4`.** Reasonable under typical cloud
 *      embedder rate-limit envelopes with headroom; the controller is the
 *      per-source bottleneck so 4 stays conservative. Callers tune up for
 *      local embedders (1.1.2 Transformers.js path) or down for paid APIs
 *      hitting tight rate windows.
 *
 *   3. **`concurrency: 1` is a legal special case.** The worker pool
 *      degenerates to a sequential awaiter; observably equivalent to a
 *      caller's `for (const uri of uris) await controller.ingest(uri)`
 *      loop. Tested explicitly because debugging callers expect
 *      input-order results.
 *
 *   4. **Per-source error isolation.** The controller is documented to
 *      never throw (it returns a `failed` `IngestResult` on Loader /
 *      chunker exceptions). If the controller *does* throw anyway —
 *      defensive against a future controller change, a malformed injected
 *      store, etc. — the walker catches and synthesizes a `failed`
 *      `IngestResult` of the documented shape. This preserves both the
 *      `WalkResult.results.length === total` invariant *and* the "one bad
 *      source never poisons the batch" guarantee.
 *
 *   5. **Abort: in-flight calls finish, no new dispatch.** When
 *      `opts.signal.aborted` flips, each worker re-checks the flag at the
 *      top of its loop and returns. In-flight `controller.ingest` calls
 *      are not cancelled (the controller has no abort surface in
 *      Phase 1). The walker returns a partial `WalkResult` with
 *      `aborted: true` and whatever results landed. A pre-aborted signal
 *      at `walk()` entry returns immediately with `total: 0`.
 *
 *   6. **`onProgress` errors are swallowed.** A diagnostic callback should
 *      not be able to abort an ingest walk. If it throws, the walker
 *      catches and continues. Same posture as the controller's stats
 *      reporting — diagnostics never gate behavior.
 *
 *   7. **`AsyncIterable` input streams.** `string[]`, sync iterables (Set,
 *      generators), and `AsyncIterable<string>` all walk fine. For
 *      `string[]` the walker reads `.length` once up front and passes the
 *      real total to `onProgress`; for streamed inputs `total` is `-1`
 *      (UI callers handle that case). Per-element validation runs at
 *      dispatch time, not up front, so streaming callers don't lose
 *      laziness.
 *
 *   8. **Injectable `now()` for deterministic `durationMs`.** `Date.now()`
 *      resolution can produce `0` in fast tests; tests inject a clock.
 *      Same DI posture every other retrieval module took.
 *
 * **Out of scope for this PR (later 1.5.0-betaN / 1.5.x PRs):**
 *
 *   - Production wire-up to `Git.getFile()` / `EmbeddingsClient.embed()`
 *     and `EmbeddingsClient.init()` integration.
 *   - Workspace tree walking (filtered by `IgnoreManager`, etc.) — the
 *     walker accepts an iterable; producing that iterable is a separate
 *     concern.
 *   - Comparison harness running queries through both legacy
 *     `context-manager.js` and the new Composer.
 *   - Test-query fixture corpus.
 *   - Actual ≥80% legacy-vs-new agreement measurement.
 *   - Migration of `find_relevant_files` (1.5.2).
 *   - Persistent chunk store / IDB backing (1.5.x).
 *   - Cancellation propagation into in-flight `controller.ingest` calls
 *     (would require an abort surface on the controller / loader / embedder
 *     chain; not Phase 1).
 *   - Retry / backoff on transient failures (controller's surface returns
 *     `failed` results; retry policy lives at the call site).
 *
 * **No runtime wire-up.** Nothing imports `createIngestWalker` outside the
 * test suite. `find_relevant_files` keeps running through legacy
 * [`js/context-manager.js`](../../context-manager.js). With this module
 * deleted, the barrel re-export removed, and the `WalkResult` typedef
 * removed, no production behavior degrades — Removability holds
 * (Decision §7).
 *
 * @module intelligence/retrieval/walker
 */

/**
 * @typedef {import('./contracts.js').IngestResult} IngestResult
 * @typedef {import('./contracts.js').WalkResult}   WalkResult
 * @typedef {import('./ingest-controller.js').IngestController} IngestController
 */

/**
 * Snapshot of accumulated walker stats. Mutating the returned object does
 * not affect future reads — `stats()` clones on each call. Lifetime totals
 * across every `walk()` invocation made on this walker handle.
 *
 * @typedef {Object} IngestWalkerStats
 * @property {number} walks          Total `walk()` calls completed.
 * @property {number} sources        Total sources dispatched (Σ `WalkResult.total`).
 * @property {number} ingested       Σ `WalkResult.ingested`.
 * @property {number} noop           Σ `WalkResult.noop`.
 * @property {number} failed         Σ `WalkResult.failed`.
 * @property {number} chunksAdded    Σ `WalkResult.chunksAdded`.
 * @property {number} chunksRemoved  Σ `WalkResult.chunksRemoved`.
 * @property {number} embedFailures  Σ `WalkResult.embedFailures`.
 * @property {number} aborts         Walks that returned `aborted: true`.
 */

/**
 * Public IngestWalker handle. Returned by `createIngestWalker`.
 *
 * @typedef {Object} IngestWalker
 * @property {(sourceUris: Iterable<string>|AsyncIterable<string>, opts?: IngestWalkOptions) => Promise<WalkResult>} walk
 * @property {() => IngestWalkerStats} stats
 */

/**
 * Options to `IngestWalker.walk()`.
 *
 * @typedef {Object} IngestWalkOptions
 * @property {AbortSignal|undefined} [signal]  Optional. When aborted, no new sources are dispatched; in-flight calls finish.
 */

/**
 * Options to `createIngestWalker`.
 *
 * @typedef {Object} IngestWalkerOptions
 * @property {IngestController}                                               controller    Required. From `createIngestController(...)`.
 * @property {number|undefined}                                               [concurrency] Optional. Positive integer; default 4. Peak in-flight `controller.ingest` calls.
 * @property {((done: number, total: number, latestResult: IngestResult) => void)|undefined} [onProgress]  Optional. Invoked once per completed source. `total` is `-1` for `AsyncIterable` input.
 * @property {(() => number)|undefined}                                       [now]         Optional. Injectable clock; defaults to `Date.now`. Tests pass a deterministic stub.
 */

const DEFAULT_CONCURRENCY = 4;

/**
 * Synthesize a `failed` `IngestResult` when the controller throws an
 * unexpected exception (defensive — the controller's documented contract
 * is to return `failed` rather than throw). Preserves the
 * `WalkResult.results.length === total` and per-source-isolation
 * invariants the walker tests pin.
 *
 * @param {string} sourceUri
 * @param {unknown} err
 * @returns {IngestResult}
 */
function synthesizeFailedResult(sourceUri, err) {
    return {
        source_uri: sourceUri,
        status: 'failed',
        content_hash: null,
        added: 0,
        removed: 0,
        embedded: 0,
        embed_failures: 0,
        error: err instanceof Error ? err : new Error(String(err)),
    };
}

/**
 * Adapt a sync `Iterable<T>` to an `AsyncIterator<T>`. The walker's worker
 * loop is uniform across input shapes if everything is async; this thin
 * wrapper avoids forking the worker code path for arrays vs streams.
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
 * @param {unknown} n
 * @returns {boolean}
 */
function isPositiveInteger(n) {
    return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/**
 * Construct an IngestWalker. The returned handle exposes `walk(sourceUris,
 * opts?)` (the orchestration entrypoint) and `stats()` (a lifetime
 * snapshot across every walk).
 *
 * Production wiring (later 1.5.0-betaN PR — out of scope here):
 *
 *   ```js
 *   await EmbeddingsClient.init();
 *   const controller = createIngestController({
 *     loader: createLoader({ fetchBytes: (uri) => Git.getFile(uri) }),
 *     embedder: createEmbedder({
 *       embedFn: (t) => EmbeddingsClient.embed(t),
 *       modelId: State.settings.embeddingModel,
 *     }),
 *     store: createInMemoryChunkStore(),
 *   });
 *   const walker = createIngestWalker({ controller, concurrency: 4 });
 *   const result = await walker.walk(workspaceUris, { signal });
 *   ```
 *
 * @param {IngestWalkerOptions} options
 * @returns {IngestWalker}
 */
export function createIngestWalker(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createIngestWalker: options must be an object');
    }
    const { controller, concurrency, onProgress, now } = options;
    if (!controller || typeof controller.ingest !== 'function') {
        throw new TypeError('createIngestWalker: controller must expose ingest()');
    }
    if (concurrency !== undefined && !isPositiveInteger(concurrency)) {
        throw new TypeError(
            'createIngestWalker: concurrency must be a positive integer when provided',
        );
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') {
        throw new TypeError(
            'createIngestWalker: onProgress must be a function when provided',
        );
    }
    if (now !== undefined && typeof now !== 'function') {
        throw new TypeError('createIngestWalker: now must be a function when provided');
    }

    const conc = concurrency ?? DEFAULT_CONCURRENCY;
    const clock = now ?? Date.now;

    let walks = 0;
    let sources = 0;
    let ingested = 0;
    let noop = 0;
    let failed = 0;
    let chunksAdded = 0;
    let chunksRemoved = 0;
    let embedFailures = 0;
    let aborts = 0;

    /**
     * @param {Iterable<string>|AsyncIterable<string>} sourceUris
     * @param {IngestWalkOptions} [opts]
     * @returns {Promise<WalkResult>}
     */
    async function walk(sourceUris, opts) {
        const signal = opts?.signal;
        const startedAt = clock();

        // Resolve total up front for arrays (so onProgress can pass real
        // totals); streamed inputs report -1 because we can't know the
        // length without consuming the stream.
        /** @type {number} */
        let knownTotal;
        /** @type {AsyncIterator<string>} */
        let iter;

        if (Array.isArray(sourceUris)) {
            knownTotal = sourceUris.length;
            iter = syncToAsyncIterator(sourceUris);
        } else if (isAsyncIterable(sourceUris)) {
            knownTotal = -1;
            iter = /** @type {AsyncIterable<string>} */ (sourceUris)[Symbol.asyncIterator]();
        } else if (isSyncIterable(sourceUris)) {
            knownTotal = -1;
            iter = syncToAsyncIterator(/** @type {Iterable<string>} */ (sourceUris));
        } else {
            throw new TypeError(
                'IngestWalker.walk: sourceUris must be an Iterable or AsyncIterable of strings',
            );
        }

        /** @type {IngestResult[]} */
        const results = [];
        let dispatched = 0;
        let abortedFlag = false;

        const finalize = () => {
            const total = results.length;
            let agg_ingested = 0;
            let agg_noop = 0;
            let agg_failed = 0;
            let agg_added = 0;
            let agg_removed = 0;
            let agg_embedFailures = 0;
            for (const r of results) {
                if (r.status === 'ingested') agg_ingested += 1;
                else if (r.status === 'noop') agg_noop += 1;
                else if (r.status === 'failed') agg_failed += 1;
                agg_added += r.added;
                agg_removed += r.removed;
                agg_embedFailures += r.embed_failures;
            }
            const endedAt = clock();
            const durationMs = Math.max(0, endedAt - startedAt);

            walks += 1;
            sources += total;
            ingested += agg_ingested;
            noop += agg_noop;
            failed += agg_failed;
            chunksAdded += agg_added;
            chunksRemoved += agg_removed;
            embedFailures += agg_embedFailures;
            if (abortedFlag) aborts += 1;

            return {
                total,
                ingested: agg_ingested,
                noop: agg_noop,
                failed: agg_failed,
                chunksAdded: agg_added,
                chunksRemoved: agg_removed,
                embedFailures: agg_embedFailures,
                results,
                aborted: abortedFlag,
                durationMs,
            };
        };

        if (signal?.aborted) {
            abortedFlag = true;
            return finalize();
        }

        async function worker() {
            while (true) {
                if (signal?.aborted) {
                    abortedFlag = true;
                    return;
                }
                const next = await iter.next();
                if (next.done) return;
                const uri = next.value;
                if (typeof uri !== 'string' || uri.length === 0) {
                    throw new TypeError(
                        `IngestWalker.walk: source URIs must be non-empty strings (got ${typeof uri === 'string' ? 'empty string' : typeof uri})`,
                    );
                }
                /** @type {IngestResult} */
                let result;
                try {
                    result = await controller.ingest(uri);
                } catch (err) {
                    result = synthesizeFailedResult(uri, err);
                }
                results.push(result);
                dispatched += 1;
                if (onProgress) {
                    try {
                        onProgress(dispatched, knownTotal, result);
                    } catch {
                        // Diagnostic callbacks must not abort the walk.
                    }
                }
            }
        }

        const workers = [];
        for (let i = 0; i < conc; i += 1) workers.push(worker());
        await Promise.all(workers);
        return finalize();
    }

    return {
        walk,
        stats() {
            return {
                walks,
                sources,
                ingested,
                noop,
                failed,
                chunksAdded,
                chunksRemoved,
                embedFailures,
                aborts,
            };
        },
    };
}
