/**
 * AI Editor — Built-in Plugin Editor
 *
 * Create, edit, and test plugins without leaving the editor.
 * Plugins are stored in Storage ('userPlugins') and loaded on startup
 * via the same blob-URL import() mechanism as URL-installed plugins.
 *
 * Tab type: 'plugin-editor'
 * Storage key: 'userPlugins' → { [id]: { source, name, savedAt } }
 *
 * @module plugin-editor
 * @since 0.9.42
 */

import { State, Storage, Plugins, EventBus } from './core.js';
import { registerTabRenderer } from './tab-manager.js';
import { CM, loadCodeMirror, getLanguageExtension } from './editor/setup.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// ============================================
// STORAGE
// ============================================

const STORAGE_KEY = 'userPlugins';

/** @returns {Object.<string, {source: string, name: string, savedAt: string}>} */
function _getAll() {
    return Storage.get(STORAGE_KEY) || {};
}

function _save(id, source, name) {
    const all = _getAll();
    all[id] = { source, name, savedAt: new Date().toISOString() };
    Storage.set(STORAGE_KEY, all);
}

function _delete(id) {
    const all = _getAll();
    delete all[id];
    Storage.set(STORAGE_KEY, all);
}

export function getUserPlugins() {
    return _getAll();
}

// ============================================
// PLUGIN TEMPLATE
// ============================================

const PLUGIN_TEMPLATE = `/**
 * My Plugin
 *
 * Describe what your plugin does here.
 * See docs/PLUGIN.md for the full authoring guide.
 */
const { Plugins, EventBus, State, Storage } = window.AIEditor;

Plugins.register({
    id: 'my-custom-plugin',
    name: 'My Custom Plugin',
    version: '1.0.0',
    author: '',
    description: 'A custom plugin',
    defaultEnabled: true,

    hooks: [
        // 'beforeSend',     // Modify outgoing LLM request
        // 'afterResponse',  // Process LLM response
        // 'onModelChange',  // React to model switch
    ],

    // Optional: config fields shown in Settings → Plugins
    // configSchema: [
    //     { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
    // ],
    // defaultConfig: { apiKey: '' },

    async init(config) {
        console.log('[my-custom-plugin] Initialized');
        return {};
    },

    // async beforeSend(data, instance, config) {
    //     // data: { messages, model, tools, ... }
    //     return data;
    // },

    // async afterResponse(data, instance, config) {
    //     // data: { content, toolCalls, ... }
    //     return data;
    // },
});
`;

// ============================================
// OPEN / CREATE TAB
// ============================================

/**
 * Open the plugin editor in a tab.
 * @param {string|null} pluginId - Existing plugin ID, or null for new
 */
export async function openPluginEditor(pluginId = null) {
    const existing = pluginId ? _getAll()[pluginId] : null;
    const source = existing?.source || PLUGIN_TEMPLATE;
    const name = existing?.name || 'New Plugin';
    const tabPath = pluginId ? `plugin:${pluginId}` : `plugin:new-${Date.now()}`;

    // Already open? Switch to it.
    const idx = State.openTabs.findIndex(t => t.type === 'plugin-editor' && t.path === tabPath);
    if (idx >= 0) {
        const { switchToTab } = await import('./tab-manager.js');
        await switchToTab(idx);
        return;
    }

    // Save current tab state
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        const cur = State.openTabs[State.activeTabIndex];
        if (!cur.type || cur.type === 'file') {
            cur.content = State.editorContent;
            cur.dirty = State.editorDirty;
        }
    }

    const newTab = {
        type: 'plugin-editor',
        path: tabPath,
        pluginId: pluginId || null,
        pluginName: name,
        source,
        dirty: false,
        isPreview: false,
    };

    State.openTabs.push(newTab);
    State.activeTabIndex = State.openTabs.length - 1;

    const { switchToTab } = await import('./tab-manager.js');
    await switchToTab(State.activeTabIndex);
}

