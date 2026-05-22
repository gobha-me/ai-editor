# METHODOLOGY: Coherence at Speed

**Operational form** of the methodology described in *Coherence at
Speed* (Smith & Claude Opus 4.7, 2026). The whitepaper provides
framing and justification; this document is for in-project reference
by humans and by Claude Code (or equivalent) sessions.

**Version:** 1.1 (operational, derived from whitepaper v1.4)
**Date:** May 2026

---

## How to read this document

- **Starting a code session?** Read §1 (Quick Reference) and §13.2
  (Code Session quickstart). Skim §6 (Phase 2). Open the architecture
  doc and the relevant ICD before writing code.
- **Starting an architecture session?** Read §1, §2–4, and §13.1.
- **Starting a re-evaluation session?** Read §1, §7, and §13.3.
- **Starting a new project?** Read §16 (Minimum Viable Adoption)
  first.

---

## 1. Quick Reference

**Three roles. Never share a session.**

- **Architect** (human) — defines constraints, ratifies patterns,
  approves plans.
- **Implementer** (LLM code session) — writes code/tests within
  approved plan.
- **Reviewer** (either) — evaluates delta between plan and
  artifact.

**Document hierarchy.** Everything traces upward:

```
architecture/    → source of truth
  ↓
roadmap.md       → sequenced plan, milestones labelled by band
  ↓
design/*.md      → multi-version arcs
  ↓
icd/*.md         → single-version contracts
  ↓
code + tests     → traced to ICD or design doc
```

**Commitment gradient.** Three bands:

- `[strong]` — load-bearing for next N milestones (default; need not
  be labelled). Comply as written.
- `[medium]` — directional for N+1 through M. Shape committed,
  details tighten as implementation approaches.
- `[fuzzy]` — sketch for work beyond M. Not a constraint.

Defaults: **N=3, M=7**. Project-tunable.

**Four phases.** Run concurrently, not sequentially:

1. **Phase 0:** Architecture + roadmap (before first code session).
2. **Phase 1:** ICDs for each component boundary.
3. **Phase 2:** Implementation loop (plan → approve → implement →
   test → merge).
4. **Phase 3:** Re-evaluation every 3–5 milestones (paper half +
   code-aware half).

**Four non-negotiable rules for code sessions:**

1. Nothing commits without a test.
2. Justify any change against the existing design.
3. Plan approved by human before implementation begins.
4. ICD deviations recorded in the ICD, in the same PR.

---

## 2. Roles

### Architect (human)

**Does:** system shape, trust boundaries, extension points,
sequencing, trade-offs. Approves plans before code is written.
Ratifies patterns. Runs re-evaluation.

**Does NOT:** write implementation code while in the Architect role.
Mix architecture and code work in one session.

### Implementer (LLM code session)

**Does:** writes source code, tests, migrations, CI config. Works
within constraints defined by the architecture, design docs, and
ICDs. Reads relevant docs at session start.

**Does NOT:** make structural decisions. If a structural question
arises mid-session, asks rather than invents. Modifies architecture
or ICDs (except for the deviation subsection per rule 4 below).

### Reviewer

Either role, performed in a separate session from the one that
produced the work. Evaluates whether the artifact matches the plan
and the relevant docs. Produces gap analyses.

---

## 3. Document Hierarchy

Suggested layout (adapt to project conventions):

```
project-root/
├── architecture/             # Source of truth
│   ├── overview.md
│   ├── data-model.md
│   ├── auth.md
│   └── ...                   # Each file scoped by concern
├── roadmap.md                # Sequenced plan, banded milestones
├── design/                   # Multi-version arcs
│   └── v0.5-notes.md
├── icd/                      # Single-version contracts
│   ├── api-items.md
│   ├── api-folders.md
│   └── ...
├── discussion/               # Pre-architectural thinking
│   └── ...
├── deferred/                 # Post-horizon archive
│   └── ...
└── METHODOLOGY-coherence-at-speed.md   # This file
```

**Traceability rules:**

- Code contradicts ICD → code is wrong.
- ICD contradicts architecture → ICD needs updating through an
  architecture session, never silently.
- Architecture is silent on the question → write to architecture
  before answering in code.

---

## 4. Commitment Gradient

### Band definitions

