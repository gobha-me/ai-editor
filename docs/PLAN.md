# AI Editor — Roadmap

## 1.0 Completed

The following items from the original plan shipped in the 0.9.x / 1.0.x series:

| Feature | Version | Notes |
|---|---|---|
| File system event hooks | 0.9.34 | `fs:created`, `fs:updated`, `fs:deleted`, `fs:renamed` on EventBus |
| Ollama capability detection | 0.9.41 | Dedicated Ollama provider queries `/api/show` for real model caps |
| Built-in plugin editor | 0.9.42 | CodeMirror tab, Storage persistence, hot-reload, auto-role switch |
| Plugin editor LLM tools | 0.9.42 | `read_plugin_source`, `write_plugin_source`, `run_plugin`, `list_user_plugins` |
| Settings export with plugin state | 0.9.42 | `pluginState`, `installedPlugins`, `userPlugins` in export JSON |
| `Plugins.registerTool()` | 1.0.0 | Convenience wrapper — no direct ToolRegistry import needed |
| `Plugins.injectCSS()` / `removeCSS()` | 1.0.0 | Scoped `<style>` injection for plugin themes and UI |
| Security hardening pass | 1.0.4 | DOMPurify bypass patches, error-message escaping, label-color CSS sanitation, plugin metadata escape |
| Editable model definitions | 1.0.x | Override capabilities/context window per model (issue #8) |
| Tool widget persistence on redraw | 1.0.x | `_display` metadata preserves tool widgets across re-renders (issue #6) |

---

## 1.1.x — Foundations (in progress)

Tracked authoritatively in [`docs/ROADMAP.md`](ROADMAP.md) §1.1.0. What has landed:

| Item | Version | Notes |
|---|---|---|
| Turn metadata enrichment | 1.0.5 | `file_ops`, `tool_result_for`, `tool_name`, `tool_args` on tool-result turns ([#170](../../../pulls/170)) |
| Migration coverage probe | 1.0.5 | `js/chat/metadata-probe.js` + `?debug=metadata` dev flag ([#172](../../../pulls/172)) |
| Pre-merge version coherence CI lint | 1.0.5 | `.gitea/workflows/ci.yaml` rejects PRs where `js/version.js` and `CHANGELOG.md` disagree ([#173](../../../pulls/173)) |
| Profile scaffolding + unified `TaskLedger` | 1.0.6 | `js/profiles/` directory, data only — no consumer wires up yet (this PR) |

What's still open per ROADMAP §1.1.0:

- **CI test step** (`node --test` job in `.gitea/workflows/ci.yaml`; port the remaining `.mjs` files off `window.T`).
- **`docs/LLM_ERROR_RECOVERY.md` retirement** — fold into PLUGIN.md/TOOLS.md or replace with a thin pointer to `js/utils/errors.js`.
- **Plugin SlotManager** — design only in 1.1.x; implementation deferred to a 1.4.x patch per ROADMAP §1.1.0.

---

## Future Work

Items that could improve the editor post-1.0. Not committed — captured for reference.

### Plugin System

- **Dynamic provider registration in settings UI** — Plugins that call `Providers.register()` or `GitProviderRegistry.register()` don't appear in settings dropdowns. The dropdown should read from the live registry.
- **SlotManager implementation** — Named DOM slots (`data-slot="sidebar-top"`, `data-slot="editor-toolbar"`, etc.) that plugins can inject HTML into. Designed in [DESIGN-git-providers-and-ui-extensions.md](DESIGN-git-providers-and-ui-extensions.md) §4 and referenced in `git-providers/registry.js#getAllContributions`, but the renderer is not yet built. Today plugins inject UI only via `registerButton` and `registerModal`.
- **Plugin settings panel tab** — Allow plugins to register a dedicated tab in the Settings modal for richer configuration UI beyond auto-generated `configSchema` fields.
- **CodeMirror extension bridge** — Expose the CodeMirror `EditorView` to plugins for keybindings, decorations, and custom syntax highlighting.
- **Plugin marketplace / registry** — A curated list of external plugin URLs browsable from within Settings.

### Tools & Roles

- **Tools settings page** — Dedicated tab showing all registered tools with name, description, role assignments, and enable/disable toggles.
- **Custom role creation UI** — Create new roles with name, icon, description, and checkbox list of tools. `Roles.register()` exists but has no UI.

### Cross-Project Tools

- **`peek_scan_file`** — Cross-repo function/class outline. Requires extracting scan parsing into a shared module.
- **`peek_search_in_files`** — Cross-repo grep. Would need tree iteration or provider search API.
- **`peek_read_function`** — Combines `peek_scan_file` + `peek_read_lines` to read a specific function from another repo by name.

### Scan Tool Coverage

- **More languages in `scan_file`** — Today only JS/TS and Python parse into a structured outline. Add Go, Rust, Java, C/C++ patterns so `scan_file` is useful in polyglot repos.

### Testing

- **CI test step** — Tests run only in the browser today (`tests/index.html`). The `.mjs` parallel suites (`test-summarizer.mjs`, `test-retry.mjs`, `test-edit-tracker.mjs`) could run under `node --test` in `.gitea/workflows/ci.yaml` before the Docker build. Expand `.mjs` coverage to match the `.js` suites.

### Other

- **Generic / custom git provider** — A "custom" option where users map endpoint URLs to the base interface for any Git API.
- **Offline / PWA support** — Service Worker for offline editing with sync-on-reconnect.

---

## Known doc/code drift

Tracked here so future updates close the loop:

- `docs/LLM_ERROR_RECOVERY.md` references a specific Gitea-only fix (commit `f79091fb`) and pre-multi-provider phrasing. Reframe around the current multi-provider error path or retire it now that `js/utils/errors.js` carries structured `EditorError`/`ErrorCode`.
- `docs/DESIGN-git-providers-and-ui-extensions.md` is mostly implemented (multi-connection works, providers are split, registry exists, contributions are collected). Only **SlotManager** remains unimplemented — the design doc could be split into "shipped" and "remaining" sections or the unimplemented portion folded into this roadmap.
