# AI Editor — Future Work Plan

Items that could improve the editor. Not committed — just captured for reference.

---

## Plugin System Enhancements

### `Plugins.registerTool()` convenience API
Thin wrapper around `ToolRegistry.register()` that auto-scopes the tool to the plugin's context and handles role assignment. Would make it trivial for a plugin to expose custom tools to the LLM.

```javascript
// Proposed API
Plugins.registerTool('my-plugin', {
    name: 'fetch_weather',
    description: 'Get current weather for a city',
    parameters: { city: { type: 'string' } },
    roles: ['full', 'coder'],
    handler: async ({ city }) => ({ temp: 72, conditions: 'sunny' })
});
```

### Dynamic provider registration in settings UI
Currently, the settings dropdown for LLM and Git providers is hardcoded from built-in registries. Plugins that call `Providers.register()` or `GitProviderRegistry.register()` don't appear in the UI. The dropdown should read from the live registry instead.

### CSS / theme injection
Add `Plugins.injectCSS(pluginId, cssText)` that creates a scoped `<style>` tag. Would enable theme plugins, custom syntax highlighting colors, or UI tweaks without touching core CSS.

### SlotManager implementation
The README references a SlotManager for UI injection. Build it: named slots in the DOM (`data-slot="sidebar-top"`, `data-slot="editor-toolbar"`, etc.) that plugins can inject HTML into.

### Plugin settings panel tab
Allow plugins to register a tab in the Settings modal for richer configuration UI beyond the auto-generated `configSchema` fields.

---

## Tools & Roles UI

### Tools settings page
A dedicated tab in Settings showing all registered tools with:
- Tool name, description, current role assignments
- Toggle to enable/disable individual tools
- Filter by role

### Role management in Models tab
When selecting a model, a popup or inline panel where you can:
- Assign a role to the model (or create a new role)
- See which tools the role enables
- Quick-toggle tools on/off for the current role

### Custom role creation
UI to define new roles: name, icon, description, and checkbox list of tools. Currently `Roles.register()` exists but there's no UI for it.

---

## Cross-Project Tools

### `peek_scan_file` — outline for cross-repo files
Cross-repo equivalent of `scan_file`. Returns function/class outline without reading the full file. Requires refactoring the scan parsing logic out of `scan-tools.js` into a shared module that both tools can call.

### `peek_search_in_files` — grep across another repo
Cross-repo equivalent of `search_in_files`. Would need to fetch the file tree and iterate, or use Gitea's search API if available.

### `peek_read_function` — targeted function read from cross-repo
Combines `peek_scan_file` + `peek_read_lines` to read a specific function from another repo by name.

---

## Editor Enhancements

### CodeMirror plugin bridge
Expose the CodeMirror `EditorView` to plugins so they can add keybindings, extensions, decorations, or custom syntax highlighting.

### File system event hooks
~~Emit events (or run hooks) for file create, rename, delete, and move operations so plugins can react.~~
✅ **Done in v0.9.34** — `fs:created`, `fs:updated`, `fs:deleted`, `fs:renamed` events on EventBus.

---

## Other Ideas

### Git provider: generic/custom
A "custom" git provider option in settings where you map endpoint URLs to the base interface. Would let someone connect to any Git API that roughly follows the same REST patterns.

### Offline / PWA support
Service Worker for offline editing with sync-on-reconnect.

### Plugin marketplace / registry
A curated list of external plugin URLs that users can browse and install from within Settings.
