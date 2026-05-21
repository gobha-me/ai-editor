# DESIGN — Profiles: Per-Surface Adapter Contract

**Status:** Draft
**Depends on:** All three sibling subsystems (`DESIGN-retrieval.md`, `DESIGN-memory.md`, `DESIGN-compression.md`) and the architectural principle in `DESIGN-intelligence.md`.
**Consumed by:** Every product surface that uses the intelligence subsystems. The five canonical surfaces are standard chat, multi-user chat, RP / personas, coder, and RAG / KB.

---

## Problem

The three intelligence subsystems (retrieval, memory, compression) are deliberately surface-agnostic. They have no opinions about whether the caller is a coding assistant, a chat product, a knowledge base, or something else. This is correct architecture — but it leaves a gap.

Every product surface needs to make decisions that the subsystems cannot make for it:

- How is the context window budget allocated across system framing, retrieved content, memory, history, and output reserve?
- Which retrieval strategies are appropriate, and at what quotas?
- Which memory scopes are queried by default?
- Which compression rules are registered, in what priority order?
- Which chunkers handle which content types?
- Which summarizer (if any) is invoked when compression Rule 5 fires?
- What custom metadata fields does the conversation chunker preserve for this surface?
- How is per-task admission state maintained and consulted?

These decisions vary widely across surfaces. A coder profile aggressively evicts tool-result turns; a chat profile barely touches them. A KB profile disables compression entirely; an RP profile preserves voice across summarization boundaries. Without a structured place to make these decisions, they leak into one of two bad places: into the subsystem code (as `if surface == "coder"` branches that rot the contract), or into per-feature glue code (where they get re-implemented inconsistently across products).

A **profile** is the named collection of those decisions. Every product surface declares a profile at session start; the profile is the only place per-surface variation lives. The intelligence subsystems remain surface-blind.

---

## What a Profile Is (and Isn't)

**A profile IS:**
- A configuration object plus a small adapter, owned by the product surface that uses it.
- The single point of variation between intelligence consumers.
- Versioned and named (a coder profile has a version; upgrading is a deliberate act).
- Composable from defaults: profiles inherit from a base profile and override what they need.
- The owner of per-task state (notably the task ledger) for surfaces that need it.

**A profile IS NOT:**
- A subsystem. Profiles do not own atomic units (`ChunkRef`, `MemoryRecord`, `Turn` belong to retrieval, memory, and compression respectively).
- A coordinator between subsystems. Subsystems coordinate through their published contracts, not via profile-side glue.
- A runtime translator between two subsystem schemas. If subsystem A and B need to exchange data, they do so through their contracts; profiles do not act as bridges.
- A place to put logic that should be in the subsystems. Anything that would be useful to multiple profiles belongs in a subsystem.
- Persistent. Profile *configuration* is durable; profile *state* (task ledger, session ledger) is session-scoped and discarded when the session ends.

**Non-Goals:** Dynamic profile inference from query content (profiles are declared, not detected); cross-profile state sharing (each profile gets its own task ledger); a marketplace of community profiles in v1; profile composition beyond simple base+overrides.

---

## Goals

1. **One named place per surface** for all per-surface decisions. No `if surface == X` branches in the subsystems.
2. **Schema-backed configuration.** Profile config is data, validated at session start, with explicit field requirements per subsystem.
3. **Lifecycle ownership of per-task state.** The profile owns the task ledger and any other session-scoped state that subsystems need access to.
4. **Composable with base defaults.** A new profile rarely starts from zero; it inherits from a base and overrides specific fields.
5. **Testable in isolation.** A profile can be exercised against fixture inputs without spinning up a full product surface.

---

## Non-Goals

- Hot-swapping profiles mid-session. Profile swap requires session reset.
- Profile-level diagnostics aggregation. Each subsystem still produces its own diagnostics; the profile may stitch them in its diagnostic logging but does not own a unified surface.
- Profile-specific embeddings. The shared embedding pipeline is shared; profiles do not pick their own embedder.
- Multi-profile-per-turn dispatch. One profile per session.

