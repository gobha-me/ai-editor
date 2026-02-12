// @ts-check
/**
 * AI Editor - Core Module
 * State management, event bus, plugin system
 *
 * @module core
 */

// ============================================
// TYPE DEFINITIONS (shared across codebase)
// ============================================

/**
 * @typedef {Object} GitConnection
 * @property {string} id         - Unique connection ID
 * @property {string} provider   - Provider key ('gitea' | 'github' | 'gitlab')
 * @property {string} label      - User-facing label
 * @property {string} url        - Base URL (e.g. 'https://git.example.com')
 * @property {string} token      - API token
 * @property {boolean} enabled   - Whether connection is active
 */

/**
 * @typedef {Object} VeniceParameters
 * @property {boolean} stripThinking
 * @property {boolean} disableThinking
 * @property {'off'|'auto'|'always'} enableWebSearch
 * @property {boolean} enableWebScraping
 * @property {boolean} enableWebCitations
 * @property {boolean} includeSearchResultsInStream
 * @property {boolean} returnSearchResultsAsDocuments
 * @property {boolean} includeSystemPrompt
 * @property {'low'|'medium'|'high'|null} reasoningEffort
 */

/**
 * @typedef {Object} OpenRouterParameters
 * @property {string}   siteUrl
 * @property {string}   appName
 * @property {string}   route
 * @property {string[]} models
 * @property {string[]} transforms
 */

/**
 * @typedef {Object} SummarizerConfig
 * @property {number} recentCountBase   - Messages kept verbatim (no tool calls)
 * @property {number} recentCountTools  - Messages kept when tools are active
 * @property {number} threshold         - Min messages before first summary
 * @property {number} interval          - New messages between re-summarizations
 * @property {number} maxChars          - Max summary output length (chars)
 */

/**
 * @typedef {'aggressive'|'balanced'|'conservative'|'custom'} SummarizerMode
 */

/**
 * @typedef {Object} Settings
 * @property {string}               giteaUrl
 * @property {GitConnection[]}      connections
 * @property {boolean}              useEmbeddings
 * @property {string}               embeddingModel
 * @property {boolean}              autoReindex
 * @property {number}               embeddingCacheExpiry
 * @property {number}               maxRelevantFiles
 * @property {string}               llmEndpoint
 * @property {string}               llmApiKey
 * @property {string}               llmModel
 * @property {string}               commitModel
 * @property {string[]}             disabledModels
 * @property {string}               apiProvider
 * @property {VeniceParameters}     veniceParameters
 * @property {OpenRouterParameters} openRouterParameters
 * @property {number}               llmTimeout
 * @property {number}               toolTimeout
 * @property {number}               summaryTimeout
 * @property {string}               role
 * @property {number}               fontSize
 * @property {number}               chatFontSize
 * @property {number}               editorFontSize
 * @property {boolean}              showIssues
 * @property {boolean}              showPullRequests
 * @property {boolean}              showLineNumbers
 * @property {string}               theme
 * @property {SummarizerMode}       summarizerMode
 * @property {SummarizerConfig}     summarizer
 */

/**
 * @typedef {Object} ModelMeta
 * @property {number}  [contextTokens]
 * @property {string}  [architecture]
 * @property {boolean} [supportsTools]
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string}    id
 * @property {string}    name
 * @property {string}    [type]
 * @property {Object}    [capabilities]
 * @property {Object}    [pricing]
 * @property {ModelMeta} [meta]
 */

/**
 * @typedef {Object} TabEntry
 * @property {string}  path
 * @property {string}  content
 * @property {string}  originalContent
 * @property {string}  sha
 * @property {boolean} dirty
 * @property {boolean} isPreview
 */

/**
 * @typedef {Object} ChatMessage
 * @property {'user'|'assistant'|'system'|'tool'} role
 * @property {string|Object}  content
 * @property {number}         [timestamp]
 * @property {Array}          [tool_calls]
 * @property {string}         [tool_call_id]
 * @property {boolean}        [isSummary]
 */

/**
 * @typedef {Object} SessionCost
 * @property {number} totalInputTokens
 * @property {number} totalOutputTokens
 * @property {number} cachedInputTokens
 * @property {number} reasoningTokens
 * @property {number} totalCost
 * @property {number} cacheSavings
 * @property {number} requests
 */

