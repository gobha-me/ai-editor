// @ts-check
/**
 * `plugin-dev.v1` — synthetic profile carrying the legacy `'plugin-dev'`
 * role's tool surface AND the long-form Plugin SDK system-prompt addendum
 * that auto-injects when a plugin editor tab is open.
 *
 * 2.54.0 (gitea#438) — explicit admission. `tools.admit` enumerates the
 * union of every `'all'`-tagged and every `'plugin-dev'`-tagged tool
 * from the pre-inversion `Roles.filterTools`, byte-equivalent to the
 * legacy behavior when `State.settings.role === 'plugin-dev'`.
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

import { renderPublicEventChannels } from '../events/public-channels.js';

/**
 * Plugin SDK system-prompt addendum. Lifted verbatim from `js/core.js`'s
 * `BUILTIN_ROLES['plugin-dev'].systemPrompt`. `js/core.js` re-imports this
 * constant to avoid drift while `BUILTIN_ROLES` still ships; the
 * BUILTIN_ROLES side retires at slice 3 (2.0.0).
 *
 * 2.39.0.0 (audit sweep) — the `EVENTBUS EVENTS` enumeration is derived
 * from `PUBLIC_EVENT_CHANNELS` (`js/events/public-channels.js`) instead
 * of being hand-maintained inline. Same pattern as `LEGACY_TOOL_ENUMERATION`
 * (retired 2.35.0) and `renderUntrustedMarkers` (added 2.37.0). Adding a
 * new public channel surfaces it here without a second edit.
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

${renderPublicEventChannels()}

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

Plugins.registerTool('my-plugin', { name, description, parameters, handler }) — Add LLM tools (convenience wrapper, auto-formats definition). Admission is profile-side: a tool registered here is only callable by the active profile when the profile's tools.admit list includes its name.
Plugins.injectCSS('my-plugin', cssText) — Inject a scoped <style> tag. Call again to replace. Plugins.removeCSS('my-plugin') to remove.
Providers.register(provider) — Add LLM providers (no settings UI auto-discovery).

### Plugins.registerTool() example
\`\`\`javascript
await Plugins.registerTool('my-plugin', {
    name: 'fetch_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    handler: async ({ city }) => ({ temp: 72, conditions: 'sunny', city })
});
// Note: tool only fires for profiles whose tools.admit list includes 'fetch_weather'.
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
 * Plugin-developer overrides on top of `chat.v1`. Carries an explicit
 * `tools.admit` list (gitea#438 / 2.54.0) extending chat.v1 with the
 * plugin-dev tool surface, plus the SDK addendum prompt.
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
        admit: [
            'ask_user',
            'delegate_task',
            'find_references',
            'find_relevant_files',
            'find_tool',
            'get_ci_logs',
            'get_ci_status',
            'get_embeddings_status',
            'get_project_tree',
            'git_log',
            'goto_line',
            'list_conversations',
            'list_issues',
            'list_open_tabs',
            'list_projects',
            'list_pull_requests',
            'list_tool_categories',
            'list_tools_by_category',
            'list_user_plugins',
            'memory_recall',
            'open_file',
            'peek_project_file',
            'peek_project_tree',
            'peek_read_lines',
            'preview_click',
            'preview_console_logs',
            'preview_errors',
            'preview_fill',
            'preview_inspect',
            'preview_list',
            'preview_logs',
            'preview_network',
            'preview_resize',
            'preview_snapshot',
            'preview_start',
            'preview_stop',
            'read_approved_plan',
            'read_chat_history',
            'read_current_file',
            'read_docs',
            'read_file',
            'read_function',
            'read_issue',
            'read_lines',
            'read_plugin_source',
            'read_pull_request',
            'run_plugin',
            'scan_file',
            'scratchpad_clear',
            'scratchpad_read',
            'scratchpad_write',
            'search_chat_history',
            'search_in_files',
            'select_range',
            'set_active_project',
            'submit_plan_for_approval',
            'submit_script_for_approval',
            'sync_releases',
            'todo_read',
            'todo_write',
            'write_plugin_source',
            'mcp__*',
        ],
    },

    task_ledger: {},

    systemPrompt: PLUGIN_DEV_SYSTEM_PROMPT,
};
