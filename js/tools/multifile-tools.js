/**
 * AI Editor - Multi-File Editing Tools
 * 
 * Tools that edit files by path without requiring manual open_file first.
 * Auto-opens/switches to the target file, applies the edit, returns context.
 * Enables workflows like: edit_file(a.js, ...) → edit_file(b.js, ...) in
 * a single tool loop with no intermediate open_file calls.
 */

import { State, EventBus } from '../core.js';
import { replaceRange, insertAtLine, deleteRange } from '../editor.js';
import { Git } from '../git.js';
import { EditTracker } from './edit-tracker.js';

// ============================================
// HELPERS
// ============================================

/**
 * Ensure a file is open and active in the editor.
 * Checks open tabs first (fast), then falls back to loading from tree.
 * 
 * @param {string} path - File path to open
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function ensureFileActive(path) {
    // Already the active file — nothing to do
    if (State.currentFile?.path === path) {
        return { ok: true };
    }

    // Check if already open in a tab — just switch
    const tabIdx = State.openTabs.findIndex(t => t.path === path);
    if (tabIdx >= 0) {
        const { switchToTab } = await import('../tab-manager.js');
        await switchToTab(tabIdx);
        return State.currentFile?.path === path
            ? { ok: true }
            : { ok: false, error: `Failed to switch to tab for '${path}'` };
    }

    // Not open — check file tree and open it
    const inTree = State.fileTree?.find(f => f.path === path && f.type !== 'dir');
    if (!inTree) {
        return { ok: false, error: `File not found: '${path}'. Use get_project_tree to see available files.` };
    }

    if (window.onTreeItemClick) {
        await window.onTreeItemClick(path, 'file', true); // true = pin tab
    }

    return State.currentFile?.path === path
        ? { ok: true }
        : { ok: false, error: `Failed to open '${path}' in editor` };
}

/**
 * Return a few lines of surrounding context after an edit.
 * 5 before / 5 after — wide enough to span typical paragraph drift
 * (the qwen-3-6-plus PR #289 trace overshot a 6-line gap with 3/3).
 */
function _getEditContext(editStart, editLineCount, totalLines) {
    const content = State.editorContent;
    if (!content) return null;
    const lines = content.split('\n');
    const CONTEXT = 5;
    const ctxStart = Math.max(1, editStart - CONTEXT);
    const ctxEnd = Math.min(totalLines, editStart + editLineCount + CONTEXT);
    const slice = lines.slice(ctxStart - 1, ctxEnd);
    return slice.map((l, i) => `${ctxStart + i}: ${l}`).join('\n');
}

/**
 * Build a 5-before / 5-after window of the *current* file content around
 * a drift-suggested target range. Inlined into STALE LINE NUMBERS errors
 * so the model can re-anchor without a follow-up read_lines round-trip.
 * Returns null if no editor content is available.
 */
function _getStaleWindow(suggestedStart, suggestedEnd) {
    const content = State.editorContent;
    if (!content || suggestedStart == null) return null;
    const lines = content.split('\n');
    const CONTEXT = 5;
    const totalLines = lines.length;
    const endLine = suggestedEnd || suggestedStart;
    const winStart = Math.max(1, suggestedStart - CONTEXT);
    const winEnd = Math.min(totalLines, endLine + CONTEXT);
    const slice = lines.slice(winStart - 1, winEnd);
    return slice.map((l, i) => `${winStart + i}: ${l}`).join('\n');
}

/**
 * Directional hint for `edit_file` calls that arrive in a wrong shape.
 *
 * Origin: HTML-Games dogfood, qwen-3-6-plus, 2026-05-08. The model invented
 * `operations: '[{"type":"replace","start_line":92,...}]'` (a JSON-encoded
 * batched-ops array) — a field that does not exist on this tool — and burned
 * 4 turns guessing `new_text` → `new_content` against the bare
 * "replace requires …" validation error. Same pattern as 1.8.2's
 * `getRefusalHint`: detect a known-bad shape and emit a targeted hint
 * naming the real shape, not the whole schema.
 *
 * Returns `{ error, hint }` if a wrong-shape key is present, else `null` so
 * the existing per-op validators fire as before for genuine omissions.
 */
function _detectWrongShape(args) {
    if (!args || typeof args !== 'object') return null;
    const keys = Object.keys(args);
    const correctShape =
        '{ path, operation, start_line, end_line, new_content }';

    if (keys.includes('operations') || keys.includes('ops') || keys.includes('op')) {
        return {
            error: `edit_file does not accept '${keys.includes('operations') ? 'operations' : keys.includes('ops') ? 'ops' : 'op'}'. It takes a single op at the top level.`,
            hint: `edit_file takes a single op at the top level: ${correctShape}. The "operations" / batched-ops shape does not exist on this tool — call edit_file once per change.`
        };
    }

    if (keys.includes('new_text') || keys.includes('text') || keys.includes('content')) {
        const wrong = keys.includes('new_text') ? 'new_text'
            : keys.includes('text') ? 'text'
            : 'content';
        return {
            error: `edit_file does not accept '${wrong}'. The content parameter is named 'new_content'.`,
            hint: `edit_file shape: ${correctShape}. Rename '${wrong}' → 'new_content'.`
        };
    }

    return null;
}

