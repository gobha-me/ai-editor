/**
 * Venice.ai Provider
 * 
 * Privacy-focused inference with web search, thinking controls,
 * and 26+ models. Extends OpenAI-compatible API with venice_parameters.
 * 
 * API docs: https://docs.venice.ai/api
 */

import { DEFAULT_CAPABILITIES } from './registry.js';

export default {
    id: 'venice',
    name: 'Venice.ai',
    description: 'Venice.ai API with model capabilities, pricing, web search, and thinking controls.',
    defaultEndpoint: 'https://api.venice.ai/api/v1',
    settingsKey: 'veniceParameters',

    // ========================================
    // MODEL PARSING
    // ========================================

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
    },

    // ========================================
    // REQUEST TRANSFORM
    // ========================================

    transformRequest(requestBody, settings) {
        const vp = settings.veniceParameters || {};
        const adv = settings.advancedParams || {};
        const veniceParams = {};

        // Web search
        if (vp.enableWebSearch && vp.enableWebSearch !== 'off') {
            veniceParams.enable_web_search = vp.enableWebSearch;
        }

        // Web scraping
        if (vp.enableWebScraping) {
            veniceParams.enable_web_scraping = true;
        }

        // Web citations
        if (vp.enableWebCitations) {
            veniceParams.enable_web_citations = true;
        }

        // Search results streaming
        if (vp.includeSearchResultsInStream) {
            veniceParams.include_search_results_in_stream = true;
        }

        // Search results as documents
        if (vp.returnSearchResultsAsDocuments !== undefined) {
            veniceParams.return_search_results_as_documents = vp.returnSearchResultsAsDocuments;
        }

        // Venice system prompt
        if (vp.includeSystemPrompt !== undefined) {
            veniceParams.include_venice_system_prompt = vp.includeSystemPrompt;
        }

        // Thinking controls — bridge from advancedParams OR veniceParameters
        const stripThinking = adv.strip_thinking_response || vp.stripThinking;
        const disableThinking = adv.disable_thinking || vp.disableThinking;
        if (stripThinking) veniceParams.strip_thinking_response = true;
        if (disableThinking) veniceParams.disable_thinking = true;

        // Only add venice_parameters if we have any
        if (Object.keys(veniceParams).length > 0) {
            requestBody.venice_parameters = veniceParams;
        }

        // Reasoning effort (top-level param for Venice reasoning models)
        if (vp.reasoningEffort && !adv.reasoning_effort) {
            requestBody.reasoning_effort = vp.reasoningEffort;
        }

        return requestBody;
    },

    // ========================================
    // RESPONSE TRANSFORM
    // ========================================

    transformResponse(response) {
        // Venice responses are clean OpenAI-compatible — no transform needed
        return response;
    },

    // ========================================
    // HEADERS
    // ========================================

    getHeaders(_settings) {
        // Venice uses standard Bearer auth — no extra headers
        return {};
    },

    // ========================================
    // ACCOUNT BALANCE
    // ========================================

    async fetchBalance(settings) {
        const endpoint = (settings.llmEndpoint || 'https://api.venice.ai/api/v1').replace(/\/+$/, '');
        const apiKey = settings.llmApiKey;
        if (!endpoint || !apiKey) return null;

        try {
            const resp = await fetch(`${endpoint}/api_keys/rate_limits`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!resp.ok) return null;

            const json = await resp.json();
            const data = json.data || {};
            const balances = data.balances || {};
            const usd = balances.USD ?? null;
            const diemBalance = balances.DIEM ?? null;
            const nextEpoch = data.nextEpochBegins || null;

            // Track DIEM max: the highest value we see for this epoch is the daily max.
            // When epoch rolls over (nextEpochBegins changes), reset.
            if (diemBalance !== null) {
                const storedEpoch = this._diemEpoch || null;
                if (!storedEpoch || storedEpoch !== nextEpoch) {
                    // New epoch or first fetch — current balance IS the max
                    this._diemMax = diemBalance;
                    this._diemEpoch = nextEpoch;
                } else if (diemBalance > (this._diemMax || 0)) {
                    // Balance went up (shouldn't happen mid-epoch, but be safe)
                    this._diemMax = diemBalance;
                }
            }

            return {
                provider: 'venice',
                usd: usd,
                diem: {
                    balance: diemBalance,
                    max: this._diemMax || diemBalance,
                    nextEpoch: nextEpoch    // ISO timestamp
                },
                label: usd !== null ? `$${usd.toFixed(2)}` : 'N/A',
                raw: {
                    usd, diemBalance,
                    diemMax: this._diemMax,
                    nextEpoch,
                    tier: data.apiTier?.id || null
                }
            };
        } catch (err) {
            console.warn('[Venice] Failed to fetch balance:', err.message);
            return null;
        }
    },

    // Internal DIEM tracking (persists across polls within same provider instance)
    _diemMax: null,
    _diemEpoch: null,

    // ========================================
    // SETTINGS SCHEMA (drives dynamic UI)
    // ========================================

    settingsSchema: {
        enableWebSearch: {
            type: 'select',
            label: 'Web Search',
            options: [
                { value: 'off', label: 'Off' },
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' }
            ],
            default: 'off',
            description: 'Enable web search for grounded responses'
        },
        enableWebScraping: {
            type: 'boolean',
            label: 'Web Scraping',
            default: false,
            description: 'Enable web page scraping for search results'
        },
        enableWebCitations: {
            type: 'boolean',
            label: 'Web Citations',
            default: false,
            description: 'Include source citations in web search results'
        },
        includeSearchResultsInStream: {
            type: 'boolean',
            label: 'Stream Search Results',
            default: false,
            description: 'Include search results in the streaming response'
        },
        returnSearchResultsAsDocuments: {
            type: 'boolean',
            label: 'Search as Documents',
            default: true,
            description: 'Format search results as structured documents'
        },
        includeSystemPrompt: {
            type: 'boolean',
            label: 'Venice System Prompt',
            default: true,
            description: 'Include Venice default system prompt'
        },
        stripThinking: {
            type: 'boolean',
            label: 'Strip Thinking',
            default: false,
            description: 'Remove <thinking> blocks from response'
        },
        disableThinking: {
            type: 'boolean',
            label: 'Disable Thinking',
            default: false,
            description: 'Prevent model from using thinking tokens'
        },
        reasoningEffort: {
            type: 'select',
            label: 'Reasoning Effort',
            options: [
                { value: '', label: 'Default' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' }
            ],
            default: '',
            description: 'Extended thinking effort for reasoning models'
        }
    }
};
