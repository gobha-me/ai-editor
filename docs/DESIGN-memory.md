# DESIGN — Memory: Curated Atomic Facts

**Status:** Draft — ready for roadmap integration
**Depends on:** Vector store library, the shared embedding pipeline, and the retrieval subsystem (`DESIGN-retrieval.md`) for context composition.
**Sibling subsystems:** `DESIGN-retrieval.md`, `DESIGN-compression.md`. All three are coordinated by `DESIGN-intelligence.md`.
**Consumed by:** Chat interfaces, agentic coding tools, note/document systems, RP/persona surfaces, or any component needing persistent, scoped, retrievable knowledge across sessions.

> **Note on naming.** This document was previously titled "Shared Memory System." It has been renamed to *Memory* because the umbrella name "intelligence" is now reserved for the three-subsystem architecture (retrieval, memory, compression). This document covers the memory subsystem only. References to the "intelligence layer" in earlier drafts now refer specifically to the retrieval subsystem.

---

## Problem

LLMs are stateless. Context windows provide only ephemeral continuity. Conversation history handles short-term recall (and conversation-history compaction is the compression subsystem's job; see `DESIGN-compression.md`), but there is no persistent home for structured, reusable knowledge such as user preferences, architectural decisions, project conventions, or domain facts. These details are repeatedly lost across conversations, agent runs, and sessions.

The memory subsystem provides curated, scoped, semantically retrievable atomic facts that integrate with the retrieval subsystem for context composition. Memories survive across sessions while remaining under user control.

A memory existing is not the same as a memory being admitted. Memory creation goes through one of three paths (each with its own confidence and audit trail), but admission to any given context window is a *separate* decision made by the retrieval Composer, governed by the admissibility principle (see `DESIGN-intelligence.md`). A memory may sit in the store for months without being admitted to a single context window if no query justifies it. That is the correct behavior. The store is the candidate pool; admission is per-turn.

---

## What Memory Is (and Isn't)

**Memory IS:**
- Atomic key-value facts with embeddings for semantic retrieval.
- Scoped and priority-ordered (`user > persona > workspace > organization`).
- Curated and explicit (created, updated, or confirmed by users, or by agents with consent).
- Retrievable via the retrieval subsystem alongside documents and other context.
- Optionally self-healing (agents can propose or directly maintain facts within guardrails).

**Memory IS NOT:**
- Conversation history. That is owned by the chat surface and compacted by the compression subsystem.
- A document knowledge base. Documents are chunked and indexed via the retrieval subsystem; memories are atomic curated facts, not chunks of source material.
- A transient cache or working scratchpad.
- A replacement for design documents or specifications. Memory captures preferences, decisions, and learned facts; it is not where you put a system spec.

**Non-Goals:** Full autonomous memory creation without consent; real-time multi-agent conflict resolution in v1; multi-modal memories; replacing general-purpose vector databases.

---

## Core Architecture

Memory builds on the retrieval subsystem's three query strategies (semantic, structural, thematic) and the shared embedding pipeline. It registers as scoped collections so memories are automatically considered during context composition by retrieval's Composer.

A **hybrid storage approach** is recommended for robustness and transparency:

1. **Primary Structured Store** — A database table plus vector embeddings, providing fast semantic search, audit trails, scoping, and confidence-based ranking.
2. **Transparent File Layer (optional but recommended)** — Human-readable Markdown files with an index (`memory.md`) that points to domain-specific files (e.g., `preferences.md`, `decisions.md`, `project-context.md`). Inspired by production agent patterns, this enables self-healing: agents can read the index, load relevant domain files, and rewrite them when facts change. The file layer stays in sync with the structured store.

The hybrid combines semantic power (via the retrieval subsystem's semantic and thematic strategies) with the transparency, selective loading (token efficiency), and auditability that pure vector stores lack.

---

## Data Model (Abstract)

Core fields for each memory fact:

- **scope**: `user`, `persona`, `workspace`, `organization`
- **owner_id** / **persona_id** / **workspace_id** / **org_id**: Context for the chosen scope.
- **key**: Short, unique identifier (e.g., `preferred_language`, `auth_approach`, `error_handling_style`).
- **value**: The factual content.
- **category**: `preferences`, `decisions`, `project_context`, `domain_knowledge`, `workflow`.
- **source**: `user_explicit`, `agent_proposed`, `system_inferred`.
- **confidence**: 0.0–1.0. `user_explicit` defaults to 1.0; `agent_proposed` defaults to 0.7–0.9.
- **embedding**: Vector of `key: value`, generated via the shared embedding pipeline.
- **superseded_by**: Reference to a newer memory record (supports history and soft deletion).
- **expires_at**: Optional TTL for ephemeral facts.
- **updated_at**, **created_at**.

An audit log records every mutation (create, update/supersede, delete, expire) with actor, reason, and before/after values.

**Scoping & Access.** Logical scopes determine retrieval priority and default visibility. RBAC groups (additive permissions under least-privilege rules) control actual read/write authorization orthogonally. This avoids collision with RBAC group primitives while allowing fine-grained control (e.g., certain groups can read all workspace memories).

Retrieval order places high-confidence user/persona memories toward the head of the context window (high attention), with organization-level facts lower.

---

## Scope as a Tuple, Not an Enum

The `scope` field above is the most common case, but it is shorthand. The underlying model is a tuple:

```
ScopeSpec {
  writer:      WriterAuthority   // who has authority to create/update
  visibility:  VisibilitySpec    // who can read; composable along multiple axes
  persistence: PersistencePolicy // how long the record lives
}
```

The four named scopes (`user`, `persona`, `workspace`, `organization`) are common compositions of this tuple. They exist as shorthand because they cover ~90% of cases and reading `scope: user` is friendlier than reading `(writer: user, visibility: user-only, persistence: persistent)`. The tuple grammar is what the architecture commits to; the enum is sugar over it.

The `persona` writer (and `persona` as a visibility sub-axis) is defined fully in `DESIGN-persona.md`. Memory uses Persona as a scope value; it does not own the Persona concept.

**Why three axes, not one.** Writer, visibility, and persistence are independent decisions that get conflated in casual description and cause real bugs when separated. A user-authored memo *about* an admin's policy decision has writer=user but visibility=admin-or-user; a Persona's private note about a specific user has writer=persona but visibility=persona-and-this-user-only; a session-scoped scratchpad has writer=user but persistence=this-session-only with no durable visibility at all. Single-axis scope cannot express these without straining.

**Common compositions, with the enum mapping made explicit:**

| Composition shorthand | Tuple | Notes |
|---|---|---|
| `user` (existing enum) | `(user, user-global, persistent)` | The user's personal memory across all their workspaces and Personas. |
| `persona` (existing enum) | `(persona, persona-global, persistent)` | The Persona remembers across all its users and sessions. Shared-Persona RPG case. |
| `workspace` (existing enum) | `(user-or-group, workspace-only, workspace-lifetime)` | Project-scoped memory; RBAC groups govern membership. |
| `organization` (existing enum) | `(admin, org-wide, persistent)` | Org-level facts visible to all org members. |
| `persona × user` | `(persona-or-user, this-persona-and-this-user-only, persistent)` | The Persona remembers things about *this* user, invisible to other users of the same Persona and to this user's other Personas. The counselor-confidence case. |
| `persona × project` | `(persona-or-user, this-persona-in-this-project-only, project-lifetime)` | The Persona remembers project-specific facts when used inside a project. |
| `user × project` | `(user-or-group, this-user-in-this-project-only, project-lifetime)` | The user's project-specific notes, invisible to other project members. |
| `persona-transient` | `(persona, this-turn-only, no-persistence)` | Admitted into the working state for the current turn but never proposed for write. Useful for sensitive content that informs behavior without becoming durable. |
| `session-transient` | `(user, this-session-only, session-lifetime)` | The session scratchpad. Survives the session, discarded at session end. |

The table is illustrative, not exhaustive. Any well-formed tuple is a valid scope; operator policy decides which compositions are admitted in a given deployment.

**The transient persistence axis.** The persistence axis explicitly includes `no-persistence` as a valid value. A record can be admitted into the working memory of the current turn (so the LLM sees it) without ever being written to the structured store. This is not a hack — it is a first-class scope policy. Use cases: sensitive content that should inform a single response but leave no trace; experimental drafts that may or may not become durable based on a later signal; one-shot context injections from an admin without polluting the user's memory.

Transient records still go through the same admission and diagnostics machinery as persistent records; the only difference is that the write step is skipped. They still carry trust labels (see `DESIGN-intelligence.md` §"Trust Labels on Admitted Content"), still respect visibility policy, and still appear in the diagnostics surface as admitted-but-not-persisted.

**Writer authority and "identity belongs to the creator."** The writer axis encodes the umbrella's identity-belongs-to-the-creator principle. The writer field names the authority that created the record; updates may come only from that authority (or, in composable cases, from any authority listed in the writer field). Cross-authority mutation is forbidden, exactly as for ChunkRefs, ToolDefs, and other atomic units.

**Visibility composability.** The visibility axis composes along multiple sub-axes: user, persona, project, group, organization. A visibility spec is a logical conjunction of constraints across these sub-axes; admission filters records whose visibility constraints are all satisfied by the current admission context. RBAC groups (per the existing access discussion) plug into the group sub-axis without changing the grammar. **The model never sees scope metadata; it sees only admitted content.** Scope is enforced at admission time, not surfaced in the assembled prompt — Persona system prompts and Profile directives never have to reason about visibility because admission has already done the filtering.

**Persistence policies.** Common values: `persistent` (default, durable across sessions), `session-lifetime` (alive while the session lives, discarded at session end), `workspace-lifetime` (alive while the workspace exists), `project-lifetime` (alive while the project exists), `ttl(duration)` (custom TTL via the existing `expires_at` field), `no-persistence` (transient). Operator policy decides which are valid in a deployment.

**Relationship to the existing fields.** The existing data model (`owner_id`, `persona_id`, `workspace_id`, `org_id`, `expires_at`) already implements the tuple grammar — those fields are the encoding of writer, visibility, and persistence. The tuple grammar makes the conceptual model explicit; implementations need not restructure their storage to adopt it.

**Multi-record write transactions.** Some operations naturally write multiple records under a single intent — the wiki-style "ingest touches many pages" pattern is the canonical example, where parsing one document produces facts that should land as a coherent set or not at all. The architecture commits to the tuple grammar applying per-record; whether multi-record writes are atomic across records is operator policy. Implementations that need atomicity should expose a transaction primitive at the API boundary; implementations that don't, accept per-record commit semantics. The single-writer rule applies per record, not per transaction.

---

## Memory Lifecycle

### Creation Paths

1. **User Explicit** — Direct creation via UI or command. Highest confidence.
2. **Agent-Proposed (with consent)** — During conversations or agent runs, the system identifies candidate facts and proposes them ("I noticed you prefer table-driven tests with subtests. Should I remember this?"). Only stored after confirmation.
3. **System-Inferred** — Low-confidence, short-TTL facts from observable signals (e.g., active workspace, auth method). Minimal influence on decisions.

**Self-Healing.** When the Transparent File Layer is enabled, agents receive tools to read the `memory.md` index, load relevant domain files, and rewrite them when context changes. Changes sync back to the structured store. This creates persistent, maintainable knowledge without constant human intervention.

### Update & Conflict Resolution

- Updates create a new record and mark the old one as superseded (preserves history).
- `user_explicit` always supersedes `agent_proposed` for the same `key+scope`.
- Cross-scope coexistence is allowed; retrieval priority resolves conflicts at composition time.
- The retrieval subsystem returns only non-superseded, non-expired memories.

### Deletion & Expiration

- Soft deletion via the supersession flag, plus audit log.
- Hard purge reserved for compliance scenarios.
- A background process cleans expired entries.

---

## Boundary with the Compression Subsystem

A common point of confusion: when a long debugging exchange resolves successfully, should the resolution become a memory?

**Not automatically.** The compression subsystem will collapse such an exchange into a synthesized marker turn (Rule 4: Resolution; see `DESIGN-compression.md`). That marker lives in the conversation buffer and serves the model's working context.

A *memory* is a different artifact: a durable, curated fact that should persist across sessions and surface in future contexts. Promoting a compression marker into a memory is the agent-proposed creation path — it requires user consent and goes through the same audit pipeline as any other agent-proposed fact.

This boundary is load-bearing. If the compression subsystem could write to memory directly, every long debugging spiral would silently produce a memory record, the user's curated knowledge would be polluted with transient working state, and the audit trail would lose meaning. The two subsystems remain strictly separate: compression compacts working state; memory accepts curated facts; the bridge between them is explicit consent.

---

## Retrieval & Context Integration

Memory registers as scoped collections in the retrieval subsystem. Retrieval uses the semantic strategy (with hybrid search) by default, with the thematic strategy available for broad workspace overviews.

Relevant memories are automatically injected during context composition. They receive a dedicated budget slice (e.g., 1.5–3k tokens) and high-attention positioning (head of the window) because they represent curated, high-confidence knowledge.

The Transparent File Layer allows selective loading: an agent reads the index first, then only the needed domain files, keeping context minimal.

---

## API (Pseudocode)

**Core Library Interface:**

```python
memory.create(key, value, scope="user", category="preferences",
              source="user_explicit", confidence=1.0)

memory.search(query, scope=None, limit=8)   # leverages retrieval subsystem

memory.get(key, scope)                       # exact lookup by priority chain

memory.update(key, new_value, reason)

memory.propose_from_context(context)         # triggers agent proposal flow
```

**LLM Tool Actions (via system tool-calling):**

- `memory:remember(key, value, category)` — Propose or store a fact.
- `memory:recall(query, scope)` — Explicit retrieval.
- `memory:revise(key, new_value, reason)` — Self-healing update.

---

## Management UI

- **User Settings** — View/edit personal and persona memories, toggle agent proposals, view audit trails, search.
- **Workspace Settings** — Manage workspace-scoped memories (for workspace owners/admins).
- **Organization Admin** — Global memories, bulk operations, statistics, moderation across groups.

---

## Interaction with Other Subsystems

- **Retrieval** treats memories as a first-class collection type. The Composer places high-priority memories near the head of the prompt.
- **Compression** does not write to memory. The bridge is explicit user consent (see "Boundary with the Compression Subsystem").
- **Agentic coding tools** use workspace memories during planning and execution.
- **Chat surfaces** receive user/persona memories at conversation start for continuity.
- **Extraction proposals** run periodically or at session end, always with explicit confirmation.

**Privacy & Local-First Considerations.** All memories can be stored locally. Cloud sync is opt-in. Users control what is proposed or stored. Support on-device embeddings. Export/import for portability. Audit logs respect RBAC group permissions.

---

## Cost & Performance

Memories are cheap to embed (small text). Selective retrieval plus file-layer indexing keeps token usage low. Self-healing reduces long-term human maintenance cost. Compared to stuffing all history into every prompt, this approach yields order-of-magnitude savings while improving consistency.

---

## Failure Modes

| Failure | Behavior | Surfaced as |
|---|---|---|
| Embedding provider down | Memory operations queue; reads fall back to exact-key lookup | `diagnostics.warnings` |
| Conflict between two `user_explicit` writes to same key+scope | Last-write-wins with audit entry; both records retained | Audit log |
| Agent proposes a fact that conflicts with an existing `user_explicit` memory | Proposal rejected; user notified | UI surfacing |
| Capacity limit reached for a scope | Soft warning; oldest low-confidence facts surface as eviction candidates | UI surfacing |
| File layer out of sync with structured store | Reconciliation job repairs; on conflict, structured store wins | Audit log + warning |
| Supersession reference points to deleted record | Treated as orphan; surfaced for cleanup | `diagnostics.warnings` |

There are no silent memory mutations. Every change is audit-logged with actor and reason.

---

## Implementation Phases

**Phase 1: Core CRUD + User Scope + Retrieval Integration**
Structured store, basic API, semantic retrieval, management UI, explicit creation only.

**Phase 2: Persona + Workspace Scopes + RBAC Integration**
Priority chain, orthogonal group-based access control, context auto-injection via the retrieval Composer.

**Phase 3: Agent Proposals, Self-Healing & Transparent File Layer**
Consent flows, `memory.md` index plus domain files, read/write tools for agents, audit UI.

**Phase 4: Organization Scope, Expiration, Advanced Features**
Clustering over memories (via retrieval's thematic strategy), relevance decay, insights dashboard, bulk import, reconciliation tools.

---

## Open Questions

| Question | Options | Recommendation |
|---|---|---|
| File layer vs pure vector store | Pure DB+vector vs hybrid Markdown files | Hybrid. The file layer adds transparency and self-healing with minimal overhead. |
| Proposal frequency | Every N turns, end-of-session, or on-demand | On-demand via tool, plus end-of-session for important runs. |
| Capacity limits | Hard caps per scope vs soft warnings | Soft configurable limits with warnings (defaults: 400 user, 300 persona, 800 workspace). |
| Conflict resolution in multi-agent | Broker agent vs event-sourced append-only | Start with optimistic locking + audit; add broker pattern for heavy multi-agent use. |
| Embedding for memories | Same model as documents vs specialized | Same shared embedding model, for consistency with the retrieval subsystem. |
| Bridge with compression | Should compression markers ever auto-promote to memories? | No. Promotion is the agent-proposed path; consent is required. |

---

## What This Design Commits To

- **Atomic facts, not chunks.** Memory records are key-value with embeddings, not slices of source material.
- **Scope is a tuple, not an enum.** The underlying model is `(writer, visibility, persistence)`. The four named scopes (`user`, `persona`, `workspace`, `organization`) are common compositions; `persona × user`, `persona-transient`, and other tuples are also valid. Operator policy decides which compositions are admitted in a deployment.
- **Scope priority chain** as the conflict-resolution mechanism for the common-enum cases: `user > persona > workspace > organization`. For tuple-grammar compositions, priority is determined by the writer authority and visibility specificity.
- **Persistence includes `no-persistence`.** Transient records are first-class — admitted into the working turn but never written to the structured store. They still carry trust labels and respect visibility policy.
- **Writer authority is single-source per record.** "Identity belongs to the creator" applies to MemoryRecord as to all other atomic units; cross-authority mutation is forbidden.
- **Multi-record write atomicity is operator policy.** The architecture commits to the tuple grammar applying per-record; cross-record transactions are an implementation-level concern, not an architectural commitment.
- **Hybrid storage** (structured store + optional transparent file layer).
- **Three creation paths**, all with explicit `source` and `confidence`.
- **Supersession, not deletion.** Updates produce new records; old records are marked superseded for audit.
- **No autonomous mutation.** Agent-proposed facts require user consent. Compression cannot write to memory.
- **Single embedding pipeline** shared with retrieval. No specialized memory embedder.
- **Audit log on every mutation.**
- **Library, not service.** Process-embedded; the structured store is the only shared state.

These are the load-bearing decisions. Push back on any of them before building.
