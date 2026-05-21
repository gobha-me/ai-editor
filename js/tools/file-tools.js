/**
 * AI Editor - File Tools
 * Tools for reading and navigating files
 */

import { State } from '../core.js';
import { Git } from '../git.js';
import { EditTracker } from './edit-tracker.js';
import { resolveFileContent } from './_file-content.js';

/**
 * Register all file-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerFileTools(registry) {
    
    // ========================================
    // read_current_file
    // ========================================
    registry.register('read_current_file', async ({ full = false }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        
        const content = State.editorContent;
        const lines = content.split('\n');
        const lineCount = lines.length;
        
        // Track this read for drift detection
        EditTracker.recordRead(State.currentFile.path, 1, lineCount, lineCount);
        
        const MAX_LINES = 200;

        // For large files, truncate UNLESS full=true is explicitly requested
        if (!full && lineCount > MAX_LINES) {
            const headCount = 120;
            const tailCount = 60;
            const head = lines.slice(0, headCount)
                .map((l, i) => `${i + 1}: ${l}`).join('\n');
            const tail = lines.slice(-tailCount)
                .map((l, i) => `${lineCount - tailCount + i + 1}: ${l}`).join('\n');
            return {
                path: State.currentFile.path,
                content: head + `\n\n... (${lineCount - headCount - tailCount} lines omitted — use read_lines for ranges OR read_current_file with full=true) ...\n\n` + tail,
                line_count: lineCount,
                truncated: true,
                language: State.currentFile.path.split('.').pop()
            };
        }

        // Small files OR full=true: return complete with line numbers
        const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
        return {
            path: State.currentFile.path,
            content: numbered,
            line_count: lineCount,
            truncated: false,
            language: State.currentFile.path.split('.').pop()
        };
    }, {
        type: 'function',
        function: {
            name: 'read_current_file',
            description: 'Read the content of the currently open file in the editor. Returns line-numbered content. Large files (200+ lines) are truncated by default — use full=true to read complete file, or use read_lines for specific sections.',
            parameters: {
                type: 'object',
                properties: {
                    full: {
                        type: 'boolean',
                        description: 'If true, return complete file content even if large (default: false)'
                    }
                },
                required: []
            }
        },
        readOnly: true,
        // Result depends on hidden state (which tab is active). Migrated
        // from the legacy `STATEFUL_READ_TOOLS` hand-list at 2.71.0.
        cache: 'never',
    });

    // NOTE: read_lines is now in scan-tools.js with enhanced features (context_lines parameter)

    // ========================================
    // read_file
    // ========================================
    registry.register('read_file', async ({ path, full = false }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }

        try {
            // 1.6.8 follow-up — buffer-aware read; see _file-content.js docstring.
            const { content, source } = await resolveFileContent(path);
            const file = { path, content };

            const lines = file.content.split('\n');
            const lineCount = lines.length;
            const MAX_LINES = 200;

            // gitea#485: refresh the staleness clock on every read regardless
            // of truncation or content source, so the next edit_file measures
            // staleness from this read — not from a prior read whose content
            // the model has already seen and superseded.
            EditTracker.recordRead(path, 1, lineCount, lineCount);

            // For large files, truncate UNLESS full=true is explicitly requested
            if (!full && lineCount > MAX_LINES) {
                const headCount = 120;
                const tailCount = 60;
                const head = lines.slice(0, headCount)
                    .map((l, i) => `${i + 1}: ${l}`).join('\n');
                const tail = lines.slice(-tailCount)
                    .map((l, i) => `${lineCount - tailCount + i + 1}: ${l}`).join('\n');
                return {
                    path: file.path,
                    content: head + `\n\n... (${lineCount - headCount - tailCount} lines omitted — use read_lines for ranges OR read_file with full=true) ...\n\n` + tail,
                    line_count: lineCount,
                    truncated: true,
                    language: path.split('.').pop(),
                    source
                };
            }

            // Small files OR full=true: return complete with line numbers
            const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
            return {
                path: file.path,
                content: numbered,
                line_count: lineCount,
                truncated: false,
                language: path.split('.').pop(),
                source
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `File not found: '${path}' does not exist on branch '${State.currentBranch}'. Use get_project_tree to see available files.` };
            }
            return { error: `Failed to read file '${path}': ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_file',
            description: '**Required:** path. Read the content of a specific file without opening it in the editor. Large files (200+ lines) are truncated by default — use full=true to read complete file, or use read_lines for specific sections.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The path to the file to read'
                    },
                    full: {
                        type: 'boolean',
                        description: 'If true, return complete file content even if large (default: false)'
                    }
                },
                required: ['path']
            }
        },
        readOnly: true
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
        
        // Track this as a read operation (opening = reading)
        // onTreeItemClick awaits file load, so State is already updated
        if (State.currentFile?.path === path && State.editorContent) {
            const lineCount = State.editorContent.split('\n').length;
            EditTracker.recordRead(path, 1, lineCount, lineCount);
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
            description: '**Required:** path. Open a specific file from the project in the editor.',
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
        },
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
        },
        readOnly: true,
        // No args; result depends on tab-manager state (open / dirty /
        // active set). Same shape as gitea#472 `list_dirty_files`.
        cache: 'never',
    });
}
