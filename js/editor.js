/**
 * AI Editor - Editor Module
 * CodeMirror 6 integration and editor logic
 */

import { State, EventBus, Storage } from './core.js';
import { getLanguageFromPath } from './llm.js';

// ============================================
// CODEMIRROR IMPORTS (vendor bundle or CDN fallback)
// ============================================

let EditorView, EditorState, Compartment, basicSetup, keymap, javascript, python, go, rust, markdown, json, html, css, sql, xml;
let oneDark, indentWithTab, defaultKeymap, historyKeymap, history, indentOnInput;
let lineNumbers, highlightActiveLineGutter, highlightActiveLine, bracketMatching, foldGutter, lineWrapping;
// Additional extensions for basicSetup fallback
let drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSelectionMatches;
let closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap;
let searchKeymap, highlightSpecialChars, foldKeymap;
let syntaxHighlighting, defaultHighlightStyle;

// Compartment for dynamic line number toggling (CM6 best practice)
let lineNumberCompartment = null;

// Language support mapping
const languageModules = {};

// ============================================
// EDITOR INSTANCE
// ============================================

let editorInstance = null;

// ============================================
// INITIALIZATION
// ============================================

/**
 * Load CodeMirror from local vendor bundle (built into Docker image).
 * Returns true if successful, false if bundle not found.
 */
async function loadFromVendorBundle() {
    // Resolve relative to <base href> so it works at any BASE_PATH
    const bundleUrl = new URL('vendor/codemirror-bundle.js', document.baseURI).href;
    const bundle = await import(bundleUrl);

    // Core modules
    const { cmView, cmState, cmBasicSetup, cmCommands, cmLanguage, cmLint, cmAutocomplete, cmSearch, cmOneDark } = bundle;

    EditorView = cmView.EditorView;
    EditorState = cmState.EditorState;
    Compartment = cmState.Compartment;
    keymap = cmView.keymap;
    lineNumbers = cmView.lineNumbers;
    highlightActiveLineGutter = cmView.highlightActiveLineGutter;
    highlightActiveLine = cmView.highlightActiveLine;
    lineWrapping = EditorView.lineWrapping;
    drawSelection = cmView.drawSelection;
    dropCursor = cmView.dropCursor;
    rectangularSelection = cmView.rectangularSelection;
    crosshairCursor = cmView.crosshairCursor;
    highlightSpecialChars = cmView.highlightSpecialChars;

    basicSetup = cmBasicSetup.basicSetup;

    indentWithTab = cmCommands.indentWithTab;
    defaultKeymap = cmCommands.defaultKeymap;
    historyKeymap = cmCommands.historyKeymap;
    history = cmCommands.history;

    indentOnInput = cmLanguage.indentOnInput;
    bracketMatching = cmLanguage.bracketMatching;
    foldGutter = cmLanguage.foldGutter;
    foldKeymap = cmLanguage.foldKeymap;
    syntaxHighlighting = cmLanguage.syntaxHighlighting;
    defaultHighlightStyle = cmLanguage.defaultHighlightStyle;

    closeBrackets = cmAutocomplete.closeBrackets;
    closeBracketsKeymap = cmAutocomplete.closeBracketsKeymap;
    autocompletion = cmAutocomplete.autocompletion;
    completionKeymap = cmAutocomplete.completionKeymap;

    highlightSelectionMatches = cmSearch.highlightSelectionMatches;
    searchKeymap = cmSearch.searchKeymap;

    oneDark = cmOneDark.oneDark;

    // Language modules
    languageModules.javascript = bundle.langJavascript;
    languageModules.python = bundle.langPython;
    languageModules.go = bundle.langGo;
    languageModules.rust = bundle.langRust;
    languageModules.markdown = bundle.langMarkdown;
    languageModules.json = bundle.langJson;
    languageModules.html = bundle.langHtml;
    languageModules.css = bundle.langCss;
    languageModules.sql = bundle.langSql;
    languageModules.xml = bundle.langXml;
    languageModules.cpp = bundle.langCpp;
    languageModules.java = bundle.langJava;
    languageModules.php = bundle.langPhp;

    return true;
}