// ============================================
// TOOL REGISTRATION
// ============================================

/**
 * @param {Object} registry - ToolRegistry instance
 */
export function registerMultiFileTools(registry) {

    // ========================================
    // edit_file — replace/insert/delete by path
    // ========================================
    // Take the full args object so wrong-shape detection can inspect
    // top-level keys before destructuring strips the unrecognized ones.
    // Same hint pattern as 1.8.2's `getRefusalHint` — narrowly scoped
    // to known-bad shapes surfaced by the 2026-05-08 HTML-Games dogfood
    // (qwen-3-6-plus invented `operations: '[...]'`).
    registry.register('edit_file', async (args) => {
        // Wrong-shape pre-check fires *before* any State or path
        // preconditions — schema mistakes are more directional than
        // "no project loaded" and don't depend on workspace state.
        const wrongShape = _detectWrongShape(args);
        if (wrongShape) return wrongShape;

        const { path, operation, start_line, end_line, after_line, new_content } = args || {};
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }

        // Auto-open the target file
        const { ok, error } = await ensureFileActive(path);
        if (!ok) return { error };

        // Validate operation
        const op = (operation || 'replace').toLowerCase();

        if (op === 'replace') {
            if (start_line == null || end_line == null || new_content == null) {
                return { error: 'replace requires start_line, end_line, and new_content' };
            }

            // Stale check
            const staleCheck = EditTracker.checkStale(path, start_line, end_line);
            if (staleCheck.stale) {
                const win = _getStaleWindow(staleCheck.suggestedStartLine, staleCheck.suggestedEndLine);
                return {
                    error: `🚨 STALE LINE NUMBERS 🚨\n${staleCheck.reason}\n` +
                        (staleCheck.suggestedStartLine
                            ? `💡 Content may now be at lines ${staleCheck.suggestedStartLine}-${staleCheck.suggestedEndLine}.`
                            : '') +
                        (win ? `\n\nCurrent content at the suggested range (live, no read_lines needed):\n${win}` : '')
                };
            }

            const result = replaceRange(start_line, end_line, new_content);
            if (result.error) return result;

            EditTracker.recordEdit(path, 'replace', start_line, end_line, result.lineDelta);
            const ctx = _getEditContext(start_line, result.newLineCount, result.totalLines);

            return {
                success: true, path, operation: 'replace',
                replaced_lines: `${start_line}-${end_line}`,
                original_line_count: result.originalLineCount,
                new_line_count: result.newLineCount,
                line_delta: result.lineDelta,
                total_lines: result.totalLines,
                context: ctx,
                message: `Replaced lines ${start_line}-${end_line} in ${path}. File now has ${result.totalLines} lines (${result.lineDelta >= 0 ? '+' : ''}${result.lineDelta}). Re-read before next edit.`
            };

        } else if (op === 'insert') {
            const insertAfter = after_line ?? start_line ?? 0;
            if (new_content == null) {
                return { error: 'insert requires new_content (and after_line or start_line)' };
            }

            const staleCheck = EditTracker.checkStale(path, insertAfter);
            if (staleCheck.stale) {
                const win = _getStaleWindow(staleCheck.suggestedStartLine, staleCheck.suggestedStartLine);
                return {
                    error: `🚨 STALE LINE NUMBERS 🚨\n${staleCheck.reason}\n` +
                        (staleCheck.suggestedStartLine
                            ? `💡 Insertion point may now be at line ${staleCheck.suggestedStartLine}.`
                            : '') +
                        (win ? `\n\nCurrent content at the suggested insertion point (live, no read_lines needed):\n${win}` : '')
                };
            }

            const result = insertAtLine(insertAfter, new_content);
            if (result.error) return result;

            EditTracker.recordEdit(path, 'insert', insertAfter, insertAfter, result.newLineCount);
            const ctx = _getEditContext(insertAfter + 1, result.newLineCount, result.totalLines);

            return {
                success: true, path, operation: 'insert',
                inserted_after: insertAfter,
                lines_inserted: result.newLineCount,
                total_lines: result.totalLines,
                context: ctx,
                message: `Inserted ${result.newLineCount} lines after line ${insertAfter} in ${path}. File now has ${result.totalLines} lines.`
            };

        } else if (op === 'delete') {
            if (start_line == null || end_line == null) {
                return { error: 'delete requires start_line and end_line' };
            }

            const staleCheck = EditTracker.checkStale(path, start_line, end_line);
            if (staleCheck.stale) {
                const win = _getStaleWindow(staleCheck.suggestedStartLine, staleCheck.suggestedEndLine);
                return {
                    error: `🚨 STALE LINE NUMBERS 🚨\n${staleCheck.reason}\n` +
                        (staleCheck.suggestedStartLine
                            ? `💡 Lines may now be at ${staleCheck.suggestedStartLine}-${staleCheck.suggestedEndLine}.`
                            : '') +
                        (win ? `\n\nCurrent content at the suggested range (live, no read_lines needed):\n${win}` : '')
                };
            }

            const result = deleteRange(start_line, end_line);
            if (result.error) return result;

            EditTracker.recordEdit(path, 'delete', start_line, end_line, -result.deletedCount);
            const ctx = _getEditContext(start_line, 0, result.totalLines);

            return {
                success: true, path, operation: 'delete',
                deleted_lines: `${start_line}-${end_line}`,
                lines_deleted: result.deletedCount,
                total_lines: result.totalLines,
                context: ctx,
                message: `Deleted lines ${start_line}-${end_line} in ${path}. File now has ${result.totalLines} lines.`
            };

        } else {
            return { error: `Unknown operation '${operation}'. Use 'replace', 'insert', or 'delete'.` };
        }
    }, {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Edit any file by path — auto-opens it if needed. Supports replace, insert, and delete operations. Preferred over open_file + replace_lines for multi-file workflows.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path to edit (e.g. "js/app.js")'
                    },
                    operation: {
                        type: 'string',
                        enum: ['replace', 'insert', 'delete'],
                        description: 'Edit operation (default: replace)'
                    },
                    start_line: {
                        type: 'integer',
                        description: 'First line (1-indexed, inclusive). Required for replace and delete.'
                    },
                    end_line: {
                        type: 'integer',
                        description: 'Last line (1-indexed, inclusive). Required for replace and delete.'
                    },
                    after_line: {
                        type: 'integer',
                        description: 'Insert after this line (0 = beginning). For insert operation.'
                    },
                    new_content: {
                        type: 'string',
                        description: 'New content to insert or replace with. Required for replace and insert.'
                    }
                },
                required: ['path']
            }
        },
        roles: ['coder']
    });

    // ========================================
    // write_file — create or overwrite entire file
    // ========================================
    registry.register('write_file', async ({ path, content }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        if (content == null) {
            return { error: 'content is required' };
        }

        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        const inTree = State.fileTree?.find(f => f.path === path && f.type !== 'dir');

        if (inTree) {
            // --- Existing file: open and replace all content ---
            const { ok, error } = await ensureFileActive(path);
            if (!ok) return { error };

            const totalLines = State.editorContent.split('\n').length;

            // Replace entire file content
            const result = replaceRange(1, totalLines, content);
            if (result.error) return result;

            EditTracker.recordEdit(path, 'replace', 1, totalLines, result.lineDelta);

            return {
                success: true, path,
                created: false,
                line_count: result.totalLines,
                message: `Overwrote ${path} (${result.totalLines} lines). Review and save when ready.`
            };

        } else {
            // --- New file: create via Git API, then open in editor ---
            try {
                await Git.createFile(owner, repo, path, content, `Create ${path}`, branch);
            } catch (err) {
                return { error: `Failed to create '${path}': ${err.message}` };
            }

            // Refresh tree so the new file appears
            EventBus.emit('tree:refresh');

            // Wait briefly for tree refresh, then open
            await new Promise(r => setTimeout(r, 500));

            if (window.onTreeItemClick) {
                try {
                    await window.onTreeItemClick(path, 'file', true);
                } catch (_) {
                    // File was created even if open fails
                }
            }

            const lineCount = content.split('\n').length;
            return {
                success: true, path,
                created: true,
                line_count: lineCount,
                message: `Created ${path} (${lineCount} lines) and opened in editor.`
            };
        }
    }, {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write entire content to a file. If the file exists, overwrites in the editor (not committed until user saves). If the file is new, creates it via Git and opens it. Use for new files or complete rewrites.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path (e.g. "js/new-module.js")'
                    },
                    content: {
                        type: 'string',
                        description: 'Complete file content to write'
                    }
                },
                required: ['path', 'content']
            }
        },
        roles: ['coder']
    });
}

// Test seam — exported so tests can verify the 5/5 context width and the
// stale-window slice behavior in isolation, without needing to drive
// edit_file through a full tool loop. Underscore prefix signals "internal".
export const _internals = { _getEditContext, _getStaleWindow };
