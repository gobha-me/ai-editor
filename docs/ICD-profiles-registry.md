# ICD — Profiles registry contract

> **Status:** initial draft, `RE-EVAL following 2.61.0`. Eighth subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #8. Tracks the post-2.54.0 profile-side admission contract + the inheritance composition rules + the resolver pattern across [`js/profiles/registry.js`](../js/profiles/registry.js) (310 LOC; `Profiles` namespace), [`js/profiles/inheritance.js`](../js/profiles/inheritance.js) (198 LOC; `resolveProfile` + admit operators), [`js/profiles/resolve.js`](../js/profiles/resolve.js) (535 LOC; nine `resolve*Config` helpers + `getActiveProfileName` + `pickProfileName` + `PLUGIN_TOOL_NAMES`), [`js/profiles/profile-contract.js`](../js/profiles/profile-contract.js) (216 LOC; `Profile` JSDoc typedef + `isProfile` guard), [`js/profiles/migration.js`](../js/profiles/migration.js) (95 LOC; `migrateRoleToProfile`), [`js/profiles/diff.js`](../js/profiles/diff.js) (291 LOC; `diffProfiles` + `formatProfileDiff`), [`js/profiles/task-ledger.js`](../js/profiles/task-ledger.js) (212 LOC; ledger struct + factory), [`js/profiles/index.js`](../js/profiles/index.js) (85 LOC; barrel), and the 10 per-profile data files (`chat-v1.js` / `coder-v1.js` / `kb-v1.js` / `subagent-v1.js` / `plugin-dev-v1.js` / `full-v1.js` / `pm-v1.js` / `reviewer-v1.js` / `rp-v1.js` / `chat-multi-v1.js`). The pair of this ICD and **ICD #3 (`ICD-tool-registry.md`, superseded at 2.54.0)** is intentional — ICD #3 documented the pre-inversion tool-side admission boundary as historical record; this ICD pins the **profile-side** admission boundary that is the post-2.54.0 sole gate (`Profiles.filterTools` is the canonical admission filter, no tool-side `roles:` field, no `LEGAL_GROUP_TAGS` validation, no `_registeredRoles` enrichment). Prior ICDs ([#1 chat-handlers, 2.42.0; #2 intelligence-composers, 2.45.0; #3 tool-registry, 2.46.0; #4 git-providers, 2.49.0; #5 retrieval-manager, 2.52.0; #6 MCP bridge, 2.55.0; #7 plugin lifecycle, 2.58.0](ROADMAP.md)) describe orthogonal seams; this ICD cross-references ICD #3 (the tool-side pair it supersedes), ICD #5 (the `resolveTaskLedgerConfig` resolver added at 2.53.0 to close ICD #5 finding (a)), ICD #6 (`'mcp__*'` glob consumers), and ICD #7 (the 2.58.0 `plugin.enabled` capability overlay that layers atop the active profile). Code-aware findings from authoring feed back to ROADMAP as `[strong]` / `[medium]`-band rows for the next code minor; **two** surface this pass (see §"Code-aware findings").

## Purpose

Profiles are the load-bearing configuration surface as of 2.0.0 (per [`DESIGN-profiles.md`](DESIGN-profiles.md) §"The Profile Contract"). Every per-surface knob the four intelligence subsystems (retrieval, memory, compression, tools) and the four capability overlays (`scriptAutomation` / `preview` / `plugin` / `subagent`) read at session start lives on the resolved profile. **There is no other configuration source for these knobs at runtime** — `State.settings.role` retired at 2.0.0 (migrated via [`migrateRoleToProfile`](../js/profiles/migration.js) at `loadSettings` time); `State.settings.profile` is the only field the runtime consults via `getActiveProfileName`, with the 2.8.0 per-chat binding overriding via `pickProfileName`.

