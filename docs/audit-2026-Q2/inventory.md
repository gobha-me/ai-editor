# Code Audit Inventory — 2026 Q2

> Living document. Drop in: refactor candidates flagged during the 2026-Q2 audit pass. Strike through items as they're resolved; the queue closes when fewer than ~5 entries remain that survive triage.
>
> Started: 2026-05-11 (post-2.23.0 SlotManager migration).
>
> Categories: **HC** hardcode wall · **EV** missing event wiring · **DUP** duplicate implementation · **REG** should-be-registered isn't · **ST** style drift.

## Triage policy

- Each entry gets a size estimate: **S** (single PR, <100 LOC), **M** (multi-PR sequence, <500 LOC), **L** (architectural — design doc + multi-minor).
- Each entry names the **system bucket** it belongs to (sidebar / chat / settings / git-providers / preview / retrieval / compression / tools / etc.) so we can audit one system at a time.
- Touch-points are listed: if fixing X requires also fixing Y, both rows cross-reference each other.
- Confidence tag: **likely**, **needs-investigation**, **maybe-intentional**.

## System buckets

- **sidebar/rail** — left-pane rail, file tree, issues panel, PR panel, branch panel
- **chat** — message rendering, tool loop, queue, conversation management
- **tools** — tool registry, tool classifications, hardcoded tool sets
- **git-providers** — gitea/github/gitlab/local providers, registry, contributions manifest
- **slot-manager** — declarative UI extension renderer
- **events** — EventBus channels (orphan emits / subscribers)
- **plumbing/storage** — Storage module discipline, localStorage usage
- **settings** — settings tabs, persistence, migration
- **app-boot** — `js/app.js` safeAdd pattern + init sequencing
- **prompts** — system prompt assembly, tool enumeration
- **profiles** — profile registry, role tags, migration
- **editor** — CodeMirror integration, editor instance, line-edit events
- **preview** — preview-host, preview tools, classification sets
- **help** — hotkey-registry, help slide-out
- **html-shell** — top-level HTML templates with inline onclick handlers

## Entries

---

### sidebar/rail

#### [HC] [S] [likely] `closeAllModals` enumerates magic selectors instead of registry
- **What:** `js/ui-helpers.js:87-91` walks `.modal-overlay` plus two known IDs (`quickOpenOverlay`, `searchPanel`) by hand. Each new modal layer (Merge Conflict, PR Review) needs an explicit `.active` toggle elsewhere.
- **Why it's load-bearing:** Modal layering already escaped the `closeAllModals` net once (`isMergeConflictActive`/`isPrReviewActive` are checked separately in `js/app.js:463-471`). The next overlay class will silently drop out of Esc-to-close.
- **Suggested fix shape:** Either a `ModalRegistry` (overlays register their close fn + z-priority) or extend `closeAllModals` to delegate to subscribers via an event channel.
- **Touch points:** `js/app.js:445-472` (popstate + Esc handler also hardcodes the layering), `js/pr-review/pr-review-mount.js`, `js/merge-conflict/merge-conflict-mount.js`.

#### [REG] [M] [likely] Git-provider `panels` manifest still flat-slot, not rail-views
- **What:** Every git provider (`js/git-providers/gitea.js:1177-1197`, `github.js:1199-1219`, `gitlab.js:~1170`) declares `panels: [{slot: 'sidebar-panels', ...}]` with no `render` and no `view:` shape. `local.js:278` has empty arrays.
- **Why it's load-bearing:** Per the 2.22.0/2.23.0 decision, rail-views is the structured slot; the 6 declarations are dead metadata. The intended migration is to flip these to `slot: 'rail-views'` with `view: {id, label, icon, badge, priority}` so providers can ship their own rail views (e.g. GitHub Actions panel, GitLab Pipelines panel) without core code changes.
- **Suggested fix shape:** Change each provider's panels to `{slot: 'rail-views', view: {id, label, icon}, render}` and confirm `applyProviderContributions` in `js/slot-manager.js:238-256` already pipes them through. The current code path silently skips render-less entries.
- **Touch points:** `js/slot-manager.js:243-246` (the `!isStructured && p.render == null` skip), `docs/DESIGN-git-providers-and-ui-extensions.md` §4 decisions table.

#### ~~[ST] [S] [likely] Sidebar uses static `[data-rail-view-container]` blocks while rail v2 wants dynamic~~ *(✅ closed — shipped 2.24.0)*
- **What:** `js/ui/left-pane-rail.js` Module-header documents the transitional state — static blocks in `html/sidebar.html` are preferred for the 4 built-ins (files / issues / prs / branches), the `render` callbacks are no-op stubs. Dynamic creation only runs for contributions without a static container.
- **Why it's load-bearing:** This is the explicit "follow-on minor" callout. The mixed mode means a future provider rail contribution renders differently from a built-in. Once the four built-ins move to `render(body)` and the static blocks delete, the entire body path is dynamic and consistent.
- **Suggested fix shape:** Move `renderFileTree`/`renderIssues`/`renderPullRequests`/`renderBranchPanel` into the `render(body)` callbacks of `BUILTIN_VIEWS` (`js/ui/left-pane-rail.js:76-121`); delete the four static blocks from `html/sidebar.html`.
- **Touch points:** `js/file-tree.js`, `js/project-manager.js` (renderIssues/renderPullRequests), `js/ui/branch-panel.js`.
- **Resolution:** 2.24.0 shipped end-to-end body migration. `view.headerActions` declarative shape extension covers per-view header buttons; four static blocks deleted from `html/sidebar.html`; `BUILTIN_VIEWS` `render(body)` invokes the imperative renderers. See [CHANGELOG §2.24.0](../../CHANGELOG.md).