---

## The Profile Contract

A profile is fully described by the following structure. Fields are grouped by which subsystem they configure, plus profile-level concerns.

```
Profile {
  name:    string      // canonical id, e.g., "coder.v2"
  version: string
  base:    string?     // optional inheritance — "chat.v1" to start from chat defaults

  # ─── Budget shape ────────────────────────────────────────────────
  # Allocation of the total context window across categories.
  # All values are token counts; their sum should equal total_tokens.
  budget: {
    total_tokens:    int       // ceiling for the full composed prompt
    system_reserve:  int
    output_reserve:  int       // max_tokens for generation
    history_reserve: int
    memory_reserve:  int       // dedicated slice for memory chunks
    # retrieval_budget is the residual.
  }

  # ─── Retrieval configuration ─────────────────────────────────────
  retrieval: {
    collections:        []string             // which corpora to query by default
    memory_collections: []MemoryScope        // which memory scopes to query
    strategy_weights:   map<string,float>    // override default applicability
    chunkers:           []ChunkerRegistration // which chunkers active in ingest
    metadata_extensions: []FieldSpec         // surface-specific Metadata.custom fields
    novelty_threshold:  float                // for task ledger re-admission decisions
  }

  # ─── Compression configuration ───────────────────────────────────
  compression: {
    rules:           []CompressionRule       // ordered by priority
    preserve_recent: int                     // hard invariant; never evict last N turns
    summarizer:      SummarizerConfig?       // null = compression disabled past Rules 1-4
  }

  # ─── Memory configuration ────────────────────────────────────────
  memory: {
    default_scope:           MemoryScope     // which scope new memories land in
    propose_after_n_turns:   int?            // null = no automatic proposals
    capacity_warnings:       map<MemoryScope,int>
  }

  # ─── Tools configuration ────────────────────────────────────────
  # Consumed by the tools subsystem (DESIGN-tools.md). The profile
  # declares the catalog and the static set; the tools subsystem
  # owns admission, discovery, and authorization.
  tools: {
    catalog:          []ToolDef            // available tools for this surface
    static:           []ToolID             // always-loaded subset
    discovery_strategies: []string         // "categorical" | "semantic" | "frequency"
    budget_tokens:    int                  // ceiling for the tool slice
    expansion_mode:   "short" | "full"     // default for discovery results
  }

  # ─── Profile-level concerns ──────────────────────────────────────
  # State that is owned by the profile rather than any single subsystem.
  task_ledger: TaskLedgerConfig            // see "The Task Ledger" section
}
```

The contract is intentionally explicit. There are no hidden defaults at the subsystem level that a profile silently overrides; everything the profile decides is in the profile.

### Inheritance

A profile may name a `base` profile. At validation time, the resolved profile is constructed by deep-merging the named profile's overrides on top of the base's values. This is the only profile-composition mechanism; there is no multi-inheritance, no mixin, no late binding.

The five canonical profiles all inherit from a common `base.v1` that supplies sensible defaults for fields no surface has reason to override.

---

## Prompt Assembly

The Profile is the **assembler** of the final prompt sent to the LLM. The assembler role is load-bearing and distinct from the author role: the Profile owns slot order and position; it does not author the content of most slots.

This distinction prevents a class of bug where a Profile that controls assembly silently rewrites content it shouldn't own — for example, a coder profile mutating retrieved code blocks during assembly, or a chat profile rewriting tool-result turns to "smooth" them. The architecture forbids this by separating who-decides-the-order from who-decides-the-content.

### The Slots

The assembled prompt consists of the following ordered slots:

