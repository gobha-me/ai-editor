// @ts-check
/**
 * Embedder integration — the back-fill seam between the chunker pipeline
 * (1.4.19) and the chunk store (1.4.20). Fourth and final ingest-pipeline
 * node before the controller arriving at 1.4.23.
 *
 * Per [`docs/DESIGN-retrieval.md`](../../../../docs/DESIGN-retrieval.md)
 * §"Embedder" lines 304-308:
 *
 *   > Resolves an embedding provider via a fallback chain (local /
 *   > self-hosted / cloud) **at library initialization**, not per-call.
 *   > Swapping providers requires reinitializing. … Embeddings are cached
 *   > by `(content_hash, embedder_model_id)`. A provider swap invalidates
 *   > cache; a content edit invalidates cache for that chunk only.
 *
 * Sits between `runChunkerPipeline` (1.4.19) and `ChunkStore.upsert`
 * (1.4.20). The design's incremental-ingest pseudocode at lines 313-328
 * names this seam `embed(to_add)` — a one-line call between `chunk(...)`
 * and `store.upsert(...)`. This module fills that line as a small, pure
 * factory rather than letting the controller (1.4.23) inline it.
 *
 * **Why a focused PR rather than inlining in the controller:**
 *
 *   1. The design names *two* commitments — provider init at library load
 *      AND a `(content_hash, model_id)` cache. The cache is a contract,
 *      not an optimization the controller can skip.
 *
 *   2. [`js/embeddings-client.js`](../../embeddings-client.js) is
 *      browser-bound (imports `State` / `EventBus` / `Storage` from
 *      `core.js`; touches `localStorage`, `caches`, `document.baseURI`).
 *      Every prior retrieval module that wanted to consume it
 *      ([`strategies/semantic.js`](./strategies/semantic.js) at 1.4.15,
 *      [`store.js`](./store.js) at 1.4.20) had to inject a callable seam
 *      to stay node-test-safe. The Embedder integration is the right home
 *      for that wrapper — without it the controller will reinvent it.
 *
 *   3. Sticking to the precedent (one focused module per Phase-1 PR)
 *      keeps reviews tractable and Removability holds.
 *
 * **Phase-1 scope decisions** (called out so future readers don't have to
 * reverse-engineer them from behavior):
 *
 *   1. **Cache key is `${modelId}::${chunk.metadata.content_hash}`.** Both
 *      pieces are pinned: `modelId` participates so a provider/model swap
 *      invalidates cleanly (the design's "swapping providers requires
 *      reinitializing"); `content_hash` participates so a content edit
 *      invalidates cache for that chunk only. The cache lives module-
 *      private as a `Map<string, EmbeddingVector>` unless the caller
 *      injects one — same layering as the Loader's stateless-by-default
 *      pattern.
 *
 *   2. **Failures degrade, don't throw.** `embedFn` returning `null` (or
 *      throwing) leaves `chunk.embedding = null` in the output. The
 *      Store's `chunkVectorSearch` already filters such chunks out
 *      ([`tests/test-retrieval-store.mjs`](../../../tests/test-retrieval-store.mjs)
 *      "chunkVectorSearch skips chunks whose embedding is null"). A
 *      single-chunk failure does not poison the batch.
 *
 *   3. **Sequential `await` over the batch in Phase 1.** The Embedder
 *      iterates `chunks` and awaits `embedFn` per chunk. Concurrency /
 *      batching belongs to the controller (1.4.23) which knows the
 *      rate-limit envelope of the production wire-up. Same restraint the
 *      Loader took on concurrency.
 *
 *   4. **Idempotent on already-embedded chunks.** A chunk arriving with
 *      `embedding != null` passes through untouched (no cache lookup, no
 *      `embedFn` call). Supports two real flows: testing fixtures with
 *      pre-baked vectors, and the controller running ingest a second time
 *      over a partially-embedded snapshot.
 *
 *   5. **No provider initialization here.** `createEmbedder` does not
 *      call `EmbeddingsClient.init()`. The caller wires
 *      `embedFn = (text) => EmbeddingsClient.embed(text)` *after*
 *      `EmbeddingsClient.init()` has resolved. This keeps the module
 *      DOM-free and matches how 1.4.15 wires its `embedQuery`.
 *
 *   6. **Inputs are `Chunk[] | ChunkRef[]`.** Chunks straight off
 *      `runChunkerPipeline` lack `provenance` + `embedding` — the
 *      Embedder doesn't need either to do its job. Outputs are
 *      `ChunkRef`-shaped: `embedding` populated (or null on failure),
 *      `provenance` echoed if present on input or set to a minimal stub
 *      otherwise. This means callers can chain
 *      `runChunkerPipeline(...) → embedder.embed(...) → store.upsert(...)`
 *      without an intermediate adapter.
 *
 *   7. **No batching API yet.** The signature is `embed(chunks)`, not
 *      `embedBatch(chunks, {concurrency})`. Batching ships when a real
 *      consumer demands it.
 *
 * **Out of scope for 1.4.22:**
 *   - Provider selection / fallback chain (`EmbeddingsClient` already
 *     does that at library init).
 *   - Production wire-up to `EmbeddingsClient.embed` (1.4.23 controller).
 *   - Persistent cache (IDB / localStorage). The in-memory cache turns
 *     over on process restart, same lifetime as the in-memory Store.
 *     Persistence is a 1.5.x concern.
 *   - BM25 index construction (still deferred per
 *     [`loader.js`](./loader.js) lines 60-63).
 *   - Migration of `find_relevant_files` off `js/context-manager.js`
 *     (1.5.2).
 *   - Concurrency / retry / backoff (controller's job).
 *
 * **No runtime wire-up.** Nothing imports `createEmbedder` outside the
 * test suite. With this module deleted, no production behavior degrades —
 * Removability holds (Decision §7).
 *
 * @module intelligence/retrieval/embedder
 */

