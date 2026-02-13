# Plugin Authoring Guide

AI Editor's plugin system lets you extend the editor with custom behavior, UI, and integrations. Plugins can intercept LLM requests/responses, add toolbar buttons, register modal dialogs, and react to editor events.

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

## Tips

- **Keep `init()` fast.** It runs at app startup. Defer heavy work to event handlers.
- **Return data from hooks.** Hooks are a pipeline — if you don't return the data, the next plugin (and the editor) gets `undefined`.
- **Use `defaultEnabled: false`** for optional/expensive plugins (billing dashboards, etc.).
- **Namespace Storage keys.** Use your plugin ID as a prefix: `Storage.set('my-plugin:cache', data)`.
- **Don't modify `State.chatHistory` directly** — use `EventBus.emit('chat:message', ...)` or the chat API.
- **Test with the LLM Debug modal** (Ctrl+Shift+I or via error log) to see how your `beforeSend` hook modifies requests.
