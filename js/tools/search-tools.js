/**
 * AI Editor - Search Tools
 * Tools for searching across project files
 */

import { State } from '../core.js';
import { Git } from '../git.js';

/**
 * Register all search-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerSearchTools(registry) {
    
    // ========================================
    // search_in_files
    // ========================================
    registry.register('search_in_files', async ({ query, path = '', max_results = 20, compact = true }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        try {
            let files = State.fileTree.filter(f => f.type !== 'dir');
            if (path) files = files.filter(f => f.path.startsWith(path));

            const textExts = new Set([
                'js','ts','jsx','tsx','py','go','rs','c','cpp','h','hpp',
                'java','rb','php','css','scss','html','htm','xml','json',
                'yaml','yml','toml','md','txt','sh','bash','sql','vue',
                'svelte','conf','cfg','ini','pl','pm'
            ]);
            files = files.filter(f => {
                const ext = f.path.split('.').pop().toLowerCase();
                const name = f.path.split('/').pop().toLowerCase();
                return textExts.has(ext) || textExts.has(name);
            });

            const results = [];
            const queryLower = query.toLowerCase();
            for (const file of files.slice(0, 50)) {
                if (results.length >= max_results) break;
                try {
                    const fileData = await Git.getFile(owner, repo, file.path, branch);
                    const lines = fileData.content.split('\n');
                    const matches = [];
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(queryLower)) {
                            const maxLength = compact ? 80 : 200;
                            const snippet = lines[i].trim().substring(0, maxLength);
                            matches.push({ line: i + 1, snippet });
                            if (matches.length >= 5) break;
                        }
                    }
                    if (matches.length > 0) {
                        results.push({ path: file.path, matches });
                    }
                } catch (e) { /* skip unreadable files */ }
            }
            return {
                query, files_searched: Math.min(files.length, 50),
                total_files_in_scope: files.length,
                results,
                message: results.length > 0
                    ? `Found "${query}" in ${results.length} file(s)`
                    : `No matches for "${query}"`,
                ...(files.length > 50 ? {
                    files_truncated: true,
                    hint: `Only searched first 50 of ${files.length} files in scope. Use the 'path' parameter to narrow scope (e.g., path="js/tools/") for more targeted results.`
                } : {}),
                ...(results.length >= max_results ? {
                    results_capped: true,
                    hint_results: `Hit max_results limit (${max_results}). Increase max_results or narrow scope with 'path' to find more matches.`
                } : {})
            };
        } catch (error) {
            return { error: `Search failed: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'search_in_files',
            description: 'Search for text across project files. Returns compact snippets with line numbers. Use read_lines to see full context around matches. Efficient for finding functions, variables, strings, or patterns.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Text to search for (case-insensitive)'
                    },
                    path: {
                        type: 'string',
                        description: 'Optional directory prefix to limit scope (e.g., "js/")'
                    },
                    max_results: {
                        type: 'integer',
                        description: 'Max files to return (default: 20)'
                    },
                    compact: {
                        type: 'boolean',
                        description: 'Return 80-char snippets instead of 200-char (default: true, saves tokens)'
                    }
                },
                required: ['query']
            }
        },
        roles: 'all'  // All roles can search the codebase
    });
}