The 2.54.0 admission inversion (gitea#438; github#40 paper-cut closed 2026-05-15) changed who declares admission and how. Pre-2.54.0: tools self-tagged with `roles: 'all' | string[]`, profiles intersected via `tools.allowed_groups`, the runtime gate admitted on tag overlap, and [`Profiles.getKnownGroupTags()`](../js/profiles/registry.js) derived the union of every profile's group tags + the two seed values (`'all'`, `'full'`) so register-time typo validation accepted them. Post-2.54.0: **profiles enumerate explicit tool names in `tools.admit`**, plus `'*'` as a wholesale-bypass sentinel and `'<prefix>__*'` glob entries for MCP-bridge tool families. Inheritance gains `admit_add` / `admit_remove` operators so child profiles narrow/widen without restating the parent's full list. The runtime gate is [`Profiles.filterTools`](../js/profiles/registry.js); the registration-time admit-coverage warn is [`Profiles.findAdmittingProfiles`](../js/profiles/registry.js) (2.55.0). Tool-side `roles:` declarations + `LEGAL_GROUP_TAGS` validation + `_registeredRoles` enrichment are retired entirely — [`ICD-tool-registry.md`](ICD-tool-registry.md) is preserved under its §"⚠️ Superseded" banner as historical record of that prior boundary.

**This ICD freezes the post-2.54.0 admission boundary, the inheritance composition shape (`base:` chain + admit operators), the resolver pattern (nine `resolve*Config` helpers — each a leaf-name + warn-on-miss + `resolveProfile`-merge sandwich), the three carve-outs (`'*'` bypass / `'<prefix>__*'` glob / `'<overlay>'` synthetic admitter from `findAdmittingProfiles`), the synthetic-profiles list (`SYNTHETIC_ENTRIES` — seven entries today), and the legacy-role migration table (five-row map in [`migration.js`](../js/profiles/migration.js)) so the next contributor reading the code sees what's load-bearing vs. incidental.**

## The seam at a glance

| | Surface | Path | LOC | Role |
|---|---|---|---|---|
| **In-process namespace** | `Profiles` (default export object) + named exports (`get`, `has`, `list`, `filterTools`, `findAdmittingProfiles`) | [`js/profiles/registry.js`](../js/profiles/registry.js) | 310 | Lookup + admission gate + admit-coverage probe |
| **Inheritance walker** | `resolveProfile(profile, lookup)` (1 public export) — chain walk + deep merge + admit-operator application | [`js/profiles/inheritance.js`](../js/profiles/inheritance.js) | 198 | Deep-merges leaf onto `base`-chain root; cycle-detects; applies `admit_add` / `admit_remove` |
| **Resolver bank** | `getActiveProfileName` / `pickProfileName` + nine `resolve*Config(profileName)` helpers (Compression / Memory / Tools / Retrieval / TaskLedger / DefaultRememberScope / ScriptAutomation / Preview / Plugin / SubAgent) + `PLUGIN_TOOL_NAMES` frozen array | [`js/profiles/resolve.js`](../js/profiles/resolve.js) | 535 | Resolved-profile lookup at session start; one helper per subsystem |
| **Typed shape** | `Profile` JSDoc typedef + 7 nested config typedefs (`BudgetSpec` / `RetrievalConfig` / `MemoryConfig` / `CompressionConfig` / `SummarizerConfig` / `ToolsConfig` / `TaskLedgerConfig`) + `MemoryScope` + `isProfile` guard | [`js/profiles/profile-contract.js`](../js/profiles/profile-contract.js) | 216 | Single source of truth for what a profile is shaped like |
| **One-shot migration** | `migrateRoleToProfile(saved)` (1 public export) + frozen 5-row `ROLE_TO_PROFILE` table | [`js/profiles/migration.js`](../js/profiles/migration.js) | 95 | Pre-2.0.0 `settings.role` → `settings.profile`; idempotent + load-time |
| **Structured differ** | `diffProfiles(profileA, profileB, options?)` + `formatProfileDiff(diff)` (2 public exports) | [`js/profiles/diff.js`](../js/profiles/diff.js) | 291 | Reports field-level deltas; raw vs resolved modes; mirrors `mergeDeep` edge cases |
| **Task ledger** | `createTaskLedger()` factory + `isTaskLedger` guard + `DEFAULT_LEDGER_CAPACITY` constant + 5 record typedefs | [`js/profiles/task-ledger.js`](../js/profiles/task-ledger.js) | 212 | Per-task working state shared across the four intelligence subsystems |
| **Barrel** | `index.js` — re-exports across the module | [`js/profiles/index.js`](../js/profiles/index.js) | 85 | Narrow consumer entry point |
| **Profile data files** | 10 profiles: `CHAT_V1` / `CODER_V1` / `KB_V1` (picker-promoted) + `SUBAGENT_V1` / `PLUGIN_DEV_V1` / `FULL_V1` / `PM_V1` / `REVIEWER_V1` / `RP_V1` / `CHAT_MULTI_V1` (lookup-only) | `js/profiles/<name>-v1.js` | 60–393 each | The actual data each profile declares |

Total surface: **18 files / ~3637 LOC** under one ICD. The data-file LOC dominates (`coder-v1.js` is 393 LOC; six other `*-v1.js` files are 60–345 LOC each); the namespace-and-resolver code is ~1500 LOC across the six non-data files.

## The five classification axes

Each axis names a question the seam answers across the namespace, the inheritance walker, and the resolver bank. The first two axes (Declaration, Admission) describe *what a profile says about itself*; the next two (Inheritance, Resolution) describe *how that declaration gets composed and consumed*; the last (Diagnostics) describes *what's surfaced about the decision*.

| Axis | Question | Where it's declared | Where it's read |
|---|---|---|---|
| **Declaration axis** | What is a profile, and what's the typed shape it must satisfy? | [`profile-contract.js`](../js/profiles/profile-contract.js) — `Profile` typedef declares 8 top-level fields: `name` / `version` / `base` (optional inheritance — string profile name or null) / `budget` / `retrieval` / `memory` / `compression` / `tools` / `task_ledger` plus optional `systemPrompt` (1.23.0 — profile-side replacement for the legacy `Roles.get(role).systemPrompt`). Capability overlay blocks (`scriptAutomation` / `preview` / `plugin` / `subagent`) are out of the core typedef — each carries on the leaf profile that introduces it (`coder.v1` for `scriptAutomation` + `preview` + `subagent`; `chat.v1` + `coder.v1` for `plugin`; `subagent.v1` for the per-call ceiling block). The `isProfile` guard pins the top-level shape; downstream-typed fields (`MemoryScope`, `CompressionRule`, `ChunkerRegistration`, `FieldSpec`, `ToolDefRef`) are declared in adjacent typedefs but not runtime-validated. **No required fields beyond the 8 top-level ones.** The 2.54.0 retirement of `tools.allowed_groups` made `tools.admit` the new admission field — declared optional in the typedef (a profile inheriting via `admit_add` carries no literal `admit`), but **every leaf profile that doesn't inherit via operators must declare it** (validated by [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs)). | `Profile` typedef is the single source consumed by [`profile-contract.js#isProfile`](../js/profiles/profile-contract.js) (top-level guard), [`registry.js#BY_NAME`](../js/profiles/registry.js) (lookup map keyed on `name`), [`inheritance.js#resolveProfile`](../js/profiles/inheritance.js) (every nested field merges per the typedef shape), the nine `resolve*Config` helpers in [`resolve.js`](../js/profiles/resolve.js) (each reads one nested field via `resolveProfile`), and [`tests/test-profiles-fixtures.mjs`](../tests/test-profiles-fixtures.mjs) (runs `isProfile` against every registered profile). |
| **Admission axis** | What gates a tool candidate post-2.54.0, and what's the load-bearing precedence order? | [`registry.js#filterTools`](../js/profiles/registry.js) — the canonical admission gate. Sequence: (1) unknown / missing `profileName` → fall back to `chat.v1` + warn (defensive only); (2) resolve via `resolveProfile`; (3) `admit.includes('*')` → return all defs (full bypass — `full.v1` only); (4) split admit entries into literal Set + glob-prefix list (`'<prefix>__*'` → keep trailing `'__'`); (5) admit each def whose `function.name` is in the literal Set OR starts with a glob prefix. Profile-side declaration sites are `js/profiles/<name>-v1.js` `tools.admit: string[]` — every picker profile carries a hand-curated list since 2.56.0 (gitea#440). | The runtime callsite is [`tools/registry.js`](../js/tools/registry.js) (`checkRoleAccess` + `getToolsForProfile` + `getToolsForRole`); upstream consumers are [`llm/api.js#LLMTools.getToolsForRole`](../js/llm/api.js) (per-turn tool array), [`prompts.js#buildSystemPrompt`](../js/prompts.js) (Composer-vs-non-Composer enumeration both read `Profiles.filterTools`), [`chat/handlers.js`](../js/chat/handlers.js) (tool loop). The 2.55.0 `findAdmittingProfiles` probe is the **registration-time** sibling — called by `ToolRegistry.register` to surface the silent-vanish failure mode (tool admitted by zero profiles → `console.warn`). |
| **Inheritance axis** | How is the resolved profile constructed from the leaf + its `base` chain, and what edge cases preserve admit-operator semantics? | [`inheritance.js#resolveProfile`](../js/profiles/inheritance.js) — walks `base` chain leaf → root (Set-tracked for cycle detection; throws on cycle or on unknown base name), then folds root → leaf so leaf overrides win. `mergeDeep` recursion rule: plain objects recurse; arrays + primitives + null + dissimilar shapes replace verbatim (per [`DESIGN-profiles.md`](DESIGN-profiles.md) §"Inheritance" *"no multi-inheritance, no mixin, no late binding"* — array values **replace wholesale**, not append). The 2.54.0 `applyAdmitOperators` carves out the `tools` parent-key: when both literal `admit` AND `admit_add`/`admit_remove` appear on a child override, the literal wins and operators are warned-then-ignored; when only operators appear, the inherited base.admit is set-subtracted by `admit_remove`, then set-unioned with `admit_add`. Operator keys never persist on the merged output. **Operators only honor the immediate-parent inheritance** — set-subtract-then-set-union runs once at the boundary between leaf and direct-base, not iteratively up the chain. The merge happens after `mergeDeep`'s array-replace, so the operator path is independent of `mergeDeep`'s array logic. | Every consumer reaches it via the `resolveProfile`-then-read pattern in [`resolve.js`](../js/profiles/resolve.js)'s nine helpers + [`registry.js#filterTools`](../js/profiles/registry.js) + [`registry.js#findAdmittingProfiles`](../js/profiles/registry.js) + [`diff.js#diffProfiles`](../js/profiles/diff.js) (resolved mode is the default). No consumer reads raw leaf fields directly for admission/config decisions — that would skip the inheritance walk. |
| **Resolution axis** | How does each intelligence subsystem read its slice of the active profile? | [`resolve.js`](../js/profiles/resolve.js) — nine helpers, all the same shape: take `profileName` arg → if `Profiles.has(name)`, use it; else fall back to `chat.v1` + warn → `Profiles.get(name)` → `resolveProfile(leaf, profileLookup)` → read the relevant nested field with defaults → return the typed result alongside `profileName: resolved.name`. The nine: `resolveCompressionConfig` (1.17.0 — `rules` array mapped from data-shape names to `RUNTIME_RULES` runtime objects; `preserve_recent`) / `resolveMemoryConfig` (1.18.0 — `default_scope` + `propose_after_n_turns` + `capacity_warnings`) / `resolveTools` (1.19.0 — `static` array only; the wider `tools` block is reachable via `resolveProfile` directly) / `resolveRetrievalConfig` (1.20.0 — `collections` + `memory_collections` + `strategy_weights` + `novelty_threshold`) / `resolveTaskLedgerConfig` (2.53.0 — `enabled` + `capacity` + `novelty_threshold`; closed ICD #5 finding (a)) / `resolveScriptAutomationConfig` (1.16.0 — `enabled` + `timeout_ms` + `max_output_bytes`; coder.v1 short-circuit, NOT `resolveProfile`-routed) / `resolvePreviewConfig` (1.22.0 — `enabled`; coder.v1 short-circuit) / `resolvePluginConfig` (2.58.0 — `enabled`; coder.v1 short-circuit) / `resolveSubAgentConfig` (2.49.0.0 — `enabled` + `run_timeout_ms` + `max_tokens` + `max_dollars` + `recursion_depth`; `resolveProfile`-routed because the block lives on `subagent.v1` and inheriting profiles need the merge). **Two divergent shapes** — `resolveScriptAutomationConfig` / `resolvePreviewConfig` / `resolvePluginConfig` short-circuit on `profileName === 'coder.v1'` and read directly from the leaf `CODER_V1` / `CHAT_V1` (no `resolveProfile`); the other six route through `resolveProfile`. The short-circuit is documented in each helper's docstring as load-bearing only when the carrier-profile set is small and stable (`coder.v1` is the only carrier of `scriptAutomation` + `preview`; `chat.v1` is the only fallback) — see §"Open invariants" #1. | Each helper has one production callsite: `resolveCompressionConfig` → [`chat/summarizer.js`](../js/chat/summarizer.js); `resolveMemoryConfig` → [`tools/memory-tools.js`](../js/tools/memory-tools.js) (via `resolveDefaultRememberScope`); `resolveTools` → [`chat/handlers.js`](../js/chat/handlers.js) (`recordToolInvocation` + `recordDiscoveryAdmissions`); `resolveRetrievalConfig` → [`intelligence/retrieval/manager.js#findRelevantFiles`](../js/intelligence/retrieval/manager.js); `resolveTaskLedgerConfig` → same; `resolveScriptAutomationConfig` → [`llm/api.js`](../js/llm/api.js); `resolvePreviewConfig` → same; `resolvePluginConfig` → [`llm/api.js#applyPluginToolFilter`](../js/llm/api.js); `resolveSubAgentConfig` → [`llm/api.js#applySubAgentToolFilter`](../js/llm/api.js) + the `delegate_task` tool handler. |
| **Diagnostics axis** | What's surfaced about the active profile + the admission decisions made on its behalf? | Six surfaces: (1) **Picker UI** — [`settings/profiles-tab.js`](../js/settings/profiles-tab.js) reads `Profiles.list()` for the `<select>` options; user pick writes `State.settings.profile`. (2) **Per-chat binding chip** — `.chat-welcome` shows the picker on new-chat; binding wins over `settings.profile` via `pickProfileName`. (3) **Debug surfaces** — [`js/debug-slideout.js`](../js/debug-slideout.js) reads `Profiles.list()` / `getActiveProfileName` to render the active profile + can call `diffProfiles(rawLeaf, resolvedLeaf)` for advanced-view shapes (the dedicated Profile panel UI is parked work — see §"Open invariants" #4). (4) **Boot-warn at registration** — [`tools/registry.js#register`](../js/tools/registry.js) calls `Profiles.findAdmittingProfiles(name, { overlayNames })` after fresh-register; empty result emits `console.warn` with the "add to profile X.tools.admit" remediation hint. (5) **Admit-coverage CI lint** — [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs) source-scans every `ToolRegistry.register('name', ...)` call across `js/tools/*.js` and asserts `findAdmittingProfiles(name).length > 0`. The lint runs on every PR; over-trimming surfaces at CI time instead of at boot. (6) **Cost dashboard mirror** — [`tools/registry.js#getStats`](../js/tools/registry.js) `.byRole` is keyed on `Profiles.list()` names — picker-promoted profiles only; synthetics excluded mirror the picker. | The picker writes `State.settings.profile` + emits `profile:changed`; per-chat binding writes `conversation.profile`; the registry warns surface to console; the CI lint surfaces in PR-status checks; the cost-dashboard byRole keys feed the Settings → Cost section. |

Five axes × **18 files / ~3637 LOC** × 9 resolvers × 10 profiles × 3 carve-outs (`'*'` bypass / `'<prefix>__*'` glob / `'<overlay>'` synthetic admitter) is the surface this ICD pins.

## Per-export contract

### `Profiles.get(name)` ([registry.js:166](../js/profiles/registry.js))

**Signature:** `(string) → Profile | null`. Sync. Pure.

**Lookup:** `BY_NAME[name]` — a single record-of-arrays-built Map over `ENTRIES` (3 picker-promoted profiles) + `SYNTHETIC_ENTRIES` (7 lookup-only profiles). Returns `null` on miss; never throws.

**Invariants:** Returns the **raw leaf** profile object — not a `resolveProfile`-merged copy. Consumers that need inherited fields must call `resolveProfile(profile, Profiles.get)` themselves. The two-step pattern is intentional — `resolveProfile` is pure-functional and idempotent; consumers that only need the raw leaf (e.g. `migration.js` for the legacy-role table-key check) shouldn't pay the merge cost.

### `Profiles.has(name)` ([registry.js:174](../js/profiles/registry.js))

**Signature:** `(string) → boolean`. Sync. Pure.

**Lookup:** `Object.prototype.hasOwnProperty.call(BY_NAME, name)` — guards against prototype-chain false positives.

### `Profiles.list()` ([registry.js:184](../js/profiles/registry.js))

**Signature:** `() → ProfileListEntry[]`. Sync. Returns a fresh array.

**Returns:** Picker-visible profiles only (`ENTRIES`); synthetics excluded. Each entry is `{ name, label, description }`.

**Invariants:** Order is insertion-order in `ENTRIES` — `chat.v1` first (the base), then `coder.v1`, then `kb.v1` (picker-promoted at 2.8.0). The picker UI relies on this order; the `byRole` keys in `ToolRegistry.getStats()` also derive from `Profiles.list()` so the cost-tab UI column order matches.

### `Profiles.filterTools(defs, profileName)` ([registry.js:217](../js/profiles/registry.js))

**Signature:** `(ToolDefShape[], string|null|undefined) → ToolDefShape[]`. Sync. Pure. Returns a fresh array.

**Filter rule (post-2.54.0, in order):**
1. `defs` not an array → return `[]` (defensive).
2. Unknown / missing `profileName` → fall back to `chat.v1` + `console.warn`. Defensive only; production callers thread `getActiveProfileName` / `pickProfileName`.
3. Resolve via `resolveProfile(leaf, name => BY_NAME[name] || null)` — inherits the chain so `admit_add` / `admit_remove` operators are honored.
4. `resolved.tools.admit.includes('*')` → return `defs.slice()` (full bypass; `full.v1` only).
5. Split `admit` into literal Set (string entries) + glob-prefix list (`'<prefix>__*'` entries; keep trailing `'__'`).
6. For each def: admit when `def.function.name` is in the literal Set OR starts with any glob prefix.

**Invariants:**
- The `'*'` bypass short-circuits **before** the literal/glob split; reordering would change semantics if a future change lets `'*'` coexist with named entries (impossible today, but the order matters for invariant clarity).
- Non-string entries in `admit` are skipped silently (defensive against future typedef widening).
- `function.name` must be a non-empty string; defs without `function` or with non-string names are rejected.
- The function is called on every chat turn — performance-load-bearing. The `Set.has` + `Array.startsWith` shape is intentional; resolving the profile per-call is acceptable because `resolveProfile` is fast (~10 µs for typical chains).

**Composed with** the tool side: `ToolRegistry.checkRoleAccess` delegates to this filter; `ToolRegistry.getToolsForProfile` delegates here for the per-turn tool array; `prompts.js` Composer-and-non-Composer paths both read through this filter (per ICD #1 §"Composer-vs-non-Composer path drift" — both paths read from this exact filter, so they cannot disagree).

### `Profiles.findAdmittingProfiles(toolName, opts?)` ([registry.js:281](../js/profiles/registry.js))

**Signature:** `(string, { overlayNames?: string[] }?) → string[]`. Sync. Pure.

**Probe rule (2.55.0 — gitea#439):**
1. Empty or non-string `toolName` → return `[]`.
2. For each `profileName` in `BY_NAME` (both picker + synthetic): resolve the profile, walk its `admit` array, match each entry via the same rule as `filterTools` *except* `'*'` is **not** counted (the silent-vanish guard — a tool reachable only via `full.v1`'s `'*'` bypass is invisible to picker profiles).
3. If `opts.overlayNames?.includes(toolName)`, append the synthetic `'<overlay>'` admitter to the result.
4. Return the list of admitter names.

**Invariants:**
- `'*'` sentinel exclusion is **load-bearing** — without it the warn would never fire for any tool (every tool admits through `full.v1`), and the silent over-admission failure mode the inversion was supposed to fix returns.
- Synthetic `'<overlay>'` admitter is the forward-compat seam for capability overlays (`plugin.enabled` via `PLUGIN_TOOL_NAMES` — see §"Open invariants" #2 for the path forward).
- Production caller is [`tools/registry.js#register`](../js/tools/registry.js) on the fresh-register branch only; HMR / MCP-reconnect re-registers don't fire the warn.

### `resolveProfile(profile, lookup)` ([inheritance.js:48](../js/profiles/inheritance.js))

**Signature:** `(Profile, (name: string) => Profile|null) → Profile`. Sync. Pure (input not mutated). Throws on cycle or unknown base.

**Chain walk:**
1. Validate inputs — `profile` must be an object, `lookup` must be a function.
2. Walk leaf → root, recording each profile in `chain[]` + `seen` Set (cycle-keyed by `name` field).
3. For each cursor: validate `name` (non-empty string; else throw); add to `seen`; push to `chain`; if `base` is null, break; if `base` is non-string, throw; lookup `base` via `lookup`; null → throw "unknown base"; non-null → cursor advances to base.
4. Fold root → leaf (`for (i = chain.length - 1; i >= 0; i--)`) so leaf overrides win.

**Deep-merge rule (in `mergeDeep`):**
- Copy base keys → out; iterate override keys → skip `undefined`; if both sides are plain objects (own enumerable, prototype is `Object.prototype` or null), recurse with `parentKey`; else override wins (arrays + primitives + null + dissimilar shapes all replace verbatim).
- Special case: `parentKey === 'tools'` → call `applyAdmitOperators(out, base, override)` after the literal merge.

**Admit-operator rule (in `applyAdmitOperators`):**
- Strip `admit_add` / `admit_remove` from `out` regardless (never persist on merged output).
- If `override.admit` is an array literal AND `admit_add` or `admit_remove` is also present → warn-then-ignore the operators; literal wins.
- Else if neither operator is present → no-op.
- Else: take `base.admit` (or `[]`), set-subtract `admit_remove`, set-union `admit_add`. Result becomes `out.admit`.

**Invariants:**
- Cycle detection uses `name` — every profile in the chain must declare a string `name` (throws otherwise).
- Operator-then-literal precedence is settled — literal `admit` always wins over operators on the same child. Documented in the docstring + pinned by [`tests/test-profiles-inheritance.mjs`](../tests/test-profiles-inheritance.mjs).
- `mergeDeep` treats `null` as a primitive (replaces base value) — mirrors DESIGN-profiles.md's "no multi-inheritance" rule.

### The nine `resolve*Config` helpers ([resolve.js](../js/profiles/resolve.js))

All nine share the same six-line shape (warn-on-miss-fallback + `Profiles.get` + `resolveProfile` + read nested field + return with defaults). Variation lives in two dimensions:

1. **Direct-leaf-read short-circuit** vs. **`resolveProfile`-routed**:
   - **Short-circuit (3 helpers)**: `resolveScriptAutomationConfig`, `resolvePreviewConfig`, `resolvePluginConfig` all read `profileName === 'coder.v1' ? CODER_V1 : CHAT_V1` and skip `resolveProfile`. The rationale (per each docstring): the carrier-profile set is small and stable — only `coder.v1` carries the override; every other profile (including synthetics) falls through to `chat.v1`'s defaults. Trading inheritance walk against simplicity is fine when the inheritance graph for this block is single-level.
   - **`resolveProfile`-routed (6 helpers)**: every other helper threads through `resolveProfile` so future profiles inheriting via `base:` chains pick up the block correctly.

2. **Fallback defaults** when the field is absent on the resolved profile:
   - Compression: `preserve_recent: 4`.
   - Memory: `default_scope: 'user'`, `propose_after_n_turns: null`, `capacity_warnings: {}`.
   - Tools: `static: []`.
   - Retrieval: `collections: []`, `memory_collections: []`, `strategy_weights: {}`, `novelty_threshold: 0.4`.
   - TaskLedger: `enabled: false`, `capacity: 100`, `novelty_threshold: 0.5`.
   - ScriptAutomation: `enabled: false`, `timeout_ms: 30000`, `max_output_bytes: 262144`.
   - Preview / Plugin: `enabled: false`.
   - SubAgent: `enabled: false`, `run_timeout_ms: 300000`, `max_tokens: 50000`, `max_dollars: 0.5`, `recursion_depth: 0`.

**Invariants:**
- Every helper returns `profileName: resolved.name` as a top-level field — the consumer can verify which profile actually answered.
- Unknown profileName always falls through to `chat.v1` with a warn — never throws. Production callers thread `getActiveProfileName` / `pickProfileName` which guarantee a registered name; the warn only fires on settings-corruption edge cases.
- No two helpers share a fallback default — divergence is intentional per the per-profile rationale documented in each helper's docstring.

### `getActiveProfileName(settings)` + `pickProfileName(conversationProfile, settings)` ([resolve.js:97 + :126](../js/profiles/resolve.js))

**Signatures:** `({profile?: string|null}) → string` + `(string|null|undefined, {profile?: string|null}) → string`. Sync. Pure.

**Resolution order:**
- `getActiveProfileName`: read `settings.profile`; if registered (`Profiles.has`), return it; else return `'chat.v1'`. **No warn on unknown** — permissive by design (stale settings blobs from a future version with a removed profile shouldn't spam the console).
- `pickProfileName`: if `conversationProfile` is a registered name, return it; else delegate to `getActiveProfileName(settings)`. The 2.8.0 per-chat binding hands `conversationProfile = conversation.profile` from `ConversationManager.getActiveProfile()`.

**Invariants:**
- Both return a registered name (never `null` / `undefined`). Downstream callers can assume the returned name passes `Profiles.has`.
- Type-narrowing JSDoc on `getActiveProfileName` returns the closed union of every registered profile name — picker + synthetic. Adding a new profile to the registry requires updating this typedef (callers consuming the type lose narrowing otherwise).
- `pickProfileName` is pure — `ConversationManager.getActiveProfile()` is the production source for `conversationProfile`, but the helper accepts the value explicitly so browser code and Node tests share one truth-table.

### `migrateRoleToProfile(saved)` ([migration.js:77](../js/profiles/migration.js))

**Signature:** `({role?, profile?, ...} | null) → MigrationResult`. Sync. Mutates input in place. Idempotent.

**Two branches:**
1. **Migration path** (`saved.role !== undefined && saved.profile == null`) — read `saved.role`, look up in 5-row `ROLE_TO_PROFILE` table (`coder → coder.v1`, `full → full.v1`, `pm → pm.v1`, `reviewer → reviewer.v1`, `'plugin-dev' → plugin-dev.v1`); unknown values fall through to `chat.v1`; write `saved.profile = toProfile`; delete `saved.role`; return `{migrated: true, fromRole, toProfile}`.
2. **Picker-already-won path** (`saved.role !== undefined && saved.profile != null`) — quiet-drop the stale `role` (the user touched the picker pre-2.0.0; their explicit choice wins); return `{migrated: false, fromRole, toProfile: saved.profile}`.

Subsequent calls on a settings blob without `role` are no-ops.

**Invariants:**
- The 5-key table mirrors [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs)'s `ROLE_TO_PROFILE` constant verbatim — divergence is a bug (the cross-product equivalence pin requires the same mapping).
- Rollback caveat: irreversible by load-time detection. Downgrading to a 1.x build with a `profile`-only settings blob loses the role mapping. Documented at CHANGELOG §2.0.0 "Breaking".

### `diffProfiles(profileA, profileB, options?)` + `formatProfileDiff(diff)` ([diff.js:70 + :226](../js/profiles/diff.js))

**Signatures:** `(Profile, Profile, DiffOptions?) → ProfileDiff` + `(ProfileDiff) → string`. Sync. Pure.

**Modes:**
- **`'resolved'` mode (default)** — both inputs go through `resolveProfile(input, options.lookup)` before walking; `options.lookup` is required (else throws). Reports what the runtime actually sees.
- **`'raw'` mode** — walks the inputs as-is; preserves leaf-author-intent view. Reserved for the future "advanced view" picker UI in 2.0.x stabilization.

**Edge-case policy** (mirrors `mergeDeep` byte-for-byte so a resolved-mode diff never lies about what `resolveProfile` would have produced):
- `undefined` keys absent on both sides → absent in diff.
- Plain objects on both sides → recurse.
- Arrays or shape-mismatch → wholesale-replace; emitted as a single `'array_replaced'` entry (never element-wise).
- `null` is a primitive (mirrors merger); null↔value is `'changed'`, not `'removed'`.

**Invariants:**
- Entry order is deterministic — depth-first, keys lexicographically sorted at each level. Fixture diffs are stable across runs.
- `options.ignorePaths` allows suppressing dot-paths (e.g. `['name', 'version']` when comparing across profile identities).
- `equal: true` ⟺ `entries.length === 0`.

### Task ledger module ([task-ledger.js](../js/profiles/task-ledger.js))

**Public surface:** `createTaskLedger(profileName, taskId?)` factory + `isTaskLedger(v)` guard + `DEFAULT_LEDGER_CAPACITY` constant + 5 record typedefs (`AdmissionRecord`, `ExclusionRecord`, `ToolAdmissionRecord`, `ToolInvocationRecord`, plus `ChunkID` / `ToolID` / `TurnID` / `TaskID` type-aliases). The struct schema is in [`DESIGN-profiles.md`](DESIGN-profiles.md) §"The Task Ledger". **Lifecycle**: one ledger per task (not session) — tasks begin/end on heuristics; a profile may run multiple tasks per session, each with its own ledger; ledgers don't survive session end by default.

Consumed by [`intelligence/retrieval/manager.js`](../js/intelligence/retrieval/manager.js) (admissions + exclusions) + [`chat/handlers.js`](../js/chat/handlers.js) (tool admissions + invocations). The capacity defaults are profile-side (`profile.task_ledger.capacity`); the factory uses `DEFAULT_LEDGER_CAPACITY` as a final fallback when no profile is supplied.

## The three carve-outs

The post-2.54.0 admission model has three short-circuits the literal/glob match doesn't cover. Removing any one silently changes admission for production profiles or tools.

| Carve-out | Where it lives | What admits | Reason |
|---|---|---|---|
| `'*'` bypass sentinel | `tools.admit: ['*']` on `full.v1` only | Every tool, unconditionally | Preserves the pre-2.0.0 `'full'` role's unfiltered semantics; the migration target for users with `settings.role === 'full'`. `findAdmittingProfiles` deliberately excludes this — `'*'` does not count as admission for the picker-side silent-vanish guard. |
| `'<prefix>__*'` glob | `tools.admit: [..., '<prefix>__*']` on chat.v1 / coder.v1 / plugin-dev.v1 (`'mcp__*'`) | Every tool whose `function.name` starts with `'<prefix>__'` | Admits MCP-bridge tools by family without per-server enumeration (MCP tool names form as `mcp__<serverId>__<toolName>`). Sub-agents deliberately omit it as a trust-boundary measure (per [`subagent-v1.js:124`](../js/profiles/subagent-v1.js)). |
| `'<overlay>'` synthetic admitter | Returned by `findAdmittingProfiles(name, {overlayNames})` when the tool name appears in `overlayNames` | The probe alone — the actual runtime admission flows through `applyPluginToolFilter` at `js/llm/api.js` | Forward-compat seam (2.55.0 → 2.58.0) for capability overlays. `PLUGIN_TOOL_NAMES` (the 5-tool plugin-dev cohort) is the production overlay set. The synthetic admitter prevents the registration-time boot-warn from firing for overlay-admitted tools without forcing every picker profile to enumerate them. |

## Synthetic profiles — three rationales, one list

[`SYNTHETIC_ENTRIES`](../js/profiles/registry.js) holds 7 lookup-only profiles, registered for `Profiles.get` / `Profiles.has` but excluded from `Profiles.list()`. Three rationales share the list — distinguishing them matters for forward-evolution:

1. **Legacy-role migration targets** (4 of 7): `full.v1` / `plugin-dev.v1` / `pm.v1` / `reviewer.v1`. The 2.0.0 migration script (slice 3) maps legacy `settings.role` strings onto these via the 5-row `ROLE_TO_PROFILE` table. Hidden from the picker so the dropdown stays simple (the design wanted three picker options, not seven); the migration preserves granularity for everyone whose pre-2.0.0 role didn't fit `chat` or `coder`. These are stable post-migration — every user has either migrated or never had a non-default role.

2. **Phase 2 architectural surfaces** (2 of 7): `chat_multi.v1` / `rp.v1`. Shipped as data + harness coverage at 2.6.0; *deliberately not* surfaced in the picker. Their declared overrides reference runtime infrastructure that doesn't exist (`shared_conversation` / `per_speaker` / `lore` / `per_persona` collections, Rule 4, voice-preserving Rule 5). Picking one today would behave indistinguishably from `chat.v1` for most users — worse than not offering. **Promotion gate**: each needs a `systemPrompt` addendum that makes choosing it user-observable without depending on unbuilt infrastructure (`kb.v1`'s 2.8.0 graduation is the precedent). Deprioritized for ai-editor — these are consumer-product surfaces (multi-user chat, role-play) absent from this product per the `feedback_chat_multi_rp_no_utility_in_aieditor` memory; the natural unlock is the Phase 4 user-authoring API (gitea#443 placeholder).

3. **Trust-boundary profile** (1 of 7): `subagent.v1`. Added at 2.49.0.0 (slice 1 of github#24 Phase 1). Read-only-by-default; bounds a `delegate_task`-spawned child agent's reach. Structurally never goes into the picker — sub-agents are invoked by the parent agent, not selected by the user. The profile is the trust boundary at the sub-agent level per [`DESIGN-sub-agents.md`](DESIGN-sub-agents.md) §"The Load-Bearing Decision".

**Forward-evolution rules:**

- Adding a 4th rationale (e.g. a per-vendor sandboxed profile) is *not* a forward-evolution path — re-litigate the picker / synthetic split first.
- Promoting a synthetic to picker (`SYNTHETIC_ENTRIES` → `ENTRIES`) follows the `kb.v1` 2.8.0 precedent: needs a `systemPrompt` addendum that makes picking it user-observable.
- Demoting a picker profile to synthetic is a major-version-shaped change (`settings.profile` blobs reference it; migration would need to point them at the new picker default).

## Interaction matrix

### Shared contract (load-bearing, do not split)

- **`Profiles.filterTools` is the sole admission gate.** `ToolRegistry.checkRoleAccess` delegates to it; the Composer's authorization gate mirrors the same short-circuits; the prompts.js system-prompt enumeration reads from the exact same filter. Adding a second admission filter (e.g. a per-chat ACL) re-introduces the kind of drift the 2.0.0 profile flip cleaned up — schedule an architecture session first.
- **The `'*'` and glob short-circuits run *before* the per-name match.** Reordering would change semantics for any profile that declared both `'*'` and named entries (impossible today by `full.v1`-only convention, but the order matters for invariant clarity).
- **Profile-name fallback is soft, not hard.** Unknown profile names hit `chat.v1` with a warn, never throw. This is the conservative choice for a runtime gate that the chat loop calls inside its hot path.
- **The five-row `ROLE_TO_PROFILE` table is the single migration source.** Both [`migration.js`](../js/profiles/migration.js) and [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs) read from this table; divergence breaks the cross-product equivalence pin that made the 1.23 → 2.0 consumer flips safe.

### Disjoint surfaces

- **Resolver bank vs. namespace.** `resolve*Config` helpers route through `Profiles.get` + `resolveProfile`; they don't expose the registry's lookup surface to their callers. Consumers reading multiple subsystem configs in one pass call multiple resolvers — no batch API by design (each subsystem owns its read shape).
- **Migration vs. lookup.** `migrateRoleToProfile` runs once at `loadSettings` time; runtime callers never touch it. The 5-row table is not exported.
- **Raw vs. resolved.** `Profiles.get` returns the raw leaf; `resolveProfile(leaf, Profiles.get)` returns the merged shape. Consumers must pick — `diffProfiles`' default of `'resolved'` is the runtime-honest mode.
- **`scriptAutomation` / `preview` / `plugin` resolvers don't go through `resolveProfile`.** They short-circuit on `coder.v1` and read leaf-direct from `CODER_V1` / `CHAT_V1`. See §"Open invariants" #1.

### Open invariants (not asserted today)

1. **The three short-circuit resolvers (`resolveScriptAutomationConfig`, `resolvePreviewConfig`, `resolvePluginConfig`) bypass `resolveProfile`.** Each docstring documents the rationale (small + stable carrier set; trading inheritance walk against simplicity). The concern is that a future profile inheriting from `coder.v1` via `base: 'coder.v1'` would *not* pick up the overrides — because the helper reads `CODER_V1` directly, not the inheritance chain. Today no profile inherits from `coder.v1`; if one does (e.g. a future `coder_review.v1`), these three resolvers would silently drop the inherited block. The fix shape is to align them with the other six (route through `resolveProfile`). See §"Code-aware findings" #1.

2. **The `'<overlay>'` synthetic admitter is a probe-time fiction.** `findAdmittingProfiles` returns `'<overlay>'` as an admitter when the tool name is in `opts.overlayNames`, but the **runtime** admission flows through `applyPluginToolFilter` at [`js/llm/api.js`](../js/llm/api.js) — not through `filterTools`. The two paths don't share a code path, only a membership constant (`PLUGIN_TOOL_NAMES`). A new capability overlay would need to wire up its own runtime filter; the registry-side probe wouldn't catch the absence. Future overlays should consider whether to consolidate the runtime side onto `filterTools` (would require admitting overlay-only tools through a new short-circuit, similar to `'*'`) or keep the per-overlay runtime filter pattern.

3. **`Profiles.list()` order is insertion-order in `ENTRIES` but not contract-pinned.** The picker UI + `byRole` keys + the Cost dashboard column order all depend on it. Adding a new picker-promoted profile should land at the end of `ENTRIES` to preserve existing column order (or the picker render + cost-tab UI need updating). No test pins this today — same shape concern as ICD #3's `Profiles.list()` order invariant.

4. **Advanced-view picker UI is parked.** `diffProfiles` resolved-mode + raw-mode is wired; the "edit raw `Profile` struct, see resolved diff" surface in Settings → Profiles → Advanced is the 2.0.x stabilization candidate per [`DESIGN-profiles.md`](DESIGN-profiles.md) line 587 Two-View Configuration. Today no production consumer reads `'raw'` mode; the differ's raw-mode code path is exercised only by tests. **Not drift** — the API stayed forward-compatible. Documenting here so the differ's raw-mode preservation is intentional, not incidental.

5. **`migrateRoleToProfile`'s 5-row table is not future-proof.** The table is frozen at the 2.0.0 migration shape. Adding a 6th legacy role (would only happen via a new sync source that ships pre-2.0.0 blobs) requires a parallel update to `tests/test-profile-filter-tools.mjs`'s `ROLE_TO_PROFILE` constant. The cross-product equivalence pin enforces this; mentioning here so future contributors don't miss the second site.

## Code-aware findings

These two items surfaced during ICD authoring. Each is a candidate for a `[strong]` / `[medium]`-band roadmap row in the next code minor (2.67.0+).

### Finding #1 [medium] — three resolvers bypass `resolveProfile`; future `base: 'coder.v1'` profiles would silently drop overrides

[`resolveScriptAutomationConfig`](../js/profiles/resolve.js) + [`resolvePreviewConfig`](../js/profiles/resolve.js) + [`resolvePluginConfig`](../js/profiles/resolve.js) read leaf-direct: `const profile = profileName === 'coder.v1' ? CODER_V1 : CHAT_V1;`. Today no profile inherits from `coder.v1` (the inheritance tree is `chat.v1` → others, with `subagent.v1` and a few synthetics chaining off `chat.v1`); the short-circuit works. But the contract leaks: if a future `coder_review.v1` declares `base: 'coder.v1'` and adds a `subagent: {recursion_depth: 1}` override, the call to `resolveSubAgentConfig('coder_review.v1')` returns the merged value correctly (uses `resolveProfile`), but `resolvePreviewConfig('coder_review.v1')` returns chat.v1's default `enabled: false` — because the helper doesn't see the chain at all.

**Suggested fix shape:** Align the three short-circuit helpers with the six `resolveProfile`-routed ones. The change is mechanical: replace the `profileName === 'coder.v1' ? CODER_V1 : CHAT_V1` line with the standard fallback-warn + `Profiles.get(name)` + `resolveProfile(leaf, profileLookup)` shape. Per-helper test additions: pin the inherited shape for `base: 'coder.v1'` and `base: 'chat.v1'` cases against a fixture profile. The 6 already-aligned helpers' tests at [`tests/test-profile-resolve.mjs`](../tests/test-profile-resolve.mjs) are the template.

**Band:** `[medium]`. Pre-emptive — no production profile triggers the failure mode today. The fix is mechanical but touches user-observable runtime; promote to `[strong]` if a future profile is queued that needs the inheritance walk (the 2.0.x stabilization advanced-view picker is the natural pull).

### Finding #2 [strong] — `Profiles` namespace exports are not shape-pinned

The 2.63.0 MCP public-surface shape pin idiom (capabilities-precedent: direct `Object.keys(...).sort()` deepEqual) is what protects MCP `bridge` / `registry` / `protocol` modules from drift. The same idiom hasn't been applied to the profiles namespace — adding or renaming a `Profiles.*` method would land without a test failure even though the per-callsite consumers (`tools/registry.js`, `prompts.js`, `chat/handlers.js`) read by name.

**Suggested fix shape:** New [`tests/test-profile-registry-shape.mjs`](../tests/test-profile-registry-shape.mjs) — mirror [`tests/test-mcp-public-surface-shape.mjs`](../tests/test-mcp-public-surface-shape.mjs) one-for-one. Pin:
- `Object.keys(Profiles).sort()` against the 5-method shape (`['filterTools', 'findAdmittingProfiles', 'get', 'has', 'list']`).
- Each method's named-export presence (`registry.js` exports `get` / `has` / `list` / `filterTools` / `findAdmittingProfiles` individually + the namespace).
- `BY_NAME` membership = `ENTRIES.map(.profile.name)` + `SYNTHETIC_ENTRIES.map(.name)` = the 10 expected profile names.
- `ENTRIES` order — `['chat.v1', 'coder.v1', 'kb.v1']` exactly (picker visibility + insertion-order invariant).
- `PLUGIN_TOOL_NAMES` 5-name membership pin (already partially covered by [`tests/test-profile-plugin-overlay.mjs`](../tests/test-profile-plugin-overlay.mjs); deduplicate or coexist).
- Resolver bank: `Object.keys(*)` for the resolve module exports — the 9 helpers + `getActiveProfileName` + `pickProfileName` + `resolveDefaultRememberScope` + `PLUGIN_TOOL_NAMES`.

**Band:** `[strong]`. Direct mechanical mirror of the 2.63.0 idiom; zero production-file edits; high anti-regression value (the profiles namespace is consumed across the codebase and a silent rename would propagate failure into Composer / prompts / handlers paths).

### Other observations (not promoted)

- **`resolveDefaultRememberScope` lives in [`resolve.js`](../js/profiles/resolve.js) instead of [`tools/memory-tools.js`](../js/tools/memory-tools.js)** to be Node-importable for tests — `memory-tools.js` transitively pulls `core.js`'s browser-only globals. Pattern is intentional; documented for future split-decisions.
- **`SUBAGENT_V1.tools.admit` restates `tools.static` verbatim** rather than admitting via `'subagent'` group tag (pre-2.54.0 shape) or via operators (since the parent `chat.v1.admit` would over-admit). The full restatement is the trust-boundary explicit shape; documented in [`subagent-v1.js:115-124`](../js/profiles/subagent-v1.js).
- **`profile-contract.js#ToolDefRef` carries `required_groups` + `requires_consent`** fields from the pre-1.4.0 era; these are typedef-only — no runtime consumer reads them. Park as a `[fuzzy]` typedef-tidying note, not a `[strong]` row.
- **`task-ledger.js` has typedef aliases (`ChunkID` / `ToolID` / `TurnID` / `TaskID`)** that don't pull in the retrieval-side contracts (avoids the `js/intelligence/retrieval/contracts.js` → `js/profiles/` import). Intentional inversion of the natural dependency graph; documented in [`task-ledger.js:34-46`](../js/profiles/task-ledger.js).

## Why the parts resist consolidation

A natural-looking refactor is "fold `inheritance.js` + `resolve.js` into a single `profile-runtime.js` module that owns chain-walk + resolver bank." That has been considered and deferred for three reasons:

1. **`resolveProfile` is pure-functional and reusable.** Production code uses it for admission filtering; tests use it for assertion fixtures; `diffProfiles` uses it for resolved-mode diffs. Folding into `resolve.js` would force every consumer to depend on the resolver bank's per-subsystem read shapes — most just want the merged profile object.

2. **The nine resolvers have intentionally divergent shapes.** Three short-circuit on `coder.v1`; six route through `resolveProfile`; each returns a different result shape (Compression returns `RuntimeRule[]`, Memory returns `MemoryConfig`-shaped object, etc.). Hoisting to a single generic resolver would obscure the per-subsystem rationale documented in each helper's docstring — and would require the subsystem-shape extraction logic to live somewhere, with no obvious owner.

3. **Migration belongs at boot, not at lookup.** `migrateRoleToProfile` mutates `saved` in place; it must run before `loadSettings` builds the live `State.settings` object. Folding it into the runtime resolver bank would either (a) force every lookup to check for legacy fields (perf-load-bearing — chat loop calls these often) or (b) require a flag tracking whether migration has run (re-introducing the kind of state-machine the inversion eliminated).

The split remains a future option if a fourth lookup pattern surfaces (e.g. plugin-author profile overlays per gitea#443) and the resolver bank needs broader sharing; today, the four-module split (`registry` + `inheritance` + `resolve` + `migration`) is the contract.

## Forward-evolution rules

### When adding a new profile

1. **Declare `tools.admit` explicitly** (or inherit via `base:` + use `admit_add`/`admit_remove` operators). Pre-2.54.0 `allowed_groups` is retired entirely — typing it would not error today but the field is dead.
2. **Add the leaf to `ENTRIES` (picker-visible) or `SYNTHETIC_ENTRIES` (lookup-only).** Synthetic-profile rationale (legacy-migration / Phase 2 architectural / trust-boundary) determines which.
3. **Run [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs)** — the test asserts every registered tool is admitted by at least one profile. Adding a profile that admits nothing extra is fine; adding a tool not admitted by any profile fails.
4. **If the new profile has a `systemPrompt` addendum**, wire `js/prompts.js` to read it via `Profile.systemPrompt` (already wired since 1.23.0 — the addendum lands automatically on any profile that declares it).
5. **If picker-promoting from synthetic**, add the `systemPrompt` addendum first (the `kb.v1` 2.8.0 precedent — make picking it user-observable).

### When adding a new admit operator

1. **Operators apply at the `tools` parent-key only.** Adding a `compression.rules_add` would require a parallel `applyCompressionOperators` carve-out in `mergeDeep` — the operator path is shape-specific.
2. **Operators run *after* `mergeDeep`'s literal-merge.** Reordering would change semantics for profiles that declare both a literal and operators (a deliberate operator-fires-last shape).
3. **Literal-wins-over-operators is settled.** When both `admit` literal AND `admit_add` / `admit_remove` are present, literal wins + warn. This is the conservative direction — a child profile that declares `admit: [...]` is making a complete statement, not augmenting an inherited list.

### When adding a new resolver

1. **Mirror the existing six `resolveProfile`-routed shape**: fallback-warn on miss + `Profiles.get(name)` + `resolveProfile(leaf, profileLookup)` + read nested field + return typed result alongside `profileName: resolved.name`. The three short-circuit resolvers (`resolveScriptAutomationConfig` etc.) are not a precedent to mirror — they're a finding-#1 candidate.
2. **Add the new helper to the `index.js` re-export list** so consumers import via `js/profiles` (not via `js/profiles/resolve.js` directly).
3. **Write a regression test at `tests/test-profile-resolve.mjs`** — the six existing resolvers' tests are the template (fallback-on-miss + base-chain merge + per-profile values + capacity overlay).

### When changing the admission filter

1. **Single source of truth.** `Profiles.filterTools` is the only admission filter. Adding a second filter re-introduces drift.
2. **The `'*'` short-circuit runs *before* the literal/glob split.** Reordering changes semantics for any future profile declaring `['*', 'named_tool']` (impossible by `full.v1`-only convention today).
3. **The 2.55.0 `findAdmittingProfiles` probe deliberately excludes `'*'`.** Removing the exclusion would silence the silent-vanish boot-warn for every tool — the warn would never fire because every tool admits through `full.v1`.

## References

- Source: [`js/profiles/registry.js`](../js/profiles/registry.js), [`js/profiles/inheritance.js`](../js/profiles/inheritance.js), [`js/profiles/resolve.js`](../js/profiles/resolve.js), [`js/profiles/profile-contract.js`](../js/profiles/profile-contract.js), [`js/profiles/migration.js`](../js/profiles/migration.js), [`js/profiles/diff.js`](../js/profiles/diff.js), [`js/profiles/task-ledger.js`](../js/profiles/task-ledger.js), [`js/profiles/index.js`](../js/profiles/index.js); 10 data files [`js/profiles/chat-v1.js`](../js/profiles/chat-v1.js), [`coder-v1.js`](../js/profiles/coder-v1.js), [`kb-v1.js`](../js/profiles/kb-v1.js), [`subagent-v1.js`](../js/profiles/subagent-v1.js), [`plugin-dev-v1.js`](../js/profiles/plugin-dev-v1.js), [`full-v1.js`](../js/profiles/full-v1.js), [`pm-v1.js`](../js/profiles/pm-v1.js), [`reviewer-v1.js`](../js/profiles/reviewer-v1.js), [`rp-v1.js`](../js/profiles/rp-v1.js), [`chat-multi-v1.js`](../js/profiles/chat-multi-v1.js).
- Production consumers: [`js/tools/registry.js`](../js/tools/registry.js) (`checkRoleAccess` + `getToolsForProfile` + `register` boot-warn); [`js/llm/api.js`](../js/llm/api.js) (`LLMTools.getToolsForRole`, `applyPluginToolFilter`, `applySubAgentToolFilter`, `getAdmittedTools` Composer path); [`js/prompts.js`](../js/prompts.js) (Composer-and-non-Composer enumeration both read `Profiles.filterTools`); [`js/chat/handlers.js`](../js/chat/handlers.js) (tool loop + `recordToolInvocation` reads `resolveTools`); [`js/intelligence/retrieval/manager.js`](../js/intelligence/retrieval/manager.js) (`resolveRetrievalConfig` + `resolveTaskLedgerConfig`); [`js/chat/summarizer.js`](../js/chat/summarizer.js) (`resolveCompressionConfig`); [`js/tools/memory-tools.js`](../js/tools/memory-tools.js) (`resolveDefaultRememberScope`); [`js/settings/profiles-tab.js`](../js/settings/profiles-tab.js) (picker UI reads `Profiles.list`); [`js/chat/conversations.js`](../js/chat/conversations.js) (per-chat binding writes `conversation.profile`).
- Design contracts: [`docs/DESIGN-profiles.md`](DESIGN-profiles.md) — the load-bearing 1.X → 2.0 flip + Inheritance rules + Canonical Profiles table; [`docs/PROFILES_AND_TOOLS.md`](PROFILES_AND_TOOLS.md) — admission narrative + per-tool / per-profile admit-list table (renamed from `ROLES_AND_TOOLS.md` at 2.57.0); [`docs/DESIGN-sub-agents.md`](DESIGN-sub-agents.md) — why `subagent.v1` inherits from `chat.v1` not `coder.v1`; [`docs/discussion/profiles-pick-tools.md`](discussion/profiles-pick-tools.md) — the github#40 admission inversion paper.
- Cross-ICD: [`ICD-tool-registry.md`](ICD-tool-registry.md) §⚠️ Superseded banner — pre-2.54.0 tool-side admission boundary (this ICD is the post-2.54.0 profile-side pair); [`ICD-chat-handlers.md`](ICD-chat-handlers.md) §"Composer-vs-non-Composer path drift" — both paths read from `Profiles.filterTools`; [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md) §"Authorization axis" — Composer-side `isAuthorized` mirrors `filterTools` short-circuits; [`ICD-retrieval-manager.md`](ICD-retrieval-manager.md) §"Code-aware findings #1" — `resolveTaskLedgerConfig` was the ICD #5 finding that closed at 2.53.0; [`ICD-mcp-bridge.md`](ICD-mcp-bridge.md) §"Connection axis" — MCP tools register under `mcp__<serverId>__<toolName>` and admit via the `'mcp__*'` glob; [`ICD-plugin-lifecycle.md`](ICD-plugin-lifecycle.md) §"Enablement axis" — the 2.58.0 `plugin.enabled` capability overlay shares the word "enabled" with per-plugin enabled but is independent.
- Tests: [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs) (1.23.x cross-product equivalence pin — legacy `Roles.filterTools` ↔ `Profiles.filterTools`, kept post-2.54.0 as the migration-shape pin), [`tests/test-profile-find-admitting-profiles.mjs`](../tests/test-profile-find-admitting-profiles.mjs) (2.55.0 — silent-vanish guard), [`tests/test-profile-admit-coverage.mjs`](../tests/test-profile-admit-coverage.mjs) (2.56.0 — every registered tool is admitted by ≥1 profile), [`tests/test-profile-plugin-overlay.mjs`](../tests/test-profile-plugin-overlay.mjs) (2.58.0 — overlay sentinel + `PLUGIN_TOOL_NAMES` membership/freeze), [`tests/test-profiles-inheritance.mjs`](../tests/test-profiles-inheritance.mjs) (`resolveProfile` + admit operators), [`tests/test-profile-resolve.mjs`](../tests/test-profile-resolve.mjs) (resolver bank), [`tests/test-profiles-fixtures.mjs`](../tests/test-profiles-fixtures.mjs) (`isProfile` against every registered profile), [`tests/test-settings-role-migration.mjs`](../tests/test-settings-role-migration.mjs) (`migrateRoleToProfile`).
- Methodology: [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #8; remaining target is editor instance, queued for `RE-EVAL following 2.64.0`).
- History anchors: 1.1.0 (profiles scaffolded, data-only); 1.17.0 (`resolveCompressionConfig` — first resolver wired to consumer); 1.18.0 / 1.19.0 / 1.20.0 (memory / tools / retrieval resolver follow-ups); 1.21.0 (`Profiles` namespace + picker UI lands); 1.22.0 (`resolvePreviewConfig`); 1.23.0 (synthetic profiles + `Profiles.filterTools` + `systemPrompt` addendum); 2.0.0 (slice 3: role grid retires, `settings.role` migrated to `settings.profile`); 2.6.0 (Phase 2 — `chat_multi.v1` / `rp.v1` / `kb.v1` join as data + harness); 2.8.0 (per-chat profile binding + `kb.v1` picker-promoted via `systemPrompt` addendum); 2.49.0.0 (`subagent.v1` + `resolveSubAgentConfig`); 2.53.0 (`resolveTaskLedgerConfig` — closed ICD #5 finding (a)); 2.54.0 (admission inversion — gitea#438; `tools.admit` + `admit_add`/`admit_remove` operators replace `allowed_groups`); 2.55.0 (`Profiles.findAdmittingProfiles` + boot-warn — gitea#439); 2.56.0 (hand-curated admit lists for `chat.v1` / `coder.v1` / `kb.v1` — gitea#440; closes github#40); 2.57.0 (Roles → Profiles UI rename — gitea#441); 2.58.0 (`plugin.enabled` capability overlay + `PLUGIN_TOOL_NAMES` — gitea#442); 2.66.0 (auto-profile-switch retired — ICD #7 finding #2; the last role-mutation site on the plugin-editor tab).

---

*This document is the eighth ICD in the backfill program; the ninth slot at `RE-EVAL following 2.64.0` targets editor instance (the last named backlog candidate; `js/editor/instance.js` + `setup.js` + tab manager) — see [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" for the ordered backlog.*
