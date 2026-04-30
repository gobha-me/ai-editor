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
- Scoped and priority-ordered (`user > workspace` for Phase 1; `persona` and `organization` deferred — see *Implementation Phases* and the 2026-04-30 kickoff decisions below).
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

## File Format & Conflict Resolution

When the transparent file layer is enabled (opt-in via Settings → Memory), `workspace`-scope memories serialize to `.aieditor/memory/<category>.md` files using a **deterministic key-sorted YAML-frontmatter block** format. One memory record per block, delimited by `---`.

**Format:**
- One frontmatter block per record. Frontmatter keys are emitted in alphabetical order so byte-for-byte equivalent records produce byte-for-byte equivalent serializations.
- Records inside a single category file are sorted by `key` so a workspace's commit history shows clean, semantic diffs rather than reorder-noise.
- String values are JSON-encoded for unambiguous escaping; `value` may be any JSON-serializable type (string, number, object, array).
- An index file `.aieditor/memory/index.md` lists the categories present and the record counts per file, refreshed at every projection write.

**Merge conflict resolution:**
- Two collaborators editing the same key on different branches (or the same user editing on two machines) produce **duplicate `key` values** within a category file when their branches merge. This is the visible artifact of a merge conflict.
- The load-time resolver picks the record with the most-recent `updated_at`; the loser is dropped from the active set but remains visible in Git history for the user to inspect.
- Conflict events surface in the Memory tab as `diagnostics.warnings` so the user can audit what was kept and what was dropped. There is no three-way smart merge — last-write-wins is deterministic and auditable.

**Rationale.** Git-native persistence demands deterministic serialization so concurrent edits manifest as visible merge artifacts (duplicate keys) rather than silent data loss. The YAML format is human-readable; users can inspect, edit, and revert manually if needed.

---

## Data Model (Abstract)

Core fields for each memory fact:

- **scope**: `user`, `workspace` (Phase 1). `persona` and `organization` are deferred — see *Implementation Phases*.
- **owner_id_or_workspace_id**: Single discriminator for the chosen scope. For `user` records this stores the per-origin user owner id (a stable lazy UUID resolved by `getOrCreateUserOwnerId()`); for `workspace` records it stores `${connectionId}/${owner}/${repo}`. One column → one compound index (`by_scope_owner_key`).
- **key**: Short, unique identifier (e.g., `preferred_language`, `auth_approach`, `error_handling_style`). Canonicalized at write time (lowercase, trimmed, ≤256 chars).
- **value**: The factual content. JSON-serializable.
- **category**: `preferences`, `decisions`, `project_context`, `domain_knowledge`, `workflow`.
- **source**: `user_explicit`, `agent_proposed`, `inferred`. Drives the consent flow (agent-proposed proposals require user confirmation; the other two bypass the consent queue) and the UI affordance ("this might be wrong" pill on `agent_proposed` and `inferred`). **No `confidence` float** — `source` carries the same UI signal without going stale the moment the source context shifts.
- **embedding**: Vector of `key: value`, generated via the shared embedding pipeline. Persisted as `number[]` for IDB structured-clone safety; callers wrap in `Float32Array.from()` only for cosine math.
- **superseded_by**: Reference to a newer memory record (supports history and soft deletion). The "head" of a chain has `superseded_by === null`; semantic search and default `list()` return only heads.
- **expires_at**: Optional TTL for ephemeral facts. `null` ≡ no expiry.
- **updated_at**, **created_at**: Epoch milliseconds.
- **md_path**: Reserved for the `.aieditor/memory/*.md` projection target (workspace-scope records only).

An audit log records every mutation (create, update/supersede, soft delete, expire) with actor, reason, and before/after snapshots. Audit entries persist in IDB store `memory_audit` with autoIncrement `seq` so global ordering is asserted by the schema, not by reconstruction.

**Scoping & Access.** Logical scopes determine retrieval priority and default visibility. AI Editor is single-user code-focused, so Phase 1 makes no commitment to RBAC groups; the future `organization` scope (deferred) is the natural seam for orthogonal group-based access control if/when shared deployments emerge.

Retrieval order places `user`-scope memories toward the head of the context window (high attention) and `workspace`-scope memories at secondary priority. The deferred `persona` and `organization` scopes would slot between the two and after `workspace` respectively when they ship.

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
              source="user_explicit")

