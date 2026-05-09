// @ts-check
/**
 * Curated language → file-extension map for ingest ordering (2.4.0).
 *
 * Used by `ingest-ordering.js` to convert provider language stats
 * (GitHub `/repos/{o}/{r}/languages`, GitLab `/projects/:id/languages`,
 * Gitea same as GitHub) into a per-extension rank. Files whose
 * extension matches a high-weight language sort first; unknown
 * extensions sort to the end but are not dropped.
 *
 * Names mirror GitHub Linguist display names so the keys match raw
 * provider responses byte-for-byte. Extensions are lowercase with
 * leading dot. Bare-filename languages (Dockerfile, Makefile) carry
 * sentinel entries with empty-extension handling done at lookup time.
 *
 * Not Linguist itself — Linguist's YAML is ~14k lines and version-
 * coupled to a Ruby gem. This curated subset covers the languages
 * we observe in real repos plus the long tail of code-editor
 * staples. Adding an entry: one PR, one test (the safelist regression
 * in `tests/test-language-extensions.mjs`).
 *
 * @module intelligence/retrieval/language-extensions
 */

/**
 * @typedef {Object.<string, string[]>} LanguageExtensionMap
 */

/** @type {LanguageExtensionMap} */
export const LANGUAGE_EXTENSIONS = {
    // Web — frontend mainline
    'JavaScript': ['.js', '.mjs', '.cjs', '.jsx'],
    'TypeScript': ['.ts', '.tsx', '.mts', '.cts'],
    'HTML': ['.html', '.htm'],
    'CSS': ['.css'],
    'SCSS': ['.scss'],
    'Sass': ['.sass'],
    'Less': ['.less'],
    'Stylus': ['.styl'],
    'Vue': ['.vue'],
    'Svelte': ['.svelte'],
    'Astro': ['.astro'],

    // Systems / strongly-typed
    'Go': ['.go'],
    'Rust': ['.rs'],
    'C': ['.c', '.h'],
    'C++': ['.cpp', '.cxx', '.cc', '.hpp', '.hxx', '.hh', '.h++'],
    'C#': ['.cs', '.csx'],
    'Java': ['.java'],
    'Kotlin': ['.kt', '.kts'],
    'Scala': ['.scala', '.sc'],
    'Swift': ['.swift'],
    'Objective-C': ['.m', '.mm'],
    'D': ['.d'],
    'Zig': ['.zig'],
    'Nim': ['.nim'],
    'Crystal': ['.cr'],
    'Ada': ['.adb', '.ads'],
    'Pascal': ['.pas', '.pp'],
    'Fortran': ['.f', '.f90', '.f95', '.for'],
    'COBOL': ['.cob', '.cbl'],

    // Dynamic / scripting
    'Python': ['.py', '.pyi', '.pyw'],
    'Ruby': ['.rb', '.rake'],
    'PHP': ['.php', '.phtml'],
    'Perl': ['.pl', '.pm'],
    'Lua': ['.lua'],
    'R': ['.r'],
    'Julia': ['.jl'],
    'Tcl': ['.tcl'],
    'Groovy': ['.groovy', '.gradle'],
    'Dart': ['.dart'],
    'Elixir': ['.ex', '.exs'],
    'Erlang': ['.erl', '.hrl'],
    'Clojure': ['.clj', '.cljs', '.cljc', '.edn'],
    'Haskell': ['.hs', '.lhs'],
    'OCaml': ['.ml', '.mli'],
    'Reason': ['.re', '.rei'],
    'ReScript': ['.res', '.resi'],
    'F#': ['.fs', '.fsx', '.fsi'],
    'Visual Basic .NET': ['.vb'],
    'PowerShell': ['.ps1', '.psm1', '.psd1'],
    'Shell': ['.sh', '.bash', '.zsh', '.ksh'],
    'Fish': ['.fish'],
    'Lean': ['.lean'],

    // Data / config / docs
    'JSON': ['.json'],
    'YAML': ['.yaml', '.yml'],
    'TOML': ['.toml'],
    'XML': ['.xml', '.xsd', '.xsl'],
    'INI': ['.ini', '.cfg'],
    'Markdown': ['.md', '.markdown', '.mdx'],
    'AsciiDoc': ['.adoc', '.asc', '.asciidoc'],
    'reStructuredText': ['.rst', '.rest'],
    'TeX': ['.tex'],

    // Query / DSL
    'SQL': ['.sql'],
    'GraphQL': ['.graphql', '.gql'],
    'Solidity': ['.sol'],

    // Build / infra
    'Dockerfile': ['.dockerfile'],
    'Makefile': ['.mk'],
    'Starlark': ['.bzl', '.star'],
    'CMake': ['.cmake'],
    'HCL': ['.hcl', '.tf', '.tfvars'],
    'Nix': ['.nix'],

    // Editor / misc
    'Vim Script': ['.vim'],
    'Emacs Lisp': ['.el'],
    'Common Lisp': ['.lisp', '.cl', '.lsp'],
    'Scheme': ['.scm', '.ss'],
    'Racket': ['.rkt'],
    'Smalltalk': ['.st'],
    'Prolog': ['.prolog'],
    'Haxe': ['.hx'],
    'CoffeeScript': ['.coffee'],
    'LiveScript': ['.ls'],
    'Elm': ['.elm'],
    'PureScript': ['.purs'],
    'Idris': ['.idr'],
    'Agda': ['.agda'],
};

