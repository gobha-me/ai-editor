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
 * @property {string}               embeddingProvider
 * @property {string}               embeddingEndpoint
 * @property {string}               embeddingApiKey
 * @property {string}               embeddingModel
 * @property {boolean}              autoReindex
 * @property {number}               embeddingCacheExpiry
 * @property {number}               maxRelevantFiles
 * @property {number}               maxIndexFiles
 * @property {number}               maxIndexTokens
 * @property {string}               llmEndpoint
 * @property {string}               llmApiKey
 * @property {string}               llmModel
 * @property {string}               commitModel
 * @property {string[]}             disabledModels
 * @property {Object}               modelOverrides
 * @property {string}               apiProvider
 * @property {VeniceParameters}     veniceParameters
 * @property {OpenRouterParameters} openRouterParameters
 * @property {number}               llmIdleTimeout
 * @property {number}               toolTimeout
 * @property {number}               summaryTimeout
 * @property {string}               role
 * @property {number}               uiScale
 * @property {number}               editorFontSize
 * @property {boolean}              showIssues
 * @property {boolean}              showPullRequests
 * @property {boolean}              showLineNumbers
 * @property {'default'|'vim'}      editorKeybindingMode
 * @property {boolean}              editorScanInvisibleUnicode
 * @property {'refined'|'editorial'} theme
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

// 2.0.0 — slice 3 of path-to-2.0.0. One-shot `settings.role` →
// `settings.profile` migration; runs from `loadSettings`. Helper extracted
// to `profiles/migration.js` so the migration test suite is Node-importable
// (browser-only globals on `core.js` are otherwise transitive).
import { migrateRoleToProfile } from './profiles/migration.js';

// 2.0.0 — slice 3: profile registry, exposed via `window.AIEditor.Profiles`
// for external plugins (replaces the retired `Roles` namespace).
import { Profiles } from './profiles/registry.js';