#### ~~[EV] [S] [likely] Issues count badge: `issuesPanel` count text rebuilt in two places~~ *(✅ closed — shipped 2.24.0)*
- **What:** `js/project-manager.js:451-456` rebuilds the `▾ Issues (N)` text directly on `[data-collapse="issuesPanelBody"] span`. The new rail-views badge in `js/ui/left-pane-rail.js` calls `view.badge()` which reads `State.issues.length`. Both rerun on `issues:render`, but the inline header text bypasses the rail entirely.
- **Why it's load-bearing:** The legacy stacked sidebar header still gets a count text update even though the rail is now the visible chrome. Dead pixels but the parallel update obscures the single source of truth.
- **Suggested fix shape:** Either keep the legacy header as truly hidden (CSS hide; rail is the visible UI) or remove the count-text rebuild and let the rail-badge be authoritative.
- **Touch points:** `js/ui/left-pane-rail.js`, `js/project-manager.js:447-471`.
- **Resolution:** 2.24.0 dropped the parallel count-text rebuild from `renderIssues` — the legacy stacked-sidebar header element no longer exists after the static block deletes. Rail badge is the single source of truth.

---

### chat

#### ~~[DUP] [M] [likely] `WRITE_TOOLS` exists twice with different memberships~~ *(✅ closed — shipped 2.25.0)*
- **What:** `js/chat/tool-classifications.js:49-53` exports `WRITE_TOOLS` (9 tools — for dup-cache short-circuit). `js/chat/turn-enrich.js:35-40` defines a local module-level `WRITE_TOOLS` (4 tools — for FileOp metadata).
- **Why it's load-bearing:** Same name, two completely different sets. A developer who edits one and thinks they covered both creates a silent classification drift. The semantics are distinct ("don't cache-skip" vs "wholesale-write FileOps") — the second should be renamed `WHOLE_FILE_WRITE_TOOLS` or moved into `tool-classifications.js` with its own export name.
- **Suggested fix shape:** Rename `turn-enrich.js`'s set to `WHOLE_FILE_OPS` and import it from `tool-classifications.js`. Keep the per-axis frozen exports adjacent so future maintainers see the distinctions next to each other.
- **Touch points:** `js/chat/tool-classifications.js`, `js/chat/turn-enrich.js:35-40`.
- **Resolution:** 2.25.0 added `WHOLE_FILE_WRITE_TOOLS` to `tool-classifications.js` (frozen array, 4 members); `turn-enrich.js` imports it. Co-located JSDoc points at the WRITE_TOOLS adjacency so future maintainers see both. A new disjointness test asserts every WHOLE_FILE_WRITE_TOOLS member is classified in either WRITE_TOOLS (skip-cache) or MUTATING_TOOLS (envelope). See [CHANGELOG §2.25.0](../../CHANGELOG.md).

#### ~~[DUP] [M] [likely] Inline `MUTATING_TOOLS` / `STATEFUL_READ_TOOLS` in handlers.js fork the classification list~~ *(✅ closed — shipped 2.25.0)*
- **What:** `js/chat/handlers.js:609-637` declares two inline `new Set([...])` lists — `MUTATING_TOOLS` (10 tools, for refusal-envelope messaging) and `STATEFUL_READ_TOOLS` (2 tools, for cache-key skip). These live inside `executeToolLoop`, so they're recreated on every loop iteration and untouched by `tool-classifications.js`.
- **Why it's load-bearing:** The header doc in `tool-classifications.js:31-37` says these were "deliberately NOT hoisted" because the axis is distinct. But that's load-bearing only if every new tool gets considered against ALL classification axes — and the inline location guarantees that future tool additions will miss one or two.
- **Suggested fix shape:** Hoist all four sets to `tool-classifications.js` with separate names and clear axis-docs. Even if they don't share members, co-locating the lists makes the classification matrix scannable.
- **Touch points:** `js/chat/handlers.js:609-637`, `js/chat/tool-classifications.js`.
- **Resolution:** 2.25.0 hoisted both sets (+ LONG_RUNNING_TOOLS, USER_PAUSE_TOOLS — see entry below) as frozen-array exports with co-located axis JSDoc. The "deliberately NOT hoisted" rationale at `tool-classifications.js:31-37` was inverted: developer-scan cost beats axis-encapsulation when the inline location is the recurring source of "missed an axis" bugs (per `feedback_prompts_js_parallel_enumeration.md`). Disjointness asserted in `tests/test-tool-classifications.mjs` — `WRITE_TOOLS ∩ MUTATING_TOOLS = ∅`, `STATEFUL_READ_TOOLS ∩ WRITE_TOOLS = ∅`.

#### [HC] [M] [likely] `LEGACY_TOOL_ENUMERATION` in `prompts.js` enumerates ~25 tool names
- **What:** `js/prompts.js:33-56` is a string with ~25 bullet-formatted tool names + descriptions. Used when `?toolsCompose=off` or when the active profile has no Composer (per `feedback_prompts_js_parallel_enumeration.md`).
- **Why it's load-bearing:** This is the explicit parallel enumeration the feedback note warns about. The Tier 3a preview tools (2.10.0), CI tools (1.4.5), git_log (1.5.x), and the LLM-authored automation (1.16.0) all added tools without updating this list, so the legacy path tells the model fewer capabilities exist than actually do.
- **Suggested fix shape:** Make the legacy path call the same `renderToolEnumeration` against the full ToolRegistry definitions instead of a hardcoded string. The only reason it doesn't today is the "include tools the model can't invoke" risk — but the legacy path runs for chat-only profiles where the filter would still produce a coherent list.
- **Touch points:** `js/prompts.js:217-230` (call site), `js/tools/registry.js`, `js/profiles/*.js`.

