# DESIGN — Retrieval

**Status:** Draft
**Depends on:** A vector store capable of storing embeddings and metadata alongside content, with k-NN query and metadata filtering. Specific choice is deferred; the design treats it as a pluggable dependency.
**Sibling subsystems:** `DESIGN-memory.md`, `DESIGN-compression.md`. All three are coordinated by `DESIGN-intelligence.md`.

> **Note on naming.** This document was previously titled "Shared Intelligence Layer." It has been renamed to *Retrieval* because the umbrella name "intelligence" is now reserved for the three-subsystem architecture (retrieval, memory, compression). This document covers retrieval only; conversation-history compaction has been split out into its own sibling document.

---

## Problem

Any system that sends a prompt to an LLM faces the same question: given a fixed context window, what content goes in it?

This is the **admissibility** question, not an accumulation question. The architecture this document is part of commits to default-exclusion as the first principle (see `DESIGN-intelligence.md`). Retrieval's job is not to maximize what it returns; it is to admit only what earns its place under the per-call budget, and to record what it excluded and why. This framing is load-bearing for everything that follows.

That choice is almost always the dominant factor in output quality. It outweighs model selection, prompt wording, and temperature tuning. A well-chosen 8k-token prompt against a mid-tier model regularly beats a stuffed 100k-token prompt against the best model available, and costs an order of magnitude less.

Despite this, context selection is consistently treated as an implementation detail. Each new feature that talks to an LLM re-invents its own logic for picking what to include. The result, predictably:

- **Duplicated effort.** Every component rebuilds chunking, embedding, retrieval, and budgeting.
- **Inconsistent quality.** Two components given the same corpus and query return different context. Bugs in one are never fixed in the other.
- **No shared feedback.** When retrieval returns the wrong thing, the signal lives inside one component and doesn't improve the next.
- **Cost blowout.** Without a budget discipline, the easy path is to pass more tokens. Token-per-call drifts upward until someone notices the bill.
- **Retrieval-as-afterthought.** Because it's written reactively inside each feature, the retrieval logic is typically the weakest part of the pipeline — one-shot semantic search with no thought to structure, diversity, or composition.

The thesis of this document is that **context selection is a cross-cutting concern, not a per-feature concern**. It deserves a dedicated library with a clean contract, strong failure semantics, and the ability to evolve independently of the components using it.

### What the problem is not

It's worth being precise about what this design is and isn't trying to solve:

- **Not an LLM wrapper.** The library does not call the generation model. It produces a context block; the caller sends the prompt.
- **Not a vector database.** It depends on one. It does not implement storage, k-NN indexes, or persistence.
- **Not a prompt engineering framework.** It does not template prompts. It hands the caller structured blocks; the caller composes the final prompt.
- **Not a memory system.** Curated, scoped, persistent facts are the job of the memory subsystem (`DESIGN-memory.md`). Memories register as collections that retrieval can query, but their lifecycle, scoping, audit, and supersession are not retrieval's concern.
- **Not a history compactor.** Conversation history compaction is the job of the compression subsystem (`DESIGN-compression.md`). Retrieval consumes a `history` parameter assumed to be already compressed; it does not run eviction rules or summarization itself. Earlier drafts of this design folded history compression into the Composer; that responsibility now lives elsewhere.

The library answers exactly one question: *given a task, a corpus, and a budget, what content should be placed in the context window and in what order?*

---

## Goals

1. **One embedded corpus, many query strategies.** Content is chunked and embedded once. Different retrieval approaches operate over the same vectors and metadata.
2. **Explicit contracts at every seam.** The library is composed of small pieces with defined inputs and outputs. Each piece is testable in isolation.
3. **Honest failure modes.** Every failure has a specified behavior. No silent empty results, no silent wrong results, no happy-path-only guarantees.
4. **Observable by default.** Every request returns diagnostics. What strategies ran, what they returned, where budgets were hit, what degraded.
5. **Provider-agnostic and local-capable.** Embedding providers are pluggable. The library must be able to run with a fully local stack.

---

## Non-Goals

- Replacing or reimplementing a vector store.
- Cross-process state coordination. The library is embedded in a process; any shared state lives in the underlying vector store.
- Multi-modal (image / audio) embeddings in v1.
- Real-time or streaming retrieval.
- End-user UI.

---

## The Load-Bearing Decision: Three Strategies, One Corpus