// ============================================
// TAB RENDERER
// ============================================

/** Active CodeMirror view for the plugin editor (separate from the main editor). */
let _pluginEditorView = null;

/**
 * Set the plugin editor's CodeMirror content programmatically.
 * Used by plugin tools (write_plugin_source) to update the editor.
 * @param {string} source
 */
export function setPluginEditorSource(source) {
    if (!_pluginEditorView) return false;
    _pluginEditorView.dispatch({
        changes: { from: 0, to: _pluginEditorView.state.doc.length, insert: source }
    });
    return true;
}

async function renderPluginEditorTab(container, tab) {
    // Destroy previous standalone instance
    if (_pluginEditorView) {
        _pluginEditorView.destroy();
        _pluginEditorView = null;
    }

    // Ensure CodeMirror is loaded
    if (!CM.EditorView) {
        await loadCodeMirror();
    }

    const savedLabel = tab.dirty ? '' : ' (saved)';
    const pluginLabel = tab.pluginId
        ? escapeHtml(tab.pluginName || tab.pluginId)
        : 'New Plugin';

    container.innerHTML = `
        <div class="plugin-editor-tab-content">
            <div class="plugin-editor-toolbar">
                <div class="plugin-editor-title">
                    <span class="plugin-editor-icon">🧩</span>
                    <span id="pluginEditorLabel">${pluginLabel}${savedLabel}</span>
                </div>
                <div class="plugin-editor-actions">
                    <button type="button" class="btn" id="pluginEditorTemplate" title="Reset to template">📄 Template</button>
                    <button type="button" class="btn" id="pluginEditorRun" title="Save & Run (Ctrl+Enter)">▶ Run</button>
                    <button type="button" class="btn btn-primary" id="pluginEditorSave" title="Save (Ctrl+S)">💾 Save</button>
                    ${tab.pluginId ? `<button type="button" class="btn btn-danger" id="pluginEditorDelete" title="Delete plugin">🗑 Delete</button>` : ''}
                </div>
            </div>
            <div class="plugin-editor-cm" id="pluginEditorCM"></div>
            <div class="plugin-editor-status" id="pluginEditorStatus"></div>
        </div>
    `;

    // Create standalone CodeMirror instance
    const cmContainer = container.querySelector('#pluginEditorCM');
    const langExt = getLanguageExtension('plugin.js');
    const langExts = Array.isArray(langExt) ? langExt : (langExt ? [langExt] : []);

    const extensions = [];

    // Basic setup
    if (Array.isArray(CM.basicSetup)) {
        extensions.push(...CM.basicSetup);
    } else if (CM.basicSetup) {
        extensions.push(CM.basicSetup);
    }

    // Theme
    if (CM.oneDark) extensions.push(CM.oneDark);

    // Keymaps
    if (CM.keymap && CM.indentWithTab) {
        const keymapExts = [CM.indentWithTab];
        if (Array.isArray(CM.defaultKeymap)) keymapExts.push(...CM.defaultKeymap);
        if (Array.isArray(CM.historyKeymap)) keymapExts.push(...CM.historyKeymap);

        // Ctrl+S → save, Ctrl+Enter → save & run
        keymapExts.push(
            { key: 'Mod-s', run: () => { _doSave(tab); return true; }, preventDefault: true },
            { key: 'Mod-Enter', run: () => { _doRun(tab); return true; }, preventDefault: true }
        );

        extensions.push(CM.keymap.of(keymapExts));
    }

    // Line wrapping
    if (CM.lineWrapping) extensions.push(CM.lineWrapping);

    // Update listener — mark tab dirty on change
    if (CM.EditorView?.updateListener?.of) {
        extensions.push(CM.EditorView.updateListener.of(update => {
            if (update.docChanged) {
                tab.source = update.state.doc.toString();
                if (!tab.dirty) {
                    tab.dirty = true;
                    // Re-render tabs to show dirty indicator
                    import('./tab-manager.js').then(m => m.renderEditorTabs());
                }
            }
        }));
    }

    // Language (JavaScript)
    extensions.push(...langExts);

    const validExts = extensions.filter(e => e != null);

    const state = CM.EditorState.create({
        doc: tab.source || '',
        extensions: validExts,
    });

    _pluginEditorView = new CM.EditorView({
        state,
        parent: cmContainer,
    });

    // Wire buttons
    container.querySelector('#pluginEditorSave')?.addEventListener('click', () => _doSave(tab));
    container.querySelector('#pluginEditorRun')?.addEventListener('click', () => _doRun(tab));
    container.querySelector('#pluginEditorTemplate')?.addEventListener('click', () => _doTemplate(tab));
    container.querySelector('#pluginEditorDelete')?.addEventListener('click', () => _doDelete(tab));

    // Focus the editor
    _pluginEditorView.focus();
}