| Band | When | Authority |
|------|------|-----------|
| `[strong]` | Load-bearing for work in next N milestones. | Comply as written. Deviation requires architecture session. |
| `[medium]` | Directional for N+1 through M. | Treat as "we're building toward this," not as binding constraint on today's code. |
| `[fuzzy]` | Sketch beyond M, or with unknown preconditions. | Do not cite as a constraint. Leave questions open. |

**Default is strong.** Unlabelled section = strong-band. If in
doubt, label medium.

### Section label syntax

Place the band in the section header:

```
## 3. Authentication and Sessions
## 4. Composition Framework [fuzzy]
## 5. Sidecar Protocol [medium: 0.5–0.8]
```

The range form (`[medium: 0.5–0.8]`) names the milestone window the
section applies to.

### Roadmap milestone label syntax

```
- [ ] 0.5.3 db.batch() and silent mode          [strong]
- [ ] 0.5.4 plinth.events table, delta sync     [strong]
- [ ] RE-EVAL following 0.5.x                   [rewrite session]
- [ ] 0.6.0 Shell bootstrap and frame           [strong]
- [ ] 0.7.x Composition framework               [medium]
- [ ] 1.0   Plugin marketplace                  [fuzzy]
```

**Rule:** a milestone inherits the **weakest band** of any
architectural section it depends on. A milestone depending on three
strong sections and one fuzzy section is `[fuzzy]`.

### Band propagation

Bands slide as the project progresses. Re-evaluation moves content
through these transitions:

- `discussion/` → `[fuzzy]` (when preconditions become visible)
- `[fuzzy]` → `[medium]` (entering M-milestone window)
- `[medium]` → `[strong]` (entering N-milestone window)
- `[strong]` → `[medium]` (rare; intervening milestones invalidated
  precise wording but directional commitment survives)
- any band → `deferred/` (milestone slipped past horizon)

---

## 5. Phase 0 — Architecture and Roadmap

**Output:** architecture document(s), roadmap, optional design
documents for multi-version arcs.

### Architecture document checklist

- [ ] System design — components, boundaries, data flow.
- [ ] Trust model — auth, authorization, who can do what.
- [ ] Extension/plugin points — how the system grows.
- [ ] Data model — entities, relationships, storage.
- [ ] Security constraints — what must never happen.
- [ ] Non-functional requirements — performance, deployment, scale.
- [ ] Every section that isn't obviously strong-band is labelled.

The architecture document is a **constraint system**, not a
specification. It tells future sessions what the walls are so they
do not need to guess.

### Roadmap checklist

- [ ] Each milestone is sized for one code session.
- [ ] Each milestone is testable in isolation.
- [ ] Each milestone traces to an architecture section.
- [ ] Each pending milestone is labelled with its weakest-band
      architectural dependency.
- [ ] Re-evaluation items appear as first-class entries at the
      chosen cadence (e.g. every 3–5 code milestones).

---

## 6. Phase 1 — Interface Contracts (ICDs)

**Output:** one ICD per component boundary.

### ICD contents

- API endpoints — method, path, request shape, response shape,
  error codes, auth requirements.
- Data types — field names, types, constraints, nullability.
- SDK/client contracts — method names, parameter types, returns.
- Event contracts — event names, payload shapes, ordering
  guarantees.

### When to write an ICD

Any time a component crosses a boundary that another component (or
session) will reference: frontend ↔ backend, service ↔ service,
plugin ↔ kernel, public API. The ICD takes 30 minutes. The
duplicate-implementation debug cycle that an absent ICD produces
takes 2–4 hours per occurrence and recurs.

### ICD template

```markdown
# ICD: <boundary name>

## Endpoints

### POST /api/items
**Request:**
```json
{ "name": "string", "folder_id": "string" }
```
**Response (200):**
```json
{ "id": "string", "name": "string", "created_at": "string" }
```
**Errors:** 400 (validation), 401 (auth), 404 (folder).

## Data types
...

## Notes
...

## Implementation deviations
[populated as deviations occur, in the same PR as the deviation]
```

---

## 7. Phase 2 — Implementation Loop

**Output:** code + tests, merged.

### Loop

```
Review docs + plan
     ↓
Plan the work → human approval
     ↓
Create branch → implement + write tests
     ↓
CI passes? → no: fix, retry
     ↓ yes
Change affects docs/ICD? → yes: update docs (same PR)
     ↓
Merge → next roadmap item
```

### The four non-negotiable rules

**1. Nothing commits without a test.**
Tests are a forcing function: they make the LLM understand what it
built well enough to prove it works. Without tests, future sessions
inherit code they cannot safely modify.