/**
 * @typedef {Object} ProviderBalance
 * @property {string} provider
 * @property {number} usd
 * @property {string} label
 * @property {*}      raw
 */

/**
 * @typedef {Object} Role
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} description
 */

/**
 * @typedef {Object} PluginManifest
 * @property {string}   id
 * @property {string}   name
 * @property {string}   [version]
 * @property {string}   [description]
 * @property {boolean}  [defaultEnabled]
 * @property {Object}   [defaultConfig]
 * @property {string[]} [hooks]
 * @property {Function} [init]
 */

// Import provider registry (auto-registers built-in providers)
import { ProviderRegistry, DEFAULT_CAPABILITIES } from './providers/index.js';

// ============================================
// EVENT BUS
// ============================================

const EventBus = {
    /** @type {Object.<string, Function[]>} */
    _listeners: {},

    /**
     * Subscribe to an event.
     * @param {string} event
     * @param {Function} callback
     * @returns {() => void} Unsubscribe function
     */
    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
        return () => this.off(event, callback);
    },

    /**
     * Unsubscribe from an event.
     * @param {string} event
     * @param {Function} callback
     */
    off(event, callback) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    },

    /**
     * Emit an event to all listeners.
     * @param {string} event
     * @param {*} [data]
     */
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
        showPullRequests: true,    // Show pull requests panel in sidebar
        showLineNumbers: true,     // Show line numbers in editor
        theme: 'dark',

        // Summarizer Configuration
        summarizerMode: 'balanced',    // 'aggressive' | 'balanced' | 'conservative' | 'custom'
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
    pullRequests: [],          // [{ number, title, head, base, state, ciState }]
    focusedIssue: null,        // Full issue data + comments for conversational triage
};

// ============================================
// STORAGE
// ============================================

/**
 * Unified storage layer — synchronous reads, async persistence.
 * 
 * Architecture (0.9.11):
 *   _cache (Map)     — source of truth for reads, always synchronous
 *   IndexedDB        — primary persistent backend (no quota issues)
 *   localStorage     — write-through fallback (quota-limited, eviction)
 * 
 * On init(): IDB data is loaded into _cache. If IDB is unavailable
 * (incognito, unsupported), localStorage populates _cache instead.
 * 
 * get() reads from _cache, never touches disk.
 * set() writes to _cache + fires async IDB write + tries localStorage.
 * remove() deletes from _cache + IDB + localStorage.
 * 
 * Migration: On first init(), localStorage data is bulk-copied to IDB.
 */
