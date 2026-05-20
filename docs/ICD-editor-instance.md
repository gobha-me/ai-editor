# ICD — Editor instance + tab-manager contract

> **Status:** initial draft, `RE-EVAL following 2.64.0`. Ninth subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #9 — the last named ICD-backfill target. Tracks the contract for the in-browser editing surface — the CodeMirror 6 loader + namespace registry ([`js/editor/setup.js`](../js/editor/setup.js), 436 LOC; `CM` 79-field namespace + `loadCodeMirror` vendor/CDN fallback + `getLanguageExtension` dispatch over 17 languages), the editor instance + per-buffer operations ([`js/editor/instance.js`](../js/editor/instance.js), 953 LOC; `editorInstance` module-local + `createEditor` boot + 22 named exports across content / cursor / line-range / Compartment-toggle surfaces), the three optional Compartment-installed decorations ([`js/editor/blame-gutter.js`](../js/editor/blame-gutter.js), 251 LOC; [`js/editor/invisible-unicode-decoration.js`](../js/editor/invisible-unicode-decoration.js), 215 LOC; [`js/editor/ghost-text.js`](../js/editor/ghost-text.js), 551 LOC with a four-state IDLE→REQUESTING→SHOWING→IDLE machine), two pure helper modules ([`js/editor/file-utils.js`](../js/editor/file-utils.js), 217 LOC; allowlist/denylist + content sniff for text-vs-binary detection; [`js/editor/diff.js`](../js/editor/diff.js), 51 LOC; line-by-line diff formatter), the barrel ([`js/editor.js`](../js/editor.js), 48 LOC; selective re-export — does NOT re-export `refreshGhostText` or the Compartment getters), and the workspace tab manager ([`js/tab-manager.js`](../js/tab-manager.js), 261 LOC; typed-tab dispatch over `file` / `issue` / `plugin-editor` / future types via the `_tabRenderers` registry). Tool admission is out of scope — the editing tools that call `replaceRange` / `insertAtLine` / `deleteRange` / `applyEdit` thread through [`ICD-tool-registry.md`](ICD-tool-registry.md) and [`ICD-profiles-registry.md`](ICD-profiles-registry.md) for admission; this ICD pins the editor-side write surface, not the gating. The plugin editor ([`js/plugin-editor.js`](../js/plugin-editor.js)) reuses `CM` + `loadCodeMirror` + `getLanguageExtension` for its own per-plugin CM instance but lives outside this ICD's surface — see [`ICD-plugin-lifecycle.md`](ICD-plugin-lifecycle.md). Prior ICDs ([#1 chat-handlers, 2.42.0; #2 intelligence-composers, 2.45.0; #3 tool-registry, 2.46.0 (superseded 2.54.0); #4 git-providers, 2.49.0; #5 retrieval-manager, 2.52.0; #6 MCP bridge, 2.55.0; #7 plugin lifecycle, 2.58.0; #8 profiles registry, 2.61.0](ROADMAP.md)) describe orthogonal seams; this ICD cross-references ICD #3 (the consumers of `applyEdit` / `replaceRange` / `insertAtLine` / `deleteRange` are tool handlers) and ICD #7 (`plugin-editor.js` is the second consumer of the `CM` namespace + the second creator of CM6 `EditorView` instances; the `'plugin-editor'` tab type is dispatched by this ICD's tab manager). Code-aware findings from authoring feed back to ROADMAP as `[strong]` / `[medium]`-band rows for the next code minor; **four** surface this pass (see §"Code-aware findings").

## Purpose

CodeMirror 6 is the load-bearing editing primitive; the editor module wraps it with the project-specific shape — a single global editor instance, a Compartment-based decoration model (line numbers / keybinding mode / blame / invisible-Unicode / ghost-text), a line/range mutation surface that the LLM tool handlers drive, and a tab manager that decides whether to mount the editor at all (file tabs) or hand the editor container to a custom renderer (issue, PR, plugin-editor tabs).

**Two coupling points are load-bearing across this seam.** First, the single global `editorInstance` module-local at [`js/editor/instance.js:27`](../js/editor/instance.js) — every consumer (toolbar, LLM tools, ghost-text, blame, invisible-Unicode, settings toggles) reads or mutates *this* instance. `createEditor` destroys the prior instance before installing a new one; there is no multi-instance contract. Second, the CM6 Compartment-ordering invariant at [`js/editor/instance.js:74–98`](../js/editor/instance.js) — the keymap compartment + ghost-text compartment must precede `basicSetup` in the extensions array because CM6 evaluates extensions in order and the first registration of a key binding wins. Reordering would silently silence Vim mode or the ghost-text Tab/Esc bindings. The two-line ordering rule is the most important invariant in this ICD.

**This ICD freezes the editor-instance singleton shape, the CM6 extension ordering rule (keymap → ghost-text → basicSetup → line-numbers → theme → wrapping → blame → invisible-Unicode → language), the three opt-in decoration Compartments (blame / invisible-Unicode / ghost-text — all lazy-instantiated via `getXCompartment()`), the ghost-text state machine (`idle` → `requesting` → `showing` → `idle` driven by four `StateEffect`s + a single module-local `_inFlight` flag + `_activeAbort` AbortController), the tab-manager type-dispatch table (`file` falls through to `createEditor`; everything else dispatches via `_tabRenderers[type]`), and the vendor-vs-CDN loading strategy (local bundle preferred; `esm.sh` fallback; per-extension defensive null-checks for both paths) so the next contributor reading the code can see what's load-bearing vs. incidental.**

## The seam at a glance

