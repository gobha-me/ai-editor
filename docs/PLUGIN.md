# Plugin Authoring Guide

AI Editor's plugin system lets you extend the editor with custom behavior, UI, and integrations. Plugins can intercept LLM requests/responses, add toolbar buttons, register modal dialogs, and react to editor events.

> **Plugins run with full access to `window` and `AIEditor` — they are not sandboxed.** Read [SECURITY.md](SECURITY.md) before installing a plugin from a URL you don't control. The editor scans plugin source for invisible Unicode (glassworm / Trojan Source) at install time, but does not audit plugin behavior.

## Quick Start

### Bundled Plugin (ships with the editor)

```javascript
// plugins/my-plugin.js
import { Plugins, EventBus, State } from '../js/core.js';

Plugins.register({
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    description: 'Does something useful',
    defaultEnabled: true,

    hooks: ['afterResponse'],

    async init(config) {
        // Called when the plugin initializes
        // Return an instance object (passed to hooks as 2nd arg)
        return {};
    },

    async afterResponse(data, instance, config) {
        // Process the LLM response
        console.log('Response received:', data.content?.length, 'chars');
        return data;
    }
});
```

Then import it in `js/app.js` alongside the other plugin imports.

### External Plugin (installed from URL)

External plugins can't use relative ES imports. Use `window.AIEditor` instead:

```javascript
// Hosted anywhere — installed via Settings → Plugins → Install from URL
const { Plugins, EventBus, State, Storage } = window.AIEditor;

Plugins.register({
    id: 'my-external-plugin',
    name: 'My External Plugin',
    version: '1.0.0',

    async init(config) {
        EventBus.on('chat:message', (msg) => {
            console.log(`New ${msg.role} message`);
        });
        return {};
    }
});
```

Users install this by pasting the URL in Settings → Plugins → "Install Plugin from URL".

### Built-in Plugin Editor (v0.9.42+)

The fastest way to create a plugin — no external tools needed:

1. Go to **Settings → Plugins → 🧩 Create Plugin**
2. A dedicated editor tab opens with full CodeMirror syntax highlighting
3. Edit the template, then **Ctrl+S** to save or **Ctrl+Enter** to save & hot-reload
4. Your plugin is stored in the browser and loads automatically on startup

Built-in plugins use the same `window.AIEditor` API as external plugins.

**LLM assistance:** When a plugin editor tab is active, the chat role auto-switches to **Plugin Developer**, which gives the LLM the full SDK reference and dedicated tools (`read_plugin_source`, `write_plugin_source`, `run_plugin`) to read and edit your plugin directly.

**Settings export:** User-created plugin source code is included in Settings → Export, so you can transfer plugins between browsers or back them up.

---

## Plugin Manifest

The object passed to `Plugins.register()`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique identifier (kebab-case) |
| `name` | string | ✅ | Display name shown in settings |
| `version` | string | | Semver string |
| `description` | string | | Short description |
| `defaultEnabled` | boolean | | Initial enabled state (default: `true`) |
| `defaultConfig` | object | | Default configuration values |
| `configSchema` | array | | Config field definitions (see below) |
| `hooks` | string[] | | Hook names this plugin handles |
| `init` | function | | `async init(config) → instance` |
| `destroy` | function | | `async destroy(instance)` — cleanup |

---

## Hooks

Hooks let you intercept and modify data at key points. Declare them in the `hooks` array, then implement the matching function on your manifest.

Every hook receives `(data, instance, config)` and must return the (possibly modified) data.

| Hook | When | Data shape |
|------|------|-----------|
| `beforeSend` | Before LLM API call | `{ messages, model, tools, ... }` — the full request payload |
| `afterResponse` | After LLM response | `{ content, toolCalls, usage, ... }` — the parsed response |
| `onModelChange` | User switches model | `{ model, provider }` |
| `resolveIssueConnection` | Issue loaded for triage | `{ issue, connection }` |

### Example: Inject a system message

