// @ts-check
/**
 * Conversation chunker — one chunk per turn, never split, no overlap.
 * Implements the conversation row of
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Chunker"
 * and the design's note "On the conversation chunker": metadata.custom is
 * the extensibility seam for surface-specific fields (speaker_id,
 * persona_id, tool_name, tool_result_for, file_ops…). The chunker itself
 * does not interpret these fields; it just preserves them.
 *
 * Pure function: `(input) → Chunk[]`. No I/O, no async, no external state.
 * Mirrors the contract pinned by [prose-chunker.js](./prose-chunker.js) at
 * 1.4.10 and [code-chunker.js](./code-chunker.js) at 1.4.11 — same
 * `ChunkerInput` → `Chunk[]` shape, same `byte_range`-as-UTF-8-bytes
 * invariant — but with a degenerate boundary rule (1 turn = 1 chunk).
 *
 * Input format. `ChunkerInput.bytes` carries a JSON-serialized
 * [HistoryTurn](../contracts.js)`[]`. The chunker parses, validates the
 * array shape and per-turn `role`+`content` invariants, and emits one
 * Chunk per turn. The contract's `bytes: string` shape is preserved — no
 * per-content-type discriminated union sprawl in `ChunkerInput`.
 *
 * Why JSON over `bytes`. The alternative — a sibling `turns` field on
 * `ChunkerInput` — was considered and rejected: it forks the contract for
 * one chunker, while every other chunker (prose, code, structured, spec)
 * works fine with opaque bytes.
 *
 * Byte-range semantics. Conversation byte_ranges are computed over the
 * concatenation of canonical per-turn serializations (`JSON.stringify
 * (turn_i)`), not over `input.bytes`. This decouples ChunkID stability
 * from caller serialization choices: the same logical conversation
 * produces identical ChunkIDs regardless of whether the caller pretty-
 * printed the JSON envelope. Adjacency holds: `chunks[i+1].byte_range[0]
 * === chunks[i].byte_range[1]`.
 *
 * @module intelligence/retrieval/chunkers/conversation-chunker
 */

import { computeChunkID } from '../chunk-id.js';
import { CHUNKER_VERSION } from '../contracts.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a string, returned as 8-char lowercase hex. Used for
 * `Metadata.content_hash` per chunk. Duplicated from prose / code chunkers
 * intentionally per the precedent set by 1.4.11 — extracting shared
 * helpers risks shifting prose byte-ranges in a conversation-chunker PR.
 *
 * @param {string} s
 * @returns {string}
 */
function fnv1aHex(s) {
    let h = FNV_OFFSET_BASIS;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i) & 0xff;
        h = Math.imul(h, FNV_PRIME);
        const high = s.charCodeAt(i) >> 8;
        if (high) {
            h ^= high;
            h = Math.imul(h, FNV_PRIME);
        }
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * UTF-8 byte length of a JS string. Counts surrogate pairs as 4 bytes
 * (the BMP-supplementary case) and BMP characters as 1/2/3 bytes per the
 * standard mapping. Avoids `TextEncoder` so the chunker stays
 * synchronous and free of platform feature-detection.
 *
 * @param {string} s
 * @returns {number}
 */
function utf8ByteLength(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) {
            n += 1;
        } else if (c < 0x800) {
            n += 2;
        } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            n += 4;
            i += 1;
        } else {
            n += 3;
        }
    }
    return n;
}

/**
 * Parse and validate the input bytes as a JSON-serialized HistoryTurn[].
 * Throws on malformed JSON, non-array root, or any turn missing `role` /
 * `content` (or with non-string types). Validation at the contract
 * boundary mirrors the prose / code chunkers' "invalid input is a
 * programmer error" stance.
 *
 * @param {string} bytes
 * @returns {Array<Object>}
 */
