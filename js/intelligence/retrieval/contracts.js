// @ts-check
/**
 * Retrieval contracts — the typedef surface for the chunk-admission and
 * composition subsystem. Phase 1 (1.5.0) implements semantic + structural
 * strategies, the ingest pipeline, and the Composer; this file is the
 * 1.4.9 foundation: data contracts only. No retrieval logic, no ingest
 * code, no model-visible change.
 *
 * Why a foundation patch first: underspecification at this seam is how
 * retrieval libraries decay into "everyone passes dicts around"
 * (`docs/DESIGN-retrieval.md` §"Core Contracts"). Pinning the shapes
 * before the chunkers and strategies arrive lets each subsequent PR be a
 * thin consumer of an agreed contract.
 *
 * Sources:
 *   - `docs/DESIGN-retrieval.md` §"Core Contracts" (lines 125-241)
 *   - `docs/DESIGN-retrieval.md` §"Chunk Identity and Stability"
 *   - `docs/DESIGN-retrieval.md` §"Composition Algorithm"
 *   - `docs/DESIGN-retrieval.md` §"Observability"
 *   - `docs/ROADMAP.md` §1.5.0 Retrieval Phase 1
 *
 * Why JSDoc and not real TS: project constraint
 * (`docs/ARCHITECTURE.md` §"Design Constraints") — no build step, no
 * transpiler. Type safety comes via `jsconfig.json` `checkJs: true`.
 *
 * @module intelligence/retrieval/contracts
 */

/**
 * Stable identifier for a chunk. Hash of
 * `(collection || source_uri || normalized_byte_range || chunker_version)`
 * per DESIGN-retrieval §"Chunk Identity and Stability". Re-running ingest
 * over unchanged source produces identical IDs; bumping a chunker version
 * produces fresh IDs so old + new chunks coexist during migrations
 * without ID collisions.
 *
 * Computation lives in `chunk-id.js` (`computeChunkID`).
 *
 * **Reserved id namespaces.** The ledger consumer (1.4.18) synthesizes
 * surrogate `ChunkID`s with the prefix `ledger_marker:<original_id>:<turn_id>`
 * for low-novelty re-admission markers. Downstream consumers that walk
 * `chunks_by_id` should treat any id starting with `ledger_marker:` as a
 * marker (the substring after `ledger_marker:` up to the next `:` is the
 * suppressed chunk's original id).
 *
 * @typedef {string} ChunkID
 */

/**
 * Logical name of a content collection — e.g. `"workspace_code"`,
 * `"api_docs"`, `"chat_history"`. Collections partition the chunk store
 * and gate cross-corpus queries.
 *
 * @typedef {string} CollectionName
 */

/**
 * Chunk content type. Drives chunker selection at ingest and metadata
 * filtering at retrieval. Per DESIGN-retrieval §"Chunker" table.
 *
 * @typedef {"prose"|"code"|"conversation"|"structured"|"spec"} ContentType
 */

/**
 * Strategy kind that produced a `Provenance` record. Open-ended on
 * purpose: `Strategy.name` is a string, and downstream tooling treats
 * unknown values as opaque rather than failing.
 *
 * @typedef {"semantic"|"structural"|"thematic"|"pinned"|string} StrategyName
 */

/**
 * Score interpretation for a `Provenance.score`. Scores from different
 * strategies are not comparable — labeling forces consumers to keep them
 * separate rather than averaging cosine with BM25.
 *
 * @typedef {"cosine"|"bm25"|"hybrid"|"structural_expanded"|"cluster_distance"} ScoreKind
 */

/**
 * Position hint for an emitted `ContextBlock`. The Composer orders blocks
 * for attention — task instructions tail, system framing head, retrieved
 * + history in body.
 *
 * @typedef {"head"|"body"|"tail"} BlockPosition
 */

/**
 * Block role used by the consuming caller to decide how to render it
 * into the final prompt. `system_context` and `task` are caller-provided
 * framing; `retrieved` and `history` are produced by the Composer.
 *
 * @typedef {"system_context"|"retrieved"|"history"|"task"} BlockRole
 */