**2. Justify the change.**
When code evolves or requirements shift: why? Does architecture or
ICD need updating? A change that cannot be justified against the
existing design is either wrong or requires an architecture session
to evolve the design.

**3. Approval before implementation.**
Present the plan first: what files, what changes, why. The human
approves, rejects, or redirects. No file mutations before approval.

**4. ICD deviations recorded in the ICD, same PR.**
If the shipped body differs from the committed interface (simpler
form, scoped-down errors, stand-in signature, postponed
sub-feature), add an "Implementation deviation" subsection to the
ICD in the same PR. Not in CHANGELOG only. Not in code header only.
Not in a follow-up "when there's time."

### ICD deviation subsection template

```markdown
## Implementation deviations

### POST /api/items — synchronous body
**Shipped:** synchronous handler, returns full object inline.
**Per ICD:** asynchronous, returns 202 + job_id with separate
status endpoint.
**Reason:** no async caller exists yet; the queue infrastructure
this depends on isn't landing until milestone 0.7.0.
**Closes when:** 0.7.0 lands; rewrite handler against the original
ICD contract. Tracked on roadmap as 0.7.1 follow-up.
```

---

## 8. Phase 3 — Re-evaluation

**Output:** updated architecture, updated roadmap, gap analysis.

**Cadence:** every 3–5 code milestones (project decision; declare
and schedule). Re-evaluation appears as a roadmap item, not a
between-milestones convention.

### Two halves, both required by default

**Paper half (structural re-evaluation):**

- [ ] Read architecture + roadmap.
- [ ] Promote `[medium]` content now in N-window → `[strong]`,
      tightening wording.
- [ ] Promote `[fuzzy]` content whose preconditions arrived →
      `[medium]`.
- [ ] Demote/relocate content whose milestone slipped.
- [ ] Re-band roadmap milestones based on dependency changes.
- [ ] **Forward ICD presence check.** For every pending `[strong]`
      milestone in the next-N window: does its ICD exist? If not,
      either demote the milestone or schedule an ICD-authoring slot
      ahead of it.

**Code-aware half (gap analysis):**

- [ ] Read code as it exists: source, ICDs as implemented,
      handlers, test coverage.
- [ ] Check strong-band architecture sections against the code that
      claims to implement them.
- [ ] Find architectural decisions embedded in code comments that
      should be promoted to the architecture document.
- [ ] Find interfaces in code that aren't documented.
- [ ] Find tests missing for claims made in architecture.
- [ ] Produce gap analysis; file as roadmap items, `discussion/`
      entries, or architecture updates.

**Skipping the code-aware half:** only with explicit reason
recorded in the re-evaluation entry on the roadmap. Default is yes.

---

## 9. Scales of Work

| Scale | Example | Documentation | Code session freedom |
|-------|---------|---------------|----------------------|
| **Single-line** | "Fix CSS cursor on attach button." | Roadmap line is the spec. | Full. |
| **Multi-version arc** | "Notes extension v0.11.0 → v0.11.10" | Design doc. | Bounded by current version; aware of arc. |
| **Architecture arc** | "Sidecar tier" — new capability across kernel, extensions, auth, deployment. | Design doc + architecture addendum + ICD(s). | Minimal; design doc dictates. |

### Design doc decision

```
Describable in one sentence?  ── yes ── Single-line item.
       │
       no
       │
Spans multiple versions?  ── no ── ICD if it crosses boundaries;
       │                            no design doc.
       yes
       │
Each version builds on the previous?  ── no ── Roadmap grouping
       │                                       suffices.
       yes
       │
       DESIGN DOC REQUIRED.
```

### Design doc must contain

1. **What has already been decided** — data model, components,
   patterns established by earlier versions. Do not revisit.
2. **What this version is responsible for** — scope, entry criteria
   (what must exist from prior versions), exit criteria (what must
   work when this version ships).
3. **What must be left open** — decisions belonging to later
   versions. Explicit "do not decide this yet" constraints. *The
   most important and most commonly omitted part.*

---

## 10. Caller-Triggered Implementation Pattern

Use when the interface can be decided now but the body's correctness
depends on a consumer that doesn't yet exist.

**Shape:** ICD ships full interface in committed form. Body ships
stubbed, hardcoded, or in simplest conforming form. Fill-in gated
on a *named* future trigger (a specific milestone or specific
caller, not "when we need it").

