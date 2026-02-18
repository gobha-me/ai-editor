/**
 * Embeddings Client - Dual-mode embeddings support
 * 
 * Local Mode: Transformers.js (client-side, browser-based)
 *   - Models: Xenova/all-MiniLM-L6-v2, Xenova/bge-small-en-v1.5, etc.
 *   - Privacy: Files never leave browser
 *   - Cost: Free (one-time model download)
 * 
 * Remote Mode: Venice.ai API (server-side)
 *   - Models: text-embedding-bge-m3, etc.
 *   - Privacy: Files sent to API
 *   - Cost: Per-token API pricing
 */

import { State, EventBus, Storage } from './core.js';

// Lazy-loaded Transformers.js modules (for local mode)
let transformers = null;
let pipeline = null;
let embeddingModel = null;

const EmbeddingsClient = {
    _initialized: false,
    _loading: false,
    _cache: new Map(), // In-memory cache for this session
    _mode: null, // 'local' or 'remote'

    /**
     * Check if embeddings are enabled in settings
     */
    isEnabled() {
        return State.settings.useEmbeddings === true;
    },

    /**
     * Detect if model is local (Transformers.js) or remote (API)
     */
    _detectMode(modelName) {
        return modelName.startsWith('Xenova/') ? 'local' : 'remote';
    },

    /**
     * Initialize the embeddings system
     * Routes to local (Transformers.js) or remote (API) based on model
     */
    async init() {
        if (this._initialized) return true;
        if (this._loading) {
            // Wait for ongoing initialization
            return new Promise(resolve => {
                const check = setInterval(() => {
                    if (this._initialized || !this._loading) {
                        clearInterval(check);
                        resolve(this._initialized);
                    }
                }, 100);
            });
        }

        if (!this.isEnabled()) {
            console.log('[Embeddings] Not enabled, skipping initialization');
            return false;
        }

        this._loading = true;
        const modelName = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
        this._mode = this._detectMode(modelName);

        console.log(`[Embeddings] Initializing in ${this._mode} mode with model: ${modelName}`);

        try {
            if (this._mode === 'local') {
                await this._initLocal(modelName);
            } else {
                await this._initRemote(modelName);
            }

            this._initialized = true;
            this._loading = false;
            console.log(`[Embeddings] Initialized successfully (${this._mode} mode)`);
            EventBus.emit('embeddings:ready');
            return true;

        } catch (error) {
            console.error('[Embeddings] Failed to initialize:', error);
            this._loading = false;
            this._initialized = false;
            return false;
        }
    },

    /**
     * Initialize local mode (Transformers.js)
     */
    async _initLocal(modelName) {
        console.log('[Embeddings] Loading Transformers.js...');
        
        // Dynamically import Transformers.js — try local vendor first, then CDN
        try {
            const vendorUrl = new URL('vendor/transformers.min.js', document.baseURI).href;
            transformers = await import(vendorUrl);
        } catch (_) {
            transformers = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
        }
        
        // Configure to use local models when possible
        transformers.env.allowLocalModels = true;
        transformers.env.useBrowserCache = true;

        console.log(`[Embeddings] Loading local model: ${modelName}`);

        // Create embedding pipeline
        pipeline = await transformers.pipeline('feature-extraction', modelName, {
            quantized: true, // Use quantized model for smaller size
        });

        embeddingModel = pipeline;
    },

    /**
     * Initialize remote mode (API-based)
     * Just validates that API credentials are configured
     */
    async _initRemote(modelName) {
        if (!State.settings.llmEndpoint || !State.settings.llmApiKey) {
            throw new Error('API endpoint and key required for remote embeddings');
        }
        console.log(`[Embeddings] Remote mode ready with model: ${modelName}`);
    },

    /**
     * Discovered max input size (chars) for the current model.
     * Starts at null (unknown), learned from errors, persists for session.
     * Prevents repeated oversized requests after first failure.
     */
    _maxInputChars: null,

    /**
     * Generate embedding for a text string.
     * Auto-trims on token limit errors and learns the model's limit.
     * 
     * @param {string} text - Text to embed
     * @returns {Promise<Array|null>} Embedding vector
     */
    async embed(text) {
        if (!this.isEnabled()) return null;
        
        if (!this._initialized) {
            const success = await this.init();
            if (!success) return null;
        }

        // Pre-trim if we've already discovered this model's limit
        let input = text;
        if (this._maxInputChars && input.length > this._maxInputChars) {
            input = this._trimToLimit(input, this._maxInputChars);
        }

        // Try embed, with up to 3 retries at progressively smaller sizes
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (this._mode === 'local') {
                    return await this._embedLocal(input);
                } else {
                    return await this._embedRemote(input);
                }
            } catch (error) {
                if (attempt >= MAX_RETRIES) {
                    console.error(`[Embeddings] Failed after ${MAX_RETRIES} retries (${this._mode} mode):`, error);
                    return null;
                }

                const limit = this._parseTokenLimitError(error);
                if (limit) {
                    // Discovered exact token limit — convert to chars
                    // ~4 chars/token for code, use 3.5 to be conservative
                    const charLimit = Math.floor(limit * 3.5);
                    this._maxInputChars = charLimit;
                    input = this._trimToLimit(input, charLimit);
                    console.log(`[Embeddings] Token limit hit (${limit} tokens) — trimming to ~${charLimit} chars, retry ${attempt + 1}/${MAX_RETRIES}`);
                } else if (this._isOverSizeError(error)) {
                    // Size error but can't parse limit — halve and retry
                    const halved = Math.floor(input.length / 2);
                    this._maxInputChars = halved;
                    input = this._trimToLimit(input, halved);
                    console.log(`[Embeddings] Size error (unparseable) — halving to ${halved} chars, retry ${attempt + 1}/${MAX_RETRIES}`);
                } else {
                    // Not a size error — don't retry
                    console.error(`[Embeddings] Failed to generate embedding (${this._mode} mode):`, error);
                    return null;
                }
            }
        }
        return null;
    },

    /**
     * Trim text to a char limit, preserving structure.
     * Keeps the structural header (before ---) intact, trims raw content.
     */
    _trimToLimit(text, charLimit) {
        if (text.length <= charLimit) return text;

        const divider = text.indexOf('\n---\n');
        if (divider === -1) {
            // No structure/content split — just truncate
            return text.slice(0, charLimit);
        }

        const structure = text.slice(0, divider);
        const content = text.slice(divider + 5); // skip \n---\n

        if (structure.length >= charLimit) {
            // Structure alone exceeds limit — truncate it
            return structure.slice(0, charLimit);
        }

        // Fit content into remaining budget, head-biased
        const contentBudget = charLimit - structure.length - 5; // 5 for \n---\n
        if (contentBudget < 100) return structure;

        const headBudget = Math.floor(contentBudget * 0.7);
        const tailBudget = contentBudget - headBudget;

        const head = content.slice(0, headBudget);
        const tail = content.slice(-tailBudget);
        return structure + '\n---\n' + head + '\n…\n' + tail;
    },

    /**
     * Parse a token limit error from various API formats.
     * Returns the max token count if this is a limit error, null otherwise.
     */
    _parseTokenLimitError(error) {
        const msg = error?.message || '';

        // Common patterns across providers:
        // "This model's maximum context length is 8192 tokens"
        // "input must have fewer than 8192 tokens"
        // "maximum token length exceeded (8192)"
        // "token limit: 512"
        // Ollama: "too many tokens: 9500 > 8192"
        const patterns = [
            /maximum\s+(?:context\s+)?(?:length|tokens?)\s+(?:is|of)\s+(\d+)/i,
            /fewer\s+than\s+(\d+)\s+tokens/i,
            /token\s+limit[:\s]+(\d+)/i,
            /(?:exceeded|too many tokens).*?>\s*(\d+)/i,
            /max[_\s]tokens?\s*[:=]\s*(\d+)/i,
        ];

        for (const pattern of patterns) {
            const match = msg.match(pattern);
            if (match) return parseInt(match[1], 10);
        }

        // Also check for HTTP 413/400 with "too large" style messages
        if ((error?.status === 413 || error?.status === 400) && /too (large|long|many)/i.test(msg)) {
            // Can't determine exact limit — caller should use halving fallback
            return null;
        }

        return null;
    },

    /**
     * Check if an error is size-related (but we can't parse the exact limit).
     */
    _isOverSizeError(error) {
        const msg = error?.message || '';
        const status = error?.status;

        // HTTP 413 Payload Too Large
        if (status === 413) return true;

        // 400 with size-related keywords
        if (status === 400 && /too (large|long|many)|exceeds?|overflow|token|length|limit/i.test(msg)) return true;

        // Ollama-style: "too many tokens"
        if (/too many tokens/i.test(msg)) return true;

        return false;
    },

    /**
     * Generate embedding using Transformers.js (local)
     */
    async _embedLocal(text) {
        const output = await embeddingModel(text, {
            pooling: 'mean',
            normalize: true
        });

        // Extract the embedding array
        const embedding = Array.from(output.data);
        return embedding;
    },

    /**
     * Generate embedding using remote API (Venice.ai, Ollama, OpenAI-compatible)
     */
    async _embedRemote(text) {
        const url = `${State.settings.llmEndpoint.replace(/\/$/, '')}/embeddings`;
        const modelName = State.settings.embeddingModel;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${State.settings.llmApiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                input: text,
                encoding_format: 'float'
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            const err = new Error(`Embeddings API error: ${response.status} - ${errorText}`);
            err.status = response.status;
            throw err;
        }

        const data = await response.json();
        
        // Venice.ai returns: { data: [{ embedding: [0.123, ...], index: 0, object: "embedding" }], ... }
        if (!data.data || !data.data[0] || !data.data[0].embedding) {
            throw new Error('Invalid embeddings API response format');
        }

        return data.data[0].embedding;
    },

    /**
     * Calculate cosine similarity between two embedding vectors
     * @param {Array} vecA - First embedding vector
     * @param {Array} vecB - Second embedding vector
     * @returns {number} Similarity score (0-1)
     */
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }

        normA = Math.sqrt(normA);
        normB = Math.sqrt(normB);

        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (normA * normB);
    },

    /**
     * Find most similar items from a collection
     * @param {Array} queryEmbedding - Query embedding vector
     * @param {Array} items - Array of {id, embedding, ...} objects
     * @param {number} topK - Number of results to return
     * @returns {Array} Top K items sorted by similarity
     */
    findSimilar(queryEmbedding, items, topK = 5) {
        if (!queryEmbedding || !items || items.length === 0) return [];

        const results = items
            .map(item => ({
                ...item,
                similarity: this.cosineSimilarity(queryEmbedding, item.embedding)
            }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, topK);

        return results;
    },

    /**
     * Clear all cached embeddings
     */
    clearCache() {
        this._cache.clear();
        console.log('[Embeddings] Cache cleared');
        EventBus.emit('embeddings:cacheCleared');
    },

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            size: this._cache.size,
            initialized: this._initialized,
            enabled: this.isEnabled(),
            mode: this._mode
        };
    }
};

// Auto-initialize when settings change
EventBus.on('settings:saved', async () => {
    if (State.settings.useEmbeddings && !EmbeddingsClient._initialized) {
        console.log('[Embeddings] Enabled in settings, initializing...');
        await EmbeddingsClient.init();
    } else if (State.settings.useEmbeddings && EmbeddingsClient._initialized) {
        // Model changed - reinitialize
        const newMode = EmbeddingsClient._detectMode(State.settings.embeddingModel);
        if (newMode !== EmbeddingsClient._mode) {
            console.log(`[Embeddings] Mode changed from ${EmbeddingsClient._mode} to ${newMode}, reinitializing...`);
            EmbeddingsClient._initialized = false;
            EmbeddingsClient._maxInputChars = null; // Reset discovered limit for new model
            embeddingModel = null;
            pipeline = null;
            await EmbeddingsClient.init();
        }
    }
});

export { EmbeddingsClient };
