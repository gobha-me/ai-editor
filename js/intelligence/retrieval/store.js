// @ts-check
/**
 * In-memory Chunk Store — Phase 1 fulfillment of the dependency-injection
 * seams the shipped retrieval strategies and Composer have been awaiting:
 *
 *   - `getChunkByID(id) => Promise<ChunkRef|null>` — used by
 *     [`composer.js`](./composer.js) to resolve `priority_pins` and by
 *     [`strategies/structural.js`](./strategies/structural.js) for the
 *     ancestor-walk parent lookup. Both call sites already `await` the
 *     handle; the store fulfills the contract verbatim.
 *
 *   - `chunkVectorSearch(queryVec, collection, k) => Promise<Array<{chunk, similarity}>>` —
 *     used by [`strategies/semantic.js`](./strategies/semantic.js). Returns
 *     candidates **pre-sorted by similarity (descending)**; the strategy
 *     preserves that order and never re-sorts (see semantic.js §"sorted on
 *     the way out").
 *
 * Plus the incremental-ingest API the design pseudocode at
 * [`docs/DESIGN-retrieval.md`](../../../../docs/DESIGN-retrieval.md) lines
 * 313-328 names — `getSourceHash` / `setSourceHash` /
 * `chunkIdsForSource` / `upsert` / `markStale` — so the controller arriving
 * at 1.4.23 can sequence the design's update protocol against this handle
 * without contortion.
 *
 * **Phase-1 scope decisions** (called out so future readers don't have to
 * reverse-engineer them from behavior):
 *
 *   1. **`markStale` deletes.** The design's 7-day grace tombstone is a
 *      persistent-store concern; an in-memory store wiped on every process
 *      restart cannot meaningfully implement grace, and a tombstone state
 *      with no consumer is dead weight. Documented on the method.
 *
 *   2. **`upsert` with a colliding ChunkID is full replace.** ChunkID is
 *      content-derived — same id implies byte-identical content — so the
 *      legitimate same-id-replace case is the embedder back-filling an
 *      embedding on a previously un-embedded chunk. Trust the new payload.
 *      If the same id arrives with a different `collection` or
 *      `source_uri` (defensive — should not happen by ChunkID construction),
 *      remove from the old indexes before re-inserting under the new ones.
 *
 *   3. **Inline cosine helper.** [`js/embeddings-client.js`](../../embeddings-client.js)
 *      imports browser-bound `core.js` globals and is not node-test-safe.
 *      A 5-line `cosineSimilarity` lives module-private below. Promotion
 *      to a shared util is deferred until a second consumer appears (the
 *      legacy file-level retrieval path keeps using its own cosine via
 *      the embeddings client until the 1.5.2 migration).
 *
 *   4. **Length-mismatched embeddings are skipped, not thrown.** Embedder
 *      generations may legitimately coexist mid-migration; throwing would
 *      explode an entire query because of one stale chunk.
 *
 *   5. **`upsert` accepts `embedding: null`.** The Embedder lands at
 *      1.4.22; until then chunks legitimately store without vectors.
 *      `chunkVectorSearch` filters such chunks out.
 *
 * **Out of scope for 1.4.20:**
 *   - BM25 index construction (the typedef at
 *     [`strategies/semantic.js`](./strategies/semantic.js) `BM25Index`
 *     exists, but its producer ships once the Loader can stream chunked
 *     content into an indexer).
 *   - Persistent / IDB-backed storage.
 *   - Concurrency control beyond single-threaded JS.
 *
 * **Production wiring (since 1.5.14):** [`manager.js:34`](./manager.js)
 * imports `createInMemoryChunkStore` and threads the store handle into
 * the Composer (for `priority_pins` resolution) and the Semantic +
 * Structural strategies (for `chunkVectorSearch` + `getChunkByID`).
 * The legacy `js/context-manager.js` file-level path retired in the
 * same cutover. Removability is inverted — deleting this module breaks
 * chunk storage for production retrieval. ICD contract:
 * [`docs/DESIGN-intelligence.md`](../../../docs/DESIGN-intelligence.md).
 *
 * @module intelligence/retrieval/store
 */

/**
 * @typedef {import('./contracts.js').ChunkID} ChunkID
 * @typedef {import('./contracts.js').ChunkRef} ChunkRef
 * @typedef {import('./contracts.js').CollectionName} CollectionName
 * @typedef {import('./contracts.js').EmbeddingVector} EmbeddingVector
 */