#### ~~[EV] [S] [likely] `tabs:render` emitted but no subscriber~~ *(✅ closed — shipped 2.24.1)*
- **What:** `js/tools/commit-tools.js:83` emits `EventBus.emit('tabs:render')` after a commit. No `EventBus.on('tabs:render', ...)` anywhere in the codebase.
- **Why it's load-bearing:** Authors thought there was a tab-rendering listener. The intended effect (re-render tabs to clear the dirty dot after commit) is achieved instead because `commitAndPush()` separately calls `renderEditorTabs()`. The orphan emit suggests the wrong wiring or a renamed channel.
- **Suggested fix shape:** Either delete the emit or add a subscriber in `js/tab-manager.js` that calls `renderEditorTabs()`. Decide based on whether tools/commit-tools.js running from LLM-context can otherwise refresh the tabs.
- **Touch points:** `js/tools/commit-tools.js:83`, `js/tab-manager.js`.
- **Resolution:** 2.24.1 deleted the orphan emit. Post-commit tab re-render already runs via `git:batchSaved` → `js/ui-helpers.js` → `renderEditorTabs()`; Now-strip badge through new `tab:contentChanged` from `batchSaveFiles`. See [CHANGELOG §2.24.1](../../CHANGELOG.md).

#### ~~[EV] [S] [likely] `tab:contentChanged` emitted only by search-panel, not by edit tools~~ *(✅ closed — shipped 2.24.1)*
- **What:** `js/search-panel.js:262` emits `tab:contentChanged` after a Search & Replace. Two subscribers (`js/ui/now-strip.js:185`, see also `js/chat/sessions-sync.js`). No emit from `js/tools/edit-tools.js` after `edit_file`/`replace_lines`/`insert_lines`/`delete_lines`.
- **Why it's load-bearing:** Now Strip badge counts dirty tabs; it stales after LLM-driven edits until a different channel happens to fire. `tab:contentChanged` is the right channel — but the only producer is the global Find/Replace path.
- **Suggested fix shape:** Add `EventBus.emit('tab:contentChanged', ...)` in `js/editor/instance.js` alongside the existing `editor:linesReplaced` emit (line ~575), or in `js/tools/edit-tools.js` per-tool after the apply.
- **Touch points:** `js/search-panel.js:262`, `js/ui/now-strip.js:185`, `js/editor/instance.js:575/632/699/753`, `js/tools/edit-tools.js`.
- **Resolution:** 2.24.1 added 8 new emit sites: 5 in `js/editor/instance.js` (alongside `editor:linesReplaced` ×2 / `editor:linesInserted` / `editor:linesDeleted` / `editor:editApplied`), 1 in `js/git.js#batchSaveFiles` per-result, 1 in `js/ui-helpers.js` after the `git:saved` flip, 1 in `js/ui/revert.js#revertAllFiles` per-tab. The audit's `js/chat/sessions-sync.js` subscriber reference was stale — Now-strip is the only subscriber today.

#### [EV] [S] [maybe-intentional] `git:branchCreated` has 3 emitters, 0 subscribers
- **What:** Emitted by every git provider (`js/git-providers/{gitea,github,gitlab}.js`) after a successful `createBranch()`. The parallel channel `branch:created` (singular emit in `js/ui/branch.js:63` + `js/issue-detail.js:693`) has 2 subscribers (`branch-panel.js`, retrieval manager).
- **Why it's load-bearing:** Confusing dual naming. The provider-level event carries `{connectionId, owner, repo, name}`; the UI-level event carries `{sourceBranch, targetBranch}`. They have different payloads, so consumers can't simply switch — but every consumer today wants the UI-level event.
- **Suggested fix shape:** Decide on one channel. Either drop the `git:branchCreated` emit, or add a subscriber bridge that re-emits `branch:created` for downstream simplicity. Same audit for `git:branchDeleted` (3 emitters, 1 subscriber).
- **Touch points:** `js/git-providers/{gitea,github,gitlab}.js`, `js/ui/branch.js`, `js/intelligence/retrieval/manager.js:1205`.

#### [EV] [S] [needs-investigation] `EventBus.emit('toast', ...)` has 1 emit, 0 subscribers
- **What:** `js/intelligence/test-loop/ui.js:137` is the only emit. The rest of the codebase calls `window.showToast(...)` or `showToast(...)` directly.
- **Why it's load-bearing:** The toast contract is split — direct function call vs event-bus emit. A subscriber would need to live in `js/ui-helpers.js`. This is small but the dead emit suggests intent that never landed.
- **Suggested fix shape:** Either route every toast through the event channel (add a subscriber in ui-helpers.js calling showToast), or replace the test-loop emit with a direct showToast call.
- **Touch points:** `js/intelligence/test-loop/ui.js:137`, `js/ui-helpers.js:77-85`.

#### [DUP] [S] [likely] CI status icons defined twice with different shapes
- **What:** `js/ui/pr-list.js:18-24` defines a `CI_ICONS` map (`success/pending/failure/error/unknown` → emoji). `js/pr-review/PrReviewSurface.js:50-54` defines a different `CI_STATUS_*` map (with `{label, cls}` shape for badges).
- **Why it's load-bearing:** Two representations of the same axis. Future status additions (e.g. `cancelled`) need to land in both places. CHANGELOG note for 2.13.0 referenced an inline duplication that was just consolidated into pr-list.js — this is the remaining sibling.
- **Suggested fix shape:** Move to `js/ui/icons.js` as `CI_STATUS_META` with both emoji + class. Have both consumers project the field they need.
- **Touch points:** `js/ui/pr-list.js:18-24`, `js/pr-review/PrReviewSurface.js:50-54`, `js/ui/icons.js`.

---