/**
 * @typedef {import('./contracts.js').Chunk}            Chunk
 * @typedef {import('./contracts.js').ChunkRef}         ChunkRef
 * @typedef {import('./contracts.js').EmbeddingVector}  EmbeddingVector
 * @typedef {import('./contracts.js').Provenance}       Provenance
 */

/**
 * Optional caller-supplied cache. The default in-memory `Map` satisfies
 * this shape; the typedef exists so callers wiring an IDB-backed or
 * shared cache at 1.5.x have a contract to implement against.
 *
 * @typedef {Object} EmbedderCache
 * @property {(key: string) => EmbeddingVector|null} get
 * @property {(key: string, vec: EmbeddingVector) => void} set
 * @property {() => number} size
 */

/**
 * Public Embedder handle. Returned by `createEmbedder`.
 *
 * @typedef {Object} Embedder
 * @property {(chunks: Array<Chunk|ChunkRef>) => Promise<ChunkRef[]>} embed
 * @property {(chunk: Chunk|ChunkRef) => Promise<ChunkRef>}            embedOne
 * @property {() => { hits: number, misses: number, failures: number, cached: number }} stats
 */

/**
 * Options to `createEmbedder`.
 *
 * @typedef {Object} EmbedderOptions
 * @property {(text: string) => Promise<EmbeddingVector|null>} embedFn  Required. Wraps the production embedder, e.g. `(t) => EmbeddingsClient.embed(t)`.
 * @property {string}                                          modelId  Required. Opaque label that participates in the cache key (`${modelId}::${content_hash}`).
 * @property {EmbedderCache|undefined}                        [cache]   Optional caller-provided cache; defaults to a module-private `Map`.
 */

/**
 * Default in-memory cache backing. A bare `Map` would satisfy the
 * `EmbedderCache` shape via duck-typing, but exposing a small adapter
 * keeps the `get` / `set` semantics explicit (Map's `get` returns
 * `undefined` for misses, the contract returns `null`).
 *
 * @returns {EmbedderCache}
 */
function createDefaultCache() {
    /** @type {Map<string, EmbeddingVector>} */
    const m = new Map();
    return {
        get(key) {
            return m.has(key) ? /** @type {EmbeddingVector} */ (m.get(key)) : null;
        },
        set(key, vec) {
            m.set(key, vec);
        },
        size() {
            return m.size;
        },
    };
}

/**
 * Build the cache key for a chunk under a given model. Both pieces are
 * load-bearing — see scope decision §1 in the module doc.
 *
 * @param {string} modelId
 * @param {string} contentHash
 * @returns {string}
 */
function cacheKey(modelId, contentHash) {
    return `${modelId}::${contentHash}`;
}

/**
 * Stub `Provenance` for a chunk that doesn't have one yet (chunks arriving
 * straight from `runChunkerPipeline` carry only `Chunk` fields). The
 * Composer overwrites this when it admits a chunk; the Embedder just
 * needs *some* provenance so the output validates as `ChunkRef`.
 *
 * @param {Chunk|ChunkRef} chunk
 * @returns {Provenance}
 */
function stubProvenance(chunk) {
    const byteRange =
        /** @type {any} */ (chunk).byte_range ??
        (/** @type {any} */ (chunk).provenance && /** @type {any} */ (chunk).provenance.byte_range) ??
        null;
    return {
        source_uri: chunk.metadata.source_uri,
        byte_range: byteRange,
        line_range: null,
        retrieved_by: 'pinned',
        score: 0,
        score_kind: 'cosine',
    };
}

