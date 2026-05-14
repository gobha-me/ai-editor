// @ts-check
/**
 * Chunker pipeline — the single callable entrypoint that subsequent ingest
 * PRs (Store, Loader, controller, parallel-execution harness) build on.
 * Implements the dispatch row of
 * [DESIGN-retrieval.md](../../../docs/DESIGN-retrieval.md) §"Ingest
 * Pipeline" (lines 265–329): pick the right chunker by `content_type`,
 * run [`extractStructure`](./structure-extractor.js) as a post-pass, return
 * `Chunk[]`.
 *
 * Pure function: `(input) → Chunk[]`. No I/O, no async, no external state.
 * Mirrors the 1.4.14 StructureExtractor PR pattern — content-type-
 * dispatched, no runtime wire-up, removability holds (Decision §7). The
 * load-bearing decision is encoding **"chunker output is always
 * structure-extracted"** as the public contract: callers stop having to
 * remember the post-pass, and the next chunker added to the dispatch table
 * inherits structural enrichment by default.
 *
 * Empty bytes short-circuit. `input.bytes.length === 0` returns `[]` before
 * dispatch; this is a centralization, not new behavior — every shipped
 * chunker already returns `[]` for empty bytes (see
 * [prose-chunker.js](./chunkers/prose-chunker.js) line 299, etc.). The
 * short-circuit lets the pipeline document the invariant in one place
 * instead of trusting it to drift across consumers.
 *
 * Dispatch table:
 *
 * | content_type   | Chunker             |
 * |---             |---                  |
 * | `prose`        | `chunkProse`        |
 * | `code`         | `chunkCode`         |
 * | `conversation` | `chunkConversation` |
 * | `structured`   | `chunkStructured`   |
 *
 * `spec` is **not** dispatched. Per
 * [DESIGN-retrieval.md](../../../docs/DESIGN-retrieval.md) §"Chunker"
 * table, the spec chunker is deferred past Phase 1; the pipeline rejects
 * it with `TypeError` rather than silently passing through, so an
 * accidental wiring surfaces at the boundary instead of at retrieval.
 *
 * Out of scope (per the 1.4.19 plan):
 *   - `content_type='auto'` magic — content-type detection is the Loader's
 *     job (DESIGN-retrieval line 275: loaders return `content_type_hint`).
 *     Two sources of truth would let extension-vs-explicit drift.
 *   - Mixed-content_type batches — by construction one `ChunkerInput` has
 *     one `content_type`; `extractStructure` already rejects mixed batches
 *     downstream.
 *
 * **Production wiring (since 1.5.14):** the ingest controller drives
 * `runChunkerPipeline` on every chunked source; the 1.5.14 cutover
 * retired legacy `js/context-manager.js` and made this module
 * load-bearing for `findRelevantFiles()`. Removability is inverted —
 * deleting this module breaks chunk-level ingest.
 *
 * @module intelligence/retrieval/pipeline
 */

import { chunkProse } from './chunkers/prose-chunker.js';
import { chunkCode } from './chunkers/code-chunker.js';
import { chunkConversation } from './chunkers/conversation-chunker.js';
import { chunkStructured } from './chunkers/structured-chunker.js';
import { extractStructure } from './structure-extractor.js';

/**
 * @typedef {import('./contracts.js').Chunk} Chunk
 * @typedef {import('./contracts.js').ChunkerInput} ChunkerInput
 * @typedef {import('./contracts.js').ContentType} ContentType
 * @typedef {import('./contracts.js').Chunker} Chunker
 */

/**
 * Dispatch table from `ContentType` to chunker. Phase 1 set; `spec` is
 * deferred past Phase 1 and intentionally absent — the pipeline rejects
 * `'spec'` rather than silently passing through.
 *
 * @type {Record<string, Chunker>}
 */
const CHUNKER_BY_CONTENT_TYPE = Object.freeze({
    prose: chunkProse,
    code: chunkCode,
    conversation: chunkConversation,
    structured: chunkStructured,
});

/**
 * Run a `ChunkerInput` through the right chunker for its `content_type`,
 * then through `extractStructure`. Returns the structurally-enriched
 * `Chunk[]`.
 *
 * Empty `input.bytes` returns `[]` without dispatching — every shipped
 * chunker has the same behavior, but centralizing it documents the
 * invariant and keeps an empty-input call cheap.
 *
 * The pipeline does not validate `input.bytes` / `input.collection` /
 * `input.metadata.source_uri` — each chunker validates its own
 * preconditions and throws `TypeError` with a chunker-specific prefix
 * (`chunkProse:` / `chunkCode:` / etc.). Keeping the pipeline thin avoids
 * duplicate validation that would drift from the chunkers'.
 *
 * @param {ChunkerInput} input
 * @returns {Chunk[]}
 * @throws {TypeError} On non-object input, missing/unknown `content_type`,
 *   or an explicit `'spec'` content_type (deferred past Phase 1).
 */
export function runChunkerPipeline(input) {
    if (input == null || typeof input !== 'object') {
        throw new TypeError('runChunkerPipeline: input must be an object');
    }
    if (input.metadata == null || typeof input.metadata !== 'object') {
        throw new TypeError('runChunkerPipeline: input.metadata must be an object');
    }
    const content_type = input.metadata.content_type;
    if (typeof content_type !== 'string' || content_type.length === 0) {
        throw new TypeError(
            'runChunkerPipeline: input.metadata.content_type must be a non-empty string',
        );
    }

    if (typeof input.bytes === 'string' && input.bytes.length === 0) {
        return [];
    }

    const chunker = CHUNKER_BY_CONTENT_TYPE[content_type];
    if (chunker == null) {
        if (content_type === 'spec') {
            throw new TypeError(
                'runChunkerPipeline: spec chunker is deferred past Phase 1 (see docs/DESIGN-retrieval.md §"Chunker")',
            );
        }
        throw new TypeError(
            `runChunkerPipeline: no chunker for content_type "${content_type}"`,
        );
    }

    const chunks = chunker(input);
    return extractStructure(chunks);
}
