# Changelog

All notable changes to AI Editor are documented here.

## [Unreleased]

## [1.3.0] - 2026-04-30

Closes the **Memory Phase 1** track from `docs/ROADMAP.md` §1.3.0 —
the externally-tellable Git-native-memory story (Decision §1) and the
prerequisite for the 1.4.x Tools track. Eight PRs land across this
release, sequenced per the 2026-04-30 kickoff:

1. **#185 — Preact + htm vendor wiring + slot-mount integration layer.** Wires the ~5 KB ESM bundle and `js/utils/preact-mount.js` helper. No user-visible change in isolation; foundational for the Memory surfaces that follow.
2. **#189 — Memory subsystem core (store, embeddings, audit, contracts).** `js/intelligence/memory/{contracts,validation,utils,idb-schema,embeddings,audit,store,index}.js`. KeyMutex serializes per-key mutations; IDB v2 adds `memory_records` + `memory_audit` stores additively.
3. **#192 — `.aieditor/memory/*.md` file layer.** `js/intelligence/memory/file-layer.js` + `?memoryRepoMode=on` URL flag. Pending content held in-memory until PR #197 wires `Git.updateFile()` at commit time.
4. **#193 — `memory_remember` / `memory_recall` / `memory_revise` LLM tools.** `js/tools/memory-tools.js`. Tool-result-honest: `agent_proposed` returns `{status: 'pending_consent', candidate_id}`; `user_explicit` and `inferred` bypass the consent queue.
5. **#194 — Settings → Memory tab.** First Preact consumer. `js/settings/memory-tab*.js`, `css/memory.css`, in-strip placement (Touch 1 Variant A). Live updates via `MEMORY_EVENTS` subscriptions with effect-cleanup.
6. **#195 — Chat consent card (Flow 1).** `js/chat/consent-card.js` + `js/chat/consent-card/MemoryConsentCard.js`; 4-state component (open / editing / saved / dismissed); `?memoryConsentVariant=quiet` URL flag for the single-line variant.
7. **#197 — Commit-modal "Memory updates" section (Flow 3A/3B).** `js/ui/commit-memory-section.js`; auto-staging on non-protected branches, "Branch off & commit memory" escape hatch on protected ones.
8. **#198 (this PR) — Inline `@memory` chip + DESIGN-memory.md update + ROADMAP §1.3.x reframe + 1.3.0 release.**

**Five kickoff decisions are now reflected in `docs/DESIGN-memory.md`** (locking the contract going forward): persona scope dropped from 1.3.0 and deferred indefinitely; `confidence: float` field replaced by the `source` enum (`user_explicit | agent_proposed | inferred`); `.aieditor/memory/*.md` is deterministic key-sorted YAML-frontmatter blocks with last-write-wins conflict resolution surfaced in `diagnostics.warnings`; auto-staging on opt-in non-protected branches with a Touch 1 Flow 3A "Memory updates" parallel section and Flow 3B escape hatch; framework integration is div-slot mounting via `mountPreact()` (custom elements deferred). The companion `[memory:<key>]` markdown citation wire format is documented in DESIGN-memory.md §"Chat Citation Wire Format" — the format is what the `@memory` chip inserts and what `memory_recall` resolves at the model's option.