async function loadCodeMirror() {
    // Try local vendor bundle first (air-gapped / Docker deployments)
    try {
        EventBus.emit('editor:loading', 'Loading CodeMirror from local vendor...');
        await loadFromVendorBundle();
        console.log('CodeMirror loaded from local vendor bundle');
        EventBus.emit('editor:loaded', 'CodeMirror loaded from local vendor');
        return true;
    } catch (e) {
        console.warn('Local vendor bundle not available, falling back to CDN:', e.message);
    }

    // Try multiple CDNs in order of preference
    const CDN_PROVIDERS = [
//        'https://cdn.jsdelivr.net/npm',
//        'https://unpkg.com',
        'https://esm.sh'
    ];

    for (const CDN of CDN_PROVIDERS) {
        try {
            EventBus.emit('editor:loading', `Loading CodeMirror from ${CDN}...`);
            console.log(`Attempting to load CodeMirror from: ${CDN}`);

            // Core modules
            const [
                cmView,
                cmState,
                cmBasicSetup,
                cmCommands,
                cmLanguage,
                cmLint,
                cmAutocomplete,
                cmSearch
            ] = await Promise.all([
                import(`${CDN}/@codemirror/view@6`),
                import(`${CDN}/@codemirror/state@6`),
                import(`${CDN}/codemirror@6`),
                import(`${CDN}/@codemirror/commands@6`),
                import(`${CDN}/@codemirror/language@6`),
                import(`${CDN}/@codemirror/lint@6`),
                import(`${CDN}/@codemirror/autocomplete@6`),
                import(`${CDN}/@codemirror/search@6`)
            ]);

            EditorView = cmView.EditorView;
            EditorState = cmState.EditorState;
            Compartment = cmState.Compartment;
            keymap = cmView?.keymap;
            lineNumbers = cmView?.lineNumbers;
            highlightActiveLineGutter = cmView?.highlightActiveLineGutter;
            highlightActiveLine = cmView?.highlightActiveLine;
            
            // lineWrapping is a static property of EditorView, NOT a module export
            lineWrapping = EditorView?.lineWrapping;

            // basicSetup: try named export, then default, then explicit sub-import
            basicSetup = cmBasicSetup?.basicSetup;
            if (!basicSetup) {
                basicSetup = cmBasicSetup?.default?.basicSetup;
            }
            if (!basicSetup) {
                try {
                    // Some esm.sh versions need the explicit sub-path
                    const setupModule = await import(`${CDN}/codemirror@6/dist/index.js`);
                    basicSetup = setupModule?.basicSetup;
                } catch (_) { /* will use fallback */ }
            }
            
            // Commands
            indentWithTab = cmCommands?.indentWithTab;
            defaultKeymap = cmCommands?.defaultKeymap;
            historyKeymap = cmCommands?.historyKeymap;
            history = cmCommands?.history;
            indentOnInput = cmLanguage?.indentOnInput;
            bracketMatching = cmLanguage?.bracketMatching;
            foldGutter = cmLanguage?.foldGutter;
            foldKeymap = cmLanguage?.foldKeymap;
            syntaxHighlighting = cmLanguage?.syntaxHighlighting;
            defaultHighlightStyle = cmLanguage?.defaultHighlightStyle;

            // View extensions for fallback basicSetup
            drawSelection = cmView?.drawSelection;
            dropCursor = cmView?.dropCursor;
            rectangularSelection = cmView?.rectangularSelection;
            crosshairCursor = cmView?.crosshairCursor;
            highlightSpecialChars = cmView?.highlightSpecialChars;

            // Autocomplete & bracket closing
            closeBrackets = cmAutocomplete?.closeBrackets;
            closeBracketsKeymap = cmAutocomplete?.closeBracketsKeymap;
            autocompletion = cmAutocomplete?.autocompletion;
            completionKeymap = cmAutocomplete?.completionKeymap;

            // Search & selection
            highlightSelectionMatches = cmSearch?.highlightSelectionMatches;
            searchKeymap = cmSearch?.searchKeymap;

            // Build fallback basicSetup from individual extensions if meta-package failed
            if (!basicSetup) {
                console.warn('[Editor] codemirror@6 basicSetup not available, building from individual extensions');
                const fallback = [];
                if (lineNumbers) fallback.push(lineNumbers());
                if (highlightActiveLineGutter) fallback.push(highlightActiveLineGutter());
                if (highlightSpecialChars) fallback.push(highlightSpecialChars());
                if (history) fallback.push(history());
                if (foldGutter) fallback.push(foldGutter());
                if (drawSelection) fallback.push(drawSelection());
                if (dropCursor) fallback.push(dropCursor());
                if (indentOnInput) fallback.push(indentOnInput());
                if (syntaxHighlighting && defaultHighlightStyle) {
                    fallback.push(syntaxHighlighting(defaultHighlightStyle, { fallback: true }));
                }
                if (bracketMatching) fallback.push(bracketMatching());
                if (closeBrackets) fallback.push(closeBrackets());
                if (autocompletion) fallback.push(autocompletion());
                if (rectangularSelection) fallback.push(rectangularSelection());
                if (crosshairCursor) fallback.push(crosshairCursor());
                if (highlightActiveLine) fallback.push(highlightActiveLine());
                if (highlightSelectionMatches) fallback.push(highlightSelectionMatches());
                // Keymaps
                const fallbackKeymaps = [];
                if (closeBracketsKeymap) fallbackKeymaps.push(...closeBracketsKeymap);
                if (defaultKeymap) fallbackKeymaps.push(...defaultKeymap);
                if (searchKeymap) fallbackKeymaps.push(...searchKeymap);
                if (historyKeymap) fallbackKeymaps.push(...historyKeymap);
                if (foldKeymap) fallbackKeymaps.push(...foldKeymap);
                if (completionKeymap) fallbackKeymaps.push(...completionKeymap);
                if (keymap && fallbackKeymaps.length > 0) {
                    fallback.push(keymap.of(fallbackKeymaps));
                }
                
                if (fallback.length > 0) {
                    basicSetup = fallback;
                    console.log(`[Editor] Built fallback basicSetup with ${fallback.length} extensions`);
                }
            }

            // Theme
            const cmOneDark = await import(`${CDN}/@codemirror/theme-one-dark@6`);
            oneDark = cmOneDark?.oneDark;

            // Log loaded modules for debugging
            console.log('CodeMirror modules loaded:', {
                EditorView: !!EditorView,
                EditorState: !!EditorState,
                basicSetup: !!basicSetup,
                basicSetupType: Array.isArray(basicSetup) ? `array[${basicSetup.length}]` : typeof basicSetup,
                keymap: !!keymap,
                lineWrapping: !!lineWrapping,
                bracketMatching: !!bracketMatching,
                autocompletion: !!autocompletion,
                searchKeymap: !!searchKeymap,
                oneDark: !!oneDark
            });

            // Load language modules
            await loadLanguages(CDN);

            console.log(`Successfully loaded CodeMirror from ${CDN}`);
            EventBus.emit('editor:loaded', `CodeMirror loaded from ${CDN}`);
            return true;

        } catch (error) {
            console.warn(`Failed to load from ${CDN}:`, error);
            // Continue to next CDN
        }
    }

    // All CDNs failed
    const error = new Error('Failed to load CodeMirror from all CDN providers');
    console.error('Failed to load CodeMirror:', error);
    EventBus.emit('editor:error', error);
    return false;
}