memory.search(query, scope=None, limit=8)   # leverages retrieval subsystem

memory.get(key, scope)                       # exact lookup by priority chain

memory.update(key, new_value, reason)

memory.propose_from_context(context)         # triggers agent proposal flow
```

**LLM Tool Actions (via system tool-calling):**

- `memory_remember(key, value, category, source)` — Propose or store a fact.
- `memory_recall(query, scope)` — Explicit retrieval.
- `memory_revise(key, new_value, reason)` — Self-healing update.

**Consent & response contract.** `memory_remember` is **tool-result-honest** about whether the fact was actually stored:

- `source='agent_proposed'` → returns `{status: 'pending_consent', candidate_id}`. The candidate is held in the in-memory consent queue; the chat consent card (PR #6) surfaces Accept / Edit / Dismiss to the user. The fact does not enter the store until the user accepts.
- `source='user_explicit'` or `source='inferred'` → returns `{status: 'stored', id}` immediately. No consent prompt; the fact enters the store synchronously.

This contract closes the agent-side hallucination path where a model would otherwise believe a proposal was stored merely because the tool returned successfully.

---

## Management UI

- **Settings → Memory tab** — List/edit personal and workspace memories, toggle the file layer (repo mode), view audit trail, export. Implemented in Preact + htm (PR #5; first Preact consumer per `docs/ROADMAP.md` §Decision 9).
- **Inline `@memory` chip in chat** — Typing `@memory` opens a fuzzy picker of existing memories; selection inserts a `[memory:<key>]` markdown citation token at the trigger site (PR #8). Shares state with the Settings tab via `MEMORY_EVENTS`.
- **Agent-proposed consent card** — When an agent calls `memory_remember` with `source='agent_proposed'`, the card mounts inline in the chat stream with Accept / Edit / Dismiss (PR #6, Touch 1 Flow 1).
- **Commit modal "Memory updates" section** — On commit, pending `.aieditor/memory/*.md` writes show as a parallel section (Flow 3A) on non-protected branches; protected branches show the "Branch off & commit memory" escape hatch (Flow 3B) (PR #7).

The deferred `organization` scope would add Organization Admin (global memories, bulk ops, moderation across groups) when it ships.

---

## Git Integration & Auto-Staging

When the user enables repo mode via Settings → Memory (opt-in toggle), `workspace`-scope memory mutations trigger **auto-staging** of the affected `.aieditor/memory/<category>.md` file for the next commit:

- Auto-staging applies **only to non-protected branches** (Decision §4 in `docs/ROADMAP.md`). On protected branches the commit modal surfaces an escape hatch — "Branch off & commit memory" creates `memory/auto-YYYYMMDD` and commits there.
- The commit modal displays a **Memory updates** section (Flow 3A) showing the staged files and per-file record counts; the user can deselect individual files before committing. Memory edits do not muddy the code-change signal — they live in their own panel, not as a banner.
- The user can disable repo mode at any time. Disabling stops auto-staging; existing memories remain in the structured store but stop projecting to files. Re-enabling resumes projection from the current state of the store.

This is the externally-tellable Git-native-memory story: a user opens a project on a new machine, pulls, and the repo's memories arrive with the code. There is no backend; Git is the transport.

---

## UI Implementation Pattern

The four Memory surfaces (Settings tab, `@memory` chip, consent card, commit-modal section) all follow the same Preact + htm pattern:

- **Slot mounting.** Vanilla code creates a `<div id="…Slot…">` (or fixed-id root for singletons), then calls `mountPreact(slot, Component, props)` from `js/utils/preact-mount.js`. The helper returns a cleanup function that runs `render(null, slot)` to drop the tree.
- **Effect-cleanup for subscriptions.** Components subscribe to `MEMORY_EVENTS` inside `useEffect`; the effect's return value unsubscribes. The mount-wrapper module owns the cleanup function and runs it on tab close / chat clear / conversation switch — no leaked listeners.
- **Custom elements deferred.** `<memory-chip>` style custom-element registration adds shadow-DOM and slot-distribution complexity that doesn't pay off for AI Editor's single-process, single-surface model. Div slots stay the production pattern through 2.0; revisit only if reuse pressure emerges.

---

## Chat Citation Wire Format

When the user picks a memory from the `@memory` chip, a markdown reference token is inserted at the trigger site:

```
[memory:<key>]
```

The token is **visible to the LLM as literal text** and **resolved via the `memory_recall` tool** at the model's option. This shape was chosen over the alternatives because:

- **No invisible structured tags.** A `data-memory-id` attribute on a hidden span is cleaner-looking but adds a render path, a serialization concern, and complicates copy/paste from chat history.
- **No new render path.** The existing markdown renderer already handles the `[…]` syntax. A pill / hover-card affordance is a follow-up polish, not a 1.3.0 commitment.
- **Auditable.** The token shows up verbatim in the conversation export, the session-replay archive (1.3.5), and the cost-dashboard transcript view.

The chip never *resolves* the citation itself — it just inserts the token. Resolution happens when the model decides it needs the underlying value and calls `memory_recall(key)`.

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

**Phase 1 (1.3.0): Core CRUD + `user` & `workspace` Scopes + Transparent File Layer + Agent Proposals**

What ships:
- Structured store (`js/intelligence/memory/`) with IDB backend, embeddings, audit log.
- Transparent file layer at `.aieditor/memory/{index,preferences,decisions,project_context,domain_knowledge,workflow}.md` for `workspace`-scope facts committed to the repo.
- Three creation paths: `user_explicit` (Settings UI + `@memory` chip), `agent_proposed` (chat consent card with Accept / Edit / Dismiss), `inferred` (low-confidence, TTL-bounded).
- Three LLM tools: `memory_remember`, `memory_recall`, `memory_revise`.
- Settings → Memory tab with list/edit/audit views; chat `@memory` chip; commit-modal "Memory updates" section.
- Agent proposals require explicit user consent (no silent writes).

**Phase 2 (deferred indefinitely): `persona` Scope**
Dropped at 1.3.0 kickoff (2026-04-30). Revisit only if `user`-scope memory usage in production reveals cluster patterns that suggest persona-level curation would meaningfully reduce noise. Single-user code-focused editor + 2.0 ships `chat_multi.v1` and `rp.v1` profiles as stubs already, so persona is not load-bearing for the planned profile contract.

**Phase 3 (1.3.x → 1.4.x): Self-Healing & Cross-Device Transport**
Agents rewrite `.aieditor/memory/*.md` files within guardrails (`memory_revise` accepts a `reason`; revisions become audit entries). Cross-device session sync via Git follows the same opt-in toggle as memory's repo mode. Session replay format (1.3.4 in the post-renumbering roadmap) carries memory references through transcripts.

**Phase 4 (post-2.0): `organization` Scope, Expiration Tuning, Advanced Features**
Organization-level scopes with RBAC; clustering over memories via retrieval's thematic strategy; relevance decay; insights dashboard; bulk import; reconciliation tools. Gated on shared-deployment usage emerging.

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
- **Scope priority chain** as the conflict-resolution mechanism: `user > workspace` for Phase 1; `persona` deferred indefinitely; `organization` is post-2.0.
- **Hybrid storage** (structured store + optional transparent file layer). `workspace`-scope memories project to `.aieditor/memory/<category>.md` deterministic key-sorted YAML-frontmatter blocks; merge conflicts manifest as duplicate keys resolved by latest `updated_at` and surfaced in `diagnostics.warnings`.
- **Three creation paths**, all with explicit `source` (`user_explicit` / `agent_proposed` / `inferred`). No `confidence` float — `source` carries the UI signal without going stale.
- **Tool-result-honest consent.** `memory_remember` with `source='agent_proposed'` returns `{status: 'pending_consent', candidate_id}`; the fact does not enter the store until user consent. `user_explicit` and `inferred` bypass the queue.
- **Supersession, not deletion.** Updates produce new records; old records are marked superseded for audit.
- **No autonomous mutation.** Agent-proposed facts require user consent. Compression cannot write to memory.
- **Single embedding pipeline** shared with retrieval. No specialized memory embedder.
- **Audit log on every mutation.**
- **Library, not service.** Process-embedded; the structured store is the only shared state.
- **Chat citation wire format.** `[memory:<key>]` markdown reference. The token is visible to the LLM; resolution happens via `memory_recall` at the model's option. No invisible structured tags.
- **UI mounts via div slots + `mountPreact()`.** Custom elements deferred. The pattern is shared by the four Memory surfaces (Settings tab, `@memory` chip, consent card, commit modal).

These are the load-bearing decisions. Push back on any of them before building.
