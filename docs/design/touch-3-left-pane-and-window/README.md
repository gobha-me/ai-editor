# CODING AGENTS: READ THIS FIRST

This is a **handoff bundle** from Claude Design (claude.ai/design).

A user mocked up designs in HTML/CSS/JS using an AI design tool, then exported this bundle so a coding agent can implement the designs for real.

## What you should do — IMPORTANT

**Read the chat transcripts first.** There are 2 chat transcript(s) in `ai-editor/chats/`. The transcripts show the full back-and-forth between the user and the design assistant — they tell you **what the user actually wants** and **where they landed** after iterating. Don't skip them. The final HTML files are the output, but the chat is where the intent lives.

**Read `ai-editor/project/Facelift.html` in full.** The user had this file open when they triggered the handoff, so it's almost certainly the primary design they want built. Read it top to bottom — don't skim. Then **follow its imports**: open every file it pulls in (shared components, CSS, scripts) so you understand how the pieces fit together before you start implementing.

**If anything is ambiguous, ask the user to confirm before you start implementing.** It's much cheaper to clarify scope up front than to build the wrong thing.

## About the design files

The design medium is **HTML/CSS/JS** — these are prototypes, not production code. Your job is to **recreate them pixel-perfectly** in whatever technology makes sense for the target codebase (React, Vue, native, whatever fits). Match the visual output; don't copy the prototype's internal structure unless it happens to fit.

**Don't render these files in a browser or take screenshots unless the user asks you to.** Everything you need — dimensions, colors, layout rules — is spelled out in the source. Read the HTML and CSS directly; a screenshot won't tell you anything they don't.

## Bundle contents

- `ai-editor/README.md` — this file
- `ai-editor/chats/` — conversation transcripts (read these!)
- `ai-editor/project/` — the `ai-editor` project files (HTML prototypes, assets, components)

## Note on the 2026-05-08 addendum (Touch 3, follow-on session)

This bundle was originally archived 2026-05-07 with four major surfaces — Left pane v2, PR Review, Merge Conflict Resolver, Window v2 / Sessions. A follow-on session 2026-05-08 added a **fifth** surface to the same `Facelift.html` canvas: **Zip Up / Zip Down** — three scopes, three homes. The new content was re-imported into this directory rather than spun out as a separate touch:

- `chats/chat2.md` — extended with the zip-flow exchange (the existing prefix is unchanged).
- `project/Facelift.html` — adds a `zip-flow` `DCSection` with five artboards.
- `project/zip-flow.jsx` + `project/zip-flow.css` — new component + styles.

The zip-flow design closes the [`docs/design/OPEN-QUESTIONS.md`](../OPEN-QUESTIONS.md) entry filed 2026-05-07 about where Zip Up / Zip Down lives in the new chrome — see that doc's status line.