### tools

#### [HC] [S] [likely] `LEGAL_GROUP_TAGS` in `tools/registry.js:53` mirrors profile names
- **What:** `js/tools/registry.js:53` declares `const LEGAL_GROUP_TAGS = ['all', 'coder', 'pm', 'reviewer', 'plugin-dev', 'full']`. Used to reject typos at tool-register time. The same 5 tags appear in `js/profiles/migration.js:25-31` `ROLE_TO_PROFILE` keys.
- **Why it's load-bearing:** Adding a new profile (`kb` → kb.v1 in 2.8.0) didn't need a new admission tag because the kb profile inherits chat.v1's `allowed_groups`. But the moment a profile wants a tag-named admission group, the registry rejects it. Forces a code change at the wrong layer (tool registry, not profile registry).
- **Suggested fix shape:** Derive the legal set from `Profiles.list()` plus the special `'all'` group, OR add an explicit `Profiles.getKnownGroupTags()` API that the registry consults.
- **Touch points:** `js/tools/registry.js:53/98/102`, `js/profiles/registry.js`, `js/profiles/migration.js:25-31`.

#### ~~[HC] [S] [maybe-intentional] `LONG_RUNNING_TOOLS` + `USER_PAUSE_TOOLS` inline in handlers.js~~ *(✅ closed — shipped 2.25.0)*
- **What:** `js/chat/handlers.js:746` `LONG_RUNNING_TOOLS = new Set(['wait_for_ci'])` and line 758 `USER_PAUSE_TOOLS = new Set(['ask_user', 'submit_plan_for_approval', 'submit_script_for_approval'])`.
- **Why it's load-bearing:** Same problem as `MUTATING_TOOLS` — inline-set-in-function, hard to find when scanning tool classifications. Each new long-running or user-pause tool needs the developer to remember.
- **Suggested fix shape:** Move to `tool-classifications.js` next to the other axes.
- **Touch points:** `js/chat/handlers.js:746,758`, `js/chat/tool-classifications.js`.
- **Resolution:** Bundled into the same 2.25.0 hoist as MUTATING_TOOLS + STATEFUL_READ_TOOLS. Each set now has its own axis-doc JSDoc (timeout axis: tool-loop scheduling) including the watchdog rationale that was previously at the inline call site.

#### [HC] [M] [needs-investigation] Tool-name string-literals dotted around chat module
- **What:** Beyond the classification sets, chat code does case dispatch on tool names: `js/chat/messages.js:725,775` (`case 'read_lines'`), `js/chat/turn-enrich.js:76,86`, `js/chat/tools.js:29` (`'read_lines': ['path', ...]` arg shape map). All consume tool-name strings as keys.
- **Why it's load-bearing:** Tool renames break silently — no compile-time guard. The risk surfaces on the next tool refactor.
- **Suggested fix shape:** Either centralize tool-name constants in `js/tools/registry.js` (export the canonical names) or accept the risk + add a Node test that scans for unknown tool-name string literals.
- **Touch points:** Multiple files — needs verification this is worth fixing vs. just adding a coverage test.

---

### git-providers

#### ~~[HC] [S] [likely] `glyphFor` in `connections-tab.js` hardcodes provider→glyph map~~ *(✅ closed — shipped 2.26.0)*
- **What:** `js/settings/connections-tab.js:18-21` defines `glyphFor(providerId)` with `{github: 'GH', gitea: 'GT', gitlab: 'GL', bitbucket: 'BB', local: 'ZP'}`. Falls back to first-2-chars-uppercased.
- **Why it's load-bearing:** Adding a new provider (e.g. azure-devops, codeberg as a separate provider) requires editing this file. The provider manifest in `js/git-providers/base.js` already has an `icon` field — the glyph is a separate axis.
- **Suggested fix shape:** Add `provider.glyph` (or `provider.shortLabel`) to the manifest in `BASE_GIT_PROVIDER`. Each provider declares its own 2-letter code; `glyphFor` consults the registry.
- **Touch points:** `js/settings/connections-tab.js:18-21`, `js/git-providers/base.js:850`, `js/git-providers/{gitea,github,gitlab,local}.js`.
- **Resolution:** 2.26.0 added `glyph: string` to the `BASE_GIT_PROVIDER` manifest shape and to each registered provider (gitea=GT, github=GH, gitlab=GL, local=ZP). `glyphFor(providerId)` becomes `GitProviderRegistry.get(providerId)?.glyph || first-2-chars-uppercased`. New `tests/test-provider-manifest-glyph.mjs` covers manifest shape + registry round-trip + fallback path. See [CHANGELOG §2.26.0](../../CHANGELOG.md).

#### ~~[REG] [S] [needs-investigation] `bitbucket` listed in glyphFor but no `bitbucketProvider` registered~~ *(✅ closed — shipped 2.26.0)*
- **What:** `glyphFor` includes `bitbucket: 'BB'` but `js/git-providers/index.js` only registers gitea/github/gitlab/local.
- **Why it's load-bearing:** Either intentional future-proofing (a placeholder) or stale dead code. Either way, the registry-mirroring constant is out of sync with the registry.
- **Suggested fix shape:** Delete the bitbucket entry, OR add a stub provider, OR document the placeholder.
- **Touch points:** `js/settings/connections-tab.js:19`, `js/git-providers/index.js`.
- **Resolution:** Closed alongside the parent `glyphFor` entry above. The `bitbucket: 'BB'` row deletes with the rest of the hardcoded map; the first-2-chars-uppercased fallback would render `'BI'` if a `bitbucket` provider were registered without declaring `glyph`, which is the correct forward-compat behavior. No stub provider added — when bitbucket support actually ships, it declares its own `glyph: 'BB'` per the new manifest convention.

