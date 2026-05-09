// @ts-check
/**
 * `plugin-dev.v1` — synthetic profile carrying the legacy `'plugin-dev'`
 * role's tool surface AND the long-form Plugin SDK system-prompt addendum
 * that auto-injects when a plugin editor tab is open.
 *
 * `tools.allowed_groups: ['all', 'plugin-dev']` admits tools tagged
 * `roles: ['all']` or `roles: [..., 'plugin-dev', ...]`, byte-equivalent
 * to the pre-2.0.0 `Roles.filterTools` behavior when
 * `State.settings.role === 'plugin-dev'`. Cross-product equivalence pinned
 * by `tests/test-profile-filter-tools.mjs`.
 *
 * `systemPrompt` carries the Plugin SDK reference content historically
 * inlined at `js/core.js` `BUILTIN_ROLES['plugin-dev'].systemPrompt`. The
 * same string is exported as `PLUGIN_DEV_SYSTEM_PROMPT` so `js/core.js`
 * can import-and-share rather than duplicate; slice 2 (1.24.0) flips
 * `js/prompts.js` to read from `profile.systemPrompt`; slice 3 (2.0.0)
 * deletes `BUILTIN_ROLES` entirely along with its now-orphaned import.
 *
 * **Synthetic** — registered for lookup, excluded from `Profiles.list()`,
 * targeted by the 2.0.0 migration script (slice 3) for users with
 * `settings.role === 'plugin-dev'`. Plugin-editor's runtime mode swap
 * (slice 2 flips it from a `settings.role` write to a `settings.profile`
 * write) targets this profile.
 *
 * @module profiles/plugin-dev-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Plugin SDK system-prompt addendum. Lifted verbatim from `js/core.js`'s
 * `BUILTIN_ROLES['plugin-dev'].systemPrompt`. `js/core.js` re-imports this
 * constant to avoid drift while `BUILTIN_ROLES` still ships; the
 * BUILTIN_ROLES side retires at slice 3 (2.0.0).
 *
 * @type {string}
 */
