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
        commitModel: '',           // Optional small/fast model for commit messages
        apiProvider: 'openai',     // Provider plugin key: openai | venice | openrouter
        theme: 'dark'
    },

    // Runtime state
    currentProject: null,      // { owner, repo }
    currentBranch: 'main',
    currentFile: null,         // { path, content, sha }
    fileTree: [],              // [{ path, type, sha }]
    branches: [],              // ['main', 'feature-x', ...]
    models: [],                // [{ id, name, capabilities, pricing, meta }]
    
    // Editor state - Multi-tab support
    openTabs: [],              // [{ path, content, originalContent, sha, dirty, isPreview }]
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
// API PROVIDER REGISTRY
// ============================================

/**
 * Providers normalize the /models response into a unified shape.
 * Each provider is an object with:
 *   id, name, description,
 *   parseModels(rawArray) => [{ id, name, type, owned_by, capabilities, pricing, meta }]
 * 
 * capabilities shape (all booleans, all optional — default false):
 *   supportsFunctionCalling, supportsVision, supportsReasoning,
 *   supportsResponseSchema, supportsWebSearch, supportsAudioInput,
 *   supportsVideoInput, supportsLogProbs, optimizedForCode
 *
 * pricing shape (optional):
 *   { input, output, cacheInput }  — USD per 1M tokens
 */

const DEFAULT_CAPABILITIES = {
    supportsFunctionCalling: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsResponseSchema: false,
    supportsWebSearch: false,
    supportsAudioInput: false,
    supportsVideoInput: false,
    supportsLogProbs: false,
    optimizedForCode: false
};

const Providers = {
    _registered: {},

    register(provider) {
        if (!provider.id || !provider.name || !provider.parseModels) {
            console.error('Provider missing id, name, or parseModels:', provider);
            return false;
        }
        this._registered[provider.id] = provider;
        console.log(`Provider registered: ${provider.name} (${provider.id})`);
        return true;
    },

    get(id) {
        return this._registered[id] || this._registered['openai'];
    },

    list() {
        return Object.values(this._registered);
    },

    /**
     * Parse raw model array through the active provider.
     * Falls back to openai (generic) parser.
     */
    parseModels(rawModels) {
        const provider = this.get(State.settings.apiProvider);
        return provider.parseModels(rawModels);
    }
};

// ---- Built-in: Generic OpenAI-compatible ----
Providers.register({
    id: 'openai',
    name: 'OpenAI / Generic',
    description: 'Standard OpenAI-compatible API. No extended capability metadata.',
    parseModels(raw) {
        return raw.map(m => ({
            id: m.id || m.name || String(m),
            name: m.id || m.name || String(m),
            type: m.type || 'text',
            owned_by: m.owned_by || null,
            capabilities: { ...DEFAULT_CAPABILITIES },
            pricing: null,
            meta: {}
        }));
    }
});

// ---- Built-in: Venice.ai ----
Providers.register({
    id: 'venice',
    name: 'Venice.ai',
    description: 'Venice.ai API with model_spec capabilities, pricing, and traits.',
    parseModels(raw) {
        return raw.map(m => {
            const spec = m.model_spec || {};
            const caps = spec.capabilities || {};
            const price = spec.pricing || {};

            return {
                id: m.id || m.name || String(m),
                name: spec.name || m.id || String(m),
                type: m.type || 'text',
                owned_by: m.owned_by || null,
                capabilities: {
                    supportsFunctionCalling: !!caps.supportsFunctionCalling,
                    supportsVision: !!caps.supportsVision,
                    supportsReasoning: !!caps.supportsReasoning,
                    supportsResponseSchema: !!caps.supportsResponseSchema,
                    supportsWebSearch: !!caps.supportsWebSearch,
                    supportsAudioInput: !!caps.supportsAudioInput,
                    supportsVideoInput: !!caps.supportsVideoInput,
                    supportsLogProbs: !!caps.supportsLogProbs,
                    optimizedForCode: !!caps.optimizedForCode
                },
                pricing: price.input ? {
                    input: price.input?.usd ?? null,
                    output: price.output?.usd ?? null,
                    cacheInput: price.cache_input?.usd ?? null
                } : null,
                meta: {
                    description: spec.description || '',
                    traits: spec.traits || [],
                    contextTokens: spec.availableContextTokens || null,
                    quantization: caps.quantization || null,
                    offline: !!spec.offline,
                    privacy: spec.privacy || null,
                    modelSource: spec.modelSource || null
                }
            };
        });
    }
});

// ---- Built-in: OpenRouter ----
Providers.register({
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter API with pricing and per-model metadata.',
    parseModels(raw) {
        return raw.map(m => {
            // OpenRouter uses: id, name, pricing.prompt, pricing.completion,
            // context_length, architecture.modality, top_provider, per_request_limits
            const pricing = m.pricing || {};
            // OpenRouter pricing is per-token, convert to per-1M-token
            const inputPrice = pricing.prompt ? parseFloat(pricing.prompt) * 1_000_000 : null;
            const outputPrice = pricing.completion ? parseFloat(pricing.completion) * 1_000_000 : null;

            // OpenRouter doesn't have explicit capability flags,
            // but we can infer some from architecture and description
            const arch = m.architecture || {};

            return {
                id: m.id || String(m),
                name: m.name || m.id || String(m),
                type: 'text',
                owned_by: m.id ? m.id.split('/')[0] : null,
                capabilities: {
                    ...DEFAULT_CAPABILITIES,
                    supportsVision: arch.modality === 'multimodal' || (m.description || '').toLowerCase().includes('vision'),
                    supportsFunctionCalling: (m.description || '').toLowerCase().includes('function') || (m.description || '').toLowerCase().includes('tool')
                },
                pricing: inputPrice !== null ? {
                    input: inputPrice,
                    output: outputPrice,
                    cacheInput: null
                } : null,
                meta: {
                    description: m.description || '',
                    contextTokens: m.context_length || null,
                    modality: arch.modality || null,
                    topProvider: m.top_provider || null
                }
            };
        });
    }
});

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
    Providers,
    DEFAULT_CAPABILITIES,
    loadSettings,
    saveSettings
};