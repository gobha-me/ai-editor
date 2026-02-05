/**
 * AI Editor - Core Module
 * State management, event bus, plugin system
 */

// ============================================
// EVENT BUS
// ============================================

const EventBus = {
    _listeners: {},

    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
        return () => this.off(event, callback);
    },

    off(event, callback) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    },

    emit(event, data) {
        if (!this._listeners[event]) return;
        this._listeners[event].forEach(cb => {
            try {
                cb(data);
            } catch (e) {
                console.error(`EventBus error in ${event}:`, e);
            }
        });
    }
};

// ============================================
// STATE MANAGEMENT
// ============================================

const State = {
    // Settings (persisted)
    settings: {
        giteaUrl: '',
        giteaToken: '',
        llmEndpoint: '',
        llmApiKey: '',
        llmModel: 'gpt-4',
        theme: 'dark'
    },

    // Runtime state
    currentProject: null,      // { owner, repo }
    currentBranch: 'main',
    currentFile: null,         // { path, content, sha }
    fileTree: [],              // [{ path, type, sha }]
    branches: [],              // ['main', 'feature-x', ...]
    models: [],                // [{ id, name }]
    
    // Editor state - Multi-tab support
    openTabs: [],              // [{ path, content, sha, dirty, isPreview }]
    activeTabIndex: -1,        // Index of currently active tab
    editorContent: '',         // Current buffer
    editorDirty: false,        // Has unsaved changes
    drafts: {},                // { 'owner/repo/branch/path': content }

    // Chat state
    chatHistory: [],           // [{ role, content, timestamp }]
    isGenerating: false,

    // Issues (bonus feature)
    issues: [],                // [{ number, title, body, state }]
    currentIssue: null,

    // Workflow runs (bonus feature)
    workflowRuns: [],          // [{ id, name, status, conclusion }]
};

// ============================================
// STORAGE
// ============================================

const Storage = {
    _prefix: 'ai-editor-',

    get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(this._prefix + key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.error('Storage get error:', e);
            return defaultValue;
        }
    },

    set(key, value) {
        try {
            localStorage.setItem(this._prefix + key, JSON.stringify(value));
        } catch (e) {
            console.error('Storage set error:', e);
        }
    },

    remove(key) {
        localStorage.removeItem(this._prefix + key);
    },

    // Draft management
    saveDraft(owner, repo, branch, path, content) {
        const key = `draft-${owner}/${repo}/${branch}/${path}`;
        this.set(key, { content, timestamp: Date.now() });
        State.drafts[`${owner}/${repo}/${branch}/${path}`] = content;
        EventBus.emit('draft:saved', { owner, repo, branch, path });
    },

    getDraft(owner, repo, branch, path) {
        const key = `draft-${owner}/${repo}/${branch}/${path}`;
        const draft = this.get(key);
        return draft ? draft.content : null;
    },

    clearDraft(owner, repo, branch, path) {
        const key = `draft-${owner}/${repo}/${branch}/${path}`;
        this.remove(key);
        delete State.drafts[`${owner}/${repo}/${branch}/${path}`];
    },

    listDrafts() {
        const drafts = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(this._prefix + 'draft-')) {
                const path = key.replace(this._prefix + 'draft-', '');
                const data = this.get(key.replace(this._prefix, ''));
                drafts.push({ path, ...data });
            }
        }
        return drafts;
    }
};

// ============================================
// PLUGIN SYSTEM
// ============================================

const Plugins = {
    _registered: {},
    _hooks: {},

    register(manifest) {
        if (!manifest.id || !manifest.name) {
            console.error('Plugin missing id or name:', manifest);
            return false;
        }

        this._registered[manifest.id] = {
            manifest,
            enabled: true,
            instance: null
        };

        // Register hooks
        if (manifest.hooks) {
            manifest.hooks.forEach(hook => {
                if (!this._hooks[hook]) {
                    this._hooks[hook] = [];
                }
                this._hooks[hook].push(manifest.id);
            });
        }

        console.log(`Plugin registered: ${manifest.name} (${manifest.id})`);
        EventBus.emit('plugin:registered', manifest);
        return true;
    },

    async init(pluginId) {
        const plugin = this._registered[pluginId];
        if (!plugin) return false;

        if (plugin.manifest.init) {
            try {
                plugin.instance = await plugin.manifest.init();
            } catch (e) {
                console.error(`Plugin init failed: ${pluginId}`, e);
                return false;
            }
        }

        EventBus.emit('plugin:initialized', pluginId);
        return true;
    },

    async runHook(hookName, data) {
        const plugins = this._hooks[hookName] || [];
        let result = data;

        for (const pluginId of plugins) {
            const plugin = this._registered[pluginId];
            if (!plugin || !plugin.enabled) continue;

            const hookFn = plugin.manifest[hookName];
            if (hookFn) {
                try {
                    result = await hookFn(result, plugin.instance);
                } catch (e) {
                    console.error(`Hook ${hookName} failed in ${pluginId}:`, e);
                }
            }
        }

        return result;
    },

    get(pluginId) {
        return this._registered[pluginId];
    },

    list() {
        return Object.values(this._registered).map(p => p.manifest);
    }
};

// ============================================
// INITIALIZATION
// ============================================

function loadSettings() {
    const saved = Storage.get('settings');
    if (saved) {
        State.settings = { ...State.settings, ...saved };
    }
}

function saveSettings() {
    Storage.set('settings', State.settings);
    EventBus.emit('settings:saved', State.settings);
}

// Auto-save drafts periodically
let draftSaveTimer = null;

function scheduleDraftSave() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    
    draftSaveTimer = setTimeout(() => {
        if (State.editorDirty && State.currentFile && State.currentProject) {
            Storage.saveDraft(
                State.currentProject.owner,
                State.currentProject.repo,
                State.currentBranch,
                State.currentFile.path,
                State.editorContent
            );
        }
    }, 2000); // 2 second debounce
}

// Listen for editor changes
EventBus.on('editor:change', () => {
    State.editorDirty = true;
    scheduleDraftSave();
});

// ============================================
// EXPORTS
// ============================================

export {
    EventBus,
    State,
    Storage,
    Plugins,
    loadSettings,
    saveSettings
};