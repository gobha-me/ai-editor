/**
 * AI Editor - Editor Module (barrel)
 *
 * Re-exports from sub-modules introduced in 0.9.13:
 *   editor/setup.js     — CodeMirror loading & language config
 *   editor/instance.js  — Editor creation & all operations
 *   editor/file-utils.js — isTextFile, getFileIcon
 *   editor/diff.js       — computeSimpleDiff, formatDiffForDisplay
 *
 * All downstream imports (e.g. `import { createEditor } from './editor.js'`)
 * continue to work unchanged.
 */

// Setup & loading
export { loadCodeMirror } from './editor/setup.js';

// Editor instance & operations
export {
    editorInstance,
    createEditor,
    setContent,
    getContent,
    getSelection,
    getCursorContext,
    replaceSelection,
    insertAtCursor,
    goToLine,
    selectRange,
    highlightRange,
    focus,
    applyEdit,
    setLineNumbersVisible,
    setKeybindingMode,
    // Section-based editing (for LLM tools)
    getLineInfo,
    getLineRange,
    replaceRange,
    insertAtLine,
    deleteRange,
    // Text-based editing (used by replaceText internal API)
    replaceText
} from './editor/instance.js';

// File utilities
export { isTextFile, isBinaryFile, looksLikeText, getFileIcon } from './editor/file-utils.js';

// Diff utilities
export { computeSimpleDiff, formatDiffForDisplay } from './editor/diff.js';