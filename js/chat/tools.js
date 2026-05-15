/**
 * Tool Execution and Validation
 * Handles tool parameter validation, execution, and text-format parsing
 */

import { ToolRegistry } from '../tools/registry.js';

// Lazy reference to ErrorLogger (avoid circular imports)
let _errorLogger = null;
function getErrorLogger() {
    if (!_errorLogger && window.ErrorLogger) _errorLogger = window.ErrorLogger;
    return _errorLogger;
}

/**
 * Required parameters per tool — frozen, module-scope, exported for the
 * anti-regression test (`tests/test-chat-tool-name-literals.mjs`, 2.44.0.0).
 *
 * Each key MUST be a registered tool name (`js/tools/*.js#register('NAME', …)`).
 * The pinning test cross-references every key against the canonical set; a
 * tool rename in the registry surfaces here as a test failure instead of as
 * silent dead validation. Pre-2.44.0.0 this map lived inside
 * `validateToolParameters` as a function-local const, which made it
 * invisible to module-import-based tests — the audit-2026-Q2 inventory
 * §tools entry "Tool-name string-literals dotted around chat module"
 * called for either centralization or coverage; we ship coverage.
 *
 * Tools omitted here are validated through the registered handler's own
 * argument checks; the `null`-on-miss return below is the documented
 * "let it through" path.
 */
export const REQUIRED_TOOL_PARAMS = Object.freeze({
    'create_file': ['path', 'content'],
    'delete_file': ['path'],
    'replace_lines': ['start_line', 'end_line', 'new_content'],
    'insert_lines': ['after_line', 'content'],
    'delete_lines': ['start_line', 'end_line'],
    'read_file': ['path'],
    'open_file': ['path'],
    'read_lines': ['path', 'start_line', 'end_line'],
    'search_in_files': ['query'],
    'create_issue': ['title'],
    'update_issue': ['number'],
    'add_issue_comment': ['number', 'body'],
    'read_issue': ['number'],
    'read_pull_request': ['number'],
    'add_pr_review': ['number', 'body'],
    'scan_file': ['path'],
    'read_function': ['name', 'path'],
    'find_references': ['symbol'],
});

/**
 * Tool-agnostic alias map for common param-name near-misses (gitea#422).
 *
 * Models drawing on training-data priors call `read_lines` with `start`/`end`
 * (grep/slice convention) instead of `start_line`/`end_line`, or
 * `search_in_files` with `pattern` (grep convention) instead of `query`. Each
 * miss costs a round-trip even though the tool is correctly chosen. The fix
 * direction in the issue is "accept common aliases at the validator"; this
 * map is the implementation. Applied via `applyAliasesAndDefaults` before
 * `validateToolParameters` runs.
 *
 * Invariant — flat (tool-agnostic) is safe iff no tool has both an alias key
 * and its canonical target in its own required-params set. Pinned by
 * `tests/test-chat-tools-validation-aliases.mjs`.
 */
export const TOOL_PARAM_ALIASES = Object.freeze({
    start: 'start_line',
    end: 'end_line',
    startLine: 'start_line',
    endLine: 'end_line',
    pattern: 'query',
    text: 'query',
    file_path: 'path',
    filepath: 'path',
});

/**
 * Rewrite alias keys to canonical names. Pure; does not mutate input.
 *
 * Returns `{args, aliasesUsed}` so callers (and tests) can observe what got
 * rewritten. `aliasesUsed` entries are formatted `'<alias>→<canonical>'` for
 * logging; the empty array means no rewrite happened.
 *
 * If both an alias and its canonical name appear in the input, the canonical
 * wins and the alias is dropped (model already used the right name; treat
 * the alias as a stray).
 *
 * @param {Record<string, any>} args
 * @returns {{args: Record<string, any>, aliasesUsed: string[]}}
 */
export function applyAliasesAndDefaults(args) {
    if (!args || typeof args !== 'object') return { args: args || {}, aliasesUsed: [] };
    const out = {};
    const aliasesUsed = [];
    for (const key of Object.keys(args)) {
        const canonical = TOOL_PARAM_ALIASES[key];
        if (canonical && !(canonical in args)) {
            out[canonical] = args[key];
            aliasesUsed.push(`${key}→${canonical}`);
        } else if (canonical && canonical in args) {
            // Canonical already present; drop the stray alias. Don't log —
            // not a misuse, just a redundant key.
        } else {
            out[key] = args[key];
        }
    }
    return { args: out, aliasesUsed };
}

/**
 * Validate that required parameters are present and non-empty.
 * Prevents bugs where AI hits token limits and sends incomplete tool calls.
 */
export function validateToolParameters(toolName, args) {
    const required = REQUIRED_TOOL_PARAMS[toolName];
    if (!required) return null; // Unknown tool, let it through

    const missing = required.filter(param => {
        const value = args[param];
        // Check for undefined, null, or empty string
        return value === undefined || value === null || value === '';
    });

    if (missing.length > 0) {
        // Earlier wording blamed "AI response was truncated" — gitea#415
        // showed that hypothesis usually wrong (schema-inconsistency was
        // the actual cause; truncation hint misled the model into retry
        // loops). Plain "what's missing + which fields are required" lets
        // the caller act on `missingParams`/`providedArgs` directly.
        return {
            error: `Tool call validation failed for ${toolName}: missing required parameter(s): ${missing.join(', ')}. ` +
            `Required for ${toolName}: ${required.join(', ')}.`,
            missingParams: missing,
            providedArgs: args
        };
    }

    return null; // Validation passed
}

