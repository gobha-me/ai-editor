# AI Editor — Roadmap

## 1.0 Completed

The following items from the original plan shipped in the 0.9.x series:

| Feature | Version | Notes |
|---|---|---|
| File system event hooks | 0.9.34 | `fs:created`, `fs:updated`, `fs:deleted`, `fs:renamed` on EventBus |
| Ollama capability detection | 0.9.41 | Dedicated Ollama provider queries `/api/show` for real model caps |
| Built-in plugin editor | 0.9.42 | CodeMirror tab, Storage persistence, hot-reload, auto-role switch |
| Plugin editor LLM tools | 0.9.42 | `read_plugin_source`, `write_plugin_source`, `run_plugin`, `list_user_plugins` |
| Settings export with plugin state | 0.9.42 | `pluginState`, `installedPlugins`, `userPlugins` in export JSON |
| `Plugins.registerTool()` | 1.0.0 | Convenience wrapper — no direct ToolRegistry import needed |
| `Plugins.injectCSS()` / `removeCSS()` | 1.0.0 | Scoped `<style>` injection for plugin themes and UI |

---

## Future Work

Items that could improve the editor post-1.0. Not committed — captured for reference.

### Plugin System

- **Dynamic provider registration in settings UI** — Plugins that call `Providers.register()` or `GitProviderRegistry.register()` don't appear in settings dropdowns. The dropdown should read from the live registry.
- **SlotManager implementation** — Named DOM slots (`data-slot="sidebar-top"`, `data-slot="editor-toolbar"`, etc.) that plugins can inject HTML into.
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

### Other

- **Generic / custom git provider** — A "custom" option where users map endpoint URLs to the base interface for any Git API.
- **Offline / PWA support** — Service Worker for offline editing with sync-on-reconnect.