/**
 * Lookup canonical extensions for a language name. Unknown languages
 * return an empty array (callers must tolerate this — it's the path
 * the indexer falls into for languages not in our curated map).
 *
 * @param {string} language
 * @returns {string[]}
 */
export function extensionsFor(language) {
    if (typeof language !== 'string' || language.length === 0) return [];
    return LANGUAGE_EXTENSIONS[language] || [];
}

/**
 * Reverse map: extension → primary language name. Built once at module
 * load. If two languages claim the same extension (rare; curated map
 * doesn't have collisions today), the first one wins.
 *
 * @type {Map<string, string>}
 */
const EXTENSION_TO_LANGUAGE = (() => {
    const m = new Map();
    for (const [language, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
        for (const ext of exts) {
            if (!m.has(ext)) m.set(ext, language);
        }
    }
    return m;
})();

/**
 * Look up the primary language name for a file extension. Returns
 * `null` for unknown extensions.
 *
 * @param {string} extension - lowercase, leading dot (e.g. ".js")
 * @returns {string|null}
 */
export function languageForExtension(extension) {
    if (typeof extension !== 'string' || extension.length === 0) return null;
    return EXTENSION_TO_LANGUAGE.get(extension.toLowerCase()) || null;
}

/**
 * Convert a raw `{language: count}` map (bytes for GitHub/Gitea,
 * percentages for GitLab — both normalize the same way) into a
 * `LanguageEntry[]` sorted descending by weight. Used by Git
 * providers to convert API responses into the shape the retrieval
 * orchestrator consumes.
 *
 * Defensive against bad input: non-object / empty / all-zero maps
 * return `[]`. Negative or NaN counts are dropped.
 *
 * @param {Object.<string, number>|null|undefined} rawCounts
 * @returns {Array<{language: string, weight: number, extensions: string[]}>}
 */
export function buildLanguageEntries(rawCounts) {
    if (!rawCounts || typeof rawCounts !== 'object') return [];
    let total = 0;
    for (const v of Object.values(rawCounts)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) total += v;
    }
    if (total <= 0) return [];
    return Object.entries(rawCounts)
        .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)
        .map(([language, v]) => ({
            language,
            weight: v / total,
            extensions: extensionsFor(language),
        }))
        .sort((a, b) => b.weight - a.weight);
}

/**
 * Extract the lowercase extension (with leading dot) from a path.
 * Returns `''` for paths without an extension. Used by ingest ordering
 * and the extension-scan fallback.
 *
 * @param {string} path
 * @returns {string}
 */
export function extensionOf(path) {
    if (typeof path !== 'string') return '';
    const lastSlash = path.lastIndexOf('/');
    const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const lastDot = base.lastIndexOf('.');
    if (lastDot <= 0) return '';
    return base.slice(lastDot).toLowerCase();
}