| | Surface | Path | LOC | Role |
|---|---|---|---|---|
| **Singleton instance** | `editorInstance` module-local (1 public export — read-only by convention) + `createEditor(container, content, filename)` async boot | [`js/editor/instance.js`](../js/editor/instance.js) | 953 | Single global CM6 `EditorView` owner; prior instance destroyed before re-create |
| **Operations bank** | 22 named exports — `setContent` / `getContent` / `getSelection` / `getCursorContext` / `replaceSelection` / `insertAtCursor` / `goToLine` / `selectRange` / `highlightRange` / `focus` / `applyEdit` + 7 line/range helpers (`getLineInfo` / `getLineRange` / `replaceRange` / `insertAtLine` / `replaceText` / `deleteRange`) + 4 Compartment toggles (`setKeybindingMode` / `refreshGhostText` / `setInvisibleUnicodeEnabled` / `setLineNumbersVisible`) | [`js/editor/instance.js`](../js/editor/instance.js) | 953 | Read + mutate the live `editorInstance.state.doc`; emit `editor:*` events |
| **CM6 loader + namespace** | `CM` 79-field object (default null until populated) + `loadCodeMirror()` async + `getLanguageExtension(filename)` over 17 languages | [`js/editor/setup.js`](../js/editor/setup.js) | 436 | Vendor bundle preferred; `esm.sh` fallback with per-extension defensive null-checks + dynamic `basicSetup` build-from-parts when meta-package fails |
| **Blame decoration** | `getBlameCompartment()` (lazy) + `setBlameData(view, ranges)` / `clearBlameData(view)` (3 exports) | [`js/editor/blame-gutter.js`](../js/editor/blame-gutter.js) | 251 | Gutter column that only appears when blame data is set; uses `StateField` + `StateEffect` for live updates |
| **Invisible-Unicode decoration** | `getInvisibleUnicodeCompartment()` (lazy) + `buildInvisibleUnicodeExtension(filename, enabled)` + `setInvisibleUnicodeMode(view, filename, enabled)` (3 exports) | [`js/editor/invisible-unicode-decoration.js`](../js/editor/invisible-unicode-decoration.js) | 215 | Inline widgets for zero-width / bidi-override / glassworm chars; click-to-delete + `Mod-Shift-U` strip-in-selection |
| **Ghost-text decoration** | `getGhostTextCompartment()` (lazy) + `buildGhostTextExtension()` + `refreshGhostTextExtension(view)` + 6 internal-but-exported helpers (`GHOST_TEXT_DEFAULTS` / `getGhostTextSettings` / `isGhostTextDisabledByFlag` / `triggerCompletion` / `acceptCompletion` / `dismissCompletion`) + 2 test-only exports (`_getThrottleStateForTest` / `_resetForTest`) + `isAtIndentContext` pure helper (12 exports) | [`js/editor/ghost-text.js`](../js/editor/ghost-text.js) | 551 | Single-flight LLM completion overlay; `idle`→`requesting`→`showing` state machine; Tab/Esc keymap with indent carve-out; `?ghostText=off` URL kill-switch |
| **File-type detection** | `isTextFile(filename)` / `isBinaryFile(filename)` / `looksLikeText(content)` / `getFileIcon(filename, isDir?)` (4 pure exports) | [`js/editor/file-utils.js`](../js/editor/file-utils.js) | 217 | Allowlist (`TEXT_EXTENSIONS` + `TEXT_FILENAMES`) + content sniff fallback; zero CM dependency |
| **Diff utilities** | `computeSimpleDiff(original, updated)` + `formatDiffForDisplay(diff)` (2 pure exports) | [`js/editor/diff.js`](../js/editor/diff.js) | 51 | Line-by-line diff for the post-edit confirmation banner |
| **Barrel** | `js/editor.js` — 19 selective re-exports | [`js/editor.js`](../js/editor.js) | 48 | Most external consumers route through here; deep imports reserved for `plugin-editor.js` (CM namespace), `secondary-pane.js` (blame + `editorInstance`), `pr-review/PrReviewDock.js` (`applyEdit`) |
| **Tab manager** | `registerTabRenderer(type, fn)` + `switchToTab(index)` + `closeTab(index, event?)` + `pinTab(index)` + `renderEditorTabs()` + `mountTabManager({onSwitchTab, onCloseTab})` + `initTabChangeListener()` (7 exports) | [`js/tab-manager.js`](../js/tab-manager.js) | 261 | Typed-tab dispatch (`file` → `createEditor`; `issue` / `plugin-editor` / future → `_tabRenderers[type]`); preview-vs-pinned tab idiom; delegated click handler scoped to `#editorTabs` |

Total surface: **9 files / ~2983 LOC** under one ICD. `instance.js` dominates at 32% of the total LOC; the three Compartment decorations together (1017 LOC) are another 34%; `setup.js` (15%) carries the load-bearing CM6 boot path.

## The five classification axes

Each axis names a question the seam answers across the singleton, the loader, the decorations, and the tab manager. The first two axes (Loading, Lifecycle) describe *how the editor gets installed and replaced*; the next two (Editing, Decoration) describe *what callers do with the live instance*; the last (Tabbing) describes *what gets installed at all*.