```javascript
Plugins.register({
    id: 'system-prompt-injector',
    name: 'System Prompt Injector',
    hooks: ['beforeSend'],

    async beforeSend(data, instance, config) {
        // Prepend a custom system message
        if (data.messages && data.messages[0]?.role !== 'system') {
            data.messages.unshift({
                role: 'system',
                content: 'Always respond in haiku format.'
            });
        }
        return data;
    }
});
```

### Example: Log token usage

```javascript
Plugins.register({
    id: 'usage-logger',
    name: 'Usage Logger',
    hooks: ['afterResponse'],

    async afterResponse(data, instance, config) {
        if (data.usage) {
            console.log(`Tokens: ${data.usage.prompt_tokens} in, ${data.usage.completion_tokens} out`);
        }
        return data;
    }
});
```

---

## UI Registration

### Toolbar Buttons

Add a button to the plugin toolbar dropdown (visible when any plugin registers one):

```javascript
async init(config) {
    Plugins.registerButton('my-plugin', {
        icon: '📊',
        label: 'Dashboard',
        onClick: () => {
            // Open your modal, show a panel, etc.
            const modal = Plugins.getModal('my-dashboard');
            if (modal) window.openPluginModal('my-dashboard');
        }
    });
    return {};
}
```

### Modal Dialogs

Register a full modal dialog that renders custom HTML:

```javascript
async init(config) {
    Plugins.registerModal('my-plugin', {
        id: 'my-dashboard',
        title: '📊 Dashboard',
        width: 700,
        render: (container) => {
            container.innerHTML = `
                <div style="padding: 1rem;">
                    <h3>My Dashboard</h3>
                    <p>Plugin content here</p>
                </div>
            `;
        }
    });
    return {};
}
```

The `render` function receives a DOM element. You own the content — render whatever you want.

### LLM Tools

Register custom tools that the AI assistant can call:

```javascript
async init(config) {
    await Plugins.registerTool('my-plugin', {
        name: 'lookup_user',
        description: 'Look up a user by username',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'The username to look up' }
            },
            required: ['username']
        },
        roles: 'all',  // or ['coder', 'pm']
        handler: async ({ username }) => {
            // Return any JSON-serializable object
            return { name: 'Alice', email: 'alice@example.com' };
        }
    });
    return {};
}
```