| Slot | Authored by | Notes |
|---|---|---|
| System prompt | Multiple authoring sources (see below) | Behavioral framing, identity, policy, operational directives. Multi-author. |
| Retrieval blocks | Retrieval subsystem (per `DESIGN-retrieval.md`) | Composer-ordered. Profile does not reorder. |
| Tool definitions | Tools subsystem (per `DESIGN-tools.md`) | Admitted set, in admission order. Profile does not filter. |
| History | Compression subsystem (per `DESIGN-compression.md`) | Post-compaction. Profile does not re-edit. |
| Task instruction | The current user message | Verbatim from input. Profile does not paraphrase. |

The Profile decides:

- The **order** in which slots appear (attention-aware: high-importance content at the head and tail; tooling and history in the middle).
- The **position** of each slot relative to others within the chosen order.
- The **budget** allocated to each slot (from the budget shape in the contract above).
- The **separators or framing** between slots (markdown headings, XML tags, plain newlines — implementation detail).

The Profile does *not* decide what goes inside any slot it doesn't author. Retrieval owns its blocks; Tools owns its definitions; Compression owns its history. The Profile assembles them; it does not edit them.

### The System Prompt Slot is Multi-Author

The single most consequential commitment of the assembly contract: **the system prompt slot has multiple authoring sources** that merge into one slot before the prompt is sent to the model. The architecture commits to the slot existing and to merge being deterministic per implementation; it does not prescribe which authoring sources are valid in a given deployment, nor the merge order, nor the conflict-resolution policy.

Common authoring sources (illustrative, not exhaustive):

- **Admin contribution** — set by the platform vendor or deployment operator. Often the only contribution in single-tenant or strictly-controlled deployments. Carries policy constraints, safety guardrails, deployment-wide tone.
- **User contribution** — set by the end user. Carries personal preferences, project-specific guidance. May be empty in deployments where users do not have system prompt authoring rights.
- **Persona contribution** — set by whoever authored the active Persona (see `DESIGN-persona.md`). Carries identity, voice, character-specific behavioral framing.
- **Profile directives** (optional, see below) — set by the Profile itself. Carries operational instructions about surface behavior (e.g., "after editing files in code mode, run the test suite"). Profile directives are *operational*, not *personality*; they belong to the Profile because they are surface-shaped, not identity-shaped.

The architecture commits to:

- The slot exists and has a defined position in the assembled prompt.
- Merge is deterministic per implementation — the same set of contributions produces the same merged result.
- Merge is auditable — diagnostics on the assembly step record which contributions were present and how they composed.
- Each contribution carries a trust label (see `DESIGN-intelligence.md` §"Trust Labels on Admitted Content") that propagates through merge; lower-trust contributions cannot override higher-trust ones unless operator policy explicitly permits.

The architecture does not commit to:

- A specific merge order. Whether Admin precedes User precedes Persona, or Admin precedes Persona precedes User, or some other order — operator policy.
- A specific conflict resolution. Whether later contributions override earlier ones, whether contributions concatenate, whether contradictions are flagged — operator policy.
- Which authoring sources are valid in a deployment. A strict enterprise system may admit only Admin; a creative platform may admit all four; an RPG may admit Admin and Persona but not User.

### Profile Directives (Distinct from System Prompt Personality)

Some Profiles need to contribute operational instructions to the system prompt slot that are prompt-shaped but not personality-shaped:

- "In code mode, run tests after editing."
- "In RP mode, stay in character when the user breaks the fourth wall, then resume narrative."
- "In KB mode, cite source IDs in line with retrieved blocks."

These are **profile directives** — operational behavior the Profile contributes. They are part of the multi-author system prompt slot but distinct from Persona contributions because:

- Profile directives apply uniformly to every Persona that runs on this Profile.
- Profile directives are surface-shaped (the same code-profile directive applies whether the active Persona is "Senior Reviewer" or "Junior Pair").
- Profile directives carry Profile-level trust (typically equal to Admin trust, or below depending on deployment policy).