The most common mistake in retrieval system design is treating different retrieval patterns as separate subsystems. Earlier drafts of this design did the same — describing "semantic," "structural," and "thematic" retrieval as three parallel tiers, each with its own box in the architecture diagram.

They are not parallel subsystems. They are three **query strategies over a single embedded corpus**:

- **Semantic:** "Find content whose meaning is close to this query."
- **Structural:** "Find content by its position in a document hierarchy."
- **Thematic:** "Find content that covers the topic space of this corpus, without a specific query."

All three share the same chunks, the same embeddings, the same vector store, and the same metadata. They differ only in how a query selects among chunks.

This framing matters because it establishes a gatekeeping rule: **if a proposed strategy cannot be expressed as "a different way to select from the same chunks," it does not belong in this layer.** It belongs either in the ingest pipeline (producing a differently-chunked collection) or in the consuming component.

Under that rule, a lot of apparent complexity evaporates. There is no tree store because the structural "tree" is just the transitive closure of parent-child metadata on ordinary chunks. There is no cross-strategy score-fusion problem because strategies do not compete for slots — each gets a per-strategy quota and returns its own chunks. There is no question of which tier owns embeddings because embeddings live with the chunks.

---

## Architecture

```
┌──────────────────────────────────────────┐
│  Caller (provides task + query + budget) │
└──────────────────┬───────────────────────┘
                   ▼
         ┌───────────────────┐
         │  Composer         │  ← budget, order
         │   ├─ Budget       │
         │   └─ Ordering     │
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │  Strategy Router  │
         └─────────┬─────────┘
                   │
                   ▼
   ┌───────────────────────────────────────┐
   │  Retrieval Strategies                 │
   │   ├─ Semantic (hybrid k-NN)           │
   │   ├─ Structural (section retrieval)   │
   │   └─ Thematic (cluster sampling)      │
   └─────────────────┬─────────────────────┘
                     │
                     ▼
           ┌───────────────────┐
           │  Chunk Store      │
           │  (vectors +       │
           │   content +       │
           │   metadata)       │
           └─────────┬─────────┘
                     │
                     ▼
           ┌───────────────────┐
           │  Ingest Pipeline  │
           └───────────────────┘
```

The Composer is the only surface callers use. Everything else is internal.

---

## Core Contracts

These are the seams. They are specified fully because underspecification here is how retrieval libraries decay into "everyone passes dicts around."

### ChunkRef — the atomic unit

Every piece of content the library can return is represented as a `ChunkRef`. Every chunk produced by ingest is addressable.

```
ChunkRef {
  id:         ChunkID           // stable across re-embeds; see "Chunk Identity"
  collection: string            // logical index name
  content:    string            // the actual text
  tokens:     int               // precomputed for the target tokenizer family
  metadata:   Metadata
  provenance: Provenance        // where this came from, for citations
  embedding:  Vector | null     // present only when a downstream stage needs it
}

Metadata {
  source_uri:    string          // canonical source identifier
  content_type:  ContentType     // prose | code | conversation | structured | spec
  created_at:    timestamp
  updated_at:    timestamp
  content_hash:  string          // hash of the source region this chunk covers
  structural:    StructuralMeta? // populated only for structured content
  custom:        map<string, any> // opaque to the library
}

StructuralMeta {
  heading_path:  []string        // e.g. ["API Reference", "Auth", "OAuth2"]
  node_kind:     string          // "section" | "function" | "type" | "test" | ...
  parent_id:     ChunkID?
  sibling_order: int
}

Provenance {
  source_uri:    string
  byte_range:    (int, int)?
  line_range:    (int, int)?
  retrieved_by:  Strategy
  score:         float           // strategy-defined; not comparable across strategies
  score_kind:    "cosine" | "bm25" | "hybrid" | "structural_expanded" | "cluster_distance"
}
```

**Why this schema, specifically:**

- `tokens` is precomputed at ingest. The Composer does budget math on every call; retokenizing on the hot path is wasteful. If the system later needs multi-tokenizer support this becomes a map keyed by tokenizer family.
- `content_hash` is over the **source region**, not the chunk text. This means re-chunking with a new strategy doesn't invalidate hashes for unchanged source regions, which lets the embedding cache survive chunker upgrades.
- `score_kind` is explicit precisely because scores from different strategies are incomparable. Labeling the kind forces any downstream code to think about it rather than silently averaging a cosine with a BM25 score.
- `structural` is optional and opaque to the semantic strategy. Only the structural strategy reads it. This is the design's way of saying "structured content is richer, but retrieval strategies that don't care can ignore it."

