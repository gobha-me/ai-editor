/**
 * OpenRouter Provider
 * 
 * Unified gateway to 200+ models with automatic fallback,
 * per-model pricing, and usage tracking via HTTP headers.
 * 
 * API docs: https://openrouter.ai/docs
 */

import { DEFAULT_CAPABILITIES } from './registry.js';

export default {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter API with 200+ models, automatic fallback, and usage tracking.',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    settingsKey: 'openRouterParameters',

    // ========================================
    // MODEL PARSING
    // ========================================

    parseModels(raw) {
        return raw.map(m => {
            // OpenRouter uses: id, name, pricing.prompt, pricing.completion,
            // context_length, architecture.modality, top_provider, per_request_limits
            const pricing = m.pricing || {};
            // OpenRouter pricing is per-token, convert to per-1M-token
            const inputPrice = pricing.prompt ? parseFloat(pricing.prompt) * 1_000_000 : null;
            const outputPrice = pricing.completion ? parseFloat(pricing.completion) * 1_000_000 : null;

            const arch = m.architecture || {};

            return {
                id: m.id || String(m),
                name: m.name || m.id || String(m),
                type: 'text',
                owned_by: m.id ? m.id.split('/')[0] : null,
                capabilities: {
                    ...DEFAULT_CAPABILITIES,
                    supportsVision: arch.modality === 'multimodal' || 
                        (m.description || '').toLowerCase().includes('vision'),
                    supportsFunctionCalling: (m.description || '').toLowerCase().includes('function') || 
                        (m.description || '').toLowerCase().includes('tool')
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
    },

    // ========================================
    // REQUEST TRANSFORM
    // ========================================

    transformRequest(requestBody, settings) {
        const orp = settings.openRouterParameters || {};

        // Provider routing preferences
        if (orp.route) {
            requestBody.route = orp.route;
        }

        // Model fallback list
        if (orp.models && Array.isArray(orp.models) && orp.models.length > 0) {
            requestBody.models = orp.models;
        }

        // Transforms (e.g. prompt optimization)
        if (orp.transforms && Array.isArray(orp.transforms)) {
            requestBody.transforms = orp.transforms;
        }

        return requestBody;
    },

    // ========================================
    // RESPONSE TRANSFORM
    // ========================================

    transformResponse(response) {
        return response;
    },

    // ========================================
    // HEADERS
    // ========================================

    getHeaders(settings) {
        const orp = settings.openRouterParameters || {};
        const headers = {};

        // Required by OpenRouter for usage ranking
        headers['HTTP-Referer'] = orp.siteUrl || window.location.origin;
        headers['X-Title'] = orp.appName || 'AI Editor';

        return headers;
    },

    // ========================================
    // SETTINGS SCHEMA (drives dynamic UI)
    // ========================================

    settingsSchema: {
        siteUrl: {
            type: 'text',
            label: 'Site URL',
            default: '',
            placeholder: 'https://your-site.com',
            description: 'Your site URL for OpenRouter usage rankings'
        },
        appName: {
            type: 'text',
            label: 'App Name',
            default: 'AI Editor',
            placeholder: 'AI Editor',
            description: 'Your app name shown in OpenRouter dashboard'
        },
        route: {
            type: 'select',
            label: 'Routing Strategy',
            options: [
                { value: '', label: 'Default' },
                { value: 'fallback', label: 'Fallback (try alternatives on failure)' }
            ],
            default: '',
            description: 'How OpenRouter routes requests to providers'
        }
    }
};