/**
 * Fixed-size float vector. Stored alongside a chunk only when a
 * downstream stage needs it (see `ChunkRef.embedding`).
 *
 * @typedef {number[]} EmbeddingVector
 */

/**
 * Per-chunk structural metadata, populated by `StructureExtractor` at
 * ingest only for content types with meaningful hierarchy (specs, prose,
 * code). Absent for free-form text where ancestor-walk has nothing to
 * walk.
 *
 * The "tree" is not stored separately — it is the transitive closure of
 * `parent_id` across chunks. See DESIGN-retrieval §"StructureExtractor".
 *
 * @typedef {Object} StructuralMeta
 * @property {string[]}       heading_path  e.g. ["API Reference", "Auth", "OAuth2"].
 * @property {string}         node_kind     "section" | "function" | "type" | "test" | "record" | ...
 * @property {ChunkID|null}   parent_id     Null at root.
 * @property {number}         sibling_order Zero-based index among same-parent siblings.
 */

/**
 * Loader-supplied metadata that travels with the chunk through the
 * pipeline. `custom` is the documented extension seam for surface-
 * specific fields (speaker_id, persona_id, tool_result_for, file_ops…)
 * — chunkers preserve it without interpretation; strategies that don't
 * care ignore it.
 *
 * @typedef {Object} Metadata
 * @property {string}              source_uri    Canonical source identifier (URI form).
 * @property {ContentType}         content_type
 * @property {number}              created_at    Epoch milliseconds (source create time).
 * @property {number}              updated_at    Epoch milliseconds (last source edit).
 * @property {string}              content_hash  Hash of the *source region* this chunk covers — survives chunker upgrades.
 * @property {StructuralMeta|null} structural    Null when content is unstructured.
 * @property {Object<string, *>}   custom        Opaque to retrieval; preserved verbatim.
 */

/**
 * Where a returned chunk came from and how it was scored. `score_kind` is
 * required to keep different scales from being silently averaged.
 *
 * @typedef {Object} Provenance
 * @property {string}                source_uri   Echo of `Metadata.source_uri` for citation.
 * @property {[number, number]|null} byte_range   Half-open [start, end) over the source bytes; null if loader didn't provide it.
 * @property {[number, number]|null} line_range   1-based inclusive lines; null if loader didn't provide it.
 * @property {StrategyName}          retrieved_by Strategy that returned the chunk.
 * @property {number}                score        Strategy-defined; not comparable across strategies.
 * @property {ScoreKind}             score_kind   How to read `score`.
 */

/**
 * The atomic unit retrieval admits to context. Every chunk produced by
 * ingest is addressable via its stable `id`.
 *
 * `tokens` is precomputed at ingest because the Composer does budget
 * math on every call; retokenizing on the hot path is wasteful. If
 * multi-tokenizer support arrives later this becomes a map keyed by
 * tokenizer family.
 *
 * `embedding` is null in transit through retrieval — it lives in the
 * chunk store. Strategies that need it during composition (e.g. novelty
 * scoring) hydrate it from there.
 *
 * @typedef {Object} ChunkRef
 * @property {ChunkID}                id
 * @property {CollectionName}         collection
 * @property {string}                 content
 * @property {number}                 tokens
 * @property {Metadata}               metadata
 * @property {Provenance}             provenance
 * @property {EmbeddingVector|null}   embedding
 */

/**
 * Chunker output — a `ChunkRef` minus the fields populated downstream of the
 * chunker. `provenance` is set by the ingest layer (a chunker has no business
 * knowing how a retrieval *will* score it); `embedding` is set by the embedder.
 *
 * `byte_range` rides on the chunk so the ingest layer can thread the
 * chunker's chosen identity range into `Provenance` without recomputing it,
 * and so chunker tests can verify adjacency directly. Reported in UTF-8
 * bytes — the cross-loader interchange unit per DESIGN-retrieval.
 *
 * The chunker is a pure `(input) → Chunk[]` function with no awareness of
 * strategies, scoring, or the embedder. See DESIGN-retrieval §"Chunker":
 * "Each chunker is pure: `(bytes, metadata) → []Chunk`."
 *
 * @typedef {Object} Chunk
 * @property {ChunkID}          id
 * @property {CollectionName}   collection
 * @property {string}           content      With chunker-specific overlap when applicable.
 * @property {number}           tokens       Precomputed estimate; the Composer trusts this.
 * @property {Metadata}         metadata
 * @property {[number, number]} byte_range   Half-open `[start, end)` UTF-8 byte range; the chunker's identity range.
 */