### RetrievalRequest — what callers pass

```
RetrievalRequest {
  task:           string               // the user-facing task, for the router
  query:          string?              // optional; required for semantic
  collections:    []string             // which logical indices to search
  budget:         Budget
  history:        []Turn?              // conversation so far, if any
  filters:        MetadataFilter?
  strategy_hints: []StrategyHint?      // force a strategy if the caller knows better
  priority_pins:  []ChunkID?           // caller-supplied must-includes
  task_ledger:    TaskLedger?          // per-task admission record; see DESIGN-profiles.md
}

Budget {
  total_tokens:   int    // ceiling for the full composed prompt
  system_reserve: int    // for the system prompt the caller will prepend
  output_reserve: int    // max_tokens for the generation
  history_reserve: int   // for recent turns verbatim
  // retrieval budget = total - system_reserve - output_reserve - history_reserve
}
```

### RetrievalResult — what callers get back

```
RetrievalResult {
  blocks:       []ContextBlock          // ordered; emit in this order
  used_tokens:  int
  chunks_by_id: map<ChunkID, ChunkRef>  // for citation and feedback
  diagnostics:  Diagnostics              // always populated
}

ContextBlock {
  role:     "system_context" | "retrieved" | "history" | "task"
  content:  string
  chunks:   []ChunkID    // which ChunkRefs contributed (empty for synthesized blocks)
  position: "head" | "body" | "tail"
}
```

The result is **structured blocks, not a flat string**. The caller concatenates in `position` order, keeping control over the final prompt format while letting the library own attention-ordering decisions.

### Strategy — the plug-in seam

Every retrieval strategy implements the same interface:

```
Strategy {
  name: string
  applies_to(req: RetrievalRequest) -> Applicability
  retrieve(req: RetrievalRequest, quota: int) -> []ChunkRef
  // quota is a soft hint in chunks; strategy may return fewer
}

Applicability {
  score:  float   // 0.0 = do not use, 1.0 = ideal fit
  reason: string  // for diagnostics
}
```

The router asks each strategy how well it fits, picks the viable ones, and gives each a quota proportional to its applicability. Adding a fourth strategy later is a single implementation, not a refactor. This is the extensibility story — not inheritance, not plugins, just an interface with three methods.

---

## Chunk Identity and Stability

A retrieval library's feedback signal (this chunk was useful, that chunk was missed) is only as durable as its chunk IDs. If IDs change every time content is re-embedded, feedback rots on contact.

**ChunkID is deterministic and stable across re-embeds of unchanged content.**

```
ChunkID = hash(collection || source_uri || normalized_byte_range || chunker_version)
```

Consequences:

- Re-running ingest on unchanged source produces identical IDs. Vector store upserts are no-ops.
- Re-chunking with a **new chunker version** produces new IDs. Old and new chunks coexist briefly, with old ones garbage-collected after a grace period. This is deliberate: feedback collected against v1 chunks remains valid for analysis even after v2 chunking ships; it simply no longer predicts retrievals.
- Editing source changes the byte range, producing new IDs. Old chunks are marked stale on the next ingest pass over that source.
- Chunker version is part of the ID so two chunkers can run in parallel during migrations without ID collisions.

**Garbage collection:** On an ingest pass over a source, any ChunkID previously associated with that source that is not re-emitted is marked stale. A periodic sweep deletes stale chunks older than the configured grace period (default 7 days).

---

## Ingest Pipeline

```
Source → Loader → Chunker → Embedder → Store
                     │
                     └─ StructureExtractor (optional, by content_type)
```

### Loader

Fetches raw source. One loader per source kind. Loaders return `(bytes, source_uri, content_hash, content_type_hint)`. They do not interpret content — that is the chunker's job.

### Chunker

Content-type-dispatched. Each chunker is pure: `(bytes, metadata) → []Chunk`.