/**
 * Public Store handle. Returned by `createInMemoryChunkStore`. Method
 * signatures match the injected seams the existing retrieval modules
 * already call against fakes.
 *
 * @typedef {Object} ChunkStore
 * @property {(id: ChunkID) => Promise<ChunkRef|null>}                                                                getChunkByID
 * @property {(queryVec: EmbeddingVector, collection: CollectionName, k: number) => Promise<Array<{chunk: ChunkRef, similarity: number}>>} chunkVectorSearch
 * @property {(sourceUri: string) => string|null}                                                                     getSourceHash
 * @property {(sourceUri: string, hash: string) => void}                                                              setSourceHash
 * @property {(sourceUri: string) => ChunkID[]}                                                                       chunkIdsForSource
 * @property {(collection: CollectionName) => Promise<ChunkRef[]>}                                                    getAllChunksForCollection
 * @property {(chunks: ChunkRef[]) => void}                                                                           upsert
 * @property {(ids: Iterable<ChunkID>) => number}                                                                     markStale
 * @property {() => { chunks: number, collections: number, sources: number }}                                         stats
 */

/**
 * Cosine similarity for two equal-length numeric vectors. Returns `0` when
 * either vector has zero norm — a degenerate vector contributes no signal,
 * so "no signal" maps cleanly to "zero similarity" rather than NaN. The
 * caller (`chunkVectorSearch`) treats length mismatches as a skip before
 * reaching here, so this helper assumes equal length.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Construct a fresh in-memory chunk store. Each call returns an isolated
 * handle; two handles share no state.
 *
 * @returns {ChunkStore}
 */