// 2.9.0 — production rate-limit pacer singleton, exposed via
// `window.AIEditor.Pacer` for DevTools introspection (snapshotAll) and
// the synthetic near-cap verification recipe (`_pool` debug hatch).
import { getPool as _getPacerPool } from './llm/pacer.js';

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
        embeddingProvider: 'local',// 'local' (Transformers.js in-browser) | 'openai' | 'venice' | 'openrouter' | 'ollama'
        embeddingEndpoint: '',     // OpenAI-compat embeddings URL — unused when embeddingProvider === 'local'
        embeddingApiKey: '',       // Bearer token — unused when embeddingProvider === 'local'
        embeddingModel: 'Xenova/all-MiniLM-L6-v2', // Local Transformers.js model or remote provider model id
        autoReindex: true,         // Auto-update embeddings on file changes
        embeddingCacheExpiry: 7,   // Days before re-indexing
        maxRelevantFiles: 5,       // Max files to return for context queries
        maxIndexFiles: 5000,       // Hard upper-bound safety net (2.4.0); was 200 pre-2.4.0 as the primary lever
        maxIndexTokens: 300000,    // 2.4.0 — primary ingest budget (chars/3.5 heuristic). ~700 avg-size files.

        // Retrieval (1.5.12 paraphrase + 1.8.1 cross-file expansion) — query
        // rewriting pre-passes plus future retrieval knobs.
        //
        // Two mutually exclusive levers:
        //   • `paraphraseMode` (1.5.12): vocabulary-different rewordings via
        //     `buildParaphraserFromSettings` in
        //     `js/intelligence/retrieval/query-paraphraser.js`. Composer
        //     fuses `[req.query, ...paraphrases]` (baseline kept).
        //   • `crossFileExpansionMode` (1.8.1, lever B): codebase-aware
        //     identifier-vocabulary alts via `buildExpanderFromSettings` in
        //     `js/intelligence/retrieval/query-expander.js`. Composer fuses
        //     `[...alts]` only (drop-baseline-from-fusion rule from the
        //     2026-05-07 probe; baseline is the noisy ranking we're
        //     escaping). When both modes are non-`'off'`, the expander wins
        //     (back-end source of truth; Settings → Retrieval UI guards the
        //     usual case).
        //
        // Both default to 'off' so upgrade is a no-op until explicit opt-in.
        retrieval: {
            paraphraseMode: 'off',                  // 'off' | 'primary' | 'utility'
            paraphraseModelId: '',                  // Used when paraphraseMode === 'utility'
            paraphraseRounds: 2,                    // 1–3
            paraphraseTemperature: 0,               // 0 = deterministic
            crossFileExpansionMode: 'off',          // 'off' | 'primary' | 'utility'
            crossFileExpanderModelId: '',           // Used when crossFileExpansionMode === 'utility'
            crossFileExpanderRounds: 3,             // 1–5; default 3 mirrors the lever-B probe
            crossFileExpanderTemperature: 0,        // 0 = deterministic
            // 2.89.0 (gitea#505) — third Utility Models entry. Cheap-tier
            // model id `delegate_task` sub-agents run on by default; empty
            // string falls through `paraphraseModelId` then to primary in
            // `subagent-runner.js`'s 5-step resolver chain. Provider stays
            // locked to primary (same constraint as paraphrase/expander).
            subagentModelId: '',                    // Used by delegate_task sub-agents
        },
        
        // LLM Configuration
        llmEndpoint: '',
        llmApiKey: '',
        llmModel: 'gpt-4',
        commitModel: '',           // Optional small/fast model for utility tasks (commit msgs, summaries)
        disabledModels: [],        // Model IDs hidden from chat selector (blacklist)
        modelOverrides: {},        // Per-model capability/context overrides: { [modelId]: { capabilities?: {}, contextTokens?: number } }
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
        llmIdleTimeout: 90000,     // 90 seconds - Resets on every streamed chunk; aborts when no token arrives within this window
        toolTimeout: 30000,        // 30 seconds - Individual tool execution timeout (standard tools)
        longRunningToolTimeout: 300000, // 5 minutes - Timeout for long-running tools (wait_for_ci, etc.)
        summaryTimeout: 60000,     // 1 minute - Chat summary generation timeout
        
        // UI Configuration
        // 2.0.0 — slice 3: `role` retired. Active surface is the profile
        // picker; pre-2.0.0 settings blobs are migrated by
        // `migrateRoleToProfile` at `loadSettings` time. Default `null`
        // resolves to `chat.v1` (the lowest-config baseline) via
        // `getActiveProfileName`.
        profile: null,             // Active profile: 'coder.v1' | 'chat.v1' | null (= chat.v1 implicit)
        uiScale: 100,              // UI scale percent (80-175); drives --ui-font-size and --chat-font-size from a 13px base
        editorFontSize: 14,        // Editor font size in px (independent of uiScale by design — code is the one place users want different sizing)
        showIssues: true,          // Show issues panel in sidebar
        showPullRequests: true,    // Show pull requests panel in sidebar
        showLineNumbers: true,     // Show line numbers in editor
        editorKeybindingMode: 'default', // 'default' | 'vim' — keybinding profile for the editor
        editorScanInvisibleUnicode: true, // Surface zero-width / bidi-override / glassworm chars in the editor
        theme: 'refined',          // 'refined' | 'editorial' — Touch 2 facelift theme (1.3.5+).
                                   // Older installs may carry 'dark' / 'light' from the
                                   // pre-facelift schema; loadSettings() migrates those.

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
    branchMetadata: {},        // { [branchName]: { ahead: number|null, behind: number|null } } — populated lazily on `branches:refresh` against the project's default branch (1.12.0). null = "unknown / not applicable" (e.g. local provider, comparison failed); UI hides counts in that case.
    projectConventions: null,  // Verbatim contents of repo-root CLAUDE.md fetched once on `project:loaded`; null when absent or fetch failed (github#37 Phase 1).
    models: [],                // [{ id, name, capabilities, pricing, meta }]
    
    // Editor state - Multi-tab support
    openTabs: [],              // [{ path, content, originalContent, sha, dirty, isPreview, type?: 'file'|'issue', issueNumber?, issueData? }]
    activeTabIndex: -1,        // Index of currently active tab
    editorContent: '',         // Current buffer
    editorDirty: false,        // Has unsaved changes
    drafts: {},                // { 'owner/repo/branch/path': content }

    // Chat state
    chatHistory: [],           // [{ role, content, timestamp }]
    isGenerating: false,

    // Last LLM exchange's wire-level token usage. Populated by LLM._trackUsage()
    // after every chat completion; read by ChatSummarizer.shouldSummarize() to
    // gate on real prompt size instead of estimated message count (1.6.4).
    lastExchangeTokens: null,  // { prompt, cached, ts } | null

    // Session cost tracking
    sessionCost: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cachedInputTokens: 0,   // Tokens served from prompt cache (OpenAI prompt_tokens_details.cached_tokens; falls back to Anthropic cache_read_input_tokens via extractUsage in 1.8.5)
        reasoningTokens: 0,     // Thinking/reasoning tokens consumed
        cacheReadTokens: 0,     // 1.8.5 — Anthropic-native cache_read_input_tokens, surfaced separately for UI even when also folded into cachedInputTokens
        cacheCreationTokens: 0, // 1.8.5 — Anthropic-native cache_creation_input_tokens (no OpenAI equivalent)
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

    // Structured todo list — LLM-owned task tracker (github#26).
    // Conversation-scoped; persisted in the conv-{id} payload by ConversationManager.
    // Re-injected into the system prompt every turn (see buildTodoPrompt).
    todo: [],                  // [{ id, content, status, activeForm? }] — max 20 items

    // Tool action log — survives summarization so AI remembers what it did
    // even after tool results are evicted from context (Issue #17)
    toolActionLog: [],         // [{ toolName, args, resultSummary, timestamp, success }]

    // Sub-agent state (2.49.0.0 — slice 1 of github#24 Phase 1).
    // Owned by the `delegate_task` tool family per
    // `docs/DESIGN-sub-agents.md` §"Gap 1" — *not* aliased to chat
    // surfaces. Single top-level slot preserves the single-global-state
    // constraint.
    //   - `tree[transcriptId]`        — live `SubAgentContext` objects (slice 2)
    //   - `transcripts[transcriptId]` — per-sub-agent message + result history
    //   - `session_cost`              — cumulative across all sub-agent calls in
    //                                   the active parent conversation; gated
    //                                   by `State.settings.subagentSessionCap`
    //                                   in slice 2. 2.89.0 (gitea#505) extends
    //                                   the shape with `byModel: { <id>: {
    //                                   dollars, tokens } }` so the cost split
    //                                   from running children on a cheap-tier
    //                                   utility model surfaces honestly. The
    //                                   scalar `dollars` / `tokens` totals
    //                                   stay — they're the cap-check basis.
    // Slice 1 lands the shape; no consumer reads or writes it yet.
    // Persisted in the conv-{id} payload by `ConversationManager.save`
    // in slice 2 (DESIGN §"Lifecycle, step by step" — step 11).
    subagents: { tree: {}, transcripts: {}, session_cost: { dollars: 0, tokens: 0, byModel: {} } },

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
 * 
 * Tab isolation (0.9.39-2):
 *   Session-volatile keys (chatHistory, session, chatSummaryInfo,
 *   chatPruneStash, activeConversation) are scoped per browser tab
 *   using a tab ID from sessionStorage. Two tabs editing different
 *   projects won't stomp each other's chat or session state.
 *   Shared keys (settings, drafts, conversations, etc.) are unaffected.
 *   Stale tab data is cleaned on init (heartbeat > 5 min or closing flag).
 */
