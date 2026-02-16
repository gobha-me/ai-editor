/**
 * File Type Utilities
 * Pure functions for file type detection and icon mapping.
 * Extracted from editor.js in 0.9.13 — no external dependencies.
 *
 * 0.9.x  — Added isBinaryFile() denylist + looksLikeText() content sniffer
 *           so files with non-standard extensions can be opened for editing.
 */

// ============================================
// KNOWN TEXT EXTENSIONS (allowlist)
// Used by zip-upload for auto-select heuristic.
// ============================================

const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'json5', 'jsonc', 'jsonl',
    'yaml', 'yml', 'toml', 'xml', 'svg', 'csv', 'tsv',
    'html', 'htm', 'xhtml', 'css', 'scss', 'less', 'sass', 'styl',
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
    'py', 'pyw', 'pyi', 'pyx',
    'go', 'mod', 'sum',
    'rs', 'rlib',
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'hh',
    'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
    'rb', 'erb', 'rake', 'gemspec',
    'php', 'phtml',
    'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh',
    'ps1', 'psm1', 'psd1',
    'sql', 'mysql', 'pgsql', 'plsql',
    'r',
    'swift',
    'lua',
    'pl', 'pm', 'pod', 't',
    'ex', 'exs', 'erl', 'hrl',
    'hs', 'lhs', 'cabal',
    'ml', 'mli', 'fs', 'fsx', 'fsi',
    'clj', 'cljs', 'cljc', 'edn',
    'dart', 'nim', 'zig', 'v', 'vala',
    'tf', 'tfvars', 'hcl',
    'proto', 'thrift', 'avsc',
    'graphql', 'gql',
    'vim', 'vimrc', 'nvim',
    'el', 'lisp', 'scm', 'rkt',
    'asm', 's', 'S',
    'bat', 'cmd',
    'diff', 'patch',
    'tpl', 'tmpl', 'j2', 'jinja', 'jinja2', 'mustache', 'hbs',
    'tex', 'bib', 'sty', 'cls',
    'rst', 'adoc', 'asciidoc', 'org', 'textile', 'wiki',
    'conf', 'cfg', 'ini', 'env', 'properties', 'prop',
    'gitignore', 'gitattributes', 'gitmodules', 'gitconfig',
    'hgignore', 'hgrc',
    'dockerfile', 'dockerignore', 'containerfile',
    'makefile', 'cmake', 'mk', 'mak',
    'license', 'readme', 'changelog', 'contributing', 'authors',
    'editorconfig', 'eslintrc', 'prettierrc', 'babelrc',
    'htaccess', 'nginx', 'caddyfile',
    'service', 'timer', 'socket', 'mount',    // systemd units
    'desktop', 'reg',
    'spec', 'rules',
    'nix', 'dhall',
    'prisma', 'sol',
]);

// Well-known extensionless filenames that are always text
const TEXT_FILENAMES = new Set([
    'makefile', 'dockerfile', 'containerfile', 'vagrantfile', 'gemfile',
    'rakefile', 'procfile', 'brewfile', 'justfile', 'taskfile',
    'caddyfile', 'tiltfile', 'earthfile', 'snakefile', 'steepfile',
    'cmakelists.txt', 'go.sum', 'go.mod',
    'license', 'licence', 'readme', 'changelog', 'contributing',
    'authors', 'patents', 'notice', 'version', 'maintainers',
    '.gitignore', '.gitattributes', '.gitmodules', '.gitconfig',
    '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc',
    '.babelrc', '.npmrc', '.nvmrc', '.node-version', '.python-version',
    '.ruby-version', '.tool-versions', '.env', '.env.local',
    '.env.development', '.env.production', '.env.test',
    '.htaccess', '.browserslistrc', '.stylelintrc',
    '.flake8', '.pylintrc', '.clang-format', '.clang-tidy',
    '.rustfmt.toml', '.cargo/config',
]);

/**
 * Returns true if the filename is a *known* text file by extension/name.
 * Used by zip-upload for auto-select heuristic.
 */
export function isTextFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const name = filename.toLowerCase();
    const basename = name.split('/').pop();

    return TEXT_EXTENSIONS.has(ext)
        || TEXT_FILENAMES.has(basename)
        || name.startsWith('.');   // Hidden config files (dotfiles)
}

// ============================================
// KNOWN BINARY EXTENSIONS (denylist)
// If it's in here, never attempt to open it.
// ============================================

const BINARY_EXTENSIONS = new Set([
    // Images
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'tif',
    'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'heic', 'heif', 'avif',
    // Fonts
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    // Audio
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus',
    // Video
    'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg',
    // Archives
    'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'zst', 'lz4', 'lzma',
    'tgz', 'tbz2', 'deb', 'rpm', 'dmg', 'iso', 'img', 'apk', 'ipa',
    // Compiled / binary
    'wasm', 'pyc', 'pyo', 'class', 'o', 'obj', 'so', 'dylib', 'dll',
    'exe', 'com', 'msi', 'elf', 'a', 'lib',
    // Data blobs
    'sqlite', 'sqlite3', 'db', 'bin', 'dat', 'pkl', 'pickle',
    'npy', 'npz', 'h5', 'hdf5', 'parquet', 'arrow', 'feather',
    'pb', 'onnx', 'pt', 'pth', 'safetensors',
    // Office / PDF (binary formats)
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'odt', 'ods', 'odp',
    // Source maps (huge, not useful to edit)
    'map',
]);

/**
 * Returns true if the filename is a *known* binary file.
 * Used by file-tree to gate file opening — unknown extensions are ALLOWED
 * (optimistic: try to open, sniff content).
 */
export function isBinaryFile(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const name = filename.toLowerCase();
    const basename = name.split('/').pop();

    // No extension and not a known text filename — can't tell from name alone,
    // let it through (content sniffing will catch true binary).
    if (!filename.includes('.') && !TEXT_FILENAMES.has(basename)) {
        return false;
    }

    return BINARY_EXTENSIONS.has(ext);
}

/**
 * Sniff content string to detect likely binary data.
 * Call AFTER fetching content for files with unknown extensions.
 * Returns true if the content appears to be text.
 *
 * Heuristic: check first 8KB for null bytes or excessive control chars.
 * Gitea/GitHub return base64-decoded UTF-8, so true binary will have
 * replacement chars (U+FFFD) or null bytes after decoding.
 */
export function looksLikeText(content) {
    if (!content || content.length === 0) return true; // empty file is text

    const sample = content.slice(0, 8192);
    let controlCount = 0;

    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        // Null byte — almost certainly binary
        if (code === 0) return false;
        // U+FFFD replacement character (from bad UTF-8 decode)
        if (code === 0xFFFD) return false;
        // Count non-whitespace control chars (except tab, newline, carriage return)
        if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            controlCount++;
        }
    }

    // If > 5% control characters, probably binary
    return (controlCount / sample.length) < 0.05;
}

// ============================================
// FILE ICON MAPPING
// ============================================

export function getFileIcon(filename, isDir = false) {
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