/**
 * What a chunker receives. Bytes from the loader plus enough framing for the
 * chunker to compute stable IDs. The chunker does not own `Metadata` — it
 * receives a partial view and returns chunks that fill it in (specifically
 * `content_hash` per chunked region, plus `structural` when a
 * StructureExtractor is wired in for that content type).
 *
 * @typedef {Object} ChunkerInput
 * @property {string}         bytes       Source content; chunker treats as opaque text.
 * @property {CollectionName} collection  Logical collection the resulting chunks join.
 * @property {Object}         metadata    Loader-supplied metadata seed.
 * @property {string}         metadata.source_uri
 * @property {ContentType}    metadata.content_type
 * @property {number}         metadata.created_at
 * @property {number}         metadata.updated_at
 * @property {Object<string, *>|undefined} metadata.custom
 */

/**
 * Pure chunker function. `(input) → Chunk[]` per DESIGN-retrieval §"Chunker".
 * No I/O, no async — chunkers run inline on loader output.
 *
 * Chunkers are content-type-dispatched at the call site (the ingest pipeline
 * picks `chunkProse` / `chunkCode` / etc. by `metadata.content_type`).
 *
 * @typedef {(input: ChunkerInput) => Chunk[]} Chunker
 */

/**
 * Per-call budget envelope. Per DESIGN-retrieval §"RetrievalRequest":
 *   retrieval_budget = total - system_reserve - output_reserve - history_reserve.
 *
 * @typedef {Object} Budget
 * @property {number} total_tokens    Ceiling for the full composed prompt.
 * @property {number} system_reserve  Caller's system-prompt ceiling.
 * @property {number} output_reserve  Generation max_tokens.
 * @property {number} history_reserve History verbatim ceiling.
 */

/**
 * Caller-supplied filter over `Metadata`. The shape is intentionally
 * opaque at this seam — strategies interpret it; the Composer passes it
 * through. Concrete fields will be pinned when the first filter consumer
 * lands.
 *
 * @typedef {Object} MetadataFilter
 * @property {ContentType[]|undefined} content_types  Accept-list; absent = all.
 * @property {Object<string, *>|undefined} custom     Strategy-specific predicates.
 */

/**
 * Caller hint that forces or disqualifies a strategy. Opaque at this
 * seam; concrete fields will be pinned by the router consumer.
 *
 * @typedef {Object} StrategyHint
 * @property {StrategyName} strategy
 * @property {"force"|"prefer"|"forbid"} mode
 * @property {string|undefined} reason  Free-form, surfaces in diagnostics.
 */

/**
 * Recent conversation turn passed in by the caller. Already compressed
 * by the compression subsystem (history compression is *not* retrieval's
 * job — see DESIGN-retrieval §"What the problem is not"). The Composer
 * only packages it and verifies fit against `Budget.history_reserve`.
 *
 * @typedef {Object} HistoryTurn
 * @property {string} role     e.g. "user" | "assistant" | "tool" | "system".
 * @property {string} content
 * @property {Object<string, *>|undefined} metadata  Compressor-supplied fields (tool_result_for, file_ops, …).
 */

/**
 * Forward declaration. The concrete TaskLedger lives in
 * `js/profiles/task-ledger.js`; retrieval is the second consumer (after
 * tools, 1.4.0). Imported by typedef-name only to avoid coupling.
 *
 * @typedef {import("../../profiles/task-ledger.js").TaskLedger} TaskLedger
 */

