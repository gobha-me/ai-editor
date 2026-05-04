/**
 * Context Tools - Embeddings-based intelligent file selection
 */

import { ToolRegistry } from './registry.js';
import { RetrievalManager } from '../intelligence/retrieval/manager.js';
import { State } from '../core.js';

/**
 * Find semantically relevant files for a given query
 */
async function findRelevantFiles({ query, max_files }) {
    if (!State.settings.useEmbeddings) {
        return {
            success: false,
            message: 'Embeddings not enabled. Enable in Settings → Context to use semantic file search.',
            files: []
        };
    }

    const maxFiles = max_files || State.settings.maxRelevantFiles || 5;
    
    try {
        const results = await RetrievalManager.findRelevantFiles(query, maxFiles);
        
        if (results.length === 0) {
            return {
                success: false,
                message: 'No files indexed yet. The project will be indexed automatically.',
                files: []
            };
        }

        return {
            success: true,
            message: `Found ${results.length} relevant files for "${query}"`,
            files: results.map(r => ({
                path: r.path,
                similarity: r.similarity,
                summary: r.summary
            })),
            token_savings: `Instead of reading all ${State.fileTree.length} files, read only these ${results.length} files (~${Math.round((1 - results.length / State.fileTree.length) * 100)}% token reduction)`
        };

    } catch (error) {
        return {
            success: false,
            message: `Failed to find relevant files: ${error.message}`,
            files: []
        };
    }
}

/**
 * Get embeddings system status
 */
async function getEmbeddingsStatus() {
    const stats = RetrievalManager.getStats();
    
    return {
        enabled: State.settings.useEmbeddings,
        files_indexed: stats.filesIndexed,
        project: stats.project,
        is_indexing: stats.isIndexing,
        model: State.settings.embeddingModel,
        max_relevant_files: State.settings.maxRelevantFiles
    };
}

/**
 * Manually trigger project indexing
 */
async function indexProject({ force }) {
    if (!State.settings.useEmbeddings) {
        return {
            success: false,
            message: 'Embeddings not enabled'
        };
    }

    try {
        const count = await RetrievalManager.indexProject(force === true);
        return {
            success: true,
            message: `Indexed ${count} files`,
            files_indexed: count
        };
    } catch (error) {
        return {
            success: false,
            message: `Indexing failed: ${error.message}`
        };
    }
}

// Register tools
ToolRegistry.register('find_relevant_files', findRelevantFiles, {
    type: 'function',
    roles: ['full', 'coder', 'reviewer'], // All roles that read code
    function: {
        name: 'find_relevant_files',
        description: 'Find semantically relevant files for a query using embeddings. Use this BEFORE reading files to dramatically reduce token usage. Returns the top N most relevant files based on their content and purpose.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Natural language query describing what you\'re looking for (e.g., "authentication logic", "search functionality", "API routes")'
                },
                max_files: {
                    type: 'number',
                    description: 'Maximum number of relevant files to return (default: 5)',
                    default: 5
                }
            },
            required: ['query']
        }
    }
});

ToolRegistry.register('get_embeddings_status', getEmbeddingsStatus, {
    type: 'function',
    roles: 'all',
    function: {
        name: 'get_embeddings_status',
        description: 'Get the current status of the embeddings system, including number of files indexed and configuration',
        parameters: {
            type: 'object',
            properties: {}
        }
    }
});

ToolRegistry.register('index_project', indexProject, {
    type: 'function',
    roles: ['full', 'coder'],
    function: {
        name: 'index_project',
        description: 'Manually trigger indexing of all project files for embeddings. Usually done automatically, but can be forced to refresh.',
        parameters: {
            type: 'object',
            properties: {
                force: {
                    type: 'boolean',
                    description: 'Force re-index even if already indexed',
                    default: false
                }
            }
        }
    }
});

export { findRelevantFiles, getEmbeddingsStatus, indexProject };
