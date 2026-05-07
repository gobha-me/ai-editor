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
        // Guard: reject if targeting the current project (LLM should use get_project_tree)
        if (State.currentProject &&
            State.currentProject.owner === owner &&
            State.currentProject.repo === repo) {
            return {
                error: `"${owner}/${repo}" IS the current project. Use get_project_tree to browse it, or read_file / read_lines to view files. peek_project_tree is only for OTHER projects.`
            };
        }

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
            description: 'Browse the file tree of a DIFFERENT project without switching away from the current one. NEVER use this for the current project — use get_project_tree instead. You MUST call list_projects first to get the correct connectionId, owner, and repo — do not guess these values. Returns the same format as get_project_tree.',
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
        roles: 'all',
        readOnly: true
    });

    // ========================================
    // peek_project_file
    // ========================================
    registry.register('peek_project_file', async ({ connectionId, owner, repo, path, branch = 'main', full = false }) => {
        // Guard: reject if targeting the current project
        if (State.currentProject &&
            State.currentProject.owner === owner &&
            State.currentProject.repo === repo) {
            return {
                error: `"${owner}/${repo}" IS the current project. Use read_file or read_lines to view its files. peek_project_file is only for OTHER projects.`
            };
        }

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
            description: 'Read a file from a DIFFERENT project without switching away from the current one. NEVER use this for the current project — use read_file or read_lines instead. Read-only — you cannot edit files in the reference project. You MUST call list_projects first to get connectionId/owner/repo — do not guess these values. Large files (200+ lines) are truncated unless full=true.',
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
        roles: 'all',
        readOnly: true
    });

    // ========================================
    // peek_read_lines
    // ========================================
    registry.register('peek_read_lines', async ({ connectionId, owner, repo, path, branch = 'main', start_line, end_line }) => {
        try {
            const { provider, connection } = GitProviderRegistry.resolve(connectionId);
            const file = await provider.getFile(connection, owner, repo, path, branch);

            const lines = file.content.split('\n');
            const total = lines.length;

            // Clamp range
            const start = Math.max(1, start_line || 1);
            const end = Math.min(total, end_line || total);

            if (start > total) {
                return { error: `start_line ${start} exceeds file length (${total} lines)` };
            }

            const slice = lines.slice(start - 1, end)
                .map((l, i) => `${start + i}: ${l}`)
                .join('\n');

            const current = State.currentProject
                ? `${State.currentProject.owner}/${State.currentProject.repo}`
                : null;

            return {
                reference_project: `${owner}/${repo}`,
                reference_branch: branch,
                current_project: current,
                path,
                start_line: start,
                end_line: end,
                total_lines: total,
                content: slice
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `File not found: '${path}' in ${owner}/${repo} on branch '${branch}'` };
            }
            return { error: `Failed to read ${owner}/${repo}/${path}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'peek_read_lines',
            description: 'Read a specific line range from a file in ANOTHER project. More efficient than peek_project_file for large files — fetch only the lines you need. Use peek_project_file first to find the relevant area, then peek_read_lines for the exact range.',
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
                        description: 'Path to the file'
                    },
                    branch: {
                        type: 'string',
                        description: 'Branch to read from (default: "main")'
                    },
                    start_line: {
                        type: 'integer',
                        description: 'First line to read (1-indexed)'
                    },
                    end_line: {
                        type: 'integer',
                        description: 'Last line to read (inclusive)'
                    }
                },
                required: ['connectionId', 'owner', 'repo', 'path', 'start_line', 'end_line']
            }
        },
        roles: 'all',
        readOnly: true
    });
}
