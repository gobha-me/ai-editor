/**
 * Editor Instance & Operations
 * CodeMirror 6 editor creation, content manipulation, and line-level editing.
 * Extracted from editor.js in 0.9.13.
 *
 * Reads CodeMirror references from the CM namespace (editor/setup.js).
 */

import { State, EventBus } from '../core.js';
import { CM, loadCodeMirror, getLanguageExtension } from './setup.js';
import { getBlameCompartment } from './blame-gutter.js';

// ============================================
// EDITOR INSTANCE
// ============================================

export let editorInstance = null;

// Compartment for dynamic line number toggling (CM6 best practice)
let lineNumberCompartment = null;

// ============================================
// EDITOR CREATION
// ============================================

export async function createEditor(container, content, filename) {
    // Handle both options object (for future) and positional args (for backward compat)
    if (typeof container === 'object' && container !== null && !container.nodeType) {
        const options = container;
        container = options.container;
        content = options.doc;
        filename = options.filename;
    }
    
    content = content || '';
    filename = filename || '';
    
    if (!CM.EditorView) {
        console.log('CodeMirror not loaded, attempting to load...');
        const loaded = await loadCodeMirror();
        if (!loaded) {
            throw new Error('Failed to load CodeMirror from all CDN providers. Check network connectivity or firewall settings.');
        }
    }

    // Destroy existing editor
    if (editorInstance) {
        editorInstance.destroy();
    }
    if (container) {
        container.innerHTML = '';
    }

    // Get language extension
    const languageExt = getLanguageExtension(filename);
    const languageExtensions = Array.isArray(languageExt) ? languageExt : (languageExt ? [languageExt] : []);

    // Build extensions array with defensive checks
    const extensions = [];
    
    // Create fresh compartment for line number visibility
    lineNumberCompartment = CM.Compartment ? new CM.Compartment() : null;
    
    // Add basicSetup
    if (Array.isArray(CM.basicSetup)) {
        extensions.push(...CM.basicSetup);
    } else if (CM.basicSetup) {
        extensions.push(CM.basicSetup);
    }
    
    // Add line number visibility compartment
    if (lineNumberCompartment) {
        const { State: AppState } = await import('../core.js');
        const showNumbers = AppState.settings.showLineNumbers !== false;
        if (showNumbers) {
            extensions.push(lineNumberCompartment.of([]));
        } else {
            extensions.push(lineNumberCompartment.of(
                CM.EditorView.theme({
                    '.cm-lineNumbers': { display: 'none !important' },
                    '.cm-activeLineGutter': { display: 'none !important' },
                    '.cm-foldGutter': { display: 'none !important' },
                    '.cm-gutters': { 'border-right': 'none', 'min-width': '0' }
                })
            ));
        }
    }
    
    // Theme
    if (CM.oneDark) extensions.push(CM.oneDark);
    
    // Keymaps
    if (CM.keymap && CM.indentWithTab) {
        const keymapExtensions = [CM.indentWithTab];
        if (Array.isArray(CM.defaultKeymap)) keymapExtensions.push(...CM.defaultKeymap);
        if (Array.isArray(CM.historyKeymap)) keymapExtensions.push(...CM.historyKeymap);
        extensions.push(CM.keymap.of(keymapExtensions));
    }
    
    // Update listener
    if (CM.EditorView?.updateListener?.of) {
        extensions.push(CM.EditorView.updateListener.of(update => {
            if (update.docChanged) {
                State.editorContent = update.state.doc.toString();
                State.editorDirty = true;
                EventBus.emit('editor:change', { content: State.editorContent });
            }
            // Emit cursor/selection changes (selection includes cursor moves)
            if (update.selectionSet || update.docChanged) {
                EventBus.emit('editor:cursorActivity', getCursorContext());
            }
        }));
    }
    
    // Line wrapping
    if (CM.lineWrapping) extensions.push(CM.lineWrapping);

    // Blame gutter compartment (starts empty = no gutter column)
    const blameComp = getBlameCompartment();
    if (blameComp) extensions.push(blameComp.of([]));
    
    // Language extensions
    extensions.push(...languageExtensions);

    console.log('Creating editor with extensions:', extensions.map(e => 
        e ? (e.constructor?.name || typeof e) : 'undefined'
    ));

    const validExtensions = extensions.filter(ext => ext !== undefined && ext !== null);
    console.log(`Valid extensions count: ${validExtensions.length} / ${extensions.length}`);

    try {
        const state = CM.EditorState.create({
            doc: content,
            extensions: validExtensions
        });

        editorInstance = new CM.EditorView({
            state,
            parent: container
        });

        State.editorContent = content;
        State.editorDirty = false;

        EventBus.emit('editor:created', { filename });
        return editorInstance;
    } catch (error) {
        console.error('Failed to create editor state:', error);
        console.error('Extensions that failed:', extensions.map((ext, i) => ({
            index: i,
            type: typeof ext,
            constructor: ext?.constructor?.name,
            hasExtension: ext?.extension !== undefined
        })));
        throw error;
    }
}

