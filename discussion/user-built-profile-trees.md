# User-built profile trees

**Status:** Decided 2026-05-15 — direction confirmed; implementation deferred to Phase 4 (authoring API).
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

## Decision

**Yes, in direction; implementation deferred to Phase 4.** This paper records the design shape so when the Phase 4 authoring API picks it up it doesn't re-litigate. No code lands from this paper session.

The Phase 4 framing matters: per `project_phase2_profiles_lookup_only.md`, the picker is pinned at `['chat.v1', 'coder.v1', 'kb.v1']` for ai-editor and the chat-multi / role-play profile shapes were deprioritized. User-built profiles aren't an ai-editor-2.x deliverable — they're the authoring-API track. What this paper does is set the contract so when that track opens, the shape is decided.

### Sub-decisions on the open questions

- **Persistence: per-user.** `State.settings.profiles: Record<string, ProfileDef>` holds user-authored profile content; `State.settings.profile` (the active name) keeps its current meaning. Per-project (committed) is a follow-on with no current demand; a JSON export/import path (below) covers the team-sharing use case cheaply.
- **Picker UX: inline, curated-first.** User profiles appear in the same picker as `chat.v1` / `coder.v1` / `kb.v1`, with the curated three sorted first and a divider above user-authored entries. No "Custom" submenu (avoids the ghetto). The picker stays a flat list — sub-menus add navigation cost the picker can't afford.
- **Editor UX (MVP):** a "New profile" button inside the existing Profiles settings tab opens an inline editor (not a separate modal — modals nested inside settings get awkward). MVP fields: `name`, `base:` (dropdown of existing profiles incl. synthetics), `admit:` (multi-select tool checklist driven by `ToolRegistry.list()`), and `systemPrompt:` (textarea, defaults to inherited). Budget and sub-agent enablement are **v2** — adding them is mechanical once the editor exists; shipping without them avoids overcommitting Phase 4 scope.
- **Validation:** reject `*.v1` reserved names (synthetic-profile namespace); reject duplicate names case-insensitively; existing cycle-check at [`js/profiles/inheritance.js:65`](../js/profiles/inheritance.js) and unknown-parent check at `:77` carry forward unchanged. Name validation runs at editor save, not at load (so a stored profile from a future schema doesn't trip an older client).
- **Migration:** `pm.v1` / `reviewer.v1` / `full.v1` **stay** as synthetic profiles in the registry — they don't become user-authorable presets. They remain available as `base:` targets for user profiles (so a user can write `my-pm` with `base: 'pm.v1'`) but stay out of the user-facing picker. The 2.0.0 migration precedent at [`CHANGELOG.md`](../CHANGELOG.md) doesn't recur because the registry shape doesn't change for these synthetics — only their picker-visibility status, which is already curated by the pinned list.
- **Sharing: JSON export/import in the Profiles tab.** A per-profile "Export" button writes `{ name, base, admit, systemPrompt, budget? }` to clipboard or download; an "Import" button (or paste field) validates and inserts. Defer until Phase 4 ships the editor; if not enough users ask for it, defer indefinitely.

### Out of scope for this paper

- Profile **authoring API** wire format beyond MVP fields (e.g. `tools.admit_add` / `admit_remove` overlay semantics, sub-agent enablement, per-tool budget overrides). These live in Phase 4's own paper when that track opens.
- Touch-3 design engagement integration. Per `project_design_engagement.md` Touch 3 is in flight as of 2026-05-07 and has not been received yet; user-authored profiles UX gets reviewed at that touch.
- Project-committed profile sharing (the "per-project" persistence option). Recorded as a follow-on; not blocking.

## Follow-up

- **Phase 4 placeholder issue (gitea):** "User-authored profiles — Phase 4 authoring API." Body links this paper as the authoritative design record; no scope or timeline pinned. Filed so the Phase 4 cohort can find the decisions without searching.
- **No issues filed against ai-editor 2.x.** This is by design — user-built profiles aren't an ai-editor 2.x deliverable.

## What "done" looks like

- [x] Decisions on persistence + picker UX + editor scope recorded here.
- [ ] Phase 4 placeholder issue filed (after paper PR merges) — non-blocking, no schedule.
- [ ] [`docs/DESIGN-profiles.md`](../docs/DESIGN-profiles.md) gains a §User-Authored Profiles section — ships with the Phase 4 authoring API, not this paper.
