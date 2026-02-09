/**
 * Provider Registry
 * 
 * Pluggable API provider system. OpenAI-compatible is the base protocol;
 * providers like Venice.ai and OpenRouter extend it via transform hooks.
 * 
 * Provider interface:
 *   id            - Unique key (e.g. 'venice', 'openrouter')
 *   name          - Display name
 *   description   - Short description for settings UI
 *   defaultEndpoint - Auto-fill when provider is selected (optional)
 *   settingsKey   - Key in State.settings for provider-specific params (optional)
 *   parseModels(rawModels) - Normalize /models response into unified shape
 *   transformRequest(requestBody, settings) - Modify outgoing API request
 *   transformResponse(response) - Modify parsed response (optional)
 *   getHeaders(settings) - Return additional HTTP headers (optional)
 *   settingsSchema - Drives dynamic provider settings UI (optional)
 */

// ============================================
// DEFAULT CAPABILITIES SHAPE
// ============================================

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

// ============================================
// BASE PROVIDER (OpenAI-compatible)
// ============================================

const BASE_PROVIDER = {
    id: 'openai',
    name: 'OpenAI / Generic',
    description: 'Standard OpenAI-compatible API. No extended capability metadata.',
    defaultEndpoint: '',
    settingsKey: null,

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
    },

    transformRequest(requestBody, _settings) {
        return requestBody;
    },

    transformResponse(response) {
        return response;
    },

    getHeaders(_settings) {
        return {};
    },

    /**
     * Fetch account balance / remaining credits from the provider.
     * Returns null if the provider doesn't support balance queries.
     * @param {Object} settings - { llmEndpoint, llmApiKey, ... }
     * @returns {Promise<{provider: string, usd: number, label: string, raw: Object}|null>}
     */
    async fetchBalance(_settings) {
        return null; // Not supported by base provider
    },

    settingsSchema: {}
};

// ============================================
// REGISTRY
// ============================================

const _providers = new Map();

// Register base provider
_providers.set(BASE_PROVIDER.id, BASE_PROVIDER);

const ProviderRegistry = {
    /**
     * Register a provider plugin. Merges with BASE_PROVIDER defaults
     * so providers only need to implement what they override.
     */
    register(provider) {
        if (!provider.id || !provider.name) {
            console.error('[Providers] Provider missing id or name:', provider);
            return false;
        }
        // Merge with base defaults — provider only needs to supply overrides
        const merged = { ...BASE_PROVIDER, ...provider };
        // Ensure parseModels exists (backward compat for providers that only had parseModels)
        if (!merged.parseModels && provider.parseModels) {
            merged.parseModels = provider.parseModels;
        }
        _providers.set(merged.id, merged);
        console.log(`[Providers] Registered: ${merged.name} (${merged.id})`);
        return true;
    },

    /**
     * Get a provider by ID. Falls back to base OpenAI.
     */
    get(id) {
        return _providers.get(id) || BASE_PROVIDER;
    },

    /**
     * List all registered providers.
     */
    list() {
        return Array.from(_providers.values());
    },

    /**
     * Parse models through the specified provider (or the active one).
     * @param {Array} rawModels - Raw model array from API
     * @param {string} [providerId] - Provider ID (uses State.settings.apiProvider if omitted)
     */
    parseModels(rawModels, providerId) {
        // Import State lazily to avoid circular dependency
        const provider = providerId 
            ? this.get(providerId) 
            : this.get(_activeProviderId);
        return provider.parseModels(rawModels);
    },

    /**
     * Transform an outgoing request body through the active provider.
     * @param {Object} requestBody - Base OpenAI-compatible request
     * @param {Object} settings - Full State.settings object
     * @returns {Object} Transformed request body
     */
    transformRequest(requestBody, settings) {
        const provider = this.get(settings.apiProvider);
        return provider.transformRequest(requestBody, settings);
    },

    /**
     * Get additional HTTP headers from the active provider.
     * @param {Object} settings - Full State.settings object
     * @returns {Object} Header key-value pairs to merge
     */
    getHeaders(settings) {
        const provider = this.get(settings.apiProvider);
        return provider.getHeaders(settings);
    },

    /**
     * Transform a parsed response through the active provider.
     * @param {Object} response - Parsed response object
     * @param {Object} settings - Full State.settings object
     * @returns {Object} Transformed response
     */
    transformResponse(response, settings) {
        const provider = this.get(settings.apiProvider);
        return provider.transformResponse(response);
    },

    /**
     * Get the settings schema for a provider (for dynamic UI generation).
     * @param {string} providerId
     * @returns {Object} Settings schema
     */
    getSettingsSchema(providerId) {
        const provider = this.get(providerId);
        return provider.settingsSchema || {};
    },

    /**
     * Get the settings key where a provider stores its params in State.settings.
     * @param {string} providerId
     * @returns {string|null}
     */
    getSettingsKey(providerId) {
        const provider = this.get(providerId);
        return provider.settingsKey || null;
    },

    /**
     * Get the default endpoint for a provider.
     * @param {string} providerId
     * @returns {string}
     */
    getDefaultEndpoint(providerId) {
        const provider = this.get(providerId);
        return provider.defaultEndpoint || '';
    },

    /**
     * Fetch account balance from the active provider.
     * @param {Object} settings - Full State.settings object
     * @returns {Promise<Object|null>} Balance info or null
     */
    async fetchBalance(settings) {
        const provider = this.get(settings.apiProvider);
        return provider.fetchBalance(settings);
    }
};

// Track active provider ID (set by core.js after settings load)
let _activeProviderId = 'openai';
ProviderRegistry.setActiveProvider = (id) => { _activeProviderId = id; };

export { ProviderRegistry, DEFAULT_CAPABILITIES };
