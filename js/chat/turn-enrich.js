/**
 * AI Editor — Turn metadata enrichment
 *
 * Enriches tool-result turns with the metadata required by the Compression
 * subsystem (Rules 1–2: Subsumption, Invalidation per docs/DESIGN-compression.md
 * §Core Contracts, lines 117–147).
 *
 * Pure: no imports from State, Storage, or any other side-effecting module.
 * Safe to run under `node --test`.
 *
 * Backwards-compat: tools not in the op-mapping table return `file_ops: []`.
 * Errored results (`result.error`) also return `[]` — per DESIGN-compression
 * §Rule 2: "A write that fails ... does not invalidate prior reads."
 */

import { WHOLE_FILE_WRITE_TOOLS } from './tool-classifications.js';

const READ_TOOLS = new Set([
    'read_current_file',
    'read_file',
    'read_lines',
    'read_function',
    'scan_file',
    'open_file',
    'read_plugin_source',
    'peek_project_file',
    'peek_read_lines',
]);

const EDIT_TOOLS = new Set([
    'replace_lines',
    'insert_lines',
    'delete_lines',
    'edit_file',
]);

// Reads whose result contains multiple paths (one FileOp each).
const MULTIPATH_READ_TOOLS = new Set([
    'find_references',
    'search_in_files',
]);

function _safeRange(start, end) {
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (start <= 0 || end <= 0) return null;
    return [start, end];
}

function _resolvePath(args, result) {
    return result?.path || args?.path || null;
}

function _multipath(result) {
    if (Array.isArray(result?.results)) {
        return [...new Set(result.results.map(r => r?.path).filter(Boolean))];
    }
    if (Array.isArray(result?.references)) {
        return [...new Set(result.references.map(r => r?.path || r?.file).filter(Boolean))];
    }
    return [];
}

function _editRange(toolName, args) {
    if (toolName === 'replace_lines' || toolName === 'delete_lines') {
        return _safeRange(args.start_line, args.end_line);
    }
    if (toolName === 'insert_lines') {
        const after = args.after_line;
        return typeof after === 'number' ? [after, after] : null;
    }
    if (toolName === 'edit_file') {
        if (args.operation === 'insert' && typeof args.after_line === 'number') {
            return [args.after_line, args.after_line];
        }
        return _safeRange(args.start_line, args.end_line);
    }
    return null;
}

function _readRange(toolName, args, result) {
    if (toolName === 'read_lines' || toolName === 'peek_read_lines') {
        return _safeRange(
            result?.start_line ?? args?.start_line,
            result?.end_line ?? args?.end_line
        );
    }
    if (toolName === 'read_function') {
        return _safeRange(result?.start_line, result?.end_line);
    }
    return null;
}

/**
 * Build FileOp[] for a tool invocation.
 *
 * @param {string} toolName - tool registry name
 * @param {object} args - parsed args (object, not JSON string)
 * @param {object} parsedResult - parsed tool result (object, not JSON string)
 * @returns {Array<{path: string, op: 'read'|'write'|'edit', range: [number, number]|null, content_hash: string|null}>}
 */
export function extractFileOps(toolName, args, parsedResult) {
    if (!toolName || !parsedResult || parsedResult.error) return [];

    const a = args || {};

    if (READ_TOOLS.has(toolName)) {
        const path = _resolvePath(a, parsedResult);
        if (!path) return [];
        return [{ path, op: 'read', range: _readRange(toolName, a, parsedResult), content_hash: null }];
    }

    if (MULTIPATH_READ_TOOLS.has(toolName)) {
        return _multipath(parsedResult).map(path => ({
            path, op: 'read', range: null, content_hash: null
        }));
    }

    if (EDIT_TOOLS.has(toolName)) {
        const path = _resolvePath(a, parsedResult);
        if (!path) return [];
        return [{ path, op: 'edit', range: _editRange(toolName, a), content_hash: null }];
    }

    if (WHOLE_FILE_WRITE_TOOLS.includes(toolName)) {
        const path = _resolvePath(a, parsedResult);
        if (!path) return [];
        return [{ path, op: 'write', range: null, content_hash: null }];
    }

    return [];
}

/**
 * Compose enriched fields onto a tool-result turn skeleton. Idempotent.
 *
 * @param {object} turnSkeleton - existing fields {tool_call_id, role:'tool', content, _display}
 * @param {string} toolName
 * @param {object} args - parsed args
 * @param {object} parsedResult - parsed tool result
 * @returns {object} new turn object with enrichment fields added
 */
export function enrichToolResultTurn(turnSkeleton, toolName, args, parsedResult) {
    return {
        ...turnSkeleton,
        tool_name: toolName,
        tool_args: args || {},
        tool_result_for: turnSkeleton.tool_call_id || null,
        file_ops: extractFileOps(toolName, args, parsedResult),
    };
}

/**
 * @typedef {Object} ReasoningBlock
 * @property {string|null} provider — the LLM provider that produced this reasoning
 * @property {'tag'|'native'|'channel'} format — 'tag' for &lt;think&gt;/&lt;thinking&gt;
 *   captured from streamed text; 'native' / 'channel' reserved for native
 *   reasoning APIs (OpenAI o1, Anthropic extended thinking) when added later.
 * @property {string} content — captured reasoning text, trimmed
 * @property {number|null} started_at — wall-clock ms at first reasoning chunk
 * @property {number|null} ended_at — wall-clock ms at last reasoning chunk
 */

/**
 * Compose enriched fields onto an assistant-turn skeleton. Idempotent.
 * Mirrors the read-path-only contract from 1.1.0: pre-1.3.1 turns persist
 * with `reasoning: undefined` and renderers/exporters treat absent ≡ no-bubble.
 *
 * @param {object} turnSkeleton - existing assistant turn fields
 * @param {{ reasoning?: ReasoningBlock|null }} extras
 * @returns {object} new turn object with reasoning merged when present
 */
export function enrichAssistantTurn(turnSkeleton, extras = {}) {
    const out = { ...turnSkeleton };
    if (extras.reasoning && extras.reasoning.content && extras.reasoning.content.length > 0) {
        out.reasoning = extras.reasoning;
    }
    return out;
}