| Axis | Question | Where it's declared | Where it's read |
|---|---|---|---|
| **Loading axis** | How does CodeMirror 6 get into the page, and how are its module references made available to callers? | [`js/editor/setup.js`](../js/editor/setup.js) — `loadCodeMirror()` tries the local vendor bundle (`vendor/codemirror-bundle.js`) first via dynamic `import()`; on failure (air-gap or Docker rebuild gap) falls back to the single CDN provider (`esm.sh`) and parallel-`Promise.all`s six core packages + lazily loads the theme + Vim plugin + 13 language modules. **Every CDN-path assignment uses optional-chaining + a `?.` against the source module** (`cmView?.keymap`, `cmView?.gutter`, `cmView?.Decoration`, etc.) so a partial CDN response degrades to "extension missing from CM namespace" rather than throwing during boot; the vendor-bundle path makes the same assignments without `?.` because the bundle either imports cleanly or the whole import fails (atomic). The `CM` export is a 79-key object pre-populated with `null` (or `{}` for `languages`) — it functions as a public-mutable namespace, intentional (every assignment in `loadCodeMirror` is a write into this object; consumers read after `editor:loaded` fires). | `editor:loading` event fires before each attempt (vendor / per CDN); `editor:loaded` fires once on success with `'CodeMirror loaded from local vendor'` or `'CodeMirror loaded from <CDN>'`; `editor:error` fires only when all paths exhaust. Consumers: [`js/app.js`](../js/app.js) boot sequence (calls `loadCodeMirror` before any tab opens); [`js/editor/instance.js#createEditor`](../js/editor/instance.js) (defensive re-call if `CM.EditorView` is still null when first edit happens); [`js/plugin-editor.js`](../js/plugin-editor.js) (second consumer of `CM` for the plugin-editor tab; shares one `CM` namespace, never re-loads). `getLanguageExtension(filename)` is read on every `createEditor` call to install the per-buffer language extension. |
| **Lifecycle axis** | How does the singleton `editorInstance` get installed, replaced, and reset, and what guarantees the prior instance's resources are released? | [`js/editor/instance.js#createEditor`](../js/editor/instance.js) at `:38`. Three lifecycle stages: (1) **Defensive load** — if `CM.EditorView` is still null, call `loadCodeMirror()`; throw on failure. (2) **Destroy prior** — if the module-local `editorInstance` is non-null, call `editorInstance.destroy()` (CM6's built-in resource releaser); `container.innerHTML = ''` clears the DOM mount. (3) **Build extensions in order** — keymap compartment FIRST (vim-precedes-basicSetup invariant per [`instance.js:74–87`](../js/editor/instance.js)), ghost-text compartment SECOND (Tab/Esc precedes basicSetup's `indentWithTab` per [`instance.js:90–98`](../js/editor/instance.js)), then `basicSetup`, then line-number compartment, then theme, then keymap-of(`indentWithTab` + `defaultKeymap` + `historyKeymap`), then `updateListener` for `editor:change` + `editor:cursorActivity`, then `lineWrapping`, then blame compartment (initialized empty), then invisible-Unicode compartment, then per-buffer language extensions. The new `EditorView` is constructed at `:181` and assigned to the module-local. `editor:created` fires with `{filename}`. **Per-instance Compartments live in `createEditor` locals** (`lineNumberCompartment`, `keymapCompartment`, plus the ghost-text compartment is shared at module scope in `ghost-text.js` because its StateField needs to outlive single instances for keymap restoration) — the local compartments are garbage-collected when the next `createEditor` runs. | The lifecycle is closed: every consumer that needs to react to a fresh editor listens for `editor:created` and re-runs any per-buffer setup (blame data attach in `secondary-pane.js`; toolbar enable/disable in `tab-manager.js#_setEditorToolbar`). No external code reaches the prior `editorInstance` after `destroy()` — the module-local rebind is atomic from JS's perspective. **There is no explicit teardown API**; the assumption is that the editor is destroyed only by being replaced (next `createEditor`) or by leaving the page entirely (browser tear-down). See §"Code-aware findings" #1. |
| **Editing axis** | How do tool handlers + UI callers read and mutate the live document, and what are the unit + range contracts? | [`js/editor/instance.js`](../js/editor/instance.js) — 7 line/range helpers + 11 selection/cursor/content helpers + 4 Compartment toggles. **Two coordinate systems coexist**: (a) **Character offsets** in the CM6 document (`from`, `to` as zero-indexed `number`) — used by `replaceSelection`, `insertAtCursor`, `highlightRange`, `replaceText` (internally, after the unique-match lookup). (b) **1-indexed line numbers** with optional 1-indexed column — used by `goToLine` / `selectRange` / `getLineInfo` / `getLineRange` / `replaceRange` / `insertAtLine` / `deleteRange`. The two-coordinate model is intentional: tool handlers (`edit_lines`, `insert_at_line`, `delete_lines`) speak line-number because that's what the LLM model emits; cursor-and-selection helpers (`replaceSelection`, `insertAtCursor`) speak offsets because the source-of-truth selection is offset-based. **Clamping is uniform**: every line-number arg is `Math.max(1, Math.min(arg, doc.lines))`; every column arg is `Math.max(1, Math.min(arg, lineText.length + 1))`. **Long-selection truncation** at `replaceSelection` / `getCursorContext` / `selectRange`: `MAX_SELECTION_CHARS = 3000` + `MAX_SELECTION_LINES = 60`; over-budget selections truncate at the midpoint with an inline `... (N lines total, truncated) ...` marker. The 11 mutating helpers all dispatch via `editorInstance.dispatch({changes, selection?, scrollIntoView?})` — CM6's transaction primitive. State writes are mirrored to `State.editorContent` + `State.editorDirty = true`, and `tab:contentChanged` fires with the current `State.currentFile.path`. **Mutation events** (in registration order): `editor:change` (any doc mutation; `updateListener` fires it); `editor:cursorActivity` (selection or doc change; cursor-context snapshot); `editor:editApplied` (`applyEdit` only; `{original, updated}` payload for the diff banner); `editor:linesReplaced` / `editor:linesInserted` / `editor:linesDeleted` (the three range-mutation surfaces; payload includes `oldLineCount` + `newLineCount` + `totalLines` for the post-edit summary). | Every LLM editing tool call routes through one of these surfaces. [`js/tools/edit-tools.js`](../js/tools/edit-tools.js) consumes `replaceRange` / `insertAtLine` / `deleteRange` (admission per `ICD-profiles-registry.md`'s `coder.v1` profile + the `tools.admit` array). [`js/tools/cursor-tools.js`](../js/tools/cursor-tools.js) wraps the cursor-and-selection helpers. [`js/tools/multifile-tools.js`](../js/tools/multifile-tools.js) drives `replaceRange` / `insertAtLine` / `deleteRange` for cross-file plans. [`js/chat/handlers.js`](../js/chat/handlers.js) consumes `applyEdit` + `computeSimpleDiff` for the diff banner. [`js/pr-review/PrReviewDock.js`](../js/pr-review/PrReviewDock.js) deep-imports `applyEdit` to drop suggested fixes into the open buffer. The 4 Compartment toggles are wired from Settings → Appearance (`setLineNumbersVisible`, `setInvisibleUnicodeEnabled`), Settings → Editor (`setKeybindingMode`), and Settings → Ghost Text (`refreshGhostText` — invoked by [`js/utils/apply-visual-settings.js`](../js/utils/apply-visual-settings.js) on settings persistence). |
| **Decoration axis** | What are the three opt-in Compartment-installed decorations, and how do they share the editor view without colliding? | Three independent Compartments, all lazy-instantiated, all reading from a single `CM.Compartment` constructor: [`blame-gutter.js#getBlameCompartment`](../js/editor/blame-gutter.js), [`invisible-unicode-decoration.js#getInvisibleUnicodeCompartment`](../js/editor/invisible-unicode-decoration.js), [`ghost-text.js#getGhostTextCompartment`](../js/editor/ghost-text.js). Each follows the same shape: module-local `_compartment` cached on first call; null until `CM.Compartment` is populated; consumers gate on `if (comp) extensions.push(comp.of(<initial>))`. **The blame Compartment starts empty** (`comp.of([])`) — no gutter column is rendered until `setBlameData(view, ranges)` reconfigures it with the gutter extension. **The invisible-Unicode Compartment is populated by `buildInvisibleUnicodeExtension(filename, enabled)`** — checks `shouldScan(filename)` per the `js/security/invisible-unicode.js` allowlist; returns `[]` when disabled or out-of-scope (binary / image / etc.). **The ghost-text Compartment is populated by `buildGhostTextExtension()`** — reads `State.settings.ghostText.enabled` + the URL flag; returns `[]` when off (zero-cost, no decoration, no keymap binding); when on returns `[field, plugin, theme, km]`. Ghost-text's `StateField` holds `{status, anchor, suggestion?, requestId?}`; transitions are driven by four `StateEffect`s (`requested` / `received` / `accepted` / `dismissed`) defined once at module scope in `_getEffects()`. Network calls live module-local (`_inFlight` flag + `_activeAbort` `AbortController` + `_requestSeq` counter) outside CM transactions — by design, per the docstring at [`ghost-text.js:27`](../js/editor/ghost-text.js) ("the network promise lives outside CM transactions"). | Settings UI: [`js/settings/appearance-tab.js`](../js/settings/appearance-tab.js) toggles blame + invisible-Unicode visibility; [`js/settings/ghost-text-tab.js`](../js/settings/ghost-text-tab.js) — if present — toggles ghost-text enable + hotkey. Per-buffer dispatch: blame reads from `setBlameData(view, ranges)` after Git provider fetches the blame data ([`js/secondary-pane.js`](../js/secondary-pane.js)); invisible-Unicode reads from `setInvisibleUnicodeMode(view, filename, enabled)` whenever the active file changes; ghost-text reconfigures on `State.settings.ghostText` mutation via `refreshGhostTextExtension(view)` (called from [`instance.js#refreshGhostText`](../js/editor/instance.js)). |
| **Tabbing axis** | What decides whether the editor mounts at all on a tab, and how do non-file tab types render into the same container? | [`js/tab-manager.js`](../js/tab-manager.js) — `_tabRenderers` module-local object keyed on tab-type string; each value is `async (container: HTMLElement, tab: object) => void`. Registration happens once at init time per feature module: [`js/issue-detail.js`](../js/issue-detail.js) registers `'issue'`; [`js/plugin-editor.js`](../js/plugin-editor.js) registers `'plugin-editor'`. `switchToTab(index)`'s type-dispatch rule: if `tab.type` is set and a renderer is registered for it, route to the renderer + clear `State.currentFile` + disable the editor-toolbar (`#btnTogglePreview` / `#btnToggleDiff` / `#btnToggleBlame` set to `disabled`) + close the secondary pane; otherwise treat as `'file'` and call [`createEditor(container, content, path)`](../js/editor/instance.js). `closeTab(index)` warns on `dirty` for `'file'` + `'plugin-editor'` types only — other tab types are assumed dirty-free (custom renderers manage their own dirty state if needed). **Preview-vs-pinned idiom**: tabs open with `isPreview: true` (italic / dimmed in the tab bar); double-click pins via `pinTab(index)`; editing pins automatically via the `editor:change` listener in `initTabChangeListener()`. The delegated click handler in `mountTabManager` is scoped to `#editorTabs` so the document-level listener survives `renderEditorTabs()`'s `innerHTML` rewrites. | Five callers consume the tab manager: [`js/app.js`](../js/app.js) (boot — `mountTabManager` + `initTabChangeListener`); [`js/file-tree.js`](../js/file-tree.js) (file open creates a `'file'` tab); [`js/issue-detail.js`](../js/issue-detail.js) (`'issue'` tab + renderer registration); [`js/plugin-editor.js`](../js/plugin-editor.js) (`'plugin-editor'` tab + renderer registration); [`js/ui/commit.js`](../js/ui/commit.js) + [`js/ui/revert.js`](../js/ui/revert.js) (post-action `renderEditorTabs()` refresh). The renderer registry has no de-registration API — feature modules register at init and renderers live for the page lifetime. |

Five axes × **9 files / ~2983 LOC** × 3 Compartment decorations × 4 module-local lifecycles (`editorInstance` / `_inFlight` ghost-text / `_compartment` per decoration / `_tabRenderers` registry) × 2 coordinate systems (offset / line-number) is the surface this ICD pins.

## Per-axis contract

### Loading axis — vendor-preferred fallback + per-extension defensive nulling

**The `CM` namespace is a 79-key writable object** ([`setup.js:22–86`](../js/editor/setup.js)). Pre-load every value is `null` (or `{}` for `CM.languages`); post-load every populated key holds a CM6 module reference. Consumers must wait for `editor:loaded` before reading from `CM` — or rely on `createEditor`'s defensive `loadCodeMirror()` re-call.

**Two loader paths share the namespace.** The vendor path ([`setup.js:96–170`](../js/editor/setup.js)) imports a single bundle (`vendor/codemirror-bundle.js`) and reads named exports off it (`bundle.cmView`, `bundle.cmState`, etc.); assignments are direct (no `?.`). The CDN path ([`setup.js:230–388`](../js/editor/setup.js)) imports six packages in parallel and assigns with `?.` everywhere because `esm.sh`'s response shape can vary (a missing sub-export degrades the feature, not the boot). The CDN path also has a **build-fallback `basicSetup`** branch ([`setup.js:301–338`](../js/editor/setup.js)) that assembles `basicSetup` from individual extensions when the meta-package's `basicSetup` export is missing.

**`getLanguageExtension(filename)`** is a dispatch table over 17 languages mapped from [`prompts.js#getLanguageFromPath`](../js/prompts.js). Unknown extensions return `[]`. A loaded-but-language-missing fallthrough also returns `[]` with a `console.warn`.

**Invariants:**
- `CM` is the single source for CM6 module refs; no other module reaches into `node_modules` / dynamic imports for CM packages.
- The order of CDN imports is parallel (`Promise.all`) — none of them depend on each other; if dependencies emerge, the parallel shape becomes sequential.
- Per-extension `?.` is load-bearing on the CDN path — removing them would surface a single CDN sub-export miss as a boot-time `TypeError` that breaks the whole editor.
- `editor:loaded` fires exactly once per page load (vendor success short-circuits the CDN loop; CDN success short-circuits the per-provider loop).

### Lifecycle axis — destroy-then-replace; per-instance compartments are GC'd implicitly

**`createEditor`** is the sole `EditorView` constructor ([`instance.js:38`](../js/editor/instance.js)). Every call destroys the prior `editorInstance` (CM6's `destroy()` releases its DOM mount + event listeners + StateField subscribers) before constructing a new one. The function accepts both positional args (`container, content, filename`) and an options object (`{container, doc, filename}`) for forward-compat; the call sites today are positional.

**The keymap-compartment-before-basicSetup invariant** ([`instance.js:74–87`](../js/editor/instance.js)):

```js
keymapCompartment = CM.Compartment ? new CM.Compartment() : null;
if (keymapCompartment) {
    const mode = AppState.settings.editorKeybindingMode || 'default';
    extensions.push(keymapCompartment.of(buildKeymapExtension(mode)));
}
// Ghost-text compartment SECOND
const ghostTextCompartment = getGhostTextCompartment();
if (ghostTextCompartment) {
    extensions.push(ghostTextCompartment.of(buildGhostTextExtension()));
}
// THEN basicSetup
if (Array.isArray(CM.basicSetup)) extensions.push(...CM.basicSetup);
else if (CM.basicSetup) extensions.push(CM.basicSetup);
```

Reordering would let `basicSetup`'s `defaultKeymap` claim `Esc/i/h/j/k/l` and `Tab` first, silencing Vim mode and the ghost-text Tab/Esc bindings without throwing. The docstring at `:78–82` calls this out — this ICD pins it as load-bearing across the lifecycle.

**Compartment ownership** is mixed:
- **Per-instance** (locals in `createEditor` — GC'd when `editorInstance` is replaced): `lineNumberCompartment`, `keymapCompartment`.
- **Module-scope** (singletons across the page lifetime): blame / invisible-Unicode / ghost-text compartments, all from their respective `getXCompartment()` lazy getters. The ghost-text StateField also lives module-scope because its keymap restoration logic relies on `Vim.defineEx` being defined at most once per session.

**Invariants:**
- `editorInstance` is exported as `let` (rebindable from inside the module only; external consumers should treat it as read-only).
- `createEditor` always emits `editor:created` on success; consumers re-attach per-buffer state in response.
- The async return is the `editorInstance` value — tests can resolve on it; the production callsite ignores it because the module-local is the source of truth.

### Editing axis — two coordinate systems, uniform clamping, mirror-to-State

The 11 mutating helpers fall into three groups:

1. **Selection-based** (3): `replaceSelection(text)`, `insertAtCursor(text)`, `replaceText(find, replacement)`. Operate on the current cursor / selection or on a unique substring match. `replaceText` requires uniqueness — multi-match returns `{error: 'Found N matches…'}` so the LLM doesn't guess.
2. **Line/range-based** (4): `replaceRange(startLine, endLine, newContent)`, `insertAtLine(afterLine, content)`, `deleteRange(startLine, endLine)`, `replaceText` (above). All accept 1-indexed lines + clamp to `[1, doc.lines]`.
3. **Whole-document** (3): `setContent(content, preserveHistory?)`, `applyEdit(newContent)`, `highlightRange(from, to)`.

**Uniform clamping:** every line-number arg is `Math.max(1, Math.min(arg, doc.lines))`; every column arg is `Math.max(1, Math.min(arg, lineText.length + 1))`. Out-of-bounds args don't throw — they clamp + the return shape reports the actual range mutated.

**Mirror-to-State:** every mutation writes `State.editorContent = editorInstance.state.doc.toString()` + `State.editorDirty = true` + emits `tab:contentChanged` with `State.currentFile.path` (when present). The `updateListener` registered in `createEditor` covers the doc-change path; the imperative helpers cover their own writes for tools that need synchronous state.

**Long-selection truncation** (`MAX_SELECTION_CHARS = 3000`, `MAX_SELECTION_LINES = 60`) applies to `getCursorContext`, `replaceSelection`, `selectRange`; truncation marker is `... (N lines total, truncated) ...`.

**Mutation event roster** (registered in `core.js` listeners + emitted by these helpers):
- `editor:change` — every doc mutation (from `updateListener`).
- `editor:cursorActivity` — selection-set or doc-changed; payload is `getCursorContext()` snapshot.
- `editor:editApplied` — `applyEdit` only; `{original, updated}` for the diff banner.
- `editor:linesReplaced` / `editor:linesInserted` / `editor:linesDeleted` — line-range helpers; payload includes line counts + total.
- `editor:created` — `createEditor` success.

**Invariants:**
- No mutation helper accepts out-of-bounds args without clamping; throws are reserved for "no editor instance" / "no selection" / "uniqueness violated" cases.
- `replaceText`'s uniqueness check is load-bearing — it's the primary reason LLM tool handlers preferred it for surgical edits before the line-range surface generalized in 2.0.x.
- Every mutating helper emits a single event per dispatch — listeners can rely on one-emit-per-call.

### Decoration axis — three Compartments, three lifecycles, one editor

All three opt-in decorations share the same Compartment-as-singleton shape but differ in lifecycle:

- **Blame** is **data-driven** — empty by default; `setBlameData(view, ranges)` reconfigures the Compartment to install the gutter + populate `StateField` content; `clearBlameData(view)` reconfigures to empty. The gutter column physically disappears when empty.
- **Invisible-Unicode** is **per-file** — `buildInvisibleUnicodeExtension(filename, enabled)` checks `shouldScan(filename)` ([`js/security/invisible-unicode.js`](../js/security/invisible-unicode.js)) before producing the StateField; binary / image / known-noisy files return `[]`. `setInvisibleUnicodeMode(view, filename, enabled)` re-runs the check on every active-file change.
- **Ghost-text** is **settings-driven + URL-overridable** — `buildGhostTextExtension()` reads `State.settings.ghostText.enabled` + checks `?ghostText=off` URL flag; returns `[]` when off. `refreshGhostTextExtension(view)` is the only mutator; called from `instance.js#refreshGhostText` (which is *not* re-exported through the barrel — see §"Code-aware findings" #4).

**Ghost-text state machine** (`idle` → `requesting` → `showing` → `idle`):

| Effect | Trigger | Transition | Side effect |
|---|---|---|---|
| `requested` | Tab keypress (indent carve-out passes) + `_inFlight === false` | `idle → requesting` | `_inFlight = true`; new `AbortController`; `EventBus.emit('ghostText:requested')` |
| `received` (non-empty) | Network response | `requesting → showing` | Show widget at anchor |
| `received` with empty suggestion | Network response trimmed-empty | `requesting → idle` (silent) | `EventBus.emit('ghostText:empty')` |
| `accepted` | Tab keypress with status `showing` | `showing → idle` | Insert suggestion at anchor; `EventBus.emit('ghostText:accepted')` |
| `dismissed` | Esc / typing / cursor move while requesting OR showing | any → `idle` | Abort if in-flight; `EventBus.emit('ghostText:dismissed')` |
| `dismissed` (network failure) | Promise reject (non-Abort) | `requesting → idle` | `EventBus.emit('ghostText:failed')` |

`_inFlight` clears in the `.finally()` of the request promise — guaranteed even on abort. `_activeAbort === abort` guards against late-finally races (the `refreshGhostTextExtension` mid-flight reconfigure flow can replace `_activeAbort` before the `finally` runs).

**Invariants:**
- Compartment getters are idempotent — repeat calls return the same instance.
- All three decoration extensions return `[]` when disabled — the Compartment installs zero-cost; toggling on/off doesn't require re-creating the editor.
- Ghost-text's network promise is the only Compartment-decoration boundary that crosses out of CM transactions — by design, per the file-header docstring at [`ghost-text.js:27–28`](../js/editor/ghost-text.js) ("The throttle and abort live module-local (not in editor state) because / the network promise lives outside CM transactions").

### Tabbing axis — type-dispatch table + delegated click handler

`_tabRenderers` is the registry; registration is one-way (no de-register). `switchToTab(index)`'s dispatch rule:

```js
const tabType = tab.type || 'file';
if (tabType !== 'file' && _tabRenderers[tabType]) {
    State.currentFile = null;          // editor toolbar disables
    State.editorContent = '';
    State.editorDirty = false;
    _setEditorToolbar(false);
    closeSecondaryPane();
    await _tabRenderers[tabType](container, tab);
} else {
    // file tab → mount editor
    State.currentFile = {path, content, sha};
    State.editorContent = tab.content;
    _setEditorToolbar(true);
    await createEditor(container, tab.content, tab.path);
}
```

Both branches end with `renderEditorTabs()` + `EventBus.emit('tab:switched', {index, tab})`.

**`closeTab(index)`'s dirty-prompt cohort** is `file` + `plugin-editor` only; all other types are assumed dirty-free. The confirm dialog uses `showConfirm` with the `danger` variant.

**Preview-vs-pinned idiom**: tabs open with `isPreview: true`; double-click pins via `pinTab`; the first text mutation also pins (in `initTabChangeListener` — `if (tab.isPreview) tab.isPreview = false`).

**`mountTabManager({onSwitchTab, onCloseTab})`** binds a single delegated `click` listener at `document` scope, filtered to `#editorTabs` ancestor — the listener survives `renderEditorTabs()`'s `innerHTML` rewrites. The `ondblclick` pin handler remains inline on each tab element (per the inline-handlers migration's Phase 3 scope which covered `onclick` only).

**Invariants:**
- Tab-type-string is the dispatch key; unknown types fall back to `'file'` semantics and would attempt `createEditor` with the tab's `content` + `path` (likely a runtime error if `path` is missing).
- `closeTab` of the active tab triggers `switchToTab` to the new active index; closing the only tab clears `State.currentFile` + renders a "Select a file to edit" welcome banner.
- `registerTabRenderer` overrides any prior registration for the same type (last-write-wins) — there is no idempotency guard.

## Open invariants

The following hold today but aren't asserted in code or tests; they're documented here so a future contributor doesn't silently break them:

1. **`editorInstance` is the singleton** — every editor-side consumer reads or writes through this one module-local. The codebase has no path that constructs a second `EditorView` against the main `#editorContainer`. The plugin-editor builds its own `EditorView` against a different DOM mount and stays out of this singleton's lane.

2. **Keymap-compartment ordering** — keymap → ghost-text → basicSetup → line-numbers → theme → wrapping → blame → invisible-Unicode → language. Documented in two adjacent comment blocks at [`instance.js:74–98`](../js/editor/instance.js); not asserted by any test. (See §"Code-aware findings" #2 for the proposed pin.)

3. **`CM` namespace mutability post-load** — every key is written at most twice (once via vendor path, once via CDN path; only one path runs per load). The namespace stays mutable after `loadCodeMirror` resolves so the CDN-with-Vim-fallback path can populate `CM.vim` after the initial parallel-import promise settles. A future hardening pass could `Object.freeze` after `editor:loaded` — but only after auditing every assignment site.

4. **Per-instance Compartments leak into GC** — `lineNumberCompartment` + `keymapCompartment` are locals to `createEditor`; the next `createEditor` rebinds them and the prior instances are eligible for garbage collection (the prior `editorInstance` lost its reference via `.destroy()`'s teardown). This is *implicit* — there's no test that proves the prior Compartments are unreachable. See §"Code-aware findings" #1.

5. **Vendor-vs-CDN drift detection** — both paths populate the same 79-key `CM` namespace; a drift (key present in vendor, missing in CDN, or vice versa) would surface as silent feature degradation (the `?.` chain on CDN), not a thrown error. No drift-detection test exists.

6. **Custom tab renderer cleanup** — `closeTab` removes the tab's DOM slot but doesn't call any cleanup callback on the renderer. A renderer that registered DOM listeners or timers against the `container` element relies on `tab-manager.js`'s subsequent `container.innerHTML = ''` (or the next `switchToTab` overwriting it) for cleanup. This mirrors the pre-2.64.0 `Plugins.setEnabled(id, false)` finding that ICD #7 closed for the plugin lifecycle — analogous gap here for UI tabs. See §"Code-aware findings" #3.

7. **`refreshGhostText` is not in the barrel** — every other Compartment toggle (`setLineNumbersVisible`, `setKeybindingMode`, `setInvisibleUnicodeEnabled`) is re-exported from `js/editor.js`. `refreshGhostText` is reachable only via the deep import `import { refreshGhostText } from './editor/instance.js'`. See §"Code-aware findings" #4.

## Code-aware findings

Surfaced while authoring this ICD; banded for ROADMAP triage. Counts: 1 `[strong]`, 2 `[medium]`, 1 `[strong] [S]`.

### ~~Finding #1 [medium] — Per-instance Compartments + `editorInstance` lack a unit-test on the destroy-then-replace contract~~ ✅ shipped 2.75.0

The lifecycle invariant — `createEditor` destroys the prior CM6 view + the next `createEditor` rebinds `editorInstance` and reassigns the module-scope `lineNumberCompartment` / `keymapCompartment` to fresh `new CM.Compartment()` instances (the prior Compartments become unreachable + GC-eligible) — had no regression test. The contract was hand-asserted via the two adjacent code-comment blocks at [`instance.js:58–61`](../js/editor/instance.js) (the destroy block) + [`instance.js:74,82`](../js/editor/instance.js) (the "Create fresh compartment" reassignments); a future contributor refactoring the destroy path could silently break it (e.g., by promoting either Compartment to `const` — would crash on reassignment but no test caught the structural drift; or moving them inside `createEditor` as function-locals — would change the GC mechanism from "module-scope rebind" to "function-local out-of-scope" and require a paired contract update).

**Fix shape (as shipped):** new [`tests/test-editor-lifecycle.mjs`](../tests/test-editor-lifecycle.mjs) source-scan test (no JSDOM required, mirroring [`tests/test-editor-compartment-ordering.mjs`](../tests/test-editor-compartment-ordering.mjs) one-for-one — reuses `stripComments` + `extractCreateEditorBody` + a sibling `findSingleMatch` helper that asserts the regex hits exactly once in the function body). Four subtests:
- `editorInstance.destroy()` is called inside `createEditor` before `editorInstance = new CM.EditorView(...)` (positive grep on the order; single-match assertion on each anchor).
- `lineNumberCompartment` is reassigned to a fresh `new CM.Compartment()` inside the `createEditor` body (positive grep on the `lineNumberCompartment = CM.Compartment ? new CM.Compartment() : null` shape; the count assertion is load-bearing — exactly one reassignment).
- `keymapCompartment` is reassigned to a fresh `new CM.Compartment()` inside the `createEditor` body (same shape).
- Module-scope declarations exist: `^let lineNumberCompartment = null;$` AND `^let keymapCompartment = null;$` at the file's left margin (forward-evolution guard — promoting either to `const` breaks reassignment, moving inside `createEditor` changes the GC mechanism; both refactors are valid futures but demand a paired test + ICD wording update).

**Why the pin shape is module-scope reassignment, not function-local declaration.** The actual code declares both Compartments as module-scope `let`s at [`instance.js:30,32`](../js/editor/instance.js), not as function-locals. Every `createEditor` call reassigns both refs to fresh `new CM.Compartment()` instances at [`instance.js:74,82`](../js/editor/instance.js); the prior Compartment refs are dropped on that rebind + become GC-eligible (the prior `editorInstance` is already detached + `.destroy()`'d before the next view is constructed at [`instance.js:181`](../js/editor/instance.js), so no live view holds them). This is a valid replacement event — different mechanism from function-local out-of-scope GC, but the same end-state (prior Compartments unreachable). The test pins the actual mechanism; the forward-evolution guard ensures a future refactor that changes the mechanism can't land silently.

Pre-emptive — no live bug, but the destroy-then-replace contract is the most easily-broken invariant in the editor module. **Sizing:** [S] (single test file, ~165 LOC including docstring; zero production-file edits). Test shape mirrors 2.72.0's [`tests/test-editor-compartment-ordering.mjs`](../tests/test-editor-compartment-ordering.mjs) one-for-one.

### Finding #2 [strong] — Compartment-ordering invariant in `createEditor` is not pinned

Reordering keymap-compartment or ghost-text-compartment to land after `basicSetup` in the extensions array would silently silence Vim mode + ghost-text Tab/Esc bindings — CM6 evaluates extensions in order and earlier registrations win. The docstring at [`instance.js:74–87`](../js/editor/instance.js) calls this out explicitly with a five-line warning; the codebase has zero regression tests for the order.

**Fix shape:** a source-scan test that reads `js/editor/instance.js` and asserts:
- `keymapCompartment.of(buildKeymapExtension(mode))` appears in the source before `extensions.push(...CM.basicSetup)` / `extensions.push(CM.basicSetup)`.
- `ghostTextCompartment.of(buildGhostTextExtension())` appears between `keymapCompartment.of(...)` and the basicSetup push.

Same idiom as [`tests/test-chat-tool-name-literals.mjs`](../tests/test-chat-tool-name-literals.mjs) (string-literal grep over source) — pure-Node, no CM6 runtime. Cheap, surgical, and turns the most-fragile invariant in this ICD into a CI-gated contract. **Sizing:** [S] (~50 LOC, one test file, zero production-file edits).

### Finding #3 [medium] — Custom tab renderer has no cleanup callback (mirrors plugin-lifecycle `destroy()` finding closed 2.64.0)

`tab-manager.js#closeTab` removes the tab from `State.openTabs` + emits `tab:closed` + calls `renderEditorTabs()`. There is no `_tabRenderers[type].cleanup?.()` hook — a renderer that registered DOM event listeners against the `container` element on `switchToTab` relies on the implicit cleanup of the next renderer overwriting `container.innerHTML` (or the welcome banner clear when the last tab closes). This is the same shape as the pre-2.64.0 plugin-lifecycle gap that ICD #7 finding #1 closed: declared cleanup-affordance never invoked.

**Fix shape:** evolve `registerTabRenderer(type, renderer)` to also accept `registerTabRenderer(type, {mount, unmount})` (back-compat — a function-only argument keeps the old shape). `closeTab` + the renderer-swap branch of `switchToTab` call `unmount?.(container, tab)` when leaving a typed tab. Audit the two production renderers ([`js/issue-detail.js`](../js/issue-detail.js), [`js/plugin-editor.js`](../js/plugin-editor.js)) for resources they should release. Add a regression test mirroring [`tests/test-plugin-lifecycle.mjs`](../tests/test-plugin-lifecycle.mjs)'s destroy-called-once shape.

**Decision required** (band promotes from [medium] to [strong] if a real leak surfaces): is the implicit-via-innerHTML-clear behavior load-bearing for one of the two production renderers? If yes (e.g., an issue-tab listener is GC'd correctly only because the DOM is detached), this finding can stay parked; if no, ship the explicit `unmount` hook. **Sizing:** [M] (touches the registry shape + both production renderers + new test; likely <250 LOC across files).

### Finding #4 [strong] [S] — `refreshGhostText` missing from the `js/editor.js` barrel

Every other Compartment toggle exported from `instance.js` is re-exported through the barrel: `setLineNumbersVisible`, `setKeybindingMode`, `setInvisibleUnicodeEnabled`. `refreshGhostText` ([`instance.js:886`](../js/editor/instance.js)) is reachable only via `import { refreshGhostText } from './editor/instance.js'` — the deep import path. The single production consumer [`js/utils/apply-visual-settings.js`](../js/utils/apply-visual-settings.js) imports `setLineNumbersVisible` through the barrel; if it ever needs `refreshGhostText` it would either add a sibling deep import or this barrel gap would force a new deep-import path through the codebase.

**Fix shape:** add `refreshGhostText` to the `export { … } from './editor/instance.js'` block at [`js/editor.js:18–43`](../js/editor.js); audit consumers (today none import it; the gap is preventive). Pure mechanical — same five-character addition the 2.0.x stabilization track absorbs in stride. **Sizing:** [S] (one line; ~10 LOC test addition to pin the barrel surface, mirroring the §"Open invariant #5" suggestion in [`ICD-profiles-registry.md`](ICD-profiles-registry.md)'s shape-pin pattern).

## Other observations (not promoted)

- The `MAX_SELECTION_CHARS = 3000` + `MAX_SELECTION_LINES = 60` constants at [`instance.js:253–254`](../js/editor/instance.js) live as module-locals in `getCursorContext`'s neighborhood but are also used by `selectRange` at `:456`. The two callsites read the same constants; centralizing into a frozen constant export (or `Object.freeze({MAX_SELECTION_CHARS, MAX_SELECTION_LINES})`) is a future-cleanup candidate but not load-bearing.
- The `_setEditorToolbar(enabled)` helper at [`tab-manager.js:85–90`](../js/tab-manager.js) hardcodes three button IDs (`btnTogglePreview`, `btnToggleDiff`, `btnToggleBlame`). New toolbar buttons added later would need to remember to extend this list — a minor maintenance hazard.
- `getLanguageExtension`'s 17-entry dispatch table at [`setup.js:404–423`](../js/editor/setup.js) is parallel to `prompts.js#getLanguageFromPath`'s extension→language map; the two are drift-prone but currently coherent. A single source-of-truth helper is a future-cleanup candidate.
- The Vim ex-commands registration at [`instance.js:807–826`](../js/editor/instance.js) (`:w`, `:wq`) uses a `vimExCommandsRegistered` boolean for once-per-session idempotency. If a future contributor needs to re-register (e.g., HMR), the flag would block it; consider exposing a `resetVimExCommands` for test cohesion.

## Why the parts resist consolidation

- **`instance.js` is large (953 LOC)** but the 22 exports each operate on the singleton `editorInstance` — splitting into "content / cursor / range / Compartment toggles" sub-files would force every consumer to deep-import three files instead of one, and the barrel at `js/editor.js` is already the consolidation point. The 2.0.x stabilization arc could revisit this if a clear sub-axis emerges (e.g., the four Compartment toggles want their own module), but no production-code pressure exists today.
- **The three Compartment decorations stay independent** because their lifecycles (data-driven / per-file / settings-driven) don't share state. A unified "decorations" module would force a synthetic abstraction.
- **`file-utils.js` + `diff.js` stay separate** from the rest because they're CM-independent pure functions; consumers (`zip-upload.js`, `file-tree.js`, `chat/handlers.js`) need them without paying the CM6 dependency cost.
- **`tab-manager.js` is *one* layer above the editor** — it decides whether to mount the editor at all. Folding it into `editor/` would couple the editor module to the tab state model + the secondary-pane lifecycle; the current separation lets feature modules register typed-tab renderers without reaching into the editor.

## Forward-evolution rules

### When adding a new editor operation
- Add the export to `instance.js`; mirror the `editorInstance` null-guard + `State.editorContent` / `State.editorDirty` mirror + emit the appropriate `editor:*` event.
- If the operation is line-number-coordinate, apply uniform clamping (`Math.max(1, Math.min(arg, doc.lines))`).
- Re-export from `js/editor.js` barrel unless the operation is internal.
- Add a unit test in `tests/test-editor-instance.mjs` or a focused sibling (the test cohort doesn't enforce one-file-per-helper).

### When adding a new Compartment decoration
- New file under `js/editor/<name>.js`; mirror the `getCompartment()` lazy getter + `buildExtension()` + `setMode(view, ...)` triplet shape.
- Install in `createEditor` in the right position (decoration → after basicSetup; keymap-claiming → before basicSetup).
- Test that disabled-build returns `[]` (zero-cost compartment).
- Document in this ICD's "Decoration axis" table.

### When adding a new tab type
- Register via `registerTabRenderer(type, renderer)` from the feature module's init.
- Decide if the type should appear in the dirty-prompt cohort (`closeTab`'s `'file' || 'plugin-editor'` check).
- Decide if `_setEditorToolbar(false)` is appropriate (typed tabs disable the toolbar today; if a custom renderer wants the toolbar, the rule needs a per-type override).
- Add a test in `tests/test-tab-manager-dispatch.mjs` or a sibling.

### When changing the CM6 loader path
- Mirror every assignment between vendor + CDN paths to keep the 79-key `CM` namespace coherent.
- Add the new key to `CM`'s null-initialized declaration at `setup.js:22–86`.
- Add a CDN-path defensive `?.` chain.
- Audit consumers (grep `CM\.<key>`) — every site must `if (CM.<key>)` guard or the runtime crashes when the CDN path fails to populate.

## References

- Roadmap entry: [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #9.
- Prior ICDs in this program: [#1 chat-handlers](ICD-chat-handlers.md), [#2 intelligence-composers](ICD-intelligence-composers.md), [#3 tool-registry](ICD-tool-registry.md) (superseded), [#4 git-providers](ICD-git-providers.md), [#5 retrieval-manager](ICD-retrieval-manager.md), [#6 MCP bridge](ICD-mcp-bridge.md), [#7 plugin lifecycle](ICD-plugin-lifecycle.md), [#8 profiles registry](ICD-profiles-registry.md).
- Architecture overview: [`ARCHITECTURE.md`](ARCHITECTURE.md) §"Editor Layer".
- Design docs referenced: none — this subsystem grew via 0.9.13 extraction + per-feature ships (1.4.7 ghost-text, 1.22.0 preview integration, 2.0.0 tab-type expansion). Future design doc opportunity if Tier 3b preview sidecar lands.
- Test cohort: [`tests/test-tab-manager-dispatch.mjs`](../tests/test-tab-manager-dispatch.mjs), [`tests/test-issue-tab-dispatch.mjs`](../tests/test-issue-tab-dispatch.mjs), [`tests/test-ghost-text.mjs`](../tests/test-ghost-text.mjs), [`tests/test-hotkey-bindings.mjs`](../tests/test-hotkey-bindings.mjs).
