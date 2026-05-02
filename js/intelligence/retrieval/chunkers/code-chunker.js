// @ts-check
/**
 * Code chunker — language-aware regex heuristic at top-level declaration
 * boundaries with no overlap. Implements the code row of
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Chunker"
 * and the honest commitment in §"On code chunking specifically": a Phase 1
 * heuristic for a small set of target languages (JS/TS/Python here);
 * AST-based chunking is deferred to 1.5.5 gated on a measured quality gap.
 *
 * Pure function: `(input) → Chunk[]`. No I/O, no async, no external state.
 * Mirrors the contract pinned by [prose-chunker.js](./prose-chunker.js) at
 * 1.4.10 — same `ChunkerInput` → `Chunk[]` shape, same `byte_range`-as-
 * UTF-8-bytes invariant, same surrogate-safe slicing — but applies the
 * design's "per-construct, no overlap" rule rather than the prose 100-char
 * overlap. Reuses `computeChunkID` from [chunk-id.js](../chunk-id.js) under
 * `CHUNKER_VERSION.code` so a future regex tweak invalidates IDs cleanly
 * (DESIGN-retrieval §"Chunk Identity and Stability").
 *
 * Strategy:
 *   1. Detect language from `metadata.source_uri` extension. Unknown
 *      extensions fall back to a single-chunk-per-file degenerate path so
 *      the chunker never returns nothing for non-empty input.
 *   2. Walk lines; match each against language-specific top-level boundary
 *      regexes (function/class/var/type/import for JS/TS;
 *      def/class/import + decorator-attaches for Python).
 *   3. Coalesce consecutive imports into a single block (DESIGN's "import
 *      blocks" boundary type).
 *   4. Build adjacent ranges `[prev_boundary, this_boundary)` so consecutive
 *      chunks share a boundary point — same byte-range adjacency invariant
 *      ProseChunker holds, just without the 100-char overlap. Leading
 *      content (shebang, file-prefix comments) rides with the first chunk.
 *   5. Hard-cut any chunk whose char span exceeds `MAX_CONSTRUCT_CHARS`
 *      at the first newline at-or-after that ceiling. Termination
 *      guarantee analogous to ProseChunker's `TARGET_MAX` hard-cut.
 *
 * Known limitations (per design §"On code chunking specifically"): nested
 * types, complex generics, decorators that need binding to non-adjacent
 * declarations, macro-heavy code. The version bump path (`CHUNKER_VERSION
 * .code`) handles improvements without ID collisions.
 *
 * @module intelligence/retrieval/chunkers/code-chunker
 */

import { computeChunkID } from '../chunk-id.js';
import { CHUNKER_VERSION } from '../contracts.js';

/**
 * Maximum char-length of a single chunk before the hard-cut safety valve
 * kicks in. Sized larger than ProseChunker's `TARGET_MAX = 1200` because
 * top-level functions are often legitimately long (a 5K-line generated
 * lookup table is one construct, but admitting it whole would dwarf any
 * sensible budget). Splits at the next newline to keep cuts line-aligned.
 */
const MAX_CONSTRUCT_CHARS = 8000;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a string, returned as 8-char lowercase hex. Used for
 * `Metadata.content_hash` per chunk; the same primitive backs `ChunkID` in
 * [chunk-id.js](../chunk-id.js). Duplicated from
 * [prose-chunker.js](./prose-chunker.js) intentionally for this PR — see
 * the plan caveat: extracting shared helpers risks shifting prose
 * byte-ranges in a code-chunker PR, so the helpers stay co-located until a
 * dedicated cleanup PR lands.
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
 * Extension → internal language label. The chunker only cares about the
 * matcher to use; concrete language naming is internal.
 */
const LANG_BY_EXT = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
};

/**
 * Detect the language label for a `source_uri` from its extension. Returns
 * `null` for unknown / extensionless paths — callers fall back to the
 * single-chunk degenerate path.
 *
 * @param {string} source_uri
 * @returns {string|null}
 */
function detectLanguage(source_uri) {
    const m = /\.([^.\/]+)$/.exec(source_uri);
    if (!m) return null;
    return LANG_BY_EXT[m[1].toLowerCase()] || null;
}

/**
 * @typedef {Object} Line
 * @property {number} start  Inclusive char index of the line's first char.
 * @property {number} end    Exclusive char index (excluding the trailing newline).
 * @property {string} text   Line content without the trailing newline.
 */

