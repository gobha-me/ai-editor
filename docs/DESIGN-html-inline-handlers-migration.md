# DESIGN — HTML Inline-Handlers → Delegated Actions Migration

**Status:** Draft — design pass triggered by the 2026-Q2 audit's [`html-shell` `[ST] [L]` entry](audit-2026-Q2/inventory.md). No version slot requested by this doc; the implementation lands as a sequenced multi-minor track per the *Phased Rollout* below.
**Depends on:** the established 2.24.0 SlotManager body migration ([`js/ui/branch-panel.js`](../js/ui/branch-panel.js) `mountBranchPanel` + [`js/projects/switcher-menu.js`](../js/projects/switcher-menu.js) `mountSwitcherMenu`) — both reference patterns the migration is replicating across the rest of the app shell.
**Related inventory rows:** the parent `[ST] [L]` "53 inline onclick" entry and the sibling `[ST] [S]` "Inline onclick strings inside js/ui renderers" entry — both in [`docs/audit-2026-Q2/inventory.md`](audit-2026-Q2/inventory.md) §"html-shell". They are addressed under one umbrella decision in this doc and execute as separate phases.
**Touch-points (cross-references):**
- [`[HC] [S] closeAllModals` enumerates magic selectors](audit-2026-Q2/inventory.md) — modal-registry refactor; intentionally NOT folded into this migration (see *Open Questions*).
- [`[ST] [M] safeAdd` pattern + bareword global reference fragility](audit-2026-Q2/inventory.md) — same axis as this work but for static-DOM buttons (`#btnCommit` et al.); the `registerAction` API proposed here is the natural successor.
- [`[HC] [M] LEGACY_TOOL_ENUMERATION` in prompts.js](audit-2026-Q2/inventory.md) — unrelated, but the parallel-enumeration risk shape is mirrored: rename a JS function → break the inline string, no compile guard.

---

## Context

This is a design doc, not a one-PR change. The audit row that motivates it is [`[ST] [L] [likely]` "53 inline `onclick="window.foo()"` calls across `html/*.html`"](audit-2026-Q2/inventory.md). Per the 2026-Q2 audit triage policy ("**L** — architectural — design doc + multi-minor"), the entry earns a design pass before any code lands.

Three reasons a single PR is the wrong shape:

1. **Breadth.** ~50 inline `onclick=` attributes in HTML templates (`html/modals.html`, `html/editor-panel.html`, `html/chat-panel.html`, `html/settings-tabs.html`) plus another ~29 across JS renderers ([`js/ui/issue-list.js`](../js/ui/issue-list.js), [`js/ui/pr-list.js`](../js/ui/pr-list.js), [`js/file-tree.js`](../js/file-tree.js), [`js/tab-manager.js`](../js/tab-manager.js), [`js/chat/messages.js`](../js/chat/messages.js), [`js/chat/input.js`](../js/chat/input.js), [`js/diff-viewer.js`](../js/diff-viewer.js), [`js/issue-detail.js`](../js/issue-detail.js)). Each surface has its own wiring + its own test boundary. Bundling them into one PR makes review unsurfaceable.
2. **Risk surfaces.** Every modal currently relies on a `window.*` global assignment in [`js/app.js:147-264`](../js/app.js). Migrating them all at once means the rollback boundary is huge — a single regression in one surface invalidates the rest. The 2.22.0 → 2.24.0 SlotManager track shipped the same shape: piece-by-piece, each minor independently shippable, each with a clean rollback.
3. **Decision-shape questions exist.** The naming convention for the action vocabulary, the choice of delegation root, the payload-arg shape, and the registration API are load-bearing decisions that need consensus before code lands. The cost of revisiting them after Phase 1 ships and 9 modals are migrated is large; the cost of agreeing in a design doc is small.

The doc commits to: the inventory of every inline handler, the load-bearing decisions, a 4-phase delivery sequence, the per-phase test plan, and a removability check. Implementation lands per the *Implementation status* table at the end.

---

## Problem

Inline event handlers (`onclick="window.commitAndPush()"`) cost the project four ways:

1. **Brittleness.** The string `"window.commitAndPush()"` is an HTML attribute; nothing checks at lint time or build time that `window.commitAndPush` exists, has the right signature, or accepts the arguments the inline string passes. Rename `commitAndPush` → `commitAndPushChanges` and every HTML caller silently breaks. The CHANGELOG references a class of bugs ("invisible to the model" when one surface gets renamed; same shape) — this is the DOM analogue.
2. **Coupling to window globals.** Every modal-extracted module has to call `window.closeCommitModal = closeCommitModal` somewhere in [`js/app.js:147-264`](../js/app.js). The block is now ~120 lines of single-purpose global aliases. A module that imports `closeCommitModal` and uses it locally still has to be re-exposed on `window` for the HTML attribute to resolve. The audit row calls this out: "the window.* exposure block" is the architectural sin; inline handlers are why it exists.
3. **CSP-unfriendliness.** Strict Content-Security-Policy disallows inline event handlers (no `unsafe-inline` for `script-src`). Today this isn't gating anything — the editor has no CSP. But the editor *should* have one (security threat model in [`docs/SECURITY.md`](SECURITY.md) §"What does NOT ship": "No CSP / iframe isolation for the editor itself"), and inline handlers will block it when that PR lands. This design unblocks CSP as a side-benefit, not as the goal.
4. **Late-binding fragility.** The same axis as the `[ST] [M]` `safeAdd` audit entry: inline handlers assume the `window.*` reference resolves at click time, which it usually does because boot order is stable. But any contribution-driven mount (a future plugin button rendered into a SlotManager slot after `init()` runs) can't piggyback on inline handlers — there's no place to put the attribute. Delegation makes the wire-up surface independent of mount timing.

The model is already established in tree. [`js/ui/branch-panel.js#mountBranchPanel`](../js/ui/branch-panel.js) attaches a single `document`-level click listener filtered by `.closest('.branch-panel')`, reads `data-branch-action` + `data-branch-name`, and dispatches to typed `onSwitch`/`onDelete`/`onCutRelease`/`onExportZip` callbacks. [`js/projects/switcher-menu.js#mountSwitcherMenu`](../js/projects/switcher-menu.js) uses the same shape scoped to its menu container with `data-action`. The migration is *replicating that shape everywhere*, not inventing a new one.