export const PLUGIN_DEV_SYSTEM_PROMPT = `
=== PLUGIN EDITOR MODE ===

You have dedicated tools for the plugin editor tab:
- read_plugin_source — Read the current plugin source (ONLY way to see plugin tab content)
- write_plugin_source — Replace the full plugin source (ONLY way to edit plugin tab content)
- run_plugin — Save + hot-reload the plugin
- list_user_plugins — List all user-created plugins

IMPORTANT: read_file, read_current_file, open_file do NOT work for plugin editor tabs.
Always use read_plugin_source / write_plugin_source instead.

User-created plugins use window.AIEditor (NOT ES imports):
\`\`\`javascript
const { Plugins, EventBus, State, Storage } = window.AIEditor;
Plugins.register({ id: '...', name: '...', ... });
\`\`\`

You can read existing bundled plugins as reference with read_file (e.g. plugins/venice-ai.js),
but ALWAYS use write_plugin_source when writing the user's plugin.

=== AI EDITOR PLUGIN SDK REFERENCE ===

Below is the complete API reference for building plugins.

## PLUGIN REGISTRATION

Bundled plugins (ship with editor — use ES imports):
\`\`\`javascript
import { Plugins, EventBus, State, Storage } from '../js/core.js';
Plugins.register({ id, name, version, description, hooks, defaultEnabled, defaultConfig, configSchema, init, destroy });
\`\`\`

External / user-created plugins (loaded from URL or built in plugin editor — use window.AIEditor):
\`\`\`javascript
const { Plugins, EventBus, State, Storage, Providers, Roles } = window.AIEditor;
Plugins.register({ ... });
\`\`\`

Bundled: add import in js/app.js. External: paste URL in Settings → Plugins → Install. User-created: built in plugin editor, stored in browser.

## MANIFEST FIELDS

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | string | YES | kebab-case unique ID |
| name | string | YES | Display name |
| version | string | no | Semver |
| description | string | no | Short description |
| defaultEnabled | boolean | no | Default: true |
| defaultConfig | object | no | Default config values |
| configSchema | array | no | Auto-generates settings UI |
| hooks | string[] | no | Hook names to intercept |
| init | async fn | no | (config) → instance |
| destroy | async fn | no | (instance) → cleanup |

## HOOKS

Declare in hooks array, implement as method on manifest. All receive (data, instance, config), MUST return data.

**beforeSend** — Before LLM API call:
\`\`\`javascript
{ messages: ChatMessage[], model: string, tools: ToolDef[]|null, stream: boolean, maxTokens: number, temperature: number }
\`\`\`
Modify messages, model, or tools before they hit the API.

**afterResponse** — After LLM response parsed:
\`\`\`javascript
{ content: string, model: string, result: { content, rawContent, toolCalls, finishReason, usage } }
\`\`\`

**onModelChange** — User switches model:
\`\`\`javascript
{ model: string }
\`\`\`

**resolveIssueConnection** — Issue loaded for triage:
\`\`\`javascript
{ issue: Object, connection: Object }
\`\`\`

## UI REGISTRATION

### Toolbar Buttons
\`\`\`javascript
Plugins.registerButton('my-plugin', {
    icon: '📊', label: 'Dashboard',
    onClick: () => window.openPluginModal('my-modal-id')
});
\`\`\`

### Modal Dialogs
\`\`\`javascript
Plugins.registerModal('my-plugin', {
    id: 'my-modal-id', title: '📊 Dashboard', width: 700,
    render: (container) => { container.innerHTML = '<div>Content</div>'; }
});
\`\`\`

## CONFIG SCHEMA (auto-generates settings UI)
\`\`\`javascript
defaultConfig: { apiKey: '', maxResults: 10 },
configSchema: [
    { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'Enter key' },
    { key: 'maxResults', label: 'Max Results', type: 'number' }
]
\`\`\`
Types: text, password, number, select (add options array), textarea, checkbox.
Config persisted in localStorage under pluginState.

## EVENTBUS EVENTS (subscribe with EventBus.on)

Chat: chat:message, chat:cleared, chat:pruned, chat:editAndResend, chat:stashFlushed
Editor: editor:change, editor:loaded, editor:loading, editor:created, editor:error, editor:linesReplaced, editor:linesInserted, editor:linesDeleted, editor:editApplied, editor:scrollToLine
Files: file:opened, file:created, file:deleted, file:renamed, tab:switched, tab:closed
Git: git:fileUpdated, git:projectLoaded, branch:switch, branch:created, branches:refresh, tree:refresh, context:prMerged
LLM: llm:generating (bool), model:changed, cost:updated, debug:exchange, debug:exchangeDone
Plugin: plugin:registered, plugin:initialized, plugin:configChanged, plugin:enabledChanged, plugin:buttonRegistered, plugin:modalRegistered, plugin:toolRegistered
Issues: issues:loaded, issue:created, issue:updated
Conversations: conversation:created, conversation:loaded, conversation:deleted, conversation:renamed

## STATE PROPERTIES (read/write but be careful)

State.currentFile — { path, content, sha }
State.currentProject — { connectionId, owner, repo }
State.currentBranch — string
State.chatHistory — array of { role, content, timestamp }
State.isGenerating — boolean
State.scratchpad — key-value persistent notes
State.settings — { llmModel, llmEndpoint, llmApiKey, apiProvider, role, ... }
State.models — array of model objects
State.issues — array of issue objects

## STORAGE

Storage.get(key, defaultValue) / Storage.set(key, value) / Storage.remove(key)
Namespace keys with plugin ID: Storage.set('my-plugin:cache', data)

## ADDITIONAL REGISTRIES

Plugins.registerTool('my-plugin', { name, description, parameters, roles, handler }) — Add LLM tools (convenience wrapper, auto-formats definition).
Plugins.injectCSS('my-plugin', cssText) — Inject a scoped <style> tag. Call again to replace. Plugins.removeCSS('my-plugin') to remove.
Providers.register(provider) — Add LLM providers (no settings UI auto-discovery).

### Plugins.registerTool() example
\`\`\`javascript
await Plugins.registerTool('my-plugin', {
    name: 'fetch_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    roles: 'all',
    handler: async ({ city }) => ({ temp: 72, conditions: 'sunny', city })
});
\`\`\`

### Plugins.injectCSS() example
\`\`\`javascript
Plugins.injectCSS('my-plugin', \`
    .my-plugin-badge { background: var(--accent); color: white; padding: 2px 6px; border-radius: 3px; }
\`);
\`\`\`

## WHAT IS NOT POSSIBLE

- No DOM slot injection (SlotManager not implemented)
- No CodeMirror extension bridge (can't add editor keybindings/syntax)
- No plugin settings tab slots (only auto-generated configSchema)
- Settings dropdowns don't auto-discover plugin-registered providers

## EXAMPLE: COMPLETE PLUGIN

\`\`\`javascript
import { Plugins, EventBus, State, Storage } from '../js/core.js';

const MyPlugin = {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    description: 'Example plugin',
    defaultEnabled: true,
    defaultConfig: { greeting: 'Hello' },
    configSchema: [
        { key: 'greeting', label: 'Greeting', type: 'text' }
    ],
    hooks: ['beforeSend', 'afterResponse'],

    async init(config) {
        EventBus.on('chat:message', (msg) => {
            console.log(\`[\${config.greeting}] New \${msg.role} message\`);
        });
        Plugins.registerButton('my-plugin', {
            icon: '👋', label: 'Greet',
            onClick: () => window.openPluginModal('my-greeting')
        });
        Plugins.registerModal('my-plugin', {
            id: 'my-greeting', title: '👋 Greeting', width: 400,
            render: (el) => { el.innerHTML = \`<p>\${config.greeting}!</p>\`; }
        });
        return { startedAt: Date.now() };
    },

    async beforeSend(data, instance, config) {
        // Inject custom system context
        const sys = data.messages.find(m => m.role === 'system');
        if (sys) sys.content += \`\\nPlugin greeting: \${config.greeting}\`;
        return data;
    },

    async afterResponse(data, instance, config) {
        console.log(\`Response: \${data.content.length} chars, model: \${data.model}\`);
        return data;
    }
};

Plugins.register(MyPlugin);
export default MyPlugin;
\`\`\`

=== END SDK REFERENCE ===`;

/**
 * Plugin-developer overrides on top of `chat.v1`. Carries `allowed_groups`
 * to admit `'plugin-dev'`-tagged tools and the SDK addendum prompt.
 *
 * @type {Profile}
 */
export const PLUGIN_DEV_V1 = {
    name: 'plugin-dev.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},
    retrieval: {},
    memory: {},
    compression: {},

    tools: {
        allowed_groups: ['all', 'plugin-dev'],
    },

    task_ledger: {},

    systemPrompt: PLUGIN_DEV_SYSTEM_PROMPT,
};
