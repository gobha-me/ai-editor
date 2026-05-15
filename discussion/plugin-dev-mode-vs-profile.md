# Plugin-dev: mode, profile, or flag?

**Status:** Draft — paper session not yet held.
**Tracks:** [gobha-me/ai-editor#40](https://github.com/gobha-me/ai-editor/issues/40) Thread 3.
**Depends on:** [profiles-pick-tools.md](profiles-pick-tools.md) (admission inversion changes the available verbs).
**Touches:** [`js/tools/plugin-tools.js`](../js/tools/plugin-tools.js) (the 4 affected tools), [`js/tools/doc-tools.js`](../js/tools/doc-tools.js) (co-tagged), [`js/profiles/`](../js/profiles/).

## Question

`plugin-dev` is special. It's not a job description ("I am a PM") — it's a capability ("I am currently building a plugin and need plugin SDK + doc tools"). The 4 tools registered with `roles: ['plugin-dev']` at [`js/tools/plugin-tools.js:62,111,194,234`](../js/tools/plugin-tools.js) are currently admitted by zero picker profiles. Once admission inverts, what shape should plugin-dev take?

## Three candidates

- **A profile (`plugin-dev.v1`).** Same as any other picker entry — selects the doc-reading + plugin tools it needs, plus whatever else. User switches to it when working on a plugin.
  - Pro: clean, fits the profile model, no new concept.
  - Con: every user-authored profile that wants plugin tools has to re-list them. The capability isn't reusable across profile shapes.

- **A flag** (`plugin.enabled: true`), modeled after [`scriptAutomation.enabled`](../js/profiles/coder-v1.js) and [`preview.enabled`](../js/profiles/coder-v1.js). Any profile can flip it on to add a known group of tools as an overlay.
  - Pro: composable with any profile shape, mirrors the existing capability-flag pattern.
  - Con: introduces a second axis of admission (profile list + flag overlays), which is what the inversion is trying to flatten.

- **A pattern.** Per [user-built-profile-trees.md](user-built-profile-trees.md), patterns are starting templates a user forks. A "plugin-dev" pattern seeds a new profile pre-loaded with the plugin SDK + doc tools.
  - Pro: no new concept; user picks it like any other starter.
  - Con: not reusable as an overlay on top of an existing profile (have to fork, can't graft).

## The deciding question

Is plugin-dev a *role someone takes on for a session* (use a profile) or a *capability anyone can engage as needed* (use a flag)?

If someone working in `coder.v1` decides mid-session to add a plugin, do they:
- Switch profiles (and lose `coder.v1`'s system prompt + budget + ledger context)?
- Flip a flag (and keep everything else)?

The flag answer is the one that doesn't ask the user to throw away their working state. That's a real ergonomic argument for the flag path — but it does fight the inversion's "one axis of admission" story.

## Out of scope

- Whether the plugin SDK track itself is alive enough to justify keeping these tools. If the answer is "no," the tools just get removed and there's nothing to decide here. The LLM-authored automation track shipped Phase 1 at 1.16.0 (see [CHANGELOG.md](../CHANGELOG.md)), so this is probably still live.

## What "done" looks like

- Decision recorded here on which of the three candidates plugin-dev becomes.
- If profile or pattern: a follow-up to author it.
- If flag: a follow-up to add `plugin.enabled` to the profile contract + wire the overlay through `filterTools`.
- [`js/tools/plugin-tools.js`](../js/tools/plugin-tools.js) and [`js/tools/doc-tools.js`](../js/tools/doc-tools.js) re-tagged (or untagged, post-inversion) accordingly.
