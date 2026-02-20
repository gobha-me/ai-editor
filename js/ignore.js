// @ts-check
/**
 * Ignore Manager — Shared ignore-pattern engine.
 *
 * Gitignore-style syntax:
 *   # comment
 *   node_modules/      → directory match (anywhere in path)
 *   *.min.js           → glob on filename
 *   dist/              → directory
 *   !src/vendor/       → negation (un-ignore)
 *   *.lock             → extension glob
 *   package-lock.json  → exact filename
 *   build/*.js         → path glob
 *
 * Three layers (applied in order, last match wins):
 *   1. Built-in defaults (binary extensions, common junk dirs)
 *   2. Global user patterns (Settings → Ignore)
 *   3. Per-project .aieditorignore file
 *
 * Consumers call IgnoreManager.isIgnored(path) — returns true if the
 * file should be hidden from LLM tools (search, tree, scan, context).
 * Explicit read_file / open_file bypass this entirely.
 */

import { State, EventBus, Storage } from './core.js';

// ============================================
// BUILT-IN DEFAULTS
// ============================================

/**
 * Default ignore patterns — ships as the initial textarea value.
 * Users can edit/remove any of these.  Blank lines separate categories.
 */
export const DEFAULT_IGNORE_PATTERNS = `# ── Directories ──
node_modules/
vendor/
.git/
dist/
build/
__pycache__/
.venv/
.tox/
.mypy_cache/
.pytest_cache/
coverage/
.nyc_output/
.next/
.nuxt/
.svelte-kit/
swaggers/

# ── Binary / media ──
*.png
*.jpg
*.jpeg
*.gif
*.svg
*.ico
*.webp
*.bmp
*.tiff
*.woff
*.woff2
*.ttf
*.eot
*.otf
*.mp3
*.mp4
*.wav
*.ogg
*.webm
*.avi
*.mov
*.zip
*.tar
*.gz
*.bz2
*.rar
*.7z
*.wasm
*.pyc
*.pyo
*.class
*.o
*.so
*.dylib
*.dll
*.exe
*.pdf
*.doc
*.docx
*.xls
*.xlsx
*.ppt
*.pptx

# ── Data / blobs ──
*.sqlite
*.db
*.bin
*.dat

# ── Maps & minified ──
*.map
*.min.js
*.min.css
bundle.js
bundle.css

# ── Lockfiles ──
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml

# ── OpenAPI / Swagger specs ──
openapi.json
openapi.yaml
openapi.yml
swagger.json
swagger.yaml
swagger.yml
`;

// ============================================
// PATTERN COMPILER
// ============================================

/**
 * Compile a single gitignore-style pattern into a test function.
 * @param {string} raw — trimmed pattern line
 * @returns {{ test: (path: string) => boolean, negated: boolean } | null}
 */
function compilePattern(raw) {
    if (!raw || raw.startsWith('#')) return null;

    let negated = false;
    let pattern = raw;

    if (pattern.startsWith('!')) {
        negated = true;
        pattern = pattern.slice(1);
    }

    // Trailing slash means directory — match as path prefix
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);

    // Convert glob to regex
    let regex;
    try {
        regex = globToRegex(pattern, dirOnly);
    } catch {
        console.warn(`[Ignore] Invalid pattern: ${raw}`);
        return null;
    }

    return { test: (path) => regex.test(path), negated };
}

/**
 * Convert a gitignore glob pattern to a RegExp.
 * Supports: * (any non-slash), ** (any including slash), ? (single char).
 *
 * @param {string} glob
 * @param {boolean} dirOnly - Match as directory (anywhere in path)
 * @returns {RegExp}
 */
function globToRegex(glob, dirOnly) {
    // If pattern contains no slash, match against filename OR as directory segment
    const hasSlash = glob.includes('/');

    let src = '';
    let i = 0;
    while (i < glob.length) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                // ** matches everything including /
                src += '.*';
                i += 2;
                if (glob[i] === '/') i++; // skip trailing slash after **
                continue;
            }
            src += '[^/]*'; // * matches non-slash
        } else if (ch === '?') {
            src += '[^/]';
        } else if (ch === '.') {
            src += '\\.';
        } else if (ch === '+' || ch === '(' || ch === ')' || ch === '^' || ch === '$' || ch === '{' || ch === '}' || ch === '|' || ch === '[' || ch === ']' || ch === '\\') {
            src += '\\' + ch;
        } else {
            src += ch;
        }
        i++;
    }

    if (dirOnly) {
        // e.g. "node_modules" → match /node_modules/ anywhere or as leading segment
        if (hasSlash) {
            // "some/dir" → must appear as prefix
            return new RegExp(`(?:^|/)${src}(?:/|$)`);
        }
        return new RegExp(`(?:^|/)${src}(?:/|$)`);
    }

    if (hasSlash) {
        // Pattern with / — match against full path from root
        return new RegExp(`^${src}$`);
    }

    // No slash — match against basename only
    return new RegExp(`(?:^|/)${src}$`);
}