const Storage = {
    _prefix: 'ai-editor-',
    _cache: new Map(),
    _idb: null,             // IDB module reference (lazy-loaded)
    _idbReady: false,       // true after successful IDB init
    _initPromise: null,     // Deduplication for concurrent init calls

    /**
     * Initialize storage. Must be awaited before loadSettings().
     * Loads IDB → cache, or falls back to localStorage → cache.
     * Runs migration from localStorage to IDB on first load.
     * @returns {Promise<void>}
     */
    async init() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = this._doInit();
        return this._initPromise;
    },

    async _doInit() {
        try {
            const { IDB } = await import('./storage/idb.js');
            await IDB.open();
            this._idb = IDB;

            // Migration: copy localStorage → IDB on first run
            const migrationFlag = 'ai-editor-idb-migrated';
            if (!localStorage.getItem(migrationFlag)) {
                const migrated = await this._migrateToIDB();
                localStorage.setItem(migrationFlag, '1');
                console.log(`[Storage] Migration complete: ${migrated} keys copied to IndexedDB`);
            }

            // Hydrate in-memory cache from IDB
            const all = await IDB.getAll();
            for (const [key, value] of all) {
                this._cache.set(key, value);
            }

            this._idbReady = true;
            console.log(`[Storage] IndexedDB ready — ${this._cache.size} keys cached`);
        } catch (e) {
            console.warn('[Storage] IndexedDB unavailable, using localStorage fallback:', e.message);
            // Populate cache from localStorage
            this._loadCacheFromLocalStorage();
        }
    },

    /**
     * Migrate all ai-editor-* keys from localStorage to IndexedDB.
     * @returns {Promise<number>} Number of keys migrated
     */
    async _migrateToIDB() {
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const rawKey = localStorage.key(i);
            if (!rawKey || !rawKey.startsWith(this._prefix)) continue;

            const key = rawKey.slice(this._prefix.length);
            try {
                const value = JSON.parse(localStorage.getItem(rawKey));
                entries.push([key, value]);
            } catch {
                // Skip unparseable entries
                console.warn(`[Storage] Migration: skipped unparseable key "${rawKey}"`);
            }
        }

        if (entries.length > 0 && this._idb) {
            return this._idb.setMany(entries);
        }
        return 0;
    },

    /**
     * Fallback: populate cache from localStorage when IDB is unavailable.
     */
    _loadCacheFromLocalStorage() {
        for (let i = 0; i < localStorage.length; i++) {
            const rawKey = localStorage.key(i);
            if (!rawKey || !rawKey.startsWith(this._prefix)) continue;

            const key = rawKey.slice(this._prefix.length);
            try {
                this._cache.set(key, JSON.parse(localStorage.getItem(rawKey)));
            } catch {
                // Skip
            }
        }
        console.log(`[Storage] localStorage fallback — ${this._cache.size} keys cached`);
    },

    // --- Synchronous read API (unchanged signature) ---

    /**
     * Read a value from storage (synchronous, from in-memory cache).
     * @template T
     * @param {string} key
     * @param {T} [defaultValue=null]
     * @returns {T}
     */
    get(key, defaultValue = null) {
        // Primary: in-memory cache (populated by init)
        if (this._cache.has(key)) {
            return this._cache.get(key);
        }
        // Pre-init fallback: read directly from localStorage
        // This ensures module-scope code that runs before init() still works
        try {
            const item = localStorage.getItem(this._prefix + key);
            return item ? JSON.parse(item) : defaultValue;
        } catch (e) {
            console.error('Storage get error:', e);
            return defaultValue;
        }
    },

    // --- Write API (cache + async IDB + localStorage write-through) ---

    /**
     * Write a value to storage (cache + IDB + localStorage).
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
        // 1. Always update in-memory cache (immediate, synchronous)
        this._cache.set(key, value);

        // 2. Async persist to IDB (fire-and-forget)
        if (this._idbReady && this._idb) {
            this._idb.set(key, value).catch(e =>
                console.warn(`[Storage] IDB write failed for "${key}":`, e.message)
            );
        }

        // 3. Write-through to localStorage (with quota handling)
        this._writeLocalStorage(key, value);
    },

    /**
     * Write to localStorage with quota-exceeded recovery.
     * This is best-effort — IDB is the authoritative store.
     */
    _writeLocalStorage(key, value) {
        try {
            localStorage.setItem(this._prefix + key, JSON.stringify(value));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                // Recovery pass 1: prune chat history (largest consumer)
                const chatKey = this._prefix + 'chatHistory';
                try {
                    const raw = localStorage.getItem(chatKey);
                    if (raw) {
                        const history = JSON.parse(raw);
                        if (Array.isArray(history) && history.length > 20) {
                            const pruned = history.slice(-20);
                            localStorage.setItem(chatKey, JSON.stringify(pruned));
                            console.warn(`[Storage] Quota exceeded — pruned chat history from ${history.length} to ${pruned.length} messages`);
                            try {
                                localStorage.setItem(this._prefix + key, JSON.stringify(value));
                                return;
                            } catch {
                                // Still full — try draft eviction
                            }
                        }
                    }
                } catch {
                    // Pruning failed — try draft eviction
                }

                // Recovery pass 2: evict oldest drafts from localStorage
                try {
                    const drafts = this._getDraftsByAge();
                    let evicted = 0;
                    for (const draft of drafts) {
                        localStorage.removeItem(draft.key);
                        evicted++;
                        try {
                            localStorage.setItem(this._prefix + key, JSON.stringify(value));
                            console.warn(`[Storage] Quota exceeded — evicted ${evicted} draft(s) to free space`);
                            return;
                        } catch {
                            // Still full — evict another
                        }
                    }
                } catch {
                    // Draft eviction failed — fall through
                }

                // localStorage is full but that's OK — IDB has the data
                if (this._idbReady) {
                    console.debug(`[Storage] localStorage full for "${key}" — data safe in IndexedDB`);
                } else {
                    console.warn('[Storage] localStorage quota exceeded. Data not saved for key:', key);
                }
            } else {
                console.error('Storage set error:', e);
            }
        }
    },

    /**
     * List all draft keys sorted by age (oldest first) for eviction.
     * Uses localStorage directly since this is a localStorage recovery path.
     * @returns {Array<{key: string, timestamp: number}>}
     */
    _getDraftsByAge() {
        const drafts = [];
        const prefix = this._prefix + 'draft-';
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) {
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    drafts.push({ key, timestamp: data?.timestamp || 0 });
                } catch {
                    drafts.push({ key, timestamp: 0 });
                }
            }
        }
        // Oldest first — evict stale drafts before recent ones
        drafts.sort((a, b) => a.timestamp - b.timestamp);
        return drafts;
    },

    /**
     * Remove a key from all storage layers.
     * @param {string} key
     */
    remove(key) {
        // Remove from all three layers
        this._cache.delete(key);

        if (this._idbReady && this._idb) {
            this._idb.remove(key).catch(e =>
                console.warn(`[Storage] IDB remove failed for "${key}":`, e.message)
            );
        }

        localStorage.removeItem(this._prefix + key);
    },

    /**
     * List all keys in storage, optionally filtered by prefix.
     * Reads from the in-memory cache (fast, synchronous).
     * @param {string} [prefix=''] — Key prefix to filter by
     * @returns {string[]}
     */
    keys(prefix = '') {
        const result = [];
        for (const key of this._cache.keys()) {
            if (!prefix || key.startsWith(prefix)) {
                result.push(key);
            }
        }
        return result;
    },

    /**
     * Whether IndexedDB is the active backend.
     * @returns {boolean}
     */
    get isIDBActive() {
        return this._idbReady;
    },

    // --- Draft management ---
    // Max draft size: 512KB for localStorage write-through.
    // IDB stores all drafts regardless of size.
    MAX_DRAFT_BYTES: 512 * 1024,

    /**
     * Save a file draft to storage.
     * @param {string} owner
     * @param {string} repo
     * @param {string} branch
     * @param {string} path
     * @param {string} content
     */
    saveDraft(owner, repo, branch, path, content) {
        const key = `draft-${owner}/${repo}/${branch}/${path}`;
        const payload = { content, timestamp: Date.now() };
        // Guard against large files blowing the localStorage quota
        const size = JSON.stringify(payload).length * 2; // UTF-16 chars ≈ 2 bytes each
        if (size > this.MAX_DRAFT_BYTES) {
            // Still save to cache + IDB, just skip localStorage
            this._cache.set(key, payload);
            if (this._idbReady && this._idb) {
                this._idb.set(key, payload).catch(e =>
                    console.warn(`[Storage] IDB write failed for draft "${path}":`, e.message)
                );
            }
            console.debug(`[Storage] Large draft (${(size / 1024).toFixed(0)}KB) for ${path} — saved to IDB only`);
        } else {
            this.set(key, payload);
        }
        State.drafts[`${owner}/${repo}/${branch}/${path}`] = content;
        EventBus.emit('draft:saved', { owner, repo, branch, path });
    },

    /**
     * Retrieve a saved draft.
     * @param {string} owner
     * @param {string} repo
     * @param {string} branch
     * @param {string} path
     * @returns {string|null}
     */
    getDraft(owner, repo, branch, path) {
        const key = `draft-${owner}/${repo}/${branch}/${path}`;
        const draft = this.get(key);
        return draft ? draft.content : null;
    },

    /**
     * Remove a saved draft.
     * @param {string} owner
     * @param {string} repo
     * @param {string} branch
     * @param {string} path
     */
    clearDraft(owner, repo, branch, path) {
        const key = `draft-${owner}/${repo}/${branch}/${path}`;
        this.remove(key);
        delete State.drafts[`${owner}/${repo}/${branch}/${path}`];
    },

    /**
     * List all saved drafts.
     * @returns {Array<{path: string, content: string, timestamp: number}>}
     */
    listDrafts() {
        const drafts = [];
        const prefix = 'draft-';
        for (const [key, data] of this._cache) {
            if (key.startsWith(prefix)) {
                const path = key.slice(prefix.length);
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
    /** @type {Object.<string, {manifest: PluginManifest, enabled: boolean, instance: *|null, config: Object}>} */
    _registered: {},
    /** @type {Object.<string, string[]>} */
    _hooks: {},
    /** @type {Array<{pluginId: string, icon: string, label: string, onClick: Function}>} */
    _buttons: [],
    /** @type {Object.<string, {pluginId: string, id: string, title: string, render: Function, width?: number}>} */
    _modals: {},

    /**
     * Register a plugin.
     * @param {PluginManifest} manifest
     * @returns {boolean}
     */
    register(manifest) {
        if (!manifest.id || !manifest.name) {
            console.error('Plugin missing id or name:', manifest);
            return false;
        }

        // Load persisted state (enabled/disabled + config)
        const savedState = Storage.get('pluginState') || {};
        const pluginState = savedState[manifest.id] || {};

        this._registered[manifest.id] = {
            manifest,
            enabled: pluginState.enabled !== undefined ? pluginState.enabled : (manifest.defaultEnabled !== undefined ? manifest.defaultEnabled : true),
            instance: null,
            config: pluginState.config || (manifest.defaultConfig ? { ...manifest.defaultConfig } : {})
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

    /**
     * Initialize a registered plugin.
     * @param {string} pluginId
     * @returns {Promise<boolean>}
     */
    async init(pluginId) {
        const plugin = this._registered[pluginId];
        if (!plugin) return false;

        if (!plugin.enabled) {
            console.log(`Plugin skipped (disabled): ${pluginId}`);
            return false;
        }

        if (plugin.manifest.init) {
            try {
                plugin.instance = await plugin.manifest.init(plugin.config);
            } catch (e) {
                console.error(`Plugin init failed: ${pluginId}`, e);
                return false;
            }
        }

        EventBus.emit('plugin:initialized', pluginId);
        return true;
    },

    /**
     * Run a hook across all enabled plugins.
     * @param {string} hookName
     * @param {*} data
     * @returns {Promise<*>}
     */
    async runHook(hookName, data) {
        const plugins = this._hooks[hookName] || [];
        let result = data;

        for (const pluginId of plugins) {
            const plugin = this._registered[pluginId];
            if (!plugin || !plugin.enabled) continue;

            const hookFn = plugin.manifest[hookName];
            if (hookFn) {
                try {
                    result = await hookFn(result, plugin.instance, plugin.config);
                } catch (e) {
                    console.error(`Hook ${hookName} failed in ${pluginId}:`, e);
                }
            }
        }

        return result;
    },

    /**
     * Get a plugin's registration entry.
     * @param {string} pluginId
     * @returns {{manifest: PluginManifest, enabled: boolean, instance: *, config: Object}|undefined}
     */
    get(pluginId) {
        return this._registered[pluginId];
    },

    /**
     * List all registered plugins.
     * @returns {Array<PluginManifest & {enabled: boolean, config: Object}>}
     */
    list() {
        return Object.values(this._registered).map(p => ({
            ...p.manifest,
            enabled: p.enabled,
            config: p.config
        }));
    },

    getConfig(pluginId) {
        const plugin = this._registered[pluginId];
        return plugin ? { ...plugin.config } : {};
    },

    setConfig(pluginId, config) {
        const plugin = this._registered[pluginId];
        if (!plugin) return;
        plugin.config = { ...config };
        this._persistState();
        EventBus.emit('plugin:configChanged', { pluginId, config });
    },

    /**
     * Enable or disable a plugin.
     * @param {string} pluginId
     * @param {boolean} enabled
     */
    setEnabled(pluginId, enabled) {
        const plugin = this._registered[pluginId];
        if (!plugin) return;
        plugin.enabled = enabled;
        this._persistState();
        EventBus.emit('plugin:enabledChanged', { pluginId, enabled });
    },

    registerButton(pluginId, { icon, label, onClick }) {
        this._buttons.push({ pluginId, icon, label, onClick });
        EventBus.emit('plugin:buttonRegistered', { pluginId, icon, label });
    },

    getButtons() {
        return this._buttons.filter(b => {
            const p = this._registered[b.pluginId];
            return p && p.enabled;
        });
    },

    registerModal(pluginId, { id, title, render, width }) {
        this._modals[id] = { pluginId, id, title, render, width };
        EventBus.emit('plugin:modalRegistered', { pluginId, id });
    },

    getModal(modalId) {
        return this._modals[modalId];
    },

    _persistState() {
        const state = {};
        for (const [id, plugin] of Object.entries(this._registered)) {
            state[id] = { enabled: plugin.enabled, config: plugin.config };
        }
        Storage.set('pluginState', state);
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
