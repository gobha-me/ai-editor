# ICD — Tool registry admission contract

> **⚠️ Superseded — 2.54.0 (gitea#438):** the admission model documented below was **inverted** in 2.54.0. The pre-2.54.0 model (tool-side `roles: [...]` tags + profile-side `tools.allowed_groups` intersection + `Profiles.getKnownGroupTags()` derivation + `_registeredRoles` enrichment + `LEGAL_GROUP_TAGS` validation) is **retired entirely**. The new model: profiles enumerate explicit tool names in `tools.admit`, with `'*'` for full bypass and `'<prefix>__*'` glob entries for MCP. Inheritance gains `admit_add` / `admit_remove` operators for narrow/widen-without-restating. The composer-side `user_groups` / `required_groups` filter is correspondingly a no-op (the catalog produces empty `required_groups`). See [`docs/DESIGN-profiles.md`](DESIGN-profiles.md) §"Inheritance > Tool admission" for the post-inversion contract + [`docs/ICD-profiles-registry.md`](ICD-profiles-registry.md) (ICD #8) for the profile-side admission contract that supersedes this one; this ICD is preserved as historical record of the prior boundary the 2.54.0 PR retired.

> **📎 Post-supersedence note — non-admission registration facets continue to evolve.** The `ToolDefinition` descriptor passed to `ToolRegistry.register()` is the same shape as pre-2.54.0 minus the retired `roles` / `_registeredRoles` fields, and is still the registration-site contract for tool authors. Subsequent additions land here without re-opening the admission ICD: **2.71.0** added an optional `cache: 'by-args' | 'never'` field to retire the cache-classification whack-a-mole pattern across 4 prior recurrences (gitea#301 / github#39 / 2.10.0 Tier 3a / gitea#472). The lifting decision lives next to the tool author at registration rather than one-or-two files away in `tool-classifications.js`; the cache axis itself is documented at [`docs/ICD-chat-handlers.md`](ICD-chat-handlers.md) §"The five axes › Cache axis — dup-detection" (the runtime consumers via `isStatefulRead(name)` / `getStatefulReadToolsLive()` accessors in [`js/chat/tool-classifications.js`](../js/chat/tool-classifications.js) union the legacy `STATEFUL_READ_TOOLS` const with the registry-driven `cache: 'never'` set). The lint guard [`tests/test-tool-cache-classifications.mjs`](../tests/test-tool-cache-classifications.mjs) source-scans `js/tools/*.js` registration blocks and requires explicit classification for stale-prone tool-name shapes (`list_*` / `find_*` / `get_*` / `*_status` / `*_logs`) via a `STALE_PRONE_NAME_ALLOWLIST` escape hatch. Future non-admission `ToolDefinition` extensions follow the same pattern: declare next to the tool, surface the question to authors via a lint guard, cross-reference back here. **This ICD's scope (admission contract) stays superseded — it does not absorb the new facets.**

> **Status:** initial draft, RE-EVAL following 2.46.0. Third subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #3. Tracks the admission contract that lives across `js/tools/registry.js` + `js/profiles/registry.js` as it stands at 2.46.0. Prior ICDs ([`ICD-chat-handlers.md`](ICD-chat-handlers.md) target #1, shipped 2.42.0; [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md) target #2, shipped 2.45.0) consume this contract — the Composers admit a *subset* of what this registry exposes. Code-aware findings from authoring feed back to ROADMAP as `[strong]`-band rows in the next code minor; **one** surfaces this pass (see §"Code-aware findings").

## Purpose

Tool admission has two declaration sites that must stay in lockstep:

- **Tool side** — at registration, each tool declares `roles: 'all' | string[]`. The tag set carves the tool into one or more admission groups.
- **Profile side** — at definition, each profile declares `tools.allowed_groups: string[]` (with `'*'` reserved as a wholesale wildcard). The set says which groups this profile may invoke.

The runtime gate (`ToolRegistry.checkRoleAccess` → `Profiles.filterTools`) admits a tool when its declared groups overlap with the active profile's allowlist. Three carve-outs short-circuit this — `'all'` on the tool side, `'*'` on the profile side, and `'full'` as a legal-but-never-declared admin-tier tag. **This ICD freezes the carve-out semantics so a future migration doesn't quietly drop one.**

The contract was implicit and inline across two files until the 2.34.0 derivation lift (`LEGAL_GROUP_TAGS` hardcode → `Profiles.getKnownGroupTags()`) opened the boundary; the 2.0.0 profile flip earlier (`Roles.filterTools` → `Profiles.filterTools`) re-keyed the admission delegate. The two prior ICDs use this contract as substrate — ICD-intelligence-composers §"Authorization axis" delegates to `isAuthorized` which mirrors the same `'full'` / `'all'` short-circuits; ICD-chat-handlers §"Composer-vs-non-Composer path drift" pins both system-prompt and API-tool-array paths reading through `Profiles.filterTools`.

## The seam at a glance

| | Tool side | Profile side |
|---|---|---|
| **File** | [`js/tools/registry.js`](../js/tools/registry.js) | [`js/profiles/registry.js`](../js/profiles/registry.js) |
| **Declaration field** | `definition.roles: 'all' \| string[]` | `Profile.tools.allowed_groups: string[]` |
| **Validation site** | `register()` lines 59–119 — throws on missing/invalid | None at definition; validation happens at first `filterTools` call when an unknown profile name falls back to `chat.v1` with a console.warn |
| **Stored form** | `definition._registeredRoles: string[]` (always normalized to array, even when source was `'all'`) | Profile object retained by reference; `allowed_groups` read directly each filter call |
| **Public namespace** | `ToolRegistry` (default export object) + `scanToolReturn` (named) | `Profiles` (namespace export) + named exports (`get`, `has`, `list`, `filterTools`, `getKnownGroupTags`) |
| **Carve-outs admitted at this layer** | `'all'` (universal) + `'full'` (legacy admin-tier, never declared by a profile) | `'*'` (wholesale wildcard, declared by `full.v1` only) |
| **Anti-regression test** | [`tests/test-tools-registry-legal-groups.mjs`](../tests/test-tools-registry-legal-groups.mjs) — pins the post-2.34.0 derived-tag set against the pre-2.34.0 hardcode | [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs) — pins `Profiles.filterTools` byte-for-byte against the legacy `Roles.filterTools` |

## The five classification axes

Each axis names a question the seam answers across both sides. The first three axes (Declaration, Admission, Bypass) describe *what gets admitted*; the last two (Failure, Diagnostics) describe *what's surfaced about the decision*.

| Axis | Question | Tool side | Profile side |
|---|---|---|---|
| **Declaration axis** | Where does an admission tag come from, and what's the legal-tag set? | `definition.roles: 'all' \| string[]` at `register()` — required; missing throws. Normalized to `_registeredRoles: string[]` on store. | `tools.allowed_groups: string[]` at profile definition. Legal-tag union derives from `Profiles.getKnownGroupTags()` at 2.34.0 — `new Set(['all', 'full'])` seeded + every profile's `allowed_groups` (excluding `'*'`). Pre-2.34.0 this was a hardcoded `LEGAL_GROUP_TAGS` inline in `registry.js` that silently shadowed profile-side additions. |
| **Admission axis** | What gates a candidate? | `_registeredRoles` includes `'all'` → admit unconditionally. Otherwise: tool admits when `_registeredRoles` ∩ profile's `allowed_groups` is non-empty. | `allowed_groups` includes `'*'` → admit ALL definitions (wholesale bypass). Otherwise: per-tool intersection check (above). |
| **Bypass axis** | What special cases short-circuit the intersection? | `'all'` on the tool side — universal-default; ~50% of tools (every read-only tool, plus `plan_step` / `ask_user`). Tag is allowed in `getKnownGroupTags()` but no profile declares it. | `'*'` on the profile side — only `full.v1` uses it (mirrors the pre-2.0.0 `'full'` role's unfiltered `Roles.filterTools` path). Legal-tag `'full'` is permitted at register-time for typo validation but never appears in any profile's `allowed_groups` — 4 tools today use it (`context-tools.js:203`, `memory-tools.js:318`/`:535`, `doc-tools.js:96`). |
| **Failure axis** | How does admission failure surface? | `register()` throws on missing `roles`, non-`'all'`/non-array shapes, or unknown tags. Register-time fatal — preserves typo discipline. | `checkRoleAccess()` returns `{ allowed: false, reason }` with operator-friendly reason (names the profile, the tool, the legal tag list, and the remediation hint). `execute()` wraps it and returns `{ error: reason }` to the LLM. Profile-name fallback (unknown `profileName` → `chat.v1`) is **soft** with a `console.warn`. |
| **Diagnostics axis** | What's surfaced about the decision? | `console.log` on register / re-register / unregister (with normalized roles). `EventBus.emit('tools:unregistered', { name })` on removal — consumed by `js/intelligence/tools/embeddings.js` to drop stale find-tool side-table entries. | `getStats()` returns `{ total, byRole: { profileName → admittedCount } }` keyed on `Profiles.list()` (excludes synthetics — chat / coder / kb only). The `_registeredRoles` is retained on each def so downstream Composer-side `user_groups` derivation can read the same source. |

Eleven exports across the seam carry these five axes. The asymmetry (5 axes × 11 exports) mirrors prior ICDs: each axis encodes a distinct *question*, but the exports carry their axis answers as fields on shared records (`ToolDefinition._registeredRoles`, `Profile.tools.allowed_groups`) rather than as separate exports per axis.

## Per-export contract

### `ToolRegistry.register(name, handler, definition)` ([registry.js:59](../js/tools/registry.js))

**Signature:** `(string, ToolHandler, ToolDefinition) → void`. Sync. Throws.

**Validation (strict, in order):**
1. `definition.roles` must be present (throws "missing required `roles` field").
2. `definition.roles` must be `'all'` (literal string) OR `string[]` — anything else throws ("invalid `roles` field").
3. Every entry in the normalized `toolRoles` must appear in `Profiles.getKnownGroupTags()` — invalid entries throw with the valid-tag list inline. **2.34.0 boundary.**

**Side effects:**
- Stores `enrichedDefinition` with `type: 'function'` (forced) and `_registeredRoles: toolRoles` (normalized).
- Re-registers under the same name silently replace the prior entry (logged with `♻️`).
- `console.log` on first-register / re-register; no event emitted on register (asymmetric with `unregister`'s event).

**Invariants:**
- `_registeredRoles` is always an array, never a literal `'all'` — the carve-out is encoded inside the array (`['all']`).
- Register order is preserved in `this.definitions` — `getDefinitions()` returns insertion-ordered, which the Composer's source-axis logic relies on.

### `ToolRegistry.unregister(name)` ([registry.js:128](../js/tools/registry.js))

**Signature:** `(string) → boolean`. Sync. Idempotent.

**Side effects:**
- Removes from both `handlers` Map and `definitions[]`.
- Emits `EventBus.emit('tools:unregistered', { name })` only when something was actually removed. Listeners (find-tool embeddings) drop their entries; the event's name field is the canonical key, not a ToolID — listeners that need ID resolve via Catalog's deterministic mapping.

**Invariants:**
- Calling for an unknown name returns `false`, no event, no log.
- The MCP bridge's disconnect flow (`js/plugins/mcp-bridge.js`) is the primary caller — admission cleanup for MCP tools is by-name, never by-ID.

### `ToolRegistry.checkRoleAccess(name)` ([registry.js:159](../js/tools/registry.js))

**Signature:** `(string) → { allowed: boolean, reason?: string }`. Sync. Pure.

**Lookup:** Reads `ConversationManager.getEffectiveProfileName()` (2.8.0 — per-chat profile binding wins over `State.settings.profile`), then delegates to `Profiles.filterTools([def], profileName)`. A single-tool array filter is the read shape — admission for the def under question lives in the returned array's length (0 = denied, 1 = allowed).

**Failure reason format:** Profile name + tool name + legal-tag list + remediation hint. Operator-visible; threaded through `execute()` → `{ error }` → LLM.

**Invariants:**
- Unknown tool name returns `{ allowed: true }` — the "not found" error fires later inside `execute()` so a single error path stays canonical.
- The legacy `'full'` short-circuit is preserved via `full.v1`'s `allowed_groups: ['*']` — `checkRoleAccess` never special-cases the `'full'` tag itself; `filterTools` handles it via the `'*'` branch.

### `ToolRegistry.execute(name, args)` ([registry.js:192](../js/tools/registry.js))

**Signature:** `(string, object) → Promise<{ result } | { error, code? }>`. Async. Never throws.

**Pipeline:**
1. Role gate via `checkRoleAccess`. Denial returns `{ error: reason }` without invoking the handler. The `console.warn` includes a 🚫 prefix and the profile name — operator-visible.
2. Handler lookup. Missing handler returns `{ error: "Unknown tool: '<name>'. Use get_project_tree or list_issues to see what's available." }`.
3. Handler invocation. Result must be non-null/non-undefined — empty returns are converted to `{ error: "Tool '<name>' returned no result. This is a bug — please try a different approach." }`.
4. Invisible-Unicode scan via `scanToolReturn(name, result)` — attaches `result._security.invisibleUnicode` in-place when findings exceed the 10 MB byte budget guard. PR #296 / 1.6.12 introduced narrower per-tool scans; the registry-wide scan landed alongside the wrap-marker work.
5. Structured error translation. `EditorError` with `recoveryHint` flows through `{ error: "<msg>. <hint>", code }`. Legacy HTTP-status (404/403/409/422) and timeout fallbacks each produce LLM-actionable messages.

**Invariants:**
- The role gate runs *before* handler lookup — denied tools never reach the handler. Composer-side admission is admissibility-shaping; this is the runtime hard gate.
- Every error path produces a string `error` field; downstream chat-loop code (`handlers.js`) discriminates on presence of `error`, not on shape. Maintaining this invariant is load-bearing across `ICD-chat-handlers.md`'s envelope contract.

### `ToolRegistry.getDefinitions()` ([registry.js:249](../js/tools/registry.js))

**Signature:** `() → ToolDefinition[]`. Sync. Returns live reference.

**Returns:** The unfiltered insertion-ordered list. Mutating the returned array would mutate the registry — callers must treat as read-only. Used by the Composers (read-only) and by `getToolsForProfile` (read + filter).

### `ToolRegistry.getToolsForProfile(profileName?)` ([registry.js:272](../js/tools/registry.js))

**Signature:** `(string?) → ToolDefinition[]`. Sync. Pure (returns a fresh array).

**Default profile name** reads `ConversationManager.getEffectiveProfileName()` (2.8.0 — per-chat binding wins over settings global).

**Delegation:** Calls `Profiles.filterTools(this.definitions, name)`. The 2.0.0 slice-3 flip renamed this from `getToolsForRole(roleId)`; the legacy-alias deprecation shim **was retired** but the registry's class docstring still claims it "is preserved below" — see §"Code-aware findings".

### `ToolRegistry.filterReadOnly(defs)` ([registry.js:437](../js/tools/registry.js))

**Signature:** `(ToolDefinition[]) → ToolDefinition[]`. Sync. Pure.

**Orthogonal to admission.** Plan Mode (github#25) wants a tool subset constrained to non-mutating reads regardless of profile-level admission. **2.76.0 (gitea#480)** migrated the filter rule: source of truth shifted from the opt-in `def.readOnly === true` flag to `side_effects` classification consulted via `getSideEffectByName` ([`js/intelligence/tools/side-effects.js`](../js/intelligence/tools/side-effects.js)). Admit-when: `side_effects === 'read'` OR name in the session-write allowlist (`scratchpad_write`, `todo_write`, the five preview action tools). **Fail-closed default** — names without a classification (including MCP-bridged tools, future tools missing a catalog entry) drop to `'external'` and are denied. The pre-2.76.0 default-mutating safety property is preserved; the new floor is stricter because it also catches tools that simply forgot to declare `readOnly: true` (the gitea#480 culprit).

**Composition:** Applied on top of role-filtered output, never as a substitute. The caller (`applyPlanModeFilter` in [`js/llm/api.js`](../js/llm/api.js)) chains `getToolsForProfile(p)` → `filterReadOnly(defs)` → the OpenAI tool-array.

### `ToolRegistry.checkPlanModeAccess(name)` ([registry.js:232](../js/tools/registry.js))

**Signature:** `(string) → { allowed: boolean, reason?: string, sideEffect?: string }`. Sync. Pure (reads global `getPlanMode()` state).

**Authoritative dispatch-side gate** (2.76.0 / gitea#480). Pre-2.76.0 the only plan-mode filter was the LLM-visible tool list; calls reaching dispatch via cached tool messages, sub-agent loops, plugin shims, or stale assistant-turn context had no second check. The new gate runs at the top of `executeWithProfile` **before** the role check — short-circuits with a rejection envelope whose `error` string names the tool's `side_effects` class and points at `submit_plan_for_approval` (same envelope shape as `checkRoleAccessForProfile` rejection so the chat-loop discriminator at `handlers.js` works identically).

**Logic:**
1. `getPlanMode()` falsy → return `{ allowed: true }` unconditionally.
2. Name in `PLAN_MODE_SESSION_WRITE_ALLOWLIST` → return `{ allowed: true }`. Allowlist covers session-local writes that should stay admitted while planning (`scratchpad_write`, `todo_write`, the five preview action tools — all session-scoped, no repo/file/remote effect).
3. `getSideEffectByName(name) === 'read'` → return `{ allowed: true }`.
4. Else return `{ allowed: false, sideEffect, reason }`.

**Invariants:**
- When plan mode is off, this function is byte-equivalent to `() → { allowed: true }` — no behavior change to existing call paths.
- Fail-closed default applies to unknown names (MCP-bridged tools, future tools without classifications). Conservative-correct: blocking is recoverable, allowing isn't.
- Composes with the list-side filter via shared allowlist + `getSideEffectByName` — list-side and dispatch-side cannot disagree.

### `ToolRegistry.getStats()` ([registry.js:311](../js/tools/registry.js))

**Signature:** `() → { total: number, byRole: { [profileName: string]: number } }`. Sync. Pure.

**Iterates `Profiles.list()` only** — synthetic profiles are excluded from the dashboard mirror of their exclusion from the picker. `byRole`'s key naming is preserved from the pre-2.0 role-keyed API for stability across the cost-tab UI; the values are profile-keyed today (chat / coder / kb).

### `ToolRegistry.clear()` ([registry.js:325](../js/tools/registry.js))

Testing + hot-reload escape hatch. Drops both maps; no event emitted. Never called by production code paths.

### `scanToolReturn(name, result)` ([registry.js:345](../js/tools/registry.js))

**Signature:** `(string, object) → void`. Sync. Mutates `result._security.invisibleUnicode` in place.

**Not part of the admission contract** — orthogonal security scan, exported for the test harness. Documented here so the seam's public surface is exhaustive in one place. Skipped when `result._security.invisibleUnicode` is already populated (narrower issue/PR scans win) and when the JSON-serialized result exceeds the 10 MB byte budget.

### `Profiles.getKnownGroupTags()` ([profiles/registry.js:197](../js/profiles/registry.js))

**Signature:** `() → string[]`. Sync. Pure.

**The 2.34.0 boundary.** Returns the union of every profile's `tools.allowed_groups` (excluding `'*'`) plus `'all'` and `'full'`. Sorted output for determinism.

**Carve-out rationale (frozen here):**
- `'all'` — never declared by a profile (checked on the tool side). Tools tagged `roles: ['all']` short-circuit inside `filterTools`. The tag is admitted to the legal set so register-time typo validation accepts it.
- `'full'` — never declared by a profile (admitted via `full.v1`'s `['*']` wildcard). 4 tools register with the tag today (see "Bypass axis" above). The tag is admitted to the legal set so register-time typo validation accepts admin-tier registrations without forcing every consumer to fork the validator.

**Anti-regression contract:** [`tests/test-tools-registry-legal-groups.mjs`](../tests/test-tools-registry-legal-groups.mjs) pins the post-2.34.0 derived set against the pre-2.34.0 hardcode — the test was the bridge that let the lift land without admission regressions.

### `Profiles.filterTools(defs, profileName)` ([profiles/registry.js:231](../js/profiles/registry.js))

**Signature:** `(ToolDefShape[], string|null|undefined) → ToolDefShape[]`. Sync. Pure. Returns a fresh array.

**Filter rule (in order):**
1. Unknown / missing `profileName` → fall back to `chat.v1` + `console.warn`. Defensive only; production `getActiveProfileName` / `getEffectiveProfileName` never emit anything else.
2. `profile.tools.allowed_groups` includes `'*'` → return `defs.slice()` (wholesale bypass; preserves pre-2.0 `'full'` role semantics).
3. For each def: admit when `_registeredRoles` includes `'all'`, OR when `_registeredRoles ∩ allowed_groups` is non-empty.

**Mirrors legacy `Roles.filterTools` byte-for-byte** — the slice 1 → slice 2 (1.23.0 → 1.24.0) cross-product equivalence pin in `tests/test-profile-filter-tools.mjs` is what made the consumer flips safe.

**Composed with** the Composer side: ICD-intelligence-composers §"Authorization axis" delegates here for the Tools Composer's `isAuthorized` check; the system-prompt path does the same per ICD-chat-handlers §"Composer-vs-non-Composer path drift" (both paths read from this exact filter, so they cannot disagree).

## Interaction matrix

### Shared contract (load-bearing, do not split)

- **The legal-tag set is derived, not hardcoded.** Adding a profile that declares a new `allowed_groups` entry auto-extends `getKnownGroupTags()` without a parallel registry edit. The 2.34.0 lift was the antibody to the prior class of "added a profile, forgot to update `LEGAL_GROUP_TAGS`" bugs.
- **Three carve-outs are stable and named.** `'all'` (tool side) + `'*'` (profile side) + `'full'` (legal-but-never-declared admin-tier tag). Removing any of these silently changes admission for production tools (`'full'`-tagged: 4 tools today) or profiles (`full.v1`).
- **Profile-name fallback is soft.** Unknown profile names hit `chat.v1` with a warn, never throw. This is the conservative choice for a runtime gate that the chat loop calls inside its hot path.

### Disjoint surfaces

- **Read-only filtering is orthogonal to role filtering.** `filterReadOnly` does not check `_registeredRoles` and admission does not check `def.readOnly`. The two filters compose at the caller; neither subsumes the other.
- **Tool unregister emits; tool register does not.** The asymmetry exists because consumers care about cache-invalidation on removal (find-tool embeddings would otherwise serve stale entries); on add, the registry's own `getDefinitions()` is the authoritative source.
- **Plan-Mode admission is separate from runtime admission.** Plan Mode constrains what the model sees while planning; the runtime gate (`checkRoleAccess`) still fires when the planned tool is invoked. A tool admitted to Plan Mode but denied by role still hits the gate.

### Open invariants (not asserted today)

- **No test pins the four `'full'`-tagged tools as admin-tier.** A future PR could quietly demote one (e.g. drop `'full'` from `memory_set`'s roles array) and admission would shift — the typo-validator would still accept it because `['coder', 'pm']` is a legal subset. The four tools are intentional carve-outs; if their admin-tier status is load-bearing, the right antibody is a contract test that pins the `'full'`-tagged set against an expected list.
- **No assertion enforces that `Profiles.list()` matches the picker `<select>` order.** `getStats().byRole` keys are derived from `Profiles.list()` order; if a future change reorders, the cost-tab UI's column order shifts silently. Today this is fine — three entries in stable order; not load-bearing if it bites.

## Code-aware findings (feed back to ROADMAP as 2.47.0+ rows)

Authoring this ICD surfaced **one** drift item worth promoting to `[strong]` in the next code minor:

### 1. `ToolRegistry.getToolsForProfile` docstring claims a retired deprecation shim is "preserved below"

[`js/tools/registry.js:265-267`](../js/tools/registry.js) reads:

> `Renamed from getToolsForRole; the legacy alias is preserved below for any plugin-side caller that still imports the old name (deprecation shim retires at 2.1.0).`

This is **stale**. Reading the rest of the file (lines 272–330) shows no `getToolsForRole` alias — it was retired (presumably at 2.1.0 as the docstring's own promise read at the time). We're at 2.46.0; the docstring claim that the shim "is preserved below" doesn't match the file.

**Suggested fix shape:** Single-file docstring update. Drop the "legacy alias is preserved" sentence; replace with a one-liner pointing at the 2.0.0 slice-3 rename history and confirming the shim was retired at 2.1.0 as planned. Same shape as the 2.46.0 retrieval-Composer docstring fix (`[strong] [S]`, single-file, no behavior change).

**Why this matters:** A future plugin author reading this docstring would expect a `getToolsForRole` alias to exist on `ToolRegistry`. They'd land on the LLM-side `LLMTools.getToolsForRole()` (`js/llm/api.js:1025`) — a coincidentally-same-named method that builds the per-turn tool array, not the registry filter. That misdirection is the kind of seam-confusion the ICD program is meant to prevent.

### Other observations (not promoted)

- **`LLMTools.getToolsForRole` name collision** — `js/llm/api.js:1025` retains the method name from the pre-2.0 era; renaming to `getToolsForProfile` would surface during a future tooling rename pass but is stability-preserving today. Park as a `[fuzzy]` note in the deferred bucket, not a `[strong]` row.
- **`'full'`-tagged tool list is not contract-pinned** — see "Open invariants" above. A test asserting `findToolsByGroup('full').map(t => t.name).sort() === ['<expected list>']` would land it; deferred until a real drift event motivates the antibody.
- **Profile docs reference `Roles.filterTools` in historical attribution** — `js/profiles/pm-v1.js:8`, `migration.js:15`, `full-v1.js:8`, `plugin-dev-v1.js:9`, `reviewer-v1.js:9`, `coder-v1.js:250`, `profiles/registry.js:21/210/222/224`. These are explanatory comments documenting the 1.23.x slice-1 cross-product equivalence — not drift. Kept as historical context.
- **MCP-bridge tools land without `readOnly: true`** — by design (the registry can't introspect MCP server semantics). The conservative-default behavior means MCP tools can't be invoked while planning. Documented for completeness; not drift.

## Why the two sides resist consolidation

A natural-looking refactor is "fold `getKnownGroupTags` + `filterTools` into a `ProfileAdmission` module that owns both sides." That has been considered and deferred for two reasons:

1. **The two sides have different lifecycle profiles.** Tool registration happens at boot time (and on MCP connect/disconnect); admission filtering happens on every chat turn. Folding both into one module would force every consumer to thread the registry through unrelated lookup APIs.

2. **The seam is already documented across the boundary.** `js/profiles/registry.js#getKnownGroupTags` carries its full rationale (legal-tag derivation + carve-out explanation) inline; `js/tools/registry.js#register` carries the validation rationale at the use site. Hoisting to a separate module would obscure the rationale's adjacency to the code it justifies.

The split remains a future option if a third consumer (e.g. an audit-logging layer that needs to record admission decisions) surfaces and the two sides need to share a third-party view; today, the two-files-one-contract pattern is the contract.

## Forward-evolution rules

### When adding a new profile

1. **Declare `tools.allowed_groups` explicitly.** Use named tags (e.g. `['coder']`, `['kb']`) or `'*'` for the wholesale bypass. Never declare `'all'` — that tag is checked on the tool side; profiles that declare `'all'` get nothing extra.
2. **Add the profile to `BY_NAME` and `ENTRIES` (if picker-visible) or `SYNTHETIC_ENTRIES` (if migration-target / lookup-only).** Synthetic-profile rationale documented in [`profiles/registry.js`](../js/profiles/registry.js) header — follow the precedent.
3. **Run [`tests/test-tools-registry-legal-groups.mjs`](../tests/test-tools-registry-legal-groups.mjs)** — the test asserts every profile's `allowed_groups` entry appears in `getKnownGroupTags()`'s output. A typo (`['cdoer']`) is caught at test time.

### When adding a new tool

1. **Declare `roles:` explicitly.** Either `'all'` (read-only / universally-safe) or an array of named tags. Omitting throws at register time.
2. **Pick `roles: 'all'` only for genuinely-universal tools.** Today ~50% of tools take this path — every read-only file/project tool, every meta tool, every preview tool. Tools that write or mutate state should pick a narrower set.
3. **For admin-tier tools, include `'full'` in the array.** The tag is legal-but-never-declared; only `full.v1` admits via `['*']`, so `'full'` is your signal "this tool is admin-tier."
4. **Mark `readOnly: true` if the tool only reads.** Plan Mode (github#25) drops mutating tools from the planning catalog. Default-mutating is the safe default — opt in.

### When changing the legal-tag derivation

1. **`'all'` and `'full'` are seed values.** Removing them silently breaks the four `'full'`-tagged tools' registration. If the carve-outs need to retire, schedule a multi-PR sequence with a pre-flight contract test.
2. **`'*'` MUST stay excluded from `getKnownGroupTags()`'s output.** It's a wholesale-bypass marker, not a tag — admitting it would let a typo'd `['*' /* meant 'full' */ ]` profile pass through.
3. **The 2.34.0 anti-regression test pins the post-derivation set against the pre-2.34.0 hardcode.** A future change that adds a third seed tag (or retires `'full'`) updates the test alongside the derivation — same PR.

### When changing the admission filter

1. **Single source of truth.** `Profiles.filterTools` is the only admission filter. `ToolRegistry.checkRoleAccess` delegates to it; the Composer's authorization gate mirrors the same `'full'` / `'all'` short-circuits. Adding a second filter (e.g. a per-chat ACL) re-introduces the kind of drift the 2.0.0 profile flip cleaned up — schedule an architecture session first.
2. **The `'*'` and `'all'` short-circuits run *before* the intersection check.** Reordering would change semantics for profiles that declare both `'*'` and named groups (impossible today, but the order matters for invariant clarity).
3. **Profile-name fallback to `chat.v1` is soft, not hard.** Throwing on an unknown profile name would crash the chat loop on a settings-corruption edge case. The defensive warn is the right shape for a runtime gate.

## References

- Source: [`js/tools/registry.js`](../js/tools/registry.js), [`js/profiles/registry.js`](../js/profiles/registry.js); profile-side declaration sites in [`js/profiles/chat-v1.js`](../js/profiles/chat-v1.js), [`coder-v1.js`](../js/profiles/coder-v1.js), [`kb-v1.js`](../js/profiles/kb-v1.js), [`full-v1.js`](../js/profiles/full-v1.js) (lookup-only `['*']` bypass), and the four `SYNTHETIC_ENTRIES` (`chat_multi-v1.js`, `plugin-dev-v1.js`, `pm-v1.js`, `reviewer-v1.js`, `rp-v1.js`).
- Production consumers: [`js/llm/api.js`](../js/llm/api.js) (`LLMTools.getToolsForRole` builds the per-turn tool array — note the naming collision with the retired `ToolRegistry.getToolsForRole` alias), [`js/chat/handlers.js`](../js/chat/handlers.js) (chat tool-loop calls `getToolsForProfile`), MCP bridge ([`plugins/mcp-bridge.js`](../plugins/mcp-bridge.js)) — primary `unregister` caller.
- Design contracts: [`docs/PROFILES_AND_TOOLS.md`](PROFILES_AND_TOOLS.md) — admission narrative + per-tool profile table (renamed from `ROLES_AND_TOOLS.md` at 2.57.0); [`docs/DESIGN-profiles.md`](DESIGN-profiles.md) — profile contract + Two-View Configuration; [`docs/PLUGIN.md`](PLUGIN.md) — plugin-side tool-registration shape.
- Cross-ICD: [`ICD-chat-handlers.md`](ICD-chat-handlers.md) §"Composer-vs-non-Composer path drift" (system-prompt + API tools-array both read `Profiles.filterTools`); [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md) §"Authorization axis" (Tools Composer's `isAuthorized` mirrors the same short-circuits).
- Tests: [`tests/test-tools-registry-legal-groups.mjs`](../tests/test-tools-registry-legal-groups.mjs) (2.34.0 derived-tag set pin), [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs) (1.23.x `Roles.filterTools` ↔ `Profiles.filterTools` byte-for-byte equivalence), [`tests/test-system-prompt-admission.mjs`](../tests/test-system-prompt-admission.mjs) (same-projection invariant — Composer-vs-non-Composer).
- Methodology: [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #3; target #4 is `git-providers/base.js`'s 43-method base interface, at the next re-eval slot).
- History anchors: 1.21.0 (`Profiles` extraction from inline `PROFILE_REGISTRY`); 1.23.0 (slice 1: `Profiles.filterTools` exists alongside legacy `Roles.filterTools` with cross-product equivalence pin); 1.24.0 (slice 2: every consumer flipped); 2.0.0 (slice 3: `getToolsForRole` → `getToolsForProfile` rename; legacy `Roles` namespace retired); 2.1.0 (deprecation shim retired per the registry docstring's promise); 2.8.0 (`ConversationManager.getEffectiveProfileName` — per-chat profile binding wins over settings global); 2.34.0 (`LEGAL_GROUP_TAGS` hardcode → `Profiles.getKnownGroupTags()` derived); 2.46.0 (last shipped code minor before this re-eval).
