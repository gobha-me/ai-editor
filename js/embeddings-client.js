/**
 * Embeddings Client - Optional client-side embeddings using Transformers.js
 * Provides semantic file search for intelligent context management
 */

import { State, EventBus, Storage } from './core.js';

// Lazy-loaded Transformers.js modules
let transformers = null;
let pipeline = null;
let embeddingModel = null;

const EmbeddingsClient = {
    _initialized: false,
    _loading: false,
    _cache: new Map(), // In-memory cache for this session

    /**
     * Check if embeddings are enabled in settings
     */
    isEnabled() {
        return State.settings.useEmbeddings === true;
    },

    /**
     * Initialize the embeddings system (lazy load Transformers.js)
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
        console.log('[Embeddings] Initializing...');

        try {
            // Dynamically import Transformers.js
            transformers = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
            
            // Configure to use local models when possible
            transformers.env.allowLocalModels = true;
            transformers.env.useBrowserCache = true;

            const modelName = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
            console.log(`[Embeddings] Loading model: ${modelName}`);

            // Create embedding pipeline
            pipeline = await transformers.pipeline('feature-extraction', modelName, {
                quantized: true, // Use quantized model for smaller size
            });

            embeddingModel = pipeline;
            this._initialized = true;
            this._loading = false;

            console.log('[Embeddings] Initialized successfully');
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
     * Generate embedding for a text string
     * @param {string} text - Text to embed
     * @returns {Promise<Float32Array|null>} Embedding vector
     */
    async embed(text) {
        if (!this.isEnabled()) return null;
        
        if (!this._initialized) {
            const success = await this.init();
            if (!success) return null;
        }

        try {
            const output = await embeddingModel(text, {
                pooling: 'mean',
                normalize: true
            });

            // Extract the embedding array
            const embedding = Array.from(output.data);
            return embedding;

        } catch (error) {
            console.error('[Embeddings] Failed to generate embedding:', error);
            return null;
        }
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
            enabled: this.isEnabled()
        };
    }
};

// Auto-initialize when settings change
EventBus.on('settings:saved', async () => {
    if (State.settings.useEmbeddings && !EmbeddingsClient._initialized) {
        console.log('[Embeddings] Enabled in settings, initializing...');
        await EmbeddingsClient.init();
    }
});

export { EmbeddingsClient };