| content_type | Chunker | Boundaries | Target size |
|---|---|---|---|
| prose | `ProseChunker` | paragraph, heading | 800–1200 chars, 100 char overlap |
| code | `CodeChunker` (heuristic v1) | top-level declarations, import blocks | per-construct, no overlap |
| conversation | `TurnChunker` | message boundary | 1 chunk per turn, never split |
| structured | `RecordChunker` | top-level keys / array elements | per record |
| spec | `SectionChunker` | heading hierarchy | per leaf section, up to ~2000 chars |

**On the conversation chunker.** The default treats every turn as a single chunk. Profiles for surfaces beyond standard chat (multi-user, RP, coder) extend `Metadata.custom` with surface-specific fields — `speaker_id`, `persona_id`, `tool_name`, `tool_result_for`, `file_ops`, etc. The chunker itself does not interpret these fields; it just preserves them. The compression subsystem reads them (see `DESIGN-compression.md`); strategies that don't care about them ignore them. This is the design's extensibility seam for surface-specific metadata: it lives in `Metadata.custom`, not in the core schema.

**On code chunking specifically.** "Structural chunking of source code" is easy to write in one line and hard to deliver. Earlier drafts elided the difficulty. The honest commitment:

- **Phase 1:** A heuristic chunker using language-aware regex for top-level declaration boundaries in a small set of target languages. Everything between top-level boundaries is a chunk. Known to fail on deeply nested types, complex generics, and macro-heavy code. Ship it anyway; instrument it.
- **Phase 3:** An AST-based chunker using tree-sitter or similar, gated on a **measured quality gap** between Phase 1 heuristics and AST-based chunking on a representative corpus.

The chunker version is bumped on any logic change so IDs invalidate cleanly.

### StructureExtractor

Runs only for content types with meaningful hierarchy: specs, prose with heading structure, code. Produces `StructuralMeta` and populates `parent_id` references during ingest.

Critically, **the hierarchical "tree" is not a separate artifact**. It is the transitive closure of `parent_id` relationships across chunks. Querying the tree is a metadata query over `structural.parent_id`. This resolves the previously open question of tree storage — there is no tree to store.

### Embedder

Resolves an embedding provider via a fallback chain (local / self-hosted / cloud) **at library initialization**, not per-call. Swapping providers requires reinitializing. This is deliberate: per-call provider negotiation adds latency to ingest with no benefit to retrieval quality.

Embeddings are cached by `(content_hash, embedder_model_id)`. A provider swap invalidates cache; a content edit invalidates cache for that chunk only.

### Incremental Ingest

```
ingest(source_uri):
  current_hash = hash(load(source_uri))
  stored_hash  = store.get_source_hash(source_uri)
  if current_hash == stored_hash:
    return NoOp

  new_chunks    = chunk(load(source_uri))
  old_chunk_ids = store.chunk_ids_for_source(source_uri)
  new_chunk_ids = {c.id for c in new_chunks}

  to_remove = old_chunk_ids - new_chunk_ids
  to_add    = [c for c in new_chunks if c.id not in old_chunk_ids]

  embed(to_add)
  store.upsert(to_add)
  store.mark_stale(to_remove)
```

That is the whole update protocol. No Merkle trees, no diff algorithms. Content hash at the source level, ChunkID equality at the chunk level.

---

## Retrieval Strategies

### Semantic (Phase 1)

Standard hybrid search. Given a query:

1. Embed the query.
2. k-NN against the collection's vectors (k = quota × 3 for headroom).
3. If keyword signal is available (from the query or an explicit hybrid text), run BM25 over the same chunks' content.
4. Fuse with reciprocal rank fusion. RRF is parameter-free and robust; this design does not introduce learned weights in v1.
5. Apply metadata filters.
6. Return top `quota`.

**Failure modes:**

- Query too short for useful embedding (fewer than 3 tokens) → fall back to pure BM25, flag in diagnostics.
- Embedding provider unavailable → return empty result with `degraded: true` in diagnostics. Do not silently skip, do not block.
- Collection empty → empty result, not an error.

### Structural (Phase 1: ancestor-walk)

The intuition behind structural retrieval is that for well-organized content (specs, code, structured docs), semantic retrieval returns fragments that lose their context. A user asking about "the authentication middleware" typically wants the whole middleware section or the whole function, not three paragraphs sliced from it.

Earlier drafts proposed an LLM-guided descent through a document tree. That is genuinely useful but genuinely expensive, and most of the value can be captured without an LLM at all.

**Phase 1 mechanism, no LLM in the loop:**

