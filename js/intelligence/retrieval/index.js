// @ts-check
/**
 * Public surface of the retrieval-admission subsystem.
 *
 * 1.4.9 ships the data foundation: the `ChunkID` hash and the typedef
 * surface in [contracts.js](./contracts.js). 1.4.10 adds `chunkProse` and
 * pins the chunker contract; 1.4.11 adds `chunkCode` (Phase 1 heuristic
 * regex chunker for JS/TS/Python); 1.4.12 adds `chunkConversation`
 * (1 turn = 1 chunk over a JSON-serialized HistoryTurn[]); 1.4.13 adds
 * `chunkStructured` (1 record per top-level array element / object key,
 * over JSON or JSONL). With 1.4.13 the Phase 1 chunker stream is complete
 * (`spec` deferred past Phase 1). 1.4.14 adds `extractStructure` — the
 * StructureExtractor pass that populates `metadata.structural` for prose
 * (heading hierarchy) and code (declaration-kind labeling) so the
 * Phase 1 Structural strategy can ancestor-walk over chunk metadata
 * without a separate tree artifact. 1.4.15 adds `createSemanticStrategy`
 * — the Phase-1 Semantic strategy (hybrid k-NN + BM25 + RRF) wrapping
 * the shipped 1.1.2 embedder, with the chunk-level vector store as an
 * injected callback until the ingest PR lands. 1.4.16 adds
 * `createStructuralStrategy` — the Phase-1 Structural strategy
 * (ancestor-walk over `parent_id` metadata) consuming the structural
 * meta produced by `extractStructure` and delegating the embed → k-NN
 * step to a caller-supplied `runSemanticRetrieve`. 1.4.17 ships
 * `compose` (the Composer) and `selectStrategies` (the Strategy
 * Router) — turning a `RetrievalRequest` into a `RetrievalResult`
 * with budget accounting, per-strategy quotas, ChunkID dedup,
 * round-robin overflow handling, and attention-aware block assembly;
 * the ledger-consultation step (design pseudocode 6.5) is stubbed in
 * this PR and lands as the ledger consumer in PR 10. 1.4.18 adds
 * `consultLedger` (the ledger consumer) — fills in step 6.5 of the
 * Composer's algorithm: when a `RetrievalRequest.task_ledger` is
 * supplied, low-novelty re-admissions are replaced with ~20-token
 * marker surrogates and admission/exclusion records are appended to
 * the ledger as a side effect. Composer's `compose()` calls into it
 * automatically when `req.task_ledger` is present; standalone use is
 * supported for callers that want to consult a ledger outside the
 * full pipeline. 1.4.19 adds `runChunkerPipeline` — the single
 * callable entrypoint that dispatches by `content_type` to the right
 * chunker and runs `extractStructure` as a post-pass; subsequent
 * ingest PRs (Store, Loader, controller, parallel-execution harness)
 * build on it instead of re-inlining the switch + extractor pass.
 * 1.4.20 adds `createInMemoryChunkStore` — the Phase-1 fulfillment of
 * the `getChunkByID` and `chunkVectorSearch` seams strategies and
 * Composer were calling against fakes, plus the incremental-ingest
 * surface (`getSourceHash` / `setSourceHash` / `chunkIdsForSource` /
 * `upsert` / `markStale`) the controller will sequence at 1.4.23.
 * Phase-1 in-memory: `markStale` deletes (a persistent backing store
 * revisits this with a 7-day grace tombstone); `upsert` is full
 * replace on id collision (trust the new payload — same content_hash
 * by construction, but possibly a freshly back-filled embedding).
 * 1.4.21 adds `createLoader` — the source-fetching seam of the ingest
 * pipeline. Per DESIGN-retrieval §"Ingest Pipeline" lines 273-275, a
 * Loader returns `(bytes, source_uri, content_hash, content_type_hint)`
 * given a source URI. Single dependency-injected factory: callers wire
 * `fetchBytes` to whichever byte source is appropriate (`Git.getFile`
 * for production at 1.4.23, in-memory `Map` for tests, MCP fetcher for
 * plugin sources). Pure helpers `detectContentType` and
 * `computeSourceHash` ship alongside for callers that need the
 * extension-dispatch logic or the change-detection fingerprint without
 * instantiating a Loader.
 * 1.4.22 adds `createEmbedder` — the back-fill seam between the chunker
 * pipeline (1.4.19) and the chunk store (1.4.20). Fourth and final
 * ingest-pipeline node before the controller. Per DESIGN-retrieval
 * §"Embedder" lines 304-308, embeddings are cached by
 * `(content_hash, embedder_model_id)`; the factory takes an injected
 * `embedFn` (production wires `(t) => EmbeddingsClient.embed(t)` after
 * `EmbeddingsClient.init()` resolves — same DI posture as 1.4.15's
 * `embedQuery`) plus a `modelId` that participates in the cache key, and
 * returns an `Embedder` exposing `embed(chunks)` / `embedOne(chunk)` /
 * `stats()`. Failures degrade — `embedFn` returning `null` or throwing
 * leaves `chunk.embedding = null` (the Store's `chunkVectorSearch`
 * already filters those out). Idempotent on already-embedded chunks.
 * 1.4.23 adds `createIngestController` — the orchestration piece that
 * sequences Loader → Chunker pipeline → Embedder → Store per the design's
 * update protocol (DESIGN-retrieval lines 313-328): hash-equality
 * short-circuit, ChunkID-equality dedup, only-new chunks embedded, stale
 * chunks `markStale`'d, source hash advanced last for crash-safety. Last
 * 1.4.x PR before 1.5.0 — single-source orchestrator only; the walker
 * / parallel-execution harness and the ≥80% legacy-vs-new agreement gate
 * that promotes the track to 1.5.0 land in 1.5.0 itself. The migration
 * off `js/context-manager.js` arrives at 1.5.2 (see `docs/ROADMAP.md`).
 *
 * Consumers should import from this barrel rather than reaching into
 * sibling modules, so the public surface remains the only commitment
 * across PRs.
 *
 * @module intelligence/retrieval
 */

export { computeChunkID, normalizeByteRange } from './chunk-id.js';
export { CHUNKER_VERSION } from './contracts.js';
export { chunkProse } from './chunkers/prose-chunker.js';
export { chunkCode } from './chunkers/code-chunker.js';
export { chunkConversation } from './chunkers/conversation-chunker.js';
export { chunkStructured } from './chunkers/structured-chunker.js';
export { extractStructure, NODE_KIND } from './structure-extractor.js';
export { runChunkerPipeline } from './pipeline.js';
export { createSemanticStrategy } from './strategies/semantic.js';
export { createStructuralStrategy } from './strategies/structural.js';
export { compose } from './composer.js';
export {
    selectStrategies,
    DEFAULT_TOTAL_QUOTA,
    DEFAULT_FALLBACK_QUOTA,
    VIABILITY_THRESHOLD,
} from './router.js';
export {
    consultLedger,
    DEFAULT_NOVELTY_THRESHOLD,
    DEFAULT_TIME_DECAY_MS,
    MARKER_TOKEN_COST,
} from './ledger-consumer.js';
export { createInMemoryChunkStore } from './store.js';
export { createLoader, detectContentType, computeSourceHash } from './loader.js';
export { createEmbedder } from './embedder.js';
export { createIngestController } from './ingest-controller.js';
