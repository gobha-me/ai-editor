/**
 * File Type Utilities
 * Pure functions for file type detection and icon mapping.
 * Extracted from editor.js in 0.9.13 — no external dependencies.
 */

// ============================================
// TEXT FILE DETECTION
// ============================================

export function isTextFile(filename) {
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