// ============================================
// IGNORE MANAGER
// ============================================

const IgnoreManager = {
    /** @type {Array<{ test: (path: string) => boolean, negated: boolean }>} */
    _compiled: [],

    /** @type {string} */
    _globalRaw: '',

    /** @type {string} */
    _projectRaw: '',

    /** Max file size (bytes) for tool operations. Separate from patterns. */
    MAX_FILE_SIZE: 250_000,

    /**
     * Initialize from saved settings. Call at app startup.
     */
    init() {
        const saved = State.settings.ignorePatterns;
        // First launch: use defaults. Subsequent: use whatever the user saved.
        this._globalRaw = (saved !== undefined && saved !== null) ? saved : DEFAULT_IGNORE_PATTERNS;
        this._projectRaw = '';
        this._recompile();

        // Listen for project loads to check for .aieditorignore
        EventBus.on('git:projectLoaded', () => this._loadProjectIgnore());

        // Clear project patterns when project is cleared
        EventBus.on('git:loading', () => {
            if (this._projectRaw) {
                this._projectRaw = '';
                this._recompile();
            }
        });
    },

    /**
     * Set global patterns from settings UI. Persists to State.settings.
     * @param {string} text — raw textarea content
     */
    setGlobalPatterns(text) {
        this._globalRaw = text;
        State.settings.ignorePatterns = text;
        this._recompile();
        EventBus.emit('ignore:changed');
    },

    /**
     * Get current global patterns text (for settings textarea).
     * @returns {string}
     */
    getGlobalPatterns() {
        return this._globalRaw;
    },

    /**
     * Get current project-level patterns (for display).
     * @returns {string}
     */
    getProjectPatterns() {
        return this._projectRaw;
    },

    /**
     * Check if a path should be ignored by LLM tools.
     * Does NOT apply to explicit read_file / open_file.
     *
     * @param {string} path - File path relative to repo root
     * @param {number} [size] - File size in bytes (0/undefined = unknown, allow)
     * @returns {boolean} true if the file should be excluded from tools
     */
    isIgnored(path, size) {
        // Size gate (independent of patterns)
        if (size && size > this.MAX_FILE_SIZE) return true;

        // Walk compiled rules — last match wins (gitignore semantics)
        let ignored = false;
        for (const rule of this._compiled) {
            if (rule.test(path)) {
                ignored = !rule.negated;
            }
        }
        return ignored;
    },

    /**
     * Recompile all patterns from global + project sources.
     */
    _recompile() {
        const lines = (this._globalRaw + '\n' + this._projectRaw)
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        this._compiled = [];
        for (const line of lines) {
            const rule = compilePattern(line);
            if (rule) this._compiled.push(rule);
        }
    },

    /**
     * Try to load .aieditorignore from the current project's file tree.
     */
    async _loadProjectIgnore() {
        try {
            if (!State.fileTree || !State.currentProject) return;

            const ignoreFile = State.fileTree.find(f =>
                f.type === 'file' && f.path === '.aieditorignore'
            );
            if (!ignoreFile) {
                if (this._projectRaw) {
                    this._projectRaw = '';
                    this._recompile();
                }
                return;
            }

            const { owner, repo } = State.currentProject;
            const branch = State.currentBranch || 'main';
            const { Git } = await import('./git.js');
            const data = await Git.getFile(owner, repo, '.aieditorignore', branch);
            if (data?.content) {
                this._projectRaw = data.content;
                this._recompile();
                console.log(`[Ignore] Loaded .aieditorignore (${this._projectRaw.split('\n').length} lines)`);
                EventBus.emit('ignore:changed');
            }
        } catch (err) {
            console.warn('[Ignore] Failed to load .aieditorignore:', err.message);
        }
    },

    /**
     * Reset global patterns to built-in defaults.
     */
    resetToDefaults() {
        this.setGlobalPatterns(DEFAULT_IGNORE_PATTERNS);
    },

    /**
     * Get stats about current ignore rules.
     * @returns {{ global: number, project: number, total: number }}
     */
    stats() {
        const globalCount = this._globalRaw.split('\n')
            .filter(l => l.trim() && !l.trim().startsWith('#')).length;
        const projectCount = this._projectRaw.split('\n')
            .filter(l => l.trim() && !l.trim().startsWith('#')).length;
        return {
            global: globalCount,
            project: projectCount,
            total: this._compiled.length
        };
    }
};

export { IgnoreManager };
