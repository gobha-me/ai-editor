/**
 * AI Editor - Cross-Project Reference Tools
 * 
 * Read-only access to files in OTHER projects without switching
 * the active project. Resolves connections directly via the
 * GitProviderRegistry, bypassing State.currentProject entirely.
 * 
 * Workflow:
 *   1. LLM calls list_projects to discover available repos
 *   2. LLM calls peek_project_tree to browse the reference repo
 *   3. LLM calls peek_project_file to read specific files
 *   4. LLM uses the knowledge to work in the *current* project
 * 
 * @module tools/xref-tools
 */

import { State } from '../core.js';
import { GitProviderRegistry } from '../git-providers/index.js';

/**
 * Register cross-project reference tools.
 * @param {import('./registry.js').ToolRegistry} registry
 */
export function registerXRefTools(registry) {

    // ========================================
    // peek_project_tree
    // ========================================
    registry.register('peek_project_tree', async ({ connectionId, owner, repo, branch = 'main', path = '' }) => {
        try {
            const { provider, connection } = GitProviderRegistry.resolve(connectionId);
            const tree = await provider.getFileTree(connection, owner, repo, branch, path);

            // Flatten to path + type (same shape as get_project_tree)
            const files = (tree || []).map(f => ({
                path: f.path,
                type: f.type,     // 'blob' | 'tree'
                name: f.name
            }));

            const current = State.currentProject
                ? `${State.currentProject.owner}/${State.currentProject.repo}`
                : null;

            return {
                reference_project: `${owner}/${repo}`,
                reference_branch: branch,
                current_project: current,
                path: path || '/',
                file_count: files.length,
                files
            };
        } catch (error) {
            return { error: `Failed to browse ${owner}/${repo}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'peek_project_tree',
            description: 'Browse the file tree of ANOTHER project without switching away from the current project. Use list_projects first to get connectionId, owner, and repo. Returns the same format as get_project_tree.',
            parameters: {
                type: 'object',
                properties: {
                    connectionId: {
                        type: 'string',
                        description: 'The connection ID from list_projects (e.g., "default-gitea")'
                    },
                    owner: {
                        type: 'string',
                        description: 'Repository owner / organization'
                    },
                    repo: {
                        type: 'string',
                        description: 'Repository name'
                    },
                    branch: {
                        type: 'string',
                        description: 'Branch to browse (default: "main")'
                    },
                    path: {
                        type: 'string',
                        description: 'Optional subdirectory to list (e.g., "src/utils/")'
                    }
                },
                required: ['connectionId', 'owner', 'repo']
            }
        },
        roles: 'all'
    });

    // ========================================
    // peek_project_file
    // ========================================
    registry.register('peek_project_file', async ({ connectionId, owner, repo, path, branch = 'main', full = false }) => {
        try {
            const { provider, connection } = GitProviderRegistry.resolve(connectionId);
            const file = await provider.getFile(connection, owner, repo, path, branch);

            const lines = file.content.split('\n');
            const lineCount = lines.length;
            const MAX_LINES = 200;

            const current = State.currentProject
                ? `${State.currentProject.owner}/${State.currentProject.repo}`
                : null;

            const meta = {
                reference_project: `${owner}/${repo}`,
                reference_branch: branch,
                current_project: current,
                path: file.path || path,
                line_count: lineCount,
                language: path.split('.').pop()
            };

            // Truncate large files unless full=true (same logic as read_file)
            if (!full && lineCount > MAX_LINES) {
                const headCount = 120;
                const tailCount = 60;
                const head = lines.slice(0, headCount)
                    .map((l, i) => `${i + 1}: ${l}`).join('\n');
                const tail = lines.slice(-tailCount)
                    .map((l, i) => `${lineCount - tailCount + i + 1}: ${l}`).join('\n');
                return {
                    ...meta,
                    content: head + `\n\n... (${lineCount - headCount - tailCount} lines omitted — use full=true for complete file) ...\n\n` + tail,
                    truncated: true
                };
            }

            const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
            return {
                ...meta,
                content: numbered,
                truncated: false
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `File not found: '${path}' does not exist in ${owner}/${repo} on branch '${branch}'. Use peek_project_tree to see available files.` };
            }
            return { error: `Failed to read ${owner}/${repo}/${path}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'peek_project_file',
            description: 'Read a file from ANOTHER project without switching away from the current project. This is read-only — you cannot edit files in the reference project. Use list_projects to get connectionId/owner/repo, then peek_project_tree to find the file path. Large files (200+ lines) are truncated unless full=true.',
            parameters: {
                type: 'object',
                properties: {
                    connectionId: {
                        type: 'string',
                        description: 'The connection ID from list_projects'
                    },
                    owner: {
                        type: 'string',
                        description: 'Repository owner / organization'
                    },
                    repo: {
                        type: 'string',
                        description: 'Repository name'
                    },
                    path: {
                        type: 'string',
                        description: 'Path to the file to read (e.g., "src/utils/helpers.js")'
                    },
                    branch: {
                        type: 'string',
                        description: 'Branch to read from (default: "main")'
                    },
                    full: {
                        type: 'boolean',
                        description: 'If true, return the full file content even for large files'
                    }
                },
                required: ['connectionId', 'owner', 'repo', 'path']
            }
        },
        roles: 'all'
    });
}