1. Run semantic retrieval as normal.
2. For each returned chunk, if `metadata.structural` is populated, walk up `parent_id` to find the smallest ancestor whose token count fits the per-chunk budget (default: retrieval_budget / quota).
3. Replace the chunk with its ancestor section. Deduplicate when multiple hits share an ancestor.
4. Return the expanded chunks with `score_kind: "structural_expanded"` and provenance pointing to the original semantic hits.

The entire thing is a parent-pointer walk over metadata populated at ingest time. Microseconds of retrieval cost, no generation model involved.

**Phase 3, gated on measurement:** LLM-guided descent from the top of the hierarchy for queries where Phase 1 ancestor-expansion returns too much or too little. We ship Phase 1, instrument it, and only build Phase 3 if the numbers justify it.

**Failure modes:**

- Chunk has no structural metadata → return chunk unchanged (graceful degradation to semantic).
- Ancestor exceeds budget even at the root → return original chunk, flag `structural_too_large` in diagnostics.

### Thematic (Phase 2)

Clustering for query-free retrieval: "summarize this project," "what themes are in these documents," "give me a coverage sample of this corpus."

Implementation:

1. Over the filtered vectors, run k-means with k from the request.
2. For each cluster, return the vector nearest the centroid as the representative.
3. Score = negative distance to centroid.

**Incremental clustering is explicitly not attempted in v1.** Clustering runs per-request over the filtered set. Expensive enough that the filtered set size is capped (default 50k vectors), and the cap is surfaced in diagnostics when hit.

**Failure modes:**

- Fewer vectors than k → return all vectors, k effectively reduced, flag in diagnostics.
- Cluster collapse (one dominant cluster) → still return k representatives but flag low silhouette score in diagnostics, so the caller knows coverage is poor.

---

## Composition Algorithm

The Composer is where the most logic lives. Full algorithm:

```
compose(req: RetrievalRequest) -> RetrievalResult:

  # 1. Budget accounting
  retrieval_budget = req.budget.total_tokens
                   - req.budget.system_reserve
                   - req.budget.output_reserve
                   - req.budget.history_reserve

  # 2. History handling — req.history is assumed pre-compressed by
  #    the compression subsystem. The Composer just packages it as blocks
  #    and verifies it fits within history_reserve.
  history_blocks = package_history(req.history, req.budget.history_reserve)

  # 3. Strategy selection
  strategies = router.select(req)   # [(strategy, quota, applicability)]

  # 4. Per-strategy retrieval
  retrieved = []
  for strategy, quota, _ in strategies:
    chunks = strategy.retrieve(req, quota)
    retrieved.append((strategy.name, chunks))

  # 5. Pinned chunks get budget first
  pinned = [store.get(id) for id in req.priority_pins]
  remaining_budget = retrieval_budget - sum(c.tokens for c in pinned)

  # 6. Interleave with per-strategy token budgets
  selected = pinned[:]
  for strategy_name, chunks in retrieved:
    strategy_budget = remaining_budget * strategy_weight(strategy_name, strategies)
    used = 0
    for chunk in chunks:
      if used + chunk.tokens > strategy_budget:
        break
      if chunk.id in {c.id for c in selected}:
        continue                # dedup across strategies
      selected.append(chunk)
      used += chunk.tokens

  # 6.5 Task ledger consultation (if supplied)
  #     Replace low-novelty re-admissions with reference markers.
  if req.task_ledger is not None:
    selected = consult_ledger(selected, req.task_ledger, req.query)
    # consult_ledger appends new admissions and suppression records
    # to the ledger as a side effect.

  # 7. Overflow handling (chunk truncation, not history compression)
  if sum(c.tokens for c in selected) > retrieval_budget:
    selected = truncate_lowest_priority(selected, retrieval_budget)

  # 8. Emit blocks in attention-aware order
  return assemble_blocks(
    task=req.task,
    retrieved=selected,
    history=history_blocks,
  )
```

**Per-strategy quotas, not cross-strategy score fusion.** This is the single biggest simplification in the design. The library does not try to compare a cosine score to a BM25 score to a cluster distance. Each strategy gets a token share proportional to its applicability, retrieves independently, and the Composer dedups by ChunkID.

**Overflow handling.** When a single pinned chunk exceeds the total budget, the Composer truncates prose or rejects the request for code (where truncation produces garbage). This is a caller-visible error, not a silent failure.

