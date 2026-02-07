/**
 * AI Editor - Edit Tools
 * Tools for modifying file content
 */

import { State } from '../core.js';
import { replaceRange, insertAtLine, deleteRange } from '../editor.js';

/**
 * Return a few lines of surrounding context after an edit so the model
 * can verify placement and know current line numbers for subsequent edits.
 * Keeps the context small (3 lines before + edited region + 3 lines after)
 * to avoid bloating tool results.
 */
function _getEditContext(editStart, editLineCount, totalLines) {
    const content = State.editorContent;
    if (!content) return null;
    const lines = content.split('\n');
    const CONTEXT = 3;
    const ctxStart = Math.max(1, editStart - CONTEXT);
    const ctxEnd = Math.min(totalLines, editStart + editLineCount + CONTEXT);
    const slice = lines.slice(ctxStart - 1, ctxEnd);
    return slice.map((l, i) => `${ctxStart + i}: ${l}`).join('\n');
}

/**
 * Register all edit-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerEditTools(registry) {
    
    // ========================================
    // replace_lines
    // ========================================
    registry.register('replace_lines', async ({ start_line, end_line, new_content }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        
        // Use the replaceRange function from editor.js
        const result = replaceRange(start_line, end_line, new_content);
        
        if (result.error) {
            return result;
        }
        
        // Return surrounding context so the model can verify placement
        // and know correct line numbers for subsequent edits
        const ctx = _getEditContext(start_line, result.newLineCount, result.totalLines);
        
        return {
            success: true,
            path: State.currentFile.path,
            replaced_lines: `${start_line}-${end_line}`,
            original_line_count: result.originalLineCount,
            new_line_count: result.newLineCount,
            line_delta: result.lineDelta,
            total_lines: result.totalLines,
            context: ctx,
            message: `Replaced lines ${start_line}-${end_line} (${result.originalLineCount} lines) with ${result.newLineCount} new lines. ` +
                     `File now has ${result.totalLines} lines (${result.lineDelta >= 0 ? '+' : ''}${result.lineDelta}). ` +
                     `IMPORTANT: Line numbers have shifted by ${result.lineDelta}. Use read_current_file or read_lines before your next edit.`
        };
    }, {
        type: 'function',
        function: {
            name: 'replace_lines',
            description: 'Replace specific lines in the current file. Use this for targeted edits instead of replacing the whole file. Line numbers are 1-indexed. Do NOT include a trailing newline in new_content.',
            parameters: {
                type: 'object',
                properties: {
                    start_line: {
                        type: 'integer',
                        description: 'First line to replace (1-indexed, inclusive)'
                    },
                    end_line: {
                        type: 'integer', 
                        description: 'Last line to replace (1-indexed, inclusive). Use same as start_line to replace single line.'
                    },
                    new_content: {
                        type: 'string',
                        description: 'The new content to insert (can be multiple lines)'
                    }
                },
                required: ['start_line', 'end_line', 'new_content']
            }
        }
    });

    // ========================================
    // insert_lines
    // ========================================
    registry.register('insert_lines', async ({ after_line, content }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file, then use insert_lines.' };
        }
        
        // Use the insertAtLine function from editor.js
        const result = insertAtLine(after_line, content);
        
        if (result.error) {
            return result;
        }
        
        const ctx = _getEditContext(after_line + 1, result.newLineCount, result.totalLines);
        
        return {
            success: true,
            path: State.currentFile.path,
            inserted_after: result.insertedAfter,
            lines_inserted: result.newLineCount,
            total_lines: result.totalLines,
            context: ctx,
            message: `Inserted ${result.newLineCount} lines after line ${after_line}. File now has ${result.totalLines} lines. ` +
                     `IMPORTANT: All lines after ${after_line} shifted by +${result.newLineCount}. Use read_lines before your next edit.`
        };
    }, {
        type: 'function',
        function: {
            name: 'insert_lines',
            description: 'Insert new lines at a specific position in the current file without replacing existing content.',
            parameters: {
                type: 'object',
                properties: {
                    after_line: {
                        type: 'integer',
                        description: 'Insert after this line number (0 to insert at beginning, 1-indexed)'
                    },
                    content: {
                        type: 'string',
                        description: 'The content to insert (can be multiple lines)'
                    }
                },
                required: ['after_line', 'content']
            }
        }
    });

    // ========================================
    // delete_lines
    // ========================================
    registry.register('delete_lines', async ({ start_line, end_line }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open in the editor. Use open_file first to open the target file.' };
        }
        
        // Use the deleteRange function from editor.js
        const result = deleteRange(start_line, end_line);
        
        if (result.error) {
            return result;
        }
        
        const ctx = _getEditContext(start_line, 0, result.totalLines);
        
        return {
            success: true,
            path: State.currentFile.path,
            deleted_lines: `${start_line}-${end_line}`,
            lines_deleted: result.deletedCount,
            total_lines: result.totalLines,
            context: ctx,
            message: `Deleted ${result.deletedCount} lines (${start_line}-${end_line}). File now has ${result.totalLines} lines. ` +
                     `IMPORTANT: All lines after ${start_line} shifted by -${result.deletedCount}. Use read_lines before your next edit.`
        };
    }, {
        type: 'function',
        function: {
            name: 'delete_lines',
            description: 'Delete specific lines from the current file.',
            parameters: {
                type: 'object',
                properties: {
                    start_line: {
                        type: 'integer',
                        description: 'First line to delete (1-indexed, inclusive)'
                    },
                    end_line: {
                        type: 'integer',
                        description: 'Last line to delete (1-indexed, inclusive)'
                    }
                },
                required: ['start_line', 'end_line']
            }
        }
    });
}