---

### slot-manager

#### [ST] [S] [maybe-intentional] `slot:${slotId}:changed` template-literal emit pattern
- **What:** `js/slot-manager.js:159` emits ``EventBus.emit(`slot:${slotId}:changed`)``. The static rail-views path uses the literal `'slot:rail-views:changed'`. Channel-finder tools that grep for `EventBus.emit('...')` (the audit's own diagnostic) miss the dynamic name.
- **Why it's load-bearing:** Channel discovery is one of this audit's primary diagnostics. Template-literal channels evade grep. This is a small style hazard, not a bug — but it argues for an `EVENT_CHANNELS` constants file.
- **Suggested fix shape:** Optional. If we add an `EVENT_CHANNELS` constants file (a likely future fix for orphan-emit hygiene), promote dynamic channel names into a `forSlot(slotId)` helper.
- **Touch points:** `js/slot-manager.js:159`.

---

### plumbing/storage

#### [ST] [M] [likely] `localStorage.setItem/getItem` called directly outside core.js
- **What:** Per `grep -rn "localStorage\." js/`, 14 files outside `core.js` use `localStorage` directly: `js/ui/left-pane-rail.js:176,345`, `js/pr-review/review-state.js:66,77,85,96`, `js/managers/search-manager.js:230,234`, `js/chat/state.js:42,228`, `js/help/platform.js:31,40,41`, `js/embeddings-client.js:101,103,107,454`, `js/intelligence/workspace-settings/file-layer.js:114-ish`.
- **Why it's load-bearing:** `feedback_storage_idb_authoritative.md` says IDB is authoritative; localStorage is best-effort fallback. Each direct localStorage call bypasses the IDB persistence layer — on a quota event, those keys die where Storage-wrapped keys survive.
- **Suggested fix shape:** Migrate each direct call to `Storage.set/get/remove`. Storage already namespace-prefixes (`ai-editor-` + key) and handles JSON. For PR-review drafts (`pr-review/review-state.js`), the keys include `${STORAGE_PREFIX}.drafts.${prNumber}` which is dynamic — Storage supports that fine.
- **Touch points:** Each of the 14 sites; `js/core.js:450` Storage module.

#### [ST] [S] [maybe-intentional] `js/help/platform.js` writes `aiEditorPlatformOverride` directly
- **What:** `js/help/platform.js:31,40,41` reads/writes `aiEditorPlatformOverride` via raw localStorage, not Storage. This is a 2-letter string (`mac` or `win`), small surface.
- **Why it's load-bearing:** Same axis as above but lowest stakes — the override only affects keyboard-shortcut display labels.
- **Suggested fix shape:** Migrate to `Storage.set('platformOverride', plat)`.
- **Touch points:** `js/help/platform.js:31,40,41`.

---

### events

#### [EV] [S] [likely] `editor` channel subscribed but no emitter
- **What:** Per the channel-mismatch diff, the channel `error` is subscribed somewhere but emitted nowhere; `settings:loaded` is subscribed but no emit. (Counter-balance: `settings:saved` is emitted in `js/app.js:784` and `js/settings/persistence.js` but not via EventBus.)
- **Why it's load-bearing:** Probably the wrong channel name was used — subscribers will never fire. Two of the rare-but-known "subscribed without emitter" cases the audit run surfaced.
- **Suggested fix shape:** Read the subscriber to see what it expects. If `settings:loaded` should fire after `loadSettings()` returns, add the emit. Same for `error`.
- **Touch points:** Search for `EventBus.on('error',` and `EventBus.on('settings:loaded',` to find the consumers.

#### [EV] [S] [maybe-intentional] Plugin lifecycle emits with no internal subscribers
- **What:** From the orphan-emits list: `plugin:configChanged`, `plugin:installed`, `plugin:mcpServerRegistered`, `plugin:modalRegistered`, `plugin:uninstalled` are emitted by `js/core.js` Plugins methods but no `EventBus.on(...)` listens internally.
- **Why it's load-bearing:** These are documented as plugin-extension points (per `js/profiles/plugin-dev-v1.js`), so they're for THIRD-PARTY plugin code. The audit's "0 subscribers" check finds them because we grep only `js/`. Mark these as the documented extension API.
- **Suggested fix shape:** No-op — but document a "public EventBus channels" registry so future audits don't re-flag them.
- **Touch points:** `js/core.js` Plugins module emits, `js/profiles/plugin-dev-v1.js` channels list.

#### [EV] [M] [maybe-intentional] `editor:linesReplaced`/`linesInserted`/`linesDeleted` emit without internal subscriber
- **What:** `js/editor/instance.js:575,632,699,753` emit those channels; only `editor:editApplied` has an in-tree subscriber (`js/core.js:1543`, `js/chat/index.js:232`).
- **Why it's load-bearing:** Documented plugin extension point (`plugin-dev-v1.js:154`). Same status as the plugin lifecycle channels — public API.
- **Suggested fix shape:** Confirm in PR notes that these are public extension channels; document them in a single registry.
- **Touch points:** `js/editor/instance.js:575-778`, `js/profiles/plugin-dev-v1.js:154`.

#### [EV] [S] [likely] `git:fileLoaded`, `git:loadingFile`, `git:saving`, `git:folderDeleted`, `git:folderRenamed`, `git:repoCreated`, `git:issueCreated`, `git:issueCommented`, `git:mrCreated`, `git:prMerged`, `git:prReviewSubmitted`, `git:ciRerun`, `git:batchSaving` all emit with 0 internal subscribers
- **What:** Run the channel diff to enumerate.
- **Why it's load-bearing:** A subset are likely "public extension API" (the plugin contract). Others (`git:loadingFile` / `git:saving` / `git:fileLoaded`) look like internal state transitions where someone meant to wire a status indicator but didn't. The `git:issueCreated` / `git:prMerged` set looks like LLM-tool integration points that nothing reads — meaning side effects (refresh issues, refresh prs) happen via direct `refreshIssues()` calls instead of through the channel.
- **Suggested fix shape:** Triage row-by-row: for each emit, decide "internal" (delete emit OR add subscriber) vs "public" (document + leave). Likely 50/50 split.
- **Touch points:** `js/git.js:677-884`, `js/git-providers/*.js`.

#### [EV] [S] [likely] Issues panel header text rebuilt without an event
- **What:** The header text update in `js/project-manager.js:451-456` (`▾ Issues (N)`) only runs when `renderIssues()` is called. `renderIssues()` is called from `refreshIssues()` AND from `EventBus.on('issues:render', renderIssues)` (`project-manager.js:835`). But anything that mutates `State.issues` without calling `renderIssues()` leaves the header stale.
- **Why it's load-bearing:** This is the same "the rail badge bug we just fixed" pattern at a different surface. The rail badge re-renders on `issues:refresh` AND `issues:render`. The legacy header text only re-renders on `issues:render`.
- **Suggested fix shape:** Either delete the legacy header text rebuild (rail badge is the surface now), or subscribe `renderIssues` to `issues:refresh` so both surfaces stay coherent.
- **Touch points:** `js/project-manager.js:451-456,830`, `js/ui/left-pane-rail.js:314-329`.

---

### app-boot

#### [ST] [M] [likely] `safeAdd` pattern + bareword global reference fragility in setupEventListeners
- **What:** `js/app.js:649-777` wires 31 buttons via `safeAdd(id, ...)`. Each call is `getElementById(id)` + `.addEventListener(event, handler)`. If the button isn't in the boot-time DOM, it logs a warning and skips. The 2.23.0 rail migration broke a few buttons this way until verified.
- **Why it's load-bearing:** Any contribution-driven button (a future Plugin button mounted into a SlotManager slot AFTER `init()` runs) is invisible to `safeAdd`. The pattern assumes static DOM. The migration to SlotManager-driven rendering would break every wired button.
- **Suggested fix shape:** Use event delegation on `document` keyed by `data-action="commit"`-style attributes (already used in `js/projects/switcher-menu.js`). Or migrate to a `registerAction(id, handler)` API that handles late binding.
- **Touch points:** `js/app.js:649-777`, `js/project-manager.js:746-880` (also uses a `safeClick` helper).

#### ~~[ST] [S] [likely] `safeAdd('btnHelp', 'click', openHelpModal)` references undefined `openHelpModal`~~ *(✅ closed — shipped 2.26.0)*
- **What:** `js/app.js:664` references the bareword `openHelpModal` which is NOT imported. The reference resolves only because `js/help/index.js:146` sets `window.openHelpModal = openHelpSlideOut` as a module-load side effect, and module-scope bare names resolve via window in non-strict mode.
- **Why it's load-bearing:** Either `'use strict'` will eventually be enabled (it should be — every other module is implicit-strict via ES modules) or the help/index.js load order shifts, and this breaks silently. The fix is one-line.
- **Suggested fix shape:** `import { openHelpSlideOut } from './help/index.js'` and call `openHelpSlideOut`, or use `window.openHelpModal`. ES modules are strict-by-default, so this likely already throws in some browsers — verify.
- **Touch points:** `js/app.js:664`, `js/help/index.js:146`.
- **Resolution:** 2.26.0 replaced the bareword reference with the already-imported `openHelpSlideOut` from `./help/index.js` (line 30 import was already in place; line 660 swapped to it). The `window.openHelpModal` global side-effect at `js/help/index.js:146` stays for any external consumer. See [CHANGELOG §2.26.0](../../CHANGELOG.md).

#### [HC] [S] [likely] Keyboard-shortcut handlers in `setupKeyboardShortcuts` mirror `hotkey-registry.js`
- **What:** `js/app.js:306-489` lists 18 key bindings (Ctrl+S, Ctrl+P, F1, F2, Esc, etc.) inline. `js/help/hotkey-registry.js:33+` lists the same 18+ bindings declaratively for the Help page display.
- **Why it's load-bearing:** Direct parallel enumeration — Files added 2.20.0+ shortcut (Ctrl+Shift+Z revert, e.g.) need to land in both. Comment at `js/app.js:307-309` says: "Keep in sync until the consolidation follow-up makes the registry the single source of truth (1.3.11+)."
- **Suggested fix shape:** Pivot `setupKeyboardShortcuts` to read `HOTKEYS` from the registry and dispatch via `when:`/handler metadata. This was explicitly the 1.3.11+ follow-up that never landed.
- **Touch points:** `js/app.js:306-489`, `js/help/hotkey-registry.js`.

---

### prompts / profiles

#### [HC] [S] [likely] `EditorPrompts.systemPrompt` template carries hardcoded UNTRUSTED markers list
- **What:** `js/prompts.js:163-164` lists `<UNTRUSTED_ISSUE_BODY>`, `<UNTRUSTED_ISSUE_COMMENT>`, `<UNTRUSTED_PR_BODY>`, `<UNTRUSTED_PR_COMMENT>` inline. The same names appear in `js/security/untrusted-wrap.js` as `UNTRUSTED_KINDS`.
- **Why it's load-bearing:** Adding a new untrusted-content surface (e.g. PR review comment, commit message from another author) requires editing both the prompt template and the security wrap. The 1.6.12 PR #296 work added the marker scheme; the enumeration in the prompt was hardcoded.
- **Suggested fix shape:** Render the marker list from `UNTRUSTED_KINDS` at prompt-build time.
- **Touch points:** `js/prompts.js:163-164`, `js/security/untrusted-wrap.js`.

#### [HC] [S] [needs-investigation] Profile addenda hardcoded in `js/profiles/*-v1.js`
- **What:** `kb-v1.js`, `plugin-dev-v1.js` each carry a `systemPrompt` addendum string. The picker-promotion rule is "promote when the profile has its own addendum" per `js/profiles/registry.js:37-43`. Future profiles will follow the same pattern.
- **Why it's load-bearing:** Each addendum is its own constant; if multiple profiles share an addendum fragment, it duplicates. So far, distinct enough not to share.
- **Suggested fix shape:** Punt. Re-evaluate after the next 1-2 profile additions.
- **Touch points:** `js/profiles/kb-v1.js`, `js/profiles/plugin-dev-v1.js`.

---

### html-shell

#### [ST] [L] [likely] 53 inline `onclick="window.foo()"` calls across `html/*.html`
- **What:** `grep -rn 'onclick="' html/` returns 53 matches. The modals (commit, revert, branch, file-create, rename, issue-detail, create-PR, zip-upload, settings) wire their close/submit buttons via inline `onclick="window.closeXxx()"` / `onclick="window.submitXxx()"`. These rely on `window.*` global assignments in `js/app.js:154-267`.
- **Why it's load-bearing:** Every modal-extracted module has to add to the `window.*` exposure block in `app.js`. The pattern is brittle (rename a function → break the inline string, no compile guard) and CSP-unfriendly (inline event handlers trip strict CSP). The hardcoded `window.openIssueTab(${issueNumber})` strings in `js/ui/issue-list.js:87` etc. add row count to the audit.
- **Suggested fix shape:** Convert each modal to event delegation on a single delegation root (`#app` or `body`), with `data-action="closeCommitModal"` attributes. The pattern is already established in `js/projects/switcher-menu.js`.
- **Touch points:** `html/modals.html`, `js/app.js:154-267`, every modal-related module.

#### [ST] [S] [likely] Inline `onclick=` strings inside `js/ui/issue-list.js` / `pr-list.js` / `file-tree.js`
- **What:** The pure renderers in `js/ui/issue-list.js:45,82,87`, `js/ui/pr-list.js:92,93`, `js/file-tree.js:113,114`, `js/tab-manager.js:207,213` build `onclick="window.foo(${arg})"` strings.
- **Why it's load-bearing:** The pure-renderer extraction pattern (1.12.0 branch-panel, 1.13.0 issue-list, 2.23.0 pr-list per the project notes) is supposed to be HTML-in / HTML-out. Inline onclick attaches a coupling to `window.*` globals that the "pure" idea wanted to decouple. The current pattern still mounts via innerHTML, so delegation requires the same DOM owner — `mountBranchPanel` already does the click delegation for the branch panel.
- **Suggested fix shape:** Move from `onclick="window.foo(${id})"` to `data-action="foo" data-id="${id}"` + a delegated click listener in the mount fn. Already the pattern for branch-panel; replicate for issue-list, pr-list, file-tree, tab-manager.
- **Touch points:** `js/ui/issue-list.js:45,82,87`, `js/ui/pr-list.js:92,93`, `js/file-tree.js:108,113,114`, `js/tab-manager.js:207,213`, `js/ui/branch-panel.js` (model implementation).

---

### settings

#### [HC] [S] [needs-investigation] Settings tab module list in `js/settings/persistence.js`?
- **What:** The settings tabs are explicitly imported in `js/settings-manager.js` (likely a fixed list of tabs). Each tab's persistence column lives in `js/settings/persistence.js`. Adding a new tab requires touching both.
- **Why it's load-bearing:** TBD — needs verification. If tabs already use a registry (similar to `Plugins.list()`), this isn't an issue.
- **Suggested fix shape:** Read `js/settings/persistence.js` and `js/settings-manager.js`. Decide if tabs deserve their own registry.
- **Touch points:** `js/settings/*.js`, `js/settings-manager.js`.

---

### preview

#### [ST] [S] [maybe-intentional] Preview-tool classification sets co-located in tool-classifications.js
- **What:** `PREVIEW_MUTATING_TOOLS` (4 tools) + `PREVIEW_READ_TOOLS` (11 tools) in `js/chat/tool-classifications.js:101-122`. The total preview-tool count is 12; the 1 not in either set is `preview_stop` (in MUTATING). So every preview tool is classified — good.
- **Why it's load-bearing:** This is healthy. Mention only to document the contrast with the file-tools side where the sets diverge.
- **Suggested fix shape:** No-op. The model for `tool-classifications.js` is already well-applied here.

---

### retrieval / compression / intelligence

#### [HC] [S] [needs-investigation] Hardcoded provider lists in `intelligence/retrieval/test-corpus.js`
- **What:** `js/intelligence/retrieval/test-corpus.js:230-302` includes 'js/git-providers/github.js', 'js/git-providers/gitlab.js' hardcoded as expected-to-rank files.
- **Why it's load-bearing:** Test fixtures, NOT a runtime hardcode. The file list is the corpus — adding a new provider means updating the corpus, which is correct behavior for a benchmark.
- **Suggested fix shape:** No-op. Flag is here only because it surfaced in the search; not a real audit candidate.

---

### Misc

#### ~~[HC] [S] [maybe-intentional] `BUILTIN_VIEWS` priority spacing (10/20/30/40) is magic~~ *(✅ closed — shipped 2.26.0)*
- **What:** `js/ui/left-pane-rail.js:76-121` uses priorities 10, 20, 30, 40 for files/issues/prs/branches. Provider contributions slot via `priority` per SlotManager's sort, default 50.
- **Why it's load-bearing:** A provider that wants to render BETWEEN issues and prs needs to pick 25 — guessable from the file but not declared. A `BUILTIN_PRIORITY = { files: 10, issues: 20, prs: 30, branches: 40 }` constant would name it.
- **Suggested fix shape:** Optional — promote the priorities to named constants or document the spacing convention near the slot contract in `docs/DESIGN-git-providers-and-ui-extensions.md`.
- **Touch points:** `js/ui/left-pane-rail.js`, `docs/DESIGN-git-providers-and-ui-extensions.md`.
- **Resolution:** 2.26.0 exported `BUILTIN_PRIORITY = Object.freeze({ files: 10, issues: 20, prs: 30, branches: 40 })` from `js/ui/left-pane-rail.js`. Each `BUILTIN_VIEWS` entry's `priority` reads from the constant. New tests in `tests/test-left-pane-rail.mjs` assert the frozen shape, ascending order, and ≥10 spacing (the provider-insertion-room invariant). See [CHANGELOG §2.26.0](../../CHANGELOG.md).

#### [ST] [S] [maybe-intentional] `js/managers/` has only `search-manager.js`
- **What:** The `managers/` directory contains a single file. Other manager-shaped modules (StorageManager, CostManager, ConversationManager) live in `core.js` / `intelligence/cost/` / `chat/conversations.js`. Inconsistent placement.
- **Why it's load-bearing:** Low stakes; orientation cost for new developers. The `js/intelligence/` subtree has its own internal organization that doesn't match `managers/`.
- **Suggested fix shape:** Either move SearchManager into `js/search-panel.js` (the only consumer) or punt.
- **Touch points:** `js/managers/search-manager.js`, `js/search-panel.js`.

#### [EV] [S] [needs-investigation] `fs:created`/`fs:updated`/`fs:deleted`/`fs:renamed` emitted with 0 subscribers
- **What:** From the orphan-emits list, these channels fire but nothing listens.
- **Why it's load-bearing:** They're likely intended for retrieval index-maintenance or plugin extension. Need to confirm whether they're public extension points (then document) or dead wires (then delete).
- **Suggested fix shape:** Read the emit sites + decide.
- **Touch points:** Whatever module emits them — most likely git.js or edit-tools.js.

#### [EV] [S] [maybe-intentional] `ghostText:*` channels emit-only
- **What:** `ghostText:requested`, `ghostText:received`, `ghostText:failed`, `ghostText:empty`, `ghostText:dismissed`, `ghostText:accepted` — six channels, all emit-only.
- **Why it's load-bearing:** Likely plugin extension points for ghost-text customization. Same status as plugin lifecycle channels.
- **Suggested fix shape:** Add to the public-API channel registry; no-op otherwise.
- **Touch points:** `js/editor/ghost-text.js`.

#### [EV] [S] [maybe-intentional] `mergeConflict:*` channels emit-only
- **What:** `mergeConflict:aborted`, `mergeConflict:aiResolve:error`, `mergeConflict:aiResolve:start`, `mergeConflict:aiResolve:success`, `mergeConflict:opened`, `mergeConflict:resolved` — six channels, all emit-only.
- **Why it's load-bearing:** Same shape — extension hooks for the new (2.18.0+) Merge Conflict Resolver. Public-API designation.
- **Suggested fix shape:** Document; no-op.
- **Touch points:** `js/merge-conflict/*.js`.

---

## Triage notes (additional candidates exist)

Additional candidates exist beyond the entries above; the cuts I made to keep the list scannable:

- **Diff viewer `data-action`/`onclick=` mix in `js/diff-viewer.js`** — moderately mixed style but localized to one module; low rendition risk.
- **CodeMirror language map in `js/editor/instance.js`** — large but mostly a domain table; not the kind of hardcode wall that blocks future refactors.
- **`js/help/markdown-loader.js` hardcoded page list** — likely a real candidate but the help-page set is small and rarely changes.
- **MCP catalog hardcoded entries** in `js/mcp/catalog.js` — these are configuration data, NOT enumeration shadows; not a refactor target.
- **The 4 separate `installFileLayer` consumers in `app.js`** (memory, sessions, workspace-settings, replay) — they all follow the same shape but no register. Possibly a candidate; postponed pending Phase 2 file-layer consolidation per ROADMAP.

The "needs-investigation" entries above are the queue's primary triage cost. The "maybe-intentional" entries should mostly resolve to a "public extension API" docs PR rather than a refactor.

## Quick wins (file-name index)

For agents that want to pick a quick win without re-reading the full inventory:

| Entry | File | Lines |
|------|------|------|
| ~~`WRITE_TOOLS` rename~~ | ~~`js/chat/turn-enrich.js`~~ | ~~35-40~~ *(✅ 2.25.0)* |
| ~~`tabs:render` orphan~~ | ~~`js/tools/commit-tools.js`~~ | ~~83~~ *(✅ 2.24.1)* |
| `LEGAL_GROUP_TAGS` registry | `js/tools/registry.js` | 53 |
| ~~`glyphFor` provider extension~~ | ~~`js/settings/connections-tab.js`~~ | ~~18-21~~ *(✅ 2.26.0)* |
| `closeAllModals` selectors | `js/ui-helpers.js` | 87-91 |
| ~~`BUILTIN_PRIORITY` constant~~ | ~~`js/ui/left-pane-rail.js`~~ | ~~76-121~~ *(✅ 2.26.0)* |
| ~~`safeAdd('btnHelp', openHelpModal)`~~ | ~~`js/app.js`~~ | ~~664~~ *(✅ 2.26.0)* |
| Settings hotkey-registry consolidation | `js/app.js` + `js/help/hotkey-registry.js` | 306-489 / 33+ |