async function loadLanguages(CDN) {
    const langModules = {
        javascript: `${CDN}/@codemirror/lang-javascript@6`,
        python: `${CDN}/@codemirror/lang-python@6`,
        go: `${CDN}/@codemirror/lang-go@6`,
        rust: `${CDN}/@codemirror/lang-rust@6`,
        markdown: `${CDN}/@codemirror/lang-markdown@6`,
        json: `${CDN}/@codemirror/lang-json@6`,
        html: `${CDN}/@codemirror/lang-html@6`,
        css: `${CDN}/@codemirror/lang-css@6`,
        sql: `${CDN}/@codemirror/lang-sql@6`,
        xml: `${CDN}/@codemirror/lang-xml@6`,
        cpp: `${CDN}/@codemirror/lang-cpp@6`,
        java: `${CDN}/@codemirror/lang-java@6`,
        php: `${CDN}/@codemirror/lang-php@6`
    };

    // Load all language modules in parallel
    const entries = Object.entries(langModules);
    const results = await Promise.allSettled(
        entries.map(([name, url]) => import(url))
    );

    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            const [name] = entries[index];
            languageModules[name] = result.value;
            console.log(`Loaded language module: ${name}`);
        } else {
            console.warn(`Failed to load language: ${entries[index][0]}`, result.reason);
        }
    });
}