// ============================================
// EDITOR OPERATIONS
// ============================================

export function setContent(content, preserveHistory = false) {
    if (!editorInstance) return;

    if (preserveHistory) {
        const transaction = editorInstance.state.update({
            changes: {
                from: 0,
                to: editorInstance.state.doc.length,
                insert: content
            }
        });
        editorInstance.dispatch(transaction);
    } else {
        const state = CM.EditorState.create({
            doc: content,
            extensions: editorInstance.state.facet(CM.EditorState.facet)
        });
        editorInstance.setState(state);
    }

    State.editorContent = content;
}

export function getContent() {
    if (!editorInstance) return State.editorContent;
    return editorInstance.state.doc.toString();
}

export function getSelection() {
    if (!editorInstance) return null;
    
    const selection = editorInstance.state.selection.main;
    if (selection.empty) return null;
    
    return {
        from: selection.from,
        to: selection.to,
        text: editorInstance.state.sliceDoc(selection.from, selection.to)
    };
}

/**
 * Get full cursor context for LLM awareness.
 * Returns cursor position, selection (if any), and surrounding lines.
 * @returns {object|null} { line, col, filePath, selection?: { fromLine, toLine, text } }
 */
const MAX_SELECTION_CHARS = 3000;
const MAX_SELECTION_LINES = 60;

export function getCursorContext() {
    if (!editorInstance || !State.currentFile) return null;

    const state = editorInstance.state;
    const sel = state.selection.main;
    const cursorPos = sel.head;
    const cursorLine = state.doc.lineAt(cursorPos);

    const ctx = {
        filePath: State.currentFile.path,
        line: cursorLine.number,
        col: cursorPos - cursorLine.from + 1,
        totalLines: state.doc.lines,
        selection: null
    };

    if (!sel.empty) {
        const fromLine = state.doc.lineAt(sel.from);
        const toLine = state.doc.lineAt(sel.to);
        let text = state.sliceDoc(sel.from, sel.to);
        let truncated = false;

        const lineCount = toLine.number - fromLine.number + 1;
        if (text.length > MAX_SELECTION_CHARS || lineCount > MAX_SELECTION_LINES) {
            // Truncate but keep first and last portions for context
            const half = Math.floor(MAX_SELECTION_CHARS / 2);
            text = text.slice(0, half) + `\n... (${lineCount} lines total, truncated) ...\n` + text.slice(-half);
            truncated = true;
        }

        ctx.selection = {
            fromLine: fromLine.number,
            toLine: toLine.number,
            lineCount,
            text,
            truncated
        };
    }

    return ctx;
}

export function replaceSelection(text) {
    if (!editorInstance) return;
    
    const selection = editorInstance.state.selection.main;
    editorInstance.dispatch({
        changes: {
            from: selection.from,
            to: selection.to,
            insert: text
        }
    });
}

export function insertAtCursor(text) {
    if (!editorInstance) return;
    
    const pos = editorInstance.state.selection.main.head;
    editorInstance.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length }
    });
}

export function goToLine(line) {
    if (!editorInstance) return;
    
    const lineInfo = editorInstance.state.doc.line(Math.min(line, editorInstance.state.doc.lines));
    editorInstance.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true
    });
    editorInstance.focus();
}

export function highlightRange(from, to) {
    if (!editorInstance) return;
    
    editorInstance.dispatch({
        selection: { anchor: from, head: to },
        scrollIntoView: true
    });
}

export function focus() {
    if (editorInstance) {
        editorInstance.focus();
    }
}

// ============================================
// SECTION-BASED EDITING (for LLM tools)
// ============================================