**History compression is delegated.** Conversation history compaction is the responsibility of the compression subsystem (`DESIGN-compression.md`). Retrieval expects `req.history` to already be the compressed output of that subsystem. If a caller wants raw uncompressed history passed through, they pass it through; retrieval does not run rules or summarizers itself. Compression is **not** applied to retrieved chunks in any version of this design — compressing retrieved chunks risks losing the precision that structural retrieval was specifically designed to provide.

**Task ledger consultation.** When `req.task_ledger` is supplied (typically by a profile maintaining per-task state — see `DESIGN-profiles.md`), the Composer consults it before admitting any candidate chunk:

1. For each candidate chunk identified by the strategies, check whether it appears in `task_ledger.admissions`.
2. If yes, compute a *novelty score* against the prior admission's justifying query. Signals include: cosine distance between current and prior query embeddings, presence of new keywords in the current query, time elapsed since prior admission, and any explicit re-examination flag in `strategy_hints`.
3. **High novelty** (a different aspect of the same chunk is now relevant) → re-admit normally; record a new admission in the ledger.
4. **Low novelty** (this chunk has already been admitted for substantively the same query) → suppress full re-admission; emit a reference marker (`[Already admitted: chunk_id — see turn N]`) consuming token cost on the order of 20 tokens instead of the full chunk size; record a suppression in `task_ledger.exclusions` with reason `"already_admitted_low_novelty"`.

The novelty threshold is a profile-tunable parameter, defaulting conservatively (re-admit when in doubt). The ledger itself is owned and lifecycle-managed by the profile; the Composer is a read-mostly consumer that appends new admission records as a side effect of retrieval. This is the single intentional case of cross-call state in the otherwise-stateless retrieval contract, and it is justified by the cost discipline: legitimately context-heavy multi-turn tasks (code review, large-corpus exploration) become economically tractable only with this amortization.

### Attention-Aware Ordering

Modern transformer attention is strongest at the start and end of the window. Blocks are emitted with explicit position hints:

- `task`: tail — the task instruction should be the last thing the model sees.
- `system_context`: head — framing the caller always wants at the top.
- `retrieved`: body.
- `history`: body. The compression subsystem may have replaced older spans with synthesized marker turns (`role: "system"`); those interleave naturally in chronological position alongside surviving real turns.

Callers can override by setting position explicitly on the request.

---

## Strategy Router

Heuristic first, with a clear fallback path. Pseudocode:

```
select(req) -> [(Strategy, quota, Applicability)]:
  applicability = [(s, s.applies_to(req)) for s in all_strategies]
  viable = [(s, a) for s, a in applicability if a.score >= 0.3]

  if not viable:
    return [(SemanticStrategy, default_quota, Applicability(0.5, "fallback"))]

  # Normalize applicability to quotas summing to the configured total
  total = sum(a.score for _, a in viable)
  return [(s, int(default_total_quota * a.score / total), a) for s, a in viable]
```

Each strategy implements `applies_to`. Defaults:

- **Semantic:** 1.0 if `query` is present, 0.0 otherwise.
- **Structural:** 0.8 if the target collection has >20% of chunks carrying structural metadata and a query is present.
- **Thematic:** 0.9 if `query` is empty or the task matches patterns like "summarize," "overview," "categorize."

Tunable, logged, testable.

**LLM tool-use mode** is a later-phase feature: expose `retrieve_semantic`, `retrieve_structural`, `retrieve_thematic` as tools and let an agent call them directly. Useful for agent loops. Not needed for Phase 1.

---

## Failure Modes

Every seam has a defined behavior on failure. No silent empty results, no silent wrong results.

| Failure | Behavior | Surfaced as |
|---|---|---|
| Embedding provider down (all fallbacks fail) | Semantic returns empty; structural falls back to metadata-only; thematic fails | `diagnostics.degraded_strategies` |
| Vector store unreachable | Whole request fails, structured error | Exception with retry hint |
| Collection does not exist | Empty result, not an error | `diagnostics.warnings` |
| Pinned ChunkID no longer exists | Skipped with warning | `diagnostics.warnings` |
| Pinned chunk alone exceeds budget | Prose: truncate with warning. Code/structured: reject with error | Exception or warning |
| Chunker version mismatch mid-request | Request completes with chunks from both versions; logged | `diagnostics.chunker_versions` |
| Malformed structural metadata | Treated as missing; graceful degrade to semantic | `diagnostics.warnings` |
| k-means fails to converge within max iterations | Return best-so-far clustering | `diagnostics.warnings` |
| Query embedding fails but BM25 available | Fall back to pure BM25 | `diagnostics.degraded_strategies` |

