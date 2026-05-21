# Intelligence Architecture — Document Set Overview

**Status:** Living index.
**Purpose:** This document is the entry point to the Intelligence architecture design set. It commits to nothing architectural — every load-bearing decision lives in one of the substantive docs cross-referenced below. Read this first to know where to go. Read it again if you get lost.

If you only have ten minutes, read this doc and `DESIGN-intelligence.md`. Those two together give you the shape; the others fill in the load-bearing details for each surface.

---

## The Doc Set

The Intelligence architecture is described by eight canonical design documents. They are peers in their respective domains and connected through the umbrella; each owns a clearly bounded set of decisions and atomic units.

| Doc | Owns | One-line summary |
|---|---|---|
| **`DESIGN-intelligence.md`** | Architectural principles, atomic-unit list, trust labels, the turn-flow contract | The umbrella. Principles (admissibility-not-accumulation, single-writer per atomic unit, falsifiability via diagnostics) and the four-subsystems-plus-two-surfaces taxonomy. |
| **`DESIGN-retrieval.md`** | `ChunkRef`, retrieval strategies, the Composer | How content is chunked, embedded, retrieved by strategy, ordered by the Composer, and admitted as evidence into the prompt. |
| **`DESIGN-memory.md`** | `MemoryRecord`, scope grammar `(writer, visibility, persistence)` | How facts persist across sessions; how Persona, User, Project, Group, and Org compose as scope; how the consent-gated extraction proposal works. |
| **`DESIGN-compression.md`** | `Turn`, the five compression rules, eviction-before-summarization | How conversation history is compacted. Eviction runs as Rules 1–4; LLM summarization is Rule 5, fallback only. |
| **`DESIGN-tools.md`** | `ToolDef`, the discovery protocol, the meta-tools | How tools are admitted via Profile static set, Persona overlay, sticky ledger, and meta-tool discovery. Hidden by default. |
| **`DESIGN-profiles.md`** | `Profile` (surface adapter), prompt assembly, the task ledger | How per-surface variation is expressed (coder / chat / KB / RP). Profile is the assembler of the final prompt but not the author of most slots. |
| **`DESIGN-persona.md`** | `Persona` (identity composition above Profile) | How identity composes above Profile. Persona = Profile + Model + System Prompt contribution. System prompt slot is multi-author (Admin / User / Persona / Profile-directives). |
| **`DESIGN-agent-loop.md`** | Envelope shapes (`success` / `refused` / `cached` / `partial`), the Authorship Rule, cache coordination | How the execution cycle runs after the prompt is assembled. The consumer surface below the four subsystems. |

There are also change documents that record specific amendment rounds:

- `DESIGN-CHANGES-2026-05-08.md` — original 18-item change pack (folded in)
- `DESIGN-CHANGES-2026-05-08-supplement.md` — resolution of the open question that produced `DESIGN-agent-loop.md` plus bookkeeping items B1–B5 (folded in)
- `DESIGN-CHANGES-2026-05-21.md` — T1 tool-authored failure shape contract (folded into `DESIGN-tools.md`); W1–W3 watchlist retained in-doc as the record of deferral

Change documents are historical evidence, not canonical state. The substantive docs above are the authoritative current contract.

---

## How to Read the Set

There are three reasonable reading orders depending on why you're here.

**For orientation (new reader).** Read in this order:
1. This doc.
2. `DESIGN-intelligence.md` — get the principles and the four-subsystems-plus-two-surfaces taxonomy.
3. `DESIGN-profiles.md` — see how the four subsystems get wired together per surface.
4. Then dive into whichever subsystem doc is closest to your concern.

**For implementing one subsystem.** Read in this order:
1. `DESIGN-intelligence.md` §"What This Document Commits To" — the principles your implementation must respect.
2. `DESIGN-intelligence.md` §"Trust Labels on Admitted Content" — the contract for content provenance, which crosses every subsystem.
3. Your subsystem's doc end-to-end.
4. The docs of the subsystems yours interacts with (typically two or three of the others).

**For understanding identity / surface composition.** Read in this order:
1. `DESIGN-profiles.md` — what a Profile is and what it owns.
2. `DESIGN-persona.md` — how Persona composes above Profile.
3. `DESIGN-memory.md` §"Scope as a Tuple, Not an Enum" — how Persona shows up in scope.

---

## The Dependency Graph

```
                       DESIGN-intelligence.md
                       (umbrella: principles,
                        trust labels, turn flow)
                                 │
        ┌────────────┬───────────┼────────────┬────────────┐
        │            │           │            │            │
        ▼            ▼           ▼            ▼            ▼
   retrieval      memory     compression    tools     agent-loop
   (ChunkRef)  (MemoryRecord)   (Turn)    (ToolDef)   (Envelope)
        │            │           │            │            │
        └────────────┴───────────┴────────────┘            │
                            │                              │
                            ▼                              │
                       profiles.md ◄────────────────────────┘
                  (assembler, surface adapter,
                       task ledger)
                            │
                            ▼
                       persona.md
                  (composition above Profile)
```

**Reading the graph:** arrows point in the direction of *concept dependency*, not import-graph dependency. A doc points to a doc whose concepts it consumes. Every subsystem doc points to the umbrella (for principles and trust labels); profiles consumes all four subsystems; persona consumes profiles plus memory and tools (for scope and overlay).

**No definitional cycles.** Each named concept has exactly one owning doc; cross-references point to the owner. The "one atomic unit per subsystem" rule from the umbrella is what prevents cycles — when ownership is unambiguous, mutual references resolve cleanly.

**Concept ownership (the things you most often need to look up):**

