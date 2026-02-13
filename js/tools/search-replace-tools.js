/**
 * AI Editor - Search & Replace Tool
 *
 * Text-based file editing that doesn't require line numbers.
 * Designed for small/medium LLMs that struggle with line-number
 * arithmetic. The model copies exact text from the file, provides
 * the replacement, and the tool handles the rest.
 *
 * Three explicit operations — no magic empty-string behavior:
 *   replace      — find exact text, swap with new text
 *   delete       — find exact text, remove it
 *   insert_after — find anchor text, add new content after it
 */

import { State, EventBus } from '../core.js';
import { replaceText } from '../editor.js';

// ============================================
// HELPERS
// ============================================

/**
 * Ensure a file is open and active in the editor.
 * Same logic as multifile-tools.js — duplicated to avoid circular deps.
 */
async function ensureFileActive(path) {
    if (State.currentFile?.path === path) {
        return { ok: true };
    }

    const tabIdx = State.openTabs.findIndex(t => t.path === path);
    if (tabIdx >= 0) {
        const { switchToTab } = await import('../tab-manager.js');
        await switchToTab(tabIdx);
        return State.currentFile?.path === path
            ? { ok: true }
            : { ok: false, error: `Failed to switch to tab for '${path}'` };
    }

    const inTree = State.fileTree?.find(f => f.path === path && f.type !== 'dir');
    if (!inTree) {
        return { ok: false, error: `File not found: '${path}'. Use get_project_tree to see available files.` };
    }

    if (window.onTreeItemClick) {
        await window.onTreeItemClick(path, 'file', true);
    }

    return State.currentFile?.path === path
        ? { ok: true }
        : { ok: false, error: `Failed to open '${path}' in editor` };
}

/**
 * Return surrounding context lines around a given line range.
 */
function _getContext(startLine, lineCount, totalLines) {
    const content = State.editorContent;
    if (!content) return null;
    const lines = content.split('\n');
    const CONTEXT = 3;
    const ctxStart = Math.max(1, startLine - CONTEXT);
    const ctxEnd = Math.min(totalLines, startLine + lineCount + CONTEXT - 1);
    const slice = lines.slice(ctxStart - 1, ctxEnd);
    return slice.map((l, i) => `${ctxStart + i}: ${l}`).join('\n');
}

// ============================================
// TOOL REGISTRATION
// ============================================

/**
 * @param {Object} registry - ToolRegistry instance
 */
export function registerSearchReplaceTools(registry) {

    registry.register('search_replace', async ({ path, operation, find, replace, new_content }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        if (!find) {
            return { error: 'find is required — copy the exact text you want to match' };
        }

        // Resolve which file to edit
        const targetPath = path || State.currentFile?.path;
        if (!targetPath) {
            return { error: 'No file specified and no file is open. Provide the path parameter.' };
        }

        // Auto-open the target file
        const { ok, error } = await ensureFileActive(targetPath);
        if (!ok) return { error };

        const op = (operation || 'replace').toLowerCase();

        // ========================================
        // REPLACE — find exact text, swap with new
        // ========================================
        if (op === 'replace') {
            const replacement = replace ?? new_content;
            if (replacement == null) {
                return { error: 'replace (or new_content) is required for the replace operation. To remove text, use operation: "delete" instead.' };
            }

            const result = replaceText(find, replacement);
            if (result.error) return result;

            const ctx = _getContext(result.startLine, result.newLineCount, result.totalLines);

            return {
                success: true,
                path: targetPath,
                operation: 'replace',
                start_line: result.startLine,
                line_delta: result.lineDelta,
                total_lines: result.totalLines,
                context: ctx,
                message: `Replaced text in ${targetPath} at line ${result.startLine}. File now has ${result.totalLines} lines.`
            };

        // ========================================
        // DELETE — find exact text, remove it
        // ========================================
        } else if (op === 'delete') {
            const result = replaceText(find, '');
            if (result.error) return result;

            const ctx = _getContext(result.startLine, 0, result.totalLines);

            return {
                success: true,
                path: targetPath,
                operation: 'delete',
                start_line: result.startLine,
                lines_removed: Math.abs(result.lineDelta),
                total_lines: result.totalLines,
                context: ctx,
                message: `Deleted text from ${targetPath} at line ${result.startLine}. Removed ${Math.abs(result.lineDelta)} lines. File now has ${result.totalLines} lines.`
            };

        // ========================================
        // INSERT_AFTER — find anchor, add after it
        // ========================================
        } else if (op === 'insert_after') {
            const insertion = replace ?? new_content;
            if (insertion == null) {
                return { error: 'replace (or new_content) is required for insert_after — this is the text to insert after the anchor.' };
            }

            // The anchor stays, new content goes right after it
            const combined = find + insertion;
            const result = replaceText(find, combined);
            if (result.error) return result;

            const insertedLines = insertion.split('\n').length;
            const ctx = _getContext(result.startLine, result.newLineCount, result.totalLines);

            return {
                success: true,
                path: targetPath,
                operation: 'insert_after',
                start_line: result.startLine,
                lines_inserted: insertedLines,
                total_lines: result.totalLines,
                context: ctx,
                message: `Inserted ${insertedLines} lines after anchor in ${targetPath}. File now has ${result.totalLines} lines.`
            };

        // ========================================
        // INSERT_BEFORE — find anchor, add before it
        // ========================================
        } else if (op === 'insert_before') {
            const insertion = replace ?? new_content;
            if (insertion == null) {
                return { error: 'replace (or new_content) is required for insert_before — this is the text to insert before the anchor.' };
            }

            const combined = insertion + find;
            const result = replaceText(find, combined);
            if (result.error) return result;

            const insertedLines = insertion.split('\n').length;
            const ctx = _getContext(result.startLine, result.newLineCount, result.totalLines);

            return {
                success: true,
                path: targetPath,
                operation: 'insert_before',
                start_line: result.startLine,
                lines_inserted: insertedLines,
                total_lines: result.totalLines,
                context: ctx,
                message: `Inserted ${insertedLines} lines before anchor in ${targetPath}. File now has ${result.totalLines} lines.`
            };

        } else {
            return { error: `Unknown operation '${operation}'. Use 'replace', 'delete', 'insert_after', or 'insert_before'.` };
        }

    }, {
        type: 'function',
        function: {
            name: 'search_replace',
            description: `Find and replace text in a file by exact string match. No line numbers needed — just copy the exact text you want to change.

IMPORTANT RULES:
1. The "find" text must match EXACTLY — same whitespace, same indentation, same line breaks.
2. The "find" text must appear exactly ONCE in the file. If it matches multiple times, include more surrounding lines to make it unique.
3. Use operation "replace" to swap text, "delete" to remove text, "insert_after" to add new lines after an anchor.
4. Read the file first (read_file or read_current_file) so you can copy exact text.`,
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path to edit (e.g. "js/app.js"). If omitted, edits the currently open file.'
                    },
                    operation: {
                        type: 'string',
                        enum: ['replace', 'delete', 'insert_after', 'insert_before'],
                        description: 'What to do: "replace" swaps find→replace, "delete" removes the found text, "insert_after" adds new content after the anchor text, "insert_before" adds before it. Default: replace.'
                    },
                    find: {
                        type: 'string',
                        description: 'Exact text to find. Must match exactly once. Copy it from the file including whitespace and indentation.'
                    },
                    replace: {
                        type: 'string',
                        description: 'New text (for replace) or text to insert (for insert_after/insert_before). Not used for delete.'
                    }
                },
                required: ['find']
            }
        },
        roles: ['coder']
    });
}