/**
 * What callers pass to the Composer. `query` is optional because thematic
 * retrieval ("summarize this corpus") runs query-free.
 *
 * @typedef {Object} RetrievalRequest
 * @property {string}                 task            User-facing task — feeds the router.
 * @property {string|null}            query           Required for semantic; null OK for thematic.
 * @property {CollectionName[]}       collections     Logical indices to search.
 * @property {Budget}                 budget
 * @property {HistoryTurn[]|null}     history         Pre-compressed by the compression subsystem.
 * @property {MetadataFilter|null}    filters
 * @property {StrategyHint[]|null}    strategy_hints
 * @property {ChunkID[]|null}         priority_pins   Caller-supplied must-includes.
 * @property {TaskLedger|null}        task_ledger     Per-task admission record; see DESIGN-profiles.md.
 * @property {string|null|undefined} [turn_id]        Optional turn identifier; used by the ledger consumer (1.4.18) when stamping `AdmissionRecord.turn_id` / `ExclusionRecord.turn_id`. The Composer also accepts `opts.turnId` as an override; if both are absent and a `task_ledger` is supplied, the consumer synthesizes one and emits a `LEDGER_TURN_SYNTHESIZED` info-warning.
 */

/**
 * One block in the composed result. Callers concatenate by `position`
 * order, keeping control over the final prompt format while the library
 * owns attention-ordering decisions.
 *
 * @typedef {Object} ContextBlock
 * @property {BlockRole}     role
 * @property {string}        content
 * @property {ChunkID[]}     chunks    Empty for synthesized blocks (e.g. compression markers).
 * @property {BlockPosition} position
 */

/**
 * Per-call diagnostics. Populated on every result — cheap to fill,
 * indispensable in production. Field set per DESIGN-retrieval
 * §"Observability" line 569+.
 *
 * @typedef {Object} Diagnostics
 * @property {StrategyName[]}                  strategies_used
 * @property {Object<StrategyName, string>}    strategies_skipped         Reason per skipped strategy.
 * @property {Object<StrategyName, number>}    chunks_returned_per_strategy
 * @property {number}                          tokens_used
 * @property {number}                          tokens_budget
 * @property {number}                          tokens_truncated           From chunk-overflow truncation, not history compression.
 * @property {boolean}                         ledger_consulted
 * @property {number}                          ledger_suppressions        Count of low-novelty re-admissions suppressed.
 * @property {Object<StrategyName, number>}    latency_per_strategy_ms
 * @property {Object<string, number>}          cache_hits                 Per cache name.
 * @property {StrategyName[]}                  degraded_strategies        Ran but in degraded mode.
 * @property {Array<{level:string, code:string, detail:string}>} warnings
 * @property {Object<ContentType, string>}     chunker_versions           For reproducibility.
 */

/**
 * What callers get back. Structured blocks, not a flat string —
 * the caller emits in `position` order.
 *
 * @typedef {Object} RetrievalResult
 * @property {ContextBlock[]}              blocks
 * @property {number}                      used_tokens
 * @property {Object<ChunkID, ChunkRef>}   chunks_by_id   For citation and feedback.
 * @property {Diagnostics}                 diagnostics
 */

/**
 * Strategy applicability — router output. `score` runs 0..1 (0 = do not
 * use, 1 = ideal fit). `reason` surfaces in diagnostics so opaque router
 * decisions remain debuggable.
 *
 * @typedef {Object} Applicability
 * @property {number} score
 * @property {string} reason
 */

/**
 * The plug-in seam every retrieval strategy implements. The router asks
 * each strategy how well it fits, picks the viable ones, and gives each
 * a quota proportional to its applicability.
 *
 * `quota` is a soft hint in chunks; strategies may return fewer if the
 * collection is small.
 *
 * @typedef {Object} Strategy
 * @property {StrategyName} name
 * @property {(req: RetrievalRequest) => Applicability} applies_to
 * @property {(req: RetrievalRequest, quota: number) => Promise<ChunkRef[]>} retrieve
 */

/**
 * Frozen registry of chunker versions, one per `ContentType`. Bumping a
 * version invalidates the corresponding ChunkIDs (see DESIGN-retrieval
 * §"Chunk Identity and Stability"); two chunkers can coexist during a
 * migration because the version participates in the ID hash.
 *
 * All entries start at `"v1"` for the foundation patch — concrete
 * chunker implementations will own their own bumps when shipped.
 */
export const CHUNKER_VERSION = Object.freeze({
    prose: 'v1',
    code: 'v1',
    conversation: 'v1',
    structured: 'v1',
    spec: 'v1',
});
