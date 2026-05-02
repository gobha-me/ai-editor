// @ts-check
/**
 * Structured chunker — one chunk per record, no overlap. Implements the
 * structured row of
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Chunker":
 * "per record over top-level keys / array elements." Pure function —
 * `(input) → Chunk[]` mirroring the contract pinned by
 * [prose-chunker.js](./prose-chunker.js) at 1.4.10, [code-chunker.js](./code-chunker.js)
 * at 1.4.11, and [conversation-chunker.js](./conversation-chunker.js) at
 * 1.4.12. No I/O, no async, no external state.
 *
 * Scope (v1). Two formats: **JSON** and **JSONL** (a.k.a. NDJSON). CSV /
 * YAML / TOML are deferred until a real consumer asks. The roadmap
 * (1.4.13) gates this scope decision explicitly because "per record" is
 * format-specific in a way Conversation's "1 turn = 1 chunk" is not — so
 * formats outside this list need a fresh decision rather than a quiet
 * extension.
 *
 * Sub-format dispatch. The chunker resolves the sub-format from
 * `input.metadata.custom.format` (`'json'` | `'jsonl'`, explicit
 * override) or, failing that, from the `input.metadata.source_uri`
 * extension (`.json` | `.jsonl` | `.ndjson`). Unknown / missing →
 * `TypeError`. No content-sniffing heuristics; mirrors Conversation's
 * "invalid input is a programmer error" stance.
 *
 * Record semantics.
 * - JSON top-level **array** `[a, b, c]` → one chunk per element.
 *   `metadata.custom.record_index = i`. Canonical record bytes:
 *   `JSON.stringify(element)`.
 * - JSON top-level **object** `{k1: v1, k2: v2}` → one chunk per
 *   key/value pair in `Object.keys()` insertion order.
 *   `metadata.custom.record_key = k`, `record_index = i`. Canonical
 *   record bytes: `JSON.stringify({[k]: v})` (the key participates in
 *   chunk identity, so two values with the same JSON form under
 *   different keys get distinct ChunkIDs through the byte_range
 *   ordering, and distinct content hashes through the canonical bytes).
 * - JSON top-level **scalar** (string, number, boolean, null) → reject.
 *   "Per record" implies a container.
 * - **Empty container** (`[]` / `{}`) → return `[]` (matches
 *   Conversation's empty-turns behavior).
 * - JSONL → one chunk per non-blank line. Whitespace-only lines are
 *   skipped. Each line must parse as JSON; any parse failure rejects
 *   the whole input (no partial success). `metadata.custom.record_index
 *   = i` is the position over **non-blank** lines (zero-based).
 *   Canonical record bytes: `JSON.stringify(parsed)`.
 *
 * Byte-range semantics. Mirroring Conversation, structured byte_ranges
 * are computed over the concatenation of canonical per-record
 * serializations, **not** over `input.bytes`. This decouples ChunkID
 * stability from caller serialization choices: the same logical
 * structured payload produces identical ChunkIDs regardless of whether
 * the caller pretty-printed JSON, used trailing newlines, etc. Adjacency
 * holds: `chunks[i+1].byte_range[0] === chunks[i].byte_range[1]`.
 *
 * `metadata.custom` precedence. Caller-supplied `input.metadata.custom`
 * keys take precedence over per-record `record_index` / `record_key` on
 * conflict — the same precedence rule Conversation established. The
 * `format` dispatch hint is filtered out before pass-through (it's a
 * chunker dispatch knob, not a chunk-level metadata field); to surface
 * the format in chunk metadata the caller can set a different key (e.g.
 * `source_format`).
 *
 * Structural metadata. `metadata.structural === null` for every emitted
 * chunk, matching Prose / Code / Conversation. Nested-record expansion
 * (parent_id walks, heading_path, etc.) is the StructureExtractor's job,
 * post-ingest.
 *
 * @module intelligence/retrieval/chunkers/structured-chunker
 */

import { computeChunkID } from '../chunk-id.js';
import { CHUNKER_VERSION } from '../contracts.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a string, returned as 8-char lowercase hex. Used for
 * `Metadata.content_hash` per chunk. Duplicated from prose / code /
 * conversation chunkers intentionally per the precedent set by 1.4.11 —
 * extracting shared helpers risks shifting prose byte-ranges in a
 * structured-chunker PR.
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
 * Resolve the structured sub-format. The explicit `metadata.custom.format`
 * override wins; otherwise the `metadata.source_uri` extension is sniffed
 * (`.json` | `.jsonl` | `.ndjson`). Returns `'json'` or `'jsonl'`. Throws
 * on unknown / missing.
 *
 * @param {string} source_uri
 * @param {Object<string, *>} inputCustom
 * @returns {"json"|"jsonl"}
 */
function resolveFormat(source_uri, inputCustom) {
    if (Object.prototype.hasOwnProperty.call(inputCustom, 'format')) {
        const f = inputCustom.format;
        if (f === 'json' || f === 'jsonl') return f;
        throw new TypeError(
            `chunkStructured: input.metadata.custom.format must be 'json' or 'jsonl' (got ${JSON.stringify(f)})`,
        );
    }
    const lower = source_uri.toLowerCase();
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
    throw new TypeError(
        "chunkStructured: cannot resolve format — set input.metadata.custom.format to 'json' or 'jsonl', or use a .json/.jsonl/.ndjson source_uri",
    );
}

