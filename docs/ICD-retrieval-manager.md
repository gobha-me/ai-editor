# ICD — Retrieval manager + ingest pipeline contract

> **Status:** initial draft, `RE-EVAL following 2.52.0`. Fifth subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #5. Tracks the contract for `js/intelligence/retrieval/` — the production singleton ([`manager.js`](../js/intelligence/retrieval/manager.js), 1264 LOC), the pure-DI ingest factories ([`loader.js`](../js/intelligence/retrieval/loader.js), [`embedder.js`](../js/intelligence/retrieval/embedder.js), [`ingest-controller.js`](../js/intelligence/retrieval/ingest-controller.js), [`walker.js`](../js/intelligence/retrieval/walker.js), [`store.js`](../js/intelligence/retrieval/store.js)), the production wiring seam ([`wiring.js`](../js/intelligence/retrieval/wiring.js)), the strategy bundle ([`strategies/semantic.js`](../js/intelligence/retrieval/strategies/semantic.js), [`structural.js`](../js/intelligence/retrieval/strategies/structural.js), [`thematic.js`](../js/intelligence/retrieval/strategies/thematic.js)), the measurement harness ([`measurement.js`](../js/intelligence/retrieval/measurement.js), [`comparison.js`](../js/intelligence/retrieval/comparison.js), [`test-corpus.js`](../js/intelligence/retrieval/test-corpus.js)), and the event seam (`context:*`, `retrieval:turn-stats`, file-mutation listeners). The compose() algorithm itself is **out of scope** — that's [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md). Prior ICDs ([#1 chat-handlers, 2.42.0; #2 intelligence-composers, 2.45.0; #3 tool-registry, 2.46.0; #4 git-providers, 2.49.0](ROADMAP.md)) describe orthogonal seams. Code-aware findings from authoring feed back to ROADMAP as `[strong]`-band rows in 2.53.0+; **three** surface this pass (see §"Code-aware findings").

## Purpose

`RetrievalManager` ([`manager.js`](../js/intelligence/retrieval/manager.js)) is a production singleton owning the chunk-level retrieval pipeline lifecycle. It replaced the legacy file-level `js/context-manager.js` at the 1.5.14 cutover (legacy module deleted same release). It is the production wrapper around the pure-DI ingest factories shipped over 1.4.x–1.5.x: it wires `Git.getFile` + `EmbeddingsClient.embed` into [`createProductionIngestWalker`](../js/intelligence/retrieval/wiring.js), drives `findRelevantFiles`, persists the chunk store to IndexedDB per branch, and exposes the index-status / pause-resume surface that the index-status indicator + Settings → Storage tab + LLM Debug Indexer panel + auto-pause-while-generating coordinator consume.

Five sub-systems consume this contract: the `find_relevant_files` tool ([`js/llm/tool-handlers.js`](../js/llm/tool-handlers.js)) (single primary consumer); the cost-recorder ([`js/intelligence/cost/cost-recorder.js`](../js/intelligence/cost/cost-recorder.js)) (attributes paraphrase/expansion tokens via `retrieval:turn-stats`); the index-status indicator ([`js/ui/index-status.js`](../js/ui/index-status.js)) (consumes `context:index*` events + `getStats`); Settings → Storage tab (consumes `getIndexedProject` / `getFilesIndexed` / per-branch keys); and the auto-pause coordinator (`autoPause`/`autoResume` called from the LLM streaming layer).

The contract was implicit and inline through the 1.4.x foundations (1.4.9 contracts → 1.4.23 controller) and the 1.5.x track (1.5.0 walker → 1.5.14 cutover); the §1.5.0 exit gate (`mean recall@5 ≥ 0.80`) was finally cleared at the 1.5.7 T3 final per `project_retrieval_agreement_baseline.md`. **This ICD freezes the lifecycle, persistence, ingest-pipeline ordering, and event seam so the next contributor reading the file sees what's load-bearing vs. what's incidental.**

## The seam at a glance