function getLanguageExtension(filename) {
    const lang = getLanguageFromPath(filename);
    
    const langMap = {
        'javascript': () => languageModules.javascript?.javascript(),
        'typescript': () => languageModules.javascript?.javascript({ typescript: true }),
        'jsx': () => languageModules.javascript?.javascript({ jsx: true }),
        'tsx': () => languageModules.javascript?.javascript({ jsx: true, typescript: true }),
        'python': () => languageModules.python?.python(),
        'go': () => languageModules.go?.go(),
        'rust': () => languageModules.rust?.rust(),
        'markdown': () => languageModules.markdown?.markdown(),
        'json': () => languageModules.json?.json(),
        'html': () => languageModules.html?.html(),
        'css': () => languageModules.css?.css(),
        'scss': () => languageModules.css?.css(),
        'sql': () => languageModules.sql?.sql(),
        'xml': () => languageModules.xml?.xml(),
        'cpp': () => languageModules.cpp?.cpp(),
        'c': () => languageModules.cpp?.cpp(),
        'java': () => languageModules.java?.java(),
        'php': () => languageModules.php?.php()
    };

    const getter = langMap[lang];
    if (getter) {
        try {
            const ext = getter();
            if (ext) return ext;
        } catch (e) {
            console.warn(`Language extension for ${lang} not available`);
        }
    }

    return [];
}

// ============================================
// EDITOR CREATION
// ============================================

