/**
 * AI Editor - LLM Module (barrel)
 *
 * Re-exports from sub-modules introduced in 0.9.13:
 *   llm/utils.js  — stripThinkBlocks, sanitizeMessages
 *   llm/debug.js  — LLMDebug ring-buffer logger
 *   llm/api.js    — LLM client, LLMTools, buildRequestBody, generate*
 *
 * Also re-exports prompt helpers from prompts.js (preserves legacy imports).
 *
 * All downstream imports (e.g. `import { LLM } from './llm.js'`)
 * continue to work unchanged.
 */

// Pure utilities
export { stripThinkBlocks, sanitizeMessages } from './llm/utils.js';

// Debug logger
export { LLMDebug } from './llm/debug.js';

// API client & high-level functions
export {
    LLM,
    LLMTools,
    buildRequestBody,
    generateEdit,
    generateCommitMessage,
    analyzeIssue
} from './llm/api.js';

// Prompt helpers (re-exported for backward compat — originally lived here)
export {
    EditorPrompts,
    buildSystemPrompt,
    getLanguageFromPath
} from './prompts.js';
