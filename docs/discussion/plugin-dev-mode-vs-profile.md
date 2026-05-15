# Plugin-dev: mode, profile, or flag?

**Status:** Decided 2026-05-15 — flag (`plugin.enabled`).
**Tracks:** [gobha-me/ai-editor#40](https://github.com/gobha-me/ai-editor/issues/40) Thread 3.
**Depends on:** [profiles-pick-tools.md](profiles-pick-tools.md) (admission inversion changes the available verbs).
**Touches:** [`js/tools/plugin-tools.js`](../../js/tools/plugin-tools.js) (the 4 affected tools), [`js/tools/doc-tools.js`](../../js/tools/doc-tools.js) (co-tagged), [`js/profiles/`](../../js/profiles/).

## Question

`plugin-dev` is special. It's not a job description ("I am a PM") — it's a capability ("I am currently building a plugin and need plugin SDK + doc tools"). The 4 tools registered with `roles: ['plugin-dev']` at [`js/tools/plugin-tools.js:62,111,194,234`](../../js/tools/plugin-tools.js) are currently admitted by zero picker profiles. Once admission inverts, what shape should plugin-dev take?

## Three candidates

- **A profile (`plugin-dev.v1`).** Same as any other picker entry — selects the doc-reading + plugin tools it needs, plus whatever else. User switches to it when working on a plugin.
  - Pro: clean, fits the profile model, no new concept.
  - Con: every user-authored profile that wants plugin tools has to re-list them. The capability isn't reusable across profile shapes.

- **A flag** (`plugin.enabled: true`), modeled after [`scriptAutomation.enabled`](../../js/profiles/coder-v1.js) and [`preview.enabled`](../../js/profiles/coder-v1.js). Any profile can flip it on to add a known group of tools as an overlay.
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

- Whether the plugin SDK track itself is alive enough to justify keeping these tools. If the answer is "no," the tools just get removed and there's nothing to decide here. The LLM-authored automation track shipped Phase 1 at 1.16.0 (see [CHANGELOG.md](../../CHANGELOG.md)), so this is probably still live.

## Decision

**Flag (`plugin.enabled`).** Plugin-dev is a capability anyone can engage as needed, not a job description.

The deciding question — "does someone mid-session in `coder.v1` switch profiles or flip a flag to add plugin tools?" — answers itself once stated. Switching profiles burns the system prompt, budget, scratchpad, and conversation ledger the user has built up; flipping a flag preserves all of it. The user has working state to protect.

The flag overlay also fits the established pattern: `scriptAutomation.enabled` and `preview.enabled` are already-shipped capability flags at [`js/profiles/coder-v1.js`](../../js/profiles/coder-v1.js), and `preview.enabled` in particular is the closest analog — preview tools are a co-located group of read-and-side-effect tools that overlay onto a base profile. `plugin.enabled` slots into that same pattern.

### Acknowledging the tension

The flag answer does cut against the "one axis of admission" framing in [profiles-pick-tools.md](profiles-pick-tools.md). Worth being explicit about why that tension is acceptable:

- The inversion's "one axis" claim is that admission no longer runs through two simultaneous mechanisms (tool tags + profile lists) — the gate is `profile.tools.admit` and nothing else. Capability flags don't violate that — they're a profile-side construct that contributes names to `admit` at filter-time, not a second admission engine that runs in parallel.
- Concretely: `filterTools` reads `profile.tools.admit` plus, when `profile.plugin?.enabled === true`, an additional static set `PLUGIN_TOOL_NAMES = ['plugin_read_docs', 'plugin_run', ...]`. The flag's contribution is a list of names that join the admit-set; it doesn't change *how* admission is decided. Same gate, same shape, slightly wider input on one branch.
- This is the same shape `preview.enabled` already has — preview tools join admission when the flag is set. Adopting `plugin.enabled` is replicating that pattern, not introducing a new admission mechanism.

The flag answer would be wrong if plugin-dev were a deeply-cross-cutting capability with per-tool budget or per-tool system-prompt implications. It isn't — it's four tools that need to coexist with whatever profile is active.

### Rejected: profile, pattern

- **`plugin-dev.v1` (profile candidate)** — rejected because it forces a context-burning switch mid-session. Also defective even when chosen up-front: a user starting in `plugin-dev.v1` loses access to `coder.v1`'s programming tools, so they'd want a `plugin-dev.v1` that inherits from `coder.v1` and adds plugin tools — which is structurally the same as `coder.v1` with `plugin.enabled: true`, only worse (re-declares the inheritance instead of overlaying).
- **Plugin-dev pattern (pattern candidate)** — rejected because patterns (per Paper 2's decision) only seed *new* profiles; they don't graft onto existing profiles. A pattern means a user has to commit to a derived profile before plugin tools are accessible — same context-burning failure as the profile candidate.

## Out of scope (carried forward)

The §Out of scope clause from the original draft stands: this paper does not litigate whether the plugin SDK track itself is alive enough to justify keeping these tools. The 1.16.0 LLM-authored automation track anchors the SDK as a live capability; no removal is on the table.

## Follow-up

- **`plugin.enabled` flag wiring (gitea):** add `plugin: { enabled: boolean }` to the profile schema; teach `filterTools` to union `PLUGIN_TOOL_NAMES` into the admit-set when set; default `false` everywhere except a user-authored profile that opts in.
- **Sweep `plugin-tools.js` + `doc-tools.js`:** drop the `roles: ['plugin-dev']` tags as part of the inversion mechanical sweep (Paper 1 follow-up #1). The plugin tool names get hardcoded in the `PLUGIN_TOOL_NAMES` static list — central definition, single place to maintain.
- **UI:** Settings tab gains a "Plugin development mode" toggle (one checkbox, mirrors `preview.enabled` UX). Lives with the Profile settings.

This work depends on Paper 1's `admit` semantic landing first — there's no point wiring the flag against the current `allowed_groups` array.

## What "done" looks like

- [x] Decision recorded here on which of the three candidates plugin-dev becomes.
- [x] Follow-up filed: gitea#442 (`plugin.enabled` flag schema + `filterTools` overlay + Settings toggle — depends on gitea#438).
- [ ] [`js/tools/plugin-tools.js`](../../js/tools/plugin-tools.js) and [`js/tools/doc-tools.js`](../../js/tools/doc-tools.js) re-tagged (untagged, post-inversion) accordingly — ships with the same sweep.
