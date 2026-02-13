/**
 * CodeMirror Setup
 * Loading from vendor bundle or CDN fallback, language configuration.
 * Extracted from editor.js in 0.9.13.
 *
 * Uses the CM namespace pattern — all CM module references live on the
 * exported `CM` object so that editor/instance.js can access them after
 * loading without tight coupling to the loading strategy.
 */

import { EventBus } from '../core.js';
import { getLanguageFromPath } from '../prompts.js';

// ============================================
// CODEMIRROR NAMESPACE
// ============================================
//
// All CodeMirror module references are stored here.
// Populated by loadFromVendorBundle() or the CDN fallback path.
// Consumed by editor/instance.js for editor creation and operations.

export const CM = {
    // Core
    EditorView: null,
    EditorState: null,
    Compartment: null,
    keymap: null,

    // View extensions
    lineNumbers: null,
    highlightActiveLineGutter: null,
    highlightActiveLine: null,
    lineWrapping: null,
    drawSelection: null,
    dropCursor: null,
    rectangularSelection: null,
    crosshairCursor: null,
    highlightSpecialChars: null,

    // Setup
    basicSetup: null,

    // Commands
    indentWithTab: null,
    defaultKeymap: null,
    historyKeymap: null,
    history: null,

    // Language support
    indentOnInput: null,
    bracketMatching: null,
    foldGutter: null,
    foldKeymap: null,
    syntaxHighlighting: null,
    defaultHighlightStyle: null,

    // Autocomplete
    closeBrackets: null,
    closeBracketsKeymap: null,
    autocompletion: null,
    completionKeymap: null,

    // Search
    highlightSelectionMatches: null,
    searchKeymap: null,

    // Gutter & state APIs (for blame gutter)
    gutter: null,
    GutterMarker: null,
    StateField: null,
    StateEffect: null,

    // Theme
    oneDark: null,

    // Language modules (populated by loadLanguages)
    languages: {}
};

// ============================================
// VENDOR BUNDLE LOADING
// ============================================

/**
 * Load CodeMirror from local vendor bundle (built into Docker image).
 * Returns true if successful, false if bundle not found.
 */
async function loadFromVendorBundle() {
    const bundleUrl = new URL('vendor/codemirror-bundle.js', document.baseURI).href;
    const bundle = await import(bundleUrl);

    const { cmView, cmState, cmBasicSetup, cmCommands, cmLanguage, cmLint, cmAutocomplete, cmSearch, cmOneDark } = bundle;

    CM.EditorView = cmView.EditorView;
    CM.EditorState = cmState.EditorState;
    CM.Compartment = cmState.Compartment;
    CM.keymap = cmView.keymap;
    CM.lineNumbers = cmView.lineNumbers;
    CM.highlightActiveLineGutter = cmView.highlightActiveLineGutter;
    CM.highlightActiveLine = cmView.highlightActiveLine;
    CM.lineWrapping = CM.EditorView.lineWrapping;
    CM.drawSelection = cmView.drawSelection;
    CM.dropCursor = cmView.dropCursor;
    CM.rectangularSelection = cmView.rectangularSelection;
    CM.crosshairCursor = cmView.crosshairCursor;
    CM.highlightSpecialChars = cmView.highlightSpecialChars;

    CM.basicSetup = cmBasicSetup.basicSetup;

    CM.indentWithTab = cmCommands.indentWithTab;
    CM.defaultKeymap = cmCommands.defaultKeymap;
    CM.historyKeymap = cmCommands.historyKeymap;
    CM.history = cmCommands.history;

    CM.indentOnInput = cmLanguage.indentOnInput;
    CM.bracketMatching = cmLanguage.bracketMatching;
    CM.foldGutter = cmLanguage.foldGutter;
    CM.foldKeymap = cmLanguage.foldKeymap;
    CM.syntaxHighlighting = cmLanguage.syntaxHighlighting;
    CM.defaultHighlightStyle = cmLanguage.defaultHighlightStyle;

    CM.closeBrackets = cmAutocomplete.closeBrackets;
    CM.closeBracketsKeymap = cmAutocomplete.closeBracketsKeymap;
    CM.autocompletion = cmAutocomplete.autocompletion;
    CM.completionKeymap = cmAutocomplete.completionKeymap;

    CM.highlightSelectionMatches = cmSearch.highlightSelectionMatches;
    CM.searchKeymap = cmSearch.searchKeymap;

    CM.oneDark = cmOneDark.oneDark;

    // Gutter & decoration APIs (for blame gutter extension)
    CM.gutter = cmView.gutter;
    CM.GutterMarker = cmView.GutterMarker;
    CM.StateField = cmState.StateField;
    CM.StateEffect = cmState.StateEffect;

    // Language modules
    CM.languages.javascript = bundle.langJavascript;
    CM.languages.python = bundle.langPython;
    CM.languages.go = bundle.langGo;
    CM.languages.rust = bundle.langRust;
    CM.languages.markdown = bundle.langMarkdown;
    CM.languages.json = bundle.langJson;
    CM.languages.html = bundle.langHtml;
    CM.languages.css = bundle.langCss;
    CM.languages.sql = bundle.langSql;
    CM.languages.xml = bundle.langXml;
    CM.languages.cpp = bundle.langCpp;
    CM.languages.java = bundle.langJava;
    CM.languages.php = bundle.langPhp;

    return true;
}

