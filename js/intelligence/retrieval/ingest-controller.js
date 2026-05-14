// @ts-check
/**
 * Incremental ingest controller — the orchestration piece that sequences
 * the four shipped ingest-pipeline nodes (Loader 1.4.21, Chunker pipeline
 * 1.4.19, Embedder 1.4.22, Chunk Store 1.4.20) per the design's update
 * protocol at `docs/DESIGN-retrieval.md` lines 313-328:
 *
 *   ```
 *   ingest(source_uri):
 *     current_hash = hash(load(source_uri))
 *     stored_hash  = store.get_source_hash(source_uri)
 *     if current_hash == stored_hash:
 *       return NoOp
 *
 *     new_chunks    = chunk(load(source_uri))
 *     old_chunk_ids = store.chunk_ids_for_source(source_uri)
 *     new_chunk_ids = {c.id for c in new_chunks}
 *
 *     to_remove = old_chunk_ids - new_chunk_ids
 *     to_add    = [c for c in new_chunks if c.id not in old_chunk_ids]
 *
 *     embed(to_add)
 *     store.upsert(to_add)
 *     store.mark_stale(to_remove)
 *   ```
 *
 * The design closes with: *"That is the whole update protocol. No Merkle
 * trees, no diff algorithms. Content hash at the source level, ChunkID
 * equality at the chunk level."* This module honors that spirit — no
 * extra cleverness, just the protocol.
 *
 * **What ships here vs. 1.5.0:** This PR is a *single-source* orchestrator.
 * The walker / file-system iteration / Git wiring lives in 1.5.0's
 * parallel-execution harness — that's where concurrency, rate-limiting,
 * resumability, and the 80%-agreement benchmark gate that promotes the
 * track to 1.5.0 land. Keeping the controller single-source matches the
 * established Phase-1 PR cadence (one focused module per PR, removability
 * holds for each).
 *
 * **Phase-1 scope decisions** (called out so future readers don't have to
 * reverse-engineer them from behavior):
 *
 *   1. **Single-source orchestrator only.** No `ingestSources(uris)` batch
 *      helper, no concurrency knob. The walker / parallel-execution
 *      harness is 1.5.0; this module owns the *protocol*, not the
 *      iteration. A caller that wants to ingest N sources today writes
 *      `for (const uri of uris) await controller.ingest(uri)`; 1.5.0
 *      replaces that loop with the production harness.
 *
 *   2. **`setSourceHash` is the last write.** Crash-safety: a partial
 *      pass leaves the *old* hash and the next call retries from scratch
 *      (the same short-circuit the design's pseudocode opens with). If
 *      `setSourceHash` is called early and `upsert` later throws, the
 *      next call would short-circuit on a hash whose chunks never landed.
 *
 *   3. **`status: "ingested"` even when all chunks fail to embed.**
 *      Per-chunk embedder failures are a degradation, not an error
 *      (`embedding: null` per the embedder's Phase-1 contract). The Store
 *      accepts null-embedding chunks and `chunkVectorSearch` filters them
 *      at query time. `embed_failures` in the result tells the caller
 *      without hiding the upsert.
 *
 *   4. **`status: "failed"` only for thrown exceptions.** Loader throws
 *      (e.g. unknown extension via `detectContentType`) and chunker-pipeline
 *      throws (e.g. invalid `content_type`) both surface as `failed` with
 *      the error attached. The store is left untouched and the source
 *      hash is not advanced.
 *
 *   5. **Empty load (`bytes.length === 0`).** `runChunkerPipeline`
 *      short-circuits to `[]`. Controller still records the source hash
 *      so a later edit triggers re-ingest. `markStale` cleans up any
 *      prior chunks (so the empty-bytes case is the documented mechanism
 *      for "the file became empty — drop everything"). `status: "ingested"`,
 *      `added: 0`, `removed: N` if there were prior chunks.
 *
 *   6. **`runChunkerPipeline` is injectable.** Tests substitute deterministic
 *      chunkers without faking through the dispatch table — same DI posture
 *      the strategies and Composer took.
 *
 *   7. **No re-embed of unchanged chunks.** The pseudocode's `to_add`
 *      filter is `[c for c in new_chunks if c.id not in old_chunk_ids]`;
 *      ChunkID equality means byte-identical content, so chunks already
 *      in the store keep their existing embedding (and aren't passed
 *      through `embedFn` again). A side-effect: a chunk that previously
 *      failed to embed (`embedding: null`) and is re-emitted unchanged
 *      stays null on this pass. A future "back-fill nulls" sweep is a
 *      separate concern (1.5.x) — not the controller's job.
 *
 * **Out of scope for 1.4.23 (subsequently shipped except where noted):**
 *   - File-system / Git-tree walking — ✓ 1.5.0 walker harness.
 *   - Production wire-up to `Git.getFile(...)` / `EmbeddingsClient.embed(...)`
 *     — ✓ 1.5.1 `wiring.js`.
 *   - Concurrency / retry / backoff — ✓ 1.5.0 walker harness.
 *   - Persistent state between process runs (1.5.x, gated on a persistent
 *     chunk store).
 *   - Migration of `find_relevant_files` off `js/context-manager.js`
 *     — ✓ 1.5.14 cutover (slipped from the originally-planned 1.5.2 slot).
 *   - Back-fill sweep for chunks with `embedding: null` (1.5.x).
 *
 * **Production wiring (since 1.5.14):** `createProductionIngestWalker`
 * (`./wiring.js`) constructs a controller with production loader /
 * embedder / store wired in; `manager.js` drives it. Removability is
 * inverted — deleting this module breaks chunk ingest.
 *
 * @module intelligence/retrieval/ingest-controller
 */

