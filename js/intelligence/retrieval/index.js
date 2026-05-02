// @ts-check
/**
 * Public surface of the retrieval-admission subsystem.
 *
 * 1.4.9 ships the data foundation: the `ChunkID` hash and the typedef
 * surface in [contracts.js](./contracts.js). 1.4.10 adds `chunkProse` and
 * pins the chunker contract; 1.4.11 adds `chunkCode` (Phase 1 heuristic
 * regex chunker for JS/TS/Python). The remaining chunkers (`conversation`,
 * `structured`, `spec`), the StructureExtractor, the strategies, and the
 * Composer arrive in follow-up PRs (sequenced toward the 1.5.0 promotion
 * when legacy-vs-new agreement on test queries clears 80%; see
 * `docs/ROADMAP.md`).
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

/**
 * Placeholder for the eventual `compose(req: RetrievalRequest) => Promise<RetrievalResult>`
 * Composer entry point. Throws on call until the implementation lands so
 * accidental wire-up fails loudly during the transition.
 *
 * @param {import('./contracts.js').RetrievalRequest} _req
 * @returns {Promise<import('./contracts.js').RetrievalResult>}
 */
export async function compose(_req) {
    throw new Error('retrieval Composer not implemented; lands after the 1.4.9 foundation patch — see docs/ROADMAP.md §1.5.0');
}