/**
 * Project a `Chunk` or `ChunkRef` onto a `ChunkRef` shape, attaching the
 * supplied embedding (or null on failure). Pure — never mutates the input.
 *
 * @param {Chunk|ChunkRef} input
 * @param {EmbeddingVector|null} embedding
 * @returns {ChunkRef}
 */
function toChunkRef(input, embedding) {
    const provenance =
        /** @type {any} */ (input).provenance ?? stubProvenance(input);
    return {
        id: input.id,
        collection: input.collection,
        content: input.content,
        tokens: input.tokens,
        metadata: input.metadata,
        provenance,
        embedding,
    };
}

/**
 * Construct an Embedder. The returned handle exposes `embed` (batch),
 * `embedOne` (single-chunk convenience), and `stats` (cache /
 * success-rate introspection for diagnostics + tests).
 *
 * `embedFn` is the integration seam. Production callers wire it after
 * `EmbeddingsClient.init()` has resolved:
 *
 *   ```js
 *   await EmbeddingsClient.init();
 *   const embedder = createEmbedder({
 *     embedFn: (t) => EmbeddingsClient.embed(t),
 *     modelId: State.settings.embeddingModel,
 *   });
 *   ```
 *
 * Tests inject a deterministic fake — no DOM, no provider, no network.
 *
 * @param {EmbedderOptions} options
 * @returns {Embedder}
 */
export function createEmbedder(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createEmbedder: options must be an object');
    }
    const { embedFn, modelId, cache } = options;
    if (typeof embedFn !== 'function') {
        throw new TypeError('createEmbedder: embedFn must be a function');
    }
    if (typeof modelId !== 'string' || modelId.length === 0) {
        throw new TypeError('createEmbedder: modelId must be a non-empty string');
    }
    if (cache !== undefined) {
        if (
            !cache ||
            typeof cache !== 'object' ||
            typeof cache.get !== 'function' ||
            typeof cache.set !== 'function' ||
            typeof cache.size !== 'function'
        ) {
            throw new TypeError(
                'createEmbedder: cache must implement { get, set, size } when provided',
            );
        }
    }

    const backing = cache ?? createDefaultCache();
    let hits = 0;
    let misses = 0;
    let failures = 0;

    /**
     * Resolve an embedding for one chunk, consulting cache first and
     * recording the outcome. Returns the vector or `null` on failure.
     *
     * @param {Chunk|ChunkRef} chunk
     * @returns {Promise<EmbeddingVector|null>}
     */
    async function resolveEmbedding(chunk) {
        const contentHash = chunk?.metadata?.content_hash;
        // No content_hash → cache is unusable for this chunk; still attempt
        // the embed call so the controller's hand-off is honored, but treat
        // every call as a miss + don't store under a meaningless key.
        const haveHash = typeof contentHash === 'string' && contentHash.length > 0;
        if (haveHash) {
            const key = cacheKey(modelId, contentHash);
            const cached = backing.get(key);
            if (cached !== null) {
                hits += 1;
                return cached;
            }
        }
        misses += 1;
        let vec;
        try {
            vec = await embedFn(chunk.content);
        } catch (_err) {
            failures += 1;
            return null;
        }
        if (vec == null) {
            failures += 1;
            return null;
        }
        if (!Array.isArray(vec)) {
            // Defensive: an embedFn returning a non-array, non-null value is
            // a contract violation but we degrade rather than throwing —
            // same posture as the null branch above.
            failures += 1;
            return null;
        }
        if (haveHash) {
            backing.set(cacheKey(modelId, contentHash), vec);
        }
        return vec;
    }

    /**
     * @param {Chunk|ChunkRef} chunk
     * @returns {Promise<ChunkRef>}
     */
    async function embedOne(chunk) {
        if (!chunk || typeof chunk !== 'object') {
            throw new TypeError('Embedder.embedOne: chunk must be an object');
        }
        const existing = /** @type {any} */ (chunk).embedding;
        if (existing != null) {
            // Idempotent: pass through untouched. No cache write — the
            // chunk's embedding may have come from a different model and
            // we must not poison the (modelId, content_hash) key with it.
            return toChunkRef(chunk, existing);
        }
        const vec = await resolveEmbedding(chunk);
        return toChunkRef(chunk, vec);
    }

    /**
     * @param {Array<Chunk|ChunkRef>} chunks
     * @returns {Promise<ChunkRef[]>}
     */
    async function embed(chunks) {
        if (!Array.isArray(chunks)) {
            throw new TypeError('Embedder.embed: chunks must be an array');
        }
        if (chunks.length === 0) return [];
        /** @type {ChunkRef[]} */
        const out = new Array(chunks.length);
        for (let i = 0; i < chunks.length; i++) {
            out[i] = await embedOne(chunks[i]);
        }
        return out;
    }

    return {
        embed,
        embedOne,
        stats() {
            return {
                hits,
                misses,
                failures,
                cached: backing.size(),
            };
        },
    };
}