import { runChunkerPipeline as defaultRunChunkerPipeline } from './pipeline.js';

/**
 * @typedef {import('./contracts.js').Chunk}             Chunk
 * @typedef {import('./contracts.js').ChunkID}           ChunkID
 * @typedef {import('./contracts.js').ChunkRef}          ChunkRef
 * @typedef {import('./contracts.js').ChunkerInput}      ChunkerInput
 * @typedef {import('./contracts.js').CollectionName}    CollectionName
 * @typedef {import('./contracts.js').IngestResult}      IngestResult
 * @typedef {import('./contracts.js').LoadedSource}      LoadedSource
 * @typedef {import('./contracts.js').ContentType}       ContentType
 */

/**
 * @typedef {import('./loader.js').Loader} Loader
 * @typedef {import('./embedder.js').Embedder} Embedder
 */

/**
 * Subset of the chunk store the controller calls. Sourced from
 * `store.js`'s `ChunkStore` typedef but restated here so the controller
 * documents exactly which methods it depends on (the store's read-side
 * `getChunkByID` / `chunkVectorSearch` are not the controller's concern).
 *
 * @typedef {Object} IngestStore
 * @property {(sourceUri: string) => string|null}            getSourceHash
 * @property {(sourceUri: string, hash: string) => void}     setSourceHash
 * @property {(sourceUri: string) => ChunkID[]}              chunkIdsForSource
 * @property {(chunks: ChunkRef[]) => void}                  upsert
 * @property {(ids: Iterable<ChunkID>) => number}            markStale
 */

/**
 * Public IngestController handle. Returned by `createIngestController`.
 *
 * @typedef {Object} IngestController
 * @property {(sourceUri: string) => Promise<IngestResult>} ingest
 * @property {() => IngestControllerStats} stats
 */

/**
 * Snapshot of accumulated ingest stats. Mutating the returned object does
 * not affect future reads — `stats()` clones on each call.
 *
 * @typedef {Object} IngestControllerStats
 * @property {number} calls          Total `ingest()` calls completed.
 * @property {number} ingested       Calls that returned `status: "ingested"`.
 * @property {number} noop           Calls that returned `status: "noop"`.
 * @property {number} failed         Calls that returned `status: "failed"`.
 * @property {number} chunksAdded    Sum of `added` across all calls.
 * @property {number} chunksRemoved  Sum of `removed` across all calls.
 * @property {number} embedFailures  Sum of `embed_failures` across all calls.
 */

/**
 * Options to `createIngestController`.
 *
 * @typedef {Object} IngestControllerOptions
 * @property {Loader}                                                  loader              Required. From `createLoader(...)`.
 * @property {Embedder}                                                embedder            Required. From `createEmbedder(...)`.
 * @property {IngestStore}                                             store               Required. From `createInMemoryChunkStore()` (or a future persistent store).
 * @property {((input: ChunkerInput) => Chunk[])|undefined}            [runChunkerPipeline] Optional. Defaults to the imported pipeline; injectable for tests / mocks.
 * @property {CollectionName|undefined}                                [collection]         Optional. Defaults to `"default"`; threaded into `ChunkerInput.collection`.
 */

/**
 * Map a `LoadedSource` into a `ChunkerInput`. The controller owns this
 * adapter so the four ingest-pipeline nodes don't need to know about each
 * others' shapes — Loader returns `LoadedSource`, the chunker pipeline
 * accepts `ChunkerInput`. Pure / synchronous; small enough to inline but
 * explicit because the field mapping is the only place the two contracts
 * meet.
 *
 * `created_at` and `updated_at` are stamped at controller-call time. The
 * Loader doesn't have file-system metadata in Phase 1 (the design defers
 * that to the walker); the chunker only uses these for `Metadata` field
 * presence, not for any decision. A future persistent store may want
 * real mtimes — the seam is here.
 *
 * @param {LoadedSource} loaded
 * @param {CollectionName} collection
 * @returns {ChunkerInput}
 */
function loadedSourceToChunkerInput(loaded, collection) {
    const now = Date.now();
    return {
        bytes: loaded.bytes,
        collection,
        metadata: {
            source_uri: loaded.source_uri,
            content_type: loaded.content_type_hint,
            created_at: now,
            updated_at: now,
            custom: undefined,
        },
    };
}

