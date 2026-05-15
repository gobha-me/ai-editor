# User-built profile trees

**Status:** Draft — paper session not yet held.
**Tracks:** [gobha-me/ai-editor#40](https://github.com/gobha-me/ai-editor/issues/40) Thread 2.
**Depends on:** [profiles-pick-tools.md](profiles-pick-tools.md) (this paper assumes the admission inversion lands).
**Touches:** [`js/profiles/registry.js`](../js/profiles/registry.js), [`js/settings/roles-tab.js`](../js/settings/roles-tab.js) (UI), [`js/core.js`](../js/core.js) (`State.settings`), [`docs/DESIGN-profiles.md`](../docs/DESIGN-profiles.md).

## Question

Once profiles enumerate tools, should users be able to **author their own profiles** — picking a parent (or starting pattern) and customizing — rather than us trying to ship every profile shape we think someone might want?

## Why this matters

`chat` / `coder` / `kb` cover the three context shapes we know about (wide-read+light-write, programming, RAG read-only). They don't cover every shape someone might need — a doc-writer who reads broadly but writes narrowly, a triage profile that reads issues + memory but doesn't touch code, an export profile that reads everything but writes nothing.

Shipping a profile for each is unbounded work. Letting users compose is bounded — we ship the seeds, users grow what they need.

## Two composition shapes

- **Parent-style.** User picks an existing profile (e.g. `coder.v1`) and overrides — adds/removes tools, swaps the system prompt, changes budget. Inheritance via [`js/profiles/inheritance.js`](../js/profiles/inheritance.js) does the work. The result has a `base:` pointer back to the parent.
- **Pattern-style.** A small library of starting templates ("wide-reader", "narrow-writer", "review-only") that a user *forks* — copies into a new standalone profile — when authoring a brand-new base. Not parents, presets. No live link back.

These are not mutually exclusive — patterns can seed new bases; bases can become parents.

## Open questions

- **Persistence.** Per-user (lives in `State.settings`) or per-project (committed to the repo)? Today `State.settings.profile` only stores the active *name* — there's no profile-content storage path. Per-user is the lower-friction default; per-project enables shared team configurations.
- **Picker UX.** Custom profiles inline with `chat` / `coder` / `kb`, or segregated under a "Custom" submenu? Inline is more discoverable but risks visually drowning the curated three.
- **Editor UX.** Where does the "author a profile" form live? Inside the existing Profile settings tab as a "New" button, or a separate modal? What's the minimum-viable editor — just a tool checklist, or also system prompt / budget / sub-agent enablement?
- **Validation.** Cycles in `base:` chains already throw at [`js/profiles/inheritance.js:65`](../js/profiles/inheritance.js). Unknown parent already throws at line 77. What else needs validation at author time — duplicate names, reserved names (`*.v1`)?
- **Migration.** If `pm.v1` / `reviewer.v1` / `full.v1` become user-authorable presets instead of synthetic profiles in the registry, what happens to existing settings pointing at them? The 2.0.0 migration table at [CHANGELOG.md:4337-4430](../CHANGELOG.md) is the precedent.
- **Sharing.** Is there an export/import path? Copying a profile JSON between users seems cheap and useful.

## What "done" looks like

- Decisions on persistence + picker UX + editor scope recorded here.
- A follow-up issue with implementation scope (mechanical: settings storage path, picker render, editor modal).
- [`docs/DESIGN-profiles.md`](../docs/DESIGN-profiles.md) gains a §User-Authored Profiles section.