function parseTurns(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(bytes);
    } catch (e) {
        throw new TypeError(`chunkConversation: input.bytes must be valid JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new TypeError('chunkConversation: input.bytes must JSON-decode to an array of turns');
    }
    for (let i = 0; i < parsed.length; i++) {
        const t = parsed[i];
        if (t == null || typeof t !== 'object' || Array.isArray(t)) {
            throw new TypeError(`chunkConversation: turn at index ${i} is not an object`);
        }
        if (typeof t.role !== 'string' || t.role.length === 0) {
            throw new TypeError(`chunkConversation: turn at index ${i} is missing string 'role'`);
        }
        if (typeof t.content !== 'string') {
            throw new TypeError(`chunkConversation: turn at index ${i} is missing string 'content'`);
        }
    }
    return parsed;
}

/**
 * Build the metadata.custom payload for a turn. Carries `role`,
 * `turn_index`, and any non-(role|content) keys from the source turn.
 * If the turn has a `metadata` sub-object (per the
 * [HistoryTurn](../contracts.js) typedef), its keys are merged in;
 * top-level extras (e.g. `timestamp`, `tool_calls`) are also merged so
 * surfaces using flat-shape turns (per `js/chat/messages.js`) round-trip
 * cleanly. Caller-supplied `metadata.custom` from the
 * [ChunkerInput](../contracts.js) takes precedence over per-turn extras
 * on key conflict — the input-level custom is the loader's per-source
 * tagging, the turn-level extras are the conversation's payload.
 *
 * @param {Object} turn
 * @param {number} turn_index
 * @param {Object<string, *>} inputCustom
 * @returns {Object<string, *>}
 */
function buildTurnCustom(turn, turn_index, inputCustom) {
    const merged = {};
    for (const key of Object.keys(turn)) {
        if (key === 'role' || key === 'content' || key === 'metadata') continue;
        merged[key] = turn[key];
    }
    if (turn.metadata != null && typeof turn.metadata === 'object' && !Array.isArray(turn.metadata)) {
        for (const key of Object.keys(turn.metadata)) {
            merged[key] = turn.metadata[key];
        }
    }
    merged.role = turn.role;
    merged.turn_index = turn_index;
    for (const key of Object.keys(inputCustom)) {
        merged[key] = inputCustom[key];
    }
    return merged;
}

/**
 * Chunk a conversation into one Chunk per turn.
 *
 * @param {import('../contracts.js').ChunkerInput} input
 * @returns {import('../contracts.js').Chunk[]}
 */
export function chunkConversation(input) {
    if (input == null) {
        throw new TypeError('chunkConversation: input is required');
    }
    const { bytes, collection, metadata } = input;
    if (typeof bytes !== 'string') {
        throw new TypeError('chunkConversation: input.bytes must be a string');
    }
    if (typeof collection !== 'string' || collection.length === 0) {
        throw new TypeError('chunkConversation: input.collection must be a non-empty string');
    }
    if (metadata == null
        || typeof metadata.source_uri !== 'string'
        || metadata.source_uri.length === 0) {
        throw new TypeError('chunkConversation: input.metadata.source_uri must be a non-empty string');
    }
    if (bytes.length === 0) return [];

    const turns = parseTurns(bytes);
    if (turns.length === 0) return [];

    const created_at = typeof metadata.created_at === 'number' ? metadata.created_at : 0;
    const updated_at = typeof metadata.updated_at === 'number' ? metadata.updated_at : created_at;
    const inputCustom = metadata.custom == null ? {} : metadata.custom;

    /** @type {import('../contracts.js').Chunk[]} */
    const chunks = [];
    let cursor = 0;
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const canonical = JSON.stringify(turn);
        const turnByteLen = utf8ByteLength(canonical);
        const byteStart = cursor;
        const byteEnd = cursor + turnByteLen;
        cursor = byteEnd;

        const id = computeChunkID({
            collection,
            source_uri: metadata.source_uri,
            byte_range: [byteStart, byteEnd],
            chunker_version: CHUNKER_VERSION.conversation,
        });

        const content = turn.content;
        chunks.push({
            id,
            collection,
            content,
            tokens: Math.ceil(content.length / 4),
            metadata: {
                source_uri: metadata.source_uri,
                content_type: 'conversation',
                created_at,
                updated_at,
                content_hash: fnv1aHex(canonical),
                structural: null,
                custom: buildTurnCustom(turn, i, inputCustom),
            },
            byte_range: [byteStart, byteEnd],
        });
    }
    return chunks;
}