/**
 * Get information about a specific line in the editor.
 * @param {number} lineNum - 1-indexed line number
 * @returns {object|null} { from, to, text, length } or null if invalid
 */
export function getLineInfo(lineNum) {
    if (!editorInstance) return null;
    
    const doc = editorInstance.state.doc;
    if (lineNum < 1 || lineNum > doc.lines) return null;
    
    const line = doc.line(lineNum);
    return {
        from: line.from,
        to: line.to,
        text: line.text,
        length: line.length
    };
}

/**
 * Get content of a range of lines.
 * @param {number} startLine - 1-indexed start line (inclusive)
 * @param {number} endLine - 1-indexed end line (inclusive)
 * @returns {object|null} { text, lineCount, from, to } or null if invalid
 */
export function getLineRange(startLine, endLine) {
    if (!editorInstance) return null;
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));
    
    const from = doc.line(clampedStart).from;
    const to = doc.line(clampedEnd).to;
    const text = doc.sliceString(from, to);
    
    return {
        text,
        lineCount: clampedEnd - clampedStart + 1,
        from,
        to,
        startLine: clampedStart,
        endLine: clampedEnd
    };
}

/**
 * Replace a range of lines with new content.
 * @param {number} startLine - 1-indexed start line (inclusive)
 * @param {number} endLine - 1-indexed end line (inclusive)
 * @param {string} newContent - Replacement text
 * @returns {object} { success, oldContent, newLineCount, totalLines }
 */
export function replaceRange(startLine, endLine, newContent) {
    if (!editorInstance) return { success: false, error: 'No editor instance' };
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));
    
    const from = doc.line(clampedStart).from;
    const to = doc.line(clampedEnd).to;
    const oldContent = doc.sliceString(from, to);
    
    editorInstance.dispatch({
        changes: { from, to, insert: newContent }
    });
    
    // Update state
    State.editorContent = editorInstance.state.doc.toString();
    State.editorDirty = true;
    
    const newTotalLines = editorInstance.state.doc.lines;
    const newLineCount = newContent.split('\n').length;
    const originalLineCount = clampedEnd - clampedStart + 1;
    const lineDelta = newLineCount - originalLineCount;
    
    EventBus.emit('editor:linesReplaced', {
        startLine: clampedStart,
        endLine: clampedEnd,
        oldLineCount: originalLineCount,
        newLineCount,
        totalLines: newTotalLines
    });
    
    return {
        success: true,
        oldContent,
        originalLineCount,
        newLineCount,
        lineDelta,
        totalLines: newTotalLines
    };
}

/**
 * Insert content after a specific line.
 * @param {number} afterLine - Line number to insert after (0 = before first line)
 * @param {string} content - Content to insert
 * @returns {object} { success, insertedLines, totalLines }
 */
export function insertAtLine(afterLine, content) {
    if (!editorInstance) return { success: false, error: 'No editor instance' };
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    let insertPos;
    if (afterLine <= 0) {
        // Insert before first line
        insertPos = 0;
        content = content + '\n';
    } else if (afterLine >= totalLines) {
        // Insert after last line
        insertPos = doc.length;
        content = '\n' + content;
    } else {
        // Insert after specified line
        const line = doc.line(afterLine);
        insertPos = line.to;
        content = '\n' + content;
    }
    
    editorInstance.dispatch({
        changes: { from: insertPos, insert: content }
    });
    
    // Update state
    State.editorContent = editorInstance.state.doc.toString();
    State.editorDirty = true;
    
    const newTotalLines = editorInstance.state.doc.lines;
    const insertedLines = content.split('\n').length - 1; // -1 for the leading \n
    
    EventBus.emit('editor:linesInserted', {
        afterLine,
        insertedCount: insertedLines,
        totalLines: newTotalLines
    });
    
    return {
        success: true,
        insertedAfter: afterLine,
        insertedLines,
        newLineCount: insertedLines,
        totalLines: newTotalLines
    };
}

/**
 * Find and replace text in the editor buffer by exact string match.
 * Works at character offsets — no line numbers needed.
 *
 * @param {string} find - Exact text to find (must appear exactly once)
 * @param {string} replacement - Text to substitute (can be empty for delete)
 * @returns {object} { success, startLine, endLine, totalLines } or { error }
 */