---

## The Load-Bearing Decisions

Push back on any of these before implementation begins. Once Phase 1 ships, these are committed.

### Decision 1 — Delegation root: `document`, scoped by container class

**Choice.** Use `document.addEventListener('click', handler)` at the listener seam, scoped per-surface by `event.target.closest('.surface-marker')`. Each `mount*` function attaches its own document-level listener with its own scoping filter.

**Alternatives considered:**
- `#app` root: marginally smaller event-walk, but `#app` doesn't exist until [`html/index.html`](../html/index.html) loads templates, so listener attach is order-sensitive. Document is always available.
- Per-modal mount-root: attach the listener on the modal's container element. Breaks down because the rail renderer re-creates `#branchPanel` lazily (2.24.0 body migration), and the container instance changes — but listeners on `document` survive that.

**Precedent.** [`js/ui/branch-panel.js:215-235`](../js/ui/branch-panel.js#L215) (`mountBranchPanel`) is the load-bearing precedent. Its docstring spells out the rationale: "Click delegation lives on `document` so the wiring is decoupled from whether `#branchPanel` exists at mount time — the rail's `render(body)` creates `#branchPanel` lazily on rail rebuilds (2.24.0 SlotManager body migration), and the `.branch-panel` scope keeps the document-level listener from catching unrelated `[data-branch-action]` attrs elsewhere."

**Trade-offs:**
- *Pro:* Decoupled from mount timing. Survives container re-creation. One listener per surface, not one per row.
- *Pro:* Re-render robustness — `innerHTML = "..."` on the surface container does not re-detach the listener. Today this matters for [`js/file-tree.js#renderTreeNodes`](../js/file-tree.js), which rebuilds the entire tree on each refresh.
- *Con:* All modal events bubble through `document`. With ~9 modal listeners post-migration, every click does ~9 `closest()` checks. Negligible at this scale (each `closest()` walks O(depth)).
- *Con:* Scoping filter is load-bearing — a missing `.closest('.commit-modal')` check catches `data-action="close"` from any other surface. Every `mount*` is responsible for its own scope.

### Decision 2 — `data-action` vocabulary: flat names, camelCase, action-only

**Choice.** Flat action names matching the migrated function name in camelCase: `data-action="closeCommitModal"`, `data-action="commitAndPush"`, `data-action="zipSelectAll"`. No namespacing.

**Alternatives considered:**
- Namespaced (`data-action="commitModal:close"`). More scannable as a vocabulary; lets the dispatcher route by namespace. But the dispatcher already routes by `.closest()` scope, so the namespace is redundant. And the action vocabulary today is *already mostly unique* by virtue of the `closeXxxModal` / `submitXxxModal` naming convention — collisions are rare.
- Verb-only (`data-action="close"`, with the surface scope disambiguating). Cleaner inside one surface but requires every reader to mentally re-attach the scope to understand what an attribute does. The current `window.closeCommitModal` naming is more self-describing; preserving it as `data-action="closeCommitModal"` keeps the grep target stable through the migration.

**Trade-offs:**
- *Pro:* `grep -rn 'data-action="closeCommitModal"'` finds the HTML attribute *and* the registered handler — same string, two surfaces, easy refactor.
- *Pro:* No mental translation step between "what was the window function" and "what's the action name."
- *Con:* No compile-time check that `data-action="closeCommitModl"` (typo) is wired to a handler. Mitigated by the test in *Tests* below — a registry-coverage assertion.
- *Con:* When two surfaces share a verb (`close`), the action names look redundant (`closeCommitModal` / `closeRevertModal` / `closeNewBranchModal` etc.). Acceptable; the modal-registry refactor (out of scope) would naturally collapse these into one `close` action when it ships.

### Decision 3 — Payload args: typed `data-*` attributes, not JSON

**Choice.** Single-arg actions use a typed `data-*` attribute (`data-id`, `data-name`, `data-path`, `data-index`). Multi-arg actions use multiple typed attributes (`data-name="${name}" data-is-dir="${isDir}"`). No `data-args='${JSON.stringify(...)}'`.

**Alternatives considered:**
- `data-args` JSON blob (`data-args='[42,"feature-x"]'`). One attribute, any arity. But JSON-in-an-attribute requires HTML-attribute-encoding of `"` and `<` characters, with classic quoting bugs ([`escapeAttr`](../js/utils/html.js) already exists for the simple case). Single typed attrs avoid the parse + the encoding hazard.
- Closure capture in the dispatcher — pass the row index in the handler via DOM walk. Forces every callsite to recompute the row's identity from `.closest('[role="listitem"]')`, repeating logic the renderer already knew. Typed attrs put the identity right next to the action.

**Trade-offs:**
- *Pro:* Each attribute is its own escape-target. `escapeAttr(node.path)` works at the per-attribute boundary — no JSON quoting on top.
- *Pro:* Coercion is explicit at the handler ("read `data-id` as a number" is `Number(el.dataset.id)`). The HTML attribute is always a string; the handler decides the shape.
- *Con:* Multi-arg signatures inflate attribute count. The tree-row case ([`js/file-tree.js`](../js/file-tree.js)) has `path` + `type` + `isDir` — three attributes per row, slightly more verbose than `onclick="window.handleTreeClick(event, '${path}', '${type}')"`. Tolerable.

### Decision 4 — Registration shape: per-surface `mountX({ onAction1, onAction2 })` callbacks

**Choice.** Each surface has its own `mount*` function (mirroring [`mountBranchPanel`](../js/ui/branch-panel.js#L216)) that takes a `{ onAction1, onAction2, ... }` opts bag of typed callbacks. The mount function owns the delegation seam; the caller provides the typed behaviors.

**Alternatives considered:**
- A single global `registerAction(actionId, handler)` registry. Spec'd as the audit row's suggested fix shape ("the natural end-state is shrinking the `window.*` block dramatically — replace with a `registerAction` API"). Pros: one source of truth, easy to dump the action list, easy to test. Cons: divorces an action's wire-up from its module, recreates the `window.*` global-namespace flat-list problem at a different layer.
- A `data-action` → handler `Map` per surface, registered at mount: `mountCommitModal({ actions: { closeCommitModal: closeCommitModal, commitAndPush: commitAndPush } })`. Equivalent to the callbacks-bag in capability; redundant in this codebase because the callback names *already* describe what they do (`onSwitch`, `onDelete`).

**Choice rationale.** The branch-panel precedent is `mountBranchPanel({ onSwitch, onDelete, onCutRelease, onExportZip })`. It works. Replicating it for every surface keeps the migration mechanical and reviewable: rename → done. The global-registry refactor is a *follow-on* that can sit on top of the per-surface pattern once it ships; this design doesn't commit to it.

**End state.** The `window.*` block in [`js/app.js:147-264`](../js/app.js) shrinks to:
- functions the *plugin extension surface* genuinely needs (the documented public API — `window.showToast`, `window.openZipUpload`, `window.openSettings` per [`js/profiles/plugin-dev-v1.js`](../js/profiles/plugin-dev-v1.js));
- functions referenced by *external embedders* (`window.AIEditor` namespace);
- a few utility helpers that callers genuinely want as a global (`window.Chat.*` is a stable API).

The block goes from ~120 lines to ~30–40, all documented as "intentionally public."

### Decision 5 — DOM-only inline handlers: `data-action="toggleExpanded" data-target="${id}"`

**Choice.** Inline handlers that do DOM manipulation without calling a `window.*` function ([`js/chat/messages.js:1019`](../js/chat/messages.js#L1019) `onclick="document.getElementById('${id}').classList.toggle('expanded')"`) migrate to `data-action="toggleExpanded" data-target="${id}"` + a generic `toggleExpanded` handler registered once.

**Why this matters.** The audit row says "53 inline onclick" — but ~3-5 of those 53 (varies by surface) are *not* `window.foo()` calls; they're inline DOM ops. The migration needs a shape for them or it has to leave a residue of inline handlers that defeats the CSP-unfriendly point. The generic dispatcher pattern (action name + typed target attribute) handles them cleanly.

### Decision 6 — Sequencing: modals first, renderers next, cleanup last

**Choice.** The 4 phases (see *Phased Rollout*) ship in this order:
1. Shared infrastructure + pilot modal (commit modal — the highest-traffic).
2. Remaining modals.
3. JS renderers (`issue-list`, `pr-list`, `file-tree`, `tab-manager`, `chat/messages`, `chat/input`, `diff-viewer`).
4. Cleanup — shrink the `window.*` block to the documented-public-API surface.

**Why this order.**
- Modals are the *bigger* surface (~43 in `html/modals.html` alone) and the *higher-stakes* path (close/submit semantics are user-critical). Doing them first front-loads the risk and validates the dispatcher shape against the densest cluster.
- Renderers are second because they're each smaller (3–13 onclicks per renderer) and follow a uniform shape — once the dispatcher pattern is settled in modals, renderers are mechanical.
- Cleanup is last because the `window.*` block can't shrink until every consumer has migrated. Doing it earlier would create a window where some HTML still references `window.foo` while `js/app.js` has already removed the alias.

This mirrors the 2.22.0/2.23.0/2.24.0 SlotManager track: per-surface migrations, each independently shippable, cleanup as the closer.

---

## Inventory

Source: `grep -rn 'onclick="' html/` + `grep -rn 'onclick=' js/`. The table below enumerates every handler grouped by surface. Columns:

| Surface | File | Function name | Payload args | `window.*` exposure |
|---|---|---|---|---|

### Modals (`html/modals.html`)

| Surface | File:line | Function | Args | `window.*` line |
|---|---|---|---|---|
| Settings | [modals.html:18](../html/modals.html) | `closeSettings` | — | [app.js:187](../js/app.js#L187) |
| Settings | [modals.html:61](../html/modals.html) | `exportSettings` | — | (settings module) |
| Settings | [modals.html:65](../html/modals.html) | `importSettings` | — | (settings module) |
| Settings | [modals.html:71](../html/modals.html) | `closeSettings` | — | [app.js:187](../js/app.js#L187) |
| Settings | [modals.html:72](../html/modals.html) | `saveSettings` | — | [app.js:188](../js/app.js#L188) |
| Revert | [modals.html:89](../html/modals.html) | `closeRevertModal` | — | [app.js:248](../js/app.js#L248) |
| Revert | [modals.html:99](../html/modals.html) | `revertOnlyCurrentFile` | — | [app.js:250](../js/app.js#L250) |
| Revert | [modals.html:103](../html/modals.html) | `revertAllFiles` | — | [app.js:249](../js/app.js#L249) |
| Revert | [modals.html:110](../html/modals.html) | `closeRevertModal` | — | [app.js:248](../js/app.js#L248) |
| Commit | [modals.html:123](../html/modals.html) | `closeCommitModal` | — | [app.js:206](../js/app.js#L206) |
| Commit | [modals.html:145](../html/modals.html) | `generateCommitMsg` | — | [app.js:207](../js/app.js#L207) |
| Commit | [modals.html:156](../html/modals.html) | `closeCommitModal` | — | [app.js:206](../js/app.js#L206) |
| Commit | [modals.html:157](../html/modals.html) | `commitAndPush` | — | [app.js:208](../js/app.js#L208) |
| New branch | [modals.html:173,189](../html/modals.html) | `closeNewBranchModal` | — | [app.js:211](../js/app.js#L211) |
| New branch | [modals.html:190](../html/modals.html) | `createNewBranch` | — | [app.js:212](../js/app.js#L212) |
| New file | [modals.html:206,216](../html/modals.html) | `closeNewFileModal` | — | [app.js:235](../js/app.js#L235) |
| New file | [modals.html:217](../html/modals.html) | `createNewFile` | — | [app.js:244](../js/app.js#L244) |
| Rename | [modals.html:233,243](../html/modals.html) | `closeRenameModal` | — | [app.js:238](../js/app.js#L238) |
| Rename | [modals.html:244](../html/modals.html) | `submitRename` | — | [app.js:239](../js/app.js#L239) |
| Issue detail | [modals.html:282,319](../html/modals.html) | `closeIssueDetailModal` | — | [app.js:224](../js/app.js#L224) |
| Issue detail | [modals.html:307](../html/modals.html) | *inline `event.stopPropagation()`* | — | — |
| Create PR | [modals.html:336,361](../html/modals.html) | `closeCreatePRModal` | — | [app.js:226](../js/app.js#L226) |
| Create PR | [modals.html:362](../html/modals.html) | `submitCreatePR` | — | [app.js:227](../js/app.js#L227) |
| Zip upload | [modals.html:381,449](../html/modals.html) | `closeZipUpload` | — | [app.js:254](../js/app.js#L254) |
| Zip upload | [modals.html:402,403](../html/modals.html) | `zipSelectAll` | `(true)` / `(false)` | [app.js:257](../js/app.js#L257) |
| Zip upload | [modals.html:404](../html/modals.html) | `scanForDiffs` | — | [app.js:258](../js/app.js#L258) |
| Zip upload | [modals.html:450](../html/modals.html) | `uploadExtractedFiles` | — | [app.js:259](../js/app.js#L259) |
| Plugin | [modals.html:463](../html/modals.html) | `closePluginModal` | — | [app.js:243](../js/app.js#L243) |
| Release | [modals.html:684,742](../html/modals.html) | `closeReleaseModal` | — | (release module) |
| Release | [modals.html:703](../html/modals.html) | `generateReleaseNotes` | — | (release module) |
| Release | [modals.html:743](../html/modals.html) | `createRelease` | — | (release module) |
| Replay | [modals.html:759,786](../html/modals.html) | `closeReplayModal` | — | (replay module) |
| Replay | [modals.html:782](../html/modals.html) | `replayPrev` | — | (replay module) |
| Replay | [modals.html:784](../html/modals.html) | `replayNext` | — | (replay module) |

### Editor / chat panels & settings tabs

| Surface | File:line | Function | Args | `window.*` line |
|---|---|---|---|---|
| Editor panel | [editor-panel.html:47](../html/editor-panel.html) | `openSettings` | — | [app.js:186](../js/app.js#L186) |
| Editor panel | [editor-panel.html:51](../html/editor-panel.html) | `openZipUpload` | — | [app.js:253](../js/app.js#L253) |
| Editor panel | [editor-panel.html:77](../html/editor-panel.html) | `toggleSecondaryFullscreen` | — | [app.js:202](../js/app.js#L202) |
| Editor panel | [editor-panel.html:80](../html/editor-panel.html) | `closeSecondaryPane` | — | [app.js:201](../js/app.js#L201) |
| Chat panel | [chat-panel.html:11](../html/chat-panel.html) | `openReplayModal` | — | (replay module) |
| Settings tabs | [settings-tabs.html:85](../html/settings-tabs.html) | `fetchModelsForSettings` | — | [app.js:189](../js/app.js#L189) |
| Settings tabs | [settings-tabs.html:523](../html/settings-tabs.html) | `fetchEmbeddingModelsForSettings` | — | [app.js:190](../js/app.js#L190) |

### JS renderers (sibling `[ST] [S]` row)

| Surface | File:line | Function | Args |
|---|---|---|---|
| Issue list | [issue-list.js:45](../js/ui/issue-list.js#L45) | `Chat.sendMessage` | `('Show me issue #${depNum}')` |
| Issue list | [issue-list.js:82](../js/ui/issue-list.js#L82) | `startWorkOnIssueFromList` | `(issue.number)` |
| Issue list | [issue-list.js:87,88](../js/ui/issue-list.js#L87) | `openIssueTab` | `(issue.number)` |
| PR list | [pr-list.js:92,93](../js/ui/pr-list.js#L92) | `openPrReview` | `(pr.number)` |
| File tree | [file-tree.js:109](../js/file-tree.js#L109) | `handleTreeClick` | `(event, path, type)` |
| File tree | [file-tree.js:114](../js/file-tree.js#L114) | `openRenameModal` | `(path, isDir)` |
| File tree | [file-tree.js:115](../js/file-tree.js#L115) | `deleteFile` / `deleteFolder` | `(path)` |
| Tab manager | [tab-manager.js:207](../js/tab-manager.js#L207) | `switchToTab` | `(index)` |
| Tab manager | [tab-manager.js:208](../js/tab-manager.js#L208) | `pinTab` | `(index)` (via `ondblclick`) |
| Tab manager | [tab-manager.js:213](../js/tab-manager.js#L213) | `closeTab` | `(index, event)` |
| Issue detail | [issue-detail.js:145](../js/issue-detail.js#L145) | `openIssueTab` | `(issueNumber)` |
| Diff viewer | [diff-viewer.js:356,361](../js/diff-viewer.js#L356) | `DiffViewer.setViewMode` | `('unified')` / `('side-by-side')` |
| Diff viewer | [diff-viewer.js:366,371](../js/diff-viewer.js#L366) | `DiffViewer.previousChange` / `nextChange` | — |
| Chat input | [chat/input.js:347,356](../js/chat/input.js#L347) | `Chat.removeImage` | `(i)` |
| Chat messages | [chat/messages.js:343,344](../js/chat/messages.js#L343) | `Chat.applyPendingEdit` / `rejectPendingEdit` | — |
| Chat messages | [chat/messages.js:349,350](../js/chat/messages.js#L349) | `Chat.continueResponse` / `copyMessage` | `(this)` |
| Chat messages | [chat/messages.js:471](../js/chat/messages.js#L471) | `Chat.previewImage` | `(this.src)` |
| Chat messages | [chat/messages.js:502,510,511](../js/chat/messages.js#L502) | `Chat.copyMessage` / `editMessage` / `retryLastMessage` | `(this)` / `(this)` / — |
| Chat messages | [chat/messages.js:1019](../js/chat/messages.js#L1019) | *inline DOM op* (`classList.toggle`) | (target id) |
| Chat messages | [chat/messages.js:1064,1065](../js/chat/messages.js#L1064) | `Chat.editMessage` / `retryLastMessage` | `(this)` / — |
| Chat messages | [chat/messages.js:1090,1091](../js/chat/messages.js#L1090) | `Chat.commitEdit` / `cancelEdit` | `(this)` / `(this)` |

**Total (by survey, 2026-05-11):** ~50 in `html/*.html` (the audit row cited 53; small variance is comments + lines that span attributes). ~29 in `js/`. Combined ~79.

**Out-of-table notes:**
- [issue-detail.js:145](../js/issue-detail.js#L145) is one isolated entry — folds naturally into Phase 3.
- [chat/messages.js:1019](../js/chat/messages.js#L1019) is the "inline DOM op without a window function" case Decision 5 covers; not a typo, a different shape.
- `js/help/index.js:77,143` matches in grep but are *comments* (back-compat notes), not live handlers — excluded.
- `modals.html:307` uses `onclick="event.stopPropagation()"` with no further dispatch — the surrounding context is event-bubbling control on a non-actionable element; the migration replaces it with a `data-stop="true"` or just CSS `pointer-events`.

---

## Reference Pattern

The pattern this migration replicates is established in two places. New surfaces should pattern-match against them; reviewers should reject deviations without rationale.

### `mountBranchPanel` ([`js/ui/branch-panel.js:216-244`](../js/ui/branch-panel.js#L216))

```javascript
let _wired = false;
export function mountBranchPanel({ onSwitch, onDelete, onCutRelease, onExportZip } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest(`[${ACTION_ATTR}]`);
        if (!btn) return;
        if (!btn.closest('.branch-panel')) return;
        const action = btn.getAttribute(ACTION_ATTR);
        const name = btn.getAttribute(NAME_ATTR) || State.currentBranch;
        if (action === 'switch' && typeof onSwitch === 'function') {
            await onSwitch(name);
        } else if (action === 'delete' && typeof onDelete === 'function') {
            await onDelete(name);
        } /* ... */
    });
    // EventBus subscriptions for re-render
    EventBus.on('project:loaded', renderBranchPanel);
    /* ... */
}
```

Four load-bearing properties:
1. `_wired` guard ensures idempotent mount (boot may invoke twice; rail re-renders may invoke again).
2. `document` listener, scoped by `.closest('.branch-panel')`.
3. `data-branch-action` attribute is the only routing key.
4. `data-branch-name` is the typed payload; the handler reads `getAttribute` + defaults from `State` when absent.

### `mountSwitcherMenu` ([`js/projects/switcher-menu.js:161-183`](../js/projects/switcher-menu.js#L161))

```javascript
menu.addEventListener('click', (e) => {
    const row = e.target.closest('[data-action]');
    if (!row) return;
    const action = row.getAttribute('data-action');
    if (action) handleAction(action);
});
```

Same shape, scoped tighter: the listener is on the menu container (`menu.addEventListener`) rather than `document`. Both shapes are valid; pick `document` when the container may re-create (re-render robustness), pick the container when the surface is permanent (boot-installed, never destroyed).

### Migration template (per modal)

For each modal, three coordinated changes:

1. **HTML** (`html/modals.html`):
   ```diff
   - <button onclick="window.closeCommitModal()">Cancel</button>
   - <button onclick="window.commitAndPush()">Commit</button>
   + <button data-action="closeCommitModal">Cancel</button>
   + <button data-action="commitAndPush">Commit</button>
   ```

2. **Module** (e.g., `js/commit-modal.js` — extracted if necessary):
   ```javascript
   let _wired = false;
   export function mountCommitModal({ onClose, onCommit, onGenerate } = {}) {
       if (_wired) return;
       _wired = true;
       document.addEventListener('click', (e) => {
           const btn = e.target.closest('[data-action]');
           if (!btn) return;
           if (!btn.closest('#commitModal')) return;
           const action = btn.getAttribute('data-action');
           if (action === 'closeCommitModal') onClose?.();
           else if (action === 'commitAndPush') onCommit?.();
           else if (action === 'generateCommitMsg') onGenerate?.();
       });
   }
   ```

3. **app.js** invokes `mountCommitModal({ onClose: closeCommitModal, onCommit: commitAndPush, onGenerate: generateCommitMsg })` during `init()`, and the corresponding `window.closeCommitModal = closeCommitModal` lines delete from the `window.*` block in Phase 4 (not in the per-modal phase — see *Sequencing*).

---

## Phased Rollout

Each phase is one minor (or one PR within a minor) and independently shippable. Each phase carries its own *Removability check* per [`docs/ROADMAP.md`](ROADMAP.md) §Decisions 7.

### Phase 1 — Shared dispatcher pattern + pilot modal

**Scope.** Pilot the dispatcher shape on a single, high-traffic modal (the commit modal). Document the pattern in a `js/ui/delegated-actions.js` JSDoc header (or a comment in the pilot module) so subsequent phases copy from a settled shape.

**Surfaces migrated.**
- Commit modal: 4 handlers (`closeCommitModal` ×2, `generateCommitMsg`, `commitAndPush`) in [`html/modals.html:123-157`](../html/modals.html).

**New code.**
- `mountCommitModal` function in [`js/git.js`](../js/git.js) (or wherever `closeCommitModal`/`commitAndPush` live today) following the [`mountBranchPanel`](../js/ui/branch-panel.js#L216) template.
- One call from [`js/app.js#init()`](../js/app.js) — `mountCommitModal({ onClose: closeCommitModal, onCommit: commitAndPush, onGenerate: generateCommitMsg })`.

**HTML changes.** 4 attributes in [`html/modals.html`](../html/modals.html) from `onclick="window.foo()"` → `data-action="foo"`.

**`window.*` block changes.** *None.* The aliases stay during the migration; they delete in Phase 4. This is intentional — keeps each phase's rollback boundary clean (revert one phase's PR → restore exactly that phase's HTML + module changes).

**Tests.**
- Node test: `tests/test-commit-modal-dispatch.mjs` — a JSDOM-equivalent (or pure-string) assertion that the dispatcher routes `data-action="commitAndPush"` to the registered handler. Lifts the pattern from the existing `tests/test-branch-panel.mjs`.
- Manual browser test: click each button in the commit modal, verify no regression.

**Inventory reference.** Parent row [`[ST] [L]`](audit-2026-Q2/inventory.md) — partial check (4/~50).

**Removability check.** Revert the PR → 4 attributes restored, `mountCommitModal` deleted, `app.js` call removed. The `window.commitAndPush` alias was untouched, so HTML restores to a working state. Byte-equivalent.

**Sized:** ~120 LOC. One minor.

### Phase 2 — Remaining modals

**Scope.** All other modals listed in *Inventory* §Modals: revert, new branch, new file, rename, issue detail, create PR, zip upload, plugin, release, replay, settings.

**Surfaces migrated.** ~45 inline handlers across 11 modals.

**Shape per modal.** Identical to Phase 1. Each modal gets its own `mountXxxModal` function in its owning module; one call from [`js/app.js#init()`](../js/app.js); the HTML attributes migrate; `window.*` aliases stay.

**Per-modal opportunity.** Several modals have their open/close logic split between [`js/app.js`](../js/app.js) (the `window.*` exposure + sometimes the body) and a topic-owning module. Where the migration naturally requires a `mountXxxModal` function, this is also the right moment to **extract the modal's logic into its own module** if it isn't already (settings is already in `js/settings-manager.js`; commit/revert/new-branch live in `js/git.js`; rename lives in `js/file-rename.js`). Don't force the extraction — only do it where it's a clean cut.

**Tests.** Per-modal Node tests asserting dispatcher routing. One per modal (~11 new test files). The existing [`tests/test-branch-panel.mjs`](../tests/test-branch-panel.mjs) is the template — pure-string assertions over the rendered HTML and dispatcher logic; no JSDOM dependency.

**Inventory reference.** Parent [`[ST] [L]`](audit-2026-Q2/inventory.md) — closes the HTML side of the entry.

**Removability check.** Per-modal revert restores its 3–5 attributes and its `mountXxxModal` + `app.js` call. Byte-equivalent.

**Sized:** ~400–500 LOC across one or two minors (likely split as 2a "core modals" and 2b "auxiliary modals" depending on review bandwidth).

### Phase 3 — JS renderers (sibling `[ST] [S]` row)

**Scope.** Inline `onclick=` strings inside JS render functions ([`js/ui/issue-list.js`](../js/ui/issue-list.js), [`js/ui/pr-list.js`](../js/ui/pr-list.js), [`js/file-tree.js`](../js/file-tree.js), [`js/tab-manager.js`](../js/tab-manager.js), [`js/chat/messages.js`](../js/chat/messages.js), [`js/chat/input.js`](../js/chat/input.js), [`js/diff-viewer.js`](../js/diff-viewer.js), [`js/issue-detail.js`](../js/issue-detail.js)).

**Surfaces migrated.** ~29 inline handlers across ~8 renderer files.

**Shape difference from modals.** Renderers produce *dynamic* HTML with payload args. The migration must (a) replace `onclick="window.foo(${id})"` with `data-action="foo" data-id="${id}"`, and (b) ensure the dispatcher is mounted once (idempotent) so re-render of the surface doesn't multiply listeners.

**Per-renderer mount fn.**
- `mountIssueList` (in [`js/ui/issue-list.js`](../js/ui/issue-list.js), or its consumer if the pure-renderer guard would be violated)
- `mountPrList` (in [`js/ui/pr-list.js`](../js/ui/pr-list.js))
- `mountFileTree` (in [`js/file-tree.js`](../js/file-tree.js))
- `mountTabManager` (in [`js/tab-manager.js`](../js/tab-manager.js))
- `mountChatMessages` (in [`js/chat/messages.js`](../js/chat/messages.js)) — largest by inline count (~13 handlers)
- `mountChatInput` (in [`js/chat/input.js`](../js/chat/input.js))
- `mountDiffViewer` (in [`js/diff-viewer.js`](../js/diff-viewer.js))

**Special case — chat/messages.js inline DOM op.** [`chat/messages.js:1019`](../js/chat/messages.js#L1019) does `onclick="document.getElementById('${id}').classList.toggle('expanded')"`. Per Decision 5, this becomes `data-action="toggleExpanded" data-target="${id}"` + a `toggleExpanded` handler that reads `data-target` and does `document.getElementById(target)?.classList.toggle('expanded')`. The handler lives in the same surface's mount fn.

**Tests.**
- Renderer string tests: assert the rendered output contains `data-action="foo"` instead of `onclick="..."`. Lift from [`tests/test-issue-row-render.mjs`](../tests/test-issue-row-render.mjs), [`tests/test-pr-list.mjs`](../tests/test-pr-list.mjs).
- Dispatcher tests: per-mount assertion that `data-action="X"` triggers handler X with the right payload args.

**Inventory reference.** Sibling [`[ST] [S]`](audit-2026-Q2/inventory.md) row — closes it.

**Removability check.** Per-renderer revert restores the inline `onclick=` strings + removes the mount fn. Byte-equivalent.

**Sized:** ~300–400 LOC across one or two minors. Chat-messages alone is half the inline count; may earn its own PR.

### Phase 4 — `window.*` exposure block cleanup

**Scope.** Shrink [`js/app.js:147-264`](../js/app.js) (~120 lines) to the documented-public-API surface.

**Audit each alias.**
- *Keep* (documented public API): `window.AIEditor`, `window.Chat.*`, `window.showToast`, `window.openZipUpload`, `window.openSettings`, `window.openHelpModal` (back-compat alias per [`js/app.js:180`](../js/app.js#L180) comment), plus the dev-flag `window.__AIE_DEBUG_METADATA`.
- *Keep* (3rd-party consumer surface): the [`js/profiles/plugin-dev-v1.js`](../js/profiles/plugin-dev-v1.js) extension-channel list dictates what plugins reach for; that list is the canonical public-API registry.
- *Delete* everything else — every `window.closeCommitModal = ...`, `window.commitAndPush = ...`, etc. is now unreferenced after Phases 1–3.

**Verification.** Grep for `window.foo` for each candidate-delete `foo`; if it appears in `html/`, that surface didn't migrate (regression — fix that first). If it appears in `js/` outside the canonical exposure block, it's a real consumer — keep.

**Tests.**
- New coverage test `tests/test-no-inline-onclick.mjs`: assert that `grep -rn 'onclick="' html/` returns zero matches. Fail the build if any inline `onclick` survives.
- Existing test for unreferenced `window.*` (if it exists; else add a small one): assert every `window.X = Y` in [`js/app.js:147-264`](../js/app.js) has a documented consumer or is in the documented-public-API registry.

**Inventory reference.** Closes the parent [`[ST] [L]`](audit-2026-Q2/inventory.md) entry's "the window.* exposure block is the architectural sin" rationale.

**Removability check.** Revert restores the deleted aliases. *Important:* the revert is byte-equivalent ONLY if Phases 1–3 also revert. Reverting Phase 4 alone would resurrect ~80 lines of aliases that no consumer references — harmless dead code, but not byte-equivalent in spirit. Document this in the PR description.

**Sized:** ~80–100 LOC deletion + ~20 LOC for the new coverage test. One small minor (the smallest of the four).

---

## CSP Implications (Follow-On Benefit)

Strict CSP requires the `script-src` directive without `unsafe-inline`. Inline event handlers (`onclick="..."`) are evaluated as script content and require `unsafe-inline` to execute. After Phase 4, the editor has zero inline event handlers in HTML and zero in JS-rendered strings, so a `script-src 'self'` CSP becomes viable.

**This design does not commit to shipping CSP.** That's a separate design pass touching:
- The CodeMirror bundle ([`vendor/codemirror-bundle.js`](../vendor/codemirror-bundle.js)) and whether it uses `eval`-like constructs;
- DOMPurify CDN load (currently external-script);
- Plugin source execution (`Plugins.installFromUrl` evaluates fetched JS via `new Function()` — this is the CSP wall, not inline handlers).

Cross-reference: [`docs/SECURITY.md`](SECURITY.md) §"What does NOT ship" — "No CSP / iframe isolation for the editor itself." That entry stays open after this migration ships; the migration *unblocks* the CSP work, doesn't *do* it.

---

## Tests

Per-phase test plan:

| Phase | Test type | Test file (proposed) | What it asserts |
|---|---|---|---|
| 1 | Dispatcher | `tests/test-commit-modal-dispatch.mjs` | `data-action="commitAndPush"` button click invokes the registered handler |
| 2 | Dispatcher × N | `tests/test-{modal}-dispatch.mjs` × ~11 | Same shape per modal |
| 3 | Renderer + dispatcher | `tests/test-{renderer}-dispatch.mjs` × ~7 | Rendered HTML uses `data-action=` (not `onclick=`); dispatcher routes correctly |
| 4 | Coverage | `tests/test-no-inline-onclick.mjs` | `grep` for `onclick="` in `html/` + `js/` returns zero matches |

**Test pattern (lifted from [`tests/test-branch-panel.mjs`](../tests/test-branch-panel.mjs)).** Pure-string assertions over rendered HTML. No JSDOM dependency. Dispatcher tests construct a minimal element tree with `document.createElement` (per [`tests/_node-shim.mjs`](../tests/_node-shim.mjs)) and dispatch synthetic click events. CI auto-globs `node --test tests/test-*.mjs` per [`reference_testing_ci.md`](../docs/audit-2026-Q2/inventory.md) — adding the test files wires them into CI automatically.

**Anti-regression assertion.** After Phase 4, the coverage test prevents any future PR from sneaking an inline `onclick=` back in. The audit's recurring-pattern memory ([`feedback_security_lint_return_raw.md`](../docs/audit-2026-Q2/inventory.md) shape) shows this kind of regression *does* happen without a lint guard.

---

## Removability

Per-phase rollback is documented in each *Phase N → Removability check* above. The aggregate removability story:

| Operation | Phases needed to revert | Result |
|---|---|---|
| Revert Phase 4 alone | Phase 4 only | Aliases restored (harmless dead code); HTML & JS still uses `data-action` (still works because aliases are unreferenced from HTML at this point). |
| Revert Phase 3 alone | Phase 3 only | Renderer inline `onclick=` strings restored; modal `data-action` stays (Phases 1–2 untouched). |
| Revert Phase 2 alone | Phase 2 only | Modal HTML attributes restored; modal `mount*` functions deleted; aliases still intact (Phase 4 didn't ship yet OR phase 4 reverted too). |
| Revert Phase 1 alone | Phase 1 only | Commit modal attributes restored; pattern documentation in pilot module deleted. |
| Full revert | All 4 phases | Byte-equivalent restoration. Each phase's revert is independent. |

The migration is reversible at every phase boundary. This is the convention the [`docs/ROADMAP.md`](ROADMAP.md) §Decisions 7 *Removability check* asks for: each minor is its own removable slice.

---

## Open Questions

What this design pass could not resolve. Each must be answered before the relevant phase ships.

| Question | Why open | Resolution timing |
|---|---|---|
| Fold the `closeAllModals` refactor (`[HC] [S]` audit entry) into this migration? | Both touch modal close paths. `closeAllModals` currently hardcodes `.modal-overlay` selectors; the registry version would let each `mountXxxModal` register its close fn. Coupling them is tempting. | **Don't fold.** Each migration is reviewable on its own; bundling complicates the rollback boundary. The two PRs cross-reference, but ship separately. |
| Should renderers move to *event delegation on a single root* (e.g. one listener on `#chatMessages`) vs *per-mount document listeners*? | Per-mount is what the precedent does (branch-panel). One-root-per-surface is marginally more efficient. | Default to per-mount (precedent-matching). Revisit if Phase 3 measurement shows listener count is a perf hazard. |
| Migrate the `safeAdd` audit row (`[ST] [M]`) at the same time? | `safeAdd` wires *static-DOM* buttons via `addEventListener`; this migration wires *inline-HTML* buttons via `data-action`. Same axis, different surface. The `safeAdd` rewrite would also benefit from a `registerAction` API. | **Don't bundle.** Static-DOM buttons aren't broken; the inline-onclick path is. Ship this migration first, then revisit `safeAdd` as a follow-up minor. |
| Should the action vocabulary track the modal-registry refactor's action names? | If `closeAllModals` becomes registry-driven, a single `data-action="close"` per-modal-scoped would work. Today's decision (`data-action="closeCommitModal"`) preserves the explicit name. | Decided in *Decision 2*: don't anticipate the registry refactor. If it ships, the rename is a single sed pass; cheap to defer. |
| Plugin extension API impact — does third-party plugin code rely on `window.closeCommitModal` et al.? | The `window.*` block is partly documented as plugin API, partly internal. The cleanup in Phase 4 needs an explicit "stays public" list. | Pre-Phase 4: audit [`js/profiles/plugin-dev-v1.js`](../js/profiles/plugin-dev-v1.js) §extension channels + ask in the PR description for any external plugin that depends on a specific window function. Conservative default: keep any alias whose function exists in the documented extension API. |
| `chat/messages.js` density (~13 inline handlers) — own PR? | It's half of Phase 3. Splitting it from `issue-list`/`pr-list`/etc. is review-bandwidth optimization, not a technical requirement. | Author's call at Phase 3 PR time. The design admits either shape. |

---

## What This Document Commits To

- **The dispatcher shape is fixed.** Every migrated surface uses a `mountXxxModal({ onAction1, onAction2, ... })` function with a `document.addEventListener('click', ...)` listener scoped by `.closest('.surface-marker')` and routed by `data-action="..."` (Decisions 1–4).
- **Four phases, each independently shippable.** Phase 1 (pilot modal), Phase 2 (remaining modals), Phase 3 (JS renderers), Phase 4 (cleanup). Each phase carries its own removability check.
- **The audit row's umbrella decision is reached.** The parent `[ST] [L]` "53 inline onclick" entry closes after Phase 2; the sibling `[ST] [S]` "renderer inline onclick" entry closes after Phase 3; the `window.*` block shrinks in Phase 4.
- **CSP is an unblocked follow-on benefit, not the goal.** This migration makes a future strict-CSP PR viable; it doesn't ship CSP.
- **The `closeAllModals` refactor is intentionally not folded in.** Cross-references in the touch-points list above; sequential not bundled.
- **Reference patterns are the precedent, not new shapes.** [`mountBranchPanel`](../js/ui/branch-panel.js#L216) and [`mountSwitcherMenu`](../js/projects/switcher-menu.js#L161) are what the migration replicates. New surfaces should pattern-match against them.

These are the load-bearing decisions. Push back on any of them before Phase 1 ships.

---

## Implementation Status

The team updates this table as phases ship. Each row gets `planned` → `in flight` → `shipped at vX.Y.Z`. The audit-inventory rows close when Phase 2 (HTML side) and Phase 3 (JS-renderer side) ship.

| Phase | Scope | Status | Shipped | Notes |
|---|---|---|---|---|
| Phase 1 | Pilot — commit modal (~4 handlers) + dispatcher pattern | shipped | 2.27.0 | `mountCommitModal` in [`js/ui/commit.js`](../js/ui/commit.js) replicates `mountBranchPanel` shape; [`tests/test-commit-modal-dispatch.mjs`](../tests/test-commit-modal-dispatch.mjs) covers the dispatcher contract. `window.*` aliases stay through Phase 3. |
| Phase 2a | 8 clean-cut modals — revert, new branch, new file, rename, issue detail, zip upload, release, replay (~21 handlers) | shipped | 2.28.0 | Eight `mountXxxModal` fns in their existing owning modules; ~21 attrs migrated in [`html/modals.html`](../html/modals.html); 8 new dispatcher tests in [`tests/`](../tests/). `zipSelectAll` carries the only typed payload (`data-zip-select="all"/"none"`). `window.*` aliases stay. |
| Phase 2b | Remaining 3 modals — plugin (extract from app.js), create-PR (project-manager.js, optional extract), settings (orchestrator + tabs); plus non-modal HTML in editor-panel / chat-panel / settings-tabs | shipped | 2.29.0 | `mountSettingsModal` in [`js/settings-manager.js`](../js/settings-manager.js) (`#settingsModal` scope catches modals.html + settings-tabs.html). `mountCreatePRModal` in [`js/project-manager.js`](../js/project-manager.js) (clean co-location). `mountPluginModal` in new [`js/plugin-modal.js`](../js/plugin-modal.js) (extracted from app.js). `mountAppShellActions` in new [`js/ui/app-shell-actions.js`](../js/ui/app-shell-actions.js) (5 non-modal handlers across editor-panel + chat-panel). 4 new dispatcher tests; 11 HTML attrs migrated across modals.html / settings-tabs.html / editor-panel.html / chat-panel.html. `window.*` aliases stay through Phase 4. |
| Phase 3a | 7 simpler JS renderers — diff-viewer, file-tree, issue-list, tab-manager, chat/input, pr-list, issue-detail (retry) (~16 handlers) | shipped | 2.30.0 | One `mountXxx` per file scoped by container ID (`#fileTree`, `#issuesPanel`, `#prsPanel`, `#editorTabs`, `#imagePreviewStrip`, `.diff-controls`, `.issue-tab-content`). Typed payloads (`data-path`, `data-issue`, `data-index`, `data-mode`, `data-is-dir`) coerced at dispatcher edge. 7 new dispatcher tests (57 cases); `tests/test-issue-row-render.mjs` updated. Two `onkeydown=` strings in issue-list / pr-list remain (Phase 3 scope is `onclick=` only). `window.*` aliases stay through Phase 4. |
| Phase 3b | `js/chat/messages.js` alone (~13 handlers — `this`-passing + DOM-only `classList.toggle` per Decision 5) | planned | — | Splits the largest density-cluster into its own PR for review bandwidth |
| Phase 4 | `window.*` block cleanup (~80 LOC deletion) + anti-regression coverage test | planned | — | Closes the parent audit row's "window.* exposure block" rationale |

When all four phases ship: cross-reference the closures in [`docs/audit-2026-Q2/inventory.md`](audit-2026-Q2/inventory.md) (both rows strike-through) and note the CSP-unblock in [`docs/SECURITY.md`](SECURITY.md) §"What does NOT ship."
