# Profiles pick the tools

**Status:** Decided 2026-05-15 — paper session held.
**Tracks:** [gobha-me/ai-editor#40](https://github.com/gobha-me/ai-editor/issues/40) Thread 1 + Thread 4.
**Touches:** [`docs/DESIGN-profiles.md`](../DESIGN-profiles.md), [`js/profiles/registry.js`](../../js/profiles/registry.js), [`js/profiles/inheritance.js`](../../js/profiles/inheritance.js), [`js/tools/registry.js`](../../js/tools/registry.js), every file in [`js/tools/`](../../js/tools/).

## Question

Should we invert the admission model so that **profiles declare which tools they admit**, instead of tools declaring (via `roles: [...]`) which profiles they serve?

## Why this is on the table

The current model — tools tag themselves with role names, profiles passively match via array overlap at [`js/profiles/registry.js:252`](../../js/profiles/registry.js) — produces three failure modes that all share the same root:

- Tools quietly elected into the wrong profile (`create_issue` reachable from `chat.v1` only because of a `'pm'` tag the user never sees).
- Tools quietly dead (`plugin-dev`-tagged tools admitted by zero picker profiles).
- Inheritance that diverges rather than narrows ([`js/profiles/coder-v1.js:263`](../../js/profiles/coder-v1.js) replaces `chat.v1`'s `['all', 'pm', 'reviewer']` with `['all', 'coder']` wholesale).

In all three cases the bug is invisible at the gate. Inverting the model makes the gap visible at profile-definition time: a tool is either listed in a profile or it isn't.

## Shape of the inversion

- Drop `roles: [...]` from every tool registration. Drop the required-field check at [`js/tools/registry.js:65`](../../js/tools/registry.js).
- Replace `profile.tools.allowed_groups` with `profile.tools.admit` — an explicit list of tool names (and/or a wildcard sentinel; see Thread 4).
- Rewrite [`js/profiles/registry.js:252`](../../js/profiles/registry.js) `filterTools` to look up names instead of intersecting tag arrays.
- Teach [`js/profiles/inheritance.js`](../../js/profiles/inheritance.js) to deep-merge tool lists — children should be able to *narrow* the parent's `admit` without restating the whole thing (add/remove operations, not wholesale replace).

## Open: Thread 4 — default state for new tools

When a contributor registers a new tool, what's the admission default?

| Option | Pro | Con |
|--------|-----|-----|
| **Default ON** (auto-admits everywhere) | Zero contributor friction | Silently widens every profile; eats `kb.v1`'s read-only safety property |
| **Default OFF** (admitted nowhere) | No surprise widening | Contributors must update profile lists; oversights produce dead tools (current failure, relocated) |
| **Default per-category** (tools declare `category`, profiles opt into categories) | Implicit enrollment + safety boundary | Adds back something tag-shaped at one level up; partial inversion |

No recommendation yet — surface in the session.

## Decision

### Thread 1 — invert admission

**Invert.** Profiles enumerate the tools they admit; tools carry no role/admission metadata.

Concretely:
- New profile field `profile.tools.admit: string[]` — an explicit list of tool names (the empty list is valid and means "no tools"; the sentinel `'*'` is reserved for `full.v1` and any user-authored super-profile).
- Drop the `roles: [...]` field from every tool registration and the required-field check at [`js/tools/registry.js:65`](../../js/tools/registry.js). Tools no longer self-elect.
- Rewrite [`filterTools` at `js/profiles/registry.js:252`](../../js/profiles/registry.js) to do a name-set lookup against `profile.tools.admit` instead of intersecting `_registeredRoles` ∩ `allowed_groups`.
- Teach [`js/profiles/inheritance.js`](../../js/profiles/inheritance.js) to deep-merge `admit` with explicit add/remove operations (`admit_add: [...]`, `admit_remove: [...]`) so children can narrow without restating the parent's list.
- Synthetic `'all'` self-tagging on tools goes away — there is no longer a special case at the admission gate.

**Why this shape, restated tersely.** The three failure modes in §Why share one root: tag overlap is invisible at the gate. Inverting makes the gap visible at profile-definition time. The 1.7.0 AST chunker retired the token-cost argument that originally motivated narrow admission; narrowing now serves focus and safety, both of which reward a clarity-forward model.

### Thread 4 — default state for new tools

**Default OFF.** A newly-registered tool is admitted by no profile until a profile lists it explicitly. The three trade-offs from the table above resolve as follows:

- **Default ON is disqualifying.** `kb.v1` invested in a read-only safety property (Phase 2, shipped 2.8.0). Default ON would silently widen `kb.v1` every time a tool with side effects lands in `js/tools/`, eating that property. Recovering it would require a per-profile audit step at every tool addition — exactly the contributor-cost we're trying to keep low elsewhere.
- **Default per-category is partial inversion.** It re-introduces a tag layer at the category level. The structural failure mode (silent admission via tag overlap) survives at lower resolution — the contributor still has to remember which category a tool belongs to, and a mis-categorized tool still admits silently.
- **Default OFF relocates the failure but makes it loud.** A contributor adds a tool, forgets to list it in any profile, and the model can't call it from any profile. The first test run or first session surfaces this fast (model says "I don't have a tool to do X" or simply can't find it in the tool list) — unlike today's silent wrong-profile admission, which only surfaces when a specific dogfood path hits it (as github#40 itself shows).

The contributor cost of Default OFF is real but bounded: at tool-registration time, the registry can emit a console warning naming the new tool with the suggested phrasing for adding it to a profile. The check belongs in `ToolRegistry.register` (post-inversion), keyed off the result of scanning all loaded profiles. The warning is dev-affordance only; CI doesn't fail on it (avoiding the "every PR has an `admit:` churn" trap).

## Follow-up

After the paper PR merges, the mechanical sweep ships as one or more gitea issues:

1. **Invert admission semantic** — rename `allowed_groups` → `admit`, rewrite `filterTools`, teach `inheritance.js` `admit_add` / `admit_remove`, sweep `js/tools/*` to drop `roles:`, update [`docs/DESIGN-profiles.md`](../DESIGN-profiles.md) §Inheritance. Tests for narrowing-not-diverging at `coder.v1 ← chat.v1`.
2. **Default-OFF dev warning** — `ToolRegistry.register` warns when a newly-registered tool name appears in no profile's `admit`. Console only, not a CI failure.
3. **Picker / system-prompt audit** — every profile in [`js/profiles/`](../../js/profiles/) gets a hand-curated `admit` list; the `create_issue` paper-cut that opened github#40 closes by `coder.v1.admit` including `create_issue`.

Each follow-up references this file and github#40. The "Roles" → "Profiles" UI rename (Thread 5 from github#40 body) ships as a fourth, independent issue — pre-shippable.

## What "done" looks like

- [x] A decision recorded in this file on the inversion shape and the default-state question.
- [x] Follow-up issues filed: gitea#438 (admission inversion / mechanical sweep), gitea#439 (default-OFF dev warning), gitea#440 (picker / system-prompt audit — closes paper-cut), gitea#441 ("Roles" → "Profiles" UI rename — independent).
- [ ] [`docs/DESIGN-profiles.md`](../DESIGN-profiles.md) §Inheritance updated to reflect the new semantic (deep-merge with add/remove on tool lists) — ships with the mechanical sweep, not this paper.