/**
 * Execute a tool call using the registry.
 *
 * When `profileName` is provided (2.49.0 — sub-agent dispatch), the
 * registry consults that profile for admission instead of the
 * conversation-bound one. Parent chat dispatch passes nothing → the
 * existing conversation-profile-bound path runs (byte-equivalent to
 * pre-2.49.0). Sub-agent runner (`js/chat/subagent-runner.js`) passes
 * the resolved sub-agent profile (defaults to `'subagent.v1'`).
 *
 * GUARANTEE: Always returns a non-null object that JSON.stringify produces a non-empty string.
 *
 * @param {{function?: {name?: string, arguments?: string}}} toolCall
 * @param {string|null} [profileName]
 */
export async function executeToolCall(toolCall, profileName = null) {
    const toolName = toolCall.function?.name || 'unknown';
    try {
        let args;
        try {
            args = JSON.parse(toolCall.function?.arguments || '{}');
        } catch (parseErr) {
            const msg = `Invalid JSON in tool arguments: ${(toolCall.function?.arguments || '').slice(0, 200)}`;
            _logToolError(toolName, null, msg);
            return { error: msg };
        }

        // Rewrite common alias keys before validation (gitea#422).
        // `start`→`start_line`, `pattern`→`query`, etc. Tool-agnostic; safe
        // by invariant (see TOOL_PARAM_ALIASES doc). Each rewrite is logged
        // once at INFO so a sweep of `[ToolValidation] aliased` lines shows
        // which priors keep biting.
        const { args: aliased, aliasesUsed } = applyAliasesAndDefaults(args);
        args = aliased;
        if (aliasesUsed.length > 0) {
            console.info(`[ToolValidation] aliased ${toolName}: ${aliasesUsed.join(', ')}`);
        }

        // Normalize file paths — LLMs often add leading slashes
        if (typeof args.path === 'string') {
            args.path = args.path.replace(/^\/+/, '');
        }

        // VALIDATE PARAMETERS BEFORE EXECUTION
        const validationError = validateToolParameters(toolName, args);
        if (validationError) {
            console.error(`[Tool Validation] ${toolName} failed:`, validationError);
            _logToolError(toolName, args, validationError.error);
            return validationError;
        }

        const result = profileName
            ? await ToolRegistry.executeWithProfile(toolName, args, profileName)
            : await ToolRegistry.execute(toolName, args);
        
        // Log any tool-level errors for debugging
        if (result?.error) {
            console.warn(`[Tool Error] ${toolName}:`, result.error);
            _logToolError(toolName, args, result.error);
        }
        
        return result;
    } catch (error) {
        // This should rarely fire since ToolRegistry.execute now catches internally,
        // but belt-and-suspenders for anything truly unexpected
        const msg = `Tool '${toolName}' crashed: ${error.message || String(error)}`;
        console.error(`[Tool Crash] ${toolName}:`, error);
        _logToolError(toolName, null, msg);
        return { error: msg };
    }
}

/**
 * Log a tool error to the ErrorLogger (visible in 🐛 panel)
 */
function _logToolError(toolName, args, message) {
    const logger = getErrorLogger();
    if (!logger) return;
    const argsStr = args ? JSON.stringify(args).substring(0, 200) : '';
    logger.logError('ERROR', `Tool ${toolName}: ${message}`, '', argsStr, 0, 0);
}

/**
 * Parse tool calls embedded as text in LLM content.
 *
 * IMPORTANT: This is a FALLBACK for APIs that don't return structured tool_calls.
 * Only called when result.toolCalls is empty.
 * Content MUST have think blocks stripped before calling this function.
 *
 * Returns { toolCalls: [], cleanContent: string }
 */
export function parseTextToolCalls(text) {
    if (!text) return { toolCalls: [], cleanContent: text };

    const toolCalls = [];
    let cleanContent = text;
    let match;

    // JSON in tags: <tool_call>{"name":"fn","arguments":{...}}</tool_call> or <function_call>
    const jsonToolPattern = /<(?:tool_call|function_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tool_call|function_call)>/gi;
    while ((match = jsonToolPattern.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: {
                    name: parsed.name || parsed.function?.name || '',
                    arguments: typeof parsed.arguments === 'string'
                    ? parsed.arguments
                    : JSON.stringify(parsed.arguments || parsed.parameters || {})
                }
            });
            cleanContent = cleanContent.replace(match[0], '');
        } catch (e) { /* invalid JSON, skip */ }
    }

    // Generic XML: <tool_call><name>fn</name><arguments>{...}</arguments></tool_call>
    const genericPattern = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/gi;
    while ((match = genericPattern.exec(text)) !== null) {
        toolCalls.push({
            id: `text_call_${toolCalls.length}`,
            type: 'function',
            function: { name: match[1].trim(), arguments: match[2].trim() }
        });
        cleanContent = cleanContent.replace(match[0], '');
    }

    return { toolCalls, cleanContent: cleanContent.trim() };
}