/**
 * Construct an IngestController. The returned handle exposes a single
 * async `ingest(sourceUri)` method that runs the design's update protocol
 * end-to-end against the injected nodes, plus a `stats()` snapshot for
 * diagnostics.
 *
 * Production wiring (1.5.0 harness):
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
 *   for (const uri of walker.walk()) await controller.ingest(uri);
 *   ```
 *
 * @param {IngestControllerOptions} options
 * @returns {IngestController}
 */
export function createIngestController(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createIngestController: options must be an object');
    }
    const { loader, embedder, store, runChunkerPipeline, collection } = options;
    if (!loader || typeof loader.load !== 'function') {
        throw new TypeError('createIngestController: loader must expose load()');
    }
    if (!embedder || typeof embedder.embed !== 'function') {
        throw new TypeError('createIngestController: embedder must expose embed()');
    }
    if (
        !store ||
        typeof store.getSourceHash !== 'function' ||
        typeof store.setSourceHash !== 'function' ||
        typeof store.chunkIdsForSource !== 'function' ||
        typeof store.upsert !== 'function' ||
        typeof store.markStale !== 'function'
    ) {
        throw new TypeError(
            'createIngestController: store must expose { getSourceHash, setSourceHash, chunkIdsForSource, upsert, markStale }',
        );
    }
    if (runChunkerPipeline !== undefined && typeof runChunkerPipeline !== 'function') {
        throw new TypeError(
            'createIngestController: runChunkerPipeline must be a function when provided',
        );
    }
    if (collection !== undefined && (typeof collection !== 'string' || collection.length === 0)) {
        throw new TypeError(
            'createIngestController: collection must be a non-empty string when provided',
        );
    }

    const chunk = runChunkerPipeline ?? defaultRunChunkerPipeline;
    const coll = collection ?? 'default';

    let calls = 0;
    let ingested = 0;
    let noop = 0;
    let failed = 0;
    let chunksAdded = 0;
    let chunksRemoved = 0;
    let embedFailures = 0;

    /**
     * @param {string} sourceUri
     * @returns {Promise<IngestResult>}
     */
    async function ingest(sourceUri) {
        if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
            throw new TypeError('IngestController.ingest: sourceUri must be a non-empty string');
        }
        calls += 1;

        // Step 1: load. Loader throws on unknown extension / fetchBytes failure.
        /** @type {LoadedSource} */
        let loaded;
        try {
            loaded = await loader.load(sourceUri);
        } catch (err) {
            failed += 1;
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

        const current = loaded.content_hash;

        // Step 2: hash short-circuit. Pseudocode lines 314-317.
        const stored = store.getSourceHash(sourceUri);
        if (stored !== null && stored === current) {
            noop += 1;
            return {
                source_uri: sourceUri,
                status: 'noop',
                content_hash: current,
                added: 0,
                removed: 0,
                embedded: 0,
                embed_failures: 0,
                error: null,
            };
        }

        // Step 3: chunk. Pseudocode line 319.
        /** @type {Chunk[]} */
        let newChunks;
        try {
            newChunks = chunk(loadedSourceToChunkerInput(loaded, coll));
        } catch (err) {
            failed += 1;
            return {
                source_uri: sourceUri,
                status: 'failed',
                content_hash: current,
                added: 0,
                removed: 0,
                embedded: 0,
                embed_failures: 0,
                error: err instanceof Error ? err : new Error(String(err)),
            };
        }

        // Step 4: diff old vs new. Pseudocode lines 320-324.
        const oldIds = new Set(store.chunkIdsForSource(sourceUri));
        const newIds = new Set(newChunks.map((c) => c.id));
        const toRemove = [];
        for (const id of oldIds) {
            if (!newIds.has(id)) toRemove.push(id);
        }
        const toAdd = newChunks.filter((c) => !oldIds.has(c.id));

        // Step 5: embed only the new chunks. Pseudocode line 326.
        // Failures degrade per the embedder's Phase-1 contract — `embedding: null`
        // surfaces in `embed_failures` but the upsert still happens.
        const embedded = await embedder.embed(toAdd);

        // Step 6: upsert + markStale. Pseudocode lines 327-328.
        store.upsert(embedded);
        const removedCount = store.markStale(toRemove);

        // Step 7: setSourceHash LAST. Crash-safety per scope decision §2 —
        // any prior throw leaves the old hash and the next call retries.
        store.setSourceHash(sourceUri, current);

        let embeddedCount = 0;
        for (const c of embedded) {
            if (c.embedding != null) embeddedCount += 1;
        }
        const embedFailuresCount = embedded.length - embeddedCount;

        ingested += 1;
        chunksAdded += toAdd.length;
        chunksRemoved += removedCount;
        embedFailures += embedFailuresCount;

        return {
            source_uri: sourceUri,
            status: 'ingested',
            content_hash: current,
            added: toAdd.length,
            removed: removedCount,
            embedded: embeddedCount,
            embed_failures: embedFailuresCount,
            error: null,
        };
    }

    return {
        ingest,
        stats() {
            return {
                calls,
                ingested,
                noop,
                failed,
                chunksAdded,
                chunksRemoved,
                embedFailures,
            };
        },
    };
}
