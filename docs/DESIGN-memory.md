# Memory Contract

**Status:** Implemented and consent-gated.

Memory stores small durable facts, not conversation transcripts. The public
surface is exported from `js/intelligence/memory/index.js`; records and audit
entries use dedicated IndexedDB stores, with an optional repository file layer.

## Data Model

A record has stable identity, scope (`user` or `workspace`), owner, canonicalized
key, category, value, source, timestamps, and lifecycle metadata. Keys are
case-insensitive within an owner/scope. Categories and sources come from the
closed sets in `contracts.js`; unknown values fail validation.

## Memory Lifecycle

- Explicit user memory may be written directly through the approved memory tool.
- Agent-proposed memory enters the consent queue and is not durable until the
  user accepts it.
- Update, supersede, soft-delete, and expiry append audit records. Soft deletion
  uses the documented sentinel and remains observable until purged.
- Per-key mutation is serialized to avoid lost updates.
- Semantic search is optional. Embedding failure falls back without weakening
  record validation or consent.
- The repository file layer writes only its documented memory paths and exposes
  pending writes and diagnostics; it does not silently overwrite dirty state.

The chat citation chip is a rendering affordance for memory references, not an
authority elevation. Coverage lives in `tests/test-memory-*.mjs` and file-layer
tests.

## Chat Citation Wire Format

Rendered citations carry a record identifier and display label only. The UI
resolves the identifier through the memory store and treats missing, expired, or
deleted records as unavailable rather than trusting embedded display text.