| | Surface | Path | LOC | Trigger |
|---|---|---|---|---|
| **Production singleton** | `RetrievalManager` (frozen export object, 19 methods + `_resetForTesting`) | [`manager.js`](../js/intelligence/retrieval/manager.js) | 1264 | EventBus listeners (project:loaded, branch:switch, git:file*, context:prMerged, branches:refresh, git:branchDeleted, branch:created) |
| **Ingest pipeline (4 nodes)** | Loader → Chunker pipeline → Embedder → Store | [`loader.js`](../js/intelligence/retrieval/loader.js) + [`pipeline.js`](../js/intelligence/retrieval/pipeline.js) + [`embedder.js`](../js/intelligence/retrieval/embedder.js) + [`store.js`](../js/intelligence/retrieval/store.js) | 313 + 137 + - + 318 | `controller.ingest(source_uri)` per source |
| **Orchestrator** | `IngestController` (single-source pass) + `IngestWalker` (parallel harness, bounded concurrency) | [`ingest-controller.js`](../js/intelligence/retrieval/ingest-controller.js) + [`walker.js`](../js/intelligence/retrieval/walker.js) | - + 434 | Manager `indexProject` (full walk) or `_ingestSingle` (incremental) |
| **Production wiring** | `createProductionLoader` / `createProductionEmbedder` / `createProductionIngestWalker` | [`wiring.js`](../js/intelligence/retrieval/wiring.js) | 287 | Manager-side DI of `Git.getFile` + `EmbeddingsClient.embed` |
| **Strategy bundle** | `createSemanticStrategy` (hybrid k-NN + BM25 + RRF) + `createStructuralStrategy` (ancestor walk) + `createThematicStrategy` (k-means clustering) | [`strategies/semantic.js`](../js/intelligence/retrieval/strategies/semantic.js) + [`strategies/structural.js`](../js/intelligence/retrieval/strategies/structural.js) + [`strategies/thematic.js`](../js/intelligence/retrieval/strategies/thematic.js) | 687 + 335 + 529 | Built lazily in `_buildStrategies`; reused across queries within a singleton lifetime |
| **Measurement harness** | `createMeasurementHarness` + `createComparisonHarness` + `QUERY_FIXTURES` | [`measurement.js`](../js/intelligence/retrieval/measurement.js) + [`comparison.js`](../js/intelligence/retrieval/comparison.js) + [`test-corpus.js`](../js/intelligence/retrieval/test-corpus.js) | 843 + - + 778 | Browser runner at [`tests/retrieval-measurement.html`](../tests/retrieval-measurement.html); never wired into production paths |
| **Query orchestration** | `findRelevantFiles(query, topK)` → `compose()` → `rollupToFiles` → legacy `{path, similarity, summary}` shape | [`manager.js:627`](../js/intelligence/retrieval/manager.js) + [`composer.js`](../js/intelligence/retrieval/composer.js) (ICD #2) + [`manager-helpers.js`](../js/intelligence/retrieval/manager-helpers.js) | - | `find_relevant_files` tool calls |

The full barrel export surface is 26 public names across [`index.js`](../js/intelligence/retrieval/index.js) (chunkers, strategies, ingest factories, query expansion, measurement, BM25, paraphraser, expander). `RetrievalManager` is intentionally **NOT** re-exported from the barrel — it imports browser-bound modules (`core.js`, `git.js`, `embeddings-client.js`, `llm/api.js`) and would break node-test imports of pure factories. Pure helpers used by the manager are exported via [`manager-helpers.js`](../js/intelligence/retrieval/manager-helpers.js) for node-test coverage.

## The five classification axes

Each axis names a question the seam answers across the manager + ingest + storage + query surfaces. The first three (Ingest, Lifecycle, Persistence) describe *how chunks land in the store*; the last two (Query, Diagnostics) describe *how chunks get out and how the call gets observed*.

| Axis | Question | Where it's declared | Where it's read |
|---|---|---|---|
| **Ingest axis** | What's the data-flow shape from "source URI" to "indexed chunk"? | `IngestController.ingest(source_uri)` per [DESIGN-retrieval.md](DESIGN-retrieval.md) §"Update protocol" lines 313–328: hash-equality short-circuit → Loader → Chunker pipeline → ChunkID-equality dedup (`to_add` / `to_remove`) → only-new chunks embedded → stale chunks `markStale`'d → source hash advanced **last** for crash-safety. Result envelope: `IngestResult` ([`contracts.js:198`](../js/intelligence/retrieval/contracts.js)) carries `{status, content_hash, added, removed, embedded, embed_failures, error}` — three statuses (`noop` / `ingested` / `failed`). | Manager `indexProject` drives `walker.walk(sourceUris)` returning `WalkResult` (rolls up `IngestResult[]`). Manager `_ingestSingle(uri)` drives `controller.ingest(uri)` for one source on file-mutation events. |
| **Lifecycle axis** | What event-driven triggers cause ingest / re-ingest / drop / clear? | EventBus listeners at [`manager.js:1176–1264`](../js/intelligence/retrieval/manager.js) — 7 EventBus subscriptions: `project:loaded` (load-from-IDB-or-walk), `branch:switch` (delta-or-walk via `tryDeltaIndexFromBranch`), `git:branchDeleted` (drop IDB key), `branch:created` (`copyIndexForBranch`), `branches:refresh` (`cleanupOrphanedIndexes`), `context:prMerged` (`reindexChanged`), `git:fileCreated/Updated/Deleted/Renamed` (single-source `_ingestSingle` / `removeFileIndex`). | EventBus emit sites: `Git` (file mutations), `branch-manager.js` (branch lifecycle), `pr-tools.js` (PR merge), `app.js` boot (`project:loaded`). The kill-switch `State.settings.useEmbeddings === true` gates every listener via `isEnabled()` first. |
| **Persistence axis** | Where do chunks live across reloads? | In-memory: module-scoped `const store = createInMemoryChunkStore()` ([`manager.js:108`](../js/intelligence/retrieval/manager.js)) — single singleton; no per-test swap. IDB persistence: `Storage.set(storageKeyFor(_indexedProject), data)` ([`manager.js:306`](../js/intelligence/retrieval/manager.js)) per branch under `retrieval-chunks-<owner>/<repo>@<branch>` prefix. Snapshot shape: `{version: 1, project, timestamp, collection, chunks, sourceHashes, queryCount, lastQueried}`. Staleness check: max-age `State.settings.embeddingCacheExpiry || 7` days. | `loadIndexFromStorage` ([`manager.js:318`](../js/intelligence/retrieval/manager.js)) — restores chunks + source hashes + BM25 index. `removeIndexForBranch` / `copyIndexForBranch` / `cleanupOrphanedIndexes` mutate IDB keys with the prefix. |
| **Query axis** | How does `findRelevantFiles` produce results? | `findRelevantFiles(query, topK=5)` ([`manager.js:627`](../js/intelligence/retrieval/manager.js)): (1) query-cache short-circuit on `(normalized_query, topK)` under current `_indexFingerprint`; (2) lazy index build if corpus empty; (3) ledger lookup (`getOrCreateLedger`); (4) query embedding for cosine novelty scoring; (5) build paraphraser/expander from settings (mutually exclusive); (6) `compose(req, deps, opts)` (ICD #2); (7) `rollupToFiles(result, topK)` reduces chunks to legacy `{path, similarity, summary}` shape; (8) cache the result + emit `retrieval:turn-stats`. | `find_relevant_files` tool handler at [`js/llm/tool-handlers.js`](../js/llm/tool-handlers.js); the readiness gate (`getEligibleFileCount`) returns `indexer_not_ready` envelope when below threshold. |
| **Diagnostics axis** | What does the manager surface about its decisions? | `context:indexStart`, `context:indexProgress`, `context:indexComplete`, `context:indexError`, `context:indexCleared`, `context:fileRemoved`, `context:pauseChanged` — emitted on indexing-lifecycle transitions. `retrieval:turn-stats` — emitted on every `findRelevantFiles` call, carrying `{conversationId, strategyStats, cache_hit?}`. `getStats()` returns `{filesIndexed, project, isIndexing, enabled, queryCount, lastQueried, cache: {queryCacheHits, queryCacheMisses, queryCacheSize, indexFingerprint}}`. | `js/ui/index-status.js` (status indicator) consumes `context:index*`; `js/intelligence/cost/cost-recorder.js` consumes `retrieval:turn-stats` and attributes paraphrase/expansion tokens; LLM debug modal calls `getStats()` for the Indexer panel. |

Five axes × four mutation-trigger paths (full walk, single-source, delta-from-branch, branch-copy) × two storage tiers (in-memory + IDB) is the surface this ICD pins. The asymmetry (5 axes × 19 public methods on `RetrievalManager`) mirrors prior ICDs: each axis encodes a distinct *question*, but the methods carry their axis answers as records on the shared singleton rather than as separate exports per axis.

## Per-axis contract

### Ingest axis — the update protocol invariants

The `IngestController.ingest(source_uri)` pass is the load-bearing primitive; the walker is just bounded-parallel orchestration over N controller calls. Per DESIGN-retrieval lines 313–328, the controller obeys six invariants:

1. **Hash-equality short-circuit.** If `loader.load(uri).content_hash === store.getSourceHash(uri)`, return `{status: 'noop', added: 0, removed: 0, ...}` without dispatching the chunker / embedder / store. Source hash NOT advanced (would be redundant).
2. **ChunkID-equality dedup.** Within a single source, chunks with IDs already in the store are NOT re-embedded; only `to_add` (new IDs) get sent to `embedder.embed`. Stale chunks (IDs that disappeared) get `markStale`'d.
3. **Per-chunk embedder failures degrade, not abort.** `embedFn` returning `null` or throwing leaves `chunk.embedding = null`; the store accepts null-embedding chunks; `chunkVectorSearch` filters them at query time. The ingest still reports `status: 'ingested'`; `embed_failures` counts the degraded chunks.
4. **Loader / chunker failures abort the pass.** `status: 'failed'` returns; source hash NOT advanced; store untouched; next call retries from scratch.
5. **Source hash advances last.** Crash-safety invariant: if the embedder or store mutation crashes mid-pass, the source hash still reflects the previous version, so the next call re-attempts the full pass.
6. **Empty bytes are a valid pass.** `{added: 0, removed: N}` if the source previously had chunks. Not an error, not a no-op — the chunker pipeline returns `[]` (centralized at [`pipeline.js:119`](../js/intelligence/retrieval/pipeline.js)) and the dedup step computes `to_remove = stored_ids \ {}`.

### Lifecycle axis — the 7 event-driven transitions

Every transition is gated by `isEnabled()` (`State.settings.useEmbeddings === true`); turning the setting off makes the manager inert without unregistering listeners. The 7 EventBus subscriptions ([`manager.js:1176–1264`](../js/intelligence/retrieval/manager.js)):

| Event | Handler | Effect |
|---|---|---|
| `project:loaded` | Try `loadIndexFromStorage`; on miss + `autoReindex !== false`, debounce 1s then `indexProject()` | Cold-load IDB snapshot or trigger a full walk |
| `branch:switch` | `_setProject` → `loadIndexFromStorage` → `_tryDeltaIndexFromBranch(previousBranch, ...)` → fall back to full walk | Delta-index via `Git.getChangedFilesBetween` when the source branch's index is fresh and the diff is bounded |
| `git:branchDeleted` | `removeIndexForBranch(name)` | Drop IDB key for the deleted branch |
| `branch:created` | `copyIndexForBranch(sourceBranch, targetBranch)` | Re-tag chunks under the new collection (ChunkID stays stable) |
| `branches:refresh` | After 500ms, `resolveLiveBranches(payload, State.branches)` → `cleanupOrphanedIndexes` | Drop IDB keys for branches that no longer exist |
| `context:prMerged` | `removeIndexForBranch(deletedBranch)` + `reindexChanged(changedFiles)` if on current branch | Drop merged branch's index + re-ingest changed files on the target |
| `git:fileCreated` / `Updated` / `Deleted` / `Renamed` | `_ingestSingle(path)` or `removeFileIndex(path)` (renamed = both) | Per-file incremental ingest; BM25 rebuilds after each |

**The `_tryDeltaIndexFromBranch` decision tree** ([`manager-helpers.js`](../js/intelligence/retrieval/manager-helpers.js), [`manager.js:1003`](../js/intelligence/retrieval/manager.js)) is pure — wraps the deps (Storage / Git / clone / load / reindex) at the production call site. Returns `true` if a delta path succeeded (cloned + reindexed only the changed files); `false` if any prerequisite missed (no source index, diff too large, etc.) and the caller should fall back to full walk.

### Persistence axis — IDB key shape + staleness invariants

- **Key prefix:** `retrieval-chunks-` (constant [`manager.js:76`](../js/intelligence/retrieval/manager.js)). **Distinct from legacy `embeddings-index-` keys** — the cutover at 1.5.14 introduced a fresh key namespace so the legacy module's keys can be cleaned up independently.
- **Full key:** `${STORAGE_PREFIX}${owner}/${repo}@${branch}`. One snapshot per branch.
- **Snapshot shape:** `{version: 1, project, timestamp, collection, chunks: ChunkRef[], sourceHashes: Record<source_uri, content_hash>, queryCount, lastQueried}`. Version field reserved for future-shape migrations.
- **Staleness check:** `Date.now() - data.timestamp > (State.settings.embeddingCacheExpiry || 7) * 24h`. Stale snapshots return `false` from `loadIndexFromStorage` and trigger a full re-walk.
- **Best-effort writes.** `Storage.set` failures (quota exceeded) log via `console.warn` but don't throw. Per `feedback_storage_idb_authoritative`, IDB is authoritative; localStorage quota errors are non-fatal.
- **Orphan cleanup.** `cleanupOrphanedIndexes(liveBranches)` is the GC sweep — iterates `Storage.keys(STORAGE_PREFIX)`, drops keys for branches not in `liveBranches`. Fires on `branches:refresh` after a 500ms debounce.
- **Per-branch copy.** `copyIndexForBranch(source, target)` clones the snapshot, re-tags every chunk's `collection` to the target's projectKey, resets query stats. ChunkID stays stable (content-derived); only `collection` changes.

### Query axis — the 8-step `findRelevantFiles` pipeline

The single entry-point for query-time retrieval. Each step is a documented escape hatch:

1. **Kill-switch + input guard.** `!isEnabled() || empty query` → `[]`.
2. **Query-cache short-circuit (1.6.9).** LRU keyed by `(normalized_query, topK)`; cache value carries the fingerprint at write time, mismatch on read = miss. Empty results cached too (avoids re-walking a no-match corpus).
3. **Lazy index build.** Empty corpus → `await indexProject(false, false)`. Backstops the auto-walk-on-project-loaded path for cold starts.
4. **Ledger lookup.** `getOrCreateLedger(conversationId, CODER_V1.name, {capacity})` — per-conversation registry from `js/chat/task-state.js`.
5. **Query embedding.** `EmbeddingsClient.embed(query)` for cosine novelty scoring; failure degrades to Jaccard-only.
6. **Pre-pass build.** `buildParaphraserFromSettings` + `buildExpanderFromSettings` from `State.settings`. **Expander wins** when both are configured — the Composer ignores the paraphraser when an expander is wired (back-end-level mutual exclusion).
7. **`compose(req, deps, opts)`.** The Composer algorithm — covered by [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md). Outputs `RetrievalResult` with blocks + chunks + diagnostics.
8. **`rollupToFiles(result, topK)` + cache + emit.** Reduces ranked chunks to the legacy `{path, similarity, summary}` shape (compat layer for the `find_relevant_files` tool's pre-1.5.14 callers); writes cache entry; emits `retrieval:turn-stats`.

**The legacy result shape is load-bearing for the tool handler** — `find_relevant_files` returns `{path, similarity, summary}[]`, not `RetrievalResult` blocks. A future cleanup that wants to surface the richer shape to the LLM has to update the tool handler in parallel.

### Diagnostics axis — events + getStats shape

**Indexing-lifecycle events.** Emitted by manager-side mutations; consumed by UI status indicators:
- `context:indexStart` `{project, resuming}`
- `context:indexProgress` `{current, total, percent}`
- `context:indexComplete` `{project, filesIndexed, totalFiles, eligible, skipped}`
- `context:indexError` `{error}`
- `context:indexCleared` `{}`
- `context:fileRemoved` `{path}`
- `context:pauseChanged` `{paused, manual, auto, indexing, progress}`

**Per-query attribution event.** `retrieval:turn-stats` ([`manager.js:837`](../js/intelligence/retrieval/manager.js)) — single producer, single consumer ([`cost-recorder.js`](../js/intelligence/cost/cost-recorder.js)). Shape: `{conversationId, strategyStats: Object<name, {hits, tokens}>, cache_hit?: boolean}`. The `paraphrase` / `expansion` slot is mutually exclusive and present even on zero tokens (cache hit) so the dashboard reflects that the pre-pass was active for the turn.

**`getStats()` shape.** Synchronous, pure-read getter consumed by the LLM Debug Indexer panel: `{filesIndexed, project, isIndexing, enabled, queryCount, lastQueried, cache: {queryCacheHits, queryCacheMisses, queryCacheSize, indexFingerprint}}`. Field set additive — new diagnostic fields land here; never remove a key.

## Interaction matrix

### Shared contract (load-bearing, do not split)

- **`RetrievalManager` is a singleton with module-scoped state.** The `store`, strategy bundle, fingerprint, query cache, paraphrase/expander IDB caches, indexing flags, project key, pause state — all module-scoped `let`/`const`. The `_resetForTesting` seam is the only swap; node tests that import the manager get the same singleton across `describe` blocks unless they call it.
- **`isEnabled()` gates every public method.** Turning `useEmbeddings` off makes the manager inert without unregistering listeners. Listeners still fire; they short-circuit on the gate.
- **The chunker pipeline is content-type-dispatched.** Loader's `content_type_hint` flows through `runChunkerPipeline` → chunker → `extractStructure` post-pass. **`'spec'` rejects.** Adding a new content type means: (a) add a chunker, (b) register in [`pipeline.js:78`](../js/intelligence/retrieval/pipeline.js) `CHUNKER_BY_CONTENT_TYPE`, (c) bump `CHUNKER_VERSION` in `contracts.js`.
- **ChunkID stays stable across chunker upgrades.** Hash of `(collection, source_uri, normalized_byte_range, chunker_version)`. Bumping the version invalidates IDs deliberately so old + new chunks can coexist during migration.
- **`retrieval-chunks-` IDB prefix is distinct from `embeddings-index-`.** Legacy `js/context-manager.js` keys are not touched by this module. Two key namespaces coexisted through the 1.5.0 → 1.5.14 cutover; the legacy ones are inert now.

### Disjoint surfaces

- **The Composer is pure; the Manager is not.** [`composer.js`](../js/intelligence/retrieval/composer.js) has no `State`, no DOM, no EventBus reads — pure `(req, deps, opts) → RetrievalResult`. The Manager wires `State.settings`, `EventBus.emit`, `Storage.get/set`, `Git.getFile`, `EmbeddingsClient.embed` into the deps tuple. This is why ICD #2 cleaves at `compose()` — the algorithm is testable in node; the lifecycle is not.
- **Pure-DI ingest factories are testable in node.** `createLoader`, `createEmbedder`, `createInMemoryChunkStore`, `createIngestController`, `createIngestWalker` — all take their I/O deps as parameters. The wiring layer (`createProductionIngestWalker`) is the production-only seam.
- **The measurement harness never wires into production.** `createMeasurementHarness` + `createComparisonHarness` + `QUERY_FIXTURES` are driven by [`tests/retrieval-measurement.html`](../tests/retrieval-measurement.html). Deleting the runner would not affect `find_relevant_files`. The track's §1.5.0 exit gate (`mean recall@5 ≥ 0.80`) is a measurement, not a runtime check.

### Open invariants (not asserted today)

- **No test pins the manager's public surface shape.** `Object.keys(RetrievalManager).sort()` could regress (a renamed method, a silently dropped getter) and only the production call sites would surface. ICD #4 cited the same gap for `BASE_GIT_PROVIDER`; same shape applies here.
- **No test pins the `context:*` event names against listener registration.** A renamed emit site without a matching listener rename would silently break the status indicator + cost recorder.
- **No test asserts the `retrieval:turn-stats` payload shape.** The cost-recorder reads `strategyStats` keys; a producer-side rename would silently lose attribution.
- ~~**The `@ts-ignore` count signals typedef drift.** 12 `@ts-ignore` annotations across [`manager.js`](../js/intelligence/retrieval/manager.js) cluster on `store.*` calls — the store's typedef declares fewer methods than the store object actually exports. See code-aware finding #2.~~ ✅ **resolved 2.59.0** — `ChunkStore` typedef widened with one `@property` for `getAllChunksForCollection`; all 12 `@ts-ignore` annotations removed; new [`tests/test-chunk-store-shape.mjs`](../tests/test-chunk-store-shape.mjs) pins the typedef-vs-runtime contract.

## Code-aware findings (feed back to ROADMAP as 2.53.0+ rows)

Authoring this ICD surfaced **three** drift items worth tracking. Per re-eval methodology, one is suggested for the next code minor's `[strong]` row; the others stay queued.

### ~~1. `CODER_V1.task_ledger.capacity` direct read survived the 1.20.0 retrieval-config rewire~~ ✅ shipped 2.53.0

✅ **Resolved at 2.53.0** (commit `0d96117`). `resolveTaskLedgerConfig(profileName)` added to [`js/profiles/resolve.js`](../js/profiles/resolve.js); [`manager.js`](../js/intelligence/retrieval/manager.js) `findRelevantFiles` call site now reads through the resolver (lines 670–679); direct `CODER_V1` import dropped. Historical record preserved below.

[`manager.js:678`](../js/intelligence/retrieval/manager.js) reads `CODER_V1.task_ledger.capacity` directly:

```javascript
const ledger = getOrCreateLedger(conversationId, CODER_V1.name, {
    capacity: (CODER_V1.task_ledger && CODER_V1.task_ledger.capacity) || 500,
});
```

The neighboring line ([`manager.js:744`](../js/intelligence/retrieval/manager.js)) reads `novelty_threshold` through `resolveRetrievalConfig` — the 1.20.0 retrieval rewire cleared `novelty_threshold` but explicitly left `task_ledger.capacity` as the "surviving direct-import use of `CODER_V1`" (per the inline docstring at lines 672–675). The comment names this as out-of-scope for the retrieval rewire because `task_ledger` is its own profile section.

**Suggested fix shape for next code minor:** Add `resolveTaskLedgerConfig(profileName)` to [`js/profiles/resolve.js`](../js/profiles/resolve.js), mirroring `resolveRetrievalConfig`. Single-file edit + a node test pinning the resolver's shape; drop the direct `CODER_V1` import. Matches the 1.20.0 fix pattern one-for-one.

**Why this matters:** The §Decision 7 Removability check requires every subsystem read to go through a resolver so the call site can be retargeted at a different profile without source surgery. The direct read prevents `chat_multi.v1` or `kb.v1` from ever calling `find_relevant_files` with a different ledger capacity (today both fall through to the CODER_V1 hardcode). Memory `feedback_chat_multi_rp_no_utility_in_aieditor` says those profiles don't ship for ai-editor; the drift is still real for future plugin profiles.

### ~~2. Twelve `@ts-ignore` annotations cluster on store method calls~~ ✅ shipped 2.59.0

✅ **Resolved at 2.59.0.** Authoring this finding mis-counted the gap as four un-typed methods (`getAllChunksForCollection`, `stats`, `chunkVectorSearch`, `chunkIdsForSource`); the actual gap was **one** — `getAllChunksForCollection`, missing from the typedef since the method's 1.5.10 addition. `stats`, `chunkVectorSearch`, and `chunkIdsForSource` were already declared. The 12 `@ts-ignore` annotations broke down as 11 wrapping `getAllChunksForCollection(...)` call sites (now typed) + 1 stale suppression on an already-typed `store.stats().sources` read (the sibling reader at [`manager.js:1091`](../js/intelligence/retrieval/manager.js) typechecked the same expression without an ignore — proof the suppression was redundant). Fix: one `@property` line added to the typedef; all 12 ignores removed; new [`tests/test-chunk-store-shape.mjs`](../tests/test-chunk-store-shape.mjs) pins the typedef-vs-runtime contract (4 subtests).

Historical record preserved below.

`grep -c '@ts-ignore' js/intelligence/retrieval/manager.js` returns **12**. All cluster on `store.getAllChunksForCollection(...)` / `store.stats()` / `store.chunkVectorSearch` calls. The store object exports these methods at runtime but the [`store.js`](../js/intelligence/retrieval/store.js) typedef (or the `ChunkStore` interface in [`store.js`](../js/intelligence/retrieval/store.js)) declares a narrower surface. The result is that the manager has type-safety holes on every store interaction.

**Suggested fix shape (queued, not promoted):** Widen the `ChunkStore` typedef to include the four currently-`@ts-ignore`'d methods (`getAllChunksForCollection`, `stats`, `chunkVectorSearch`, `chunkIdsForSource`). Sympathy with existing tests: the store's behavior tests pass; only the type surface is narrower than reality. Same shape as the 2.46.0 retrieval-Composer docstring fix — single-file edit, no behavior change.

**Why this is queued, not promoted:** The fix is mechanical but touches a typedef that downstream typedefs reference; needs a careful one-pass sweep to land in a single PR. Worth doing during the next time someone touches the store seam; not worth queue-jumping the next code minor.

### 3. `retrieval:turn-stats` event has no shape-pinning test

Single producer ([`manager.js:837`](../js/intelligence/retrieval/manager.js)); single consumer ([`cost-recorder.js`](../js/intelligence/cost/cost-recorder.js)). The cost recorder reads `payload.strategyStats.*` keys but no test asserts the producer-consumer contract. A future rename on either side would silently lose paraphrase/expansion attribution; the cost dashboard would keep displaying numbers, but with a stale schema.

**Suggested fix shape (queued, not promoted):** Mirror the [`tests/test-provider-capabilities-shape.mjs`](../tests/test-provider-capabilities-shape.mjs) idiom from ICD #4 — a pinning test that exercises `findRelevantFiles` under a mock EventBus, captures the emitted payload, and asserts the expected key set. Same idiom catches all four `context:index*` events too if widened.

**Why this is queued, not promoted:** Browser-DOM-coupled. Manager imports `core.js` which assumes `window`; node-test plumbing requires a JSDOM fake or a manager-side seam injection that doesn't exist today. Worth queuing for the same slot that lands code-aware finding #1 (resolver pattern).

### Other observations (not promoted)

- **`_buildStrategies` is lazy-singleton.** Built once per manager lifetime; never rebuilt. A future setting change that should affect strategy selection (e.g. disabling thematic) requires `_resetForTesting`. Not drift; documented limitation. The `clearMemo` hook on each strategy provides a partial reset for fingerprint-bump cases ([`manager.js:160–167`](../js/intelligence/retrieval/manager.js)).
- **`MAX_INDEX_SIZE = 250_000` bytes** at [`manager.js:63`](../js/intelligence/retrieval/manager.js) is the hard size cap before `IgnoreManager.isIgnored` runs. Not a setting; not exposed. Documented as a stability fence; raising it would risk indexing minified JS bundles.
- **`DEFAULT_CONCURRENCY = 4`** at [`manager.js:73`](../js/intelligence/retrieval/manager.js) is the walker concurrency. Not a setting; not exposed. Empirically chosen during 1.5.0 — should expose if a real workload presses it.
- **The `_ingestSingle` re-constructs the production walker on every file mutation.** Each call to `_ingestSingle` calls `createProductionIngestWalker(...)` again, which re-awaits `EmbeddingsClient.init()`. The init is idempotent and cached, so the cost is negligible — but the pattern is wasteful. Documented as a micro-optimization opportunity, not drift.
- **The legacy `{path, similarity, summary}` shape from `rollupToFiles`** is the tool-handler-visible compatibility layer. A future cleanup that wants to surface ranked chunks (with byte ranges, score kinds, structural meta) to the LLM has to update [`js/llm/tool-handlers.js`](../js/llm/tool-handlers.js) in parallel. Out of scope here; flagged so it surfaces if the model starts asking for chunk-level surfacing.

## Why the surface resists consolidation

A natural-looking refactor is "split manager.js by axis — lifecycle.js, persistence.js, query.js, diagnostics.js." That has been considered and deferred for three reasons:

1. **The module-scoped state binds the axes.** `_collection`, `_indexedProject`, `_indexFingerprint`, `_queryCache`, `_strategies`, `_bm25Index`, `_indexing`, `_indexProgress`, `_manualPause`, `_autoPause`, `_abortController`, `_resumeRemaining` — these all participate in multiple axes. Splitting would either require lifting state to a passed-around context object (intrusive) or doing inter-module getters/setters (more coupling, not less).
2. **The pure-DI factories already split.** [`loader.js`](../js/intelligence/retrieval/loader.js), [`embedder.js`](../js/intelligence/retrieval/embedder.js), [`store.js`](../js/intelligence/retrieval/store.js), [`ingest-controller.js`](../js/intelligence/retrieval/ingest-controller.js), [`walker.js`](../js/intelligence/retrieval/walker.js), [`pipeline.js`](../js/intelligence/retrieval/pipeline.js), [`composer.js`](../js/intelligence/retrieval/composer.js), [`router.js`](../js/intelligence/retrieval/router.js), [`ledger-consumer.js`](../js/intelligence/retrieval/ledger-consumer.js) are already separate files. The Manager is the *production wrapper* that wires them together; splitting the wrapper would not improve test coverage.
3. **The 7 event listeners need to live next to the singleton state they read.** A `lifecycle.js` split would either need to import-and-mutate manager state (bad) or share state via a third module (worse).

The split remains a future option if a clear axis-split refactor with measured pre/post test-coverage gain materializes; today, 1264 LOC × 1 file is below the cognitive-load threshold (the 5 axes have explicit section comments at lines 58 / 103 / 222 / 272 / 358 / 381 / 556 / 610 / 875 / 1027 / 1068 / 1115 / 1172).

## Forward-evolution rules

### When adding a new ingest source type (e.g. memory:// URIs, MCP-served content)

1. **Add a Loader for the URI scheme.** `createLoader({fetchBytes, contentTypeOverride})` — `fetchBytes(uri)` returns the bytes; `contentTypeOverride(uri)` resolves URIs without an extension to a `ContentType` before extension-based detection runs. Production-wired via `createProductionLoader` in [`wiring.js`](../js/intelligence/retrieval/wiring.js).
2. **Make sure the chunker pipeline has a matching content type.** If you're adding `'audio'` or `'pdf'`, add the chunker + register in [`pipeline.js:78`](../js/intelligence/retrieval/pipeline.js) `CHUNKER_BY_CONTENT_TYPE` + bump `CHUNKER_VERSION` in [`contracts.js`](../js/intelligence/retrieval/contracts.js).
3. **Wire the new loader at the manager level.** Either replace `createProductionLoader` with a dispatching loader, or layer a chained loader on top. The Manager-side wiring path is `createProductionIngestWalker` → `createProductionLoader` → `createLoader`.
4. **Decide the collection-key strategy.** If the new source isn't branch-scoped, the `projectKeyFor(owner, repo, branch)` shape won't fit; consider a separate `STORAGE_PREFIX` namespace.
5. **Update this ICD's Ingest axis section.** New invariants land here.

### When adding a new strategy

1. **Implement the `Strategy` interface** from [`contracts.js`](../js/intelligence/retrieval/contracts.js) — `{name, applies_to(req), retrieve(req, quota)}`. `name` is a free-form string; `applies_to` returns `{score: 0..1, reason}`; `retrieve` returns `Promise<ChunkRef[]>`.
2. **Add to `_buildStrategies` in [`manager.js`](../js/intelligence/retrieval/manager.js).** The Composer's router picks strategies by applicability + viability threshold; adding a strategy doesn't require Composer changes.
3. **Document the strategy's diagnostics shape.** `Diagnostics.chunks_returned_per_strategy[name]` will populate automatically; if your strategy has internal counters (cache hits, fallback counts), surface them as `Diagnostics.warnings` rather than per-strategy slots.
4. **Add the strategy to the test corpus.** [`tests/retrieval-measurement.html`](../tests/retrieval-measurement.html) drives `QUERY_FIXTURES`; adding a strategy means re-baselining recall@5.

### When adding a new lifecycle event

1. **Emit, don't import.** EventBus is the seam; direct method calls into `RetrievalManager` from the emitter would couple the producer to the manager singleton.
2. **Gate on `isEnabled()` in the listener.** Every existing listener does; the kill-switch is the user-visible invariant.
3. **Document the event name in this ICD's Lifecycle axis table.** Skipping this is the drift the program is designed to surface.

### When adding a new diagnostic field

1. **Add to `getStats()` output if it's a sync getter shape.** Never remove existing keys; additive only.
2. **Add to `retrieval:turn-stats` payload if it's per-query.** Strategy-shaped fields go under `strategyStats[name].{hits, tokens, ...}`; turn-shaped fields go at the top level alongside `cache_hit`.
3. **Update this ICD's Diagnostics axis section.**

## References

- **Source — production singleton:** [`js/intelligence/retrieval/manager.js`](../js/intelligence/retrieval/manager.js) (1264 LOC; 19 public methods + `_resetForTesting`; module-scoped state for 12 invariants); [`manager-helpers.js`](../js/intelligence/retrieval/manager-helpers.js) (pure helpers used by the manager — `rollupToFiles`, `projectKeyFromString`, `resolveLiveBranches`, `tryDeltaIndexFromBranch`).
- **Source — pure-DI ingest pipeline:** [`loader.js`](../js/intelligence/retrieval/loader.js), [`pipeline.js`](../js/intelligence/retrieval/pipeline.js), [`embedder.js`](../js/intelligence/retrieval/embedder.js), [`store.js`](../js/intelligence/retrieval/store.js), [`ingest-controller.js`](../js/intelligence/retrieval/ingest-controller.js), [`walker.js`](../js/intelligence/retrieval/walker.js), [`bm25-indexer.js`](../js/intelligence/retrieval/bm25-indexer.js), [`structure-extractor.js`](../js/intelligence/retrieval/structure-extractor.js), [`chunkers/*.js`](../js/intelligence/retrieval/chunkers/).
- **Source — production wiring:** [`wiring.js`](../js/intelligence/retrieval/wiring.js) (`createProductionLoader` + `createProductionEmbedder` + `createProductionIngestWalker` — the DI bridge from pure factories to `Git` + `EmbeddingsClient`).
- **Source — strategies:** [`strategies/semantic.js`](../js/intelligence/retrieval/strategies/semantic.js), [`strategies/structural.js`](../js/intelligence/retrieval/strategies/structural.js), [`strategies/thematic.js`](../js/intelligence/retrieval/strategies/thematic.js).
- **Source — query expansion:** [`query-paraphraser.js`](../js/intelligence/retrieval/query-paraphraser.js), [`query-expander.js`](../js/intelligence/retrieval/query-expander.js), `paraphrase-cache-idb.js`, `expander-cache-idb.js`.
- **Source — measurement:** [`measurement.js`](../js/intelligence/retrieval/measurement.js), [`comparison.js`](../js/intelligence/retrieval/comparison.js), [`test-corpus.js`](../js/intelligence/retrieval/test-corpus.js); browser runner at [`tests/retrieval-measurement.html`](../tests/retrieval-measurement.html).
- **Source — contracts:** [`contracts.js`](../js/intelligence/retrieval/contracts.js) (~720 LOC of JSDoc typedefs — `Chunk`, `ChunkRef`, `Metadata`, `RetrievalRequest`, `RetrievalResult`, `Diagnostics`, `IngestResult`, `WalkResult`, `ProductionIngestWalkerOptions`, `Strategy`, etc.).
- **Production consumers:** [`js/llm/tool-handlers.js`](../js/llm/tool-handlers.js) (`find_relevant_files` tool — primary consumer); [`js/intelligence/cost/cost-recorder.js`](../js/intelligence/cost/cost-recorder.js) (`retrieval:turn-stats` consumer); [`js/ui/index-status.js`](../js/ui/index-status.js) (status indicator); Settings → Storage tab (per-branch index list); LLM Debug Indexer panel.
- **Design contracts:** [`docs/DESIGN-retrieval.md`](DESIGN-retrieval.md) (the long-form spec — chunker dispatch, ingest update protocol lines 313–328, observability §"Diagnostics" lines 569+, composition algorithm). [`docs/DESIGN-profiles.md`](DESIGN-profiles.md) (task ledger contract; `novelty_threshold` resolver pattern).
- **Cross-ICD:** [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md) (the `compose()` algorithm — what this ICD's Query axis hands off to). [`ICD-tool-registry.md`](ICD-tool-registry.md) §"Per-export contract" (how `find_relevant_files` tool admission threads `RetrievalManager` calls into the LLM-visible envelope). [`ICD-git-providers.md`](ICD-git-providers.md) §"Functional defaults" (the `getChangedFilesBetween` functional default that `_tryDeltaIndexFromBranch` consumes).
- **Tests:** Node — `tests/test-retrieval-*.mjs` (pure-factory coverage: chunkers, controller, walker, composer, strategies, ingest invariants); `tests/test-manager-helpers.mjs` (pure helpers used by the manager). Browser — `tests/retrieval-measurement.html` drives `QUERY_FIXTURES` for recall@5 baselines per `project_retrieval_agreement_baseline.md`. **None pin the manager's public surface or event shapes** (see §"Open invariants").
- **Methodology:** [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #5; remaining candidates for the next slot: editor instance, MCP bridge, plugin lifecycle — profiles registry deferred per `project_profile_admission_paper`).
- **History anchors:** 1.4.9 (contracts.js foundation); 1.4.17 (`compose()` + Composer algorithm); 1.4.18 (ledger consumer step 6.5); 1.4.19 (`runChunkerPipeline`); 1.4.20 (`createInMemoryChunkStore`); 1.4.23 (`createIngestController`); 1.5.0 (`createIngestWalker` + Phase 1 production wiring); 1.5.7 (T3 final = 0.5489 recall@5 baseline per `project_retrieval_agreement_baseline.md` — §1.5.0 gate cleared at 1.5.7); 1.5.11 (BM25 indexer); 1.5.12 (paraphrase pre-pass); 1.5.14 (legacy `js/context-manager.js` retired — cutover); 1.6.8 (`retrieval:turn-stats` event); 1.6.9 (query cache + fingerprint); 1.7.0 (AST code chunker Phase 1); 1.8.1 (cross-file query expansion lever B); 1.15.0 (Task Ledger Phase 1 — ledger wiring on); 1.20.0 (`resolveRetrievalConfig` rewire); 2.2.0 (retrieval ingest delta-indexing); 2.4.0 (`orderByLanguageStats` + token cap).
