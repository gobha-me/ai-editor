// @ts-check
/**
 * Prose chunker — paragraph + heading boundaries with 800-1200 char target
 * size and 100 char overlap. Implements the prose row of
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Chunker".
 *
 * Pure function: `(input) → Chunk[]`. No I/O, no async, no external state.
 * The 1.4.10 PR ships this in isolation; the chunker contract, overlap
 * mechanics, and ChunkID stability story it pins are reused by the four
 * follow-up chunker PRs (`code`, `conversation`, `structured`, `spec`).
 *
 * Why prose first: the smallest seam that exercises overlap and the
 * heading-forces-boundary rule together — the parts of the contract every
 * later chunker reuses. The harder code chunker (regex heuristic per
 * `docs/DESIGN-retrieval.md` §"On code chunking specifically") lands on
 * top of this contract rather than alongside it.
 *
 * @module intelligence/retrieval/chunkers/prose-chunker
 */

import { computeChunkID } from '../chunk-id.js';
import { CHUNKER_VERSION } from '../contracts.js';

const TARGET_MIN = 800;
const TARGET_MAX = 1200;
const OVERLAP_CHARS = 100;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a string, returned as 8-char lowercase hex. Used for
 * `Metadata.content_hash` per chunk; the same primitive backs `ChunkID` in
 * [chunk-id.js](../chunk-id.js).
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
 * Build a UTF-16 char-index → UTF-8 byte-offset table. Lets every chunk's
 * `byte_range` be reported in UTF-8 bytes (the cross-loader interchange
 * unit per DESIGN-retrieval) while the chunker slices on JS string indices
 * for surrogate-safe boundaries.
 *
 * @param {string} s
 * @returns {number[]} Length s.length + 1; offsets[i] is the byte position of char i.
 */
function buildUtf8Offsets(s) {
    const offsets = new Array(s.length + 1);
    let pos = 0;
    for (let i = 0; i < s.length; i++) {
        offsets[i] = pos;
        const c = s.charCodeAt(i);
        if (c < 0x80) {
            pos += 1;
        } else if (c < 0x800) {
            pos += 2;
        } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
            pos += 4;
            offsets[i + 1] = pos;
            i += 1;
        } else {
            pos += 3;
        }
    }
    offsets[s.length] = pos;
    return offsets;
}

/**
 * @typedef {Object} Block
 * @property {"heading"|"paragraph"} kind
 * @property {number} start  Inclusive char index.
 * @property {number} end    Exclusive char index.
 */

/**
 * Tokenize source into a flat list of paragraph + heading blocks. Headings
 * are markdown-style (`#`/`##`/... followed by whitespace). Blank lines
 * separate paragraphs; the chunker is otherwise content-agnostic.
 *
 * Source text on lines that don't fit either category is treated as
 * paragraph content — the chunker is intentionally permissive so it can
 * handle prose that uses non-markdown conventions.
 *
 * @param {string} bytes
 * @returns {Block[]}
 */
function tokenizeBlocks(bytes) {
    if (bytes.length === 0) return [];
    /** @type {Block[]} */
    const blocks = [];
    /** @type {Block | null} */
    let cur = null;

    let i = 0;
    while (i <= bytes.length) {
        const lineStart = i;
        let lineEnd = i;
        while (lineEnd < bytes.length && bytes[lineEnd] !== '\n') lineEnd++;
        const line = bytes.slice(lineStart, lineEnd);
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            if (cur !== null) { blocks.push(cur); cur = null; }
        } else if (/^#+\s/.test(trimmed)) {
            if (cur !== null) { blocks.push(cur); cur = null; }
            blocks.push({ kind: 'heading', start: lineStart, end: lineEnd });
        } else if (cur === null) {
            cur = { kind: 'paragraph', start: lineStart, end: lineEnd };
        } else {
            cur.end = lineEnd;
        }

        if (lineEnd >= bytes.length) break;
        i = lineEnd + 1;
    }
    if (cur !== null) blocks.push(cur);
    return blocks;
}

/**
 * Locate a sentence-boundary cut inside `[start, end)`, preferring the
 * latest such boundary in the `[start + TARGET_MIN, start + TARGET_MAX]`
 * window. Falls back to a hard cut at `start + TARGET_MAX` (surrogate-safe)
 * when no boundary is reachable.
 *
 * @param {string} bytes
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function findSentenceCut(bytes, start, end) {
    const lo = Math.min(start + TARGET_MIN, end);
    const hi = Math.min(start + TARGET_MAX, end);
    for (let i = hi - 1; i >= lo; i--) {
        const c = bytes[i];
        if ((c === '.' || c === '!' || c === '?')
            && i + 1 < bytes.length
            && /\s/.test(bytes[i + 1])) {
            return i + 2;
        }
    }
    let cut = start + TARGET_MAX;
    if (cut > 0 && cut < bytes.length) {
        const code = bytes.charCodeAt(cut - 1);
        if (code >= 0xD800 && code <= 0xDBFF) cut--;
    }
    return cut;
}

/**
 * Break any block whose char-length exceeds TARGET_MAX into sub-blocks of
 * the same kind. Sentence boundaries are preferred; the deterministic
 * fallback hard-cuts at TARGET_MAX so a single huge token-free paragraph
 * still terminates.
 *
 * @param {Block[]} blocks
 * @param {string}  bytes
 * @returns {Block[]}
 */