export function createInMemoryChunkStore() {
    /** @type {Map<ChunkID, ChunkRef>} */
    const chunksById = new Map();
    /** @type {Map<CollectionName, Set<ChunkID>>} */
    const chunkIdsByCollection = new Map();
    /** @type {Map<string, Set<ChunkID>>} */
    const chunkIdsBySource = new Map();
    /** @type {Map<string, string>} */
    const sourceHashes = new Map();

    /**
     * Drop an id from a `Map<K, Set<ChunkID>>` index, deleting the empty
     * key entirely so `stats().collections` / `.sources` reflect the
     * post-removal cardinality and `chunkVectorSearch` over an
     * emptied-out collection returns `[]` via the normal "unknown
     * collection" path rather than iterating an empty set.
     *
     * @param {Map<string, Set<ChunkID>>} index
     * @param {string} key
     * @param {ChunkID} id
     */
    function removeFromIndex(index, key, id) {
        const set = index.get(key);
        if (!set) return;
        set.delete(id);
        if (set.size === 0) index.delete(key);
    }

    /**
     * Add an id to a `Map<K, Set<ChunkID>>` index, creating the set on
     * first use.
     *
     * @param {Map<string, Set<ChunkID>>} index
     * @param {string} key
     * @param {ChunkID} id
     */
    function addToIndex(index, key, id) {
        let set = index.get(key);
        if (!set) {
            set = new Set();
            index.set(key, set);
        }
        set.add(id);
    }

    return {
        async getChunkByID(id) {
            if (typeof id !== 'string' || id.length === 0) return null;
            return chunksById.get(id) ?? null;
        },

        async chunkVectorSearch(queryVec, collection, k) {
            if (!Array.isArray(queryVec) || queryVec.length === 0) {
                throw new TypeError('chunkVectorSearch: queryVec must be a non-empty number[]');
            }
            if (!Number.isFinite(k) || k <= 0) return [];
            const ids = chunkIdsByCollection.get(collection);
            if (!ids || ids.size === 0) return [];
            const dim = queryVec.length;
            /** @type {Array<{chunk: ChunkRef, similarity: number}>} */
            const scored = [];
            for (const id of ids) {
                const chunk = chunksById.get(id);
                if (!chunk) continue;
                const emb = chunk.embedding;
                if (!Array.isArray(emb) || emb.length !== dim) continue;
                scored.push({ chunk, similarity: cosineSimilarity(queryVec, emb) });
            }
            scored.sort((x, y) => y.similarity - x.similarity);
            if (k >= scored.length) return scored;
            return scored.slice(0, k);
        },

        getSourceHash(sourceUri) {
            if (typeof sourceUri !== 'string' || sourceUri.length === 0) return null;
            return sourceHashes.get(sourceUri) ?? null;
        },

        setSourceHash(sourceUri, hash) {
            if (typeof sourceUri !== 'string' || sourceUri.length === 0) {
                throw new TypeError('setSourceHash: sourceUri must be a non-empty string');
            }
            if (typeof hash !== 'string') {
                throw new TypeError('setSourceHash: hash must be a string');
            }
            sourceHashes.set(sourceUri, hash);
        },

        chunkIdsForSource(sourceUri) {
            if (typeof sourceUri !== 'string' || sourceUri.length === 0) return [];
            const set = chunkIdsBySource.get(sourceUri);
            if (!set) return [];
            return Array.from(set);
        },

        /**
         * Materialize every chunk in a collection. Added at 1.5.10 for the
         * Thematic strategy, which clusters over the full filtered set
         * rather than a top-k slice. Unknown collection → `[]` (matches
         * the `chunkVectorSearch` posture). Async to match the existing
         * `await`-friendly API surface even though the in-memory impl
         * resolves synchronously.
         *
         * @param {CollectionName} collection
         * @returns {Promise<ChunkRef[]>}
         */
        async getAllChunksForCollection(collection) {
            const ids = chunkIdsByCollection.get(collection);
            if (!ids || ids.size === 0) return [];
            /** @type {ChunkRef[]} */
            const out = [];
            for (const id of ids) {
                const chunk = chunksById.get(id);
                if (chunk) out.push(chunk);
            }
            return out;
        },

        upsert(chunks) {
            if (!Array.isArray(chunks)) {
                throw new TypeError('upsert: chunks must be an array');
            }
            if (chunks.length === 0) return;
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (!chunk || typeof chunk !== 'object') {
                    throw new TypeError(`upsert: chunks[${i}] must be an object`);
                }
                if (typeof chunk.id !== 'string' || chunk.id.length === 0) {
                    throw new TypeError(`upsert: chunks[${i}].id must be a non-empty string`);
                }
                if (typeof chunk.collection !== 'string' || chunk.collection.length === 0) {
                    throw new TypeError(`upsert: chunks[${i}].collection must be a non-empty string`);
                }
                if (
                    !chunk.metadata ||
                    typeof chunk.metadata !== 'object' ||
                    typeof chunk.metadata.source_uri !== 'string' ||
                    chunk.metadata.source_uri.length === 0
                ) {
                    throw new TypeError(`upsert: chunks[${i}].metadata.source_uri must be a non-empty string`);
                }
            }
            for (const chunk of chunks) {
                const prior = chunksById.get(chunk.id);
                if (prior) {
                    if (prior.collection !== chunk.collection) {
                        removeFromIndex(chunkIdsByCollection, prior.collection, chunk.id);
                    }
                    if (prior.metadata.source_uri !== chunk.metadata.source_uri) {
                        removeFromIndex(chunkIdsBySource, prior.metadata.source_uri, chunk.id);
                    }
                }
                chunksById.set(chunk.id, chunk);
                addToIndex(chunkIdsByCollection, chunk.collection, chunk.id);
                addToIndex(chunkIdsBySource, chunk.metadata.source_uri, chunk.id);
            }
        },

        /**
         * Phase-1 in-memory: "stale" means "deleted." A persistent backing
         * store revisits this with a 7-day grace tombstone — see
         * DESIGN-retrieval §"Garbage collection".
         */
        markStale(ids) {
            if (ids == null || typeof ids[Symbol.iterator] !== 'function') return 0;
            let removed = 0;
            for (const id of ids) {
                if (typeof id !== 'string' || id.length === 0) continue;
                const chunk = chunksById.get(id);
                if (!chunk) continue;
                chunksById.delete(id);
                removeFromIndex(chunkIdsByCollection, chunk.collection, id);
                removeFromIndex(chunkIdsBySource, chunk.metadata.source_uri, id);
                removed += 1;
            }
            return removed;
        },

        stats() {
            return {
                chunks: chunksById.size,
                collections: chunkIdsByCollection.size,
                sources: chunkIdsBySource.size,
            };
        },
    };
}
