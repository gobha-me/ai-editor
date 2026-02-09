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

        // Thinking controls — from generic advancedParams
        if (adv.strip_thinking_response) veniceParams.strip_thinking_response = true;
        if (adv.disable_thinking) veniceParams.disable_thinking = true;

        // Only add venice_parameters if we have any
        if (Object.keys(veniceParams).length > 0) {
            requestBody.venice_parameters = veniceParams;
        }

        // Reasoning effort (top-level param for Venice reasoning models)
        if (adv.reasoning_effort) {
            requestBody.reasoning_effort = adv.reasoning_effort;
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
            // Fetch both endpoints in parallel:
            //   /api_keys/rate_limits → balances (remaining DIEM/USD) + nextEpochBegins
            //   /api_keys             → consumptionLimits (max DIEM/USD per epoch)
            const [rateLimitsResp, keysResp] = await Promise.all([
                fetch(`${endpoint}/api_keys/rate_limits`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                }),
                fetch(`${endpoint}/api_keys`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                })
            ]);

            if (!rateLimitsResp.ok) return null;

            const rateLimitsJson = await rateLimitsResp.json();
            const rlData = rateLimitsJson.data || {};
            const balances = rlData.balances || {};
            const usd = balances.USD ?? null;
            const diemBalance = balances.DIEM ?? null;
            const nextEpoch = rlData.nextEpochBegins || null;

            // Extract per-epoch DIEM limit from the api_keys response
            let diemMax = null;
            if (keysResp.ok) {
                const keysJson = await keysResp.json();
                const keys = keysJson.data || [];
                // Find first INFERENCE key with a diem consumption limit
                for (const k of keys) {
                    const limit = k.consumptionLimits?.diem;
                    if (limit !== null && limit !== undefined) {
                        diemMax = limit;
                        break;
                    }
                }
            }

            return {
                provider: 'venice',
                usd: usd,
                diem: diemBalance !== null ? {
                    balance: diemBalance,
                    max: diemMax,           // Per-epoch limit from consumptionLimits
                    nextEpoch: nextEpoch    // ISO timestamp for epoch reset
                } : null,
                label: usd !== null ? `$${usd.toFixed(2)}` : 'N/A',
                raw: {
                    usd, diemBalance, diemMax, nextEpoch,
                    tier: rlData.apiTier?.id || null
                }
            };
        } catch (err) {
            console.warn('[Venice] Failed to fetch balance:', err.message);
            return null;
        }
    },

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
        }
    }
};