| Concept | Owning doc |
|---|---|
| Atomic units (`ChunkRef`, `MemoryRecord`, `Turn`, `ToolDef`) | The subsystem named by the unit. |
| Principles (admissibility, single-writer, diagnostics) | `DESIGN-intelligence.md` |
| Trust labels | `DESIGN-intelligence.md` |
| Turn flow | `DESIGN-intelligence.md` |
| Scope tuple grammar | `DESIGN-memory.md` |
| The five compression rules | `DESIGN-compression.md` |
| Meta-tool discovery protocol | `DESIGN-tools.md` |
| Prompt assembly | `DESIGN-profiles.md` |
| Multi-author system prompt slot | `DESIGN-profiles.md` |
| Profile directives (vs. Persona system prompts) | `DESIGN-profiles.md` |
| Persona composition | `DESIGN-persona.md` |
| Envelope shapes & cache coordination | `DESIGN-agent-loop.md` |
| Authorship Rule (Tools vs agent-loop authoring) | `DESIGN-agent-loop.md` |

If a concept isn't here and isn't obviously in one of the eight docs, that may be a real gap — please flag it rather than inventing the owner.

---

## Architectural Shape, In One Page

The architecture is a stack with two surfaces and four admission subsystems:

**Profiles surface (above the four).** Per-surface adapter that holds compression rules, retrieval strategies, tool defaults, budget allocations. Profile is the *assembler* of the final prompt — it owns slot order, position, and budget — but not the author of most slots.

**The four admission subsystems (the core).**

- **Retrieval** decides what evidence enters the prompt.
- **Memory** decides what persistent facts enter the prompt.
- **Compression** decides how conversation history is compacted before being admitted.
- **Tools** decides which tool definitions enter the prompt.

Each subsystem owns one atomic unit and is the single writer for that unit. Each emits per-subsystem diagnostics covering both admissions and exclusions, with reasons. None of the four mutate another's data.

**Agent-loop surface (below the four).** The execution cycle that runs after the Profile assembles the prompt. Owns envelope shapes (`success` / `refused` / `cached` / `partial`), cache coordination, sub-agent inheritance, and the Authorship Rule that separates loop-authored envelopes from tool-authored failure shapes.

**Persona** sits above Profile as a composition pattern — not a third surface, but a higher-level construct that consumes a Profile and contributes content (system prompt, optional tool overlay) labeled with its identity.

The single load-bearing design statement: *"Does the LLM have the correct context to do as asked — and only that?"* Every subsystem's job is some refinement of that question. The governing principle: *admissibility, not accumulation* — default exclude, admission must be earned, and the why must be recorded.

---

## Standing Conventions

These apply across the doc set:

- **Each doc ends with "What This Document Commits To."** Load-bearing decisions are made explicit and falsifiable. Push back on commitments before building, not after.
- **Configuration vs commitment.** The architecture commits to mechanisms (the slots, the contracts, the constraints). Operators configure policies within those mechanisms. The phrase "the architecture commits to X; the architecture does not commit to Y" appears throughout for a reason.
- **Hints, not prescriptions.** Where multiple valid policies exist (scope compositions, merge orders, trust orderings, retention windows), docs give illustrative examples and explicitly state the architecture is permissive.
- **Identity belongs to the creator.** No cross-minting of IDs across subsystems. The writer of an atomic unit is the single authority over its updates.
- **Docs precede implementation.** Standing project rule. Implementations align to the docs on their next iteration; doc changes ship before code changes.
- **Honest revision over retrofitting.** When new evidence invalidates a prior commitment, the commitment is revised. Past examples: the "three subsystems" commitment walked back to four when Tools forced the question; the original "tool envelope" framing walked back when the Authorship Rule clarified two distinct categories.

---

## Open Questions Across the Set

Items currently deferred and worth knowing about before they bite you:

- **Async learning.** Memory extraction currently runs synchronously at end-of-turn. Whether long-running Personas need an asynchronous learning loop (MAPLE-style) for cross-conversation consolidation is unresolved. Watch for personalization drift in long-running shared-Persona surfaces.
- **Chat / RP / KB profile evidence.** Most quantitative validation of the architecture's commitments comes from coding-agent surfaces. Chat and RP profiles are designed but less empirically validated; KB has the most distinct retrieval orchestration needs and may surface friction first.
- **Persona inheritance.** Whether Personas support base+overrides like Profiles do is deferred until a concrete need surfaces.
- **Cross-Persona handoff within a session.** Whether and how a conversation can switch active Personas mid-session. Currently treated as Profile policy.
- **Group-scope details.** Membership changes, post-departure visibility, write-attribution within a group are named but not fully specified in `DESIGN-memory.md`.
- **The `cache_key_axes` open question** in `DESIGN-agent-loop.md` regarding stateful-read caching.

Each owning doc carries its own "Open Questions" section with the full list for that subsystem. The items above are the ones most likely to cross subsystem boundaries.

---

## Maintaining This Document

This doc should change when:

- A new design doc is added to the set (update the table, the dependency graph, the concept-ownership table).
- A doc is removed or renamed.
- A concept's owning doc changes (the concept-ownership table should always reflect current ownership).
- A new cross-cutting open question emerges that's worth flagging before someone hits it.

This doc should *not* change when:

- A substantive doc's internal content changes but its scope and ownership don't.
- A subsystem evolves its internal contracts.
- Implementation choices change (this doc describes the design, not deployments).

If you find yourself wanting to put load-bearing content here, it probably belongs in one of the substantive docs instead. This document earns its keep by being navigation, not architecture.
