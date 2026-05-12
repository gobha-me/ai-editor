# `docs/discussion/` — pre-architecture content

> **One-line rule.** A discussion doc captures thinking that isn't ready to be architecture in any band. Cite a discussion doc only as *"see [`discussion/X.md`](discussion/X.md) for the thinking,"* never as a source of truth.

---

## Purpose

Per the methodology this project adopted on 2026-05-12 (see [`VERSIONING.md`](../VERSIONING.md) for the related X.Y.Z.N convention and the new band labels in [`ROADMAP.md`](../ROADMAP.md)):

> *"Some content isn't ready to be architecture in any band. LLM architecture sessions surface questions faster than the architect can answer them authoritatively; documenting the thinking prevents re-invention, but writing it into the architecture tree — even at fuzzy band — implies a commitment that hasn't been made. These artifacts live in `discussion/` alongside the architecture tree."*

A discussion doc is a **conversation capture with explicit "not a commitment" framing** — "here is the design space we explored," with an explicit list of what is decided now (usually limited to: reserved schema fields and don't-foreclose constraints) and what is deferred.

---

## What goes here

- Design-space-exploration captures that surfaced during a Claude session but didn't land as an architectural decision.
- Questions parked behind "wait for real dogfood signal" — the dogfood is the trigger, the discussion doc preserves the thinking until the trigger fires.
- Open-questions content that would inflate ROADMAP's "Deferred / unscheduled" section past one screen if it lived inline.

## What does NOT go here

- **Shipped designs.** Those live in `docs/DESIGN-*.md` (Scale-2 / Scale-3 design docs per methodology §Scales of Work).
- **Fuzzy-band roadmap items.** Those stay in ROADMAP with `[fuzzy]` band labels. Discussion docs are pre-architecture; fuzzy is architecture-in-sketch.
- **Decisions Jeff has made.** Those land in ROADMAP §"Decisions" or in a DESIGN doc, not here.
- **Per-PR rationale.** That belongs in CHANGELOG.

---

## Movement rules

A discussion doc has three possible exits:

1. **→ fuzzy-band ROADMAP/architecture entry** — the thinking firmed up enough to sketch a direction, and preconditions are visible on the roadmap. Promotion happens during a re-evaluation session (see ROADMAP §"Re-evaluation cadence"). The discussion doc is preserved with a "promoted to ROADMAP §X on YYYY-MM-DD" footer, not deleted (history matters).
2. **→ DESIGN doc** — the thinking promoted past fuzzy directly into a multi-version design arc (skipping medium-band sketch). Rare but legitimate when a real consumer arrives that demands the full ICD now.
3. **→ `docs/deferred/`** — the preconditions slipped past the planned roadmap horizon. Content is preserved, relocated, and clearly marked inactive. (`deferred/` doesn't exist yet; it's bootstrapped when the first item graduates.)

---

## Seed content

Three discussion docs were seeded from existing ROADMAP "Deferred / unscheduled" prose on 2026-05-12:

- [`github-37-phase-2.md`](github-37-phase-2.md) — eight deferred design questions for the project-conventions file (CLAUDE.md analogue) Phase 2; trigger is dogfood signal that surfaces friction around any of the eight knobs.
- [`pr-review-polish.md`](pr-review-polish.md) — four PR Review polish follow-ups parked behind real usage signal post-2.14.0.
- [`touch-3-window-v2-sessions.md`](touch-3-window-v2-sessions.md) — load-bearing thinking on Window v2 / Sessions; the actual Touch 3 design bundle lives at [`docs/design/touch-3-left-pane-and-window/`](../design/touch-3-left-pane-and-window/), this captures the architecture-vs-implementation seams.

Future discussion docs seed from sessions where Claude surfaces an architectural question Jeff isn't yet ready to answer — capture the design space, name the trigger, file here.