// ============================================
// ACTIONS
// ============================================

function _setStatus(msg, type = 'info') {
    const el = document.getElementById('pluginEditorStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = `plugin-editor-status plugin-editor-status-${type}`;
}

function _doSave(tab) {
    if (!_pluginEditorView) return;
    const source = _pluginEditorView.state.doc.toString();
    tab.source = source;

    // Extract plugin ID and name from source
    const idMatch = source.match(/id:\s*['"]([^'"]+)['"]/);
    const nameMatch = source.match(/name:\s*['"]([^'"]+)['"]/);
    const id = idMatch?.[1] || tab.pluginId || `user-plugin-${Date.now()}`;
    const name = nameMatch?.[1] || 'Untitled Plugin';

    tab.pluginId = id;
    tab.pluginName = name;
    tab.path = `plugin:${id}`;
    tab.dirty = false;

    _save(id, source, name);

    // Update label
    const label = document.getElementById('pluginEditorLabel');
    if (label) label.textContent = `${name} (saved)`;

    import('./tab-manager.js').then(m => m.renderEditorTabs());

    _setStatus(`Saved: ${name} (${id})`, 'success');
    window.showToast?.(`Plugin saved: ${name}`, 'success');
}

async function _doRun(tab) {
    // Save first
    _doSave(tab);

    const source = tab.source;
    if (!source) return;

    // Snapshot current registrations
    const beforeIds = new Set(Plugins.list().map(p => p.id));

    try {
        const blob = new Blob([source], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            await import(/* webpackIgnore: true */ blobUrl);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }

        // Find newly registered or re-registered plugin
        const afterList = Plugins.list();
        const newId = afterList.find(p => !beforeIds.has(p.id))?.id || tab.pluginId;

        if (newId) {
            await Plugins.init(newId);
            _setStatus(`Running: ${tab.pluginName} — plugin initialized`, 'success');
            window.showToast?.(`Plugin running: ${tab.pluginName}`, 'success');
        } else {
            _setStatus('Plugin loaded but no new registration detected — ensure Plugins.register() is called', 'warning');
        }
    } catch (err) {
        _setStatus(`Error: ${err.message}`, 'error');
        window.showToast?.(`Plugin error: ${err.message}`, 'error');
        console.error('[plugin-editor] Run failed:', err);
    }
}

function _doTemplate(tab) {
    if (!_pluginEditorView) return;
    _pluginEditorView.dispatch({
        changes: {
            from: 0,
            to: _pluginEditorView.state.doc.length,
            insert: PLUGIN_TEMPLATE,
        },
    });
    tab.dirty = true;
    _setStatus('Template loaded — edit and save', 'info');
}

async function _doDelete(tab) {
    if (!tab.pluginId) return;

    const { showConfirm } = await import('./ui/dialogs.js');
    const ok = await showConfirm(
        `Delete plugin "${tab.pluginName || tab.pluginId}"? This removes the stored source code.`,
        { title: 'Delete Plugin', okLabel: 'Delete', variant: 'danger' }
    );
    if (!ok) return;

    _delete(tab.pluginId);
    Plugins.setEnabled(tab.pluginId, false);

    window.showToast?.(`Plugin deleted: ${tab.pluginName}`, 'success');

    // Close this tab
    const idx = State.openTabs.findIndex(t => t === tab);
    if (idx >= 0) {
        const { closeTab } = await import('./tab-manager.js');
        await closeTab(idx);
    }
}

// ============================================
// STARTUP — Load user plugins from Storage
// ============================================

/**
 * Load all user-created plugins from Storage on startup.
 * Same blob-URL import() mechanism as URL-installed plugins.
 * @returns {Promise<{loaded: number, failed: number}>}
 */
export async function loadUserPlugins() {
    const all = _getAll();
    const ids = Object.keys(all);
    if (ids.length === 0) return { loaded: 0, failed: 0 };

    console.log(`[plugin-editor] Loading ${ids.length} user plugin(s)...`);
    let loaded = 0;
    let failed = 0;

    for (const id of ids) {
        const { source, name } = all[id];
        if (!source) { failed++; continue; }

        // Snapshot before
        const beforeIds = new Set(Plugins.list().map(p => p.id));

        try {
            const blob = new Blob([source], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            try {
                await import(/* webpackIgnore: true */ blobUrl);
            } finally {
                URL.revokeObjectURL(blobUrl);
            }

            // Find and init
            const afterList = Plugins.list();
            const newId = afterList.find(p => !beforeIds.has(p.id))?.id;
            if (newId) {
                await Plugins.init(newId);
            }

            loaded++;
            console.log(`[plugin-editor] Loaded: ${name} (${id})`);
        } catch (err) {
            failed++;
            console.warn(`[plugin-editor] Failed to load ${id}: ${err.message}`);
        }
    }

    return { loaded, failed };
}

// ============================================
// TAB TYPE REGISTRATION
// ============================================

registerTabRenderer('plugin-editor', renderPluginEditorTab);

// ============================================
// AUTO-PROFILE SWITCHING
// ============================================
// When a plugin-editor tab becomes active, auto-switch to plugin-dev.v1.
// When switching away, restore the previously-selected profile.
//
// 2.0.0 — slice 3 flip. Pre-2.0.0 this auto-switched
// `State.settings.role` between the user's saved role and `'plugin-dev'`;
// now it switches `State.settings.profile` between the saved value
// (which may be `null` if the picker was untouched) and `'plugin-dev.v1'`.
// `_syncProfileUI` updates the picker `<select>` so the Settings tab
// stays in sync if it's open.

let _savedProfile = null;

function _syncProfileUI(profileName) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('settingProfilePicker'));
    if (select) {
        select.value = profileName || '';
    }
}

EventBus.on('tab:switched', ({ tab }) => {
    const isPluginTab = tab?.type === 'plugin-editor';
    const currentProfile = State.settings.profile || null;

    if (isPluginTab && currentProfile !== 'plugin-dev.v1') {
        // Entering plugin editor — save current profile and switch
        _savedProfile = currentProfile;
        State.settings.profile = 'plugin-dev.v1';
        Storage.set('settings', State.settings);
        _syncProfileUI('plugin-dev.v1');
        EventBus.emit('profile:changed', { profile: 'plugin-dev.v1', auto: true });
        console.log(`[plugin-editor] Auto-switched profile: ${_savedProfile} → plugin-dev.v1`);
    } else if (!isPluginTab && currentProfile === 'plugin-dev.v1') {
        // Leaving plugin editor — restore previous profile
        State.settings.profile = _savedProfile;
        Storage.set('settings', State.settings);
        _syncProfileUI(_savedProfile);
        EventBus.emit('profile:changed', { profile: _savedProfile, auto: true });
        console.log(`[plugin-editor] Restored profile: plugin-dev.v1 → ${_savedProfile}`);
        _savedProfile = null;
    }
});
