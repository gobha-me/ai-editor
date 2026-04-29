// @ts-check
/**
 * Turn store — converts the existing `ChatMessage` shape (per
 * `js/chat/summarizer.js`) into the canonical `Turn` struct that the
 * Compactor and rules consume.
 *
 * The compression layer never mutates source ChatMessages. Conversion is
 * one-way (`chatMessageToTurn`) and the round-trip back to ChatMessage[]
 * uses the cached `metadata.source_index` so the wrapper at
 * `js/chat/handlers.js` can preserve original references.
 *
 * Per `docs/DESIGN-compression.md` §"Turn Identity and Stability":
 *
 *   TurnID = hash(session_id || sequence_number || timestamp_ms)
 *
 * Phase 1 simplification: TurnID = `T${index}` per-call. Diagnostics are
 * scoped to a single `Compactor.compress()` invocation (the LLM debug
 * modal records per-exchange) so cross-call stability is not yet required.
 * Stable hash form lands when the turn store is persisted in 1.3.x or
 * later.
 *
 * @module intelligence/compression/turn-store
 */

import { estimateTokens } from './tokens.js';

/**
 * @typedef {import('./contracts.js').Turn}         Turn
 * @typedef {import('./contracts.js').TurnRole}     TurnRole
 * @typedef {import('./contracts.js').TurnID}       TurnID
 * @typedef {import('./contracts.js').TurnMetadata} TurnMetadata
 * @typedef {import('./contracts.js').FileOp}       FileOp
 */

/**
 * Phase-1 TurnID factory. Sequence-only. Deterministic per call, not
 * cross-call.
 *
 * @param {number} sequenceNumber  Position in the source history (0-based).
 * @returns {TurnID}
 */
export function makeTurnId(sequenceNumber) {
    return `T${sequenceNumber}`;
}

/**
 * Map a raw ChatMessage role to a canonical TurnRole.
 *
 * Existing chat history uses 5 roles: 'user' | 'assistant' | 'tool' |
 * 'system' | 'error'. The DESIGN canonical is 'user' | 'assistant' |
 * 'tool_call' | 'tool_result' | 'system'.
 *
 * Mapping rules:
 *   - 'tool'                                 → 'tool_result' (carries file_ops, tool_result_for)
 *   - 'assistant' with non-empty tool_calls  → 'assistant'   (with metadata.has_tool_calls=true)
 *   - 'assistant' (plain)                    → 'assistant'
 *   - 'error' (UI-only role)                 → 'system'
 *   - everything else                        → as-is
 *
 * Note: we keep `tool_call` distinct in the typedef but the existing chat
 * history doesn't represent tool_call as its own message — it's merged
 * into the assistant turn's `tool_calls[]` array. Rules 1 & 2 don't need
 * `tool_call` separation (they only inspect `tool_result` turns); the
 * distinction matters when Rule 3 (Consumption) lands in 1.2.2.
 *
 * @param {{role?: string, tool_calls?: Array<unknown>}} msg
 * @returns {TurnRole}
 */
function mapRole(msg) {
    const r = msg && typeof msg === 'object' ? msg.role : null;
    if (r === 'tool') return 'tool_result';
    if (r === 'error') return 'system';
    if (r === 'user' || r === 'assistant' || r === 'system') return r;
    return 'system'; // unknown roles default to system; preserve_recent will save them
}

/**
 * Convert one ChatMessage into a canonical Turn. Pure: no I/O, no clock
 * dependency unless the source lacks a timestamp.
 *
 * @param {Object} msg              Source ChatMessage.
 * @param {number} sequenceNumber   Position in the source array.
 * @returns {Turn}
 */
export function chatMessageToTurn(msg, sequenceNumber) {
    const m = msg && typeof msg === 'object' ? msg : {};
    const role = mapRole(m);
    const content = m.content == null ? '' : m.content;

    /** @type {TurnMetadata} */
    const metadata = {
        source_index: sequenceNumber,
        has_tool_calls: !!(Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
        file_ops: Array.isArray(m.file_ops) ? m.file_ops : [],
    };

    if (typeof m.tool_name === 'string') metadata.tool_name = m.tool_name;
    if (m.tool_args && typeof m.tool_args === 'object') metadata.tool_args = m.tool_args;
    if (m.tool_result_for !== undefined) metadata.tool_result_for = m.tool_result_for;
    if (typeof m.tool_call_id === 'string') metadata.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.superseded_by)) metadata.superseded_by = m.superseded_by;

    // Capture the call ids on assistant turns so the Compactor's tool-pair
    // coherence pass can match a Drop'd tool_result back to its caller.
    if (metadata.has_tool_calls && Array.isArray(m.tool_calls)) {
        const ids = m.tool_calls.map(tc => tc && (tc.id || (tc.function && tc.function.id))).filter(id => typeof id === 'string');
        if (ids.length > 0) metadata.tool_call_ids = ids;
    }

    return {
        id: makeTurnId(sequenceNumber),
        role,
        content,
        tokens: estimateTokens(content),
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : sequenceNumber,
        metadata,
    };
}

/**
 * Convert a full ChatMessage[] array into Turn[]. The output is
 * chronological and 1:1 with the input — no filtering happens here; the
 * Compactor's rule pipeline owns admissibility decisions.
 *
 * @param {Array<Object>} history
 * @returns {Turn[]}
 */
export function chatHistoryToTurns(history) {
    if (!Array.isArray(history)) return [];
    return history.map((m, i) => chatMessageToTurn(m, i));
}

/**
 * Round-trip helper — given a list of surviving turns and the original
 * ChatMessage[], return the corresponding ChatMessage subset preserving
 * the original references. Synthesized turns (created by Rule 4 markers
 * or Rule 5 summarization) carry no `metadata.source_index` and are
 * emitted as freshly constructed `system`-role messages.
 *
 * @param {Turn[]}        survivors
 * @param {Array<Object>} originalHistory
 * @returns {Array<Object>}
 */
export function turnsToChatMessages(survivors, originalHistory) {
    if (!Array.isArray(survivors)) return [];
    const orig = Array.isArray(originalHistory) ? originalHistory : [];
    /** @type {Array<Object>} */
    const out = [];
    for (const t of survivors) {
        const idx = t && t.metadata ? t.metadata.source_index : undefined;
        if (typeof idx === 'number' && idx >= 0 && idx < orig.length) {
            out.push(orig[idx]);
        } else {
            // Synthesized turn — emit a fresh ChatMessage. The marker
            // text lives in `t.content`.
            out.push({
                role: t && t.role === 'system' ? 'system' : 'system',
                content: t && t.content != null ? String(t.content) : '',
                _synthesized: true,
                _compressionReason: t && t.metadata && t.metadata.custom
                    ? t.metadata.custom.reason || null
                    : null,
            });
        }
    }
    return out;
}

/**
 * Build a synthesized marker Turn (used by Rule 4 Replace decisions and
 * by the Rule 5 summarizer wrapper). System role; no source_index.
 *
 * @param {string} content   Marker text or summary body.
 * @param {string} reason    Stored on `metadata.custom.reason` for diagnostics.
 * @param {number} timestamp
 * @returns {Turn}
 */
export function makeSynthesizedTurn(content, reason, timestamp) {
    return {
        id: makeTurnId(-1), // sentinel; synthesized turns share a placeholder id slot
        role: 'system',
        content,
        tokens: estimateTokens(content),
        timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
        metadata: {
            source_index: -1,
            file_ops: [],
            custom: { reason },
        },
    };
}
