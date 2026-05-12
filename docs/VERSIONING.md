# AI Editor — Versioning convention

> **The one-line rule.** Multi-PR / multi-slice work develops in `X.Y.Z.N` (sub-patch); the single `vX.Y.Z` tag fires when the feature is testable end-to-end. Single-PR work that's testable on its own tags directly as `X.Y.Z`.

---

## Why this exists

Through ~2.30 the project burned through minor versions for individual sub-steps of multi-PR arcs:

- The inline-handlers migration shipped Phases 1 + 2a + 2b + 3a + 3b + 4 as six separate `vX.Y.0` tags (`v2.27.0` → `v2.32.0`).
- The 2026-Q2 audit sweep shipped six [S]-sized inventory closures as six more tags (`v2.33.0` → `v2.37.0`-and-counting).

Each individual tag was internally correct, but the cadence ("a release every few hours") shipped intermediate states that weren't testable end-to-end without further commits in the same arc. The release-readiness gate documented in [`ROADMAP.md`](ROADMAP.md) §"Cadence and versioning" was firing on intermediate states because there was no intermediate-state vocabulary.

`X.Y.Z.N` is that vocabulary. The `.N` says "this is in flight; the gate doesn't apply yet."

---

## The convention

### Syntax

`Major.Minor.Patch.N` — four dots. `N` starts at 0 and increments with each commit (or each PR, depending on the arc's natural unit of work) inside the in-flight feature. When the arc is complete and testable end-to-end, drop the `.N` and the final commit lands as `X.Y.Z`. Only that final `X.Y.Z` gets a `vX.Y.Z` git tag.

```
2.40.0.0  → 2.40.0.1 → … → 2.40.0.5 → 2.40.0   (tagged: v2.40.0)
  └──── in-flight; not testable e2e yet ──────┘   └─ release gate fires here ─┘
```

`js/version.js` carries the four-dot stamp during the in-flight phase. The version-coherence lint (when it ships — see ROADMAP Foundations) matches `js/version.js` against the latest `## [X.Y.Z]` heading in `CHANGELOG.md`, so the `[Unreleased]` block stays unpromoted until the final `.N`-strip happens.

### What earns its own `X.Y.Z` tag (no sub-patch needed)

- A single-PR feature that's meaningfully usable on its own push.
- A single-line fix or polish that doesn't require a follow-up.
- Anything where the next push to `main` is the *only* push needed to complete the unit of work.

Examples from the recent history that would still tag directly:
- `2.17.1` — tool-return invisible-Unicode scanning (single-PR fix; no follow-up needed).
- `2.24.1` — event-wiring pair fix (single-PR; closed two inventory entries together).
- `2.10.0` — Tier-3a preview (single PR shipping all 5 new tools at once).

### What should live in `X.Y.Z.N` space until tag-ready

- **Multi-PR feature arcs** — the inline-handlers migration is the canonical example. It would have been:
  ```
  2.27.0.0 (Phase 1 pilot) → 2.27.0.1 (Phase 2a 8 modals) → 2.27.0.2 (Phase 2b 3 modals)
    → 2.27.0.3 (Phase 3a 7 renderers) → 2.27.0.4 (Phase 3b chat/messages.js)
    → 2.27.0.5 (Phase 4 window.* cleanup) → 2.27.0 (tagged: v2.27.0)
  ```
  One arc, one tag, six progress stamps. Today this is six tags (`v2.27.0` through `v2.32.0`); none of the intermediate four were independently testable end-to-end.
- **Sweep waves** — the 2026-Q2 audit sweep should be one tag wrapping the wave (e.g. `2.33.0.0 → 2.33.0.N → 2.33.0`), not one tag per inventory entry closed.
- **Multi-slice DESIGN-doc arcs** — when a DESIGN doc's "Phase 1" itself spans multiple PRs (sub-agents Phase 1 will be ~10–14 files per `docs/DESIGN-sub-agents.md`), the phase develops in `.N`.
- **Anything whose release-readiness gate would fail on intermediate states** — if a 10-turn dogfood in this repo would catch a regression on Phase N because Phase N+1 hasn't landed yet, Phase N belongs in `.N`-space, not on a tag.

### No retroactive renaming

Tags `v2.17.0`–`v2.37.0` exist. They stay. The convention applies forward from adoption (2026-05-12).

---

## Composition with existing feedback memories

Three memories already encode versioning discipline. The X.Y.Z.N convention **layers atop them, does not supersede**:

### `feedback_version_bump.md` — bump `js/version.js` + promote `[Unreleased]` as you go

Still applies. The bump just happens *within* the `X.Y.Z.N` space during the in-flight phase. `[Unreleased]` accumulates entries per sub-step until the final `.N`-strip, at which point `[Unreleased]` promotes to `## [X.Y.Z] - YYYY-MM-DD` and the wave's full per-sub-step rationale lives under that single heading.

**Concretely** — on the inline-handlers arc with the new convention:
- Phase 1 PR commits: `version.js` reads `2.27.0.0`; CHANGELOG `[Unreleased]` gains a "Phase 1 — pilot commit modal" entry.
- Phase 2a PR commits: `version.js` reads `2.27.0.1`; same `[Unreleased]` block gains a "Phase 2a — 8 modals" entry alongside Phase 1.
- … through Phase 4 …
- On the final commit closing the arc: `version.js` reads `2.27.0`; `[Unreleased]` promotes to `## [2.27.0] - YYYY-MM-DD` containing all 6 phases' rationale; tag `v2.27.0` pushes.

### `feedback_no_bump_for_measurement_only.md` — measurement-only PRs accumulate in `[Unreleased]`

Still applies, unchanged. Measurement/probe/benchmark PRs that touch only `tests/` / `docs/` / `CHANGELOG.md` do **not** bump version.js, X.Y.Z.N or otherwise. They land entries directly under `[Unreleased]`, then ride out with whatever the next production-code-path-changing release is (which itself may be an `X.Y.Z` or an `X.Y.Z.N → X.Y.Z` arc).

The `1.7.2` lever-C case from the memory still works the same way: today it would still be a measurement-only stop with no bump; the lever-B production wiring at `1.8.1` is what carried the [Unreleased] block forward.

### `feedback_roadmap_in_track_patches.md` — in-track patches are real milestones

Still applies. In-track patches (`1.1.1` between Foundations `1.1.0` and Compression `1.2.0`) are committed work and must be named in roadmap projections, not skipped.

The new layer: if `1.1.1` itself is non-trivial (multi-PR or sweep-shaped), it may develop in `1.1.1.0 → 1.1.1.N → 1.1.1`. Simple patches still land directly as `1.1.1`. The patch number is real either way.

---

## Tagging discipline

The X.Y.Z.N convention is the **slowdown mechanism on the road to tagging**. The **release-readiness gate** (ROADMAP §"Cadence and versioning") is the **gate at the tag boundary**. Both remain:

- During `X.Y.Z.N` development: no tag push; no release-readiness gate firing; `:dev` Docker tag for PR preview deployments per existing flow.
- At the `X.Y.Z` final commit: the 10-turn dogfood in this repo runs as the gate; on pass, `vX.Y.Z` tag pushes and triggers the Docker tag-push deploy.

The gate is honor-system today (no automation). The dogfood result is recorded on the release tag annotation alongside the bundled-PR list — exactly as documented in ROADMAP.

---

## Decision flow for picking a version stamp

```
Is this a single PR that's testable end-to-end on its own merge?
    │
    ├── Yes → tag directly as X.Y.Z (whichever bump tier per
    │         ROADMAP "Cadence and versioning": patch / minor / major).
    │
    └── No (multi-PR arc, sweep wave, or DESIGN-doc phase that
            spans multiple commits before being independently testable)
          │
          ▼
        Develop in X.Y.Z.N space (start at .0; increment per sub-step).
        Final commit drops the .N; that commit gets the vX.Y.Z tag.
```

Borderline: a "sub-step that *is* technically testable on its own but is part of a larger commitment to a follow-up." Land it on its own tag if the follow-up is genuinely optional; develop in `.N` if the follow-up is committed work that the same arc was committed to.

---

## See also

- [`ROADMAP.md`](ROADMAP.md) §"Cadence and versioning" — semver intent + release-readiness gate.
- [`ROADMAP.md`](ROADMAP.md) §"How to read the bands" — band labels (`[strong]` / `[medium]` / `[fuzzy]`) that classify a milestone's commitment weight, orthogonal to whether it tags directly or develops in `.N`.
- Memory: `feedback_version_bump.md`, `feedback_no_bump_for_measurement_only.md`, `feedback_roadmap_in_track_patches.md`.
