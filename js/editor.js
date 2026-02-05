/**
 * AI Editor - Editor Module
 * CodeMirror 6 integration and editor logic
 */

import { State, EventBus, Storage } from './core.js';
import { getLanguageFromPath } from './llm.js';

// ============================================
// CODEMIRROR IMPORTS (from CDN)
// ============================================

let EditorView, EditorState, basicSetup, keymap, javascript, python, go, rust, markdown, json, html, css, sql, xml;
let oneDark, indentWithTab, defaultKeymap, historyKeymap, history, indentOnInput;
let lineNumbers, highlightActiveLineGutter, highlightActiveLine, bracketMatching, foldGutter, lineWrapping;

// Language support mapping
const languageModules = {};

// ============================================
// EDITOR INSTANCE
// ============================================

let editorInstance = null;

// ============================================
// INITIALIZATION
// ============================================

async function loadCodeMirror() {
    // Try multiple CDNs in order of preference
    const CDN_PROVIDERS = [
        'https://cdn.jsdelivr.net/npm',
        'https://unpkg.com',
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
                cmLint
            ] = await Promise.all([
                import(`${CDN}/@codemirror/view@6`),
                import(`${CDN}/@codemirror/state@6`),
                import(`${CDN}/codemirror@6`),
                import(`${CDN}/@codemirror/commands@6`),
                import(`${CDN}/@codemirror/language@6`),
                import(`${CDN}/@codemirror/lint@6`)
            ]);

            EditorView = cmView.EditorView;
            EditorState = cmState.EditorState;
            basicSetup = cmBasicSetup.basicSetup;
            keymap = cmView.keymap;
            lineNumbers = cmView.lineNumbers;
            highlightActiveLineGutter = cmView.highlightActiveLineGutter;
            highlightActiveLine = cmView.highlightActiveLine;
            lineWrapping = cmView.lineWrapping;
            
            // Commands
            indentWithTab = cmCommands.indentWithTab;
            defaultKeymap = cmCommands.defaultKeymap;
            historyKeymap = cmCommands.historyKeymap;
            history = cmCommands.history;
            indentOnInput = cmLanguage.indentOnInput;
            bracketMatching = cmLanguage.bracketMatching;
            foldGutter = cmLanguage.foldGutter;

            // Theme
            const cmOneDark = await import(`${CDN}/@codemirror/theme-one-dark@6`);
            oneDark = cmOneDark.oneDark;

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

async function createEditor(options) {
    // Accept options object: { container, doc, filename }
    const { container, doc: content = '', filename = '' } = options;
    
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

    const languageExt = getLanguageExtension(filename);
    const extensions = [
        basicSetup,
        oneDark,
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of(update => {
            if (update.docChanged) {
                State.editorContent = update.state.doc.toString();
                State.editorDirty = true;
                EventBus.emit('editor:change', { content: State.editorContent });
            }
        }),
        lineWrapping,
        ...(Array.isArray(languageExt) ? languageExt : [languageExt])
    ];

    const state = EditorState.create({
        doc: content,
        extensions
    });

    editorInstance = new EditorView({
        state,
        parent: container
    });

    State.editorContent = content;
    State.editorDirty = false;

    EventBus.emit('editor:created', { filename });
    return editorInstance;
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
        'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'xml',
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
    editorInstance
};