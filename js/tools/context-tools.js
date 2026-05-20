/**
 * Context Tools - Embeddings-based intelligent file selection
 */

import { ToolRegistry } from './registry.js';
import { RetrievalManager } from '../intelligence/retrieval/manager.js';
import { State } from '../core.js';

/**
 * Below this fraction of (indexed / eligible) files, find_relevant_files
 * refuses to run the pipeline and returns a recoverable `indexer_not_ready`
 * envelope instead. Threshold is approximate — the goal is to reject "6/505"
 * style cold runs (github#29) while letting partially-indexed projects past.
 */
const READINESS_THRESHOLD = 0.30;

/**
 * Find semantically relevant files for a given query.
 *
 * Failure modes covered (github#29 + github#35):
 *  - indexer_not_ready  — coverage below READINESS_THRESHOLD, recovers via index_project
 *  - retrieval_partial  — cold pipeline exceeded soft budget under the hard tool wall
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

    // Readiness gate (github#29). Cold projects with thin coverage produce
    // misleading "thin results" rather than an explicit "not ready" signal,
    // and the model can't tell the difference. Fail fast with a recoverable
    // envelope instead.
    const indexed = RetrievalManager.getFilesIndexed();
    const eligible = RetrievalManager.getEligibleFileCount();
    if (eligible > 0 && indexed / eligible < READINESS_THRESHOLD) {
        const coverage = indexed / eligible;
        return {
            success: false,
            error: 'indexer_not_ready',
            indexed,
            estimated_total: eligible,
            coverage,
            message: `Index not ready: ${indexed} of ${eligible} eligible files indexed (${(coverage * 100).toFixed(1)}% < ${(READINESS_THRESHOLD * 100).toFixed(0)}% threshold).`,
            hint: 'Run index_project, then retry. For navigation in the meantime, use get_project_tree + read_file.',
            files: []
        };
    }

    // Soft budget (github#35). The hard tool wall (default 30s) returns a
    // silent timeout with no result. Race the manager against an internal
    // budget 5s under the wall (floor 15s) so an over-budget pipeline
    // produces a structured `retrieval_partial` envelope the model can act
    // on. The in-flight pipeline keeps running in the background and tends
    // to populate the manager's LRU by the time the model retries.
    const hardWallMs = State.settings.toolTimeout || 30000;
    const softBudgetMs = Math.max(15000, hardWallMs - 5000);
    const startMs = Date.now();

    let budgetTimer;
    try {
        const results = await Promise.race([
            RetrievalManager.findRelevantFiles(query, maxFiles),
            new Promise((_, reject) => {
                budgetTimer = setTimeout(
                    () => reject(new Error('SOFT_BUDGET_EXCEEDED')),
                    softBudgetMs
                );
            })
        ]);
        if (budgetTimer) clearTimeout(budgetTimer);

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
        if (budgetTimer) clearTimeout(budgetTimer);
        if (error?.message === 'SOFT_BUDGET_EXCEEDED') {
            return {
                success: false,
                error: 'retrieval_partial',
                elapsed_ms: Date.now() - startMs,
                soft_budget_ms: softBudgetMs,
                hard_wall_ms: hardWallMs,
                message: `Retrieval pipeline exceeded the soft budget (${softBudgetMs}ms, under the ${hardWallMs}ms hard tool wall). The pipeline is still running in the background.`,
                hint: 'Retry the same query — cold pipelines typically warm on the second attempt as the in-flight run completes and populates the LRU. Or fall back to get_project_tree + read_file.',
                files: []
            };
        }
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
    readOnly: true,
    // Args-keyed in shape, but the underlying retrieval index mutates as
    // files are edited / added / removed within the session. An args-keyed
    // cache hit would return pre-edit relevance against post-edit truth.
    cache: 'never',
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
    readOnly: true,
    // No args; depends on indexer progress / configured embedder state.
    // Same shape as gitea#472.
    cache: 'never',
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