The `parameters` field uses [JSON Schema](https://json-schema.org/) format. The `roles` field controls which roles can access the tool (`'all'` or an array of role IDs).

### CSS Injection

Add custom styles. Multiple calls with the same plugin ID replace the previous stylesheet:

```javascript
async init(config) {
    Plugins.injectCSS('my-plugin', `
        .my-plugin-highlight { background: var(--accent); color: white; padding: 2px 6px; border-radius: 3px; }
        .my-plugin-panel { border: 1px solid var(--border); padding: 1rem; }
    `);
    return {};
}

async destroy(instance) {
    Plugins.removeCSS('my-plugin');
}
```

Use CSS custom properties (`var(--accent)`, `var(--bg-primary)`, etc.) to respect the active theme.

---

## Configuration

Plugins can declare a config schema. The editor auto-generates a settings UI in the Plugins tab.

```javascript
Plugins.register({
    id: 'my-plugin',
    name: 'My Plugin',

    defaultConfig: {
        apiKey: '',
        maxResults: 10
    },

    configSchema: [
        {
            key: 'apiKey',
            label: 'API Key',
            type: 'password',
            placeholder: 'Enter your API key'
        },
        {
            key: 'maxResults',
            label: 'Max Results',
            type: 'number'
        }
    ],

    async init(config) {
        // config.apiKey, config.maxResults available here
        if (!config.apiKey) {
            console.warn('My Plugin: no API key configured');
        }
        return {};
    }
});
```

Config field types: `text`, `password`, `number`, `select`, `textarea`, `checkbox`.

For `select` type, add `options`:

```javascript
{
    key: 'theme',
    label: 'Theme',
    type: 'select',
    options: [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }
    ]
}
```

Config is persisted in `localStorage` under the `pluginState` key and survives reloads.

---

## window.AIEditor API

External plugins access the editor through `window.AIEditor`:

| Export | What it is |
|--------|-----------|
| `Plugins` | Plugin registry — `register()`, `registerButton()`, `registerModal()`, `get()`, `list()`, `getConfig()`, `setConfig()` |
| `EventBus` | Pub/sub — `on(event, handler)`, `off(event, handler)`, `emit(event, data)` |
| `State` | App state — `chatHistory`, `currentFile`, `currentProject`, `currentBranch`, `isGenerating`, `scratchpad`, etc. |
| `Storage` | Persistent storage — `get(key, default)`, `set(key, value)`, `remove(key)` (IDB + localStorage) |
| `Providers` | LLM provider registry — `register()`, `get()`, `list()` |
| `Roles` | Role registry — `register()`, `get()`, `list()` |

### EventBus Events

Subscribe to editor events for reactive behavior:

```javascript
const { EventBus } = window.AIEditor;

// Chat events
EventBus.on('chat:message', (msg) => { /* {role, content, timestamp} */ });
EventBus.on('chat:cleared', () => { /* chat was reset */ });
EventBus.on('chat:pruned', (info) => { /* history was summarized */ });

// Editor events
EventBus.on('editor:change', () => { /* buffer changed */ });
EventBus.on('editor:loaded', (data) => { /* file loaded in editor */ });
EventBus.on('file:opened', ({ path }) => { /* tab opened */ });
EventBus.on('tab:switched', (tab) => { /* active tab changed */ });

// Git events
EventBus.on('git:fileUpdated', (data) => { /* file committed */ });
EventBus.on('git:projectLoaded', (data) => { /* project switched */ });
EventBus.on('branch:switch', (branch) => { /* branch changed */ });

// Model events
EventBus.on('model:changed', (data) => { /* LLM model changed */ });
EventBus.on('cost:updated', (cost) => { /* token cost updated */ });

// Plugin events
EventBus.on('plugin:configChanged', ({ pluginId, config }) => {});
EventBus.on('plugin:enabledChanged', ({ pluginId, enabled }) => {});
```

This is not exhaustive — see `docs/ARCHITECTURE.md` for the full event catalog.

### State Properties

```javascript
const { State } = window.AIEditor;

State.currentFile;       // Current file path
State.currentProject;    // { connectionId, owner, repo }
State.currentBranch;     // Branch name
State.chatHistory;       // Array of {role, content, timestamp}
State.isGenerating;      // Boolean — LLM is responding
State.scratchpad;        // Key-value persistent notes
```

State is read/write but be careful — modifying `chatHistory` directly won't trigger re-renders. Use the chat API or EventBus for side effects.

---

## Bundled Plugin Examples

| Plugin | File | Demonstrates |
|--------|------|-------------|
| **Venice AI** | `plugins/venice-ai.js` | `beforeSend`/`afterResponse`/`onModelChange` hooks, model metadata injection |
| **Venice Billing** | `plugins/venice-billing.js` | Toolbar button, modal dialog, config schema, API integration |
| **OpenRouter Billing** | `plugins/openrouter-billing.js` | Reading LLM settings, modal rendering, `defaultEnabled: false` |
| **Cross-Repo Issues** | `plugins/cross-repo-issues.js` | `resolveIssueConnection` hook, config schema with textarea |

---

## Capabilities & Limitations

What the plugin system **can do today** — and what it can't.

### ✅ What Works

| Capability | How | Since |
|---|---|---|
| **Intercept LLM requests** | `beforeSend` hook — modify messages, model, tools before the API call | v0.9.32-8 |
| **Process LLM responses** | `afterResponse` hook — inspect/react to content after the LLM responds | v0.9.32-8 |
| **React to model changes** | `onModelChange` hook — runs when user switches LLM model | v0.9.32-8 |
| **Toolbar buttons** | `registerButton()` — adds a button to the plugin dropdown menu | v0.8.x |
| **Modal dialogs** | `registerModal()` — full custom HTML modal with render function | v0.8.x |
| **Register LLM tools** | `registerTool()` — add tools the AI assistant can call | v1.0.0 |
| **Inject CSS** | `injectCSS()` / `removeCSS()` — scoped stylesheet injection | v1.0.0 |
| **Plugin configuration** | `configSchema` + `defaultConfig` — auto-generated settings UI | v0.8.x |
| **Event system** | `EventBus.on()` — subscribe to 60+ editor events (chat, editor, git, etc.) | v0.8.x |
| **Persistent state** | `Storage.get/set` — survives reloads, namespaced by plugin | v0.8.x |
| **Enable/disable** | Users toggle plugins on/off in Settings → Plugins | v0.8.x |
| **External plugins** | Load from URL via `window.AIEditor` — no build step | v0.8.x |
| **Built-in plugin editor** | CodeMirror tab with save, hot-reload, and LLM assistance | v0.9.42 |
| **Custom roles** | `Roles.register()` — add new roles dynamically | v0.8.x |

### ⚠️ Works But No Settings UI

These registries are functional but the settings UI doesn't auto-discover them:

| Capability | Registry | Limitation |
|---|---|---|
| **Register LLM providers** | `Providers.register(provider)` | Works, but the settings dropdown won't automatically show new providers. |
| **Register git providers** | `GitProviderRegistry.register(provider)` | Same — must implement the base interface, but settings UI won't list it. |
| **Plugin-registered tools** | `Plugins.registerTool()` | Works, but there's no UI to view/manage plugin-registered tools. |

### ❌ Not Currently Possible

| Capability | Why |
|---|---|
| **Settings panel tabs** | No slot for plugins to add custom tabs to the settings modal. |
| **DOM slot injection** | `SlotManager` is referenced in docs but was never implemented. Plugins can only inject UI via modals and toolbar buttons. |
| **Tool configuration UI** | Users can't enable/disable individual tools or assign tools to roles from the UI. |
| **Modify editor (CodeMirror) behavior** | No hook into the CodeMirror instance. Plugins can't add keybindings, syntax highlighting, or editor extensions. |

### Hook Data Shapes (Reference)

Hooks receive `(data, instance, config)` and **must return data** (or the pipeline breaks).

**`beforeSend`** — called before LLM API fetch:
```javascript
{
    messages: ChatMessage[],  // The message array (modifiable)
    model: string,            // Model ID
    tools: ToolDef[] | null,  // Tool definitions (modifiable)
    stream: boolean,
    maxTokens: number,
    temperature: number
}
```

**`afterResponse`** — called after LLM response parsed:
```javascript
{
    content: string,          // Stripped response text
    model: string,            // Model that was used
    result: {                 // Full result object (read-only recommended)
        content, rawContent, toolCalls, finishReason, usage
    }
}
```

**`onModelChange`** — called when user switches model:
```javascript
{
    model: string             // New model ID
}
```

**`resolveIssueConnection`** — called when loading issue for triage:
```javascript
{
    issue: Object,            // Issue data
    connection: Object        // Git connection context
}
```

---

## Tips

- **Keep `init()` fast.** It runs at app startup. Defer heavy work to event handlers.
- **Return data from hooks.** Hooks are a pipeline — if you don't return the data, the next plugin (and the editor) gets `undefined`.
- **Use `defaultEnabled: false`** for optional/expensive plugins (billing dashboards, etc.).
- **Namespace Storage keys.** Use your plugin ID as a prefix: `Storage.set('my-plugin:cache', data)`.
- **Don't modify `State.chatHistory` directly** — use `EventBus.emit('chat:message', ...)` or the chat API.
- **Test with the LLM Debug modal** (Ctrl+Shift+I or via error log) to see how your `beforeSend` hook modifies requests.
- **Use the Plugin Developer role** (🧩 in the role selector) when asking the AI assistant to help build plugins. It injects the full SDK reference into the system prompt so the LLM knows the API — no internet required.