async function createEditor(container, content, filename) {
    // Handle both options object (for future) and positional args (for backward compat)
    if (typeof container === 'object' && container !== null && !container.nodeType) {
        // Called with options object: createEditor({ container, doc, filename })
        const options = container;
        container = options.container;
        content = options.doc;
        filename = options.filename;
    }
    
    // Set defaults
    content = content || '';
    filename = filename || '';
    
    if (!EditorView) {
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
    // Clear container before creating new editor
    // This removes the "Welcome" message and any previous editor content
    if (container) {
        container.innerHTML = '';
    }


    // Get language extension - ensure it's always an array
    const languageExt = getLanguageExtension(filename);
    const languageExtensions = Array.isArray(languageExt) ? languageExt : (languageExt ? [languageExt] : []);

    // Build extensions array with defensive checks
    const extensions = [];
    
    // Create fresh compartment for line number visibility
    lineNumberCompartment = Compartment ? new Compartment() : null;
    
    // Add basicSetup if available (it's actually an array of extensions)
    if (Array.isArray(basicSetup)) {
        extensions.push(...basicSetup);
    } else if (basicSetup) {
        extensions.push(basicSetup);
    }
    
    // Add line number visibility compartment (uses CM6 theme override to hide)
    if (lineNumberCompartment) {
        const { State: AppState } = await import('./core.js');
        const showNumbers = AppState.settings.showLineNumbers !== false;
        if (showNumbers) {
            extensions.push(lineNumberCompartment.of([])); // no override — numbers visible
        } else {
            extensions.push(lineNumberCompartment.of(
                EditorView.theme({
                    '.cm-lineNumbers': { display: 'none !important' },
                    '.cm-activeLineGutter': { display: 'none !important' },
                    '.cm-foldGutter': { display: 'none !important' },
                    '.cm-gutters': { 'border-right': 'none', 'min-width': '0' }
                })
            ));
        }
    }
    
    // Add theme
    if (oneDark) extensions.push(oneDark);
    
    // Add keymaps with proper structure
    if (keymap && indentWithTab) {
        const keymapExtensions = [indentWithTab];
        if (Array.isArray(defaultKeymap)) keymapExtensions.push(...defaultKeymap);
        if (Array.isArray(historyKeymap)) keymapExtensions.push(...historyKeymap);
        extensions.push(keymap.of(keymapExtensions));
    }
    
    // Add update listener
    if (EditorView?.updateListener?.of) {
        extensions.push(EditorView.updateListener.of(update => {
            if (update.docChanged) {
                State.editorContent = update.state.doc.toString();
                State.editorDirty = true;
                EventBus.emit('editor:change', { content: State.editorContent });
            }
        }));
    }
    
    // Add line wrapping
    if (lineWrapping) extensions.push(lineWrapping);
    
    // Add language extensions
    extensions.push(...languageExtensions);

    // Debug log extensions
    console.log('Creating editor with extensions:', extensions.map(e => 
        e ? (e.constructor?.name || typeof e) : 'undefined'
    ));

    // Validate extensions before creating state
    const validExtensions = extensions.filter(ext => ext !== undefined && ext !== null);
    console.log(`Valid extensions count: ${validExtensions.length} / ${extensions.length}`);

    try {
        const state = EditorState.create({
            doc: content,
            extensions: validExtensions
        });

        editorInstance = new EditorView({
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

function setContent(content, preserveHistory = false) {
    if (!editorInstance) return;

    if (preserveHistory) {
        // Replace content while preserving undo history
        const transaction = editorInstance.state.update({
            changes: {
                from: 0,
                to: editorInstance.state.doc.length,
                insert: content
            }
        });
        editorInstance.dispatch(transaction);
    } else {
        // Full reset (new file)
        const state = EditorState.create({
            doc: content,
            extensions: editorInstance.state.facet(EditorState.facet) // Preserve extensions
        });
        editorInstance.setState(state);
    }

    State.editorContent = content;
}

function getContent() {
    if (!editorInstance) return State.editorContent;
    return editorInstance.state.doc.toString();
}

function getSelection() {
    if (!editorInstance) return null;
    
    const selection = editorInstance.state.selection.main;
    if (selection.empty) return null;
    
    return {
        from: selection.from,
        to: selection.to,
        text: editorInstance.state.sliceDoc(selection.from, selection.to)
    };
}

function replaceSelection(text) {
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

function insertAtCursor(text) {
    if (!editorInstance) return;
    
    const pos = editorInstance.state.selection.main.head;
    editorInstance.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length }
    });
}

function goToLine(line) {
    if (!editorInstance) return;
    
    const lineInfo = editorInstance.state.doc.line(Math.min(line, editorInstance.state.doc.lines));
    editorInstance.dispatch({
        selection: { anchor: lineInfo.from },
        scrollIntoView: true
    });
    editorInstance.focus();
}

function highlightRange(from, to) {
    if (!editorInstance) return;
    
    editorInstance.dispatch({
        selection: { anchor: from, head: to },
        scrollIntoView: true
    });
}

function focus() {
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
function getLineInfo(lineNum) {
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
 * Get the character position range for a line range.
 * @param {number} startLine - 1-indexed start line
 * @param {number} endLine - 1-indexed end line
 * @returns {object|null} { from, to, text } or null if invalid
 */
function getLineRange(startLine, endLine) {
    if (!editorInstance) return null;
    
    const doc = editorInstance.state.doc;
    if (startLine < 1 || endLine < startLine || startLine > doc.lines) return null;
    
    const clampedEnd = Math.min(endLine, doc.lines);
    const lineStart = doc.line(startLine);
    const lineEnd = doc.line(clampedEnd);
    
    return {
        from: lineStart.from,
        to: lineEnd.to,
        text: editorInstance.state.sliceDoc(lineStart.from, lineEnd.to)
    };
}

/**
 * Replace a range of lines with new content.
 * This is the core function that LLM tools use for section-based editing.
 * 
 * @param {number} startLine - 1-indexed line to start replacement (inclusive)
 * @param {number} endLine - 1-indexed line to end replacement (inclusive)
 * @param {string} newContent - New content to insert (can be multi-line)
 * @returns {object} { success, from, to, originalLineCount, newLineCount, lineDelta, totalLines, error }
 */
function replaceRange(startLine, endLine, newContent) {
    if (!editorInstance) {
        return { error: 'Editor not initialized' };
    }
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    // Validate line numbers
    if (startLine < 1 || endLine < startLine || startLine > totalLines) {
        return {
            error: `Invalid line range. File has ${totalLines} lines. Got start=${startLine}, end=${endLine}`
        };
    }
    
    // Clamp end line to file length
    const clampedEnd = Math.min(endLine, totalLines);
    
    // Get the range to replace
    const lineStart = doc.line(startLine);
    const lineEnd = doc.line(clampedEnd);
    const from = lineStart.from;
    const to = lineEnd.to;
    
    // Count original lines being replaced
    const originalLineCount = clampedEnd - startLine + 1;
    
    // In CM6, line(n).to is the offset BEFORE the newline separator.
    // The existing newline after the last replaced line is preserved.
    // If new_content ends with \n, that produces a double-newline (spurious blank line).
    // Strip it so the replacement joins cleanly with the preserved separator.
    let insertText = newContent;
    if (insertText.endsWith('\n') && clampedEnd < totalLines) {
        insertText = insertText.slice(0, -1);
    }
    
    // Count new lines (from actual inserted text for accurate reporting)
    const newLines = insertText.split('\n');
    const newLineCount = newLines.length;
    
    // Apply the replacement
    editorInstance.dispatch({
        changes: { from, to, insert: insertText }
    });
    
    // Update state
    State.editorContent = editorInstance.state.doc.toString();
    State.editorDirty = true;
    
    const newTotalLines = editorInstance.state.doc.lines;
    const lineDelta = newLineCount - originalLineCount;
    
    EventBus.emit('editor:rangeReplaced', {
        startLine,
        endLine: clampedEnd,
        originalLineCount,
        newLineCount,
        lineDelta,
        totalLines: newTotalLines
    });
    
    return {
        success: true,
        from,
        to,
        originalLineCount,
        newLineCount,
        lineDelta,
        totalLines: newTotalLines
    };
}

/**
 * Insert new lines at a specific position without replacing existing content.
 * 
 * @param {number} afterLine - Insert after this line (0 = beginning, 1-indexed)
 * @param {string} content - Content to insert (can be multi-line)
 * @returns {object} { success, insertedAfter, newLineCount, totalLines, error }
 */
function insertAtLine(afterLine, content) {
    if (!editorInstance) {
        return { error: 'Editor not initialized' };
    }
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    // Validate
    if (afterLine < 0 || afterLine > totalLines) {
        return {
            error: `Invalid line number. File has ${totalLines} lines. after_line must be 0-${totalLines}`
        };
    }
    
    // Determine insertion position
    let insertPos;
    if (afterLine === 0) {
        // Insert at beginning
        insertPos = 0;
    } else {
        const line = doc.line(afterLine);
        insertPos = line.to;
    }
    
    // FIX: Simplified and consistent newline handling
    // Normalize: strip trailing newline from content (we'll add separators explicitly)
    let insertContent = content.endsWith('\n') ? content.slice(0, -1) : content;
    
    if (afterLine === 0) {
        // Insert at beginning — append newline to separate from first line
        insertContent = insertContent + '\n';
    } else {
        // Insert after a line — prepend newline as separator
        insertContent = '\n' + insertContent;
    }
    
    // Count new lines from original content (before normalization)
    const newLines = content.split('\n');
    const newLineCount = newLines.length;
    
    // Apply the insertion
    editorInstance.dispatch({
        changes: { from: insertPos, insert: insertContent }
    });
    
    // Update state - force synchronization
    State.editorContent = editorInstance.state.doc.toString();
    State.editorDirty = true;
    
    const newTotalLines = editorInstance.state.doc.lines;
    
    EventBus.emit('editor:linesInserted', {
        afterLine,
        newLineCount,
        totalLines: newTotalLines
    });
    
    return {
        success: true,
        insertedAfter: afterLine,
        newLineCount,
        totalLines: newTotalLines
    };
}

/**
 * Delete a range of lines.
 * 
 * @param {number} startLine - 1-indexed line to start deletion (inclusive)
 * @param {number} endLine - 1-indexed line to end deletion (inclusive)
 * @returns {object} { success, deletedCount, totalLines, error }
 */
function deleteRange(startLine, endLine) {
    if (!editorInstance) {
        return { error: 'Editor not initialized' };
    }
    
    const doc = editorInstance.state.doc;
    const totalLines = doc.lines;
    
    // Validate
    if (startLine < 1 || endLine < startLine || startLine > totalLines) {
        return {
            error: `Invalid line range. File has ${totalLines} lines.`
        };
    }
    
    const clampedEnd = Math.min(endLine, totalLines);
    const deletedCount = clampedEnd - startLine + 1;
    
    // Get the range to delete
    const lineStart = doc.line(startLine);
    const lineEnd = doc.line(clampedEnd);
    
    // Include the newline after the last deleted line if not at EOF
    let to = lineEnd.to;
    if (clampedEnd < totalLines) {
        to = doc.line(clampedEnd + 1).from;
    }
    
    // Apply the deletion
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

function applyEdit(newContent) {
    if (!editorInstance) return;
    
    // Store original for potential undo
    const original = getContent();
    
    // Apply the new content, preserving undo history
    setContent(newContent, true);
    
    State.editorDirty = true;
    EventBus.emit('editor:editApplied', { original, updated: newContent });
}

// ============================================
// LINE NUMBER TOGGLE (CM6 Compartment)
// ============================================

function setLineNumbersVisible(visible) {
    if (!editorInstance || !lineNumberCompartment || !EditorView) {
        // Expected at startup before any file is opened — not an error
        console.debug('[Editor] Cannot toggle line numbers — editor or compartment not ready');
        return false;
    }
    
    try {
        if (visible) {
            // Remove override — basicSetup's lineNumbers become visible
            editorInstance.dispatch({
                effects: lineNumberCompartment.reconfigure([])
            });
        } else {
            // Add theme override to hide gutter elements
            editorInstance.dispatch({
                effects: lineNumberCompartment.reconfigure(
                    EditorView.theme({
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

// ============================================
// DIFF UTILITIES
// ============================================

function computeSimpleDiff(original, updated) {
    const originalLines = original.split('\n');
    const updatedLines = updated.split('\n');
    const diff = [];

    const maxLen = Math.max(originalLines.length, updatedLines.length);
    
    for (let i = 0; i < maxLen; i++) {
        const origLine = originalLines[i];
        const updLine = updatedLines[i];
        
        if (origLine === undefined) {
            diff.push({ type: 'add', line: i + 1, content: updLine });
        } else if (updLine === undefined) {
            diff.push({ type: 'remove', line: i + 1, content: origLine });
        } else if (origLine !== updLine) {
            diff.push({ type: 'change', line: i + 1, original: origLine, updated: updLine });
        }
    }

    return diff;
}

function formatDiffForDisplay(diff) {
    return diff.map(d => {
        switch (d.type) {
            case 'add':
                return `+ L${d.line}: ${d.content}`;
            case 'remove':
                return `- L${d.line}: ${d.content}`;
            case 'change':
                return `~ L${d.line}:\n  - ${d.original}\n  + ${d.updated}`;
            default:
                return '';
        }
    }).join('\n');
}

// ============================================
// FILE TYPE UTILITIES
// ============================================

function isTextFile(filename) {
    const textExtensions = [
        'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'xml', 'svg',
        'html', 'htm', 'css', 'scss', 'less', 'sass',
        'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
        'py', 'pyw', 'pyi',
        'go', 'mod', 'sum',
        'rs', 'toml',
        'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
        'java', 'kt', 'kts', 'scala',
        'rb', 'erb',
        'php', 'phtml',
        'sh', 'bash', 'zsh', 'fish',
        'ps1', 'psm1', 'psd1',
        'sql',
        'r', 'R',
        'swift',
        'lua',
        'vim', 'vimrc',
        'conf', 'cfg', 'ini', 'env',
        'gitignore', 'gitattributes', 'gitmodules',
        'dockerfile', 'dockerignore',
        'makefile', 'cmake',
        'license', 'readme', 'changelog', 'contributing',
        'editorconfig', 'eslintrc', 'prettierrc', 'babelrc'
    ];

    const ext = filename.split('.').pop().toLowerCase();
    const name = filename.toLowerCase();

    return textExtensions.includes(ext) || 
           textExtensions.includes(name) ||
           name.startsWith('.');  // Hidden config files
}

function getFileIcon(filename, isDir = false) {
    if (isDir) return '📁';

    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        // Code
        'js': '📜', 'jsx': '⚛️', 'ts': '📘', 'tsx': '⚛️',
        'py': '🐍', 'go': '🐹', 'rs': '🦀', 'rb': '💎',
        'java': '☕', 'kt': '🎯', 'swift': '🍎', 'c': '©️', 'cpp': '➕',
        'php': '🐘', 'cs': '#️⃣',
        // Web
        'html': '🌐', 'css': '🎨', 'scss': '🎨', 'less': '🎨',
        // Data
        'json': '📋', 'yaml': '📋', 'yml': '📋', 'xml': '📋', 'toml': '📋',
        // Docs
        'md': '📝', 'txt': '📄', 'pdf': '📕',
        // Config
        'env': '🔐', 'gitignore': '🚫', 'dockerfile': '🐳',
        // Other
        'sql': '🗃️', 'sh': '💻', 'bash': '💻'
    };

    return iconMap[ext] || '📄';
}

// ============================================
// EXPORTS
// ============================================

export {
    loadCodeMirror,
    createEditor,
    setContent,
    getContent,
    getSelection,
    replaceSelection,
    insertAtCursor,
    goToLine,
    highlightRange,
    focus,
    applyEdit,
    computeSimpleDiff,
    formatDiffForDisplay,
    isTextFile,
    getFileIcon,
    editorInstance,
    setLineNumbersVisible,
    // Section-based editing (for LLM tools)
    getLineInfo,
    getLineRange,
    replaceRange,
    insertAtLine,
    deleteRange
};
