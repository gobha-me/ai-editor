/**
 * AI Editor - File Tools
 * Tools for reading and navigating files
 */

import { State } from '../core.js';
import { GiteaAPI } from '../gitea.js';
import { EditTracker } from './edit-tracker.js';

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
        roles: 'all'  // All roles can read files
    });

    // NOTE: read_lines is now in scan-tools.js with enhanced features (context_lines parameter)

    // ========================================
    // read_file
    // ========================================
    registry.register('read_file', async ({ path, full = false }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        
        // Note: read_file doesn't track for editing since it doesn't open in editor
        const { owner, repo } = State.currentProject;
        try {
            const file = await GiteaAPI.getFile(owner, repo, path, State.currentBranch);
            const lines = file.content.split('\n');
            const lineCount = lines.length;
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
                    path: file.path,
                    content: head + `\n\n... (${lineCount - headCount - tailCount} lines omitted — use read_lines for ranges OR read_file with full=true) ...\n\n` + tail,
                    line_count: lineCount,
                    truncated: true,
                    language: path.split('.').pop()
                };
            }

            // Small files OR full=true: return complete with line numbers
            const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
            return {
                path: file.path,
                content: numbered,
                line_count: lineCount,
                truncated: false,
                language: path.split('.').pop()
            };
        } catch (error) {
            return { error: `Failed to read file: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the content of a specific file without opening it in the editor. Large files (200+ lines) are truncated by default — use full=true to read complete file, or use read_lines for specific sections.',
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
        roles: 'all'  // All roles can read files
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
        // Use setTimeout to ensure State is updated after file loads
        setTimeout(() => {
            if (State.currentFile?.path === path && State.editorContent) {
                const lineCount = State.editorContent.split('\n').length;
                EditTracker.recordRead(path, 1, lineCount, lineCount);
            }
        }, 100);
        
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
        },
        roles: 'all'  // All roles can open files for viewing
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
        roles: 'all'  // All roles can see open tabs
    });
}