The decision to allow Preact + htm narrowly for new state-heavy
surfaces (vanilla everywhere else, forever) is locked in
`docs/ROADMAP.md` §Decisions §9. Memory tab is the first target; the
`@memory` chip (this PR) and consent card (#195) follow it; the
`active-tools chip row` (1.4.0) and `profile picker` (2.0) come next.

In parallel, lands a **synthetic compression-savings benchmark** that
verifies the Decision §8 gate locally without waiting for organic
dashboard data on `editor.gobha.ai` to accumulate. Five deterministic
fixtures (pure subsumption, pure invalidation, hybrid, 30-turn debug,
50-turn agentic) run through the same Compactor pipeline and assert
token-reduction percentages on every commit. **Aggregate result:
79.2% reduction across 105 turns / 193,950 → 40,350 tokens; 30-turn
debug session 78.7%; 50-turn agentic session 90.3% — all far above
the ROADMAP §1.2.0 floor of 40%.** Numbers are bounded ±2–3pp on both
sides so a regression that under-evicts (rule miss) and one that
over-evicts (false-positive cascade) both flag the test.

**Tier 2 of the same gate:** the new `?compression=off` URL flag turns
the deployed instance into the *control* side of a dual-session A/B.
With the flag set, `chat/compactor-integration.js` short-circuits past
the Compactor entirely — chat history flows straight into
`ChatSummarizer.getContextMessages()` exactly as it did pre-1.2.0. Open
two tabs on `editor.gobha.ai/dev` (one with the flag, one without),
run the same 50-turn synthetic shape from Tier 1's S5 fixture, then
compare the per-conversation totals on Settings → Cost. The synthetic
benchmark's 90.3% is the floor the deployed dashboard should approach;
materially below means deployed Compactor wiring or input shape
diverges from the synthetic — worth chasing before the next compression
patch ships.

**Closing the Memory track (PR #8).** The inline `@memory` chip lands
as the third Preact + htm consumer in the codebase (after the Settings
tab in PR #5 and the consent card in PR #6). Typing `@memory` opens a
fuzzy picker of the user's memories; arrow keys navigate, Enter
inserts a `[memory:<key>]` markdown citation token at the trigger
site. The citation is visible to the LLM as literal text and resolved
via `memory_recall` at the model's option — no invisible structured
tags, no new render path. Alongside the chip, this release aligns
`docs/DESIGN-memory.md` with the kickoff decisions that PRs #1–#7
shipped (collapsed scope enum, `source` enum replacing `confidence:
float`, file-format spec, Git-integration spec, mount-pattern spec,
chat-citation wire format), and reframes `docs/ROADMAP.md` §1.3.x to
reflect that workspace scope landed inside 1.3.0 (the original §1.3.1
slot is reused for self-healing tools; persona scope §1.3.2 deferred
indefinitely).

### Added

- **`vendor/preact-htm-entry.mjs`** — esbuild entry point re-exporting
  Preact's public surface (`h`, `render`, `Fragment`, etc.), all
  hooks (`useState`, `useEffect`, `useRef`, …), and htm's preact-bound
  `html` template tag. Compiles to `vendor/preact-htm-bundle.js`
  during the Docker build, mirroring the existing
  `codemirror-bundle.js` pattern. ~5 KB minified ESM.

- **`Dockerfile` Stage 1** — bundles `preact-htm-entry.mjs` alongside
  `codemirror-entry.mjs` via `npx esbuild --bundle --format=esm
  --minify --target=es2020`. Adds a `test -s preact-htm-bundle.js`
  guard to the verification step so empty bundles fail the build
  loudly. Stage 2 copies the bundle into `/usr/share/nginx/html/vendor/`
  and removes the build-only entry file.

- **`vendor/package.json`** — declares `preact ^10` and `htm ^3` as
  dev dependencies for the Stage 1 esbuild step. No runtime npm install
  in the served image; vendor `node_modules` is purged in Stage 2.

- **`js/utils/preact-mount.js`** — public mount helper. Exports
  `getPreact()` (lazy-loads the vendor bundle, falls back to esm.sh
  for dev mode, caches the result) and
  `mountPreact(rootEl, componentFn, props)` returning an idempotent
  cleanup function that calls Preact's `render(null, root)` on
  teardown. The CDN fallback mirrors the CodeMirror loader pattern in
  `js/editor/setup.js`. Includes `_setLoaderForTests` /
  `_resetLoaderForTests` seams for the node:test suite.

- **`tests/test-preact-mount.mjs`** — node:test smoke suite with 10
  cases covering loader caching, concurrent-load coalescing, render
  call shape, idempotent cleanup, argument validation
  (rootEl required, componentFn must be a function), and cache reset
  between stub swaps. Stubs Preact entirely — real DOM integration
  belongs to the browser suite at `tests/index.html`.

- **`tests/test-dependencies.js` manifest** — adds the Preact + htm
  bundle to the SCIF-readiness manifest with `dockerBundled: true,
  required: false` (the first consumer lands later in 1.3.0; until
  then the helper is dormant).

- **`tests/test-compression-synthetic-savings.mjs`** — Tier 1
  measurement-before-scale benchmark per ROADMAP Decision §8. Six
  node:test cases over five fixtures (S1 pure subsumption — 59.4%, S2
  pure invalidation — 46.9%, S3 hybrid 10-turn — 70.0%, S4 30-turn
  debug — 78.7%, S5 50-turn agentic — 90.3%) plus an aggregate
  assertion (79.2% across 105 turns). Bounds are tight (±2–3pp around
  the deterministic value) so logic regressions in either direction
  surface immediately. Provides the floor the Tier 2 deployed-instance
  dual-session run will compare against — Rule 3 (next compression
  patch, slot now-untracked per the planned ROADMAP §1.2.x reframe)
  ships only if dashboard data confirms the synthetic numbers.

- **`js/utils/compression-flag.js`** — Tier 2 dual-session flag.
  Reads `?compression=off` (also `=false`, `=0`, `=disabled`,
  case-insensitive) from `window.location.search` once on first call,
  caches the result for the rest of the session, and logs a single
  `[AI Editor] Compression DISABLED…` line to the DevTools console so
  the operator running the dual-session A/B can confirm which tab is
  in which mode. URL-only by design — no localStorage, no Settings
  toggle (per the plan: easy to share via link, easy to A/B by opening
  two tabs, no persisted state to forget about). Includes
  `_resetCacheForTests` for the node:test seam.

- **`tests/test-compression-flag.mjs`** — 15 node:test cases covering:
  flag absent / unrelated query params / non-disable values
  (`compression=on`, `=true`, `=1`); all four disable tokens
  (`off`, `false`, `0`, `disabled`); case-insensitive match;
  whitespace tolerance; flag set alongside other params; one-shot
  cache (URL change after first call doesn't re-flip the flag);
  console.log fires exactly once on first detection and stays silent
  when flag is absent; SSR / no-window safety; malformed search
  string doesn't throw.

#### Memory Phase 1 — subsystem core (Memory PR #2)

Memory PR #2 of 8 in the 1.3.0 track. Stands up the storage backbone
in `js/intelligence/memory/`: contracts, IDB-backed structured store
with audit log, validators, embedding canonicalization helper. No
LLM tools, no `.aieditor/memory/*.md` file layer, no UI yet — those
arrive in PRs #3–#7. **No user-visible behavior change in this PR.**

The two kickoff decisions (memory `project_design_engagement.md`,
2026-04-30) are concrete in code now: `MemoryScope` is `user|workspace`
only — `persona` was dropped from 1.3.0 entirely; `MemorySource` is the
3-value enum `user_explicit | agent_proposed | inferred` that replaced
the original `confidence: float` field. `DESIGN-memory.md` still
reflects the pre-kickoff data model; that doc updates with PR #8.

- **`js/intelligence/memory/contracts.js`** — JSDoc typedefs and runtime
  constants for the subsystem. Exports `MemoryScope`, `MemoryCategory`,
  `MemorySource`, `MemoryRecord` (14 fields), `AuditEntry`, `AuditAction`,
  `MemoryListOptions`, `MemoryQuery`, `MemoryEvent`. Runtime constants:
  `MEMORY_EVENTS` (channel names — `memory:created|updated|deleted`),
  `MEMORY_LIMITS` (key/actor/reason caps), the four enum lists, and
  `DELETED_SENTINEL = '__deleted__'` (the value `superseded_by` takes for
  soft-deleted records — keeps the deletion chain in the same field
  rather than adding a parallel `deleted_at` column).

- **`js/intelligence/memory/validation.js`** — pure validators. Each
  returns `{ ok: true }` or `{ ok: false, errors: string[] }` so the
  store layer decides whether to throw. `assertValid()` is the
  throwing wrapper used inside `store.create/update`. Enforces
  scope/category/source enum membership, key canonicalization
  (lowercase + trim, ≤256 chars), `embedding` as `number[]` not
  `Float32Array` (for IDB structured-clone safety), `created_at <=
  updated_at`, and rejects `superseded_by === id` (no self-supersession).

- **`js/intelligence/memory/utils.js`** — `KeyMutex` class providing
  per-key serialization (`withLock(key, fn)`), plus `chainKey()`,
  `now()` (clock seam), `newRecordId()` (wraps
  `crypto.randomUUID()` with a v4 fallback for environments without it).
  The mutex is the load-bearing race-safety mechanism that makes
  read-modify-write on the same `(scope, owner, key)` atomic. Issue #188
  is the bug class this prevents for memory writes.

- **`js/intelligence/memory/idb-schema.js`** — IDB plumbing layer.
  Exports the `STORES` constant, the four record indexes
  (`by_scope_owner_key`, `by_scope_category`, `by_superseded_by`,
  `by_expires_at`), the two audit indexes (`by_record_id`, `by_ts`),
  and twelve operation primitives (`putRecord`, `getRecord`,
  `deleteRecord`, `getAllRecords`, `getRecordsByOwner`,
  `getRecordsByKey`, `getRecordsByCategory`, `getExpiredRecords`,
  `addAudit`, `getAllAudit`, `getAuditByRecord`, `clearAll`) routed
  through a swappable implementation. Production wires to real IDB via
  `IDB.open()` (now v2); `_setIDBImpl(impl)` is the test seam. Mirrors
  the `embeddings-client.js:_setLoaderForTests` pattern. Ships a
  `Map`-backed `createMemoryFakeIDB()` for `node:test`.

- **`js/intelligence/memory/embeddings.js`** — the canonical
  embed-input format. `canonicalEmbedText(rec)` builds
  `"${key}: ${value}"` (value JSON-stringified when not a string)
  and is the single owner of that format. PR #3's file-layer reconciler
  and PR #4's `memory_remember` tool both call this so semantic search
  across the file/runtime divide stays consistent. `embedRecord(client,
  rec)` is the convenience wrapper that delegates to a caller-provided
  embedding client (typically `js/embeddings-client.js:EmbeddingsClient`).
  No caching, no batching, no retries — `EmbeddingsClient` already does
  those.

- **`js/intelligence/memory/audit.js`** — append-only log over IDB
  store `memory_audit`. `append({actor, action, record_id, before,
  after, reason})` returns the assigned `seq` (autoIncrement guarantees
  monotonic ordering). `list({recordId?, sinceTs?, limit?})` and
  `listForRecord(recordId)` are the read paths. Rejects malformed
  entries synchronously before any IDB write.

- **`js/intelligence/memory/store.js`** — the public CRUD surface.
  `create()`, `update()`, `supersede()`, `softDelete()`,
  `purgeExpired()` mutate; `getById()`, `getByKey()`, `list()`,
  `searchSemantic()` query. Every mutation routes through `KeyMutex`
  on `chainKey(scope, owner, key)`, writes to IDB, appends an audit
  entry, and emits the corresponding `memory:*` event on `EventBus`.
  `update()` rejects identity-bearing field changes (use
  `supersede()`); `softDelete()` sets `superseded_by = DELETED_SENTINEL`;
  `searchSemantic()` filters out records with `embedding === null` so
  records pending indexing don't pollute the result set. Local
  `cosineSimilarity` so the store runs under `node:test` without
  importing the embeddings-client's module-eval setup.

- **`js/intelligence/memory/index.js`** — barrel re-exporting the
  public surface plus `import('./intelligence/memory')` typedef
  pickup. Test-seam exports (`_setIDBImpl`, `_resetIDBImpl`,
  `createMemoryFakeIDB`, `_resetMutexForTests`) are exposed so
  `tests/test-memory-*.mjs` can swap the IDB layer and reset state
  between cases.

- **`tests/test-memory-contracts.mjs`** — barrel + constants smoke
  suite. Asserts every public function is exported (so a barrel
  regression fails at import time, not at first use), enum lists are
  frozen, and `MEMORY_SCOPES` is `['user', 'workspace']` only (the
  persona-dropped invariant).

- **`tests/test-memory-validation.mjs`** — pure-function suite over
  `validation.js`. Covers canonicalization, every enum, key length,
  multi-error aggregation, self-supersession, `created_at` vs
  `updated_at` ordering, embedding-type guard (rejects `Float32Array`),
  `md_path` round-trip, actor max length, and `assertValid` throwing
  with `errors[]` attached.

- **`tests/test-memory-store.mjs`** — CRUD-surface suite using the
  Map-backed fake IDB. Exercises create→getById round-trip, key
  canonicalization, audit entry on create, `getByKey` chain walk,
  identity-field guards on update, supersede creating a new head and
  marking the old, `softDelete` with `DELETED_SENTINEL` and list
  filtering, `purgeExpired` with audit action `expire`, scope
  isolation across `user`/`workspace`, list filtering by category /
  expiry / pagination, and `searchSemantic` ranking by cosine with
  null-embedding exclusion and topK truncation.

- **`tests/test-memory-audit.mjs`** — audit-log suite. Asserts
  monotonic seq, optional `ts` injection, malformed-entry rejection,
  `MEMORY_LIMITS.ACTOR_MAX_LENGTH` / `REASON_MAX_LENGTH` enforcement,
  `list` ordering and `sinceTs` filter, `listForRecord` filter, and
  100-way concurrent `append` preserving count and assigning a
  contiguous seq range. Also confirms `before/after` snapshots
  round-trip unchanged through the IDB store.

- **`tests/test-memory-races.mjs`** — race-safety suite. The
  load-bearing case: 50 concurrent `update()` calls against the same
  record produce exactly 50 audit entries with `entries[i].before ===
  entries[i-1].after` for every i — proving the `KeyMutex` serializes
  read-modify-write atomically. Also verifies different keys mutate
  concurrently (no false serialization), `update`/`softDelete` races
  resolve to exactly-one-winner per trial, and the mutex chain map
  drains after operations resolve.

#### Memory Phase 1 — `.aieditor/memory/*.md` file layer (Memory PR #3)

Memory PR #3 of 8 in the 1.3.0 track. Stands up the transparent file
projection of the workspace-scope structured store: per-category
Markdown files at `.aieditor/memory/{preferences,decisions,project_context,
domain_knowledge,workflow}.md` plus an `index.md` pointer. **No
user-visible behavior change in this PR.** The actual `Git.updateFile()`
write at commit time lands in PR #7 (commit-modal "Memory updates"
section, Touch 1 Flow 3A); for now the file content is held in an
in-memory pending buffer that consumers (PR #7's modal, PR #5's Memory
tab diagnostics) read via `getPendingContent(path)` /
`listPendingPaths()`. The reason for the split: the editor has no
working-tree concept, so calling `Git.updateFile()` per mutation would
force a commit per mutation — wrong shape for the auto-staging UX
Decision §3 + Flow 3A describe.

The file format is decided by the kickoff (memory file
`project_design_engagement.md`, Decision §4): one YAML-frontmatter
block per record, frontmatter keys alphabetically sorted, strings
JSON-encoded for unambiguous escape, body JSON-encoded so any
string/object/array round-trips. Records sorted by `key` for
byte-determinism. Conflict resolution at parse time: duplicate keys
keep the latest `updated_at`, drop the others, surface as
`diagnostics.warnings` (no three-way merge — Memory tab in PR #5
renders the warnings).

The `?memoryRepoMode=on` URL flag is the temporary opt-in until PR #5
ships the Settings → Memory toggle. Mirrors the `?compression=off`
precedent from PR #187: URL-only, read-once + cached, logged on first
detection. Removability: delete the flag file + the four-line guard in
`installFileLayer()`; behavior reverts to "file layer inert until PR
#5's Settings toggle activates it."

- **`js/intelligence/memory/file-layer.js`** — the projection module.
  Exports pure `serialize(records)` / `serializeIndex(counts)` /
  `parse(content, opts)` for round-trippable conversion between
  `MemoryRecord[]` and the YAML-frontmatter file format. Lifecycle
  (`enable(workspaceId)`, `disable()`, `loadFromGit({owner, repo,
  branch, gitClient?})`) wires the layer to a specific workspace,
  performs initial flush from existing IDB records on enable, and
  reads any committed `.aieditor/memory/*.md` from Git on workspace
  mount to seed the structured store. Mutation subscriber filters
  events to workspace-scope records belonging to the active workspace
  (user-scope records and other-workspace records are no-ops).
  Pending content read API: `getPendingContent(path)`,
  `listPendingPaths()`, `getDiagnostics()`, `clearDiagnostics()`,
  `isEnabled()`, `getActiveWorkspaceId()`. Helper: `categoryPath(cat)`,
  `indexPath()`. Boot integration: `installFileLayer()` (called from
  `js/app.js`) subscribes to `project:loaded` / `project:cleared` only
  when the URL flag is set. Test seams:
  `_setGitClientForTests(client)`, `_resetForTests()`. Eventual
  consistency: pending content is one IDB roundtrip behind the most
  recent mutation — sub-millisecond in production; tests synchronize
  naturally because `createMemoryFakeIDB()` resolves on next
  microtask.

- **`js/utils/memory-repo-mode-flag.js`** — URL flag reader. Reads
  `?memoryRepoMode=on` (also `=true`/`=1`/`=enabled`,
  case-insensitive) from `window.location.search` once on first call,
  caches the result, logs `[AI Editor] Memory repo-mode ENABLED…` on
  first detection so the operator running manual end-to-end testing
  sees in DevTools which mode the tab is in. Includes
  `_resetCacheForTests` for the node:test seam. Mirrors
  `js/utils/compression-flag.js` byte-for-byte structurally.

- **`tests/test-memory-file-layer.mjs`** — 36 node:test cases over
  the file layer. Pure paths (`categoryPath` for every
  `MEMORY_CATEGORIES` entry; null for unknown including the dropped
  `persona`; `indexPath`). Round-trip (single record; multiple
  records preserving key sort; structured object values; strings
  with quotes, newlines, unicode, and embedded quotes in
  `created_by`). Determinism (input-order independence; empty input
  → empty string). Conflict resolution (duplicate keys → newer
  `updated_at` wins, both ids surface in warning; well-formed blocks
  survive when one block is malformed; records failing
  `validateRecord` skipped with warning; empty/whitespace input
  parses cleanly). Store `md_path` defaulting (workspace-scope
  records get `.aieditor/memory/<category>.md`; user-scope stays
  null; explicit override respected; supersession populates the new
  head). Lifecycle (enable activates; disable clears; rejects empty
  workspaceId; idempotent re-enable; refuses to switch workspaces
  without disable). Initial flush (existing workspace records flush
  on enable; user-scope records skipped; empty workspace produces no
  pending content; re-enable produces byte-identical content).
  Mutation subscription (workspace-scope create regenerates the
  affected category file; user-scope and other-workspace events
  ignored; softDelete regenerates with the record removed; disable
  unsubscribes — subsequent mutations don't regenerate).
  `loadFromGit` (reads via injected fake client; accumulates parse
  warnings; treats getFile errors as "file absent" with no warning;
  refuses when not enabled). Diagnostics (`clearDiagnostics` empties
  the buffer). Index regeneration (omits zero-count categories;
  updates when a mutation reaches a new category).

- **`evals/` — NIAH context-attention eval harness.** Empirically
  tests the architectural assumption (DESIGN-retrieval.md §475,
  DESIGN-memory.md §74) that *transformer attention is strongest at
  the head and tail of the window* against the actual models AI Editor
  calls. Plants a passcode in a long *Pride and Prejudice* haystack
  at varying depths (5%, 25%, 50%, 75%, 95%), asks the model to
  recite it, scores hit/miss across small/medium/large context tiers
  on Venice. Bypasses `LLM.chat()` so it can capture provider
  rate-limit response headers (`x-ratelimit-{limit,remaining,reset}-{requests,tokens}`)
  for slow-roll pacing — the same algorithm is queued for production
  in ROADMAP §1.2.5. Reuses settings, model registry, and pricing
  from the running app via `localStorage`; keeps no key material in
  committed code. Never imported by `js/app.js` or CI. Runs against a
  $10 budget cap; full grid (~150 calls across 3 model tiers) costs
  ~$5.70 and ~10–15 min wall-clock TPM-bound. Pre-flight unit suite
  at `evals/test-haystack.mjs` (10 cases) gates harness sanity before
  any API call.

- **Inline `@memory` chip + picker (Memory PR #8).** Typing `@memory`
  in the chat input opens a Preact-rendered popover with the user's
  memories (user + workspace scopes). Arrow keys navigate, Enter
  inserts a `[memory:<key>]` markdown citation token at the trigger
  site, Esc closes without inserting. Three-file split mirrors the
  consent card (PR #6) and Memory tab (PR #5) precedents:
  - `js/chat/memory-chip/match.js` — pure helpers
    (`findActiveTrigger`, `filterMemories`, `formatCitation`,
    `applyCitation`); DOM-free and store-free so node:test can
    exercise every rule without loading Preact.
  - `js/chat/memory-chip.js` — controller (module-local state,
    pub-sub, `MEMORY_EVENTS` subscription for live refresh, lazy
    load on first show). Public surface: `showChip / hideChip /
    setChipQuery / navigateChip / selectChipActive / isChipVisible`.
  - `js/chat/memory-chip/MemoryChip.js` — Preact component;
    subscribes to the controller and re-renders on each state
    change.
  - `js/chat/input.js` integration — trigger detection on `input` /
    `click` / arrow-key / `blur` events; navigation/selection/
    dismissal on keydown when the chip is visible (consumes the
    event so the existing Enter-to-send doesn't fire).
  - `html/chat-panel.html` — `#memoryChipRoot` slot inside
    `.chat-input-area` with absolute-positioned popover (no layout
    reflow).
  - `css/memory.css` — `.mem-chip` styles mirroring the `.mem-consent`
    visual vocabulary so the three Memory surfaces feel consistent.
  - `tests/test-memory-chip-match.mjs` (24 cases) +
    `tests/test-memory-chip-controller.mjs` (12 cases) — full
    coverage of trigger detection, filter scoring, citation insertion,
    visibility seam, navigation wrap, selection callback, hide
    idempotency.

### Fixed

- **Plugin lifecycle: `setEnabled(true)` now runs `init()` on first
  enable.** (#190) Previously `setEnabled` only flipped the boolean
  and emitted `plugin:enabledChanged` — it never called `init()`.
  Plugins shipped with `defaultEnabled: false` (release-sync,
  cross-repo-issues, custom user plugins that opted out of auto-init)
  registered at boot, got skipped by the boot-time `Plugins.init()`
  loop in `js/app.js`, and stayed UI-less even after a user toggled
  them on in Settings. `setEnabled` is now async and calls
  `manifest.init(config)` exactly once on the first disabled→enabled
  transition. See `tests/test-plugin-lifecycle.mjs` for coverage.

### Changed

- **`js/chat/compactor-integration.js`** — when
  `isCompressionDisabled()` is true, `getCompressedContextMessages()`
  short-circuits past `Compactor.compress` entirely, attaches
  diagnostics with `warnings: ['disabled_via:url_flag(?compression=off)']`
  to the active LLM exchange (so the LLM Debug modal makes the mode
  obvious), and hands `State.chatHistory` straight to
  `ChatSummarizer.getContextMessages` — the pre-1.2.0 baseline path.
  Default behavior (no flag) unchanged.


- **README.md `Deployment` section** — vendor-bundle list now
  includes Preact + htm. Adds a one-paragraph note pointing at
  Decision §9: select new state-heavy surfaces (Memory tab first; later
  the active-tools chip row and profile picker) use Preact + htm
  loaded as a single ~5KB ESM bundle, no JSX, no build-time transform.
  Existing surfaces stay vanilla forever.

- **`js/intelligence/memory/store.js`** — `create()` and `supersede()`
  now populate `md_path` automatically for workspace-scope records when
  the caller doesn't supply one (`.aieditor/memory/<category>.md`).
  User-scope records stay `null`. Lets the file layer (this PR's
  `file-layer.js`) know which file each record projects into without
  requiring every caller (PR #4's LLM tools, PR #5's UI) to compute
  the path. Existing field validation (`md_path` is null or string)
  unchanged.

- **`js/app.js`** — calls `installMemoryFileLayer()` during the boot
  init sequence (alongside `initCostRecorder` / `initSessionListeners`).
  Exposes `window.AIEditor.memoryFileLayer = { getPendingContent,
  listPendingPaths, getDiagnostics, isEnabled, getActiveWorkspaceId }`
  so the manual end-to-end test against `editor.gobha.ai/dev?memoryRepoMode=on`
  can inspect pending content from DevTools without code changes.
  PR #5's Settings → Memory tab reads from the same surface; PR #7's
  commit modal too.

- **`js/intelligence/memory/index.js`** — re-exports the file-layer
  surface (15 named exports plus 2 test seams). Consumers
  (`js/app.js`, future PR #4–#7) `import { ... } from
  'intelligence/memory/index.js'` rather than reaching into the
  individual sub-modules.

- **`js/storage/idb.js`** — bumps `DB_VERSION` from 1 to 2 to add the
  Memory subsystem's two object stores additively. The existing `kv`
  store is unchanged and its data is preserved. New: `memory_records`
  (keyPath `id`) with four indexes — compound `by_scope_owner_key`,
  `by_scope_category`, sparse `by_superseded_by`, sparse
  `by_expires_at` — and `memory_audit` (autoIncrement keyPath `seq`)
  with `by_record_id` and `by_ts` indexes. The schema upgrade runs
  once per browser tab on first load after deploy. Failure mode if a
  tab's upgrade is blocked is the existing `IDB.open()` warning at
  `[IDB] Database open blocked — close other tabs` — no data is lost
  because the upgrade is purely additive.

#### Memory Phase 1 — LLM tools (Memory PR #4)

Memory PR #4 of 8 in the 1.3.0 track. Wires three OpenAI-function-calling
tools — `memory_remember`, `memory_recall`, `memory_revise` — over the
PR #2 store and PR #3 file layer. **No user-visible behavior change in
this PR.** The model can call these tools when something prompts it to,
but no system-prompt injection auto-fires memories into context yet —
that arrives with PR #5 (Settings → Memory tab) and PR #8 (release / the
inline `@memory` chip + DESIGN-memory.md update). PR #4 is foundation
for the rest of the track; it ships now to unblock parallel work on the
Settings tab and the consent card.

The tools honor the two kickoff decisions (memory file
`project_design_engagement.md`, 2026-04-30): `scope` is `user|workspace`
only — `persona` was dropped — and the `source` enum
(`user_explicit | agent_proposed | inferred`) is the surface the tools
expose, not the dropped `confidence: float` field.

- **`js/tools/memory-tools.js`** — registers the three tools. Wraps the
  store's `create / update / supersede / getByKey / list / searchSemantic`
  surface. `memory_remember` looks up `(scope, owner, key)` first and
  auto-supersedes when a head exists; semi-deterministic for the model
  ("remember X" with the same key twice produces the audit chain a human
  would expect). Embeds via `embedRecord()` before write so semantic
  recall hits immediately; embedding-down (provider offline, embeddings
  disabled) writes still succeed with `embedding: null` and the response
  carries `embedded: false`. `memory_recall` accepts `scope: 'all'` (a
  synthetic value not in `MEMORY_SCOPES`) and merges per-scope queries —
  rationale: the model rarely knows where a fact was filed; forcing it
  to pick scope-by-scope means missed hits and giving up. `memory_revise`
  patches in place via `update()`; identity fields are unreachable from
  the schema; `reason` is required. Owner-id resolution: workspace via
  `getActiveWorkspaceId()` (returns an actionable error when no project
  is loaded — the `?memoryRepoMode=on` flag is still the gate until PR
  #5 ships the Settings toggle); user via a lazy UUID stored at
  `Storage('memoryUserId')` — global per origin (the bare key isn't in
  `Storage._TAB_SCOPED`), so user memories don't fragment across tabs.
  Actor format `'agent:<llmModel>'` so the audit log distinguishes
  agent calls from PR #6's user-clicked Settings/consent mutations.
  Role gates: `recall` is `'all'` (read-only is harmless); `remember`
  and `revise` are `['full', 'coder', 'pm']` — `reviewer` is read-only
  by charter, `plugin-dev` is plugin-scoped.

- **`tests/test-memory-tools.mjs`** — node:test suite covering the three
  tools end-to-end through the registry, the in-memory IDB fake, and a
  stub embeddings client. Cases: happy-path create, idempotent
  re-remember (action=superseded with chain), default scope/source,
  workspace-no-active-project graceful error, invalid category/source/
  persona-scope rejected with helpful messages, embedding-down write
  proceeds with `embedded:false`, user-scope owner via Storage,
  semantic vs list recall paths, `scope: 'all'` merge, workspace-empty
  recall with note, embeddings-down query falls back to list with
  `note`, category filter, limit clamp, revise patches in place +
  re-embeds, source-only revise leaves value untouched, unknown id /
  superseded id / missing reason / no-field-changes errors, and role-
  gate denial for `reviewer` on remember (with recall still allowed).
  24 cases total.

- **`js/chat/index.js`** — wires `registerMemoryTools(ToolRegistry)` into
  the boot sequence after `registerPluginTools`.

#### Memory Phase 1 — Settings → Memory tab (Memory PR #5)

Memory PR #5 of 8 in the 1.3.0 track. Lands the **first Preact + htm
consumer** in the codebase (Decision §9) — the Settings → Memory tab.
Closes the "memory is real but invisible" gap: PRs #2-#4 made it
possible for the agent and the file layer to read/write memories, but
the user had no UI to inspect, edit, or delete them. Layout follows
Touch 1 design Flow 2A (`docs/design/touch-1-memory-ux/project/
flow2-settings.jsx`) — in-strip tab placement between Roles and
Plugins, split-pane list+detail, repo-mode toggle, scope filter chips,
inline audit log on the selected record. The mock's `persona` chip and
`confidence` float are absent per the 2026-04-30 kickoff (Decisions
§1, §2): scopes are `user`+`workspace` only, and the `source` enum
(`user_explicit | agent_proposed | inferred`) drives the affordance.

Live updates: the tab subscribes to `MEMORY_EVENTS.{CREATED,UPDATED,
DELETED}` so memories created via the `memory_remember` tool while the
modal is open appear without a manual refresh. Effect cleanup
unsubscribes on unmount; the settings-manager unmounts on
`closeSettings()` so the EventBus subscription window matches the
modal's open lifetime — no leaked listeners across cycles.

Out of scope here (sequenced for later Memory PRs): chat consent card
(PR #6), commit-modal "Memory updates" section (PR #7), inline
`@memory` chip + DESIGN-memory.md update + 1.3.0 release (PR #8).

- **`js/settings/memory-tab.js`** — `mountMemoryTab()` /
  `unmountMemoryTab()` lifecycle surface. Owns the Preact root, the
  cleanup fn returned by `mountPreact`, and an idempotent guard so
  repeated tab clicks don't double-mount. Loads `MemoryTab.js` via
  dynamic import — the components file uses top-level `await
  getPreact()`, so dynamic import keeps a Preact bundle/CDN failure
  out of `settings-manager.js`'s synchronous import graph.
- **`js/settings/memory-tab/MemoryTab.js`** — Preact components.
  Single file with `MemoryTab` (root, owns records / selectedId /
  filter / scope state), `MemoryToolbar` (count badge, file-mode
  toggle, audit toggle, export), `MemoryRepoBanner` (file-mode pending
  paths), `MemoryFilters` (search + scope chips), `MemoryList` +
  `MemoryRow` (scope badge, key:value, source + relative-time meta),
  and `MemoryDetail` (read-only key, value textarea, scope/source/
  category tags, recent-audit list, Save/Delete). Save calls
  `update(id, {value}, ...)`; Delete uses `softDelete()`. Audit toggle
  expands the list from last 5 to last 50 inline, no extra modal.
  Export is a JSON `Blob` download mirroring `exportSettings()`. "all"
  scope chip queries both `user` and `workspace` and merges by
  `updated_at`.
- **`js/intelligence/memory/owner.js`** — single source of truth for
  user-scope owner-id resolution. Exports `getOrCreateUserOwnerId()`
  (lazy UUID persisted at `Storage('memoryUserId')`, shared across
  tabs because the key is not in `Storage._TAB_SCOPED`). Both
  `memory-tools.js` (PR #4 LLM tools) and `MemoryTab.js` (this PR)
  consume this resolver, so the tab and the agent see the same user
  bucket. Without it the tab would render empty after an agent's
  `memory_remember` call — caught during real-world testing of this
  PR before merge. Future Memory PRs (#6 consent card, #8 @memory
  chip) reuse it too.
- **`html/modals.html`** — new `<button data-tab="tabMemory">` between
  Roles and Plugins (Touch 1 Variant A position).
- **`html/settings-tabs.html`** — new `<div id="tabMemory"
  class="settings-tab-content">` panel with a
  `<div id="memoryTabRoot">` slot for the Preact mount.
- **`js/settings-manager.js`** — imports `mountMemoryTab` /
  `unmountMemoryTab`. Tab-switch handler calls `mountMemoryTab()`
  alongside the existing `populateModelsTab()` / `populatePluginsTab()`
  patterns. `closeSettings()` calls `unmountMemoryTab()` so each modal
  open gets a fresh root.
- **`css/memory.css`** — full visual surface for the tab. Class names
  mirror the Touch 1 design canvas styles for vocabulary continuity
  with the consent card / commit-modal section / @memory chip that
  ship in PRs #6-#8. Includes scope-badge color treatments
  (user=accent blue, workspace=success teal), source-tag treatments
  (`user-explicit` neutral, `agent-proposed` warning yellow,
  `inferred` muted italic), pill-switch toggle, repo-mode banner.
- **`css/base.css`** — adds `--memory: var(--accent)` token. Tracks
  accent today; reserved as a distinct knob so memory surfaces can
  move to a memory-specific hue without touching every site.
- **`index.html`** — links the new `css/memory.css` file alongside the
  existing component CSS files.
- **`tests/test-memory-tab.js`** — browser smoke test pinning the
  integration contract. Swaps the memory IDB to the in-memory fake
  via `_setIDBImpl(createMemoryFakeIDB())`, seeds 3 records, mounts
  the tree into a fixture div, asserts row count, fires a `create()`
  while mounted and asserts the row count rises (live-update path),
  fires `softDelete()` and asserts it falls, then runs cleanup and
  asserts the EventBus listener count returns to baseline (no leaked
  subscriptions). Resets the IDB impl in the `finally` so other suites
  see real IDB. Registered under "Memory Tab" in `tests/index.html`.

#### Memory Phase 1 — Chat consent card (Memory PR #6)

Memory PR #6 of 8 in the 1.3.0 track. Closes the consent gap: before
this PR, `memory_remember` with the default `source: 'agent_proposed'`
wrote to the IDB store immediately and silently. Per Touch 1 Flow 1
(`docs/design/touch-1-memory-ux/project/flow1-consent.jsx`), the user
must Accept / Edit / Dismiss an inline card before an agent-proposed
memory becomes durable. **Second Preact + htm consumer** in the
codebase (Memory tab was first; active-tools chip row at 1.4.0 is next
per Decision §9).

The consent flow is implemented as a pending in-memory queue, not a
write-immediately-then-revise/softDelete model. Three reasons argued
against the cheaper alternative: (1) **tool-result honesty** — the
model needs to know whether its write durably landed; returning
`created` when the user might dismiss is a lie the next `memory_recall`
exposes; (2) **file-layer thrash** — `js/intelligence/memory/file-layer.js`
regenerates `.aieditor/memory/<cat>.md` on every CREATED/UPDATED/DELETED;
write-then-delete per dismissed proposal is git noise with repo-mode on;
(3) **audit cleanliness** — dismissed proposals never became state and
shouldn't appear in `audit.listForRecord()`.

`source: 'user_explicit'` and `source: 'inferred'` bypass the queue and
write immediately — the consent gate applies only to `agent_proposed`.

The "quiet" single-line variant is enabled via `?memoryConsentVariant=quiet`
URL flag (mirrors `?compression=off` and `?memoryRepoMode=on` precedent).
A Settings toggle is deferred to a 1.3.x patch if real-user feedback
asks for it.

- **`js/intelligence/memory/consent-queue.js`** — in-memory pending
  queue. Surface: `enqueue(input)`, `get(id)`, `list()`, `accept(id, opts)`,
  `dismiss(id, opts)`, `clearAll()`. Lifetime: page session only — no
  IDB persistence (a reload drops pending proposals; a `chat:cleared`
  event drops them too). `accept()` does the `getByKey` → `create` /
  `supersede` branch deferred from the tool, so the head record at
  accept time wins (between propose and accept the head may have
  changed). Embedding work also moves here so dismissed candidates
  skip the embedder entirely. Test seam:
  `_setEmbeddingsClientForTests`, `_resetForTests`.
- **`js/intelligence/memory/contracts.js`** — extends `MEMORY_EVENTS`
  with `CONSENT_REQUESTED: 'memory:consent_requested'` (payload
  `{candidate}`) and `CONSENT_RESOLVED: 'memory:consent_resolved'`
  (payload `{candidate_id, outcome: 'accepted'|'dismissed', record_id?}`).
  Adds `MemoryCandidate` typedef + the two payload typedefs. **Does
  not** extend `AuditAction` — dismissals are intentionally unaudited.
- **`js/tools/memory-tools.js`** — `memory_remember` branches on
  `source` after validation. `agent_proposed` enqueues a candidate via
  `consentEnqueue()` and returns `{status: 'pending_consent',
  candidate_id, key, value, scope, category, source, hint}` — the model
  is told explicitly that the write is not durable and not to call
  `memory_recall` expecting to find it. `user_explicit` and `inferred`
  paths are unchanged. Tool description updated so the consent gate is
  visible at the function-calling boundary.
- **`js/chat/consent-card.js`** — Preact mount wrapper. Mirrors
  `js/settings/memory-tab.js` (the PR #5 precedent) but accepts a
  caller-supplied root because each consent card mounts into a fresh
  chat-message slot. Tracks active mounts via WeakMap + a strong-ref
  Set so `unmountAll()` can drain everything in one pass. Idempotency
  guard prevents double-mount on the same root. Vanilla error fallback
  if Preact load fails. Test seams: `_isMounted`, `_resetForTests`.
- **`js/chat/consent-card/MemoryConsentCard.js`** — Preact component.
  Four-state machine (`open | editing | saved | dismissed`) over three
  visual sub-components: `InlineCard` (default), `QuietLine` (URL
  flag), `SavedCard` (post-Accept with Undo). `Enter` accepts in either
  open or editing mode; `Escape` cancels edit. `Undo` calls
  `softDelete()` with `reason: 'user undid consent'`. The "Will be
  staged with your next commit on `<branch>`" line shows only when the
  file layer is enabled and the candidate is workspace-scope.
- **`js/chat/messages.js`** — exports `addConsentCardMessage(candidateId)`
  which appends a `<div class="chat-message mem-consent-slot">` and
  fires `mountConsentCard()`. Modifies `clearChat()` and
  `renderMessages()` to call `unmountAllConsentCards()` *before*
  `chatContainer.innerHTML = ''` so Preact effect-cleanup runs while
  the DOM still exists (otherwise listeners subscribed inside the
  component would leak across re-renders). After re-render,
  `renderMessages()` walks `consentList()` and re-mounts cards for any
  candidate still pending — survives a tab switch / `editMessage`
  re-render without re-prompting the agent.
- **`js/chat/handlers.js`** — after `addToolCallMessage`, branches on
  `toolName === 'memory_remember' && toolResult?.status ===
  'pending_consent'` to call `addConsentCardMessage(candidate_id)`.
  The tool-call panel still renders so the agent's call is visible;
  the card sits below it.
- **`js/app.js`** — subscribes to `chat:cleared` and calls
  `consentClearAll()` so a "new chat" drops any pending proposals (the
  conversational context that produced them is gone).
- **`css/memory.css`** — appends `.mem-consent*` block (~230 lines)
  using the existing `--accent`, `--text-muted`, `--text-secondary`,
  `--font-mono` tokens. Class names match `flow1-consent.jsx`. Saved
  state uses an accent-tinted background + Undo link; dismissed
  collapses with `display: none` so the chat reflow is consistent
  regardless of resolution outcome. Quiet variant uses a dashed border
  and a single-line layout.
- **`tests/test-memory-consent-queue.mjs`** — 13 cases over the queue
  surface: enqueue UUID shape + CONSENT_REQUESTED emission, key
  canonicalization, list snapshot, clearAll silent, accept (no
  existing key) emits CREATED then CONSENT_RESOLVED in order, accept
  with edited value writes the edit, accept on existing key takes the
  supersede branch, accept on unknown id throws, source override
  honored, embedding success populates record, embedder error swallowed
  (record persisted with `embedding: null`), dismiss emits RESOLVED
  with no store write + no audit, dismiss is idempotent, accept is
  one-shot (drop-before-write contract).
- **`tests/test-memory-consent-tool-flow.mjs`** — 7 cases at the LLM-
  tool boundary: agent_proposed returns `pending_consent` and writes
  nothing, user_explicit bypasses queue (immediate write), inferred
  bypasses queue, agent_proposed → consentAccept produces a record
  with `source: user_explicit` and the audit log captures it as
  create, Edit + Accept stores the edited value, Dismiss leaves no
  record + no audit, supersede branch fires when an existing record
  at the same `(scope, owner, key)` is present.
- **`tests/test-memory-consent-card-mount.mjs`** — 7 cases over the
  Preact mount wrapper using the `_setLoaderForTests` stub: render
  fires with the supplied root, idempotent per root, unmount runs
  cleanup + clears tracking, `unmountAll` drains every active mount,
  null-root and empty-candidateId no-op cleanly, dynamic-import failure
  falls back to the vanilla error banner.
- **`tests/test-memory-tools.mjs`** — existing tests updated for the
  new contract: every test that seeded records via `memory_remember`
  with implicit default source now passes `source: 'user_explicit'` so
  it bypasses the queue (the test's intent was always immediate
  write). The "default source" test was rewritten to assert the new
  `pending_consent` return shape.

#### Memory Phase 1 — Commit-modal "Memory updates" section (Memory PR #7)

Memory PR #7 of 8 in the 1.3.0 track. Closes the third Touch 1 flow
(`docs/design/touch-1-memory-ux/project/flow3-commit.jsx`): pending
`.aieditor/memory/*.md` writes from `file-layer.js` are now visible
inside the commit modal alongside the user's dirty editor tabs.

Two surface variants per ROADMAP Decision §4 ("Memory files auto-stage
on commit when repo mode is opt-in AND the current branch isn't
protected"):

- **Flow 3A — unprotected branch.** A `commit-section--mem` panel auto-
  stages every pending memory path; each row carries a Show/Hide diff
  toggle revealing the pending content as `+ ` prefixed lines. On
  commit, the pseudo-tabs (`{path, content, sha: undefined}`) ride
  through `batchSaveFiles()` so the provider takes the create branch
  for new files and the update branch for existing ones. Successfully-
  committed paths drop from `_pendingFiles` via the auto-clear hook —
  partial-success commits leave failed paths pending so the user can
  retry without losing them.
- **Flow 3B — protected branch.** The same paths surface as a
  `commit-section--warn` panel with disabled checkboxes and three
  escape-hatch buttons: **Branch off & commit memory** (placeholder —
  emits `memory:branchOffRequested` and points at the 1.3.x patch that
  wires the real branch-creation flow), **Keep pending** (closes the
  modal without staging; pending state preserved), **Discard** (drops
  every visible path from the projection, leaving IDB source records
  intact). The commit button label adopts a `(code only)` suffix when
  Flow 3B is active so the user understands that a green Commit only
  sends the code files.

The renderer is vanilla DOM (string in, string out) per Decision §9 —
the next Preact slot is reserved for the active-tools chip row at
1.4.0; the section's small surface and minimal local state didn't earn
the framework. `escapeAttr()` covers both attribute and content
escaping so the renderer is testable under `node --test` without a
DOM.

- **`js/ui/commit-memory-section.js`** *(new)* — pure renderer
  (`renderMemoryUpdatesSection({isProtected, pendingPaths, branch})`)
  + click delegation (`wireMemoryUpdatesSection(rootEl, callbacks)`).
  Idempotent wiring replaces any previous handler so re-renders
  between modal opens don't accumulate listeners. Show/Hide diff
  toggles a sibling `<pre>` per row, lazily filled via
  `getPendingContent(path)` on first expand. `formatPendingDiff()`
  prefixes each line with `+ ` for the preview.
- **`js/ui/commit.js`** — three integration points:
  `openCommitModal()` calls a new `_renderMemorySection()` helper that
  reads `listPendingPaths()` + `_currentBranchIsProtected()` (looks up
  `State.branches.find(b => b.name === State.currentBranch)?.protected`)
  and writes the rendered section into `#commitMemorySection`.
  `commitAndPush()` builds memory pseudo-tabs only on unprotected
  branches and concatenates them with the user's selected dirty tabs
  before `batchSaveFiles()`. Auto-clear runs after the call: filter
  committed paths against the original pending set and call
  `discardPendingMemoryWrites()` on the intersection. The commit
  button label gains a `(code only)` suffix when Flow 3B is active.
- **`js/intelligence/memory/file-layer.js`** — new export
  `discardPendingMemoryWrites(paths?)` drops paths from
  `_pendingFiles` without touching IDB source records. Emits one
  synthetic `MEMORY_EVENTS.UPDATED` (`{before: null, after: null}`)
  when paths are actually dropped so the Settings → Memory tab's
  pending-paths indicator refreshes if it's open. The file layer's
  own `_onMutation` listener guards on `record.scope === 'workspace'`
  and treats null as a no-op, so the synthetic envelope doesn't
  trigger a regenerate cycle. No-op when the layer is disabled.
- **`js/intelligence/memory/index.js`** — re-exports
  `discardPendingMemoryWrites` alongside `listPendingPaths` /
  `getPendingContent` / `isEnabled`.
- **`html/modals.html`** — adds `<div id="commitMemorySection">`
  between the file-list `.form-group` and the commit-message
  `.form-group`. Empty when no pending paths or layer disabled.
- **`css/memory.css`** — appends a 165-line `.commit-section*` block
  with the two variants (`--mem` accent left border, `--warn` warning
  left border), the `.commit-file--mem` row, the `.commit-mem-diff`
  preview `<pre>`, the `.branch-row__protected` indicator pill, and
  the `.src-link` toggle style. Reuses already-shipped `.mem-btn` /
  `.mem-btn--ghost` from PR #5/#6.
- **`tests/test-commit-memory-section.mjs`** — 11 node:test cases over
  the renderer: empty input → empty string; Flow 3A render shape;
  Flow 3B render shape with three buttons; pluralization; XSS escape
  on path and branch; `formatPendingDiff()` line-prefixing.
- **`tests/test-file-layer-discard.mjs`** — 6 node:test cases: no-op
  when disabled; named-path drop; clear-all; IDB source records
  unchanged; exactly-one synthetic event per drop batch; unknown path
  is a silent no-op.
- **`tests/test-commit-modal-memory.js`** — 22-assertion browser smoke
  pinning Flow 3A / 3B render shapes, Show/Hide diff toggle, Discard
  click clearing pending paths while keeping IDB records. Wired into
  `tests/index.html` after the Memory Tab suite.

### Notes

- **Version bump 1.2.1 → 1.3.0.** Memory PR #8 closes the 1.3.0 track
  and cuts the release. Per `feedback_version_bump.md`, intermediate
  PRs in a track ship under `[Unreleased]`; the bump lands here
  alongside the `@memory` chip, the `docs/DESIGN-memory.md` updates
  (drop persona scope, drop confidence float, codify the
  `.aieditor/memory/*.md` file format, document the chat citation
  wire format and div-slot mount pattern), and the ROADMAP §1.3.x
  reframe (workspace shipped in 1.3.0; original §1.3.1 slot reused
  for self-healing tools; persona §1.3.2 deferred indefinitely;
  remaining patches renumbered).
- **Removability (Memory PR #5).** Delete `js/settings/memory-tab.js`,
  the `js/settings/memory-tab/` directory, `css/memory.css`, the
  `tabMemory` button + panel, the settings-manager wiring, the
  `--memory` token, and the test file; the memory subsystem still
  works (the `memory_remember/recall/revise` tools and the file
  layer are independent), but users lose the only direct surface for
  inspecting/editing/deleting memories. The `memory_remember` tool
  becomes a write-only black box without the tab to read it back —
  that's the user-visible gap PR #5 closes.
- **Removability (Memory PR #6).** Delete `js/intelligence/memory/consent-queue.js`,
  `js/chat/consent-card.js`, the `js/chat/consent-card/` directory,
  the new test files, and revert the four-line branch in
  `js/chat/handlers.js`, the `addConsentCardMessage` export +
  unmountAll wiring in `js/chat/messages.js`, the `chat:cleared`
  subscription in `js/app.js`, the `agent_proposed` branch in
  `js/tools/memory-tools.js`, and the `MEMORY_EVENTS.CONSENT_*`
  channel additions in `js/intelligence/memory/contracts.js`.
  Behavior reverts to "agent-proposed memories write immediately and
  silently" — the user-visible gap closed by PR #6 is exactly that
  silent write becoming an explicit Accept/Edit/Dismiss card.
- **Removability (Memory PR #7).** Delete `js/ui/commit-memory-section.js`,
  the new test files, and revert the integration block in
  `js/ui/commit.js` (the `_renderMemorySection` helper, the import
  block, the memory-pseudo-tabs branch in `commitAndPush`, the
  auto-clear hook), the `discardPendingMemoryWrites` export in
  `js/intelligence/memory/file-layer.js` and its re-export in
  `js/intelligence/memory/index.js`, the `<div id="commitMemorySection">`
  in `html/modals.html`, and the `.commit-section*` block appended to
  `css/memory.css`. Behavior reverts to "pending memory writes from
  the file layer are invisible at commit time" — the user has no path
  to commit `.aieditor/memory/*.md` files (the file layer holds them
  in `_pendingFiles` indefinitely) and no signal on protected branches
  that the writes can't be staged. The user-visible gap closed by
  PR #7 is exactly that invisible accumulation becoming a legible
  panel that auto-stages on feature branches and warns on protected
  ones.
- **Removability (Memory PR #8).** Delete `js/chat/memory-chip.js`,
  the `js/chat/memory-chip/` directory, and the new test files; revert
  the chip-related imports and event-handler additions in
  `js/chat/input.js`, the `<div id="memoryChipRoot">` slot in
  `html/chat-panel.html`, and the `.mem-chip*` block appended to
  `css/memory.css`. Behavior reverts to "users must paste memory keys
  manually if they want to cite a memory in a message." That's
  acceptable — the chip is a discovery affordance, not load-bearing
  for the subsystem (the LLM tools, store, file layer, Settings tab,
  consent card, and commit-modal section all keep working). The
  user-visible gap closed by PR #8 is exactly that the existing
  memories were invisible to the chat author at message-composition
  time.

## [1.2.1] - 2026-04-29

Opens the **Cost dashboard** patch from `docs/ROADMAP.md` §1.2.1 — the
measurement-before-scale gate per Decision §8. Without this dashboard
in production for at least a week, the 1.2.x cadence (Rule 3 → Rule 4
→ Rule 5 tuning) has no way to confirm that 1.2.0's Rules 1+2
delivered the projected ≥40% reduction; if they didn't, the rest of
the track gets re-scoped, not stacked on an unverified base.

### Added

- **`js/intelligence/cost/` module tree** — second occupant of the
  `js/intelligence/` umbrella after compression in 1.2.0.
  - `cost-store.js`: synchronous Storage layer over three keys —
    `cost-by-conv-{id}` (per-conversation aggregate with byTool /
    byModel breakdowns), `cost-daily` (rolling 30-day calendar with
    byProvider breakdown, auto-pruned on every write), and
    `cost-budget` (daily / monthly USD caps). Local-date stamps
    (`localDateKey`) so the chart matches the user's wall clock.
  - `budget.js`: pure threshold helpers — `checkThresholds(spend, cap)`
    returns `{level: 'ok'|'warn'|'over', percent}` with WARN at 80%
    and OVER at 100%; `pickWorse({daily, monthly})` returns the more
    pressing of the two so the banner copy can name the offender.
  - `cost-recorder.js`: subscribes to the existing `cost:updated`
    event from `js/llm/api.js` and `llm:generating` for the
    conversation-switch race fix — snapshots `activeConversationId`
    on generation start, attributes the next `cost:updated` to that
    snapshot rather than whichever conversation was active when the
    response arrived. Per-tool attribution proportionally credits
    `prompt_tokens` to each tool by tool-result byte length;
    documented as **estimated** (1.4.0's admission ledger replaces
    this with measured numbers).
  - `index.js`: barrel exporting the public surface plus
    `initCostRecorder()`.

- **Settings → Cost tab** (`js/settings/cost-tab.js`,
  `html/settings-tabs.html`). New tab between Storage and Advanced.
  Vanilla JS — Memory in 1.3.0 is the first Preact target, not this.
  - Live session card mirroring `State.sessionCost`.
  - 30-day SVG bar chart (no chart library) with daily USD spend +
    hover tooltip showing per-provider breakdown.
  - Conversations list sorted by spend, click-to-load through the
    existing `ConversationManager.load(id)`.
  - Per-tool breakdown for the active conversation — calls + estimated
    tokens, labelled "Estimated" with a tooltip explaining the
    Phase-1 caveat.
  - Budget alert inputs (daily / monthly USD caps) with
    `Today: $X of $Y` and `This month: $X of $Y` hint lines.
  - Provider note that links to `plugins/venice-billing.js` when
    Venice is the active provider, since that overlay still owns the
    live USD/DIEM API view.

- **Conversation drawer cost chip.** Each row in
  `js/chat/index.js` `renderConversationList` now appends `· $X.XX ·
  Nk tok` to the meta line when a `cost-by-conv-{id}` record exists.
  Older conversations pre-1.2.1 fall back gracefully (no chip).
  Drawer rerenders on `cost:updated` while open so the chip stays
  current.

- **Soft budget-warning banner above the chat input** at 80% (warn)
  and 100% (over) of the configured daily or monthly cap, whichever
  is worse. Inserted into `.chat-input-area`, dismissable, never
  blocks a request — Decision §8 commits to soft-only in 1.2.1; hard
  halts can revisit if dashboard data shows demand.

- **`tests/test-cost-store.mjs`, `test-cost-budget.mjs`,
  `test-cost-recorder.mjs`** — node:test coverage for aggregation
  arithmetic, daily-prune at 30 days, multi-conversation isolation,
  budget round-trip, and per-tool attribution proportionality.

### Changed

- **`js/llm/api.js` `LLM._trackUsage` and `cost:updated` event
  payload.** Now optionally accepts a `context = {messages, toolCalls}`
  argument and forwards it into the event. Existing consumers
  (`js/model-manager.js` `updateCostTracker`) ignore the new fields.
  Backwards compatible.

- **`js/chat/conversations.js` `ConversationManager.delete()`** also
  calls `removeConvCost(id)` so the matching `cost-by-conv-{id}`
  record clears. Storage doesn't leak across conversation deletes.

### Notes

- **Per-tool attribution is an estimate.** Phase 1 uses byte-length
  proportions; the 1.4.0 Tools track lands the admission ledger that
  replaces this with measured counts on the unified `TaskLedger` from
  1.1.0. Documented in the dashboard UI.
- **Hard halts are deliberately not in 1.2.1.** Soft warnings only,
  per the locked decision. The roadmap notes hard halts as a future
  patch if usage data shows demand.
- **Removability.** Delete `js/intelligence/cost/` and unregister the
  Settings → Cost tab; `State.sessionCost` keeps working unchanged.
  Persisted records become orphan keys cleared by Storage on next
  cleanup. No data loss; the editor degrades to the pre-1.2.1
  session-only view.
- **Gate for 1.2.2.** ROADMAP §1.2.1 commits Rule 3 (Consumption) to
  ≥1 week of dashboard data showing concrete Rule 1+2 savings before
  it ships. The next minor that opens is whichever the data justifies.

## [1.2.0] - 2026-04-29

Opens the **Compression Phase 1** track from `docs/ROADMAP.md` §1.2.0
— the first eviction subsystem, sized to deliver invisible cost
savings on long, tool-heavy coder sessions before the cost dashboard
arrives in 1.2.1 to verify the projection. Implements Rules 1
(Subsumption) and 2 (Invalidation) per `docs/DESIGN-compression.md`
§"The Five Rules"; existing summarizer stays in place as Rule 5
fallback (tighter integration is §1.2.4). Other roles keep current
Rule-5-only behavior via a profile shim.

### Added

- **`js/intelligence/compression/` module tree** — first occupant of
  the new `js/intelligence/` umbrella.
  - `contracts.js`: typedefs (Turn, TurnMetadata, FileOp, Decision,
    CompressionRule, CompressionRequest, CompressionResult,
    Diagnostics) per DESIGN-compression.md §"Core Contracts".
  - `decisions.js`: `Keep` / `Drop` / `Replace` / `Summarize` factories
    + type guards. Tagged-union `kind` discriminator.
  - `tokens.js`: cheap `chars / 3.5` token estimator matching the
    existing `js/chat/summarizer.js` math. Defensive against circular
    refs. Precomputation at turn ingest is a 1.2.x optimization.
  - `turn-store.js`: ChatMessage → Turn conversion, round-trip via
    `metadata.source_index`, synthesized-marker turn factory. Phase-1
    TurnID = `T${index}` per call; stable hash form lands when the
    turn store is persisted.
  - `compactor.js`: async `compress(req)` runs the
    `docs/DESIGN-compression.md` §"Pipeline Algorithm" — sort rules,
    per-turn evaluation (skipping `is_summarizer` rules), tool-pair
    coherence, apply Drop/Replace, optional Rule-5 summarizer loop
    (50-iter safety cap), final budget drop-oldest fallback.
  - `rules/subsumption.js`: Rule 1 — drop a tool_result whose single
    read file-op is fully contained by a later read on the same path,
    with no intervening write/edit. Reason format
    `subsumed_by:{B.id}`.
  - `rules/invalidation.js`: Rule 2 — drop a tool_result whose read
    range overlaps a later write/edit on the same path. Reason
    `invalidated_by:{B.id}`.
  - `rules/summarization.js`: Rule 5 marker (`is_summarizer: true`,
    no-op `evaluate`) plus `wrapChatSummarizer({ChatSummarizer,
    callLLM})` factory that builds a SummarizerFn delegating to the
    existing `js/chat/summarizer.js` `_buildPrompt` /
    `_basicSummary` paths.

- **Tool-pair coherence pass** in the Compactor — keeps eviction
  atomic at the assistant-turn level. The LLM API requires every
  assistant `tool_calls[i].id` be matched by a subsequent `tool`
  message; if Rules 1/2 drop a tool_result without its matching
  tool_call also being dropped, the API returns 400. Algorithm: for
  each assistant.tool_call_ids, count coverage by id; if all
  uncovered → drop the assistant too (`orphan:all_N_tool_results_
  evicted`); if some uncovered → revert the partial drops
  (`tool_pair_coherence_revert`).

- **`js/profiles/resolve.js`** — thin role → CompressionConfig shim.
  Coder gets Rules 1+2+5; non-coder roles get a Rule-5-only shim
  preserving current behavior. Designed so 1.4.0 (Tools) and 2.0
  (Profiles ascend) replace it cleanly.

- **`js/chat/compactor-integration.js`** — `getCompressedContext
  Messages()` ties State.chatHistory → Compactor → Compressed history
  → `ChatSummarizer.getContextMessages(compressed)`. Defensive
  try/catch falls back to summarizer-only on Compactor crash.
  Records diagnostics on the upcoming `LLMDebug` exchange.

- **LLM Debug Modal — Compression decisions panel.** Per-exchange
  details panel in `js/llm-debug-modal.js` showing tokens_in/out,
  compression ratio, evicted_ids with rule+reason, replaced_ids,
  summarized_spans, **rules_skipped with reason** (the load-bearing
  diagnostic per ROADMAP §1.2.0 exit criteria — distinguishes "no
  rule applied" from "rule skipped because metadata absent" by
  counting tool_result turns lacking file_ops), warnings,
  rule_errors, and per-rule latency.

- **`LLMDebug.attachCompressionDiagnostics(diag)`** in
  `js/llm/debug.js` — pins compression diagnostics onto the upcoming
  LLM exchange (or the active one, if the exchange is already in
  flight).

- **Tests** — three new node `--test` suites at
  `tests/test-compression-contracts.mjs` (26 cases),
  `tests/test-compression-rules.mjs` (41 cases covering Rule 1, Rule
  2, range primitives, and combined Rule 1+2 fixtures including the
  DESIGN §"Worked Example" partial trace), `tests/test-compression-
  pipeline.mjs` (25 cases covering empty/trivial inputs, preserve_
  recent invariant, decision tally, rules_skipped accounting,
  rule-throw failure, summarizer failure modes, Rule 5 wiring, tool-
  pair coherence with single/multi/duplicate/lonely call_id
  fixtures), and `tests/test-profile-resolve.mjs` (3 cases for the
  resolver shim).

### Changed

- **`js/profiles/coder-v1.js`** `compression.rules` — was
  `[{name:'summarization'}]`; now `[{name:'subsumption', priority:10},
  {name:'invalidation', priority:20}, {name:'summarization',
  priority:50}]`. `preserve_recent` stays at 24 (matches existing
  `summarizer.recentCountTools`); the field is documented inline
  with a reconciliation note vs DESIGN's "start at 4" Open Question
  — the conservative coder default reflects tool-call density in
  coder sessions.

- **`ChatSummarizer.getContextMessages(historyOverride?)`** in
  `js/chat/summarizer.js` — accepts an optional history array to
  override `State.chatHistory`. Default behavior unchanged. Used by
  the new Compactor integration so windowing / tool-pair safety /
  summary-prefix logic runs on the compressed history.

- **`js/chat/handlers.js` `handleGeneralRequest`** — replaces the
  direct `ChatSummarizer.getContextMessages()` call at the LLM-send
  seam with `await getCompressedContextMessages()`. Single line; the
  call is now async.

- **`docs/ROADMAP.md`** header bumped to **1.2.0**.

## [1.1.4] - 2026-04-29

Opens the **1.1.4 — Supply-chain / glassworm protection** patch from
`docs/ROADMAP.md` §1.1.4. Adds visible review surfaces at three trust
boundaries — PRs entering the repo, source loaded into the editor, and
plugin/settings imports crossing into a running session — for the
invisible-Unicode threat class (glassworm tags-block, Trojan Source bidi
overrides, zero-width steganography). The CI lint is the cheap fence; the
editor decoration is the long pole.

### Added

- **Scanner module** at `js/security/invisible-unicode.js`. Single source
  of truth for the codepoint ranges (`U+200B–U+200F`, `U+2060–U+206F`,
  `U+FEFF`, `U+202A–U+202E`, `U+2066–U+2069`, `U+E0000–U+E007F`). Exports
  `scan()`, `findingsToCharRanges()`, `stripInvisible()`, `shouldScan()`,
  and `INVISIBLE_RANGES`. Pure ES module with no DOM dependencies — runs
  in Node tests and in the browser. New `js/security/` directory; further
  security modules will land here as they ship.

- **CI lint step** at `.gitea/workflows/ci.yaml`. New
  "Security lint — invisible Unicode" job runs `grep -rPn` across
  `js/`, `plugins/`, `tests/` (`*.js`, `*.mjs`, `*.json`) and fails the
  build on any flagged codepoint. Sits as a peer to the existing
  DOMPurify-bypass audit so failure output stays readable.

- **CodeMirror 6 inline decoration**
  (`js/editor/invisible-unicode-decoration.js`,
  `js/editor/setup.js`, `js/editor/instance.js`). Renders flagged
  codepoints as visible `U+xxxx` widgets with a tooltip naming the char
  and a click-to-delete affordance. New keymap `Mod-Shift-U` strips every
  flagged char in the selection. Compartment-based runtime toggle so
  Settings changes take effect without recreating the editor. Adds
  `Decoration`, `ViewPlugin`, `WidgetType` to the `CM` namespace on both
  vendor-bundle and CDN-fallback paths; the existing `cmView` re-export
  in `vendor/codemirror-entry.mjs` already provides them.

- **`editorScanInvisibleUnicode` setting** (`js/core.js`,
  `js/settings/persistence.js`, `js/settings-manager.js`,
  `html/settings-tabs.html`, `js/app.js`, `js/editor.js`). Default `true`.
  Off by default for prose formats (`*.md`, `*.markdown`, `*.html`,
  `*.htm`, `*.xml`, `*.xhtml`) where bidi/zero-width chars are sometimes
  legitimate; the language gate lives in `shouldScan(filename)`. Surfaced
  in **Settings → Appearance** as "Scan for invisible Unicode (glassworm
  / Trojan Source)" with a help line pointing at `docs/SECURITY.md`. The
  `setInvisibleUnicodeEnabled()` export from `js/editor.js` is wired
  through the existing `settings:saved` listener.

- **Plugin install scan** in `js/plugin-loader.js` `installPlugin()`. When
  the fetched source contains invisible Unicode, the call returns
  `{ success: false, requiresConfirmation: true, invisibleUnicodeFindings }`
  rather than executing the source. Caller can re-invoke with
  `{ confirmedInvisibleUnicode: true }` to proceed. The
  `_wireInstallButton` handler in `js/settings/plugins-tab.js` renders an
  inline warning band into `#pluginInstallStatus` listing the first three
  findings with line/column, and offers Cancel (default) or
  "Install anyway." Trust-on-first-install: subsequent reloads do not
  rescan the same source.

- **Settings import scan** in `js/settings/persistence.js`
  `importSettings()`. The fetched JSON text is scanned before
  `JSON.parse`. On findings, the existing `showConfirm` from
  `js/ui/dialogs.js` surfaces a danger-styled confirmation dialog with
  the count and first three findings; default action is Cancel. Permissive
  (warn-and-confirm) rather than throwing — matches the existing
  validator's style and avoids leaving Storage half-written if a throw
  lands mid-flow.

- **`docs/SECURITY.md`** — new security policy document. Covers the
  threat model (glassworm, Trojan Source, polyglot exfiltration, plugin
  supply chain), what ships in 1.1.4, what does not ship (residual user
  responsibility — plugins are not sandboxed, trust-on-first-install,
  no signature verification), the canonical codepoint reference table
  (kept in sync with the JS scanner and the CI lint), and how to report
  a vulnerability. Linked from `README.md` (Plugin system feature block
  and PLUGIN.md cross-reference) and from the top of `docs/PLUGIN.md`.

- **Tests** at `tests/test-invisible-unicode.mjs` — 17 new
  `node --test` cases covering each codepoint family, range boundaries,
  ASCII/CJK/emoji negative cases, UTF-16 surrogate-pair offset math for
  the supplementary-plane Tags block (`'\u{E0000}'.length === 2`),
  multi-finding scans, line/column reporting, and the `shouldScan`
  language gate. Runs in CI under the existing `node --test` step.

### Changed

- **`installPlugin(url)` API in `js/plugin-loader.js`** now accepts an
  optional `options` argument and may return `requiresConfirmation: true`
  alongside the existing `success`/`error` shape. Existing callers that
  treat any non-`success` return as failure continue to work; callers
  wanting the warning-band UX should branch on `requiresConfirmation` and
  re-invoke with `{ confirmedInvisibleUnicode: true }`. Only caller in
  the editor codebase is `js/settings/plugins-tab.js` which has been
  updated.

- **`docs/ROADMAP.md`** header bumped to **1.1.4**.

## [1.1.3] - 2026-04-29

Opens the **1.1.3 — Vim keybindings** track from `docs/ROADMAP.md` §1.1.3.
The roadmap originally scoped Default / Vim / Emacs; scoping confirmed the
mention of `@codemirror/legacy-modes/mode/emacs` was a misread (that package
is a CM5 syntax-highlighting shim, unrelated to keybindings) and Emacs has
been dropped from the patch. The maintained CM6 vim extension is
`@replit/codemirror-vim` (the original `@codemirror/vim` package was retired);
this release wires it into the existing vendor bundle and CDN-fallback
loader, surfaces a Default / Vim radio in Settings → Appearance, and
documents the bindings in the F1 help modal.

### Added

- **`@replit/codemirror-vim` bundled into `vendor/codemirror-bundle.js`**
  (`vendor/package.json`, `vendor/codemirror-entry.mjs`,
  `js/editor/setup.js`). The vendor entry exports the new `cmVim`
  namespace; the loader unpacks it into `CM.vim` after the bundle resolves
  and falls back to `https://esm.sh/@replit/codemirror-vim@6` when the
  local bundle is unavailable. Failure to load Vim is non-fatal — `CM.vim`
  stays `null` and the editor still creates with the default keymap.
- **`editorKeybindingMode` setting** (`js/core.js`,
  `js/settings/persistence.js`, `js/settings-manager.js`,
  `html/settings-tabs.html`). New `'default' | 'vim'` setting under the
  Appearance tab, below the line-number toggle. Default is `'default'`;
  legacy installs without the key fall through to default via the
  existing merge spread in `loadSettings()` — no migration required.
- **Runtime mode swap via `keymapCompartment`** (`js/editor/instance.js`).
  Mirrors the existing `lineNumberCompartment` pattern: a fresh
  Compartment is created in `createEditor()` and seeded from
  `State.settings.editorKeybindingMode`. The new exported
  `setKeybindingMode(mode)` calls
  `editorInstance.dispatch({ effects: keymapCompartment.reconfigure(...) })`
  so toggling Default ↔ Vim does not rebuild the editor or lose history.
- **`:w` and `:wq` ex commands wired to the commit modal**
  (`js/editor/instance.js`). Using `Vim.defineEx` once per session, both
  commands invoke the existing `window.openCommitModal()` flow so save
  behaves the way Vim users expect (queue the dirty file for a commit)
  rather than silently no-op. Registration is idempotent — the flag
  `vimExCommandsRegistered` short-circuits subsequent calls.
- **Vim mode help group in the F1 modal Hotkeys tab** (`html/modals.html`).
  New `<div class="help-group">` documenting Esc / i / a / v, motion
  (h/j/k/l, w/b, 0/$, gg/G), edit (dd, yy, p/P), undo/redo, search, and
  the new `:w` / `:wq` save mapping. Header reminds users to enable Vim
  in Settings → Appearance.
- **`tests/test-keybindings.mjs`** — four `node:test` cases covering the
  `editorKeybindingMode` default, Storage round-trip, legacy-install
  fallback, and explicit-set wins on merge. Picked up by the existing
  `node --test tests/test-*.mjs` step in CI.
- **`tests/test-keybindings.js`** — browser-driven smoke that loads
  CodeMirror, asserts `CM.vim` and `CM.vim.Vim.defineEx` are populated,
  creates a real `EditorView` in a hidden container, and exercises the
  Default → Vim → Default round-trip via `setKeybindingMode()`. Wired
  into `tests/index.html` after the LLM-idle-timeout suite.

### Fixed

- **Vim ex-command input is readable** (`css/editor.css`). The
  `<input>` inside `.cm-vim-panel` had no styling, so the UA default
  `color: black` left it nearly invisible against oneDark when typing
  `:w`, `:q`, `/search`, etc. Added a small block scoping the panel
  background/color/font to the project's CSS variables and forcing the
  input to `color: inherit` + monospace.
- **Vim keymap actually intercepts keystrokes** (`js/editor/instance.js`).
  The keybinding compartment was pushed onto the extension list *after*
  `basicSetup`. CM6 evaluates extensions in order — first registration
  wins — so basicSetup's `defaultKeymap` claimed `Esc`/`i`/`hjkl` before
  vim's keymap got a chance and Vim mode silently no-op'd. Per
  `@replit/codemirror-vim`'s README the vim extension must precede
  basicSetup; reordered. The browser test in `tests/test-keybindings.js`
  now drives a real `KeyboardEvent` through `view.contentDOM` and
  asserts the `insertMode` flag flips on `i` / off on `Esc`, so the
  ordering invariant has a regression test (the dispatch-only test that
  shipped with the initial commit didn't exercise the keymap).
- **`EmbeddingsClient.clearCache()` is now an actual nuke**
  (`js/embeddings-client.js`). Pre-fix it only `.clear()`'d the
  in-memory `_cache` Map, leaving the Cache-API `transformers-cache`
  store and the persisted `embeddings-index-*` Storage keys behind —
  exactly the state that left users staring at a poisoned cache after
  flipping providers. New behavior: clears the in-memory map, deletes
  every `embeddings-index-*` Storage key (via `Storage.keys('embeddings-index-')`),
  deletes the `transformers-cache` Cache-API store, and resets the
  `embedder.cacheWiped.1.1.3` recovery sentinel. Returns
  `{ indexes, transformersCache }` for caller diagnostics. Verified end-to-end
  in preview with planted poisoned entries.
- **Provider/model switch wipes stale persisted indexes**
  (`js/embeddings-client.js` `settings:saved` listener). Vectors are
  model-bound — a 384-dim index from one model can't be queried with
  vectors from a 768-dim model, and even same-dim indexes from different
  models live in different embedding spaces. The listener already
  re-inits when the embedder config sig changes; it now also clears
  `_cache` and removes every `embeddings-index-*` key so subsequent
  queries don't return garbage matches against vectors produced by the
  prior model.
- **Embedder model picker only shows models for the active provider**
  (`js/settings/models-tab.js`, `js/settings-manager.js`,
  `html/settings-tabs.html`). Pre-fix the datalist hard-coded the three
  Xenova/* options at page load and the "Fetch API Models" button mixed
  remote results in alongside them — leaving a noisy picker where half
  the entries were non-functional for whichever provider was active.
  New `populateEmbeddingModelsByProvider(provider)` runs on settings
  open and on provider radio change: shows the Xenova/* trio in `local`
  mode, leaves the list empty in remote mode until "Fetch API Models"
  fills it from `<endpoint>/models?type=embedding`. The fetch helper
  itself now bails early with an info toast when local is active
  instead of silently returning nothing.
- **Transformers.js in-browser embedder no longer crashes on init**
  (`js/embeddings-client.js`). `_initLocal()` set
  `transformers.env.allowLocalModels = true`, which made the library try
  to fetch model files from `<deployment-origin>/models/<model>/...`
  before falling back to HuggingFace. The deployment doesn't serve model
  files, so nginx's SPA fallback returned the index.html page; the
  library then called `JSON.parse('<!DOCTYPE html>…')` and surfaced as
  `SyntaxError: Unexpected token '<'`. The flag is now `false` (matching
  Transformers.js's documented browser default), so the library goes
  straight to HuggingFace, with the existing `useBrowserCache = true`
  still serving subsequent loads from IndexedDB. Surfaces a partial
  closure of the "in-browser embedder validation" item the 1.1.2.x list
  in `docs/ROADMAP.md` deferred — measurement / hardware-requirements
  documentation is still owed.
- **One-time `transformers-cache` wipe for users poisoned by the pre-fix
  state** (`js/embeddings-client.js`,
  `_wipePoisonedTransformersCacheOnce()`). Anyone who tried the local
  embedder before this release ended up with the SPA's `<!DOCTYPE html>…`
  cached at `<origin>/models/...` keys inside the Cache API's
  `transformers-cache` store. Those entries kept short-circuiting init
  even after `allowLocalModels` flipped to `false`. The new helper runs
  on first `_initLocal()` of a browser, deletes the
  `transformers-cache` once, and sets a `embedder.cacheWiped.1.1.3` flag
  in `localStorage` so it never re-runs. No-ops on fresh installs.

### Changed

- **`settings:saved` listener applies the new mode in-place** (`js/app.js`).
  Hooked into the existing block where `applyLineNumbersVisibility()`
  fires; calls `setKeybindingMode(State.settings.editorKeybindingMode)`
  alongside it. Toggling the radio in Settings and clicking Save flips
  the editor's keybinding mode without a page reload.
- **`docs/ROADMAP.md` §1.1.3 rewritten to Vim-only scope.** The "What
  ships" block names `@replit/codemirror-vim` (not the retired
  `@codemirror/vim`); a new paragraph notes Emacs is deferred and why.
  UI improvement #3 in the cross-cutting table updated to "Vim
  keybinding toggle in Settings → Appearance."

## [1.1.2] - 2026-04-29

Opens the **1.1.2 — Embedder hardening** track from `docs/ROADMAP.md`
§1.1.2 with the foundational provider-decoupling change. Pre-1.1.2 the
embedder shared `llmEndpoint` + `llmApiKey` with the chat LLM and inferred
local-vs-remote from `embeddingModel.startsWith('Xenova/')`. Self-hosted
deployments that want the embedder on a different host than the chat LLM
couldn't be expressed. This release introduces independent embedder
credentials with an explicit provider sentinel, ships a new Settings tab
to surface them, and migrates existing installs in place. The remaining
1.1.2.x patches (filetype filters, ceiling measurement, in-browser
embedder validation, "skipped: N" surface) build on this shape.

### Changed

- **Embedder gets its own provider, endpoint, and API key**
  (`js/embeddings-client.js`, `js/core.js`, `js/llm/api.js`,
  `js/settings/models-tab.js`). Old behavior: `EmbeddingsClient._initRemote`
  and `_embedRemote` read `State.settings.llmEndpoint` and `llmApiKey`,
  with mode auto-detected from the model name prefix. New behavior: mode
  is driven by `State.settings.embeddingProvider` (a `'local' | 'openai'
  | 'venice' | 'openrouter' | 'ollama'` sentinel), and remote mode reads
  `embeddingEndpoint` + `embeddingApiKey` instead. The chat LLM's
  `llmEndpoint`/`llmApiKey` are untouched — the migration *clones* the
  shared credentials into the new keys for any existing remote-embedder
  user, so behavior is bit-for-bit equivalent on upgrade. `_detectMode`
  is removed; the explicit provider sentinel replaces the heuristic.
- **Embeddings UI moves from Context tab to its own Settings → Embeddings
  tab** (`html/modals.html`, `html/settings-tabs.html`,
  `js/settings-manager.js`). The Context tab now hosts only the chat
  summarizer. The new tab consolidates: provider radio, endpoint, API
  key, "Use chat LLM credentials" copy button, enable toggle, model
  picker + datalist + Fetch API Models button, max-relevant-files
  slider, max-index-files slider, auto-reindex, cache expiry, clear
  cache, and the live status panel. The settings tab strip handles the
  11th tab via the existing scroll arrows; the sidebar UX rework noted
  in `docs/ROADMAP.md` UI #13 stays deferred to 1.3.x/1.4.x.
- **`EmbeddingsClient` `settings:saved` handler reinits on
  provider/endpoint/key/model change** (`js/embeddings-client.js`). Pre-1.1.2
  it only watched mode change; switching providers in the new UI now
  takes effect without a page reload, as does swapping models within
  the same mode.
- **`LLM.listEmbeddingModels()` and
  `fetchEmbeddingModelsForSettings()` fetch the embedder catalog from the
  embedder endpoint** (`js/llm/api.js`, `js/settings/models-tab.js`). The
  "Fetch API Models" button on the Embeddings tab now hits the embedder
  host, falling back to the chat-LLM inputs only if the embedder fields
  are empty (covers the in-modal first-run flow).

### Added

- **Three new settings keys** (`js/core.js`): `embeddingProvider`
  (default `'local'`), `embeddingEndpoint`, `embeddingApiKey`. The
  `Settings` typedef and the `State.settings` defaults block both gain
  these fields. `maxIndexFiles` is also promoted from an implicit
  `|| 200` fallback at call sites to a real default in the same block —
  not a behavior change, just removes the silent magic number.
- **One-shot migration: split shared LLM/embedder credentials**
  (`js/core.js` `loadSettings()`). The migration runs at most once per
  stored settings blob: if `embeddingProvider` is undefined and the
  saved `embeddingModel` starts with `Xenova/`, set
  `embeddingProvider: 'local'` (no endpoint/key); if a non-Xenova model
  is set, clone `apiProvider` → `embeddingProvider`, `llmEndpoint` →
  `embeddingEndpoint`, `llmApiKey` → `embeddingApiKey`. Fresh installs
  fall through to the default `'local'` via the merge spread. The chat
  LLM's `apiProvider`/`llmEndpoint`/`llmApiKey` are preserved.
- **Settings → Embeddings tab** (`html/modals.html` line 18,
  `html/settings-tabs.html` new `tabEmbeddings` panel). Provider radio
  with five options; endpoint + API key inputs that hide when `local`
  is selected; "⇣ Use chat LLM credentials" button that copies from the
  LLM tab's inputs (not from `State` directly, so unsaved LLM-tab edits
  propagate). The "indexing controls" section below the divider keeps
  the existing controls, just relocated.
- **`tests/test-settings-migration.mjs`** — eight new `node:test` cases
  exercising the 1.1.2 split: remote credentials cloned into embedder
  fields when `embeddingModel` is non-Xenova, local mode detected from
  `Xenova/*` prefix without leaking chat-LLM credentials, idempotency,
  fresh-install fallthrough, `apiProvider` defaulting to `'openai'`,
  and a chained 1.1.1 + 1.1.2 case covering users who upgrade from
  1.1.0 directly to 1.1.2. Two integration tests confirm
  `State.settings.embeddingProvider === 'local'` and
  `maxIndexFiles === 200` defaults landed without drift.

### Risk note

Existing remote-embedder users are the migration's primary risk
surface. Because old `_initRemote` and `_embedRemote` only read
`llmEndpoint` + `llmApiKey`, the migration's clone of those values into
`embeddingEndpoint` + `embeddingApiKey` produces a runtime configuration
that is bit-for-bit equivalent to the pre-1.1.2 behavior. The migration
unit test (`migration: 1.1.2 splits credentials when remote embedding
model present`) is the contract; the manual verification path is to
load an existing 1.1.1 install, inspect `State.settings.embedding*` in
DevTools, and confirm a `find_relevant_files` call in chat hits the
expected endpoint with the expected `Authorization` header.

Local-mode users (the default and most common case) experience no
behavioral change at all — the migration sets the explicit `'local'`
sentinel and clears the unused endpoint/key, which is bit-for-bit
equivalent to the prior `embeddingModel.startsWith('Xenova/')`
heuristic.

### Removed

- **Dead `embeddingMode` reference** in
  `js/settings/persistence.js` `exportSettings()` (line 214 prior). The
  field was exported but never set, read, or migrated — it's a leftover
  from a prior iteration. Replaced with the three real new keys
  (`embeddingProvider`, `embeddingEndpoint`, `embeddingApiKey`).

## [1.1.1] - 2026-04-29

First behavior-changing release after the **1.1.0 — Foundations** track
closes. Foundations content shipped incrementally under `1.0.5` and
`1.0.6`; this release marks the track exit by landing the first
follow-up patch from `docs/ROADMAP.md` §1.1.1, plus the documentation
deliverables that were sitting in `[Unreleased]` after the docs branch
merged.

### Changed

- **LLM timeout is now idle-based, not wall-clock** (`js/llm/api.js`,
  `js/chat/handlers.js`). Old behavior: `Promise.race` in
  `handlers.js` aborted any chat after a fixed wall-clock window from
  fetch start (default 180s). Reasoning models (DeepSeek-R1, o1-style,
  GPT-5 think-mode) routinely spend 30–90s reasoning before emitting
  their first token and got falsely aborted. New behavior: the timer
  lives inside `LLM._handleStream()` and resets on every
  `reader.read()` chunk arrival — keep-alives, tool-call deltas, and
  think-tag chunks all count as activity, not just visible tokens. If
  no chunk arrives within the configured idle window, the request
  aborts via the existing `AbortController` and surfaces as
  `Idle timeout (Ns) — no tokens received`. The `Promise.race` wrapper
  in `handlers.js` is removed; non-stream consumers get a wall-clock
  fallback inside `chat()` using the same window. Closes
  `docs/ROADMAP.md` §1.1.1.
- **`docs/ARCHITECTURE.md` § `tools/registry.js`** — paragraph expanded to
  name the canonical error contract directly: `EditorError` extends
  `Error` with a machine-readable `.code` (from the `ErrorCode` enum)
  and a human-readable `.recoveryHint`; consumers compare `err.code`
  rather than parse `.message`; `js/error-logger.js` renders the hint;
  `EditorError.fromResponse()` and `.wrap()` are the canonical
  constructors. Closes a doc/code drift item flagged in
  `docs/PLAN.md` § Known doc/code drift.
- **`js/tools/doc-tools.js` `DOC_MANIFEST`** — entries can now declare
  an `inline` content string instead of a `path` to fetch. The
  `read_docs` handler short-circuits the fetch path for inline entries
  and returns the inline content directly. The manifest-listing branch
  surfaces inline entries with `inline: true` in place of `path` so the
  LLM can tell them apart.

### Added

- **Settings rename + one-shot migration: `llmTimeout` → `llmIdleTimeout`**
  (`js/core.js` `loadSettings()`). The migration runs at most once per
  stored settings blob: if the old key is present and the new key is
  absent, the value is copied over and the old key is deleted before
  the merge spread. Same numeric value, new semantics — see Risk note
  below. Default for new installs is `90000` (90s); old installs keep
  whatever they had set (typically 180000ms).
- **Settings → LLM tab — "Idle Timeout (since last token)"** label
  (`html/settings-tabs.html`). The slider id, display span, and label
  all renamed from `settingLlmTimeout`/`llmTimeoutValue` to
  `settingLlmIdleTimeout`/`llmIdleTimeoutValue`. Adds an info-icon
  tooltip and a `<small>` help line explaining the reset-on-token
  semantics so users don't have to read the CHANGELOG to understand
  the rename.
- **`tests/test-llm-idle-timeout.mjs`** — six `node:test` cases
  exercising `_handleStream()` with a fake reader: window respected
  when chunks arrive in time, abort fires when chunks stop, timer
  resets per chunk so cumulative duration > window doesn't trigger,
  default falls back to 90s when setting is unset, user-cancel
  distinguishable from idle-cancel.
- **`tests/test-settings-migration.mjs`** — seven cases covering the
  rename: copies old → new, no-op when only new present, no-op when
  both present, no-op when neither, idempotency across re-runs, and
  Storage round-trip integrity. Lands as a home for future one-shot
  migrations so they don't each invent their own test pattern.

### Risk note

The old `llmTimeout` was wall-clock from fetch start; the new
`llmIdleTimeout` resets on chunks. A user who set
`llmTimeout: 60000` for a slow connection migrates to
`llmIdleTimeout: 60000` — different meaning, same number. In practice
the new semantics are *more lenient* for streaming sessions
(reasoning models that paused for 30s before their first token used
to fail; now they don't), so existing values continue to work. If a
user did want the strict wall-clock-of-N behavior, they need to
re-tune; this is acceptable per the roadmap and called out in the
Settings → LLM help line.

### Docs

- **SlotManager — contract locked** (`docs/DESIGN-git-providers-and-ui-extensions.md`
  §4). Closes the last design-only deliverable from `docs/ROADMAP.md`
  §1.1.0: *"during 1.1 we lock the contract."* Adds four subsections
  to the existing SlotManager design:
  - **Slot catalog** — closed registry of five named slots
    (`sidebar-panels`, `settings-connections`, `editor-toolbar`,
    `chat-input-row`, `status-bar`) with host element and purpose for
    each. Plugins cannot invent private slot names; new slots require
    a DESIGN-doc PR.
  - **Error semantics, security, and ordering** — `render()` errors
    are caught, logged, and skipped (no sibling-render abort);
    `HTMLElement` returns mount via `appendChild`, `string` returns
    via `insertAdjacentHTML('beforeend', ...)` and are **not**
    sanitized by SlotManager (plugin authors own sanitization, same
    rule as the CI `return raw;` lint); priority sorts ascending with
    default `50` and stable tie-break by registration order; CSS
    isolation is via plugin-id namespacing — no shadow DOM in 1.4.x.
  - **Schema additions** — `version: '1.1'` field on each panel /
    setting / menuItem entry; future renderers can reject unknown
    versions for forward-compat.
  - **Implementation status callout** at the top of §4 — clarifies
    that the renderer (`js/slot-manager.js`) is deferred to 1.4.x
    while the contract is now locked.

  Why: 1.4.0 (Tools Phase 1) is two tracks away. Without the
  catalog/error/security clarifications now, the 1.4.x SlotManager
  patch would have to redesign these in flight — and the four
  ambiguities (what slots exist, what happens on render error, who
  sanitizes HTML, how priorities tie-break) are exactly the kind of
  decisions that quietly bind plugin-author expectations once the
  first plugin uses them.

  `docs/PLAN.md` updated to reflect the locked contract under both
  the 1.1.x landed table and the SlotManager Future Work bullet; the
  doc/code drift entry is updated rather than deleted so the resolution
  history is traceable.

### Removed

- **`docs/LLM_ERROR_RECOVERY.md`** retired. The doc was ~160 lines of
  agent-troubleshooting guidance built around a 2024 Gitea-only fix
  (commit `f79091fb`); the canonical error contract has lived in
  `js/utils/errors.js` for several releases now (`EditorError`,
  `ErrorCode`, `recoveryHint`), and the doc had no live readers
  outside `read_docs({doc_id:'error-recovery'})`. The `read_docs`
  entry is preserved (so existing LLM tool calls don't 404) but now
  returns an inline pointer string referencing `js/utils/errors.js`
  and the new `ARCHITECTURE.md` paragraph. Closes the
  `docs/ROADMAP.md` §1.1.0 deliverable: *"Retire/rewrite
  `docs/LLM_ERROR_RECOVERY.md`. Either fold its useful content into a
  new section in PLUGIN.md / TOOLS.md, or replace with a thin pointer
  to `js/utils/errors.js`."* — shrink-to-pointer chosen because the
  surviving content was three sentences, which fold into ARCHITECTURE
  more honestly than into PLUGIN/TOOLS.

## [1.0.6] - 2026-04-29

### Added
- **Profile scaffolding + unified `TaskLedger`** (`js/profiles/`) — data-only
  module landing the typedef contract from `docs/DESIGN-profiles.md` and
  `docs/DESIGN-tools.md`. Four files:
  - `task-ledger.js` — `TaskLedger` typedef + record typedefs
    (`AdmissionRecord`, `ExclusionRecord`, `ToolAdmissionRecord`,
    `ToolInvocationRecord`) + `createTaskLedger(...)` empty-state factory
    + `isTaskLedger(...)` type guard. One ledger struct, four record
    arrays — chunk admissions/exclusions for retrieval (1.5.0) and tool
    admissions/invocations for tools (1.4.0).
  - `profile-contract.js` — `Profile` typedef plus `BudgetSpec`,
    `RetrievalConfig`, `MemoryConfig`, `CompressionConfig`,
    `SummarizerConfig`, `ToolsConfig`, `TaskLedgerConfig` sub-typedefs
    + `isProfile(...)` type guard.
  - `coder-v1.js` — `CODER_V1` Profile object that mirrors *current*
    coder-role behavior (single-strategy semantic retrieval, scratchpad-only
    memory, Rule-5-only compression, all 52 tools loaded). Field-by-field
    provenance comments link each value back to the source it mirrors
    (`State.settings.summarizer`, DESIGN docs, ROADMAP decisions).
  - `index.js` — barrel export.

  Why: the unified TaskLedger ships once now so 1.4.0 (tool admissions /
  invocations) and 1.5.0 (chunk admissions / exclusions) fill in the same
  struct rather than each shipping its own ledger schema and a future
  merge step. Per `docs/ROADMAP.md:114` *"One schema, no migration"* —
  this lands that schema. The roadmap exit criteria for §1.1.0 is
  explicit: *"Unified `TaskLedger` typedef + empty-state struct present
  in `js/profiles/`; no consumer wires up yet."* This PR satisfies that
  by introducing zero behavior change. The `coder.v1` profile is data
  only — no subsystem reads it yet. 1.2.0/1.3.0/1.4.0/1.5.0 will each
  begin reading the relevant slice; 2.0 makes the profile contract
  load-bearing.

  Tests: `tests/test-profiles.{mjs,js}` — 19 node:test cases plus a
  parallel browser suite covering ledger empty-state shape, type-guard
  behavior, coder.v1 budget arithmetic (residual = 12500), and the
  documented field-by-field provenance against `State.settings`.

- **Pre-merge version coherence CI lint** (`.gitea/workflows/ci.yaml`) — new
  step in the `build-and-deploy` job, runs before the existing security lint.
  Parses the `VERSION` constant from `js/version.js` and the most recent
  `## [X.Y.Z]` heading from `CHANGELOG.md`; fails the build if they disagree.
  Skips the `## [Unreleased]` block (matched only on numeric headings).

  Why: AI Editor has shipped two release-sync drifts in a row
  (`0.9.42 → 1.0.4 → 1.0.5`) where `js/version.js` lagged the production
  tag and required a retroactive sync PR. Per `docs/ROADMAP.md` §1.1.0
  this lint is the machine replacement for the human "remember to bump
  version.js" rule. Pure CI tooling — no runtime impact.

- **Migration coverage probe** (`js/chat/metadata-probe.js`) — read-only
  consistency check that surfaces in dev mode via `?debug=metadata`. At
  session load, counts how many tool-result turns carry the enrichment
  fields added in the previous turn-metadata work (`tool_name`, `tool_args`,
  `tool_result_for`, `file_ops`) and reports per-field coverage to the
  console. Pure module — no Storage, no DOM, no `State` mutation. Tests:
  `tests/test-metadata-coverage.{mjs,js}`.

  Why: when Compression Phase 1 (1.2.0) starts measuring eviction rates, the
  probe's coverage signal is what lets us tell "no rule applied" apart from
  "rule skipped because metadata absent on a pre-#170 turn." Without that
  distinction, an under-target eviction rate is ambiguous evidence. Per
  `docs/ROADMAP.md` §1.1.0, the enrichment + probe ship as one shippable
  unit; this lands the second half.

  Wired in `js/app.js` (parses the query string once at boot, exposes
  `window.__AIE_DEBUG_METADATA`) and consumed in `js/chat/index.js`
  `initChat()` after history rehydration. Default-off; zero behavior change
  when the flag is absent.

- **`node --test` CI step** (`.gitea/workflows/ci.yaml`) — new
  `Node tests (node --test)` step in the `build-and-deploy` job, runs
  `tests/test-*.mjs` after the version coherence check and before the
  security lint. Pinned to Node 22 LTS via `actions/setup-node@v4`. A
  failing test blocks PR merge before any Docker work happens.

  Why: per `docs/ROADMAP.md` §1.1.0 exit criteria, "`node --test` runs in
  CI, all existing `.mjs` suites pass after porting." Until this lands,
  the only test runner is `tests/index.html` in a browser, which is not
  exercised by CI. Closes the loop on regression detection at the chat
  enrichment / summarizer / retry boundaries.

- **Runner-health smoke test** (`tests/test-smoke.mjs`) — three sanity
  checks (`1+1`, ESM resolution from `tests/` to `../js/`, Node major
  version ≥ 20). Catches a broken CI runner config before it manifests as
  a confusing failure in a real test suite.

- **Node-side browser-globals shim** (`tests/_node-shim.mjs`) — minimal
  `window` / `localStorage` / `indexedDB` / `document` / `navigator` stubs
  so test files whose transitive imports touch `js/core.js` or `js/git.js`
  can run under `node --test`. Side-effect-only module; consumers
  `import './_node-shim.mjs';` at the top before any `../js/...` import.

### Changed
- **`tests/test-retry.mjs`, `tests/test-edit-tracker.mjs`,
  `tests/test-summarizer.mjs`, `tests/test-blame-normalize.mjs`** — ported
  from the in-page `window.T` framework to `node:test` +
  `node:assert/strict`. The browser parallel suites
  (`tests/test-*.js`) are unchanged and continue to run under
  `tests/index.html`. The Node ports are aligned with current `.js`
  sibling coverage (the previous `.mjs` files were stale: `test-retry`
  asserted the wrong shape for `ConnectionError`, `test-edit-tracker`
  used a long-renamed API). The two stateful tests load
  `tests/_node-shim.mjs` first; pure-utility tests (`test-retry`,
  `test-edit-tracker`) need no shim. Single DOM-bound assertion in
  `test-blame-normalize` is `test.skip()`d under Node with a comment
  pointing at the `.js` sibling.

### Fixed
- **`tests/test-context-filter.js`** — Browser test now seeds
  `IgnoreManager._globalRaw` with `DEFAULT_IGNORE_PATTERNS` and calls
  `_recompile()` at the top. Production calls `IgnoreManager.init()` at app
  startup; the test never did, leaving `_compiled = []` so `isIgnored()`
  returned `false` for every input. 32 of the 35 failing browser tests
  (binary/media, lock files, path patterns, edge cases) were the same root
  cause; all green after seeding.
- **`js/ignore.js` `DEFAULT_IGNORE_PATTERNS`** — Added `*.bundle.js` and
  `*.bundle.css` alongside the existing bare `bundle.js` / `bundle.css`.
  The bare patterns are exact-basename matches (gitignore semantics) and
  miss real-world webpack output like `vendor.bundle.js` and
  `styles.bundle.css`. Affects new installs only — existing users keep
  their saved patterns until they reset.
- **`tests/test-summarizer.js`** — Updated the 3 "1M model, balanced"
  expectations from `{200, 60, 100}` to `{625, 219, 375}`. The summarizer
  multiplies its upper clamps by `getContextScale().scale` (1×/2×/4×/8×
  per `js/llm/api.js` lines 99–102); 1M-ctx models hit scale 8 so capacity
  (625) sits well under the scaled cap (1600/480/800) and is no longer
  clamped. Test was written when scale was always 1; production scaling
  was added later.

## [1.0.5] - 2026-04-29

### Added
- **`docs/ROADMAP.md`** — Versioned plan through 2.0 covering the four
  intelligence subsystems (retrieval, memory, compression, tools) and
  profile contract. Tracks: foundations → compression → memory → tools →
  retrieval → profiles. Biweekly minor cadence; ~5-month arc to 2.0.
- **DESIGN docs landed** — `DESIGN-intelligence.md`, `DESIGN-retrieval.md`,
  `DESIGN-memory.md`, `DESIGN-compression.md`, `DESIGN-profiles.md`,
  `DESIGN-tools.md` relocated from project root into `docs/`. These
  describe the architecture target ROADMAP.md sequences toward.

### Changed
- **`js/version.js`** — Bumped 1.0.4 → 1.0.5. The 1.0.5 release shipped
  to production via PRs #165, #166, #167 but the version constant wasn't
  bumped in lockstep; this corrects the drift.
- **`docs/TOOLS.md`** — Full rewrite covering all 52 tools across 16
  modules with accurate per-tool role assignments. Previous version
  documented ~25 tools and missed cursor/multifile/xref/eval/scratchpad/
  doc/commit/PR-merge/CI/embeddings tools entirely.
- **`docs/ARCHITECTURE.md`** — Updated File Size Map with current line
  counts (replaces stale "no file >600 lines" claim). Added Local
  provider section, Testing & CI section. Removed deleted
  `search-replace-tools` reference.
- **`docs/ROLES_AND_TOOLS.md`** — Full rewrite. Tool counts per role
  now accurate (52/36/28/27/22 instead of "19+"). Tool/role matrix
  derived from actual `roles:` fields in source.
- **`docs/scan-tools-guide.md`** — Fixed `js/chat.js` reference (now
  `js/chat/`); replaced "Coming soon: Go/Rust/Java/C++" with description
  of current empty-outline behavior for non-JS/Python files.
- **`docs/PLAN.md`** — Added 1.0.4 + recent shipped items; flagged
  SlotManager as designed-but-not-built; added Scan Tool Coverage and
  Testing sections; added Known doc/code drift section.

### Fixed (already shipped on `main` ahead of this version bump)
- **PR #165:** PR detail merge button state now resets on every PR load
  (issue #10).
- **PR #166:** Editable model definitions — capabilities and context
  window can now be overridden per model (issue #8).
- **PR #167:** Tool widgets persist across redraws via `_display`
  metadata (issue #6).

## [1.0.4] - 2026-02-23

### Security

- **P0 — DOMPurify bypass patched** — Three independent markdown renderers
  (`chat/messages.js`, `secondary-pane.js`, `markdown-modal.js`) had a
  conditional pattern that returned raw `marked.parse()` output to `innerHTML`
  when DOMPurify was unavailable. All three now fail closed — escaping content
  rather than passing through unsanitized HTML. This affects rendering of LLM
  responses, Git issue/PR bodies, and comments.

- **P1 — Regex markdown fallback XSS fixed** — The `renderMarkdown()` fallback
  in `secondary-pane.js` applied regex formatting to raw input without
  escaping first, allowing injection via headings, inline code, links, and
  images. Now calls `escapeHtml()` before regex processing, matching the
  existing safe pattern in `chat/messages.js`.

- **P2a — Error messages escaped** — `e.message` and `docPath` strings from
  API errors and fetch failures were injected into `innerHTML` without
  escaping in `release-manager.js`, `app.js`, and `markdown-modal.js`. All
  error paths now use `escapeHtml()`. Release URL attribute also now uses
  `escapeAttr()`.

- **P2b — Image filename escaped** — Pasted/dropped image filenames in
  `chat/input.js` were injected into a `title` attribute without
  `escapeAttr()`, allowing attribute breakout from crafted filenames.

- **P2c — Plugin metadata escaped** — Role names, descriptions, icons, and
  tool definitions from plugins were rendered unescaped in
  `settings/roles-tab.js`. A malicious plugin could inject HTML via
  `Roles.register()` or tool registration. All plugin-provided strings now
  pass through `escapeHtml()` / `escapeAttr()`.

- **P3a — Label color CSS injection fixed** — `issue-detail.js` injected
  Git API label colors directly into `style` attributes. Crafted color values
  could inject arbitrary CSS. Now stripped to hex characters only via
  `replace(/[^0-9a-fA-F]/g, '')`.

- **P3b — Issue state escaped** — `issue.state` from Git APIs was injected
  into `innerHTML` without escaping. Now uses `escapeHtml()`.

### Changed
- **CI: Security lint step** — Gitea CI workflow now includes a pre-build
  security lint that checks for DOMPurify bypass patterns (`return raw;`)
  and verifies vendor security libraries are referenced in the Dockerfile.
  Fails the build if regressions are detected.

## [1.0.0] - 2026-02-20

### Added
- **`Plugins.registerTool()`** — Convenience wrapper for registering LLM
  tools from plugins. Auto-formats the tool definition and handles
  ToolRegistry import via lazy `import()` to avoid circular deps.
  ```javascript
  await Plugins.registerTool('my-plugin', {
      name: 'fetch_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      roles: 'all',
      handler: async ({ city }) => ({ temp: 72, city })
  });
  ```

- **`Plugins.injectCSS()` / `Plugins.removeCSS()`** — Scoped `<style>`
  tag injection for plugins. Multiple calls with the same plugin ID
  replace the previous stylesheet. Enables theme plugins, custom UI
  styling, and visual tweaks without modifying core CSS.
  ```javascript
  Plugins.injectCSS('my-plugin', `.my-class { color: var(--accent); }`);
  Plugins.removeCSS('my-plugin');  // cleanup in destroy()
  ```

- **`plugin:toolRegistered`** EventBus event — Emitted when a plugin
  registers a tool via `Plugins.registerTool()`.

- **Download project as zip** — 📥 button in the branch selector row
  downloads the current project/branch as a zip archive. Supported on
  all remote providers (Gitea, GitHub, GitLab). Shows progress toast,
  triggers browser save dialog with `{repo}-{branch}.zip` filename.

- **Ignore patterns** — New Settings → Ignore tab with gitignore-syntax
  patterns that control what the LLM can discover via tools (`get_project_tree`,
  `search_in_files`, `find_references`, context indexing). Defaults ship
  with sensible exclusions (node_modules, binaries, lockfiles, etc.).
  Per-project `.aieditorignore` file at repo root merges on top.
  File tree sidebar and explicit `read_file` are unaffected — only
  the LLM's autonomous discovery is scoped.
  - `js/ignore.js` — shared module with pattern compiler, three-layer
    merge (defaults → global settings → project `.aieditorignore`)
  - Context manager refactored to delegate to `IgnoreManager.isIgnored()`
  - Settings export/import includes `ignorePatterns`

### Changed
- **Plugin SDK "What Is Not Possible"** — Removed "CSS injection" and
  "file system events" entries (both now implemented). Remaining:
  SlotManager, CodeMirror bridge, plugin settings tabs, provider
  settings UI auto-discovery.

### Fixed
- **Dockerfile labels** — Added OCI metadata labels
  (`org.opencontainers.image.*`) and blanked inherited `maintainer`.
  Without this, container registries displayed "NGINX Docker
  Maintainers" as the image author.

### Docs
- **PLUGIN.md**: New "LLM Tools" and "CSS Injection" sections with
  full examples. Updated capability tables — registerTool and injectCSS
  moved from "Possible But Not Bridged" to "What Works".
- **PLAN.md**: Rewritten as 1.0 release roadmap. Completed items in a
  table, remaining items organized as "Future Work" by category.
- **Plugin-dev role systemPrompt**: Documents `registerTool()` and
  `injectCSS()` with examples. Updated "WHAT IS NOT POSSIBLE" list.

## [0.9.42] - 2026-02-20

### Added
- **Built-in Plugin Editor** — Create, edit, and test plugins without
  leaving the editor:
  - Settings → Plugins → "Create Plugin" opens a dedicated tab with
    full CodeMirror syntax highlighting (JavaScript mode, dark theme)
  - Ctrl+S saves source to Storage, Ctrl+Enter saves & runs (hot-reload)
  - User plugins stored in `userPlugins` Storage key, loaded on startup
    via same blob-URL import() mechanism as URL-installed plugins
  - Edit button (✏️) on user-created plugin cards in Settings
  - Unsaved changes warning on tab close
  - Delete button removes source from Storage and disables plugin
  - New "User-Created Plugins" section in Settings → Plugins tab
  - Plugin template pre-populated with hooks, config schema, and docs

- **Plugin Editor LLM Tools** — Dedicated tools for the plugin-dev role:
  - `read_plugin_source` — Read current plugin editor content (numbered)
  - `write_plugin_source` — Replace full plugin source in the editor
  - `run_plugin` — Save + hot-reload via blob import
  - `list_user_plugins` — List all user-created plugins with status
  - Auto-role switching: entering a plugin editor tab switches to
    `plugin-dev` role, leaving restores previous role
  - System prompt includes tool usage instructions + full SDK reference

- **Plugin-dev role scoping** — `plugin-dev` no longer gets "full"
  tool access. Scoped to: read-only file/project/search/scratchpad
  tools (roles: 'all'), plugin editor tools (roles: 'plugin-dev'),
  and read_docs. No file editing, commits, issue creation, or PRs.

- **Settings Export includes Plugin State** — Export/import now covers:
  - `pluginState`: enabled/disabled status + config for all plugins
  - `installedPlugins`: external plugin URLs (re-fetched on reload)
  - `userPlugins`: full source code of user-created plugins
  - Import merges gracefully — doesn't overwrite existing plugins,
    skips duplicate URLs, unknown plugin IDs sit harmlessly in storage
    until their plugin registers
  - Settings export version bumped to 1.1

### Changed
- **Tab manager**: `_tabDisplay()` handles `plugin-editor` tab type
  (🧩 icon). Dirty indicator shown for plugin editor tabs. Close-tab
  warns about unsaved changes for plugin editor tabs.
- **Tool registry**: `plugin-dev` removed from "return everything"
  shortcut — now properly filtered through role-based access control
- **Plugin-dev role description**: Updated to reflect scoped tools and
  auto-activation behavior

### Docs
- **PLUGIN.md**: New "Built-in Plugin Editor" quick start section
- **TOOLS.md**: Plugin Editor tools section + updated role table
- **ROLES_AND_TOOLS.md**: Full Plugin Developer role definition with
  tool list, restrictions, and auto-activation docs
- **Help modal**: Plugin editor hotkeys (Ctrl+S, Ctrl+Enter)

## [0.9.41] - 2026-02-20

### Fixed
- **Chat defaulting to wrong repo context** (Issue #4): LLM used
  `peek_project_tree` for the current project (inventing connectionId/
  owner/repo) instead of using `get_project_tree` or `read_file`.
  Three-layer fix:
  1. Tool guard: `peek_project_tree` and `peek_project_file` now reject
     calls targeting the current project with a corrective error message
  2. Prompt hardening: cross-project instructions now say "ONLY when the
     user explicitly asks about a DIFFERENT project" and warn against
     guessing connectionId values
  3. Context injection: `connectionId` now included in the "Current
     context" block so the LLM has it available when needed
- **Ollama model capabilities not detected** (Issue #3): Models like
  `granite4:latest` have tool support but the regex heuristic didn't
  always detect it. New Ollama provider queries `/api/show` for real
  capability metadata.

### Added
- **Ollama provider** (`js/providers/ollama.js`):
  - Auto-detects capabilities via native `/api/show` endpoint (tools,
    vision, context length, quantization, parameter size, family)
  - Parallel enrichment with concurrency cap (6 models at a time)
  - 5 s timeout per model — falls back to defaults on failure
  - Derives native API base by stripping `/v1` from endpoint
  - Select "Ollama" in Settings → LLM → Provider to use it
- **`ProviderRegistry.enrichModels()`**: New async hook called after
  `parseModels()`. Providers can implement `enrichModels(models, settings)`
  to augment model data with async API calls. No-op for providers that
  don't implement it.

### Changed
- **`peek_project_tree`**: Description strengthened — "NEVER use this for
  the current project", "You MUST call list_projects first". Rejects calls
  where owner/repo matches current project.
- **`peek_project_file`**: Same guard and description hardening.
- **System prompt**: Current context block now includes `Connection:
  {{connectionId}}`. Cross-project workflow section emphasizes calling
  `list_projects` first and never guessing connection values.
- **`listModels()`** (`js/llm/api.js`): Now calls `enrichModels()` after
  parsing, enabling providers to augment capabilities asynchronously.

## [0.9.40] - 2026-02-20

### Fixed
- **LLM overwrites issue descriptions**: `update_issue` tool had a `body`
  parameter that replaced the user's entire issue description. The LLM
  would reach for `update_issue({ body: "..." })` instead of
  `add_issue_comment()` when asked to "update an issue" with new info.
  Removed `body` from `update_issue` — it is now metadata-only
  (title, state, labels).
- **Multi-tab data corruption**: Two browser tabs of the editor would
  stomp each other's chat history, session state, summarizer context,
  and active conversation. Now 5 session-volatile keys are scoped per
  tab using a tab ID from `sessionStorage`.
- **scratchpad-tools**: `chatSummaryInfo` was read via direct
  `localStorage.getItem()` without the `ai-editor-` prefix — always
  returned null. Fixed to use `Storage.get()`.

### Added
- **Tab isolation** in `Storage` (`core.js`):
  - `_tabId` from `sessionStorage` (persists on refresh, unique per tab)
  - `_resolveKey()` transparently prefixes tab-scoped keys: `~t{id}~key`
  - `_parseTabKey()` reverse parser for cache iteration
  - Tab registry with 60 s heartbeat for stale detection
  - `beforeunload` marks tab as "closing"; refresh clears the flag
  - `_cleanStaleTabs()` on init removes data for dead tabs (>5 min stale
    or marked closing)
  - `_migrateTabScopedKeys()` one-time upgrade: moves unscoped volatile
    keys into the first tab's scope
  - `keys()` filters to show only this tab's scoped data + shared data
- **Tab-scoped keys**: `chatHistory`, `chatSummaryInfo`, `chatPruneStash`,
  `activeConversation`, `session`
- **Shared keys** (unchanged): `settings`, `models`, `conversations`,
  `conv-*`, `draft-*`, `pluginState`, `searchHistory`, layout widths

### Changed
- **`update_issue` tool**: Removed `body` parameter entirely. Added
  `labels` array parameter (was documented but missing from schema).
  Description now explicitly says "metadata only" and directs the LLM
  to `add_issue_comment` for posting content.
- **`add_issue_comment` tool**: Description expanded to clarify this is
  the correct tool for updates, responses, analysis, status reports,
  and any new content on an issue.
- **`Storage.get/set/remove`**: Now route through `_resolveKey()` for
  transparent tab scoping. External API unchanged.
- **`Storage.keys()`**: Returns bare (unprefixed) keys for this tab's
  scoped data; hides other tabs' keys entirely.
- Updated `docs/TOOLS.md` to match issue tool changes.

## [0.9.39-1] - 2026-02-19

### Added
- **Themed dialog system** (`js/ui/dialogs.js`): `showAlert()`, `showConfirm()`,
  and `showPrompt()` — Promise-based replacements for native `alert()`,
  `confirm()`, and `prompt()`. Styled to match editor theme with proper
  backdrop, animation, keyboard support (Esc, Enter, Ctrl+Enter for
  textarea), and focus management.
- **Prompt dialog for issue actions**: Accept, Deny, and Comment actions
  now use a proper themed modal with title, textarea, and
  contextual button labels instead of browser `prompt()`.

### Changed
- **Eliminated all native browser dialogs** — removed every `alert()`,
  `confirm()`, and `prompt()` call across 12 files:
  - `issue-detail.js` (6 prompt → showPrompt)
  - `tab-manager.js` (confirm → showConfirm, closeTab now async)
  - `error-logger.js` (confirm + 3 alert → showConfirm + showToast)
  - `llm-debug-modal.js` (confirm + alert → showConfirm + showToast)
  - `search-panel.js` (confirm → showConfirm)
  - `storage-metrics.js` (2 confirm → showConfirm)
  - `ui-helpers.js` (2 confirm → showConfirm)
  - `settings/plugins-tab.js` (confirm → showConfirm)
  - `settings/connections-tab.js` (confirm → showConfirm)
  - `project-manager.js` (confirm → showConfirm)
  - `zip-upload.js` (confirm → showConfirm)
  - `ui/revert.js` (2 confirm → showConfirm)
  - `file-tree.js` (2 confirm → showConfirm)
- **Destructive confirms use red button**: Delete, Clear, Revert, Deny
  actions render with `variant: 'danger'` for a red confirm button.
- **Issue tab action buttons restyled**: Start Work, Accept, Deny, and
  Comment buttons now use themed hover states with semantic colors
  matching the rest of the editor UI.

## [0.9.39] - 2026-02-19

### Added
- **Issue tabs**: Issues now open as editor tabs instead of being crushed
  in the chat window or a blocking modal. Clicking an issue in the sidebar
  opens it as a preview tab in the editor pane — same pattern as files.
  Double-click to pin. Full issue detail, comments, labels, branch info,
  and action buttons (Accept, Deny, Comment, Start Work) are all rendered
  in-tab with room to breathe.
- **Typed tab system**: `tab-manager.js` now supports a `registerTabRenderer()`
  API for custom tab types beyond files. Issue tabs are the first consumer;
  the pattern is ready for PR tabs or other views.
- **Tab visual distinction**: Issue tabs show a 🔖 icon and accent-colored
  left border + label so they're visually distinguishable from file tabs.
- **In-tab actions**: Accept, Deny, Comment, and Start Work buttons in the
  issue tab body — no more switching to the focus bar or modal to triage.
- **Refresh button**: Each issue tab has a 🔄 button to re-fetch data.

### Changed
- Sidebar issue click now opens a tab (was: chat focus bar)
- Focus bar "📄 Full details" button now opens a pinned tab (was: modal)
- `State.openTabs` entries now support a `type` field (`'file'` | `'issue'`)
- `switchToTab()` routes to registered renderers for non-file tab types
- Editor toolbar buttons (Preview, Diff, Blame) are auto-disabled when
  viewing non-file tabs

## [0.9.28-3] - 2026-02-13

### Fixed
- **Issue focus bar display**: Comments section now has proper containment
  with background, border, max-height, and scroll — matches body section
  visual style. Comment items use accent-colored left border and bolder
  meta line for clearer hierarchy
- **Issue body overflow**: Reduced body max-height from 120px to 80px,
  font from `--font-md` to `--font-sm` — tighter in the focus bar
- **Comments header**: Shows "💬 Comments (N)" label with "showing last 3"
  note when truncated — clearly separates body from comments
- **Accept tooltip**: Changed from "close with comment" to "comment and
  keep open" — accept posts a comment but does not close the issue
- **README ports**: Fixed `docker run` examples from `:80` to `:8000`
  to match Dockerfile `EXPOSE 8000`

## [0.9.28-2] - 2026-02-13

### Fixed
- **Commit message truncation**: Removed `maxTokens: 256` cap from
  commit message generation. Thinking models would burn the token
  budget on `<think>` blocks, leaving the actual message truncated.
  Prompt instructions now control output length instead
- **Think block stripping**: `stripThinkBlocks()` now handles both
  `<think>` and `<thinking>` tag variants (used by different model
  families). Applies to both non-streaming util and streaming parser
- **Commit message prompts**: Strengthened system and user prompts to
  explicitly instruct against thinking, explanations, quotes, and
  code fences — reduces think-block output from models that respect
  system instructions

### Added
- CI/CD workflow (`.gitea/workflows/ci.yaml`): Docker Hub dual-push
  on release tags — `gobha/ai-editor:latest` + `gobha/ai-editor:vX.Y.Z`
- `DOCKERHUB.md`: Docker Hub repository overview page
- `Ctrl+Shift+B` added to README keyboard shortcuts table

## [0.9.28-1] - 2026-02-13

### Fixed
- **Blame gutter empty column**: Rewrote inline blame gutter from
  `StateField` + `gutter()` (always renders column) to `Compartment`
  pattern — gutter column only exists when blame data is dispatched.
  Empty compartment = zero pixels. No more 180px blank column on load
  or when providers lack blame support (Gitea, GitHub)
- **Help modal**: Added `Ctrl+Shift+B` (blame/history) to keyboard
  shortcuts help

## [0.9.28] - 2026-02-13

### Added — Blame/History Interactive Cluster

Three features that build on the existing blame and file history
infrastructure (shipped in 0.9.10), making them interactive.

**Inline blame gutter** (`js/editor/blame-gutter.js`):
- CodeMirror 6 gutter extension showing blame annotations directly
  in the editor: SHA · author · relative date, color-coded by commit
- Uses CM6 `gutter()` + `GutterMarker` + `StateField` architecture
- Only marks the first line of each blame range (GitLens-style) to
  avoid visual noise
- Activates automatically when blame pane is toggled on; clears when
  closed
- SHA elements are clickable → opens commit diff in secondary pane
- Graceful no-op when blame data isn't available (GitHub/Gitea fall
  back to file history as before)
- New CM namespace exports: `gutter`, `GutterMarker`, `StateField`,
  `StateEffect` (both vendor bundle and CDN fallback paths)

**File history → diff** (`js/secondary-pane.js`):
- History table rows are now clickable — click any commit to view a
  unified diff between that commit's version of the file and the
  current editor content
- Fetches historical file via `Git.getFile(owner, repo, path, sha)`
  (works across all 3 providers since `getFile` already accepts a ref)
- Shows "No changes" state when file is identical
- "← Back" button returns to the history table

**Blame → commit diff** (`js/secondary-pane.js`, providers):
- Blame SHA elements are now clickable — click any SHA to see the
  full commit summary: author, date, and table of changed files with
  status icons and +/- line counts
- New provider method `getCommitDiff(sha)` added to all 3 providers:
  - **Gitea**: `GET /repos/{owner}/{repo}/commits/{sha}` (files array)
  - **GitHub**: `GET /repos/{owner}/{repo}/commits/{sha}` (files + patches)
  - **GitLab**: `GET /projects/{id}/repository/commits/{sha}/diff`
- Normalized return format: `{sha, shortSha, message, author, date, files[]}`
- "← Back" button returns to blame view

**CSS** (`css/editor.css`):
- Blame SHA elements now show pointer cursor and underline on hover
- History rows show hover background highlight
- New `.blame-back` button styles for in-pane navigation
- New `.commit-files` container for commit diff view

## [0.9.27-2] - 2026-02-13

### Fixed
- Markdown viewer modal z-index bumped to `10001` — onboarding overlay
  was `10000`, not `1000` as assumed in -1 patch
- File tree now refreshes after every git commit — both the UI commit
  modal (`ui/commit.js`) and the LLM tool commit (`tools/commit-tools.js`)
  now emit `tree:refresh` on success. Previously the tree stayed stale
  until manual refresh, causing UX confusion and potential sha conflicts
  on subsequent operations

## [0.9.27] - 2026-02-13

### Added — UX polish

**Markdown viewer modal** (`js/markdown-modal.js`):
- Generic reusable modal for rendering local `.md` files in-app
- Fetches file, pipes through `marked` → `DOMPurify`, displays in a
  scrollable overlay with styled headings, tables, code blocks, and links
- Caches rendered content per path (no re-fetch on repeat opens)
- Lazy DOM injection — modal element created on first use only
- Keyboard accessible: Escape to close, backdrop click to close,
  focus trapped on close button
- Onboarding "see setup guide" link now opens `REPOS.md` in the modal
  instead of downloading the raw file
- Exposed as `window.openMarkdownModal(path, title)` for global access
  (e.g. from help menus, settings links, or plugins)

**Conversation search** (`html/chat-panel.html`, `js/chat/index.js`):
- Search input at top of conversation drawer, filters by title as you type
- Auto-focuses when drawer opens for immediate keyboard use
- Escape clears search text before closing drawer
- "No matches" empty state when filter has no results

**Conversation sort** (`js/chat/index.js`):
- Sort toggle button (↕) in drawer header cycles through 3 modes:
  🕐 Recent (default) → 🔤 Alphabetical → 💬 Most messages
- Toast notification shows current sort mode on each cycle
- Sort state persists within session (resets to Recent on reload)

## [0.9.26-1] - 2026-02-13

### Fixed — Lighthouse audit & mobile chat input

**Critical: Mobile chat input offscreen**
- `100vh` → `100dvh` (with `vh` fallback) on `.app-container` — fixes
  mobile Safari/Chrome where `100vh` includes browser chrome, pushing the
  chat input below the visible area
- Chat and sidebar overlays use `bottom: 0` instead of `height: 100%`
  for robustness against viewport height mismatches
- Modal overrides also use `dvh` units
- Added `flex-shrink: 0` to `.chat-header` and `.chat-input-area` —
  prevents flex compression from squishing the input off-screen
- Added `min-height: 0` to `.chat-messages` — standard fix for flex
  children with `overflow: auto` in a column; without this the messages
  area won't shrink below its content size and can push the input out

**Performance (CLS 0.181 → target <0.1)**
- Added `contain: layout style` and `min-height: 0` to `.main-content`
  to prevent child panels from shifting ancestor layout during JS init
- Vendor scripts (`marked`, `purify`, `jszip`) now load with `defer` —
  no longer render-blocking (P2: 3 fewer blocking resources)

**Accessibility (89 → target 95+)**
- Welcome tab placeholder now has `role="tab"` and `aria-selected` (A1)
- Color contrast: bumped `--text-secondary` (#858585→#9e9e9e) and
  `--text-muted` (#6e6e6e→#8e8e8e) for WCAG AA 4.5:1 on dark
  backgrounds; `.cost-balance` uses brighter blue (#5bbdf5) (A2)
- Sidebar action buttons: bumped to 28×28px min touch targets (A3)
- File tree: switched from `aria-label` to `aria-labelledby` pointing
  at the visible `.name` span to fix label/name mismatch (A4)

**Best Practices**
- Balance polling no longer starts eagerly on page load — deferred
  until after `fetchModels()` succeeds, preventing 401 console errors
  from unconfigured Venice API keys (B2)

**Hardening**
- `previewImage()` now uses DOM API (`createElement`/`appendChild`)
  instead of `innerHTML` with string interpolation — eliminates a
  potential XSS vector from crafted image URLs

## [0.9.26] - 2026-02-13

### Added — Mobile responsive layout

Full mobile support at ≤768px breakpoint. The three-column desktop
layout (sidebar | editor | chat) becomes a single-panel mode with
bottom tab bar navigation.

**Bottom tab bar** (`js/mobile.js`, `css/mobile.css`):
- Three tabs: 📁 Files | ⚡ Editor | 💬 Chat
- Only one panel visible at a time
- Activity badges: blue dot on Chat when assistant responds, on Files
  when tree refreshes (while user is on another panel)
- Panel switching via `.mobile-active` CSS class
- Auto-switch to Editor when a file is opened or tab is switched
- Injected dynamically by `initMobile()` — no HTML template changes
- `mobileShowPanel(panel)` exported for programmatic switching

**Panel layout changes** (CSS-only, no JS layout changes):
- Sidebar: `position: absolute; width: 100%; height: 100%` overlay
- Chat: same overlay treatment
- Editor: persistent base layer (always mounted)
- Resize handles: hidden
- Desktop `.hidden` class overridden by `.mobile-active` on mobile

**Header simplification:**
- Hidden: sidebar/chat toggles (replaced by tab bar), debug buttons,
  help button, version number
- Remaining buttons: settings, commit, revert — all 36×36px touch targets
- Cost tracker: truncated to 100px max

**Touch-friendly targets (44px minimum):**
- All header buttons: 36×36px minimum
- Tab bar tabs: 44px min-height
- File tree items: 36px min-height
- Chat input actions: 40×40px
- Project/branch selectors: 36px min-height

**Modal sizing:**
- All modals: full-screen (100vw × 100vh, no border-radius)
- Settings: full-screen with horizontal-scrolling tab bar
- Onboarding: full-width, tighter padding

**Text input zoom prevention:**
- All text inputs, textareas, and selects set to `font-size: 16px`
  (iOS auto-zooms on inputs below 16px)

**Chat panel tweaks:**
- Header wraps: model selector and action buttons flow to second line
- Chat textarea: 16px font-size, 44px min-height

**Editor tweaks:**
- Tabs: horizontal scroll with hidden scrollbar, 80px min-width
- Toolbar buttons: 36×36px touch targets

**Toast positioning:**
- `.toast-container` raised to `bottom: 62px` (above 52px tab bar)

**Small phone (≤480px):**
- Tighter header text, smaller tab labels, compact onboarding cards

**Integration with existing code:**
- `toggleSidebar()` / `toggleChat()` updated to delegate to
  `mobileShowPanel()` at ≤768px
- No changes to any tool, provider, or chat module — only UI layer

**New files:**
- `css/mobile.css` — all mobile styles (dedicated file, no pollution
  of existing CSS)
- `js/mobile.js` — tab bar injection, panel switching, badge logic

**Modified files:**
- `index.html` — mobile.css stylesheet link
- `js/app.js` — import + `initMobile()` call
- `js/ui-helpers.js` — toggleSidebar/toggleChat delegate to mobile module

## [0.9.25-1] - 2026-02-13

### Added — Local filesystem provider (zip-only mode)

Uploading a zip no longer requires a Git connection. When no project is
active, the Upload Zip modal switches to "local mode":

- Git-specific controls hidden (target directory, commit message, Scan
  for Diffs button)
- Upload button reads "📂 Load into Editor"
- Files load into an in-memory filesystem provider
- File tree, tabs, editor, and all LLM tools work normally

**New file: `js/git-providers/local.js`**

A full git provider implementation backed by an in-memory Map. Implements
the same interface as Gitea/GitHub/GitLab so all existing code works
without modification:

- `listRepos()` — returns locally loaded projects
- `getFileTree()` — builds tree from Map keys
- `getFile()` / `createFile()` / `updateFile()` — read/write Map entries
- `batchCommitFiles()` — batch update Map (so "commit" saves to memory)
- `listBranches()` — returns `[{name: 'main'}]`
- `listIssues()` / `listMergeRequests()` — returns `[]`
- `getBlame()` / `getFileCommits()` — returns empty (no history)
- `hidden: true` — excluded from Settings → Connections dropdown

**How it works:**
1. User clicks Upload Zip (or drops a zip) with no project loaded
2. `openZipUpload()` detects no `State.currentProject`, hides git controls
3. On "Load into Editor", `_loadLocal()`:
   - Creates a `__local__` connection in `GitProviderRegistry` (ephemeral)
   - Calls `loadFilesIntoLocal()` to populate the in-memory file store
   - Calls `switchProject()` which triggers the standard project load flow
   - `loadProject()` calls `provider.getFileTree()` → file tree renders
   - `refreshProjects()` adds local projects to the sidebar dropdown
4. Everything downstream (editor, tabs, tools, AI) works unchanged

**Data lifetime:** In-memory only — refreshing the page clears local
projects. This is by design: no persistence, no privacy concerns, no
stale state.

**Settings isolation:**
- Local provider hidden from connection settings UI
- Local connection excluded from settings persistence (not in `connections[]`)
- Settings → Connections only shows Gitea/GitHub/GitLab

## [0.9.25] - 2026-02-13

### Added — First-run onboarding wizard

New users see a guided setup wizard on first launch when no Git
connections and no LLM are configured. Four-step flow:

**Step 0 — Welcome:** Three paths presented as clickable cards:
- "Connect to Git + LLM" → full setup flow
- "Just browse & edit code" → Git only, skip LLM
- "Zip upload only" → dismiss immediately, no config needed
- "I'll configure later in Settings (Ctrl+,)" → skip all

**Step 1 — Git Connection:** Provider selector (Gitea/GitHub/GitLab),
URL with auto-fill for GitHub/GitLab, token, test button. Saves
connection directly to GitProviderRegistry + persists to Storage.
Links to REPOS.md for token setup guide.

**Step 2 — LLM Provider:** Venice/OpenRouter/Custom selector, endpoint
auto-fill, API key. Saves to State.settings + Storage.

**Step 3 — Done:** Quick reference card: select project, upload zip,
ask AI, Settings (Ctrl+,), F1 for shortcuts.

**Implementation:**
- `js/onboarding.js` (new) — wizard logic, form wiring, persistence
- `html/modals.html` — onboarding overlay with 4-step wizard
- `css/modals.css` — 24 new CSS classes for wizard styling
- `html/editor-panel.html` — improved welcome screen: shows both
  Settings and Upload Zip buttons, F1 hint
- `js/app.js` — calls `checkOnboarding()` at end of init

**Completion flag:** `Storage.get('onboardingComplete')` — set on any
exit path (finish, skip, or dismiss). Also auto-set if user already has
connections + LLM configured (e.g., imported settings).

### Added — LICENSE file

MIT license. Referenced by README.md.

## [0.9.24-2] - 2026-02-12

### Fixed — `run_code` always returning `undefined`

The IIFE wrapper `(function(){ CODE })()` treated expressions as
statements — `42 * 17` ran but never returned its value.

**Fix:** REPL-style auto-return. `_wrapForReturn()` prepends `return`
to the last non-empty, non-comment line. If that creates a SyntaxError
(last line is a declaration like `const x = 5;`), falls back gracefully
to running code as-is (result stays `undefined`, console output still
captured).

Examples now working correctly:
- `42 * 17` → result: `714`
- `Array.from(...)...reduce(...)` → result: `385`
- `const fib = ...; fib(10)` → result: `55`
- `'world'.split('').reverse().join('')` → result: `dlrow`

## [0.9.24-1] - 2026-02-12

### Added — `run_code` tool (sandboxed JavaScript execution)

LLMs can now run JavaScript to verify calculations, transform data,
test regex patterns, or prototype logic instead of doing mental math.

**Sandbox security (`js/tools/eval-tools.js`):**
- Runs in `Function()` constructor — not `eval()`
- Blocked globals set to `undefined` inside sandbox: `window`, `self`,
  `globalThis`, `document`, `fetch`, `XMLHttpRequest`, `WebSocket`,
  `eval`, `Function`, `localStorage`, `sessionStorage`, `indexedDB`,
  `navigator`, `location`, `setTimeout`, `setInterval`, `Worker`,
  `alert`, `confirm`, `prompt`, `postMessage`, and more
- 3-second timeout via `Promise.race`
- Console capture: `console.log/warn/error/info` output returned in
  `console_output` field
- Max 100KB output to prevent memory bombs
- Last expression auto-returned (REPL-style) unless code contains
  explicit `return`

**System prompt:** Added to tool inventory — models know it exists for
math, string manipulation, data transforms, and logic validation.

**Tool count:** 41 → 42

## [0.9.24] - 2026-02-12

### Added — `search_replace` tool (text-based editing for all models)

Small and medium LLMs consistently fail with line-number-based editing
tools. They miscalculate line numbers, lose track after edits shift
lines, and confuse `start_line`/`end_line`/`after_line` parameters.
The new `search_replace` tool eliminates this entirely.

**How it works:** The model reads the file, copies the exact text it
wants to change (including whitespace/indentation), and provides the
replacement. No line numbers involved.

**Four explicit operations — no magic empty-string behavior:**
- `replace` — find exact text, swap with new text
- `delete` — find exact text, remove it entirely
- `insert_after` — find anchor text, add new content after it
- `insert_before` — find anchor text, add new content before it

**Uniqueness requirement:** The `find` text must match exactly once in
the file. If it matches multiple times, the tool returns an error with
the match count and asks the model to include more surrounding context.

**New files:**
- `js/tools/search-replace-tools.js` — tool definition + ensureFileActive
- `js/editor/instance.js` — new `replaceText()` function for character-
  offset find-and-replace through CodeMirror

**System prompt updated (`js/prompts.js`):**
- `search_replace` listed first in tool inventory
- Editing workflow rewritten: search_replace as PREFERRED approach,
  line-based tools as alternative "when you have confident line numbers"
- Efficiency rules updated: minimum edit path is now `read_file →
  search_replace`
- Line number drift warning explicitly notes "use search_replace to
  avoid this problem entirely"

**Cache handling (`js/chat/handlers.js`):**
- `search_replace`, `edit_file`, `write_file`, `delete_file` added to
  all three cache exclusion lists (bypass, invalidation, don't-cache).
  These were missing for `edit_file`/`write_file` since 0.9.21.

**Tool count:** 40 → 41

## [0.9.23-2] - 2026-02-12

### Fixed — Sparse tool call array crash

Streaming tool call deltas with non-zero `index` values created sparse
array holes (e.g., `[undefined, {function: ...}]`). The `for...of` loop
in `handleGeneralRequest` iterated the `undefined` slot, crashing on
`toolCall.function`.

**Root cause (`llm/api.js`):** `toolCalls[tc.index]` indexed by delta
position without filtering. Fixed: `.filter(Boolean)` before returning.

**Belt-and-suspenders (`chat/handlers.js`):** Added `if (!toolCall?.function) continue;` guard in the loop body.

### Added — Public-ready documentation

**`README.md`** — complete rewrite for GitHub readiness. Tighter
structure: Quick Start → What It Does → Features → Config → Shortcuts →
Deployment → Project Structure. No more stale "Future Enhancements"
checkbox list.

**`REPOS.md`** (new) — Git provider setup guide with minimum token
permissions per provider. Covers Gitea (repository + issue + user
scopes), GitHub (fine-grained and classic token options), GitLab (api
scope, explanation of why). Includes connection settings, multiple
connections, and troubleshooting.

**`docs/PLUGIN.md`** (new) — Plugin authoring guide. Covers bundled and
external plugins, manifest fields, hooks (beforeSend, afterResponse,
onModelChange), UI registration (toolbar buttons, modals), config schema
with auto-generated settings UI, `window.AIEditor` API reference
(Plugins, EventBus, State, Storage, Providers, Roles), event catalog,
State properties, and tips.

## [0.9.23-1] - 2026-02-12

### Fixed — Duplicate showToast declaration

Removed local `showToast()` function in `chat/index.js` that conflicted
with the `import { showToast } from '../ui-helpers.js'` added in 0.9.23.
The local copy was a legacy inline version; the imported one is the
canonical implementation.

## [0.9.23] - 2026-02-12

### Added — Conversation Persistence

Chat history now persists across multiple conversations. "New Chat"
saves the current conversation and creates a blank one instead of
destroying history.

**Core system (`js/chat/conversations.js`):**
- `ConversationManager` — CRUD for conversations with Storage backend
- Storage layout: `conversations` (metadata index), `conv-{id}`
  (messages + summaryInfo + pruneStash), `activeConversation` (active ID)
- Auto-migration: on first run, existing `chatHistory`/`chatSummaryInfo`/
  `chatPruneStash` are wrapped into the first conversation entry
- Auto-title: derived from first user message, truncated to 60 chars
- Handles multimodal content (image+text arrays) for title derivation
- Max 50 conversations; oldest auto-pruned when exceeded
- Debounced save on `chat:message` and `chat:pruned` events (2s delay)
- Immediate save on `beforeunload`

**Conversation drawer UI:**
- 📚 button in chat header toggles a slide-down drawer
- Shows all conversations sorted by most recent, with:
  - Title (from first message)
  - Relative time ("3h ago", "2d ago")
  - Message count
  - Active conversation highlighted with `--bg-active`
  - ✕ delete button (appears on hover)
- Click to switch: saves current → loads target → re-renders messages
- Click outside or toggle button to close drawer
- Auto-re-renders on create/load/delete/rename events

**Behavioral changes:**
- "New Chat" button: 🗑️ → ➕ icon, toast says "New conversation
  started" instead of "Chat cleared"
- `clearChat()` now calls `ConversationManager.create()` instead of
  wiping State — current conversation is saved first
- Each conversation stores its own summary and prune stash

**New CSS in `chat.css`:** `.conversation-drawer`, `.conv-drawer-header`,
`.conv-drawer-list`, `.conv-item`, `.conv-item-active`,
`.conv-item-content`, `.conv-item-title`, `.conv-item-meta`,
`.conv-item-delete`, `.conv-empty`

**New:** `js/chat/conversations.js` (337 lines)

**Modified:** `js/chat/index.js` (ConversationManager init, drawer UI,
debounced save, beforeunload hook, switchConversation on window.Chat),
`js/app.js` (toast wording), `html/chat-panel.html` (📚 button + drawer
element, ➕ icon), `css/chat.css` (drawer styles),
`docs/ARCHITECTURE.md` (conversations module entry)

## [0.9.22-2] - 2026-02-12

### Fixed — Full UI Theme Audit

Comprehensive audit across all modals, JS-generated HTML, and form
controls. Every inline-styled form element now uses CSS classes from
the design system.

**Merge modal (the reported bug):**
- `#prMergeStrategy` select → `class="select-inline"` — was unstyled
  browser chrome with only inline `font-size`
- Delete branch label/checkbox → `class="label-inline-check"`
- PR comment textarea → `class="textarea-mono"` inside `.form-group`

**New CSS classes in `modals.css`:**
- `.select-inline` — themed select for use outside .form-group
- `.label-inline-check` — compact checkbox+label combo
- `.textarea-mono` — monospace textarea with theme colors/borders
- `.badge-state` + `-open/-closed/-merged` — PR/issue state badges
- `.btn-xs` — extra-small button (toggle comments)
- `.btn-sm` — small button (storage cleanup)
- `.btn-icon-danger` — icon-only delete button with hover→danger
- `.error-type-error/-warn/-log` — error log type badges
- `.error-recovery-hint` — themed recovery hint block

**PR detail (`pr-detail.js`):**
- State badges: hardcoded `#8957e5`, `#238636`, `#da3633` → CSS classes
- Toggle comments button: `font-size: 10px` inline → `.btn-xs`

**Issue detail (`issue-detail.js`):**
- Toggle comments button: same fix as PR detail

**Error logger (`error-logger.js`):**
- Badge highlight: `#dc3545` → `var(--danger)`
- Type colors: hardcoded hex map → `var(--danger)`, `var(--warning)`,
  `var(--text-muted)`
- Recovery hint: hardcoded `#3b82f6`/`#93c5fd` → `.error-recovery-hint`

**Storage metrics (`storage-metrics.js`):**
- Delete embedding button: 8-property inline + onmouseover/out →
  `.btn-icon-danger` (CSS handles hover)
- Cleanup buttons: inline font-size → `.btn-sm`

**Modals HTML cleanup:**
- Removed 6 redundant `style="width: 100%"` on selects/inputs already
  inside `.form-group` (rule provides it)

## [0.9.22-1] - 2026-02-12

### Fixed — Plugin Install UI Theme Consistency

Audited the plugin install UI from 0.9.22 against the design system.
All inline-styled elements now use existing CSS classes or new
purpose-built rules.

**Before → After:**
- Install button: raw `<button>` with inline padding → `class="btn btn-primary"`
- URL input: inline font/size → `.plugin-install-row input` rule with proper
  `background`, `border`, `color`, `padding`, `::placeholder`, `:focus` from theme
- Install section container: inline bg/border/radius → `class="connection-editor"`
  (already existed for connection edit panels)
- Uninstall button: inline `color: var(--error)` → `class="danger"` (uses existing
  `.connection-card-actions button.danger:hover` pattern)
- Section headers: inline uppercase/tracking → `.plugin-section-header` class
- Config panel container: inline bg/border → `class="connection-editor"`
- Config field labels: inline `font-size` → inherited from `.form-group label`
- Config textareas: inline `font-family: mono` → `.plugin-config-panel textarea` rule
- External badge text: inline font-size → `.plugin-badge-external` class
- URL display in external cards: inline word-break → `.plugin-external-meta` class

**New CSS in `css/modals.css`:** `.plugin-section-header`,
`.plugin-install-row` (flex + input), `.plugin-install-status`,
`.plugin-install-hint`, `.plugin-external-meta`, `.plugin-badge-external`,
`.plugin-config-panel textarea`

**Modified:** `js/settings/plugins-tab.js` (replaced inline styles with
classes), `css/modals.css` (new plugin UI rules)

## [0.9.22] - 2026-02-12

### Added — Plugin Install from URL

External plugins can now be installed at runtime from any URL, without
modifying the `plugins/` directory or rebuilding the container image.

**Install flow:**
1. Settings → Plugins → paste URL → Install
2. Plugin JS is fetched, loaded via blob import, verified via
   `Plugins.register()` call detection
3. URL is persisted to localStorage — auto-reloads on next visit
4. Uninstall disables immediately; fully removed on reload

**`window.AIEditor` global API** — external plugins can't use relative
ES module imports, so `core.js` now exposes a global object:
```js
const { Plugins, EventBus, State, Storage, Providers, Roles } = window.AIEditor;
Plugins.register({ id: 'my-plugin', name: 'My Plugin', ... });
```

**Settings UI changes:**
- "Install Plugin from URL" section at top of Plugins tab with URL
  input, install button, and status feedback
- "Installed from URL" section shows external plugins with source URL,
  load status (● loaded / ⚠ error), and ✕ uninstall button
- "All Plugins" section now labels external plugins with 📦 icon and
  "(external)" badge
- Empty state updated to mention URL install option

**New:** `js/plugin-loader.js` — `installPlugin(url)`,
`uninstallPlugin(url)`, `getInstalledPlugins()`,
`loadInstalledPlugins()`

**Modified:** `js/core.js` (window.AIEditor global),
`js/app.js` (import + call loadInstalledPlugins at init),
`js/settings/plugins-tab.js` (install UI, external plugin list,
uninstall), `html/settings-tabs.html` (description update),
`docs/ARCHITECTURE.md` (window.AIEditor entry)

## [0.9.21] - 2026-02-12

### Added — Multi-File Editing

Two new tools let the LLM edit across files without manual `open_file`
calls, cutting the tool-call overhead for multi-file tasks roughly in
half.

**`edit_file`** — surgical edit on any file by path. Accepts `path`,
`operation` (replace/insert/delete), and the relevant line parameters.
Auto-opens the target file if it's not already active, switching tabs
transparently. The LLM can now do:
```
edit_file(path='a.js', operation='replace', start_line=10, end_line=15, new_content='...')
edit_file(path='b.js', operation='insert', after_line=5, new_content='...')
```
No intermediate `open_file` calls needed.

**`write_file`** — create new files or completely overwrite existing
ones. For existing files, opens in the editor and replaces all content
(not committed until user saves). For new files, creates via Git API,
refreshes the tree, and opens the new file.

### Fixed — open_file Race Condition

`open_file` used `setTimeout(100)` to record the EditTracker read after
the file loaded. Since `onTreeItemClick` already `await`s the full load
chain, the setTimeout was both unreliable and unnecessary. Replaced with
inline recording after the await.

### Fixed — replaceRange Missing Return Fields

`replaceRange()` in `editor/instance.js` didn't return `originalLineCount`
or `lineDelta` — both were `undefined` in edit tool responses and
EditTracker recordings. Added both fields. Also added `insertedAfter`
and `newLineCount` alias to `insertAtLine()` return for consistency.

### Changed — System Prompt Multi-File Guidance

Updated the system prompt to:
- List `edit_file` and `write_file` in capabilities
- Add `edit_file` as step 6 in the workflow (preferred over open_file + replace_lines)
- Add a dedicated "MULTI-FILE EDITING" workflow section
- Update critical rules to prefer `edit_file` over the manual open→edit pattern
- 35 tools total (2 new)

**New:** `js/tools/multifile-tools.js` (edit_file, write_file + ensureFileActive helper)

**Modified:** `js/tools/file-tools.js` (open_file setTimeout fix),
`js/editor/instance.js` (replaceRange + insertAtLine return fields),
`js/chat/index.js` (import + register), `js/prompts.js` (multi-file
workflow), `docs/ARCHITECTURE.md` (tool diagram)

## [0.9.20] - 2026-02-12

### Added — Image/Screenshot Paste for Vision Models

Chat now supports sending images alongside text prompts for use with
vision-capable LLMs. Three input methods:

- **Clipboard paste** — paste a screenshot or copied image directly into
  the chat textarea (Ctrl+V / Cmd+V)
- **Drag & drop** — drop image files onto the textarea
- **Attach button** — 📎 button opens a file picker (PNG/JPEG/GIF/WebP,
  5 MB max)

Pending images appear as thumbnails in a preview strip above the input
with ✕ to remove. Images-only sends (no text) are allowed.

Messages are stored using the OpenAI multimodal content format
(`content: [{type:'text',...}, {type:'image_url',...}]`), which passes
through the existing LLM pipeline to any vision-capable model. Image
thumbnails render inline in user chat messages and can be clicked for
a fullscreen overlay preview (Escape or click to dismiss).

The summarizer already guards against non-string content with
`typeof m.content === 'string' ? ... : JSON.stringify(...)`, so
multimodal messages are handled gracefully in context management.

**New:** `js/chat/state.js` (pendingImages state), `js/chat/input.js`
(paste/drop/attach handlers + preview strip), `js/chat/index.js`
(previewImage overlay + window.Chat wiring), `js/chat/handlers.js`
(multimodal content builder + alreadyInContext fix), `js/chat/messages.js`
(image rendering in messages), `js/app.js` (send button images-only),
`html/chat-panel.html` (📎 button), `css/chat.css` (preview strip,
message images, overlay, drag-over styles)

## [0.9.19-1] - 2026-02-12

### Fixed — Settings Save Clears Project

When saving settings, `refreshProjects()` rebuilt the dropdown but lost
the selection. The project appeared to vanish, leaving an orphaned branch
selector. Fix: after rebuilding the dropdown, re-select the current
`State.currentProject` value if one is loaded.

### Added — Session Persistence

Project, branch, and open tabs now survive page reloads:

- **`saveSession()`** — writes `connectionId`, `owner`, `repo`, `branch`,
  and pinned tab paths to `Storage` on every project switch, branch
  change, file open, or tab close (debounced at 1 s).
- **`restoreSession()`** — called once at startup after `refreshProjects`.
  Re-opens the saved project + branch, then re-opens each saved tab
  (best-effort, skips files that no longer exist on the branch).
- Preview tabs are intentionally excluded — only pinned tabs persist.
- The previously-active tab is re-activated after all tabs reopen.

### Added — Clear Project Button

New **✕** button in the sidebar project header:

- Prompts for confirmation if there are dirty (unsaved) tabs.
- Resets all project state (`currentProject`, `fileTree`, `openTabs`,
  `branches`, `issues`, `pullRequests`).
- Clears session storage so next reload starts fresh.
- Emits `project:cleared` event for other modules.

### Changed — `tab:closed` Event

`closeTab()` in `tab-manager.js` now emits `EventBus.emit('tab:closed')`
so session persistence can track tab removals (previously only
`tab:switched` existed).

### Fixed — Zip Upload Fires N Commits Instead of One

`uploadExtractedFiles()` called `provider.createFile()` / `updateFile()`
in a loop — one API call per file, each creating a separate commit and
push event. Uploading 137 files to a repo with CI triggered 137
concurrent pipeline runs.

Replaced with `provider.batchCommitFiles()`, a new method that uses
Gitea's multi-file contents endpoint (`POST /repos/{owner}/{repo}/contents`)
to commit ALL file operations in a **single atomic commit**. One push
event, one CI trigger, regardless of file count.

**Renamed across all providers:** `batchUpdateFiles` → `batchCommitFiles`.
The Gitea provider now uses the real batch API; GitHub/GitLab retain the
sequential fallback (can be upgraded later). The `batchSaveFiles()` facade
(used by the commit flow for dirty tabs) also benefits from this — dirty
tab commits that previously created N pushes now create one.

**New file parameter:** `encoding: 'base64' | 'text'` tells the batch
method whether content is pre-encoded (binary from JSZip) or needs
base64 conversion (text files).

### Fixed — Retry Leaves Dangling User Message

`retryLastMessage()` only popped the last assistant reply before re-
sending, leaving the original user message in place — resulting in a
duplicate. Now uses the same truncate-from-user-message-onward pattern
as `editAndResend()`, which also cleans up any interleaved tool messages.

**Modified:** `js/zip-upload.js` (single batch commit), `js/git-providers/gitea.js`
(real batch API), `js/git-providers/base.js` + `github.js` + `gitlab.js`
(method rename), `js/git.js` (facade + batchSaveFiles), `js/project-manager.js`
(refreshProjects fix + session persistence + clearProject), `js/app.js`
(imports + wiring), `js/tab-manager.js` (tab:closed event),
`js/chat/index.js` (retry fix), `html/sidebar.html` (✕ button)

## [0.9.19] - 2026-02-12

### Added — Cross-Project Reference Tools

Two new LLM tools that allow reading files from OTHER projects without
switching away from the current workspace:

- **`peek_project_tree`** — browse the file tree of any connected repo.
  Takes `connectionId`, `owner`, `repo`, optional `branch` and `path`.
  Returns the same shape as `get_project_tree`.
- **`peek_project_file`** — read a file from any connected repo (read-
  only). Supports the same truncation and `full=true` semantics as
  `read_file`. Returns `reference_project` and `current_project` fields
  so the LLM always knows which repo it's looking at.

**Why this matters:** The user can now say "look at how the billing
service handles pagination and implement the same pattern here" and the
LLM will peek at the billing repo's files, save the pattern to
scratchpad, and implement it in the current project — all without
disrupting the workspace, losing dirty tabs, or triggering UI refreshes.

**Workflow guidance:** System prompt updated with step 11: Cross-Project
Reference, instructing the LLM to prefer `peek_*` tools over
`set_active_project` for read-only reference lookups.

**New file:** `js/tools/xref-tools.js` (190 lines)
**Modified:** `js/chat/index.js` (import + registration),
`js/prompts.js` (tool list + workflow), `docs/ARCHITECTURE.md`

## [0.9.18] - 2026-02-12

### Fixed — V Hotkey Captured in Commit Modal

The diff viewer's keyboard shortcut handler (`initDiffKeyboardShortcuts`)
now checks for active inputs/textareas and open modals before handling
bare key presses. Typing "v" in the commit message textarea no longer
toggles the diff view mode.

**Guards added:** `activeElement` is INPUT/TEXTAREA/contentEditable,
or any `.modal-overlay.active` is present.

**File modified:** `js/diff-viewer.js`

### Fixed — Generated Commit Message Not Populating

Root cause: `buildCommitMessagePrompt(original, updated)` expected two
arguments (single-file original/updated), but `generateCommitMessage()`
passed one combined diff summary string. `{{updated}}` resolved to the
literal string "undefined".

Fixes:
- Template now uses single `{{diff_summary}}` placeholder for multi-file diffs
- `buildCommitMessagePrompt()` takes one argument matching the caller
- `generateCommitMessage()` now prefers `result.content` (think-blocks
  stripped) over `result.rawContent` (may contain `<think>` blocks)
- Strips markdown code fences some models wrap commit messages in
- Empty result shows warning toast instead of silent failure

**Files modified:** `js/prompts.js`, `js/llm/api.js`, `js/ui/commit.js`

### Fixed — Favicon Replaced by Canvas Icon on Load

`FaviconManager.init()` stored the original SVG favicon (⚡ lightning
bolt) but immediately replaced it with a canvas-drawn code-brackets icon
via `_drawIdleIcon()`. The idle state now restores the original HTML
favicon. Canvas drawing is only used for loading spinner and error states.

**File modified:** `js/favicon-manager.js`

## [0.9.17] - 2026-02-12

### Improved — Error Logger + EditorError Integration

The error log modal now surfaces structured fields from `EditorError`:

- **Code badge** — monospace `AUTH_INVALID_TOKEN`, `GIT_NOT_FOUND`, etc.
  displayed inline next to the error type
- **Recovery hint** — blue-highlighted 💡 block below the error message
  with actionable suggestions (e.g. "Check your API token in Settings →
  Connections.")
- **HTTP status** — shown when available (e.g. `HTTP 404`)
- Text export (`exportText()`) includes code, status, and hint
- `serializeValue()` extracts EditorError fields when logging via
  `console.error()`
- Backward-compatible: regular `Error` objects render unchanged

**Files modified:** `js/error-logger.js`

### Added — Buy Me a Coffee Badge

☕ badge in the Help modal footer linking to
https://buymeacoffee.com/jeffasmith — visible but not intrusive.

**Files modified:** `html/modals.html`

## [0.9.16-1] - 2026-02-12

### Removed — Dead Scroll Sync Code

With diffs now overlaying the editor pane (since 0.9.14-2), the
editor-to-diff scroll sync was OBE. Removed:

- `initEditorDiffSync()` — bidirectional editor↔diff scroll polling
- `syncEditorToChange()` — editor scroll on change navigation
- `toggleScrollSync()` — toggle function and state variable
- `scrollSyncEnabled` / `editorScrollListener` state
- 🔗 Sync button from diff controls toolbar
- `S` keyboard shortcut (was mapped to sync toggle, help page incorrectly said "syntax highlighting")
- `toggleScrollSync` from `window.DiffViewer` global

**Kept:** Left↔right pane sync in side-by-side mode (still needed).

**Files modified:** `js/diff-viewer.js` (746→597 lines, −149),
`html/modals.html` (removed `S` from help), `js/version.js`

## [0.9.16] - 2026-02-12

### Changed — Summarizer: Percentage-Based Scaling (replaces tier system)

The old tier system (`Huge`/`Large`/`Medium`/`Small` + mode shift) is
replaced with smooth, linear scaling from the loaded model's actual
context window size.

**How it works:**
- Mode sets a *fill percentage* of the context window:
  - Aggressive: **30%** — summarize early, keep context lean
  - Balanced: **50%** — default middle ground
  - Conservative: **75%** — preserve more, still safe from overflow
- All params (recent count, threshold, interval, maxChars) derived from
  `contextTokens × fillPct / 800` with per-param min/max clamps
- No discrete tiers → no "cliff" when a model sits near a boundary
- Custom mode still uses user-specified values, unchanged

**Examples (128K model):**
| Mode | Threshold | Recent (base/tools) | Interval |
|------|-----------|---------------------|----------|
| Aggressive | 48 | 17/29 | 22 |
| Balanced | 80 | 28/48 | 36 |
| Conservative | 120 | 42/72 | 54 |

**Files modified:** `js/chat/summarizer.js`, `js/settings/llm-tab.js`,
`js/tools/scratchpad-tools.js`, `tests/test-summarizer.js`

### Added — `docs/ARCHITECTURE.md`

Module dependency map, layer diagram, key data flows, and file size
budget. Auto-derived from source with manual annotations.

### Added — Structured Error Objects (`js/utils/errors.js`)

`EditorError` class extends native `Error` with:
- `.code` — machine-readable enum (`ErrorCode.GIT_NOT_FOUND`, etc.)
- `.recoveryHint` — actionable suggestion for the user
- `.status` — HTTP status code (when applicable)
- `.context` — metadata (endpoint, rawBody, etc.)
- `EditorError.fromResponse(response)` — factory from fetch Response
- `EditorError.wrap(err)` — wrap any thrown value with code inference

Wired into:
- `git-providers/base.js` — `request()` now throws `EditorError`
- `git-providers/gitea.js` — blame unsupported uses `ErrorCode.BLAME_UNSUPPORTED`
- `tools/registry.js` — `execute()` checks `.code` + `.recoveryHint` first

### Added — Offline Indicator Banner (`js/offline-indicator.js`)

Fixed-position banner at screen bottom when network connectivity is lost.
- Listens for browser `online`/`offline` events
- Periodic fetch probe (every 10s when offline) catches captive portal / DNS failures
- `aria-live="assertive"` for screen reader announcement
- Emits `EventBus('network:status', { online })` for other modules to react

## [0.9.15] - 2026-02-12

### Added — JSDoc Type Annotations & `@ts-check`

First pass of static type coverage across the five core modules. Zero
runtime changes — every edit is a JSDoc comment or a new `jsconfig.json`.

**New file:**
- `jsconfig.json` — VS Code project config enabling `@ts-check` IDE
  support project-wide (ES2022, bundler resolution, `js/**/*.js` scope)

**Typed modules (41 `@typedef`, 5 `@ts-check`):**
- `js/core.js` — 14 typedefs: `GitConnection`, `Settings`,
  `VeniceParameters`, `OpenRouterParameters`, `SummarizerConfig`,
  `SummarizerMode`, `ModelEntry`, `ModelMeta`, `TabEntry`,
  `ChatMessage`, `SessionCost`, `ProviderBalance`, `Role`,
  `PluginManifest`. All `EventBus`, `Storage`, `Plugins` methods typed.
- `js/git-providers/base.js` — 9 typedefs: `TestConnectionResult`,
  `BlameCommit`, `BlameRange`, `BlameData`, `FileCommit`,
  `PullRequestData`, `PRFileChange`, `CommitStatus`. Every provider
  method annotated with `@param`/`@returns`.
- `js/tools/registry.js` — 2 typedefs + 1 callback:
  `ToolDefinition`, `ToolFunctionSchema`, `ToolHandler`. Typed
  `handlers` Map and `definitions` array.
- `js/llm/api.js` — 9 typedefs: `LLMChatOptions`, `LLMUsage`,
  `ToolCallDelta`, `LLMChatResult`, `RequestBodyOptions`. Re-imports
  shared types from core and registry.
- `js/chat/summarizer.js` — 7 typedefs: `TierParams`, `Tier`,
  `SummaryInfo`, `AutoParams`. Re-imports `ChatMessage`,
  `SummarizerMode`, `SummarizerConfig` from core.

**Developer experience:**
- VS Code now shows inline type hints, autocomplete, and red squiggles
  for type mismatches across the entire `js/` tree
- Hover over any `State.settings.*` property to see its type
- Tool handlers get full parameter and return-type checking
- Cross-module imports resolve typed interfaces (e.g. `GitConnection`
  defined in core.js, used in base.js via `@typedef {import(...)}`)

## [0.9.14-3] - 2026-02-12

### Fixed — Summarizer Mode Radio Buttons

- Mode radio buttons (Aggressive/Balanced/Conservative/Custom) were
  non-functional — clicking a different mode re-read the old value from
  `State.settings.summarizerMode` and re-checked it, ignoring the click
- Change handler now writes `e.target.value` into State before
  re-populating the sliders, so mode switches take effect immediately

## [0.9.14-2] - 2026-02-12

### Fixed — Diff/Blame Full-Width & Gitea Blame

- Diff and Blame panes now fill 100% of the editor-split area — cleared
  inline `style.width` set by the resize manager so the `diff-overlay`
  CSS class takes effect properly
- Gitea blame now immediately throws `BLAME_UNSUPPORTED` since the Gitea
  REST API has no blame endpoint, cleanly triggering the file history
  fallback instead of hitting a 404
- Fixed Gitea file history endpoint from `/git/commits` (non-existent)
  to `/commits` — the correct Gitea API path for listing commits with
  path filtering

## [0.9.14-1] - 2026-02-12

### Fixed — Diff/Blame Fullscreen Button

- Fullscreen button now hidden for Diff and Blame modes — these already
  overlay the editor at full width via `diff-overlay`, making the button
  redundant and confusing
- Button remains visible for Preview mode where split/fullscreen toggle
  is meaningful

## [0.9.14] - 2026-02-12

### Changed — Summarizer Modes & Scratchpad Scaling

**Summarizer: named modes replace auto/manual**
- New modes: 🔥 Aggressive, ⚖️ Balanced, 🧊 Conservative, 🔧 Custom
- All non-custom modes remain context-window-aware via tier detection
- Aggressive shifts detected tier toward smaller (prune early, save tokens)
- Conservative shifts toward larger (preserve history, use more context)
- Legacy `auto` → `balanced`, `manual` → `custom` (auto-migrated)
- System prompt now injects "Summary in ~N messages" countdown when
  approaching summarization — encourages scratchpad note-taking

**Scratchpad scaling by mode**
- Limits now scale with summarizer mode (tied to context capability):
  - Aggressive: 8 keys, 400 chars/value, 1.5K auto-inject
  - Balanced: 15 keys, 1000 chars/value, 4K auto-inject
  - Conservative: 20 keys, 2000 chars/value, 8K auto-inject
- Gives large-context models proportionally more working space

### Fixed

**Gitea blame fallback**
- Blame now falls back to file history for ANY error, not just
  BLAME_UNSUPPORTED — fixes broken Gitea blame (404 on older instances,
  format mismatches)
- Gitea blame normalizer hardened: handles multiple response shapes
  (`commit.sha` vs `commit_sha`, string vs object lines, etc.)
- Fallback view now shows reason: "Line blame unavailable (reason)"

### Improved

**Test runner TLDR**
- Summary + per-suite pills now render at top of page before detailed results
- Instant pass/fail visibility without scrolling

**Test coverage: mode shifting**
- New tests for aggressive/conservative tier shifting
- Legacy mode migration tests (`auto`→`balanced`, `manual`→`custom`)
- Boundary clamping tests (aggressive on smallest, conservative on largest)

## [0.9.13] - 2026-02-12

### Changed — Module Decomposition

Three monolithic modules split into focused sub-modules using barrel re-export
pattern. Zero downstream import changes required (except app.js for ui/).

**editor.js (1036→4 files)**
- `editor/setup.js` — CodeMirror loading, CDN fallback, language config
- `editor/instance.js` — Editor creation, content ops, line-level editing
- `editor/file-utils.js` — `isTextFile`, `getFileIcon` (pure, zero deps)
- `editor/diff.js` — `computeSimpleDiff`, `formatDiffForDisplay` (pure)
- `editor.js` — barrel re-export (all existing imports preserved)

**llm.js (919→3 files)**
- `llm/utils.js` — `stripThinkBlocks`, `sanitizeMessages` (pure, tested)
- `llm/debug.js` — `LLMDebug` ring-buffer logger (self-contained)
- `llm/api.js` — `LLM` client, streaming, tool calling, cost tracking
- `llm.js` — barrel re-export (all existing imports preserved)

**ui-helpers.js (634→4 files)**
- `ui/commit.js` — Commit modal workflow
- `ui/revert.js` — Single & batch revert with confirmation modal
- `ui/branch.js` — Branch creation with git-ref sanitization
- `ui/file-create.js` — New file modal
- `ui-helpers.js` — shared utilities (toggles, toast, draft mgmt, status bar)

### Architecture
- CM namespace pattern (`CM` object) eliminates module-level `let` sharing
  between setup and instance modules
- Direct import from `prompts.js` in `editor/setup.js` eliminates the
  editor→llm→prompts indirection for `getLanguageFromPath`
- No circular dependencies: sub-modules import parent utilities,
  barrels only re-export

### Files Modified
- `js/editor.js` → barrel re-export
- `js/editor/setup.js` — NEW
- `js/editor/instance.js` — NEW
- `js/editor/file-utils.js` — NEW
- `js/editor/diff.js` — NEW
- `js/llm.js` → barrel re-export
- `js/llm/utils.js` — NEW
- `js/llm/debug.js` — NEW
- `js/llm/api.js` — NEW
- `js/ui-helpers.js` → trimmed to shared utilities
- `js/ui/commit.js` — NEW
- `js/ui/revert.js` — NEW
- `js/ui/branch.js` — NEW
- `js/ui/file-create.js` — NEW
- `js/app.js` — updated imports for ui/ sub-modules
- `js/version.js` — 0.9.13

## [0.9.12] - 2026-02-12

Test coverage expansion for pure functions across the codebase.
Adds 7 new test modules (~248 assertions) covering LLM message handling,
chat intent routing, tool call parsing, context filtering, HTML escaping,
event bus, and secondary pane utilities.

### Added
- **test-eventbus.js** — on/off/emit, return-value unsubscribe, error isolation, data passing (13 assertions)
- **test-llm-pure.js** — `stripThinkBlocks` edge cases, `sanitizeMessages` field stripping/role filtering/tool call sparse gap handling, `getLanguageFromPath` mapping (53 assertions)
- **test-handlers.js** — `detectIntent` routing for commit/issue/edit/explain/general intents with and without open file, `_briefError` JSON extraction and truncation (45 assertions)
- **test-tools-parse.js** — `validateToolParameters` required/missing/edge cases, `parseTextToolCalls` JSON tags/function_call variant/argument formats (35 assertions)
- **test-context-filter.js** — `ContextManager.shouldIndex` for source files, binary/media exclusions, lock files, path patterns, edge cases (47 assertions)
- **test-secondary-pane.js** — `isPreviewable`, `_shortAuthor` name formatting, `_shortDate` relative time (30 assertions)
- **test-html-escape.js** — `escapeHtml` and `escapeAttr` XSS prevention, null/coercion handling (25 assertions)

### Changed
- **js/llm.js** — exported `sanitizeMessages` for testability
- **js/secondary-pane.js** — exported `_shortAuthor`, `_shortDate` for testability
- **js/chat/handlers.js** — exported `detectIntent`, `_briefError` for testability
- **tests/index.html** — organized imports by category (infrastructure → core → modules → LLM/chat → UI/context → deployment)

### Files
- `tests/test-eventbus.js` — NEW
- `tests/test-llm-pure.js` — NEW
- `tests/test-handlers.js` — NEW
- `tests/test-tools-parse.js` — NEW
- `tests/test-context-filter.js` — NEW
- `tests/test-secondary-pane.js` — NEW
- `tests/test-html-escape.js` — NEW
- `tests/index.html` — updated with 7 new imports
- `js/llm.js` — added `sanitizeMessages` to exports
- `js/secondary-pane.js` — exported `_shortAuthor`, `_shortDate`
- `js/chat/handlers.js` — exported `detectIntent`, `_briefError`
- `js/version.js` — bumped to 0.9.12

## [0.9.11-1] - 2026-02-12

### Fixed
- **IDB test stability** — `test-idb.js` now clears IDB on startup to prevent stale data from prior runs causing false failures (IndexedDB persists across page reloads unlike in-memory state)

### Added
- **External dependency audit test** (`test-dependencies.js`) — SCIF readiness validation
  - Manifest of all 5 external dependencies with local/CDN paths and bundling status
  - Local vendor file probing (HEAD fetch for each vendor path)
  - CDN reachability check (5s timeout, no-cors mode)
  - Runtime global verification (marked, DOMPurify, JSZip)
  - SCIF summary: asserts all 4 required deps are Docker-bundled, flags 1 optional dep (Transformers.js)

## [0.9.11] - 2026-02-12

### Added
- **IndexedDB storage backend** — primary persistence layer replacing localStorage
  - `js/storage/idb.js` — async key-value wrapper with single `kv` object store
  - Methods: `open()`, `get()`, `set()`, `remove()`, `keys(prefix)`, `getAll()`, `setMany()`, `clear()`, `estimate()`
  - Automatic migration from localStorage to IndexedDB on first load
  - In-memory `Map` cache keeps `Storage.get()` synchronous — zero API changes for callers
  - Write-through: `set()` writes to cache + IDB (async) + localStorage (fallback)
  - `remove()` cleans all three layers: cache, IDB, localStorage
- **Storage.keys(prefix)** — list all keys with optional prefix filter (synchronous, reads from cache)
- **Storage.isIDBActive** — boolean property indicating whether IndexedDB is active
- **Large draft support** — drafts >512KB now saved to IDB (previously skipped entirely)
- **New tests** — `test-idb.js` (IDB low-level operations) and `test-storage.js` (cache layer, keys, drafts)

### Changed
- **Storage.init()** — new async initialization step called before `loadSettings()` in app boot
  - Loads IDB → cache on startup; falls back to localStorage → cache if IDB unavailable
  - Migration runs once: all `ai-editor-*` localStorage keys copied to IDB, flag set
- **Storage Metrics tab** — now reads from in-memory cache instead of iterating localStorage
  - Shows active backend (IndexedDB or localStorage) in total label and quota section
  - Tab description updated to reflect IDB-primary architecture
- **ContextManager.cleanupOrphanedIndexes()** — uses `Storage.keys()` / `Storage.remove()` instead of direct `localStorage` iteration
- **SearchManager** — ported from raw `localStorage` to `Storage` API with one-time migration of legacy unprefixed `searchHistory` key

### Fixed
- **EditTracker** — same-millisecond timestamp collision caused `checkStale()` to miss edits
  - Added monotonic `_seq` counter for guaranteed logical ordering
  - `checkStale()` now filters on `e.seq > lastRead.seq` instead of timestamp comparison
  - Delta-zero edits (same-size replacements) no longer falsely trigger staleness
- **Vendor bundle paths** — hardcoded absolute `/vendor/` paths broke deployments at sub-paths (e.g. `/editor-dev/`)
  - `editor.js`: CodeMirror bundle import now resolves via `document.baseURI` instead of absolute `/vendor/`
  - `embeddings-client.js`: Transformers.js import uses same baseURI resolution

### Files
- `js/storage/idb.js` — NEW: IndexedDB wrapper module
- `js/core.js` — Storage object rewritten: _cache Map, init(), keys(), IDB integration
- `js/app.js` — `await Storage.init()` added to boot sequence before `loadSettings()`
- `js/context-manager.js` — `cleanupOrphanedIndexes()` uses Storage API
- `js/managers/search-manager.js` — imports Storage, ported from raw localStorage
- `js/storage-metrics.js` — `measureStorage()` reads from cache, IDB-aware rendering
- `js/ui-helpers.js` — updated string references (localStorage → storage)
- `js/tools/edit-tracker.js` — `_seq` counter, `clearAll()` resets seq
- `html/settings-tabs.html` — updated tab description and heading
- `js/editor.js` — vendor bundle path: absolute → baseURI-relative
- `js/embeddings-client.js` — vendor transformers path: absolute → baseURI-relative
- `tests/test-idb.js` — NEW: IDB wrapper tests (open, CRUD, keys, setMany, clear)
- `tests/test-storage.js` — NEW: Storage cache layer tests (keys, consistency, drafts)
- `tests/index.html` — added IDB and Storage test imports

## [0.9.10] - 2026-02-11

### Added
- **Git blame view** — line-by-line blame data displayed in the secondary pane
  - Gitea: Full blame via `GET /repos/{owner}/{repo}/git/blames/{ref}/{path}` (requires Gitea 1.22+)
  - GitLab: Full blame via `GET /projects/:id/repository/files/:path/blame`
  - GitHub: Falls back to file commit history (REST API lacks blame endpoint)
  - Color-coded by commit with alternating backgrounds for visual range separation
  - Blame gutter shows short SHA (with commit message tooltip), author, and relative date
  - Stats bar: total lines and unique commit count
  - Keyboard shortcut: `Ctrl+Shift+B`
  - Toolbar button: 🔍 Blame (disabled when no file is open)
  - Auto-refreshes on tab switch
- **File commit history** — `getFileCommits()` API across all three providers
  - Gitea: `GET /repos/{owner}/{repo}/git/commits?path=...`
  - GitHub: `GET /repos/{owner}/{repo}/commits?path=...`
  - GitLab: `GET /projects/:id/repository/commits?path=...`
  - Used as fallback when blame is unavailable, displayed as a sortable table
- **Test suite** — browser-based test runner with 4 test modules
  - `tests/index.html` — minimal test framework (assert, eq, deepEq, throws/throwsAsync)
  - `tests/test-edit-tracker.mjs` — EditTracker stale detection, multi-edit tracking, cross-file isolation
  - `tests/test-retry.mjs` — isRetryable classification (transient vs permanent errors, all error patterns)
  - `tests/test-summarizer.mjs` — auto-tune tier boundaries, mode toggle, _extractSymbols (JS/Python/Rust), _summarizeToolResult (file/tree/search/error results)
  - `tests/test-blame-normalize.mjs` — blame export validation and guard checks

### Files
- `js/git-providers/base.js` — `getBlame()`, `getFileCommits()` base methods
- `js/git-providers/gitea.js` — `getBlame()` (blame API), `getFileCommits()` (commits API)
- `js/git-providers/github.js` — `getBlame()` (throws BLAME_UNSUPPORTED), `getFileCommits()` (commits API)
- `js/git-providers/gitlab.js` — `getBlame()` (blame API), `getFileCommits()` (commits API)
- `js/git.js` — `getBlame()`, `getFileCommits()` facade methods
- `js/secondary-pane.js` — `toggleBlamePane()`, `renderBlame()`, `_renderBlameView()`, `_renderFileHistory()`, `_shortAuthor()`, `_shortDate()`, blame color palette
- `js/app.js` — blame import, `Ctrl+Shift+B` shortcut, blame button wiring
- `html/editor-panel.html` — 🔍 Blame toolbar button
- `css/editor.css` — blame-view, blame-table, blame-gutter, file-history, history-table styles
- `tests/` — new test directory with runner and 4 test modules

## [0.9.9] - 2026-02-11

### Added
- **Summarizer auto-tune** — automatically scales summarizer parameters based on the active model's context window size
  - Four tiers: Small (<32K, aggressive), Medium (32K+), Large (128K+), Huge (500K+, nearly disabled)
  - New auto/manual mode toggle in Settings → LLM → Chat Summarizer
  - Auto mode: sliders show computed values (read-only), info badge shows tier and detected context window
  - Manual mode: sliders work as before with full user control
  - `summarizerMode` setting persisted; defaults to `auto`
  - Slider ranges expanded (max recent: 80/120, threshold: 250, interval: 100) for large-context models
  - Recomputes on model change via `model:changed` EventBus event
- **Smarter tool result handling in summarizer** — tool results now get structured compression instead of being discarded
  - File read results → `[File: path — N lines. Key symbols: fn1, fn2, ...]`
  - File tree results → `[File tree: N files. Sample: path1, path2, ...]`
  - Search results → `[Search: N matches in M files: path1, path2, ...]`
  - Error results preserved in full
  - `_extractSymbols()` extracts function/class/const/def names from source code (JS, Python, Rust, Go)
  - Assistant tool_calls now listed in summary prompt: `[Tools called: read_file → path, search_in_files → "query"]`
  - `_basicSummary()` fallback now includes file paths from tool results
- **`maxTokens` scaling** — LLM summary generation token budget now scales with `maxChars` setting instead of hardcoded 500

### Files
- `js/chat/summarizer.js` — auto-tune tiers, mode property, `getAutoParams()`, `_getContextWindow()`, `_getTier()`, `_summarizeToolResult()`, `_extractSymbols()`, rewritten `_buildPrompt()`, `_basicSummary()` with tool paths, scaled `maxTokens`
- `js/settings/llm-tab.js` — rewritten `populateSummarizerSliders()` with auto/manual toggle, `updateSummarizerForModel()`, `model:changed` listener, ChatSummarizer import
- `js/settings/persistence.js` — `summarizerMode` persistence, conditional slider save (skip in auto mode)
- `js/model-manager.js` — emit `model:changed` event on model selection
- `html/settings-tabs.html` — auto/manual radio toggle, auto-tune info badge, expanded slider ranges

## [0.9.8-4] - 2026-02-11

### Added
- **New Project button** (➕) in sidebar header — opens a modal to create a new repository on any connected git provider
  - Connection selector, repo name, description, private/public toggle, auto-init README
  - Validates repo name format, auto-selects the new project after creation
  - `createRepo()` implemented for all three providers (Gitea, GitHub, GitLab) + Git facade
- **LLM `list_projects` tool** — lists all available projects across all connections with current active project/branch info. Scoped to all roles.
- **LLM `set_active_project` tool** — programmatic project switching from chat
  - Refuses if there are dirty (unsaved) files — tells the LLM to commit first
  - Accepts optional `branch` parameter to switch to a specific branch
  - Clears tabs, editor state, updates branch selector, emits `project:loaded`
  - Reuses the same `switchProject()` function as the UI dropdown
- **`switchProject()` extracted** from `onProjectChange` as a reusable exported function — accepts `(connectionId, owner, repo, { branch })`, used by both UI and LLM tool
- **System prompt updated** with step 0 ("if no project is loaded → list_projects → set_active_project") and step 10 for project switching during workflow

### Files
- `js/project-manager.js` — `switchProject()`, `openNewProjectModal()`, `closeNewProjectModal()`, `submitNewProject()`, wiring in `initProjectListeners`
- `js/tools/project-tools.js` — `list_projects` and `set_active_project` tools
- `js/git.js` — `createRepo()` facade method
- `js/git-providers/base.js` — `createRepo()` base method
- `js/git-providers/gitea.js` — `createRepo()` via POST `/user/repos`
- `js/git-providers/github.js` — `createRepo()` via POST `/user/repos`
- `js/git-providers/gitlab.js` — `createRepo()` via POST `/projects`
- `js/llm.js` — system prompt additions for project tools
- `html/sidebar.html` — ➕ New Project button
- `html/modals.html` — New Project modal

## [0.9.8-3] - 2026-02-11

### Added
- **Per-index delete** on embedding cards in Settings → Storage — each embedding index now has an × button to delete it individually instead of only the nuclear "Clear Embeddings" option
  - Confirm dialog shows the project/branch name
  - Clears in-memory index if the deleted entry was the active one
  - Re-renders the metrics view after deletion

### Files
- `js/storage-metrics.js` — delete button on each embedding card, event delegation, ContextManager import

## [0.9.8-2] - 2026-02-11

### Fixed
- **Embeddings indexing 75 files instead of respecting limits** — `indexProject()` was indexing every file from `State.fileTree` with no extension filtering, no path exclusions, and no max count. Now:
  - **Extension filter**: skips binary, media, fonts, archives, compiled, lockfiles, maps, office docs (40+ extensions)
  - **Path filter**: skips `node_modules/`, `vendor/`, `dist/`, `build/`, `.git/`, minified bundles, lockfiles
  - **Max cap**: respects `maxIndexFiles` setting (default: 200, configurable 25–500 via new slider)
  - `shouldIndex()` method shared by `indexProject`, `updateFileIndex`, `reindexChanged`, and file event handlers
- Fixed duplicate `type="button"` attributes across settings-tabs.html

### Added
- **Branch lifecycle for embeddings**:
  - `git:branchDeleted` → removes that branch's embedding index from localStorage
  - `branch:switch` → loads cached index for new branch or auto-indexes if none exists
  - `context:prMerged` → incrementally re-indexes only the changed files on the target branch after merge
  - `removeIndexForBranch(name)` method for explicit branch index cleanup
  - `cleanupOrphanedIndexes(liveBranches)` method for bulk orphan cleanup
- **Incremental re-indexing** via `reindexChanged(paths)` — re-embeds only specific files instead of full project rebuild
- **Max files to index** setting (Settings → Context): slider 25–500, default 200
  - Status display shows when index is at the cap with a warning to increase
- `context:prMerged` event emitted from `submitMergePR` with `baseBranch`, `headBranch`, `changedFiles`, and `deletedBranch` data

### Files
- `js/context-manager.js` — filtering, branch lifecycle, reindexChanged, event listeners overhaul
- `js/project-manager.js` — emit `context:prMerged` after successful merge
- `js/settings-manager.js` — maxIndexFiles slider init and handler
- `js/settings/persistence.js` — maxIndexFiles read/write
- `js/settings/llm-tab.js` — enhanced status display with limit info
- `html/settings-tabs.html` — maxIndexFiles slider, fixed duplicate type attrs

## [0.9.8-1] - 2026-02-11

### Fixed
- **"null" rendered in assistant messages** — tool-call-only assistant responses (no text content) were stored with `content: null` in chatHistory. On page refresh or re-render, `JSON.stringify(null)` produced the literal string "null" in the UI. Fixed in three places:
  - `renderMessage` now skips assistant messages that have `tool_calls` but no content (these are protocol artifacts, not user-facing messages)
  - `renderMessage` null-guards content with `|| ''` before passing to `stripThinkBlocks` and `JSON.stringify`
  - `updateStreamingMessage` and `finalizeStreamingMessage` both null-coerce content at entry
- **Tab-switch streaming resilience** — if the browser backgrounded the tab during streaming and chunks were lost, the same null content path could trigger. The guards prevent "null" from ever reaching the DOM regardless of how content becomes null/undefined.

### Files
- `js/chat/messages.js` — null guards in `renderMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`; skip-render logic for tool-call-only assistant messages

## [0.9.8] - 2026-02-11

### Added
- **LLM commit tool** (`commit_files`) — the LLM can now commit dirty editor files directly from chat:
  - Accepts optional `paths` array to commit specific files (defaults to all dirty files)
  - Accepts optional `message` for a custom commit message; if omitted, auto-generates one using the same `generateCommitMessage` pipeline as the commit modal
  - Syncs current editor content to tab state before committing
  - Updates tab dirty state and triggers UI refresh after commit
  - Returns committed paths, failed paths (with errors), and the commit message used
- **List dirty files tool** (`list_dirty_files`) — LLM can check which files have uncommitted changes before committing, with line change and size info
- Both tools scoped to the `coder` role
- System prompt updated with commit tools in tool list and workflow (step 9)

### Files
- `js/tools/commit-tools.js` — new module with `commit_files` and `list_dirty_files`
- `js/app.js` — imports commit-tools for self-registration
- `js/llm.js` — system prompt additions

## [0.9.7-2] - 2026-02-11

### Changed
- **System prompt now promotes `find_relevant_files`** — LLMs were ignoring semantic search because the prompt never mentioned it:
  - Added to tool list with "PREFERRED for discovery" annotation
  - Workflow step 3 (before grep) with strong guidance on when to use it vs `search_in_files`
  - Efficiency rules updated: "DON'T know which files → find_relevant_files FIRST"
  - Conditional context injected at end of prompt: when embeddings index is active, tells the LLM exactly how many files are indexed and that natural language queries work
- This should cause LLMs to actually fire `find_relevant_files` during exploration, which in turn increments the query counters visible in the Storage tab

### Files
- `js/llm.js` — system prompt updates + imports `ContextManager` for stats injection

## [0.9.7-1] - 2026-02-11

### Added
- **Embeddings usage tracking** — `ContextManager.findRelevantFiles()` now records `queryCount` and `lastQueried` timestamps, persisted to the index metadata in localStorage
- **Enriched embeddings detail in Storage tab** — each embedding index now shows:
  - File count, build age (relative time), last queried time
  - Color-coded usage badges: red "unused", yellow "< 5 queries", green "5+ queries"
  - Individual size bars per index
- Storage Details section now splits embeddings (card view with stats) from other items (compact list)

### Changed
- `ContextManager.getStats()` now includes `queryCount` and `lastQueried`
- Index metadata format extended with `queryCount` and `lastQueried` fields (backward-compatible)
- Query stats reset on full re-index (new vectors = new tracking baseline)

## [0.9.7] - 2026-02-11

### Added
- **Storage Metrics tab** in Settings — live dashboard showing browser storage usage:
  - **Origin quota** bar using `navigator.storage.estimate()` (localStorage + IndexedDB + Cache Storage)
  - **Category breakdown** with stacked color bar: Chat History, Drafts, Settings, Model Cache, Embeddings, UI State, Other
  - **Per-key drill-down** — top 20 largest items with size bars and monospace key names
  - **Cleanup actions** — per-category clear buttons (Chat, Drafts, Embeddings, Model Cache) with confirmation dialogs
  - All metrics render live when tab activates, re-render after cleanup

### Files
- `js/storage-metrics.js` — new module (measurement, aggregation, rendering)
- `html/settings-tabs.html` — Storage tab HTML skeleton
- `html/modals.html` — Storage tab button in tab bar
- `js/settings-manager.js` — imports and wires `renderStorageMetrics()` on tab switch

## [0.9.6] - 2026-02-11

### Added
- **CI status polling in PR detail modal** — When a PR is open and CI is in a non-terminal state (pending/unknown), polls `getCommitStatus` every 10 seconds. Badge updates live in both the modal and the sidebar PR list. Polling stops automatically when CI reaches success/failure/error or when the modal is closed.
- **Collapsible comments in issue and PR detail modals** — Comments now render as `<details>` elements with chevron indicators. First comment open by default, rest collapsed. "Expand All / Collapse All" toggle button appears when 2+ comments exist. Each comment shows a text preview snippet in the collapsed header. Scrollable container capped at 400px (issues) / uncapped (PRs).
- All comments are now shown in the issue detail modal (previously capped at last 5).

### Changed
- PR detail modal CI badge now has `.pr-ci-live` class for targeted live updates without re-rendering the full meta bar.

## [0.9.5-3] - 2026-02-11

### Fixed
- **Branch list not refreshing after merge** — After merging a PR (especially with "delete branch" checked), the branch dropdown still showed the deleted branch. Added `refreshBranches()` that re-fetches the branch list and updates the selector. If the current branch was deleted, automatically switches to the repo's default branch.
- **`branches:refresh` EventBus event was a no-op** — The LLM tool `merge_pull_request` emitted this event but nothing listened for it. Now wired to `refreshBranches()` alongside the existing `issues:refresh` and `prs:refresh` listeners.

### Changed
- Removed redundant branch-switch logic from the merge handler — `refreshBranches()` handles the "current branch was deleted" case with proper select dropdown sync.

## [0.9.5-2] - 2026-02-11

### Added
- **OpenRouter Billing Plugin** (`plugins/openrouter-billing.js`) — full billing dashboard using the same API key configured in LLM settings (no separate key required). Two-tier design:
  - **Regular API key**: Shows all-time/daily/weekly/monthly usage from `/api/v1/key`, key credit limit progress bar. Balance and per-model breakdown show "—" with a tip linking to provisioning key docs.
  - **Provisioning key**: Unlocks real account balance from `/api/v1/credits`, per-model per-day activity breakdown from `/api/v1/activity` with token counts (prompt/completion/reasoning), cost bars, provider attribution on hover, and day navigation (30 days back).
  - Day picker with ◀/▶ navigation, 🔄 refresh, session caching per day key.
  - Auto-detects key type on first fetch — no config needed.
- **`defaultEnabled` support in plugin manifest** — plugins can set `defaultEnabled: false` to register disabled. Only activates when the user explicitly enables in Settings → Plugins.

### Changed
- **Venice Billing and OpenRouter Billing plugins now default to OFF** — billing dashboards are opt-in via Settings → Plugins toggle.

## [0.9.5-1] - 2026-02-11

### Fixed
- **OpenRouter balance showing $40 instead of real balance** — Root cause: `limit_remaining` from `/api/v1/key` is the **API key's spending cap**, not the account balance. If a key has a $40 limit, it shows "$40 remaining" regardless of actual account credits. Fix: try `/api/v1/credits` first (returns real `total_credits - total_usage`); fall back to `/api/v1/key` with corrected labeling that shows usage stats instead of misleading "remaining" figure. Also reverted the `/auth/key` endpoint change from 0.9.5 — the original `/key` was correct per OpenRouter docs.

### Changed
- Cost tracker header now shows provider tooltip on hover with detailed breakdown (all-time, monthly, daily usage; key limit if set)
- Balance display falls back to `label` text when `usd` is null (OpenRouter /key fallback path)

## [0.9.5] - 2026-02-11

### Fixed
- **OpenRouter balance showing wrong/null** — Was hitting `/api/v1/key` (non-existent). Corrected to `/api/v1/auth/key` per OpenRouter API docs.
- **GitLab (and all providers) "Test" button broken** — `GitProviderRegistry.testConnection()` was called in the connection editor but never implemented. Added `testConnection` to the base provider (hits `GET /user` endpoint), registry method that creates a temporary connection object and delegates to the provider. Works for Gitea, GitHub, and GitLab without per-provider overrides since all three return `login` or `username` from their user endpoint.

## [0.9.4] - 2026-02-11

### Fixed
- **Chat history localStorage quota exceeded** — `ChatSummarizer` generated summaries but never pruned `State.chatHistory`. The in-memory array grew unbounded, causing `QuotaExceededError` on every save. Fixed with a prune→stash→flush lifecycle: summary generates, old messages splice out and stash for one-query undo, then flush permanently on the next user input.
- **Stash save order-of-operations** — Pruned messages couldn't be stashed because the old (large) chatHistory was still in localStorage, leaving no room. Fixed by removing the old key before writing the smaller array, freeing space for the stash write.
- **Invisible summary notification** — Summary badge rendered at `chatContainer.firstChild` but user was scrolled to bottom. Added toast notifications on prune and undo events.
- **Commit message generation returning empty** — Non-streaming `LLM.chat` applied `stripThinkBlocks` before returning. Models that wrap short utility responses in `<think>` blocks (e.g., minimax-m21) had their commit messages nuked to empty string. Added `skipThinkStrip` option and `rawContent` field to the response; `generateCommitMessage` now handles think blocks locally with fallback extraction.
- **JS-generated buttons missing `type="button"`** — 3 buttons in file-tree, chat messages, and plugin settings defaulted to `type="submit"`.

### Changed
- **Venice Billing Plugin v2** — Complete rewrite: fetches all pages in parallel batches (was capped at 5 pages, missing 73%+ of data), day picker for 24hr totals navigable 30 days back, paginated transaction log, fixed model name extraction for cache SKUs, filtered non-inference entries from totals.
- **README rewrite** — Updated to reflect current state: GitHub + GitLab providers documented, project structure updated (settings/, git-providers/, accessibility.js, etc.), deployment guide with BASE_PATH multi-environment docs, CI/CD pipeline reference, provider comparison table removed from "Future Enhancements".
- **CHANGELOG catch-up** — Added missing entries for 0.8.6 through 0.9.3.

## [0.9.3] - 2026-02-11

### Added
- **Accessibility module** (`js/accessibility.js`) — Comprehensive keyboard navigation and screen reader support:
  - Modal focus trapping with Tab/Shift+Tab cycling and previous-focus restoration on close
  - File tree arrow key navigation: Up/Down to move, Right to expand directory, Left to collapse/go to parent, Enter/Space to open file or toggle directory
  - Editor tab arrow key navigation with Home/End support
  - Settings tab keyboard navigation
  - ARIA roles and labels across all interactive elements
  - `MutationObserver`-based modal watcher for automatic focus management
- 114 `aria-*` attributes and 49 `role` attributes added across HTML templates
- 26 `tabindex` attributes for keyboard-focusable elements

## [0.9.2] - 2026-02-11

### Fixed
- **PR merge button silent failure** — `confirm()` dialogs can be suppressed by browsers in modal contexts. Replaced with inline confirmation: first click turns button red with "⚠️ Confirm squash?", second click merges, auto-resets after 3 seconds. All three providers now pass `head_commit_id`/`sha` to the merge API. Error handling upgraded from `alert()` to `showToast()`.

### Added
- **AI-generated PR review comments** — "Add Comment" section in PR detail modal with ✨ Generate with AI button. Analyzes PR title, description, diffs, and existing comments, writes a code review comment using the commit model. Post button submits via provider API and refreshes comments inline.

## [0.9.1] - 2026-02-11

### Changed
- **Settings manager split** — Refactored 1,753-line `settings-manager.js` monolith into 7 focused modules:
  - `settings-manager.js` (298 lines) — Orchestrator: open/close, tab switching
  - `settings/persistence.js` (287 lines) — DOM→State collection, export/import (backend swap target for switchboard)
  - `settings/llm-tab.js` (402 lines) — Provider settings, advanced params, sliders
  - `settings/connections-tab.js` (276 lines) — Git connection CRUD
  - `settings/models-tab.js` (301 lines) — Model browser, fetch, capabilities
  - `settings/plugins-tab.js` (125 lines) — Plugin config UI
  - `settings/roles-tab.js` (88 lines) — Role cards + tool list
- External API surface unchanged; no circular dependencies

## [0.9.0] - 2026-02-11

### Added
- **Runtime BASE_PATH** — Container accepts `BASE_PATH` environment variable for sub-path deployment. `docker-entrypoint.sh` generates nginx config from `nginx.conf.template` via `envsubst` at startup. Supports root (`/`), sub-path (`/editor`, `/test`, `/dev`), and arbitrary prefixes.
- **CI/CD pipeline** (`.gitea/workflows/ci.yaml`) — Three-environment deployment:
  - PR opened/synced → build `:dev` → deploy `ai-editor-dev` with `BASE_PATH=/dev`
  - Push to main → build `:test` → deploy `ai-editor-test` with `BASE_PATH=/test`
  - Tag `v*` → build `:latest` + `:vX.Y.Z` → deploy `ai-editor` with `BASE_PATH=/`
  - Concurrency groups prevent duplicate builds
- `docker-entrypoint.sh` and `nginx.conf.template` — New files for runtime config generation

### Changed
- All hardcoded `editor/` path prefixes in `index.html`, `template-loader.js`, `search-manager.js` converted to `./` relative paths. App is now truly path-agnostic.
- Removed Traefik `stripPrefix` middleware dependency from deployment

## [0.8.7] - 2025-02-10

### Added
- **Full PR workflow — never leave the editor**:
  - **Create PR**: ➕ button in PR panel header. Auto-populates title from branch name (e.g., `issue/42-fix-bug` → "Fix bug (#42)"), branch selectors pre-filled.
  - **Review PR**: Click any PR → full detail modal with state/CI/mergeable badges, markdown description, changed files with expandable inline diffs (syntax-colored), and all comments rendered as markdown.
  - **Merge PR**: Strategy picker (squash/merge/rebase), "delete branch" checkbox, auto-switches to main if you delete the branch you're on.
- **Provider methods**: `addPullRequestComment()`, `mergePullRequest()` — implemented on Gitea, GitHub, and GitLab with normalized return shapes
- **`merge_pull_request` LLM tool** — strategy, title, message, delete_branch params
- PR detail modal is resizable

## [0.8.6] - 2025-02-10

### Added
- **Plugin infrastructure**:
  - Settings → Plugins tab with connection-card-style UI (icon, name, status dot, ⚙️ config expand, ✅/⬜ toggle)
  - Plugin button/modal registration API via SlotManager
  - `beforeFetchIssues` / `resolveIssueConnection` hooks in Git facade for cross-repo routing
- **Cross-repo issues plugin** (`plugins/cross-repo-issues.js`) — Route issues from a GitHub connection to a Gitea working repo. Entire issue pipeline (sidebar, focus bar, triage, LLM tools) works against the mapped connection.
- **Venice billing plugin** (`plugins/venice-billing.js`) — Opens modal via plugin toolbar, calls Venice billing-usage endpoint, renders cost breakdown. Requires admin API key.
- **Markdown rendering in issues** — Issue bodies and comments in the detail modal and focus bar now render through `marked` + `DOMPurify` using the existing `preview-markdown` class. Full support for code blocks, blockquotes, links, images, headings.
- **Resizable modals** — New `.modal-resizable` class with CSS `resize: both`, min/max constraints, flex body that fills available space. Applied to issue detail and plugin modals.

### Fixed
- Rogue plugin modal visible on page load (used `class="modal"` instead of `class="modal-overlay"`)
- Removed 300-char truncation on issue comments — full markdown renders with scroll overflow


## [0.8.5] - 2025-02-10

### Added
- **Conversational Issue Triage** — click any issue in the sidebar to focus it in the chat panel for LLM-assisted review
  - **Issue Focus Bar**: Rendered at the top of the chat panel showing title, state, labels, assignees, description, and last 3 comments
  - **Rich LLM context injection**: Full issue body, labels, assignees, and up to 5 comments injected into the system prompt so the LLM can find relevant code, assess impact, and suggest approaches
  - **Quick actions**: Accept (comments, keeps open), Deny (comments + closes), Comment (adds note), Start Work (creates branch via existing workflow)
  - **Expand button** (📄): Opens the full issue detail modal for additional info
  - **Dismiss button** (✕): Returns chat to normal mode, clears focused state
  - **Sidebar highlight**: Focused issue gets purple left-border highlight (distinct from blue active-work highlight)
  - **Chat integration**: System message announces focused issue, input placeholder updates to triage-specific hint
  - `State.focusedIssue` — new state field, separate from `State.currentIssue` (active work branch)
  - EventBus events: `issue:focused`, `issue:unfocused`

### Changed
- Issue sidebar items now focus in chat (single click) instead of opening the modal directly
  - Modal still accessible via expand button in the focus bar
- System prompt now includes two distinct issue contexts:
  - `ACTIVE ISSUE` — when on a work branch for an issue (existing behavior)
  - `FOCUSED ISSUE (TRIAGE MODE)` — when reviewing/discussing an issue in chat (new)

### Workflow
1. Third party creates an issue/ticket
2. Click the issue in the left sidebar → focus bar appears at top of chat
3. Discuss with the LLM: "What code is relevant to this?", "Is this a valid bug?", "How complex is this?"
4. LLM uses search_project, read_file, scan tools to find and reference actual code
5. Accept → posts ✅ comment | Deny → posts ❌ comment + closes | Comment → posts note | Start Work → creates branch

## [0.8.4] - 2025-02-10

### Added
- **GitLab Provider** (`js/git-providers/gitlab.js`): Third git provider, completes the trifecta (Gitea, GitHub, GitLab)
  - Auth: `PRIVATE-TOKEN` header
  - API v4 with URL-encoded `owner/repo` project identifiers
  - Full recursive tree API with pagination (capped at 10K items)
  - **Atomic batch commits**: Uses GitLab's Commits API for multi-file operations in a single commit (unlike GitHub/Gitea's sequential approach), falls back to sequential on failure
  - **MR terminology mapping**: `source_branch`/`target_branch` → `head`/`base`, `iid` → `number`, `opened` → `open`, `description` → `body`
  - **Rename via Commits API**: Atomic delete + create in one commit (no intermediate state)
  - **CI status**: Commit statuses API with pipeline fallback — fetches latest pipeline + jobs when commit statuses are empty (common with GitLab CI)
  - Issue comments filter out system-generated notes automatically
  - MR comments distinguish inline (position-based) from general notes
  - Labels handled as comma-separated strings (GitLab convention)
  - Settings: URL field (defaults to `https://gitlab.com`) + PAT token (`glpat-xxx`)
  - Self-hosted GitLab: any URL works, `/api/v4` appended automatically
- Registered in `js/git-providers/index.js` — previously a placeholder comment

### Provider comparison
| Feature | Gitea | GitHub | GitLab |
|---------|-------|--------|--------|
| Auth | `token` | `Bearer` | `PRIVATE-TOKEN` |
| Tree | walk dirs | `git/trees?recursive` | `tree?recursive` + paginate |
| Batch | sequential | sequential | atomic Commits API |
| CI | commit status | status + check-runs | commit status + pipelines |
| File path | path segment | path segment | URL-encoded |
| MR naming | `head`/`base` | `head`/`base` | `source_branch`/`target_branch` |

## [0.8.3-2] - 2025-02-10

### Added
- **`read_pull_request` tool**: LLMs can now read full PR details — description, per-file diffs, CI status, and all comments (review + general) in a single call. Patches auto-truncated at ~8K chars to stay within tool result limits. Available to all roles.
- **`add_pr_review` tool**: Post review feedback on a PR as a general comment. Available to reviewer, coder, and pm roles. Triggers sidebar PR refresh.
- **`get_ci_status` tool**: Check CI/CD pipeline status for any branch or commit SHA. Defaults to current branch. Available to all roles.
- **Provider methods**: `getPullRequest()`, `getPullRequestFiles()`, `getPullRequestComments()`, `addPullRequestComment()` — implemented on both GitHub and Gitea providers with normalized return shapes
- **Git facade**: Five new methods wiring provider PR operations to the tool layer

### Changed
- **PR tools now enable full review loop**: Coder creates PR → Reviewer reads diff + CI → Reviewer posts feedback → Coder resolves → repeat
- Tool count: 25 → 28

## [0.8.3-1] - 2025-02-10

### Changed
- **Sidebar: Workflows → Pull Requests**: Replaced the Workflows panel with a PR panel showing CI status
  - Branch-contextual: on default branch shows all open PRs, on feature branch shows only that branch's PRs
  - Each PR displays CI status badge (✅ success, 🔄 pending, ❌ failure, ⚪ unknown)
  - CI status fetched in parallel from combined commit status API
  - Re-renders automatically on branch switch

### Added
- **`getCommitStatus()`**: New provider method on both GitHub and Gitea
  - GitHub: tries `/commits/{ref}/status` first, falls back to `/commits/{ref}/check-runs` (Actions use checks API)
  - Gitea: uses `/commits/{ref}/status`
  - Returns normalized `{ state, total, statuses[] }` shape
- **`State.pullRequests`**: New state property for cached PR data with CI annotations

### Fixed
- Settings toggle renamed from "Show Workflows" to "Show Pull Requests" with matching state key

## [0.8.3] - 2025-02-10

### Added
- **GitHub Provider**: Full GitHub.com support as second git provider implementation
  - All repository, branch, file, issue, PR, and Actions operations
  - `Bearer` token auth with `X-GitHub-Api-Version` header
  - Efficient `git/trees?recursive=true` for file tree (single request vs directory walking)
  - Automatic fallback to contents-walk for repos exceeding git/trees limit
  - Rate limit detection with reset time in error messages
  - GitHub Actions workflow run listing
  - `fixedUrl` set to `https://api.github.com` — no URL field needed in connection settings
  - GitHub Enterprise support via `getBaseUrl()` (auto-appends `/api/v3`)
  - Filters PRs from issues endpoint (GitHub returns both)
  - Strips RFC 2045 newlines from base64 file content

### Fixed
- **Dead event listeners**: `secondary-pane.js` was listening for `gitea:saved`/`gitea:batchSaved` events that were never emitted after provider migration; updated to `git:fileUpdated`/`git:batchCommitted`
- **Tool error handling (0.8.2-5 rework)**: Moved error handling to source instead of downstream hacks
  - `ToolRegistry.execute()` now catches all errors with typed recovery hints (404/403/409/422/timeout)
  - Guarantees non-null, non-empty tool results — LLM always gets actionable feedback
  - `executeToolCall()` catches malformed JSON arguments separately
  - Tool result serialization guards against `"null"`/`"undefined"` content
  - Removed over-engineered 3-pass orphan detection from `sanitizeMessages()`

## [0.8.2] - 2025-02-10

### Added

- **Zip Upload**: Upload entire zip files to the repository from the sidebar.
  - 📦 button in Files header opens the upload modal
  - Drag-and-drop or click to select a `.zip` file
  - JSZip extracts in-browser — no backend needed
  - File preview with checkboxes for selective upload
  - Auto-strips common single-directory prefix (e.g., `project-v1/`)
  - Detects existing files via SHA lookup for create vs. update
  - Target directory field for uploading into subdirectories
  - Progress bar with per-file status tracking
  - Binary files detected and excluded by default
  - Select all / Select none controls
  - File tree auto-refreshes on completion

### Changed

- **Vendor bundle**: Added JSZip 3.10.1 (~25KB minified) with CDN fallback
  for air-gapped deployments.

## [0.8.1-2] - 2025-02-10

### Fixed

- **Import error**: `handlers.js` imported `escapeHtml` from `messages.js`
  where it was no longer exported (moved to `utils/html.js` in 0.8.1).
  Removed the unused import.

## [0.8.1-1] - 2025-02-10

### Fixed

- **Dockerfile build failure**: Inline heredoc (`<< 'NGINX'`) requires BuildKit
  `dockerfile:1.4+` syntax, which Gitea Actions runners don't support by default.
  Extracted nginx config to standalone `nginx.conf` file and use `COPY` instead.
- Clean up `nginx.conf` from served files in final image.

## [0.8.1] - 2025-02-10

### Security

- **XSS sanitization pass**: All `innerHTML` paths now escape external data (file names,
  branch names, connection IDs, workflow data, error metadata) via shared `escapeHtml` /
  `escapeAttr` utilities. Previously, malicious repository names, branch names, or Git API
  responses could inject and execute arbitrary scripts.
- **SVG preview sandboxed**: SVG files rendered in the preview pane now pass through
  DOMPurify (if available) or fall back to a `sandbox=""` iframe with no script execution.
- **Consolidated escape functions**: Six duplicate `escapeHtml` implementations across the
  codebase replaced with a single source of truth in `js/utils/html.js`.

**Files modified for XSS fixes:**
  `file-tree.js`, `tab-manager.js`, `project-manager.js`, `ui-helpers.js`,
  `settings-manager.js`, `error-logger.js`, `model-manager.js`, `secondary-pane.js`,
  `chat/messages.js`, `diff-viewer.js`, `quick-open.js`, `search-panel.js`

### Added

- **Resizable preview pane**: Drag handle between editor and preview/diff pane allows
  resizing. Width persists to localStorage across sessions.
- **Preview fullscreen toggle**: Button in secondary pane header (⛶) toggles fullscreen
  mode, hiding the editor and giving the preview/diff the full width.
- **Shared HTML utilities module** (`js/utils/html.js`): Canonical `escapeHtml()` and
  `escapeAttr()` for all HTML construction.

### Changed

- **Dockerfile: python → nginx**: Production image switched from `python3 -m http.server`
  to `nginx:1-alpine`. Adds gzip compression, proper cache headers (immutable for vendor
  bundles, no-cache for app files), and security headers (X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy). Image is smaller and significantly faster.

### Fixed

- Preview pane `.ext` indicator was not escaped (minor XSS in file extension display).
- Connection card `providerName` was not escaped in settings UI.

---

## [0.8.0-1] - Previous Release

Initial 0.8.x series release. See README for full feature list.
