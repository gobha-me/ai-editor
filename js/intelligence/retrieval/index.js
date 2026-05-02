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
 * injected callback until the ingest PR lands. The Structural strategy,
 * the Composer, the ledger consumer, and the migration off
 * `js/context-manager.js` arrive in follow-up PRs (sequenced toward the
 * 1.5.0 promotion when legacy-vs-new agreement on test queries clears
 * 80%; see `docs/ROADMAP.md`).
 *
 * The placeholder `compose` export establishes the public surface so
 * downstream consumers can wire imports today and have those imports
 * fail loudly until the Composer ships, rather than swap import paths
 * mid-track.
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
export { createSemanticStrategy } from './strategies/semantic.js';

/**
 * Placeholder for the eventual `compose(req: RetrievalRequest) => Promise<RetrievalResult>`
 * Composer entry point. Throws on call until the implementation lands so
 * accidental wire-up fails loudly during the transition.
 *
 * @param {import('./contracts.js').RetrievalRequest} _req
 * @returns {Promise<import('./contracts.js').RetrievalResult>}
 */
export async function compose(_req) {
    throw new Error('retrieval Composer not implemented; lands as PR 9 of 1.5.0 — see docs/ROADMAP.md §1.5.0');
}