/**
 * Split `bytes` into a flat list of lines, preserving char-index ranges.
 * The trailing newline (if any) is excluded from `text` and `end`; the
 * next line's `start` sits one past it. Final line has no trailing
 * newline implied.
 *
 * @param {string} bytes
 * @returns {Line[]}
 */
function tokenizeLines(bytes) {
    /** @type {Line[]} */
    const lines = [];
    let i = 0;
    while (i <= bytes.length) {
        const start = i;
        let end = i;
        while (end < bytes.length && bytes[end] !== '\n') end++;
        lines.push({ start, end, text: bytes.slice(start, end) });
        if (end >= bytes.length) break;
        i = end + 1;
    }
    return lines;
}

/**
 * @typedef {{kind: "import"|"export"|"function"|"class"|"var"|"type"|"def"|"decorator"}} BoundaryMatch
 */

/**
 * Match a JS/TS line against the top-level boundary regexes. Returns the
 * boundary kind on match, `null` otherwise. Patterns require the construct
 * keyword at column 0 — indented (nested) declarations don't qualify, by
 * design (Phase 1 heuristic).
 *
 * @param {string} line
 * @returns {BoundaryMatch|null}
 */
function matchJsBoundary(line) {
    if (/^import\b/.test(line)) return { kind: 'import' };
    if (/^export\s*[{*]/.test(line)) return { kind: 'export' };
    if (/^(export\s+(default\s+)?)?(async\s+)?function\b/.test(line)) return { kind: 'function' };
    if (/^(export\s+(default\s+)?)?(abstract\s+)?class\b/.test(line)) return { kind: 'class' };
    if (/^(export\s+)?(const|let|var)\s+\w/.test(line)) return { kind: 'var' };
    if (/^(export\s+)?(type|interface|enum)\s+\w/.test(line)) return { kind: 'type' };
    if (/^export\s+default\b/.test(line)) return { kind: 'export' };
    return null;
}

/**
 * Match a Python line against the top-level boundary regexes. Decorators
 * are matched as their own kind so the post-pass can shift the
 * corresponding def/class boundary back through them.
 *
 * @param {string} line
 * @returns {BoundaryMatch|null}
 */
function matchPyBoundary(line) {
    if (/^(import|from)\s+\w/.test(line)) return { kind: 'import' };
    if (/^@\w/.test(line)) return { kind: 'decorator' };
    if (/^(async\s+)?def\s+\w/.test(line)) return { kind: 'def' };
    if (/^class\s+\w/.test(line)) return { kind: 'class' };
    return null;
}

/**
 * Walk lines to find boundary char-positions. Applies language-specific
 * matching, decorator-attaches (Python), and import-block coalescing.
 *
 * @param {string} bytes
 * @param {string|null} language
 * @returns {number[]} Char-indices of line starts that begin a new chunk.
 */
function findBoundaries(bytes, language) {
    if (language == null) return [];
    const lines = tokenizeLines(bytes);
    const matcher = language === 'python' ? matchPyBoundary : matchJsBoundary;
    /** @type {Array<BoundaryMatch|null>} */
    const matched = lines.map((l) => matcher(l.text));

    if (language === 'python') {
        for (let li = 0; li < lines.length; li++) {
            const m = matched[li];
            if (m && (m.kind === 'def' || m.kind === 'class')) {
                let target = li;
                let probe = li - 1;
                while (probe >= 0) {
                    const pm = matched[probe];
                    if (pm && pm.kind === 'decorator') {
                        target = probe;
                        probe--;
                    } else {
                        break;
                    }
                }
                if (target !== li) {
                    matched[target] = m;
                    for (let k = target + 1; k <= li; k++) matched[k] = null;
                }
            }
        }
        for (let li = 0; li < lines.length; li++) {
            const m = matched[li];
            if (m && m.kind === 'decorator') matched[li] = null;
        }
    }

    /** @type {BoundaryMatch|null} */
    let lastEmitted = null;
    for (let li = 0; li < lines.length; li++) {
        const m = matched[li];
        if (!m) continue;
        if (m.kind === 'import' && lastEmitted && lastEmitted.kind === 'import') {
            matched[li] = null;
        } else {
            lastEmitted = m;
        }
    }

    const boundaries = [];
    for (let li = 0; li < lines.length; li++) {
        if (matched[li]) boundaries.push(lines[li].start);
    }
    return boundaries;
}

/**
 * Build adjacent chunk ranges from boundary positions. The first chunk
 * always starts at char 0 so leading shebangs / file-prefix comments ride
 * with the first construct. Subsequent chunks span
 * `[boundaries[i], boundaries[i+1])`; the last extends to `bytes.length`.
 *
 * @param {string} bytes
 * @param {number[]} boundaries
 * @returns {Array<{start:number, end:number}>}
 */
function buildChunkRanges(bytes, boundaries) {
    if (bytes.length === 0) return [];
    if (boundaries.length === 0) {
        return [{ start: 0, end: bytes.length }];
    }
    const cuts = [0, ...boundaries.slice(1).filter((b) => b > 0)];
    /** @type {Array<{start:number, end:number}>} */
    const out = [];
    for (let i = 0; i < cuts.length; i++) {
        const start = cuts[i];
        const end = i + 1 < cuts.length ? cuts[i + 1] : bytes.length;
        if (end > start) out.push({ start, end });
    }
    return out;
}

/**
 * Hard-cut any range whose char span exceeds `MAX_CONSTRUCT_CHARS` at the
 * first newline at-or-after that ceiling. Falls back to a surrogate-safe
 * char-position cut if no newline is reachable inside the range —
 * termination guarantee mirrors ProseChunker's `TARGET_MAX` fallback.
 *
 * @param {Array<{start:number, end:number}>} ranges
 * @param {string} bytes
 * @returns {Array<{start:number, end:number}>}
 */
function hardCutOversized(ranges, bytes) {
    /** @type {Array<{start:number, end:number}>} */
    const out = [];
    for (const r of ranges) {
        let cur = r.start;
        while (r.end - cur > MAX_CONSTRUCT_CHARS) {
            const probe = cur + MAX_CONSTRUCT_CHARS;
            const idx = bytes.indexOf('\n', probe);
            if (idx >= 0 && idx < r.end) {
                const cut = idx + 1;
                out.push({ start: cur, end: cut });
                cur = cut;
            } else {
                let cut = probe;
                if (cut < bytes.length) {
                    const code = bytes.charCodeAt(cut - 1);
                    if (code >= 0xD800 && code <= 0xDBFF) cut--;
                }
                out.push({ start: cur, end: cut });
                cur = cut;
            }
        }
        if (cur < r.end) out.push({ start: cur, end: r.end });
    }
    return out;
}

/**
 * Chunk source code into per-top-level-construct chunks for JS/TS/Python.
 * Unknown extensions yield a single-chunk degenerate output — the chunker
 * still emits a usable Chunk so downstream stages aren't surprised by
 * empty results on, say, a `Makefile`.
 *
 * @param {import('../contracts.js').ChunkerInput} input
 * @returns {import('../contracts.js').Chunk[]}
 */
export function chunkCode(input) {
    if (input == null) {
        throw new TypeError('chunkCode: input is required');
    }
    const { bytes, collection, metadata } = input;
    if (typeof bytes !== 'string') {
        throw new TypeError('chunkCode: input.bytes must be a string');
    }
    if (typeof collection !== 'string' || collection.length === 0) {
        throw new TypeError('chunkCode: input.collection must be a non-empty string');
    }
    if (metadata == null
        || typeof metadata.source_uri !== 'string'
        || metadata.source_uri.length === 0) {
        throw new TypeError('chunkCode: input.metadata.source_uri must be a non-empty string');
    }
    if (bytes.length === 0) return [];
    if (bytes.trim().length === 0) return [];

    const language = detectLanguage(metadata.source_uri);
    const boundaries = findBoundaries(bytes, language);
    const initialRanges = buildChunkRanges(bytes, boundaries);
    const ranges = hardCutOversized(initialRanges, bytes);

    const utf8 = buildUtf8Offsets(bytes);
    const created_at = typeof metadata.created_at === 'number' ? metadata.created_at : 0;
    const updated_at = typeof metadata.updated_at === 'number' ? metadata.updated_at : created_at;
    const custom = metadata.custom == null ? {} : metadata.custom;

    return ranges.map((range) => {
        const content = bytes.slice(range.start, range.end);
        const byteStart = utf8[range.start];
        const byteEnd = utf8[range.end];
        const id = computeChunkID({
            collection,
            source_uri: metadata.source_uri,
            byte_range: [byteStart, byteEnd],
            chunker_version: CHUNKER_VERSION.code,
        });
        return {
            id,
            collection,
            content,
            tokens: Math.ceil(content.length / 4),
            metadata: {
                source_uri: metadata.source_uri,
                content_type: 'code',
                created_at,
                updated_at,
                content_hash: fnv1aHex(content),
                structural: null,
                custom,
            },
            byte_range: [byteStart, byteEnd],
        };
    });
}
