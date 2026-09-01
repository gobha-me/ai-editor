# Retrieval Contract

**Status:** Implemented and optional.

`js/intelligence/retrieval/` ingests bounded sources into stable chunks, stores
them, selects strategies for a query, and composes labelled evidence for prompt
use. Retrieval is advisory context; it never authorizes actions.

## Core Contracts

Sources, chunks, strategies, scored references, composition requests, and
composition results use the validated shapes exported beside their owning
modules. Unknown schema variants are not silently coerced.

## Chunk Identity and Stability

Chunk identity is derived from collection, source URI, normalized byte range,
and chunker version. A chunker-version change intentionally changes identity.

## Ingest Pipeline and Chunkers

- Loaders normalize bytes and content type before chunking.
- The ingest controller orders project files, enforces file/token ceilings, and
  records diagnostics for skipped or failed inputs.
- Index replacement and delta updates preserve source identity and fail closed on
  invalid cached/schema state.

## Composition Algorithm

- The router selects only viable registered strategies and enforces total and
  fallback quotas.
- Semantic, structural, and thematic strategies return scored references using
  the shared chunk shape.
- Composition deduplicates, applies filters and budgets, records admitted and
  rejected evidence, and returns explicit truncation diagnostics.
- Query paraphrasing and embeddings are optional. Their failure falls back to
  deterministic local behavior rather than producing fabricated matches.
- Retrieved content is wrapped as untrusted evidence with source coordinates.

Public factories and contracts live alongside their implementations; manager and
comparison harnesses are consumers, not alternate authorities. Retrieval tests
cover stable IDs, ingest limits, routing, scoring, filtering, composition, cache
migration, and provider failure.

## Observability

Results expose selected strategies, admitted/rejected counts, truncation,
fallbacks, timing, and source coordinates. Diagnostics must not contain provider
credentials or raw embedding vectors.
