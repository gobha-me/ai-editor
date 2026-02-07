/**
 * AI Editor - Search Tools
 * Tools for searching across project files
 */

import { State } from '../core.js';
import { GiteaAPI } from '../gitea.js';

/**
 * Register all search-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerSearchTools(registry) {
    
    // ========================================
    // search_in_files
    // ========================================
    registry.register('search_in_files', async ({ query, path = '', max_results = 20 }) => {
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
                    const fileData = await GiteaAPI.getFile(owner, repo, file.path, branch);
                    const lines = fileData.content.split('\n');
                    const matches = [];
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(queryLower)) {
                            matches.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
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
                results,
                message: results.length > 0
                    ? `Found "${query}" in ${results.length} file(s)`
                    : `No matches for "${query}"`
            };
        } catch (error) {
            return { error: `Search failed: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'search_in_files',
            description: 'Search for text across project files. Returns matching lines with file paths and line numbers. Use to find functions, variables, strings, or patterns in the codebase.',
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
                    }
                },
                required: ['query']
            }
        }
    });
}
