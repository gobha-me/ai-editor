# Profiles pick the tools

**Status:** Draft — paper session not yet held.
**Tracks:** [gobha-me/ai-editor#40](https://github.com/gobha-me/ai-editor/issues/40) Thread 1 + Thread 4.
**Touches:** [`docs/DESIGN-profiles.md`](../docs/DESIGN-profiles.md), [`js/profiles/registry.js`](../js/profiles/registry.js), [`js/profiles/inheritance.js`](../js/profiles/inheritance.js), [`js/tools/registry.js`](../js/tools/registry.js), every file in [`js/tools/`](../js/tools/).

## Question

Should we invert the admission model so that **profiles declare which tools they admit**, instead of tools declaring (via `roles: [...]`) which profiles they serve?

## Why this is on the table

The current model — tools tag themselves with role names, profiles passively match via array overlap at [`js/profiles/registry.js:252`](../js/profiles/registry.js) — produces three failure modes that all share the same root:

- Tools quietly elected into the wrong profile (`create_issue` reachable from `chat.v1` only because of a `'pm'` tag the user never sees).
- Tools quietly dead (`plugin-dev`-tagged tools admitted by zero picker profiles).
- Inheritance that diverges rather than narrows ([`js/profiles/coder-v1.js:263`](../js/profiles/coder-v1.js) replaces `chat.v1`'s `['all', 'pm', 'reviewer']` with `['all', 'coder']` wholesale).

In all three cases the bug is invisible at the gate. Inverting the model makes the gap visible at profile-definition time: a tool is either listed in a profile or it isn't.

## Shape of the inversion

- Drop `roles: [...]` from every tool registration. Drop the required-field check at [`js/tools/registry.js:65`](../js/tools/registry.js).
- Replace `profile.tools.allowed_groups` with `profile.tools.admit` — an explicit list of tool names (and/or a wildcard sentinel; see Thread 4).
- Rewrite [`js/profiles/registry.js:252`](../js/profiles/registry.js) `filterTools` to look up names instead of intersecting tag arrays.
- Teach [`js/profiles/inheritance.js`](../js/profiles/inheritance.js) to deep-merge tool lists — children should be able to *narrow* the parent's `admit` without restating the whole thing (add/remove operations, not wholesale replace).

## Open: Thread 4 — default state for new tools

When a contributor registers a new tool, what's the admission default?

| Option | Pro | Con |
|--------|-----|-----|
| **Default ON** (auto-admits everywhere) | Zero contributor friction | Silently widens every profile; eats `kb.v1`'s read-only safety property |
| **Default OFF** (admitted nowhere) | No surprise widening | Contributors must update profile lists; oversights produce dead tools (current failure, relocated) |
| **Default per-category** (tools declare `category`, profiles opt into categories) | Implicit enrollment + safety boundary | Adds back something tag-shaped at one level up; partial inversion |

No recommendation yet — surface in the session.

## What "done" looks like

- A decision recorded in this file (or a successor) on the inversion shape and the default-state question.
- A follow-up issue / sub-issues filed for the mechanical sweep + inheritance helper rewrite.
- [`docs/DESIGN-profiles.md`](../docs/DESIGN-profiles.md) §Inheritance updated to reflect the new semantic (deep-merge with add/remove on tool lists).
