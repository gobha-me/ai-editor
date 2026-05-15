/**
 * AI Editor — Plugin Editor Tools
 *
 * LLM tools for interacting with the built-in plugin editor.
 * All scoped to the 'plugin-dev' role only.
 *
 * These bridge the gap between the LLM and the plugin-editor tab,
 * which uses its own CodeMirror instance (not the main editor).
 *
 * @module tools/plugin-tools
 * @since 0.9.42
 */

import { State, Storage, Plugins } from '../core.js';
import { getUserPlugins, setPluginEditorSource } from '../plugin-editor.js';

/**
 * Find the active plugin-editor tab and its CodeMirror reference.
 * @returns {{ tab: object, cmView: object|null } | null}
 */
function _getActivePluginTab() {
    if (State.activeTabIndex < 0 || State.activeTabIndex >= State.openTabs.length) return null;
    const tab = State.openTabs[State.activeTabIndex];
    if (tab.type !== 'plugin-editor') return null;
    return { tab };
}

export function registerPluginTools(registry) {

    // ── read_plugin_source ─────────────────────────

    registry.register('read_plugin_source', async () => {
        const result = _getActivePluginTab();
        if (!result) {
            return {
                error: 'No plugin editor tab is active. Open a plugin editor tab first (Settings → Plugins → Create Plugin, or edit an existing user plugin).'
            };
        }
        const { tab } = result;
        const source = tab.source || '';
        const lines = source.split('\n');
        const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');

        return {
            pluginId: tab.pluginId || null,
            pluginName: tab.pluginName || 'New Plugin',
            dirty: tab.dirty,
            line_count: lines.length,
            content: numbered
        };
    }, {
        type: 'function',
        function: {
            name: 'read_plugin_source',
            description: 'Read the source code of the plugin currently open in the plugin editor tab. Returns numbered lines. This is the ONLY way to read plugin editor content — read_file and read_current_file do NOT work for plugin tabs.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        readOnly: true
    });

    // ── write_plugin_source ────────────────────────

    registry.register('write_plugin_source', async ({ source }) => {
        const result = _getActivePluginTab();
        if (!result) {
            return {
                error: 'No plugin editor tab is active. Open a plugin editor tab first.'
            };
        }
        if (!source || typeof source !== 'string') {
            return { error: 'source parameter is required and must be a string containing the full plugin source code.' };
        }

        const { tab } = result;

        // Update the tab's source
        tab.source = source;
        tab.dirty = true;

        // Update the live CodeMirror instance
        setPluginEditorSource(source);

        return {
            success: true,
            pluginId: tab.pluginId,
            pluginName: tab.pluginName,
            line_count: source.split('\n').length,
            note: 'Source updated in editor. Use run_plugin to save and hot-reload, or the user can press Ctrl+S to save and Ctrl+Enter to run.'
        };
    }, {
        type: 'function',
        function: {
            name: 'write_plugin_source',
            description: 'Write the COMPLETE source code to the active plugin editor tab. Replaces the entire content. Use read_plugin_source first to see current code, then write the full updated source. After writing, use run_plugin to save and hot-reload.',
            parameters: {
                type: 'object',
                properties: {
                    source: {
                        type: 'string',
                        description: 'The complete plugin source code. Must be valid JavaScript that calls Plugins.register().'
                    }
                },
                required: ['source']
            }
        },
    });

    // ── run_plugin ─────────────────────────────────

    registry.register('run_plugin', async () => {
        const result = _getActivePluginTab();
        if (!result) {
            return { error: 'No plugin editor tab is active.' };
        }
        const { tab } = result;
        const source = tab.source;
        if (!source) {
            return { error: 'Plugin source is empty. Write source first with write_plugin_source.' };
        }

        // Extract ID and name from source
        const idMatch = source.match(/id:\s*['"]([^'"]+)['"]/);
        const nameMatch = source.match(/name:\s*['"]([^'"]+)['"]/);
        const id = idMatch?.[1] || tab.pluginId || `user-plugin-${Date.now()}`;
        const name = nameMatch?.[1] || 'Untitled Plugin';

        // Save to Storage
        tab.pluginId = id;
        tab.pluginName = name;
        tab.path = `plugin:${id}`;
        tab.dirty = false;

        const allPlugins = getUserPlugins();
        allPlugins[id] = { source, name, savedAt: new Date().toISOString() };
        Storage.set('userPlugins', allPlugins);

        // Hot-reload via blob import
        const beforeIds = new Set(Plugins.list().map(p => p.id));
        try {
            const blob = new Blob([source], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            try {
                await import(/* webpackIgnore: true */ blobUrl);
            } finally {
                URL.revokeObjectURL(blobUrl);
            }

            const afterList = Plugins.list();
            const newId = afterList.find(p => !beforeIds.has(p.id))?.id || id;
            if (newId) {
                await Plugins.init(newId);
            }

            // Update label
            const label = document.getElementById('pluginEditorLabel');
            if (label) label.textContent = `${name} (saved)`;
            import('../tab-manager.js').then(m => m.renderEditorTabs());

            return {
                success: true,
                pluginId: id,
                pluginName: name,
                registered: !!newId,
                initialized: !!newId,
                note: newId
                    ? `Plugin "${name}" saved, registered, and initialized.`
                    : `Plugin saved but Plugins.register() was not called — make sure source calls Plugins.register({ id, name, ... }).`
            };
        } catch (err) {
            return {
                success: false,
                error: `Plugin execution failed: ${err.message}`,
                pluginId: id,
                note: 'Source was saved to storage but failed to execute. Fix the error and try again.'
            };
        }
    }, {
        type: 'function',
        function: {
            name: 'run_plugin',
            description: 'Save the current plugin source to storage and hot-reload it (register + initialize). Equivalent to pressing "▶ Run" in the plugin editor toolbar. Returns success/failure with error details.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
    });

    // ── list_user_plugins ──────────────────────────

    registry.register('list_user_plugins', async () => {
        const userPlugins = getUserPlugins();
        const entries = Object.entries(userPlugins);

        if (entries.length === 0) {
            return {
                plugins: [],
                note: 'No user-created plugins. Use the plugin editor to create one.'
            };
        }

        return {
            plugins: entries.map(([id, entry]) => {
                const registered = Plugins.get(id);
                return {
                    id,
                    name: entry.name,
                    savedAt: entry.savedAt,
                    enabled: registered?.enabled ?? false,
                    registered: !!registered,
                    lineCount: (entry.source || '').split('\n').length,
                };
            })
        };
    }, {
        type: 'function',
        function: {
            name: 'list_user_plugins',
            description: 'List all user-created plugins stored in the plugin editor. Shows name, ID, enabled status, and line count.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        readOnly: true
    });
}
