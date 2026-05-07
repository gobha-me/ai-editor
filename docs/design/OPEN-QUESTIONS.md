# Design — open questions (backfeed pipeline)

This is the bridge between **code sessions** (Claude Code implementing designed surfaces) and **design sessions** (claude.ai/design refining the spec). When an implementer hits a design ambiguity that the bundled deliverable doesn't answer, they append an entry here. The repo owner (Jeff) reads it, captures any needed screenshots, and routes the question back to claude.ai/design — answers land in the relevant touch's `chats/` directory or as an addendum file alongside the original deliverable.

The point is to **avoid building the wrong thing**: cheaper to ask than to ship a wrong default and walk it back.

## When to file an entry

File when *all* of these are true:

- You're implementing a surface from one of the design touches (`docs/design/touch-{1,2,3}-*/`).
- The bundle's chat transcript + Facelift.html / Memory Design.html / component files don't answer the question.
- The question is about **what the design should be**, not about how to wire it (wiring is the implementer's call).
- A reasonable default would be load-bearing — i.e. picking wrong means redoing the surface, not just polishing it.

Don't file for:
- Pure implementation choices (Preact vs raw DOM, where state lives, file naming).
- Questions that can be answered by reading the design canvas or transcript more carefully.
- Things you can ask the user inline in the current session.

## Format

Append entries below in this shape. Newest at the top.

```
### YYYY-MM-DD — <surface name> — <one-line question>

- **Touch:** #1 / #2 / #3 (link to the relevant `docs/design/touch-N-*/` dir)
- **Surface:** the specific designed surface (e.g. "PR Review · sticky review dock")
- **Question:** what's ambiguous + why it matters
- **What we tried / read:** which transcript section, which component, what default we considered
- **Screenshots:** paths under `docs/design/screenshots/<YYYY-MM-DD>-<slug>-*.png`, if any
- **Status:** `open` → `sent-to-design` → `resolved (link)`
- **Code session:** branch / PR ref so the answer can come back to the right place
```

## Backfeed loop

1. Implementer appends an `open` entry, attaches screenshots under `docs/design/screenshots/`, opens (or continues) the PR.
2. Jeff reviews on next pass: bundles the question + screenshots, takes them to claude.ai/design, captures the response.
3. The design response lands as a new file in the relevant touch's directory:
   - Quick clarifications: append to an `addendum.md` in the touch's root (create on first use).
   - Substantive design rework: a new transcript file `chats/chatN.md` plus any updated component files.
4. Implementer flips status to `resolved (link to addendum / chat)` and continues. Old screenshots stay under `docs/design/screenshots/` as evidence of what was asked.

## Constraints worth knowing before filing

- **Project rule:** "DESIGN docs are the contract" — when implementation diverges from a DESIGN doc, the doc updates first, then the code. Same applies to design touches: an addendum lands before the code that depends on it merges.
- **Memory rule:** small clarifications are appended to the touch's addendum; substantive new direction goes in a new chat transcript so the *intent* is preserved, not just the conclusion.
- **No self-answering:** if you can answer the question by reading the bundle more carefully, do that — but record what you read so future implementers don't re-walk the same trail.

## Entries

_(none yet — first entry establishes the screenshot folder layout)_