export function replaceText(find, replacement) {
    if (!editorInstance) return { error: 'No editor instance' };
    if (!find) return { error: 'find text is required' };

    const doc = editorInstance.state.doc;
    const content = doc.toString();

    // Require unique match
    const firstIdx = content.indexOf(find);
    if (firstIdx === -1) {
        return { error: 'Text not found in file. Make sure you copied the exact text including whitespace and indentation.' };
    }
    const secondIdx = content.indexOf(find, firstIdx + 1);
    if (secondIdx !== -1) {
        // Count occurrences for a helpful message
        let count = 2;
        let pos = secondIdx;
        while ((pos = content.indexOf(find, pos + 1)) !== -1) count++;
        return { error: `Found ${count} matches — search text must be unique. Include more surrounding context to disambiguate.` };
    }

    const from = firstIdx;
    const to = firstIdx + find.length;

    // Record line positions before edit (for context)
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;

    editorInstance.dispatch({
        changes: { from, to, insert: replacement }
    });

    // Update state
    State.editorContent = editorInstance.state.doc.toString();
    State.editorDirty = true;

    const newDoc = editorInstance.state.doc;
    const newTotalLines = newDoc.lines;

    // Calculate what changed
    const oldLineCount = find.split('\n').length;
    const newLineCount = replacement.split('\n').length;
    const lineDelta = newLineCount - oldLineCount;

    EventBus.emit('editor:linesReplaced', {
        startLine,
        endLine,
        oldLineCount,
        newLineCount,
        totalLines: newTotalLines
    });

    return {
        success: true,
        startLine,
        endLine,
        oldLineCount,
        newLineCount,
        lineDelta,
        totalLines: newTotalLines
    };
}

/**
 * Delete a range of lines.
 * @param {number} startLine - 1-indexed start line (inclusive)
 * @param {number} endLine - 1-indexed end line (inclusive)
 * @returns {object} { success, deletedCount, totalLines }
 */
export function deleteRange(startLine, endLine) {
    if (!editorInstance) return { success: false, error: 'No editor instance' };
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    const clampedStart = Math.max(1, Math.min(startLine, totalLines));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));
    const deletedCount = clampedEnd - clampedStart + 1;
    
    const lineStart = doc.line(clampedStart);
    const lineEnd = doc.line(clampedEnd);
    
    // Calculate deletion range including the trailing newline
    let to = lineEnd.to;
    if (clampedEnd < totalLines) {
        to = doc.line(clampedEnd + 1).from;
    }
    
    editorInstance.dispatch({
        changes: { from: lineStart.from, to: to, insert: '' }
    });
    
    // Update state
    State.editorContent = editorInstance.state.doc.toString();
    State.editorDirty = true;
    
    const newTotalLines = editorInstance.state.doc.lines;
    
    EventBus.emit('editor:linesDeleted', {
        startLine,
        endLine: clampedEnd,
        deletedCount,
        totalLines: newTotalLines
    });
    
    return {
        success: true,
        deletedCount,
        totalLines: newTotalLines
    };
}

// ============================================
// APPLY LLM EDIT
// ============================================

export function applyEdit(newContent) {
    if (!editorInstance) return;
    
    const original = getContent();
    setContent(newContent, true);
    
    State.editorDirty = true;
    EventBus.emit('editor:editApplied', { original, updated: newContent });
}

// ============================================
// LINE NUMBER TOGGLE (CM6 Compartment)
// ============================================

export function setLineNumbersVisible(visible) {
    if (!editorInstance || !lineNumberCompartment || !CM.EditorView) {
        console.debug('[Editor] Cannot toggle line numbers — editor or compartment not ready');
        return false;
    }
    
    try {
        if (visible) {
            editorInstance.dispatch({
                effects: lineNumberCompartment.reconfigure([])
            });
        } else {
            editorInstance.dispatch({
                effects: lineNumberCompartment.reconfigure(
                    CM.EditorView.theme({
                        '.cm-lineNumbers': { display: 'none !important' },
                        '.cm-activeLineGutter': { display: 'none !important' },
                        '.cm-foldGutter': { display: 'none !important' },
                        '.cm-gutters': { 'border-right': 'none', 'min-width': '0' }
                    })
                )
            });
        }
        console.log(`[Editor] Line numbers ${visible ? 'shown' : 'hidden'} via compartment`);
        return true;
    } catch (e) {
        console.error('[Editor] Failed to toggle line numbers:', e);
        return false;
    }
}
