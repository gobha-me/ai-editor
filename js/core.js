/**
 * AI Editor - Core Module
 * State management, event bus, plugin system
 */

// Import provider registry (auto-registers built-in providers)
import { ProviderRegistry, DEFAULT_CAPABILITIES } from './providers/index.js';

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
        giteaUrl: '',     // Legacy — migrated to connections[] on first run
        connections: [],  // Git provider connections: [{ id, provider, label, url, token, enabled }]
        
        // Embeddings / Context Management
        useEmbeddings: false,      // Enable client-side embeddings
        embeddingModel: 'Xenova/all-MiniLM-L6-v2', // Transformers.js model
        autoReindex: true,         // Auto-update embeddings on file changes
        embeddingCacheExpiry: 7,   // Days before re-indexing
        maxRelevantFiles: 5,       // Max files to return for context queries
        
        // LLM Configuration
        llmEndpoint: '',
        llmApiKey: '',
        llmModel: 'gpt-4',
        commitModel: '',           // Optional small/fast model for utility tasks (commit msgs, summaries)
        disabledModels: [],        // Model IDs hidden from chat selector (blacklist)
        apiProvider: 'openai',     // Provider plugin key: openai | venice | openrouter
        
        // Venice.ai-specific parameters (only used when apiProvider === 'venice')
        veniceParameters: {
            stripThinking: false,              // Strip thinking blocks from response
            disableThinking: false,            // Disable thinking entirely
            enableWebSearch: 'off',            // 'off' | 'auto' | 'always'
            enableWebScraping: false,          // Enable web scraping for searches
            enableWebCitations: false,         // Include citations for web results
            includeSearchResultsInStream: false, // Stream search results
            returnSearchResultsAsDocuments: true, // Format search results as documents
            includeSystemPrompt: true,         // Include Venice system prompt
            reasoningEffort: null              // 'low' | 'medium' | 'high' for reasoning models
        },
        
        // OpenRouter-specific parameters (only used when apiProvider === 'openrouter')
        openRouterParameters: {
            siteUrl: '',                       // Site URL for OpenRouter rankings
            appName: 'AI Editor',              // App name in OpenRouter dashboard
            route: '',                         // Routing strategy: '' | 'fallback'
            models: [],                        // Fallback model list
            transforms: []                     // Prompt transforms
        },
        
        // Timeout Configuration (in milliseconds)
        llmTimeout: 180000,        // 3 minutes - Main LLM response timeout (for reasoning models like Kimi K2.5)
        toolTimeout: 30000,        // 30 seconds - Individual tool execution timeout
        summaryTimeout: 60000,     // 1 minute - Chat summary generation timeout
        
        // UI Configuration
        role: 'full',              // Active role: full | coder | pm | reviewer
        fontSize: 13,              // UI font size in px
        chatFontSize: 13,          // Chat panel font size in px
        editorFontSize: 14,        // Editor font size in px
        showIssues: true,          // Show issues panel in sidebar
        showWorkflows: true,       // Show workflows panel in sidebar
        showLineNumbers: true,     // Show line numbers in editor
        theme: 'dark',

        // Summarizer Configuration
        summarizer: {
            recentCountBase: 10,   // Messages kept verbatim (no tool calls active)
            recentCountTools: 24,  // Messages kept when tool calls are in recent history
            threshold: 30,         // Min messages before first summary triggers
            interval: 15,          // New messages between re-summarizations
            maxChars: 2000         // Max summary output length (chars)
        }
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

    // Session cost tracking
    sessionCost: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cachedInputTokens: 0,   // Tokens served from prompt cache
        reasoningTokens: 0,     // Thinking/reasoning tokens consumed
        totalCost: 0,           // USD estimate
        cacheSavings: 0,        // USD saved from cache hits
        requests: 0
    },

    // Provider account balance (fetched from API)
    providerBalance: null,      // { provider, usd, label, raw } or null

    // Issues (bonus feature)
    issues: [],                // [{ number, title, body, state }]
    currentIssue: null,

    // Scratchpad — LLM-managed persistent notes (survives summarization, cleared on new chat)
    scratchpad: {},            // { key: value } — max 10 keys, 500 chars each

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
            if (e.name === 'QuotaExceededError') {
                // Try to recover by pruning chat history (largest consumer)
                const chatKey = this._prefix + 'chatHistory';
                try {
                    const raw = localStorage.getItem(chatKey);
                    if (raw) {
                        const history = JSON.parse(raw);
                        if (Array.isArray(history) && history.length > 20) {
                            // Keep only last 20 messages
                            const pruned = history.slice(-20);
                            localStorage.setItem(chatKey, JSON.stringify(pruned));
                            console.warn(`[Storage] Quota exceeded — pruned chat history from ${history.length} to ${pruned.length} messages`);
                            // Retry the original write
                            try {
                                localStorage.setItem(this._prefix + key, JSON.stringify(value));
                                return;
                            } catch {
                                // Still full — give up gracefully
                            }
                        }
                    }
                } catch {
                    // Pruning failed — fall through
                }
                console.warn('[Storage] localStorage quota exceeded. Data not saved for key:', key);
            } else {
                console.error('Storage set error:', e);
            }
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
// API PROVIDER REGISTRY (delegated to providers/)
// ============================================

/**
 * Backward-compatible Providers facade.
 * Delegates to ProviderRegistry from js/providers/.
 * Existing code using Providers.register/get/list/parseModels continues to work.
 */
const Providers = {
    register(provider) {
        return ProviderRegistry.register(provider);
    },
    get(id) {
        return ProviderRegistry.get(id);
    },
    list() {
        return ProviderRegistry.list();
    },
    parseModels(rawModels) {
        return ProviderRegistry.parseModels(rawModels, State.settings.apiProvider);
    }
};