**Distinct from "wait for a caller."** Some practices defer the
interface until a concrete caller exists. Caller-triggered commits
to the interface now so future callers can code against it; only
the body waits. See §13 (keyword-prior override) for why this
distinction is framed in behavioral terms rather than by invoking
the historical name for the contrast practice.

**Not speculative abstraction.** Speculative abstraction builds
*machinery* on a hypothesis. Caller-triggered defers the body and
ships only the contract.

**Obligations:**

1. Interface must be real enough for future callers to code
   against. A stub that leaks wrong error codes or wrong return
   shape defeats the purpose.
2. Trigger must be named on the roadmap or in the ICD (or both).
3. If shipped body deviates from committed interface, the ICD
   records it in the same PR (rule 4 from §7).

Re-evaluation surfaces caller-triggered implementations whose
trigger has arrived but whose body is still stubbed; the fill-in
goes on the roadmap.

---

## 11. `discussion/` — Pre-Architectural Content

For thinking that isn't ready to be architecture in any band.

**A `discussion/` document is a *conversation capture* with
explicit "not a commitment" framing.** Describes the design space
explored. Lists what was decided (usually limited to: reserved
schema fields, don't-foreclose constraints). Lists what remains
deferred. The architecture may cite it as "see `discussion/X.md`
for the thinking," never as a source of truth.

**Movement out of `discussion/`** happens when preconditions become
visible on the roadmap: content moves into the architecture tree at
`[fuzzy]` band, then slides through the gradient as implementation
approaches.

---

## 12. `deferred/` — Post-Horizon Content

For content whose implementing milestone slipped past the roadmap
horizon (beyond M).

### Entry conditions

Content lands in `deferred/` through deliberate movement during a
re-evaluation session. Three paths:

1. **Milestone slip past horizon.** The implementing milestone was
   rescheduled to beyond M (or removed from the roadmap with no
   near-term replacement).
2. **Architecture change invalidates the section's premise.** A new
   decision elsewhere means this section no longer fits the current
   direction.
3. **Long-fuzzy without movement.** A fuzzy-band section has been
   fuzzy for several re-evaluations without precondition arriving.
   Rare — usually long-fuzzy content stays at fuzzy because the
   conceptual anchor is still wanted.

### `deferred/` header note template

Every file relocated to `deferred/` carries this note at the top:

```markdown
> **Deferred:** 2026-05-15
> **Reason:** Milestone 0.8.0 (composition framework) rescheduled
> to beyond horizon at re-eval following 0.6.x.
> **Status at deferral:** [fuzzy] in active tree.
> **Reactivation trigger:** roadmap returns composition work to
> M-window.
```

### Possible outcomes

1. **Reactivation** — a new roadmap item brings the implementing
   milestone back into range. Content returns to the active tree at
   `[fuzzy]` (precise wording has gone stale); re-bands as
   implementation approaches.
2. **Obsolescence** — subsequent architecture renders the deferred
   content irrelevant. *Delete* the deferred file. Leave a brief
   note in the related active section: "Previously considered: see
   removed `deferred/X.md` (deleted at 2026-08-01, obsoleted by
   decision in §3.4 of architecture/data-model.md)."
3. **Indefinite preservation** — content stays as historical
   record. Periodic re-evaluation passes glance over `deferred/`
   and ask: still operative, or obsolete? If obsolete, delete with
   citation.

### What does NOT belong in `deferred/`

- **Shipped suboptimal code.** That is technical debt (TD) or
  architectural debt (AD). It lives with the code; if material, it
  gets a paydown item on the roadmap.
- **Pre-architectural thinking.** That lives in `discussion/`
  (entry side of the gradient). `deferred/` is the exit side.
- **Ideas brainstormed but never pursued.** Those go in
  `discussion/` if worth preserving as design-space exploration,
  or get deleted.

`deferred/` becoming a junk drawer is a known failure mode (§13.4).
Maintain the boundaries.

---

## 13. Failure Modes — Quick Reference

Recognize these patterns. The mitigations are the structural
responses; the *avoidance* is the discipline of the methodology.

| Failure | Recognise it by | Mitigation |
|---------|-----------------|------------|
| Duplicate implementation | Three handlers parse same data three ways. Two endpoints return same object with different field names. | Phase 1 ICD. All layers trace to one contract. |
| Context drift | Forgets design decisions from earlier in this or prior sessions. | Read architecture + ICD at session start. |
| Plausible-but-wrong | Code compiles, looks reasonable, violates an unstated assumption. | Tests required. State assumptions explicitly in architecture. |
| Scope creep | Adds features not requested. | Plan approval gate (Phase 2 rule 3). |
| Structural drift | Architectural decisions made mid-implementation because question came up. | Code session implements; architecture session decides. Hard boundary. |
| Confident incorrectness | States as fact something wrong about an API or runtime. | CI/tests for behaviour. Architecture session verifies system-design claims against code. |
| Sycophantic agreement | Agrees with human even when it contradicts the design. | Document is authority, not most recent message. Flag conflicts. |
| "Not mine, pre-existing" dismissal | Observes a defect outside current scope, classifies it as not-its-responsibility, proceeds without recording. | Dismissal requires evidence: attribution (git blame), symptom (reproducible), recommended classification. Resolution deferred to human. |
| Keyword-prior override | Doc invokes a well-known term (YAGNI, DRY, KISS, single-responsibility) to draw a contrast; LLM pattern-matches the keyword and applies its training-data meaning, ignoring the doc's local framing. Behaves as the keyword typically prescribes despite the doc saying "not this." | Lead with structural contrast (the *behavior*, not the *label*). Reference the keyword only as historical anchor, never as a foil. Project conventions live in memory, not as named keywords in the methodology. |
| Local optimisation | Convenient choice now, blocks a future version. | Multi-version design doc with explicit "do not decide yet" constraints. |
| Architecture inflation | Strong-band wording accumulates faster than implementation can pressure-test. | Use bands honestly. Pre-architectural thinking goes to `discussion/`. |
| Re-evaluation drift | Phase 3 defined but not scheduled. Sliding window stops sliding. | Schedule re-eval as first-class roadmap items. |
| Silent architectural divergence | Code drifts from architecture; tests pass because they validate code against itself, not against the doc. | Code-aware re-evaluation. |
| Undocumented deviation | Deviation in code header or CHANGELOG; ICD unchanged. | Phase 2 rule 4. Deviation in owning ICD in same PR. |
| Missing ICD on the near horizon | `[strong]` milestone has no ICD; code session blocks on pickup. | Forward ICD presence check during re-evaluation. |
| `deferred/` as junk drawer | TD, brainstorms, and pre-arch musings parked in `deferred/`. Directory becomes untrustworthy. | `deferred/` is post-horizon architecture only. TD lives with code; brainstorms in `discussion/`. Header note required. |

---

## 14. Session Quick-Start

### 14.1 Architecture Session

**You are:** the human Architect, in conversation with an LLM
acting as drafting partner. Output is architecture, design docs,
ICDs, or roadmap changes.

**Open:**

- [ ] Read current architecture, roadmap, and relevant ICDs.
- [ ] State the question or scope this session is addressing.

**During:**

- [ ] Decide bands honestly: strong only if load-bearing in next N.
- [ ] Move pre-architectural thinking to `discussion/`, not into
      the architecture tree at any band.
- [ ] If a decision belongs to multiple versions, write a design
      doc with explicit "do not decide yet" constraints.
- [ ] If a boundary is introduced or changed, write/update the
      ICD.

**Close:**

- [ ] Every change committed to the docs (architecture, design,
      ICD, roadmap) before the session ends.
- [ ] Roadmap milestones re-banded if architectural dependencies
      changed.
- [ ] Re-evaluation items still scheduled at the chosen cadence.

### 14.2 Code Session

**You are:** an LLM Implementer. Output is code, tests, and (when
relevant) ICD deviation subsections.

**Open:**

- [ ] Read the architecture section(s) relevant to this milestone.
- [ ] Read the relevant ICD(s).
- [ ] If a design doc covers this version's arc, read it.
- [ ] Check for project code conventions (in project memory, in a
      `CONVENTIONS.md`, or wherever the project keeps them). If
      conventions relevant to this work — naming, readability,
      comment philosophy, language idioms — are missing or
      unclear, pause and ask the human before planning. Persist
      their answers to the project's conventions store so future
      sessions inherit them. This is especially important for new
      projects where the conventions don't yet exist; the first
      session is expected to surface the question, not invent
      conventions from training defaults.
- [ ] If anything else is unclear or contradictory, surface it
      before planning. Do not invent.

**During:**

- [ ] Produce a plan: what files, what changes, why. Wait for
      human approval before mutating files.
- [ ] On approval: create branch; implement; write tests
      alongside.
- [ ] If you observe a defect outside this scope, do NOT silently
      dismiss it. Record attribution evidence (git blame/commit),
      symptom evidence (reproducible context), and recommended
      classification. Surface to the human before proceeding.
- [ ] If you find a structural question, ask the human; do not
      decide unilaterally.
- [ ] If the shipped code deviates from the ICD, update the
      ICD's "Implementation deviation" subsection in this PR.

**Close:**

- [ ] CI passes.
- [ ] Tests cover the changes.
- [ ] All doc updates (ICD deviations, etc.) in the same PR.
- [ ] Plan-vs-shipped delta noted in PR description if material.

### 14.3 Re-evaluation Session

**You are:** the human Architect with an LLM partner. Output is
updated docs and a gap analysis. This is a *different session*
from the code sessions whose work is being audited.

**Open:**

- [ ] Read architecture, roadmap, recent design docs, recent
      ICDs.
- [ ] Identify what has changed since the last re-evaluation.

**During — paper half:**

- [ ] Promote `[medium]` content now in N-window → `[strong]`;
      tighten wording.
- [ ] Promote `[fuzzy]` content whose preconditions arrived →
      `[medium]`.
- [ ] Relocate slipped content to `deferred/` with header note.
- [ ] Re-band affected roadmap milestones.
- [ ] Forward ICD presence check.

**During — code-aware half (default yes):**

- [ ] Read the code as it actually exists.
- [ ] Check strong-band architecture against code that claims to
      implement it.
- [ ] Note: architectural decisions embedded in code comments;
      interfaces in code not in any ICD; tests missing for
      architectural claims.
- [ ] Produce gap analysis.

**Close:**

- [ ] All movements documented (band changes, relocations).
- [ ] Gap-analysis findings filed: roadmap items, `discussion/`
      entries, or architecture updates as appropriate.
- [ ] Next re-evaluation scheduled on roadmap.

---

## 15. Conventions

### File paths

- `architecture/*.md` — architecture sections.
- `roadmap.md` — sequenced plan.
- `design/*.md` — multi-version design docs.
- `icd/*.md` — interface control documents.
- `discussion/*.md` — pre-architectural thinking.
- `deferred/*.md` — post-horizon archive.

### Section labels (bands)

- Default (unlabelled) = `[strong]`.
- `[medium]` or `[medium: 0.5–0.8]` (with milestone window).
- `[fuzzy]`.

Place in section header:

```
## 4. Composition Framework [fuzzy]
```

### Roadmap milestone labels

```
- [ ] 0.5.3 db.batch()                  [strong]
- [ ] 0.7.x Composition                 [medium]
- [ ] RE-EVAL following 0.5.x           [rewrite session]
```

Re-evaluation entries are first-class roadmap items.

### ICD deviation subsection (in the ICD file)

```markdown
## Implementation deviations

### <endpoint or contract name> — <one-line summary>
**Shipped:** what actually ships.
**Per ICD:** what the contract committed to.
**Reason:** why the deviation was taken.
**Closes when:** named trigger (specific milestone or caller),
not "when we need it."
```

### `deferred/` header note (top of relocated file)

```markdown
> **Deferred:** <date>
> **Reason:** <which entry path of §12, with specifics>
> **Status at deferral:** <band the content had>
> **Reactivation trigger:** <named condition or 'none expected'>
```

### `discussion/` document framing (top of file)

```markdown
> **Discussion document — not a commitment.**
> Captures design-space exploration as of <date>.
> Decisions made: <usually limited to reserved fields, don't-foreclose
> constraints>.
> Deferred: <what remains open>.
```

---

## 16. Minimum Viable Adoption

For a project starting from scratch, the highest-leverage subset:

1. **Write the architecture document before the first code
   session.** Even a rough one. The LLM will be roughly 3× more
   consistent with it than without it.
2. **Write the ICD for your most-touched boundary.** Document the
   shape once. Reference it in every session that touches it.
3. **Require tests.** Tell every code session: nothing merges
   without a test.
4. **Write a design doc for anything spanning 3+ versions.** Save
   the re-architecture session that version 4 would otherwise
   require.
5. **Label the bands.** Strong is default; label medium and fuzzy
   explicitly. Label every pending milestone by its weakest
   architectural dependency.
6. **Schedule re-evaluation on the roadmap.** Every 3–5
   milestones. Both halves by default.

Everything else in this document refines these six. If you adopt
nothing else, adopt these.

---

*End of methodology.*