A Profile may have no directives at all (chat profiles often don't); when present, they merge into the system prompt slot alongside other contributions.

### Assembly Order Is Profile-Shaped

The default order most surfaces use is roughly:

```
[ system prompt ] [ tool definitions ] [ retrieval blocks ] [ history ] [ task instruction ]
```

This puts framing first, capabilities second, evidence third, conversation fourth, and the current ask last — exploiting the recency-and-primacy attention patterns documented in long-context research. The KB profile may invert retrieval and history (evidence is the point, history is secondary). The RP profile may suppress retrieval entirely some turns and rely on memory + persona prompt. These are profile decisions, not architectural ones.

### Diagnostics

The assembly step produces a diagnostics record per the umbrella's diagnostics principle. Required fields:

- Which slots were assembled.
- Which authoring sources contributed to the system prompt slot.
- Token counts per slot (actual vs budget).
- Trust labels carried into the assembled prompt.
- Any contributions that were rejected (e.g., a User contribution discarded by Profile policy).

The diagnostics are operator-readable and surface in the same diagnostics export as the other subsystems' surfaces.

---

## The Task Ledger

The single most important piece of profile-owned state is the **task ledger**. It is what makes legitimately context-heavy multi-turn tasks (large-corpus exploration, multi-file code review, iterative debugging) economically tractable, by amortizing chunk admission across a task's turns.

### Lifecycle

A task begins when the profile decides one is starting (heuristics: a new top-level user message after period of inactivity, an explicit "/task" marker, the start of a new session). A task ends when the profile decides it has ended (heuristics: an explicit task-completion signal, a topic shift detected by the next-message classifier, session end).

A profile may run multiple tasks within a session. Each task has its own ledger. Ledgers do not survive session end by default — they are working state, not memory. (If a user wants the *outcome* of a task to persist, that goes through the memory subsystem with consent, not via ledger preservation.)

### Schema

```
TaskLedger {
  task_id:     TaskID            // assigned at task start
  surface:     string            // for diagnostics and analytics
  started_at:  timestamp
  admissions:  []AdmissionRecord
  exclusions:  []ExclusionRecord
}

AdmissionRecord {
  chunk_id:        ChunkID
  admitted_at:     timestamp
  turn_id:         TurnID         // which turn triggered admission
  tokens:          int
  query:           string?        // the query that justified admission
  query_embedding: Vector?        // cached for novelty scoring
  strategy:        string         // semantic | structural | thematic | pinned
  facets_covered:  []string       // optional; what aspect of the chunk this admission was for
}

ExclusionRecord {
  chunk_id:    ChunkID
  excluded_at: timestamp
  turn_id:     TurnID
  reason:      string             // "already_admitted_low_novelty" | "out_of_budget" | ...
  rule:        string             // which mechanism made the exclusion decision
}
```

### Re-admission Decision

When the retrieval Composer encounters a candidate chunk during retrieval and the task ledger has a prior `AdmissionRecord` for that chunk:

```
score_novelty(current_query, prior_admission) -> float [0, 1]:
  signals = []

  # Cosine distance between current query and the query that
  # justified the prior admission. If they are essentially the
  # same query, the chunk has already been admitted for this need.
  signals.append(1.0 - cosine(current_q_emb, prior.query_embedding))

  # Keyword novelty: tokens in current query not present in prior query.
  new_tokens = tokenize(current_query) - tokenize(prior.query or "")
  signals.append(min(1.0, len(new_tokens) / 5.0))

  # Time decay: very stale admissions have lower confidence that
  # the chunk's relevance has not shifted. Weak signal.
  hours_elapsed = (now() - prior.admitted_at) / 3600
  signals.append(min(1.0, hours_elapsed / 24))

  # Explicit override.
  if "force_readmit" in current_strategy_hints:
    return 1.0

  return weighted_mean(signals)  # weights are profile-tunable
```

If `score_novelty >= profile.retrieval.novelty_threshold`, the chunk is re-admitted normally and a new admission record is appended. Otherwise, the chunk is suppressed and replaced in the emitted blocks with a reference marker:

```
[Already admitted: {chunk_id} — see turn {prior.turn_id}; ~{prior.tokens} tokens]
```

The marker costs ~20 tokens in place of a multi-hundred-token chunk. The model retains the awareness that the content exists in conversation history and can request explicit re-examination if the marker is insufficient.

### Why "novelty" and not just dedup

A pure "if seen, suppress" rule would be wrong. The user's stated case captures exactly why: *sometimes you need to look at a file a second time when something elsewhere makes a previously-irrelevant aspect now relevant.* The novelty score recognizes this. A query about "auth middleware" admits `middleware.ts` once. A later query about "rate limiting interactions with auth" warrants re-admitting `middleware.ts` because the *aspect* is new, even though the chunk is the same. Pure dedup would silently produce a worse answer.

### Capacity

Ledgers are bounded. The default cap is 500 admission records per task; older records spill to a compact form (chunk_id and turn_id only, dropping query embeddings) and eventually drop entirely with a warning. A long-running task pressing this limit is a signal the profile's task boundaries are too coarse — re-tune the boundary detection rather than expanding the cap.

---

## Canonical Profiles

The five baseline profiles. Each is a starting point — a real product may override any field. The point of naming them is that there is *one* canonical version per surface kind, not a fragmented set of near-duplicates.

### `chat.v1` — Standard chat

The base profile from which the others inherit. Targets a single human conversing with the assistant about general topics.

| Field | Value |
|---|---|
| Total / system / output / history / memory budget (32k example) | 32000 / 2000 / 4000 / 8000 / 2000 → retrieval = 16000 |
| Retrieval collections | `attached_docs` only |
| Memory collections | `user`, `persona` |
| Strategy weights | semantic 1.0, structural 0.5, thematic 0.0 |
| Chunkers | prose, structured |
| Compression rules | Rule 5 only (generic summarization) |
| `preserve_recent` | 4 |
| Summarizer | small generic model |
| Task ledger | enabled, 100-record cap |
| Tools | minimal (web search, calculator) |

### `chat_multi.v1` — Multi-user chat with @-mention semantics

Inherits from `chat.v1`. Overrides:

- Retrieval collections add `shared_conversation`.
- Memory collections add `per_speaker` scopes.
- Conversation chunker registers `speaker_id` as a custom metadata field.
- Compression's Rule 5 summarizer prompt preserves speaker attribution.
- Task ledger novelty score weights heavily toward speaker-context shifts.

### `rp.v1` — Role-play / personas

Inherits from `chat.v1`. Overrides:

- Retrieval collections add `lore` (per-world).
- Memory collections add `per_persona`; default scope for new memories is `persona`.
- Chunkers register `persona_id`, `in_character`, `scene_id` as custom metadata.
- Strategy weights: structural 0.8 over lore (hierarchies matter); thematic 0.3.
- Compression registers Rule 4 (Resolution) keyed off `scene_id` boundaries: scene transitions trigger a marker collapse.
- Compression's Rule 5 summarizer is voice-preserving (different prompt than generic).
- `preserve_recent` raised to 8 (preserve more in-character continuity).

### `coder.v1` — Coding assistant

Inherits from `chat.v1`. The profile with the most extensive overrides because coder workflows are the most context-heavy and the most amenable to admissibility discipline.

| Field | Override |
|---|---|
| Retrieval collections | `workspace_code`, `workspace_docs`, `recent_tool_results` |
| Memory collections | add `workspace`; default scope = `workspace` |
| Strategy weights | structural 1.0, semantic 0.8, thematic 0.0 |
| Chunkers | add `code` (Phase 1 heuristic), tool-call/tool-result chunkers |
| Metadata extensions | `tool_name`, `tool_args`, `tool_result_for`, `file_ops`, `file_path`, `byte_range_read` |
| Compression rules | All five (Subsumption, Invalidation, Consumption, Resolution, Summarization) |
| `preserve_recent` | 2 (aggressive — most recent context is what matters in coding) |
| Summarizer | code-aware (different prompt template) |
| Task ledger | enabled, 500-record cap, novelty threshold low (re-admit liberally) |
| Tools | full set: file ops, search, run_shell, code execution |
| Budget shape | `output_reserve` raised to 8000 (coding outputs are long); `memory_reserve` 1500 |

### `kb.v1` — Single-purpose knowledge-base assistant

Inherits from `chat.v1`. The minimal profile.

| Field | Override |
|---|---|
| Retrieval collections | `kb_documents` only |
| Memory collections | none |
| Strategy weights | semantic 1.0, thematic 0.4 (for overview queries), structural 0.6 |
| Compression rules | none — sessions too short to compress |
| `preserve_recent` | (irrelevant, no compression) |
| Summarizer | none |
| Task ledger | disabled — short-session pattern doesn't benefit |
| Tools | minimal (citation lookup) |

The KB profile is a useful demonstration that the architecture is opt-in at the profile level. A surface that doesn't need compression pays no cost for it. A surface that doesn't need a task ledger pays no cost for it. Most subsystem features are silent unless the profile turns them on.

---

## Profile Behavior in Practice

Three worked examples grounded in the user's scenarios. Each traces a query through the architecture and shows what gets admitted, what gets excluded, and on what grounds.

### Example 1: "Summarize this entire codebase"

**Profile:** `coder.v1`. **Corpus:** ~200,000 LOC across 312 files in a workspace.

**Recognition.** The profile classifies the query: no explicit file scope, the verb is "summarize," the noun phrase is the entire workspace. This matches a thematic-strategy pattern with a structural filter.

**Request construction.** The profile builds:

```
RetrievalRequest {
  task: "Produce a summary of the codebase scoped to its public surface.",
  query: "summarize codebase",
  collections: ["workspace_code"],
  budget: { total: 32000, system: 2000, output: 8000, history: 8000, memory: 1500 },
                                                       # retrieval_budget = 12500
  filters: MetadataFilter(node_kind in ["module", "class", "function_signature", "type"],
                          structural.heading_path includes "exported"),
  strategy_hints: ["thematic_emphasis"],
}
```

**Composer behavior.**

- Thematic strategy clusters across the public-surface filter (returns ~50 cluster representatives).
- Structural strategy returns the top-level module headers and their immediate exported types.
- Semantic strategy is skipped (applicability low: query is too generic).
- Total admitted: ~120 chunks averaging ~80 tokens each = ~10,000 tokens.

**What got excluded.** Approximately 14,000 chunks (function bodies, tests, comments, internal types) filtered by `node_kind` and `heading_path`, never reaching the strategies. Diagnostics record `chunks_filtered_pre_strategy: 14127`.

**Response.** The model produces a summary explicitly limited to the public surface, with a closing line like: *"This summary covers the public API of 47 modules in the workspace. Implementation details, tests, and internal helpers are not in context. Tell me which area to dig into."*

**The principle in action.** The architecture refused to *pretend* to summarize what it could not honestly fit. The user gets an answer that is true plus a scoped offer to go deeper, instead of a hallucinated summary of code the model never saw.

### Example 2: "SLOC report"

**Profile:** `coder.v1`. **Corpus:** same ~200,000 LOC workspace.

**Recognition.** The profile classifies the query: this is a *computational* task, not an interpretive one. The right tool exists (`run_shell` with `cloc`). Loading source into context is the wrong move.

**Request construction.** No retrieval call is made for the source code. The profile constructs an LLM call with:

- A short system message describing the workspace root.
- The `run_shell` and `count_lines` tool definitions.
- The user's query.
- Empty `collections: []` for retrieval (no corpus admission).

Total context: ~500 tokens.

**LLM behavior.** The model issues `run_shell("cloc .")`. The tool result lands as a turn (~200 tokens of cloc output). The model produces a structured report.

**What got excluded.** The entire source corpus. Not by retrieval filtering — by *not asking retrieval at all*. The profile's recognition layer routed this away from the context-heavy path.

**The principle in action.** "Counting" is a tool job, not an attention job. A profile that conflates "code task" with "load code into context" would have admitted hundreds of thousands of tokens and produced an unreliable count. The profile that recognizes the category does it right with hundreds of tokens. The savings are three orders of magnitude.

This is the example that most clearly illustrates a subtle point: **admissibility discipline is not the same as retrieval discipline.** Sometimes the right move is not "retrieve more carefully" but "do not retrieve at all." Profiles need recognition logic for this case, not just rules for how to retrieve well when retrieval is the right tool.

### Example 3: "Review the following code for smells" (with attached file)

**Profile:** `coder.v1`. **Scope:** an attached file `src/auth/middleware.ts` (~600 lines).

**Recognition.** Explicit scope, interpretive verb, unbounded "smells" criterion. This is legitimately context-heavy *within a bounded scope*.

**Request construction.**

```
RetrievalRequest {
  task: "Review src/auth/middleware.ts for code smells.",
  query: "code review smells middleware authentication",
  collections: ["workspace_code"],
  budget: { ... retrieval_budget = 18000 },
  priority_pins: [chunk_ids_for(src/auth/middleware.ts)],
  task_ledger: <fresh ledger>,
}
```

**Composer behavior.**

- Pinned chunks consume budget first: the file's chunks (~3000 tokens).
- Structural strategy walks ancestors and immediate descendants of the pinned chunks (the `auth` module's other files at top-level, the parent index file).
- Semantic strategy finds callers of the middleware and similar middleware patterns elsewhere.
- Thematic skipped (specific query).
- Total admitted: ~12,000 tokens.

**What got excluded.** Every file unrelated to auth. The other 295 files in the workspace. Diagnostics record `chunks_filtered: ~13000` and `strategies_skipped: ["thematic: specific query"]`.

**Response.** A focused code review of the middleware and its immediate ecosystem.

**The follow-up turn.** The user replies: *"Now look at how this is used in the test suite."*

The profile recognizes this as a continuation of the same task (no boundary signal) and re-uses the existing task ledger.

```
RetrievalRequest {
  task: "Examine how src/auth/middleware.ts is used in the test suite.",
  query: "middleware authentication tests usage",
  collections: ["workspace_code"],
  budget: { ... },
  task_ledger: <existing ledger from prior turn>,
}
```

**Composer behavior on the second turn.**

- Strategies identify candidate chunks. Among them: `src/auth/middleware.ts` (already in the ledger from the prior admission) and several files in `tests/` (new).
- Ledger consultation: for `middleware.ts`, novelty score is low (current query is about its *use* but the chunk's content hasn't shifted in relevance from the prior query). → Suppressed; emit reference marker `[Already admitted: middleware.ts — see turn 1; ~3000 tokens]`.
- The test files are new admissions; they go in normally.
- Total *new* admission cost: ~5,000 tokens (the test files), versus ~8,000 if `middleware.ts` had been re-admitted.

**The principle in action.** The user asked a legitimate follow-up that genuinely needs the test files. The architecture admitted them. It also recognized that re-pasting `middleware.ts` was unnecessary — the model already has it from turn 1, and a marker preserves the awareness without paying again. If a *third* turn asks "how does middleware.ts handle the case where the user's session is already expired" — a clearly novel aspect — the novelty score would be high, `middleware.ts` would be re-admitted, and the model would have its content present and current.

---

## Failure Modes

| Failure | Behavior | Surfaced as |
|---|---|---|
| Profile config invalid (missing required field) | Reject at session start with structured error | Exception |
| Profile references unknown subsystem capability (e.g., a chunker that doesn't exist) | Reject at session start | Exception |
| Profile name unknown to registry | Reject at session start | Exception |
| Base profile reference cycles | Detect at validation; reject | Exception |
| Task ledger capacity exceeded | Spill oldest records to compact form, then drop with warning | `diagnostics.warnings` |
| Concurrent retrieval calls in same task | Each gets a snapshot of the ledger; both may append — last writer wins for new admissions; suppressions are union | `diagnostics.warnings` if conflict |
| Profile-tuned `novelty_threshold` outside [0, 1] | Validate and reject at config load | Exception |
| Surface declares wrong profile (e.g., chat for a coding task) | No error; quality degrades silently. This is a UX problem, not an architecture problem. | (none — by design) |
| Memory collections referenced in profile not authorized for the user's RBAC group | Filter to authorized subset, warn | `diagnostics.warnings` |

---

## Phased Delivery

**Phase 1 — Profile contract + base + chat + coder:**

- Profile schema validation.
- `base.v1` and `chat.v1` and `coder.v1` profiles.
- Task ledger Phase 1: admission tracking, suppression-with-marker for low-novelty re-admissions, basic novelty score (cosine + keyword signals).
- Profile registration as the only place subsystems get configured.

*Explicitly excluded from Phase 1:* automatic task boundary detection, the multi-user / RP / KB profiles, profile inheritance beyond a single base level.

**Phase 2 — Remaining canonical profiles:**

- `chat_multi.v1`, `rp.v1`, `kb.v1`.
- Per-profile worked-example test fixtures.
- Profile inheritance through one level (base → leaf).

**Phase 3 — Operational maturity:**

- Task boundary detection heuristics (replaces explicit task markers).
- Novelty-score tuning from real usage.
- Per-profile dashboards and quality metrics.

**Phase 4 — Extensibility:**

- Custom profile authoring API for product teams.
- Profile diffing (compare what two profiles would do for the same query).
- Profile regression testing harness.

---

## Open Questions

| Question | Why open | Resolution path |
|---|---|---|
| Task boundary detection | Explicit markers are unergonomic; automatic detection is unreliable | Ship with explicit markers; build heuristics on usage data |
| Novelty score weights | Profile-tunable but defaults need calibration | Measure on coder profile; tune; promote to other profiles |
| Whether ledgers should survive session end | Risk of staleness vs. continuity benefit | Keep session-scoped in v1; revisit if users ask to resume tasks |
| Whether profiles should be allowed to override subsystem failure modes | Could be useful for paranoid surfaces; could fragment behavior | No in v1; subsystem failure modes are a contract |
| Multi-profile sessions (e.g., chat that occasionally invokes coder mode) | Real product need, but doubles the state-management complexity | Single profile per session in v1; revisit if friction is high |
| How profile config is distributed (file, registry service, code) | Operational rather than architectural | Code-defined in v1 (typed structs); externalize later if needed |

---

## What This Document Commits To

- **One profile per session.** No mid-session swap, no per-turn dispatch.
- **Profile is the assembler, not the author.** Profile owns slot order, position, and budget. Retrieval, Memory, Compression, and Tools own the content of their respective slots; the Profile does not edit them during assembly.
- **The system prompt slot is multi-author.** Admin, User, Persona, and (optional) Profile directives are common contributing sources. Merge is deterministic per implementation and auditable in diagnostics. Merge order and conflict resolution are operator policy, not architectural commitments.
- **Schema-validated configuration.** Profile config is data; invalid profiles fail fast at session start.
- **Profiles own per-task state.** The task ledger lives here. Subsystems consume it but do not own its lifecycle.
- **Novelty over dedup for re-admission.** Pure suppression of seen chunks is wrong; admissibility decisions consider what aspect is now relevant.
- **Inheritance from a single base.** No multi-inheritance, no late binding.
- **Recognition is part of the contract.** A profile that always retrieves is incomplete; some queries (computation, tool-call patterns) should not invoke retrieval at all.
- **Five canonical profiles, opinionated.** Standard chat, multi-user chat, RP, coder, KB. New surfaces should fit into one or extend an existing one before becoming a sixth.

These are the load-bearing decisions. Push back on any of them before building.
