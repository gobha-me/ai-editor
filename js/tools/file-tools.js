/**
 * AI Editor - File Tools
 * Tools for reading and navigating files
 */

import { State } from '../core.js';
import { GiteaAPI } from '../gitea.js';

/**
 * Register all file-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerFileTools(registry) {
    
    // ========================================
    // read_current_file
    // ========================================
    registry.register('read_current_file', async () => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        const content = State.editorContent;
        const lines = content.split('\n');
        const lineCount = lines.length;
        const MAX_LINES = 200;

        // For large files, return first + last sections with line numbers
        // so the model can target read_lines for specific regions
        if (lineCount > MAX_LINES) {
            const headCount = 120;
            const tailCount = 60;
            const head = lines.slice(0, headCount)
                .map((l, i) => `${i + 1}: ${l}`).join('\n');
            const tail = lines.slice(-tailCount)
                .map((l, i) => `${lineCount - tailCount + i + 1}: ${l}`).join('\n');
            return {
                path: State.currentFile.path,
                content: head + `\n\n... (${lineCount - headCount - tailCount} lines omitted — use read_lines to see specific ranges) ...\n\n` + tail,
                line_count: lineCount,
                truncated: true,
                language: State.currentFile.path.split('.').pop()
            };
        }

        // Small files: return with line numbers for easy reference
        const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
        return {
            path: State.currentFile.path,
            content: numbered,
            line_count: lineCount,
            language: State.currentFile.path.split('.').pop()
        };
    }, {
        type: 'function',
        function: {
            name: 'read_current_file',
            description: 'Read the content of the currently open file in the editor. Returns line-numbered content. Large files (200+ lines) are automatically truncated — use read_lines for specific sections.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    });

    // ========================================
    // read_lines
    // ========================================
    registry.register('read_lines', async ({ path, start_line, end_line }) => {
        // Read from the currently open file if path matches, otherwise fetch from Gitea
        let content;
        let filePath;

        if (State.currentFile && (!path || path === State.currentFile.path)) {
            content = State.editorContent;
            filePath = State.currentFile.path;
        } else if (path) {
            if (!State.currentProject) {
                return { error: 'No project is currently loaded' };
            }
            const { owner, repo } = State.currentProject;
            try {
                const file = await GiteaAPI.getFile(owner, repo, path, State.currentBranch);
                content = file.content;
                filePath = file.path;
            } catch (error) {
                return { error: `Failed to read file: ${error.message}` };
            }
        } else {
            return { error: 'No file specified and no file is currently open.' };
        }

        const lines = content.split('\n');
        const totalLines = lines.length;
        const start = Math.max(1, start_line || 1);
        const end = Math.min(totalLines, end_line || totalLines);

        if (start > totalLines) {
            return { error: `start_line ${start} exceeds file length (${totalLines} lines)` };
        }

        const slice = lines.slice(start - 1, end);
        const numbered = slice.map((l, i) => `${start + i}: ${l}`).join('\n');

        return {
            path: filePath,
            start_line: start,
            end_line: end,
            line_count: totalLines,
            content: numbered
        };
    }, {
        type: 'function',
        function: {
            name: 'read_lines',
            description: 'Read specific line range from a file. Use this instead of read_file when you only need to see a section of a large file. Lines are returned with line numbers for easy reference.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path to read from (omit to read from currently open file)'
                    },
                    start_line: {
                        type: 'integer',
                        description: 'First line to read (1-indexed, inclusive). Default: 1'
                    },
                    end_line: {
                        type: 'integer',
                        description: 'Last line to read (1-indexed, inclusive). Default: end of file'
                    }
                },
                required: []
            }
        }
    });

    // ========================================
    // read_file
    // ========================================
    registry.register('read_file', async ({ path }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const file = await GiteaAPI.getFile(owner, repo, path, State.currentBranch);
            const lines = file.content.split('\n');
            const lineCount = lines.length;
            const MAX_LINES = 200;

            if (lineCount > MAX_LINES) {
                const headCount = 120;
                const tailCount = 60;
                const head = lines.slice(0, headCount)
                    .map((l, i) => `${i + 1}: ${l}`).join('\n');
                const tail = lines.slice(-tailCount)
                    .map((l, i) => `${lineCount - tailCount + i + 1}: ${l}`).join('\n');
                return {
                    path: file.path,
                    content: head + `\n\n... (${lineCount - headCount - tailCount} lines omitted — use read_lines to see specific ranges) ...\n\n` + tail,
                    line_count: lineCount,
                    truncated: true,
                    language: path.split('.').pop()
                };
            }

            const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
            return {
                path: file.path,
                content: numbered,
                line_count: lineCount,
                language: path.split('.').pop()
            };
        } catch (error) {
            return { error: `Failed to read file: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the content of a specific file without opening it in the editor. Large files (200+ lines) are automatically truncated — use read_lines for specific sections.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The path to the file to read'
                    }
                },
                required: ['path']
            }
        }
    });

    // ========================================
    // open_file
    // ========================================
    registry.register('open_file', async ({ path }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const file = State.fileTree.find(f => f.path === path);
        if (!file) {
            return { error: `File not found: ${path}` };
        }
        if (file.type === 'dir') {
            return { error: `Cannot open directory: ${path}` };
        }
        
        // Trigger file open through the global handler
        if (window.onTreeItemClick) {
            await window.onTreeItemClick(path, 'file', true); // true = pin as non-preview
        }
        
        return {
            success: true,
            path: path,
            message: `Opened ${path} in editor`
        };
    }, {
        type: 'function',
        function: {
            name: 'open_file',
            description: 'Open a specific file from the project in the editor',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The path to the file to open (e.g., "src/main.js")'
                    }
                },
                required: ['path']
            }
        }
    });

    // ========================================
    // list_open_tabs
    // ========================================
    registry.register('list_open_tabs', async () => {
        return {
            tabs: State.openTabs.map((tab, index) => ({
                path: tab.path,
                dirty: tab.dirty,
                isPreview: tab.isPreview,
                isActive: index === State.activeTabIndex
            })),
            activeTab: State.activeTabIndex >= 0 ? State.openTabs[State.activeTabIndex]?.path : null
        };
    }, {
        type: 'function',
        function: {
            name: 'list_open_tabs',
            description: 'List all currently open tabs in the editor',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    });
}