const Storage = {
    _prefix: 'ai-editor-',
    _cache: new Map(),
    _idb: null,             // IDB module reference (lazy-loaded)
    _idbReady: false,       // true after successful IDB init
    _initPromise: null,     // Deduplication for concurrent init calls

    // ── Tab isolation (0.9.39-2) ──────────────────────────────
    // These keys are session-volatile: each browser tab gets its own
    // copy so two tabs never stomp each other's chat, session, etc.
    // Everything else (settings, drafts, conversations) stays shared.
    _tabId: null,
    _TAB_SCOPED: new Set([
        'chatHistory',
        'chatSummaryInfo',
        'chatPruneStash',
        'activeConversation',
        'session',
    ]),
    _TAB_PFX: '~t',        // prefix marker for scoped keys
    _TAB_SEP: '~',          // separator between tabId and key

    /** Generate or retrieve a stable tab ID from sessionStorage. */
    _initTabId() {
        const SK = 'ai-editor-tab-id';
        let id = sessionStorage.getItem(SK);
        if (!id) {
            id = Math.random().toString(36).slice(2, 10);
            sessionStorage.setItem(SK, id);
        }
        this._tabId = id;

        // If beforeunload marked us "closing" but we're back → refresh, clear the flag
        try {
            const raw = localStorage.getItem(this._prefix + '_tabRegistry');
            if (raw) {
                const reg = JSON.parse(raw);
                if (reg[id]?.closing) {
                    reg[id] = { ts: Date.now(), closing: false };
                    localStorage.setItem(this._prefix + '_tabRegistry', JSON.stringify(reg));
                }
            }
        } catch { /* ignore */ }
    },

    /**
     * Resolve a caller-facing key to its internal (possibly tab-scoped) key.
     * Shared keys pass through unchanged. Tab-scoped keys become ~t{id}~{key}.
     */
    _resolveKey(key) {
        if (this._tabId && this._TAB_SCOPED.has(key)) {
            return `${this._TAB_PFX}${this._tabId}${this._TAB_SEP}${key}`;
        }
        return key;
    },

    /**
     * Parse a raw internal key. Returns { tabId, key } if tab-scoped, else null.
     */
    _parseTabKey(rawKey) {
        if (!rawKey.startsWith(this._TAB_PFX)) return null;
        const sep = rawKey.indexOf(this._TAB_SEP, this._TAB_PFX.length);
        if (sep < 0) return null;
        return {
            tabId: rawKey.slice(this._TAB_PFX.length, sep),
            key:   rawKey.slice(sep + 1),
        };
    },

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
        // Establish tab identity first (synchronous, from sessionStorage)
        this._initTabId();

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

        // Tab isolation lifecycle (after cache is populated)
        this._migrateTabScopedKeys();
        this._registerTab();
        this._cleanStaleTabs();
        this._startHeartbeat();
        this._initBeforeUnload();
        console.log(`[Storage] Tab ${this._tabId} registered`);
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
        const resolved = this._resolveKey(key);
        // Primary: in-memory cache (populated by init)
        if (this._cache.has(resolved)) {
            return this._cache.get(resolved);
        }
        // Pre-init fallback: read directly from localStorage
        // This ensures module-scope code that runs before init() still works
        try {
            const item = localStorage.getItem(this._prefix + resolved);
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
        const resolved = this._resolveKey(key);
        // 1. Always update in-memory cache (immediate, synchronous)
        this._cache.set(resolved, value);

        // 2. Async persist to IDB (fire-and-forget)
        if (this._idbReady && this._idb) {
            this._idb.set(resolved, value).catch(e =>
                console.warn(`[Storage] IDB write failed for "${resolved}":`, e.message)
            );
        }

        // 3. Write-through to localStorage (with quota handling)
        this._writeLocalStorage(resolved, value);
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
                // Do NOT prune chatHistory: IDB + _cache hold the full payload,
                // and the misleading warning reads like data loss (see 1.6.5).
                // Drafts have no IDB shadow — evict those instead.
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
        const resolved = this._resolveKey(key);
        // Remove from all three layers
        this._cache.delete(resolved);

        if (this._idbReady && this._idb) {
            this._idb.remove(resolved).catch(e =>
                console.warn(`[Storage] IDB remove failed for "${resolved}":`, e.message)
            );
        }

        localStorage.removeItem(this._prefix + resolved);
    },

    /**
     * List all keys in storage, optionally filtered by prefix.
     * Reads from the in-memory cache (fast, synchronous).
     * @param {string} [prefix=''] — Key prefix to filter by
     * @returns {string[]}
     */
    keys(prefix = '') {
        const result = [];
        for (const rawKey of this._cache.keys()) {
            const parsed = this._parseTabKey(rawKey);
            if (parsed) {
                // Tab-scoped: only show keys belonging to this tab, unprefixed
                if (parsed.tabId === this._tabId) {
                    if (!prefix || parsed.key.startsWith(prefix)) {
                        result.push(parsed.key);
                    }
                }
                // Other tabs' keys are invisible
            } else {
                // Shared key
                if (!prefix || rawKey.startsWith(prefix)) {
                    result.push(rawKey);
                }
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
    },

    // ── Tab isolation lifecycle ───────────────────────────────

    /**
     * One-time migration: move unscoped tab-volatile keys → this tab's scope.
     * Handles the upgrade from pre-isolation storage to per-tab storage.
     */
    _migrateTabScopedKeys() {
        let migrated = 0;
        for (const key of this._TAB_SCOPED) {
            const resolved = this._resolveKey(key);
            if (!this._cache.has(resolved) && this._cache.has(key)) {
                // Unscoped key exists but scoped doesn't — adopt it
                const value = this._cache.get(key);
                this._cache.set(resolved, value);
                if (this._idbReady && this._idb) {
                    this._idb.set(resolved, value).catch(() => {});
                    this._idb.remove(key).catch(() => {});
                }
                this._cache.delete(key);
                localStorage.removeItem(this._prefix + key);
                migrated++;
            }
        }
        if (migrated > 0) {
            console.log(`[Storage] Migrated ${migrated} key(s) to tab scope (tab ${this._tabId})`);
        }
    },

    /**
     * One-time migration: copy an unprefixed legacy localStorage key into
     * Storage (cache + IDB + prefixed localStorage) and remove the legacy
     * entry. Idempotent — safe to call on every read after migration since
     * the legacy key is gone.
     *
     * Used by 2.40.0 storage discipline sweep to migrate ad-hoc raw
     * localStorage call sites onto the Storage wrapper without orphaning
     * existing user data (Storage prepends `_prefix: 'ai-editor-'`, so a
     * naive switch would leave legacy unprefixed keys unreachable).
     *
     * @param {string} legacyKey — Unprefixed localStorage key to read.
     * @param {string} storageKey — Storage-API key to write under.
     * @param {{ transform?: (str: string) => any }} [opts]
     *   transform: maps the raw string value to the parsed shape Storage
     *   should hold. Defaults to `JSON.parse` (matches Storage's own
     *   serialization). Use `s => s` for already-stringy values, or
     *   `s => s === '1'` for the boolean-as-string-flag pattern.
     * @returns {boolean} true if migration ran (or legacy key existed and
     *   storageKey already populated → legacy removed without overwrite);
     *   false if nothing to migrate.
     */
    migrateLegacyKey(legacyKey, storageKey, { transform = JSON.parse } = {}) {
        let legacyValue;
        try {
            legacyValue = localStorage.getItem(legacyKey);
        } catch {
            return false;
        }
        if (legacyValue === null) return false;

        // Storage already populated → drop the legacy duplicate (don't overwrite
        // a freshly-written value with a stale legacy one).
        const resolved = this._resolveKey(storageKey);
        const alreadyPopulated = this._cache.has(resolved) ||
            (() => {
                try { return localStorage.getItem(this._prefix + resolved) !== null; }
                catch { return false; }
            })();
        if (alreadyPopulated) {
            try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
            return true;
        }

        let parsed;
        try {
            parsed = transform(legacyValue);
        } catch (e) {
            // Corrupt legacy value — remove it; caller falls through to default.
            console.debug(`[Storage] migrateLegacyKey: invalid value at "${legacyKey}":`, e?.message || e);
            try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
            return false;
        }

        this.set(storageKey, parsed);
        try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
        return true;
    },

    /** Register this tab in the shared registry with a heartbeat timestamp. */
    _registerTab() {
        const key = '_tabRegistry';
        const reg = this._cache.get(key) || {};
        reg[this._tabId] = { ts: Date.now(), closing: false };
        // Write through all layers (key is not tab-scoped)
        this._cache.set(key, reg);
        if (this._idbReady && this._idb) {
            this._idb.set(key, reg).catch(() => {});
        }
        try { localStorage.setItem(this._prefix + key, JSON.stringify(reg)); } catch { /* ignore */ }
    },

    /**
     * Clean up scoped data from tabs that are no longer alive.
     * A tab is stale if: marked "closing" (tab closed, not refreshed)
     * or its heartbeat is older than 5 minutes (crash / kill).
     */
    _cleanStaleTabs() {
        const key = '_tabRegistry';
        const reg = this._cache.get(key) || {};
        const STALE_MS = 5 * 60 * 1000;
        const now = Date.now();
        const staleIds = [];

        for (const [id, info] of Object.entries(reg)) {
            if (id === this._tabId) continue;
            const ts = typeof info === 'number' ? info : info?.ts || 0;
            const closing = typeof info === 'object' && info?.closing;
            if (closing || (now - ts) > STALE_MS) {
                staleIds.push(id);
            }
        }
        if (staleIds.length === 0) return;

        // Remove scoped keys for each stale tab
        for (const staleId of staleIds) {
            const pfx = `${this._TAB_PFX}${staleId}${this._TAB_SEP}`;
            for (const rawKey of [...this._cache.keys()]) {
                if (rawKey.startsWith(pfx)) {
                    this._cache.delete(rawKey);
                    if (this._idbReady && this._idb) {
                        this._idb.remove(rawKey).catch(() => {});
                    }
                    localStorage.removeItem(this._prefix + rawKey);
                }
            }
            delete reg[staleId];
        }

        // Persist cleaned registry
        this._cache.set(key, reg);
        if (this._idbReady && this._idb) {
            this._idb.set(key, reg).catch(() => {});
        }
        try { localStorage.setItem(this._prefix + key, JSON.stringify(reg)); } catch { /* ignore */ }
        console.log(`[Storage] Cleaned ${staleIds.length} stale tab(s): ${staleIds.join(', ')}`);
    },

    /** Heartbeat: update registry timestamp every 60 s so stale detection works. */
    _startHeartbeat() {
        setInterval(() => this._registerTab(), 60_000);
    },

    /**
     * On beforeunload, mark this tab as "closing" in the registry.
     * If the tab is actually refreshing (not closing), _initTabId()
     * detects the sessionStorage survived and clears the flag.
     */
    _initBeforeUnload() {
        window.addEventListener('beforeunload', () => {
            try {
                const raw = localStorage.getItem(this._prefix + '_tabRegistry');
                const reg = raw ? JSON.parse(raw) : {};
                if (reg[this._tabId]) {
                    reg[this._tabId] = { ts: Date.now(), closing: true };
                    localStorage.setItem(this._prefix + '_tabRegistry', JSON.stringify(reg));
                }
            } catch { /* can't do much in beforeunload */ }
        });
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
    /** @type {Map<string, string>} Tool name → owning pluginId, populated by registerTool. */
    _toolOrigins: new Map(),
    /** @type {Object|null} Cached ToolRegistry reference (resolved on first registerTool call). */
    _toolRegistry: null,

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
                // 1.3.9: surface init errors to the Debug slide-out's
                // Plugins tab. The data carrier is in-memory (no
                // persisted side-effects), and capture remains a
                // no-op for any consumer that doesn't subscribe.
                EventBus.emit('plugin:initError', {
                    pluginId,
                    name: plugin.manifest.name || pluginId,
                    msg: e.message || String(e),
                });
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
     * Enable or disable a plugin. When transitioning disabled→enabled
     * for the first time, runs the plugin's `init()` so its buttons,
     * modals, hooks, and tools register. Without this, plugins shipped
     * with `defaultEnabled: false` (release-sync, cross-repo-issues)
     * would register at boot, get skipped by the boot-time `init()`
     * loop in `js/app.js`, and remain UI-less even after a user toggled
     * them on in Settings — symptom: plugin appears "enabled" but its
     * toolbar button never shows.
     *
     * @param {string}  pluginId
     * @param {boolean} enabled
     * @returns {Promise<void>} Resolves once the (possibly deferred)
     *   init() completes. Existing callers don't await; that's fine —
     *   the boolean flip is synchronous, only the init() runs after.
     */
    async setEnabled(pluginId, enabled) {
        const plugin = this._registered[pluginId];
        if (!plugin) return;
        const wasEnabled = plugin.enabled;
        plugin.enabled = enabled;
        this._persistState();
        EventBus.emit('plugin:enabledChanged', { pluginId, enabled });

        // First-time enable: run init() so the plugin can register its
        // buttons/modals/hooks/tools. Skip when re-enabling a plugin that
        // already has an instance (it set everything up once already and
        // we don't have an unregister path yet).
        if (enabled && !wasEnabled && !plugin.instance && plugin.manifest && plugin.manifest.init) {
            try {
                plugin.instance = await plugin.manifest.init(plugin.config);
                EventBus.emit('plugin:initialized', pluginId);
            } catch (e) {
                console.error(`Plugin init failed on enable: ${pluginId}`, e);
            }
        }

        // First-time disable: run destroy() so the plugin can release timers,
        // listeners, captured DOM nodes, etc. Symmetric mirror of the
        // first-enable init antibody above. Catch + log destroy errors —
        // never block disable persistence on a faulty cleanup hook. Clear
        // the captured instance so a redundant second disable no-ops and a
        // later re-enable runs init() fresh (the prior instance's state was
        // released by destroy).
        if (!enabled && wasEnabled && plugin.instance && plugin.manifest && plugin.manifest.destroy) {
            try {
                await plugin.manifest.destroy(plugin.instance, plugin.config);
            } catch (e) {
                console.error(`Plugin destroy failed on disable: ${pluginId}`, e);
            }
            plugin.instance = null;
        }
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

    /**
     * Convenience wrapper around ToolRegistry.register().
     * Lazily imports the registry to avoid circular deps (core ← registry ← core).
     *
     * @param {string} pluginId - Owning plugin ID (for logging)
     * @param {Object} opts
     * @param {string} opts.name - Tool name (snake_case)
     * @param {string} opts.description - Description shown to the LLM
     * @param {Object} opts.parameters - JSON Schema for tool arguments
     * @param {string|string[]} opts.roles - 'all' or array of role IDs
     * @param {(args: Object) => Promise<Object>} opts.handler - Tool handler
     */
    async registerTool(pluginId, { name, description, parameters, roles, handler }) {
        if (!name || !handler) {
            console.error(`[Plugins.registerTool] ${pluginId}: name and handler required`);
            return false;
        }
        try {
            const { ToolRegistry } = await import('./tools/registry.js');
            ToolRegistry.register(name, handler, {
                type: 'function',
                function: {
                    name,
                    description: description || `Tool provided by plugin: ${pluginId}`,
                    parameters: parameters || { type: 'object', properties: {}, required: [] }
                },
                roles: roles || 'all'
            });
            this._toolRegistry = ToolRegistry;
            this._toolOrigins.set(name, pluginId);
            console.log(`[Plugins] Tool registered: ${name} (plugin: ${pluginId})`);
            EventBus.emit('plugin:toolRegistered', { pluginId, name });
            return true;
        } catch (err) {
            console.error(`[Plugins.registerTool] ${pluginId}: failed to register ${name}:`, err);
            return false;
        }
    },

    /**
     * Enumerate plugin-registered tools that are currently in the live
     * ToolRegistry. Joins the in-memory `_toolOrigins` (toolName → pluginId)
     * map against the registry — entries whose tool was unregistered (e.g.
     * the MCP bridge dropping a server) are filtered out via the live
     * lookup. Returns the empty array before any plugin has registered a
     * tool (the ToolRegistry import hasn't resolved yet).
     *
     * Surfaced in Settings → Plugins → "Plugin Tools" subsection.
     *
     * @returns {Array<{name: string, pluginId: string, description: string, roles: string|string[]}>}
     */
    getRegisteredTools() {
        if (!this._toolRegistry) return [];
        const out = [];
        for (const [name, pluginId] of this._toolOrigins) {
            const def = this._toolRegistry.definitions.find(d => d.function?.name === name);
            if (!def) continue;
            out.push({
                name,
                pluginId,
                description: def.function?.description || '',
                roles: def.roles || 'all'
            });
        }
        return out;
    },

    /**
     * Convenience wrapper around the MCP bridge. Plugins can register a
     * connection to a Model Context Protocol server; on success the
     * server's advertised tools land in `ToolRegistry` (and therefore the
     * Catalog) under the canonical name `mcp__<serverId>__<toolName>`,
     * with category `mcp.<serverId>`. The MCP tools are NOT in any
     * profile's static set — they reach the model only via discovery
     * (`find_tool` / `list_tools_by_category`) + sticky admission, in
     * line with the §1.4.0 admissibility principle.
     *
     * Supports `transport: "streamable-http"` (default) only. Legacy HTTP+SSE
     * and stdio are rejected before network access; the browser runtime has no
     * subprocess capability.
     *
     * @param {string} pluginId - Owning plugin ID (for logging)
     * @param {Object} opts
     * @param {string} opts.id - Stable server id (slug). Used in tool names + persistence.
     * @param {string} opts.url - HTTP endpoint of the MCP server.
     * @param {string} [opts.label] - Display label (defaults to id).
     * @param {string} [opts.token] - Bearer token for the `Authorization` header.
     * @param {string} [opts.transport] - "streamable-http" (default).
     * @param {boolean} [opts.enabled] - Default true.
     * @returns {Promise<{ ok: boolean, toolCount: number, error?: string }>}
     */
    async registerMCPServer(pluginId, opts) {
        if (!opts || !opts.id || !opts.url) {
            console.error(`[Plugins.registerMCPServer] ${pluginId}: id and url required`);
            return { ok: false, toolCount: 0, error: 'id and url required' };
        }
        try {
            const { MCPServerRegistry } = await import('./mcp/registry.js');
            const bridge = await import('./mcp/bridge.js');

            // If the registry already knows about this id, leave its
            // persisted record alone; only add when the plugin-supplied
            // record is genuinely new. This lets the bundled plugin call
            // through after `loadServers(...)` has populated state.
            if (!MCPServerRegistry.getServer(opts.id)) {
                MCPServerRegistry.addServer({
                    id: opts.id,
                    label: opts.label || opts.id,
                    url: opts.url,
                    token: opts.token || '',
                    transport: opts.transport ?? 'streamable-http',
                    enabled: opts.enabled !== false,
                });
            }

            const result = await bridge.connect(opts.id);
            EventBus.emit('plugin:mcpServerRegistered', { pluginId, serverId: opts.id, ok: result.ok, toolCount: result.toolCount });
            return result;
        } catch (err) {
            console.error(`[Plugins.registerMCPServer] ${pluginId}: failed to register ${opts.id}:`, err);
            return { ok: false, toolCount: 0, error: err?.message || String(err) };
        }
    },

    /**
     * Inject a scoped <style> tag for a plugin.
     * Multiple calls with the same pluginId replace the previous sheet.
     *
     * @param {string} pluginId - Owning plugin ID (used as style element ID)
     * @param {string} cssText - Raw CSS to inject
     */
    injectCSS(pluginId, cssText) {
        if (!pluginId || !cssText) return;
        const styleId = `plugin-css-${pluginId}`;
        let el = document.getElementById(styleId);
        if (!el) {
            el = document.createElement('style');
            el.id = styleId;
            el.setAttribute('data-plugin', pluginId);
            document.head.appendChild(el);
        }
        el.textContent = cssText;
        console.log(`[Plugins] CSS injected: ${pluginId} (${cssText.length} chars)`);
    },

    /**
     * Remove injected CSS for a plugin.
     * @param {string} pluginId
     */
    removeCSS(pluginId) {
        const el = document.getElementById(`plugin-css-${pluginId}`);
        if (el) {
            el.remove();
            console.log(`[Plugins] CSS removed: ${pluginId}`);
        }
    },

    _persistState() {
        const state = {};
        for (const [id, plugin] of Object.entries(this._registered)) {
            state[id] = { enabled: plugin.enabled, config: plugin.config };
        }
        Storage.set('pluginState', state);
    }
};

// Drop the toolName→pluginId entry when ToolRegistry.unregister() fires.
// Reuses the `tools:unregistered` event already emitted at js/tools/registry.js:139.
EventBus.on('tools:unregistered', (payload) => {
    const name = payload && typeof payload.name === 'string' ? payload.name : null;
    if (name) Plugins._toolOrigins.delete(name);
});

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
    },
    async enrichModels(models, settings) {
        return ProviderRegistry.enrichModels(models, settings);
    }
};

// ============================================
// ROLE DEFINITIONS — RETIRED AT 2.0.0
// ============================================
//
// The profile picker is the configuration surface; admission filtering goes through
// `Profiles.filterTools` (`js/profiles/registry.js`).
//
// External plugins that imported `Roles` from `window.AIEditor` get a
// one-version deprecation shim below — see the `window.AIEditor` block
// at the bottom of this module. The shim retires at 2.1.0.

// ============================================
// INITIALIZATION
// ============================================

function loadSettings() {
    const saved = Storage.get('settings');
    if (saved) {
        // One-shot migration (1.1.1): wall-clock llmTimeout → idle llmIdleTimeout.
        // Same numeric value, different semantics (resets on each streamed chunk
        // instead of firing once from fetch start). Drops the old key so the
        // migration runs at most once per stored settings blob.
        if (saved.llmTimeout !== undefined && saved.llmIdleTimeout === undefined) {
            saved.llmIdleTimeout = saved.llmTimeout;
            delete saved.llmTimeout;
        }
        // One-shot migration (1.1.2): split shared LLM/embedder credentials.
        // Pre-1.1.2 the embedder shared llmEndpoint + llmApiKey with the chat
        // LLM and inferred local-vs-remote from embeddingModel.startsWith('Xenova/').
        // Now the embedder has its own provider/endpoint/apiKey; mode is explicit.
        // Local-mode users get an empty endpoint/key (sentinel only); remote-mode
        // users get llm* cloned across so behavior is bit-for-bit equivalent.
        // One-shot migration (1.3.5): theme schema becomes Touch 2 names.
        // Pre-1.3.5 settings carried `theme: 'dark'` (or 'light', unused);
        // post-1.3.5 valid values are 'refined' (the new default that
        // mirrors today's dark palette) and 'editorial'. 'dark' → 'refined'
        // is bit-equivalent for existing users; anything unrecognized falls
        // back to the default rather than carrying an invalid value forward.
        if (saved.theme && saved.theme !== 'refined' && saved.theme !== 'editorial') {
            saved.theme = 'refined';
        }
        // One-shot migration (1.3.13): three-axis font sizes → single uiScale.
        // Pre-1.3.13 settings carried independent fontSize / chatFontSize / editorFontSize
        // sliders; the UI scale slider replaces the first two with a percent-based knob
        // (default 100 == 13px). Editor font size keeps its own knob. Migration picks
        // max(legacy) so users who scaled either surface up don't lose ground.
        if (saved.uiScale === undefined && (saved.fontSize !== undefined || saved.chatFontSize !== undefined)) {
            const maxLegacy = Math.max(saved.fontSize || 13, saved.chatFontSize || 13);
            const raw = (maxLegacy / 13) * 100;
            const snapped = Math.round(raw / 5) * 5;
            saved.uiScale = Math.max(80, Math.min(175, snapped));
            delete saved.fontSize;
            delete saved.chatFontSize;
        }
        // One-shot migration (2.0.0): role-keyed surface → profile-keyed surface.
        // Pre-2.0.0 the chat panel + settings tab carried a Role selector;
        // 2.0.0 retires it for the profile picker. The 5-key table inside
        // `migrateRoleToProfile` mirrors the cross-product equivalence test
        // (`tests/test-profile-filter-tools.mjs:ROLE_TO_PROFILE`) verbatim —
        // divergence across the two is the bug. Subsequent loads idle through
        // (the helper is idempotent — once `profile` is set, no rewrite).
        //
        // Slice 3 ships in two commits: commit A (this) writes `profile` and
        // preserves `role` for legacy readers; commit B flips every consumer
        // and adds `delete saved.role` to the helper.
        const _profileMigration = migrateRoleToProfile(saved);
        if (_profileMigration.migrated) {
            console.log(
                `[loadSettings] 2.0.0 migration: role='${_profileMigration.fromRole}' → ` +
                `profile='${_profileMigration.toProfile}'. Profile picker is now the ` +
                `load-bearing configuration surface.`
            );
        }

        if (saved.embeddingProvider === undefined) {
            const isLocalModel = (saved.embeddingModel || '').startsWith('Xenova/');
            if (isLocalModel) {
                saved.embeddingProvider = 'local';
                saved.embeddingEndpoint = '';
                saved.embeddingApiKey = '';
            } else if (saved.embeddingModel) {
                saved.embeddingProvider = saved.apiProvider || 'openai';
                saved.embeddingEndpoint = saved.llmEndpoint || '';
                saved.embeddingApiKey = saved.llmApiKey || '';
            }
            // Otherwise: no model and no provider → fresh-install default 'local'
            // wins via the merge spread below.
        }
        // One-shot migration (2.4.0): legacy `maxIndexFiles` was the primary
        // ingest lever (default 200, slider min 25). 2.4.0 demotes it to a
        // safety net (default 5000, slider min 500) and introduces
        // `maxIndexTokens` as the primary lever. A saved value below the new
        // slider min would clamp visually but persist as 200 — confusing.
        // Bump anything below the new floor to the new default; users who
        // explicitly raised the cap pre-2.4.0 keep their setting.
        if (typeof saved.maxIndexFiles === 'number' && saved.maxIndexFiles < 500) {
            saved.maxIndexFiles = 5000;
        }
        // Deep-merge known nested objects so new defaults aren't lost on upgrade.
        // Top-level keys are spread first, then nested objects are merged individually.
        const nestedKeys = ['veniceParameters', 'openRouterParameters', 'advancedParams', 'retrieval'];
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
// GLOBAL API FOR EXTERNAL PLUGINS
// ============================================
// External plugins loaded via URL can't use ES module imports with
// relative paths. They use window.AIEditor instead:
//   const { Plugins, EventBus, State } = window.AIEditor;

window.AIEditor = {
    Plugins,
    EventBus,
    State,
    Storage,
    Providers,
    Profiles,
    // 2.9.0 — rate-limit pacer state. `snapshotAll()` returns
    // `{ [modelId]: { rpmLimit, tpmLimit, remainingReq, remainingTok,
    // resetReqAt, resetTokAt } }` for status-pill or DevTools probing.
    // `_pool` is a debug hatch for the synthetic near-cap recipe.
    Pacer: {
        snapshotAll: () => _getPacerPool().snapshotAll(),
        get _pool() { return _getPacerPool(); },
    },
    // 2.0.0 — slice 3: `Roles` retired. Deprecation shim warns once on
    // first access so plugin authors importing `Roles` from
    // `window.AIEditor` see a migration hint instead of a silent
    // `undefined` crash. The shim retires at 2.1.0.
    get Roles() {
        if (!_rolesDeprecationWarned) {
            _rolesDeprecationWarned = true;
            console.warn(
                '[ai-editor] `window.AIEditor.Roles` was retired at 2.0.0. ' +
                'Use `window.AIEditor.Profiles` (filter tools via ' +
                '`Profiles.filterTools(defs, profileName)`); the active profile ' +
                'is `State.settings.profile` (default `chat.v1`). This shim ' +
                'retires at 2.1.0.'
            );
        }
        return undefined;
    },
};
let _rolesDeprecationWarned = false;

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
    DEFAULT_CAPABILITIES,
    loadSettings,
    saveSettings,
    saveDraftNow
};
