/**
 * Ollama Provider
 * 
 * Local model inference via Ollama. Queries the native /api/show
 * endpoint to get real model capabilities (tools, vision, etc.)
 * instead of relying on regex heuristics.
 * 
 * Endpoint should be the OpenAI-compat URL (e.g. http://localhost:11434/v1).
 * The provider auto-derives the native API base by stripping /v1.
 * 
 * Ollama API docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import { DEFAULT_CAPABILITIES } from './registry.js';

/** Derive the native Ollama base from the OpenAI-compat endpoint. */
function _nativeBase(endpoint) {
    // http://host:11434/v1  →  http://host:11434
    // http://host:11434/v1/ →  http://host:11434
    // http://host:11434     →  http://host:11434
    return endpoint.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

/**
 * Query Ollama's /api/show for a single model's capabilities.
 * Returns a capabilities object, or defaults on failure.
 * @param {string} base - Native Ollama base URL
 * @param {string} modelName - Model name (e.g. "granite4:latest")
 * @returns {Promise<Object>}
 */
async function _queryCapabilities(base, modelName) {
    try {
        const resp = await fetch(`${base}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName }),
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;

        const data = await resp.json();

        // Ollama returns capabilities as an array of strings:
        //   ["completion", "tools", "vision", "embedding", ...]
        const caps = new Set(data.capabilities || []);

        // Also extract context length from model_info if available
        const info = data.model_info || {};
        // Keys vary by model family but often include a context_length field
        let contextTokens = null;
        for (const [key, val] of Object.entries(info)) {
            if (/context.length/i.test(key) && typeof val === 'number') {
                contextTokens = val;
                break;
            }
        }

        return {
            capabilities: {
                ...DEFAULT_CAPABILITIES,
                supportsFunctionCalling: caps.has('tools'),
                supportsVision: caps.has('vision'),
                // Ollama doesn't flag these explicitly — leave as false
                supportsReasoning: false,
                optimizedForCode: false,
            },
            contextTokens,
            family: data.details?.family || null,
            parameterSize: data.details?.parameter_size || null,
            quantization: data.details?.quantization_level || null,
        };
    } catch {
        // Timeout, network error, parse error — silently fall back
        return null;
    }
}

export default {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local Ollama instance. Auto-detects model capabilities via /api/show.',
    defaultEndpoint: 'http://localhost:11434/v1',
    settingsKey: null,

    // ========================================
    // MODEL PARSING (synchronous initial pass)
    // ========================================

    parseModels(raw) {
        return raw.map(m => {
            const id = m.id || m.name || String(m);
            return {
                id,
                name: id,
                type: m.type || 'text',
                owned_by: m.owned_by || 'ollama',
                // Placeholder — enrichModels() will replace with real data
                capabilities: { ...DEFAULT_CAPABILITIES },
                pricing: null,
                meta: {
                    contextTokens: m.context_length || m.context_window || null,
                }
            };
        });
    },

    // ========================================
    // ASYNC ENRICHMENT — real capability detection
    // ========================================

    /**
     * After parseModels(), query /api/show for each model to get real
     * capabilities. Runs in parallel with a concurrency cap.
     * 
     * @param {Array} models - Parsed model array from parseModels()
     * @param {Object} settings - State.settings (has llmEndpoint)
     * @returns {Promise<Array>} Enriched models
     */
    async enrichModels(models, settings) {
        const base = _nativeBase(settings.llmEndpoint || '');
        if (!base) return models;

        // Query all models in parallel (capped at 6 concurrent)
        const CONCURRENCY = 6;
        const queue = [...models];
        const results = new Map();

        async function worker() {
            while (queue.length > 0) {
                const model = queue.shift();
                if (!model) break;
                const data = await _queryCapabilities(base, model.id);
                if (data) results.set(model.id, data);
            }
        }

        const workers = Array.from(
            { length: Math.min(CONCURRENCY, models.length) },
            () => worker()
        );
        await Promise.allSettled(workers);

        // Merge enriched data back
        return models.map(m => {
            const enriched = results.get(m.id);
            if (!enriched) return m;

            return {
                ...m,
                capabilities: enriched.capabilities,
                meta: {
                    ...m.meta,
                    contextTokens: enriched.contextTokens || m.meta.contextTokens,
                    family: enriched.family,
                    parameterSize: enriched.parameterSize,
                    quantization: enriched.quantization,
                }
            };
        });
    },

    // ========================================
    // REQUEST / RESPONSE (passthrough — Ollama is OpenAI-compat)
    // ========================================

    transformRequest(requestBody, _settings) {
        return requestBody;
    },

    transformResponse(response) {
        return response;
    },

    getHeaders(_settings) {
        return {};
    },

    async fetchBalance(_settings) {
        return null; // Local — no billing
    },

    settingsSchema: {}
};
