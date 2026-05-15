/**
 * AI Editor - Cursor Tools
 * 
 * Tools for cursor-aware, selection-relative editing.
 * 
 * Workflow:  goto_line → select_range → replace_selection
 *            (navigate)   (highlight)    (edit)
 * 
 * Each tool returns enough context for the LLM to verify its position
 * before the next step. No blind edits.
 * 
 * All operations are purely editor-state — no Git, no save.
 * Instantly undo-able with Ctrl+Z.
 */

import { State } from '../core.js';
import {
    goToLine,
    selectRange,
    replaceSelection,
    insertAtCursor,
    getCursorContext
} from '../editor.js';

/**
 * Register all cursor-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerCursorTools(registry) {

    // ========================================
    // goto_line
    // ========================================
    registry.register('goto_line', async ({ line, col }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open. Use open_file first.' };
        }

        const result = goToLine(line, col || 1);
        if (!result) {
            return { error: 'Editor not available.' };
        }

        return {
            success: true,
            path: State.currentFile.path,
            line: result.line,
            col: result.col,
            line_content: result.lineContent,
            word_before: result.wordBefore,
            word_after: result.wordAfter,
            total_lines: result.totalLines,
            context: result.surroundingLines,
            message: `Cursor at line ${result.line}, col ${result.col}` +
                (result.wordBefore ? ` — after "${result.wordBefore}"` : '') +
                (result.wordAfter ? `, before "${result.wordAfter}"` : '')
        };
    }, {
        type: 'function',
        function: {
            name: 'goto_line',
            description: 'Move the cursor to a specific line and column in the current file. Returns the line content, word before/after cursor, and surrounding lines for verification. Use this to navigate before selecting or editing.',
            parameters: {
                type: 'object',
                properties: {
                    line: {
                        type: 'integer',
                        description: 'Line number to go to (1-indexed)'
                    },
                    col: {
                        type: 'integer',
                        description: 'Column number (1-indexed, optional — defaults to 1, the beginning of the line)'
                    }
                },
                required: ['line']
            }
        },
    });

    // ========================================
    // select_range
    // ========================================
    registry.register('select_range', async ({ from_line, from_col, to_line, to_col }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open. Use open_file first.' };
        }

        const result = selectRange(from_line, from_col || 1, to_line, to_col);
        if (!result) {
            return { error: 'Editor not available.' };
        }

        return {
            success: true,
            path: State.currentFile.path,
            from_line: result.fromLine,
            from_col: result.fromCol,
            to_line: result.toLine,
            to_col: result.toCol,
            line_count: result.lineCount,
            selected_text: result.text,
            truncated: result.truncated,
            total_lines: result.totalLines,
            message: `Selected ${result.lineCount} line(s): ${result.fromLine}:${result.fromCol} → ${result.toLine}:${result.toCol}` +
                (result.truncated ? ' (text truncated in output)' : '')
        };
    }, {
        type: 'function',
        function: {
            name: 'select_range',
            description: 'Select a range of text in the current file by line:column coordinates. Returns the selected text. Use after goto_line to verify content before replacing, or independently to highlight a region.',
            parameters: {
                type: 'object',
                properties: {
                    from_line: {
                        type: 'integer',
                        description: 'Start line (1-indexed)'
                    },
                    from_col: {
                        type: 'integer',
                        description: 'Start column (1-indexed, optional — defaults to 1)'
                    },
                    to_line: {
                        type: 'integer',
                        description: 'End line (1-indexed, optional — defaults to from_line for single-line selection)'
                    },
                    to_col: {
                        type: 'integer',
                        description: 'End column (1-indexed, optional — defaults to end of to_line)'
                    }
                },
                required: ['from_line']
            }
        },
    });

    // ========================================
    // replace_selection
    // ========================================
    registry.register('replace_selection', async ({ new_content }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open. Use open_file first.' };
        }

        // Verify there's actually a selection
        const cursor = getCursorContext();
        if (!cursor?.selection) {
            return {
                error: 'No text is selected. Use select_range first to select the text you want to replace.',
                cursor_at: cursor ? `line ${cursor.line}, col ${cursor.col}` : 'unknown'
            };
        }

        const result = replaceSelection(new_content);
        if (!result) {
            return { error: 'Editor not available.' };
        }
        if (result.error) {
            return result;
        }

        return {
            success: true,
            path: State.currentFile.path,
            replaced_lines: `${result.replacedFromLine}-${result.replacedToLine}`,
            old_length: result.oldLength,
            new_length: result.newLength,
            cursor_now: { line: result.cursorLine, col: result.cursorCol },
            total_lines: result.totalLines,
            context: result.surroundingLines,
            message: `Replaced selection (lines ${result.replacedFromLine}-${result.replacedToLine}). ` +
                `Cursor now at line ${result.cursorLine}:${result.cursorCol}. ` +
                `File has ${result.totalLines} lines. Undo: Ctrl+Z`
        };
    }, {
        type: 'function',
        function: {
            name: 'replace_selection',
            description: 'Replace the currently selected text with new content. REQUIRES an active selection — use select_range first. The replaced region is exactly what was highlighted. Returns surrounding context and new cursor position. Undo-able with Ctrl+Z.',
            parameters: {
                type: 'object',
                properties: {
                    new_content: {
                        type: 'string',
                        description: 'The text to replace the selection with'
                    }
                },
                required: ['new_content']
            }
        },
    });

    // ========================================
    // insert_at_cursor
    // ========================================
    registry.register('insert_at_cursor', async ({ content }) => {
        if (!State.currentFile) {
            return { error: 'No file is currently open. Use open_file first.' };
        }

        const result = insertAtCursor(content);
        if (!result) {
            return { error: 'Editor not available.' };
        }

        return {
            success: true,
            path: State.currentFile.path,
            inserted_at: `line ${result.insertedAt.line}, col ${result.insertedAt.col}`,
            inserted_chars: result.insertedChars,
            inserted_lines: result.insertedLines,
            cursor_now: { line: result.cursorLine, col: result.cursorCol },
            total_lines: result.totalLines,
            context: result.surroundingLines,
            message: `Inserted ${result.insertedLines} line(s) at line ${result.insertedAt.line}:${result.insertedAt.col}. ` +
                `Cursor now at ${result.cursorLine}:${result.cursorCol}. Undo: Ctrl+Z`
        };
    }, {
        type: 'function',
        function: {
            name: 'insert_at_cursor',
            description: 'Insert text at the current cursor position without replacing anything. Use goto_line first to position the cursor. Returns the insertion point and surrounding context. Undo-able with Ctrl+Z.',
            parameters: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The text to insert at the cursor'
                    }
                },
                required: ['content']
            }
        },
    });
}
