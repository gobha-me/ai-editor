// ============================================
// CodeMirror Vendor Bundle Entry Point
// ============================================
// Built by esbuild during Docker image creation.
// Produces a single ESM file with all CodeMirror
// modules for air-gapped / offline deployments.
// ============================================

// Core
export * as cmView from '@codemirror/view';
export * as cmState from '@codemirror/state';
export * as cmBasicSetup from 'codemirror';
export * as cmCommands from '@codemirror/commands';
export * as cmLanguage from '@codemirror/language';
export * as cmLint from '@codemirror/lint';
export * as cmAutocomplete from '@codemirror/autocomplete';
export * as cmSearch from '@codemirror/search';

// Theme
export * as cmOneDark from '@codemirror/theme-one-dark';

// Language modules
export * as langJavascript from '@codemirror/lang-javascript';
export * as langPython from '@codemirror/lang-python';
export * as langGo from '@codemirror/lang-go';
export * as langRust from '@codemirror/lang-rust';
export * as langMarkdown from '@codemirror/lang-markdown';
export * as langJson from '@codemirror/lang-json';
export * as langHtml from '@codemirror/lang-html';
export * as langCss from '@codemirror/lang-css';
export * as langSql from '@codemirror/lang-sql';
export * as langXml from '@codemirror/lang-xml';
export * as langCpp from '@codemirror/lang-cpp';
export * as langJava from '@codemirror/lang-java';
export * as langPhp from '@codemirror/lang-php';
