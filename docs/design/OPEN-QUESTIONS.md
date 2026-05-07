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

### 2026-05-07 — Upload / Download Zip — where does the existing zip flow live in Touch 3?

- **Touch:** [#3](touch-3-left-pane-and-window/) (cross-cutting; also touches the [#2](touch-2-facelift/) Top bar + Settings layouts).
- **Surface:** Upload / Download Zip — shipped today via [`js/zip-upload.js`](../../js/zip-upload.js). README §Git lines 57–58: *"Zip upload with batch commit (atomic). Download project/branch as zip."* Today, upload commits the whole zip as one atomic batch on the active branch; download exports the active project / branch as a zip.
- **Question:** Touch 3 didn't include this surface in its brief, but the feature is **shipped, distinguishing, and the user explicitly flagged it as one of ai-editor's best — *"getting a branch in and out is not a feature you see in a lot of places."*** The implementer needs to know:
  1. **Where does Zip Up / Zip Down live in the new chrome?** The Touch 2 top-bar Restructure is locked at 3 actions (Settings / Help / Debug); zip doesn't fit there. Touch 2 Settings has a vertical sidebar grouped Workspace / AI / App; "Workspace → Import / Export" is a candidate. Touch 3's Rail v2 "Branches" view has *Cut release* inline; zip-export-of-branch could sit there as a sibling. Or it stays where it is today (which doesn't appear on any Touch 2/3 mock at all).
  2. **Does it evolve under Window v2 / Sessions?** A *session* in Window v2 = branch + task + chat + open files. **Session import/export as a zip** is a strong narrative fit: download a zip = snapshot the active session; upload a zip = open a session from someone else's snapshot. If yes, the upload-batch-commit semantics may need to change (commit to a *new* branch the session creates, not the active one).
  3. **Does the atomic-batch-commit behavior persist?** Today's upload writes every file in the zip as one commit. Under sessions, that may or may not be right — same call as (2).
- **What we read:** Touch 3 `chat2.md` (no zip mention); Touch 2 `chat1.md` (no zip mention beyond top-bar/settings/chat scoping); `Facelift.html` left-pane v2, top-bar, settings — none surface zip up/down. README §Git confirms it's shipped and named.
- **Screenshots:** TBD — Jeff to capture the current Zip Upload modal + Download project/branch buttons under `docs/design/screenshots/2026-05-07-zip-flow-*.png` before sending to claude.ai/design (the design assistant's own audit screenshots in the Touch 3 bundle don't show this surface).
- **Status:** `open`
- **Code session:** preemptive — not blocking active implementation, filed because Jeff flagged the gap on 2026-05-07 after the Touch 3 archive PR ([#314](https://git.gobha.me/xcaliber/ai-editor/pulls/314)) merged. No fresh design work depends on the answer yet, but any 1.x extraction (A. branch switcher, B. ▶ Start, C. Files Now-strip) and any post-2.0 Window v2 work would.