---

## Consistency Model

The library is embedded in a single process. The vector store it depends on may be shared across processes.

**Guarantees made:**

- Read-your-writes within a single process.
- ChunkID determinism across processes on identical inputs.
- Content hash comparison is the conflict resolution mechanism — last ingest wins per source.

**Guarantees not made:**

- Cross-process cache coherence. Each process has its own embedding and query caches.
- Strong ordering of concurrent ingests over the same source. Simultaneous ingests of the same content are no-ops (matching hashes); of different content, last writer wins with a warning.
- Read consistency during ongoing ingest. A query overlapping an ingest pass may see a mix of old and new chunks for the modified source.

**Coordination mechanism for shared deployments:** optional advisory metadata in the vector store (e.g., a `last_ingest_at` field per source) that coordinating callers can check and wait on. The library itself does not coordinate.

This is deliberately weak. Strong cross-process consistency would require a coordination service the design is unwilling to mandate.

---

## Caching

Three caches, all process-local:

1. **Embedding cache.** Key: `(content_hash, embedder_model_id)`. Value: vector. Never invalidated directly — the content hash encodes content. Size-bounded LRU.
2. **Query cache.** Key: `(collection, query_embedding_hash, filter_hash, strategy, quota)`. Value: `[ChunkID]`. TTL-based invalidation (default 5 minutes) plus explicit invalidation on ingest to the queried collection.
3. **Structural expansion cache.** Key: `ChunkID`. Value: expanded ancestor `ChunkID`. Invalidated on any ingest to the source.

No distributed caching. No cross-process invalidation. If cross-process caching later becomes necessary it is an additive change — caches are per-process today, and the library has no opinion on whether that remains true.

---

## Observability

Every `RetrievalResult` carries a `diagnostics` field. Minimum populated fields:

- `strategies_used`, `strategies_skipped` (with reason)
- `chunks_returned_per_strategy`
- `tokens_used`, `tokens_budget`, `tokens_truncated` (from chunk-overflow truncation, not history compression)
- `ledger_consulted`, `ledger_suppressions` (when `req.task_ledger` was supplied)
- `latency_per_strategy_ms`
- `cache_hits` per cache
- `degraded_strategies` — any strategies that ran in a degraded mode
- `warnings` — structured warning entries
- `chunker_versions` — for reproducibility

These fields are cheap to populate and make the library debuggable in production without additional instrumentation.

---

## Worked Example

A concrete trace, to make the contracts tangible. Query: "how does rate limiting work?" against a corpus containing both API documentation and source code.

**Request:**

```
RetrievalRequest {
  task: "Explain the rate limiting behavior to the user.",
  query: "how does rate limiting work",
  collections: ["api_docs", "server_code"],
  budget: Budget {
    total_tokens:    32000,
    system_reserve:   2000,
    output_reserve:   4000,
    history_reserve:  4000,    // retrieval budget = 22000
  },
  history: [...recent 4 turns...],
  filters: null,
}
```

**Router selection:**

- Semantic: applicability 1.0 (query present)
- Structural: applicability 0.8 (both collections have structural metadata)
- Thematic: applicability 0.0 (specific query)
- Quotas: semantic gets 12 chunks, structural gets 8 chunks.

**Semantic retrieval** against both collections:

- Returns 12 chunks. Top hits include fragments of the rate limiter implementation, two sections of the rate limiting API doc, a test file fragment, and a config snippet.

**Structural retrieval** (semantic hits, then ancestor-walk):

- The three fragments of the rate limiter source file share a common ancestor at the `RateLimiter` class level (~1200 tokens). Collapse to one chunk.
- The two API doc hits share the parent section "Rate Limiting" (~800 tokens). Collapse.
- The test fragment expands to the full test function (~600 tokens).
- The config snippet has no structural metadata; unchanged.

**Composition:**