// ============================================
// CDN FALLBACK LOADING
// ============================================

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

    const entries = Object.entries(langModules);
    const results = await Promise.allSettled(
        entries.map(([name, url]) => import(url))
    );

    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            const [name] = entries[index];
            CM.languages[name] = result.value;
            console.log(`Loaded language module: ${name}`);
        } else {
            console.warn(`Failed to load language: ${entries[index][0]}`, result.reason);
        }
    });
}

// ============================================
// MAIN LOADER
// ============================================

export async function loadCodeMirror() {
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
        'https://esm.sh'
    ];

    for (const CDN of CDN_PROVIDERS) {
        try {
            EventBus.emit('editor:loading', `Loading CodeMirror from ${CDN}...`);
            console.log(`Attempting to load CodeMirror from: ${CDN}`);

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

            CM.EditorView = cmView.EditorView;
            CM.EditorState = cmState.EditorState;
            CM.Compartment = cmState.Compartment;
            CM.keymap = cmView?.keymap;
            CM.lineNumbers = cmView?.lineNumbers;
            CM.highlightActiveLineGutter = cmView?.highlightActiveLineGutter;
            CM.highlightActiveLine = cmView?.highlightActiveLine;
            CM.lineWrapping = CM.EditorView?.lineWrapping;

            CM.basicSetup = cmBasicSetup?.basicSetup;
            if (!CM.basicSetup) {
                CM.basicSetup = cmBasicSetup?.default?.basicSetup;
            }
            if (!CM.basicSetup) {
                try {
                    const setupModule = await import(`${CDN}/codemirror@6/dist/index.js`);
                    CM.basicSetup = setupModule?.basicSetup;
                } catch (_) { /* will use fallback */ }
            }
            
            CM.indentWithTab = cmCommands?.indentWithTab;
            CM.defaultKeymap = cmCommands?.defaultKeymap;
            CM.historyKeymap = cmCommands?.historyKeymap;
            CM.history = cmCommands?.history;
            CM.indentOnInput = cmLanguage?.indentOnInput;
            CM.bracketMatching = cmLanguage?.bracketMatching;
            CM.foldGutter = cmLanguage?.foldGutter;
            CM.foldKeymap = cmLanguage?.foldKeymap;
            CM.syntaxHighlighting = cmLanguage?.syntaxHighlighting;
            CM.defaultHighlightStyle = cmLanguage?.defaultHighlightStyle;

            CM.drawSelection = cmView?.drawSelection;
            CM.dropCursor = cmView?.dropCursor;
            CM.rectangularSelection = cmView?.rectangularSelection;
            CM.crosshairCursor = cmView?.crosshairCursor;
            CM.highlightSpecialChars = cmView?.highlightSpecialChars;

            CM.closeBrackets = cmAutocomplete?.closeBrackets;
            CM.closeBracketsKeymap = cmAutocomplete?.closeBracketsKeymap;
            CM.autocompletion = cmAutocomplete?.autocompletion;
            CM.completionKeymap = cmAutocomplete?.completionKeymap;

            CM.highlightSelectionMatches = cmSearch?.highlightSelectionMatches;
            CM.searchKeymap = cmSearch?.searchKeymap;

            // Build fallback basicSetup if meta-package failed
            if (!CM.basicSetup) {
                console.warn('[Editor] codemirror@6 basicSetup not available, building from individual extensions');
                const fallback = [];
                if (CM.lineNumbers) fallback.push(CM.lineNumbers());
                if (CM.highlightActiveLineGutter) fallback.push(CM.highlightActiveLineGutter());
                if (CM.highlightSpecialChars) fallback.push(CM.highlightSpecialChars());
                if (CM.history) fallback.push(CM.history());
                if (CM.foldGutter) fallback.push(CM.foldGutter());
                if (CM.drawSelection) fallback.push(CM.drawSelection());
                if (CM.dropCursor) fallback.push(CM.dropCursor());
                if (CM.indentOnInput) fallback.push(CM.indentOnInput());
                if (CM.syntaxHighlighting && CM.defaultHighlightStyle) {
                    fallback.push(CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }));
                }
                if (CM.bracketMatching) fallback.push(CM.bracketMatching());
                if (CM.closeBrackets) fallback.push(CM.closeBrackets());
                if (CM.autocompletion) fallback.push(CM.autocompletion());
                if (CM.rectangularSelection) fallback.push(CM.rectangularSelection());
                if (CM.crosshairCursor) fallback.push(CM.crosshairCursor());
                if (CM.highlightActiveLine) fallback.push(CM.highlightActiveLine());
                if (CM.highlightSelectionMatches) fallback.push(CM.highlightSelectionMatches());
                // Keymaps
                const fallbackKeymaps = [];
                if (CM.closeBracketsKeymap) fallbackKeymaps.push(...CM.closeBracketsKeymap);
                if (CM.defaultKeymap) fallbackKeymaps.push(...CM.defaultKeymap);
                if (CM.searchKeymap) fallbackKeymaps.push(...CM.searchKeymap);
                if (CM.historyKeymap) fallbackKeymaps.push(...CM.historyKeymap);
                if (CM.foldKeymap) fallbackKeymaps.push(...CM.foldKeymap);
                if (CM.completionKeymap) fallbackKeymaps.push(...CM.completionKeymap);
                if (CM.keymap && fallbackKeymaps.length > 0) {
                    fallback.push(CM.keymap.of(fallbackKeymaps));
                }
                
                if (fallback.length > 0) {
                    CM.basicSetup = fallback;
                    console.log(`[Editor] Built fallback basicSetup with ${fallback.length} extensions`);
                }
            }

            // Theme
            const cmOneDark = await import(`${CDN}/@codemirror/theme-one-dark@6`);
            CM.oneDark = cmOneDark?.oneDark;

            // Gutter & decoration APIs (for blame gutter extension)
            CM.gutter = cmView?.gutter;
            CM.GutterMarker = cmView?.GutterMarker;
            CM.StateField = cmState?.StateField;
            CM.StateEffect = cmState?.StateEffect;

            console.log('CodeMirror modules loaded:', {
                EditorView: !!CM.EditorView,
                EditorState: !!CM.EditorState,
                basicSetup: !!CM.basicSetup,
                basicSetupType: Array.isArray(CM.basicSetup) ? `array[${CM.basicSetup.length}]` : typeof CM.basicSetup,
                keymap: !!CM.keymap,
                lineWrapping: !!CM.lineWrapping,
                bracketMatching: !!CM.bracketMatching,
                autocompletion: !!CM.autocompletion,
                searchKeymap: !!CM.searchKeymap,
                oneDark: !!CM.oneDark
            });

            await loadLanguages(CDN);

            console.log(`Successfully loaded CodeMirror from ${CDN}`);
            EventBus.emit('editor:loaded', `CodeMirror loaded from ${CDN}`);
            return true;

        } catch (error) {
            console.warn(`Failed to load from ${CDN}:`, error);
        }
    }

    const error = new Error('Failed to load CodeMirror from all CDN providers');
    console.error('Failed to load CodeMirror:', error);
    EventBus.emit('editor:error', error);
    return false;
}

// ============================================
// LANGUAGE EXTENSION RESOLVER
// ============================================

export function getLanguageExtension(filename) {
    const lang = getLanguageFromPath(filename);
    
    const langMap = {
        'javascript': () => CM.languages.javascript?.javascript(),
        'typescript': () => CM.languages.javascript?.javascript({ typescript: true }),
        'jsx': () => CM.languages.javascript?.javascript({ jsx: true }),
        'tsx': () => CM.languages.javascript?.javascript({ jsx: true, typescript: true }),
        'python': () => CM.languages.python?.python(),
        'go': () => CM.languages.go?.go(),
        'rust': () => CM.languages.rust?.rust(),
        'markdown': () => CM.languages.markdown?.markdown(),
        'json': () => CM.languages.json?.json(),
        'html': () => CM.languages.html?.html(),
        'css': () => CM.languages.css?.css(),
        'scss': () => CM.languages.css?.css(),
        'sql': () => CM.languages.sql?.sql(),
        'xml': () => CM.languages.xml?.xml(),
        'cpp': () => CM.languages.cpp?.cpp(),
        'c': () => CM.languages.cpp?.cpp(),
        'java': () => CM.languages.java?.java(),
        'php': () => CM.languages.php?.php()
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