/**
 * @typedef {Object} ParsedRecord
 * @property {string} canonical    JSON.stringify(...) of the record value (or {key:value} for object entries).
 * @property {string|null} key     Object-entry key, or null for array / JSONL records.
 * @property {number} record_index Zero-based index over emitted records.
 */

/**
 * Parse the input bytes as JSON and walk the top-level container. Throws
 * on malformed JSON, top-level scalar, or non-container types.
 *
 * @param {string} bytes
 * @returns {ParsedRecord[]}
 */
function parseJsonRecords(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(bytes);
    } catch (e) {
        throw new TypeError(`chunkStructured: input.bytes must be valid JSON: ${e.message}`);
    }
    if (Array.isArray(parsed)) {
        const records = [];
        for (let i = 0; i < parsed.length; i++) {
            records.push({
                canonical: JSON.stringify(parsed[i]),
                key: null,
                record_index: i,
            });
        }
        return records;
    }
    if (parsed != null && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        const records = [];
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            records.push({
                canonical: JSON.stringify({ [k]: parsed[k] }),
                key: k,
                record_index: i,
            });
        }
        return records;
    }
    throw new TypeError(
        'chunkStructured: JSON top-level value must be an array or object (top-level scalars are not records)',
    );
}

/**
 * Parse the input bytes as JSONL: one JSON value per non-blank line.
 * Whitespace-only lines are skipped. Any parse failure rejects the whole
 * input (no partial success).
 *
 * @param {string} bytes
 * @returns {ParsedRecord[]}
 */
function parseJsonlRecords(bytes) {
    const lines = bytes.split('\n');
    const records = [];
    let record_index = 0;
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        let line = lines[lineNo];
        // Strip trailing CR for CRLF-delimited input.
        if (line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d) {
            line = line.slice(0, -1);
        }
        if (line.trim().length === 0) continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            throw new TypeError(
                `chunkStructured: JSONL line ${lineNo + 1} is not valid JSON: ${e.message}`,
            );
        }
        records.push({
            canonical: JSON.stringify(parsed),
            key: null,
            record_index,
        });
        record_index += 1;
    }
    return records;
}

/**
 * Build the metadata.custom payload for a record. Carries `record_index`
 * always, `record_key` for object-entry records, and any caller-supplied
 * keys from `input.metadata.custom`. Caller keys take precedence on
 * conflict — same rule Conversation established. The dispatch-only
 * `format` key is filtered out (it's a chunker knob, not a chunk-level
 * field).
 *
 * @param {ParsedRecord} record
 * @param {Object<string, *>} inputCustom
 * @returns {Object<string, *>}
 */
function buildRecordCustom(record, inputCustom) {
    /** @type {Object<string, *>} */
    const merged = { record_index: record.record_index };
    if (record.key !== null) {
        merged.record_key = record.key;
    }
    for (const key of Object.keys(inputCustom)) {
        if (key === 'format') continue;
        merged[key] = inputCustom[key];
    }
    return merged;
}

/**
 * Chunk a structured (JSON or JSONL) payload into one Chunk per record.
 *
 * @param {import('../contracts.js').ChunkerInput} input
 * @returns {import('../contracts.js').Chunk[]}
 */
export function chunkStructured(input) {
    if (input == null) {
        throw new TypeError('chunkStructured: input is required');
    }
    const { bytes, collection, metadata } = input;
    if (typeof bytes !== 'string') {
        throw new TypeError('chunkStructured: input.bytes must be a string');
    }
    if (typeof collection !== 'string' || collection.length === 0) {
        throw new TypeError('chunkStructured: input.collection must be a non-empty string');
    }
    if (metadata == null
        || typeof metadata.source_uri !== 'string'
        || metadata.source_uri.length === 0) {
        throw new TypeError('chunkStructured: input.metadata.source_uri must be a non-empty string');
    }

    const inputCustom = metadata.custom == null ? {} : metadata.custom;
    const format = resolveFormat(metadata.source_uri, inputCustom);

    if (bytes.length === 0) return [];

    const records = format === 'json'
        ? parseJsonRecords(bytes)
        : parseJsonlRecords(bytes);
    if (records.length === 0) return [];

    const created_at = typeof metadata.created_at === 'number' ? metadata.created_at : 0;
    const updated_at = typeof metadata.updated_at === 'number' ? metadata.updated_at : created_at;

    /** @type {import('../contracts.js').Chunk[]} */
    const chunks = [];
    let cursor = 0;
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        const recordByteLen = utf8ByteLength(record.canonical);
        const byteStart = cursor;
        const byteEnd = cursor + recordByteLen;
        cursor = byteEnd;

        const id = computeChunkID({
            collection,
            source_uri: metadata.source_uri,
            byte_range: [byteStart, byteEnd],
            chunker_version: CHUNKER_VERSION.structured,
        });

        chunks.push({
            id,
            collection,
            content: record.canonical,
            tokens: Math.ceil(record.canonical.length / 4),
            metadata: {
                source_uri: metadata.source_uri,
                content_type: 'structured',
                created_at,
                updated_at,
                content_hash: fnv1aHex(record.canonical),
                structural: null,
                custom: buildRecordCustom(record, inputCustom),
            },
            byte_range: [byteStart, byteEnd],
        });
    }
    return chunks;
}
