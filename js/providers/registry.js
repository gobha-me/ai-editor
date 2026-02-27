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
// HEURISTIC CAPABILITY DETECTION
// ============================================

/**
 * Infer model capabilities from the model ID/name string.
 * Covers Ollama, LM Studio, and other OpenAI-compatible endpoints
 * that don't provide capability metadata in their /models response.
 * 
 * This is a best-effort heuristic — not authoritative. Providers with
 * real metadata (Venice, OpenRouter) bypass this entirely.
 */

// Models/families known to support function calling / tool use
const TOOL_PATTERNS = [
    // Meta Llama 3+
    /llama[_-]?3/,
    // IBM Granite 3+
    /granite[_-]?[34]/,
    // Nous Hermes (tool-tuned)
    /hermes[_-]?[23]?/,
    // Alibaba Qwen 2+
    /qwen[_-]?2/,
    // Mistral / Mixtral
    /mistral|mixtral/,
    // Cohere Command-R
    /command[_-]?r/,
    // Microsoft Phi-3+
    /phi[_-]?[34]/,
    // DeepSeek v2+
    /deepseek[_-]?v[23]|deepseek[_-]?coder[_-]?v2/,
    // Functionary (purpose-built for tools)
    /functionary/,
    // FireFunction
    /firefunction/,
    // NexusRaven
    /nexusraven/,
    // OpenAI models
    /^gpt[_-]?[34]/,
    // Claude models (if proxied)
    /^claude/,
    // Gemma 2
    /gemma[_-]?2/,
    // GLM / ChatGLM 4+
    /glm[_-]?4|chatglm[_-]?4/
];

// Models/families known to support vision
const VISION_PATTERNS = [
    /llava|bakllava/,
    /moondream/,
    /llama.*vision|vision.*llama/,
    /minicpm[_-]?v/,
    /^gpt[_-]?4[_-]?o|^gpt[_-]?4[_-]?turbo/,
    /^claude[_-]?3/,
    /gemini/,
    /qwen.*vl|vl.*qwen/,
    /phi[_-]?3.*vision|phi[_-]?4.*vision/,
    /internvl/,
    /glm[_-]?4v/
];

// Models/families known to support extended reasoning
const REASONING_PATTERNS = [
    /deepseek[_-]?r1/,
    /qwq/,
    /^o[1234][_-]|^o[1234]$/
];

// Models optimized for code generation
const CODE_PATTERNS = [
    /codellama|codegemma|code[_-]?llama/,
    /deepseek[_-]?coder/,
    /starcoder|star[_-]?coder/,
    /coder|codestral/,
    /wizardcoder/,
    /phind[_-]?codellama/
];

function _inferCapabilities(modelId) {
    const id = modelId.toLowerCase();
    return {
        supportsFunctionCalling: TOOL_PATTERNS.some(p => p.test(id)),
        supportsVision: VISION_PATTERNS.some(p => p.test(id)),
        supportsReasoning: REASONING_PATTERNS.some(p => p.test(id)),
        supportsResponseSchema: false,
        supportsWebSearch: false,
        supportsAudioInput: false,
        supportsVideoInput: false,
        supportsLogProbs: false,
        optimizedForCode: CODE_PATTERNS.some(p => p.test(id))
    };
}

// ============================================
// BASE PROVIDER (OpenAI-compatible)
// ============================================

const BASE_PROVIDER = {
    id: 'openai',
    name: 'OpenAI / Generic',
    description: 'Standard OpenAI-compatible API. Infers model capabilities from names.',
    defaultEndpoint: '',
    settingsKey: null,

    parseModels(raw) {
        return raw.map(m => {
            const id = (m.id || m.name || String(m)).toLowerCase();

            return {
                id: m.id || m.name || String(m),
                name: m.id || m.name || String(m),
                type: m.type || 'text',
                owned_by: m.owned_by || null,
                capabilities: _inferCapabilities(id),
                pricing: null,
                meta: {
                    contextTokens: m.context_length || m.context_window || null
                }
            };
        });
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
    },

    /**
     * Run async enrichment on parsed models (e.g. Ollama /api/show).
     * No-op if the active provider doesn't implement enrichModels().
     * @param {Array} models - Parsed model array
     * @param {Object} settings - Full State.settings object
     * @returns {Promise<Array>} Enriched models
     */
    async enrichModels(models, settings) {
        const provider = this.get(settings.apiProvider);
        if (typeof provider.enrichModels === 'function') {
            return provider.enrichModels(models, settings);
        }
        return models;
    }
};

// Track active provider ID (set by core.js after settings load)
let _activeProviderId = 'openai';
ProviderRegistry.setActiveProvider = (id) => { _activeProviderId = id; };

/**
 * Apply per-model capability/context overrides stored in State.settings.modelOverrides
 * onto the live State.models array.  Call this after fetching models and whenever an
 * override is saved so every consumer (status bar, selects, chat) sees merged values.
 *
 * @param {Array}  models    - State.models array (mutated in-place)
 * @param {Object} overrides - State.settings.modelOverrides map
 */
function applyModelOverrides(models, overrides) {
    if (!Array.isArray(models)) return;
    const ov = (overrides && typeof overrides === 'object') ? overrides : {};

    for (const model of models) {
        // Snapshot originals on first call so reset can restore without a full refetch
        if (!model._baseCapabilities) {
            model._baseCapabilities = { ...(model.capabilities || {}) };
        }
        if (model._baseContextTokens === undefined) {
            model._baseContextTokens = model.meta?.contextTokens ?? null;
        }
        if (model._baseOutputTokens === undefined) {
            model._baseOutputTokens = model.meta?.outputTokens ?? null;
        }

        const entry = ov[model.id];
        if (entry) {
            // Merge capability overrides on top of base
            model.capabilities = entry.capabilities && typeof entry.capabilities === 'object'
                ? { ...model._baseCapabilities, ...entry.capabilities }
                : { ...model._baseCapabilities };
            // Override context window and max output tokens
            model.meta = {
                ...(model.meta || {}),
                contextTokens: typeof entry.contextTokens === 'number'
                    ? entry.contextTokens
                    : model._baseContextTokens,
                outputTokens: typeof entry.outputTokens === 'number'
                    ? entry.outputTokens
                    : model._baseOutputTokens,
            };
        } else {
            // No override — restore to base values
            model.capabilities = { ...model._baseCapabilities };
            model.meta = {
                ...(model.meta || {}),
                contextTokens: model._baseContextTokens,
                outputTokens: model._baseOutputTokens,
            };
        }
    }
}

export { ProviderRegistry, DEFAULT_CAPABILITIES, applyModelOverrides };