function splitOversizedBlocks(blocks, bytes) {
    /** @type {Block[]} */
    const out = [];
    for (const block of blocks) {
        if (block.end - block.start <= TARGET_MAX) {
            out.push(block);
            continue;
        }
        let cur = block.start;
        while (cur < block.end) {
            if (block.end - cur <= TARGET_MAX) {
                out.push({ kind: block.kind, start: cur, end: block.end });
                break;
            }
            const cut = findSentenceCut(bytes, cur, block.end);
            out.push({ kind: block.kind, start: cur, end: cut });
            cur = cut;
        }
    }
    return out;
}

/**
 * Greedy pack normalized blocks into chunk ranges. Heading blocks always
 * start a fresh chunk (so a heading and the section that follows it ride
 * together until the size limit). Other blocks join the current chunk
 * until adding them would exceed TARGET_MAX.
 *
 * @param {Block[]} blocks
 * @returns {Array<{ start: number, end: number }>}
 */
function packChunks(blocks) {
    /** @type {Array<{ start: number, end: number }>} */
    const out = [];
    /** @type {{ start: number, end: number } | null} */
    let cur = null;
    for (const block of blocks) {
        if (cur === null) {
            cur = { start: block.start, end: block.end };
            continue;
        }
        const proposedSize = block.end - cur.start;
        if (block.kind === 'heading' || proposedSize > TARGET_MAX) {
            out.push(cur);
            cur = { start: block.start, end: block.end };
        } else {
            cur.end = block.end;
        }
    }
    if (cur !== null) out.push(cur);
    return out;
}

/**
 * Stretch chunk ranges so consecutive chunks share a boundary point. Any
 * inter-block whitespace becomes the previous chunk's tail rather than
 * a gap; first chunk extends back to char 0 so leading whitespace lives
 * in chunk 0; final chunk extends to bytesLength so the union covers the
 * whole source.
 *
 * Adjacency (chunk[i+1].start === chunk[i].end) is what makes the 100-char
 * overlap a uniform slice of the source rather than a per-chunk recompute.
 *
 * @param {Array<{ start: number, end: number }>} ranges
 * @param {number} bytesLength
 * @returns {Array<{ start: number, end: number }>}
 */
function stretchToContiguous(ranges, bytesLength) {
    if (ranges.length === 0) return [];
    /** @type {Array<{ start: number, end: number }>} */
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
        const start = i === 0 ? 0 : ranges[i].start;
        const end = i + 1 < ranges.length ? ranges[i + 1].start : bytesLength;
        out.push({ start, end });
    }
    return out;
}

/**
 * Char index where chunk N's content begins — pulls 100 chars of overlap
 * from chunk N-1 for chunks 2..N; for the first chunk, returns the chunk's
 * own start. Backs off if landing on a low surrogate so a pair never
 * splits.
 *
 * @param {string} bytes
 * @param {number} chunkStart
 * @param {number} index
 * @returns {number}
 */
function overlapStart(bytes, chunkStart, index) {
    if (index === 0) return chunkStart;
    let start = Math.max(chunkStart - OVERLAP_CHARS, 0);
    if (start > 0 && start < bytes.length) {
        const code = bytes.charCodeAt(start);
        if (code >= 0xDC00 && code <= 0xDFFF) start += 1;
    }
    return start;
}

/**
 * Chunk prose into 800-1200 char chunks at paragraph + heading boundaries
 * with 100 char overlap.
 *
 * @param {import('../contracts.js').ChunkerInput} input
 * @returns {import('../contracts.js').Chunk[]}
 */
export function chunkProse(input) {
    if (input == null) {
        throw new TypeError('chunkProse: input is required');
    }
    const { bytes, collection, metadata } = input;
    if (typeof bytes !== 'string') {
        throw new TypeError('chunkProse: input.bytes must be a string');
    }
    if (typeof collection !== 'string' || collection.length === 0) {
        throw new TypeError('chunkProse: input.collection must be a non-empty string');
    }
    if (metadata == null
        || typeof metadata.source_uri !== 'string'
        || metadata.source_uri.length === 0) {
        throw new TypeError('chunkProse: input.metadata.source_uri must be a non-empty string');
    }
    if (bytes.length === 0) return [];

    const blocks = tokenizeBlocks(bytes);
    if (blocks.length === 0) return [];

    const split = splitOversizedBlocks(blocks, bytes);
    const packed = packChunks(split);
    const ranges = stretchToContiguous(packed, bytes.length);

    const utf8 = buildUtf8Offsets(bytes);
    const created_at = typeof metadata.created_at === 'number' ? metadata.created_at : 0;
    const updated_at = typeof metadata.updated_at === 'number' ? metadata.updated_at : created_at;
    const custom = metadata.custom == null ? {} : metadata.custom;

    return ranges.map((range, i) => {
        const contentStart = overlapStart(bytes, range.start, i);
        const content = bytes.slice(contentStart, range.end);
        const sourceSlice = bytes.slice(range.start, range.end);
        const byteStart = utf8[range.start];
        const byteEnd = utf8[range.end];
        const id = computeChunkID({
            collection,
            source_uri: metadata.source_uri,
            byte_range: [byteStart, byteEnd],
            chunker_version: CHUNKER_VERSION.prose,
        });
        return {
            id,
            collection,
            content,
            tokens: Math.ceil(content.length / 4),
            metadata: {
                source_uri: metadata.source_uri,
                content_type: 'prose',
                created_at,
                updated_at,
                content_hash: fnv1aHex(sourceSlice),
                structural: null,
                custom,
            },
            byte_range: [byteStart, byteEnd],
        };
    });
}