// ============================================
// ROLE DEFINITIONS
// ============================================

/**
 * Roles control which tools are available to the LLM.
 * Tools declare which roles can access them at registration time.
 * 
 * Role shape: { id, name, icon, description }
 * 
 * Special considerations:
 * - Roles can be registered dynamically by plugins
 * - Tools reference roles by ID and are validated at registration
 * - Role 'full' is special: gets all tools regardless of their role declarations
 */

const Roles = {
    _registered: {},

    /**
     * Register a role.
     * @param {Object} role - { id, name, icon, description }
     */
    register(role) {
        if (!role.id || !role.name) {
            console.error('Role missing id or name:', role);
            return false;
        }
        
        // Prevent duplicate registration
        if (this._registered[role.id]) {
            console.warn(`Role ${role.id} already registered, skipping`);
            return false;
        }
        
        this._registered[role.id] = {
            id: role.id,
            name: role.name,
            icon: role.icon || '🔧',
            description: role.description || ''
        };
        
        console.log(`Role registered: ${role.name} (${role.id})`);
        EventBus.emit('role:registered', role);
        return true;
    },

    /**
     * Get a role by ID.
     */
    get(id) {
        return this._registered[id] || this._registered['full'];
    },

    /**
     * List all registered roles.
     */
    list() {
        return Object.values(this._registered);
    },

    /**
     * Check if a role exists.
     */
    exists(id) {
        return !!this._registered[id];
    },

    /**
     * Filter tool definitions based on the active role.
     * Tools must explicitly declare which roles can access them.
     * The 'full' role gets all tools regardless of their declarations.
     * Tools with roles: 'all' are available to every role.
     * 
     * @param {Array} toolDefinitions - Array of tool definition objects
     * @returns {Array} Filtered tool definitions
     */
    filterTools(toolDefinitions) {
        const activeRole = State.settings.role;
        
        // 'full' role gets everything
        if (activeRole === 'full') {
            return toolDefinitions;
        }

        return toolDefinitions.filter(tool => {
            const toolRoles = tool._registeredRoles || [];
            
            // Tools marked as 'all' are available to everyone
            if (toolRoles.includes('all')) {
                return true;
            }
            
            // Check if active role is in the tool's allowed roles
            return toolRoles.includes(activeRole);
        });
    }
};

// ============================================
// BUILT-IN ROLE DEFINITIONS
// ============================================

const BUILTIN_ROLES = [
    {
        id: 'full',
        name: 'Full Access',
        icon: '🔓',
        description: 'All tools enabled. Maximum capability, highest token overhead.'
    },
    {
        id: 'coder',
        name: 'Coder',
        icon: '💻',
        description: 'Read/edit/create code, search the codebase, navigate project tree, read issues for context. No issue creation.'
    },
    {
        id: 'pm',
        name: 'Project Manager',
        icon: '📋',
        description: 'Create/manage issues, search and read code for context. No code editing.'
    },
    {
        id: 'reviewer',
        name: 'Reviewer',
        icon: '🔍',
        description: 'Read-only code access with search, can comment on issues. No code editing or issue creation.'
    }
];

// Register built-in roles
BUILTIN_ROLES.forEach(role => Roles.register(role));

// ============================================
// INITIALIZATION
// ============================================

function loadSettings() {
    const saved = Storage.get('settings');
    if (saved) {
        // Deep-merge known nested objects so new defaults aren't lost on upgrade.
        // Top-level keys are spread first, then nested objects are merged individually.
        const nestedKeys = ['veniceParameters', 'openRouterParameters', 'advancedParams'];
        const merged = { ...State.settings, ...saved };
        for (const key of nestedKeys) {
            if (State.settings[key] && typeof State.settings[key] === 'object' && !Array.isArray(State.settings[key])) {
                merged[key] = { ...State.settings[key], ...(saved[key] || {}) };
            }
        }
        State.settings = merged;
    }
    // Sync active provider with registry
    ProviderRegistry.setActiveProvider(State.settings.apiProvider || 'openai');
}

function saveSettings() {
    Storage.set('settings', State.settings);
    // Sync active provider with registry
    ProviderRegistry.setActiveProvider(State.settings.apiProvider || 'openai');
    EventBus.emit('settings:saved', State.settings);
}

// Auto-save drafts periodically
let draftSaveTimer = null;

function scheduleDraftSave() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    
    draftSaveTimer = setTimeout(() => {
        saveDraftNow();
    }, 2000); // 2 second debounce
}

// Immediate draft save (for tool edits and beforeunload)
function saveDraftNow() {
    if (State.editorDirty && State.currentFile && State.currentProject) {
        Storage.saveDraft(
            State.currentProject.owner,
            State.currentProject.repo,
            State.currentBranch,
            State.currentFile.path,
            State.editorContent
        );
    }
    // Also persist all dirty tab contents
    if (State.currentProject) {
        const { owner, repo } = State.currentProject;
        for (const tab of State.openTabs) {
            if (tab.dirty && tab.content !== tab.originalContent) {
                Storage.saveDraft(owner, repo, State.currentBranch, tab.path, tab.content);
            }
        }
    }
}

// Listen for editor changes
EventBus.on('editor:change', () => {
    State.editorDirty = true;
    scheduleDraftSave();
});

// Immediate save on tool-applied edits (these are discrete, important changes)
EventBus.on('editor:editApplied', () => {
    saveDraftNow();
});

// Save drafts before page unload (crash/refresh safety net)
window.addEventListener('beforeunload', () => {
    saveDraftNow();
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
    ProviderRegistry,
    Roles,
    DEFAULT_CAPABILITIES,
    loadSettings,
    saveSettings,
    saveDraftNow
};