- Pinned: none.
- Semantic contribution: ~55% of 22000 = 12100 tokens, filled with top-scoring chunks up to budget.
- Structural contribution: ~45% of 22000 = 9900 tokens. Dedup against semantic removes three semantic chunks subsumed by structural ancestors.
- Total selected: ~6400 tokens of retrieved content.

**Emitted blocks, in order:**

1. `system_context` (if any) — position: head
2. `history` (4 turns, possibly including marker turns from compression) — position: body
3. `retrieved` (structural ancestors + remaining semantic fragments, ordered by score within strategy) — position: body
4. `task` — position: tail

**Diagnostics:**

```
{
  strategies_used: ["semantic", "structural"],
  chunks_returned_per_strategy: { "semantic": 9, "structural": 4 },
  tokens_used: 6400,
  tokens_budget: 22000,
  latency_per_strategy_ms: { "semantic": 87, "structural": 4 },
  cache_hits: { "embedding": 1, "query": 0, "structural": 0 },
  degraded_strategies: [],
  warnings: [],
  chunker_versions: { "code": "v1.2", "prose": "v1.0" },
}
```

If an implementation disagrees with any step of this trace, that is the bug.

---

## Cost Model

Projected, not measured. Phase 1 must replace these numbers with measurements.

| Approach | Input tokens / call | Retrieval latency |
|---|---|---|
| Full context stuffing | 30k+ | 0 |
| Semantic only, no budgeting | 15k | ~100ms |
| This design (cache cold) | 6–8k | 200–400ms |
| This design (cache warm) | 6–8k | 20–50ms |

Caveats: these figures depend on the embedding model, vector store, and corpus size. They are a projection from published RAG literature adjusted for the added per-strategy retrieval steps. Treat them as targets, not claims. History-compression latency is captured in the compression subsystem's cost model (`DESIGN-compression.md`).

---

## Phased Delivery

**Phase 1 — MVP (4–6 weeks):**

- Core contracts (ChunkRef, RetrievalRequest, RetrievalResult, Strategy).
- Ingest pipeline with heuristic chunkers for prose, code (regex-based), conversation, structured, spec.
- Semantic strategy with hybrid search and RRF.
- Structural strategy as ancestor-walk over semantic results (no LLM).
- Composer with budget accounting, dedup, attention-aware ordering.
- Heuristic router.
- Full diagnostics.

*Explicitly excluded from Phase 1:* thematic retrieval, feedback logging, LLM tool-use routing. (History compression is not on this roadmap at all — it is the compression subsystem's responsibility; see `DESIGN-compression.md`.)

**Phase 2 (2–3 weeks):**

- Thematic retrieval (k-means).
- Query cache.

**Phase 3 (gated on measurement):**

- AST-based code chunker.
- LLM-guided structural navigation, only if Phase 1 structural quality is measurably insufficient.

**Phase 4:**

- LLM tool-use router mode.
- Explicit feedback logging.
- Cross-collection query coordination (multi-collection queries with collection-specific strategy selection).

---

## Open Questions

| Question | Why open | Resolution path |
|---|---|---|
| Embedding model choice | Ties into provider availability, cost, and local-first viability | Benchmark on a representative corpus before Phase 1 ships |
| Default budget split ratios | Depends on typical use patterns | Measure during Phase 1, tune in Phase 2 |
| Chunk overlap for prose | Too much hurts dedup; too little hurts recall | Default 100 chars; revisit with retrieval-quality data |
| Cache size limits | Depends on deployment footprint | Per-process config with sensible defaults |
| Structural metadata threshold in router applicability | Currently hardcoded at 20% | Tune against real collections |

Questions previously open and now resolved by this design: tree storage (there is no tree to store), clustering implementation (per-request k-means), hybrid scoring (parameter-free RRF), chunk identity (deterministic hash including chunker version). History compression is no longer this document's concern (see `DESIGN-compression.md`).

---

## What This Design Commits To

- **One corpus, three query strategies.** Not three subsystems.
- **Stable, deterministic chunk identity** across re-embeds.
- **Per-strategy quotas**, never cross-strategy score fusion.
- **Structural retrieval as ancestor-walk** in Phase 1. Tree navigation with an LLM only in Phase 3, only if measured to be necessary.
- **Explicit failure modes** at every seam.
- **Diagnostics on every call.**
- **Library, not service.** Cross-process coordination is out of scope; the vector store is the only shared state.

These are the load-bearing decisions. Push back on any of them before building.
