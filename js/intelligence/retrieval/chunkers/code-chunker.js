// @ts-check
/**
 * Code chunker — language-aware boundary detection at top-level
 * declarations with no overlap. Implements the code row of
 * [DESIGN-retrieval.md](../../../../docs/DESIGN-retrieval.md) §"Chunker"
 * and the honest commitment in §"On code chunking specifically": a Phase 1
 * heuristic for a small set of target languages (JS/TS/Python via regex
 * boundary matchers; C/C++ via the brace-depth-aware lexer
 * `findCFamilyBoundaries` added in 1.7.0 after the polyglot benchmark
 * fired the AST-chunker gate — see CHANGELOG §1.7.0).
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
 *
 * The `cfamily` label fans out to a brace-depth-aware lexer
 * ([findCFamilyBoundaries](#)) that handles C/C++ headers + impls. See the
 * 1.7.0 entry in `CHANGELOG.md` for the recall@5 measurement that prompted
 * its addition.
 */
const LANG_BY_EXT = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    c: 'cfamily',
    cc: 'cfamily',
    cpp: 'cfamily',
    cxx: 'cfamily',
    h: 'cfamily',
    hh: 'cfamily',
    hpp: 'cfamily',
    hxx: 'cfamily',
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
 * Strip line-comments and block-comments from a short prefix slice,
 * preserving string literals verbatim. Used by `findCFamilyBoundaries`
 * when classifying whether an opening `{` belongs to a `namespace` /
 * `extern "C"` block (which the chunker treats as transparent) or to a
 * real declaration body. Strings are preserved because the
 * `extern "C"` / `extern "C++"` discriminator depends on the literal
 * `"..."` content. Pure, single-pass; not intended for whole-file use —
 * callers pass the chars between the most recent statement boundary and
 * the `{`.
 *
 * @param {string} s
 * @returns {string}
 */
function stripCommentsForPrefix(s) {
    let out = '';
    let mode = 'NORMAL';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const c2 = i + 1 < s.length ? s[i + 1] : '';
        if (mode === 'NORMAL') {
            if (c === '/' && c2 === '/') { mode = 'LINE'; i++; continue; }
            if (c === '/' && c2 === '*') { mode = 'BLOCK'; i++; continue; }
            if (c === '"') { mode = 'STR'; out += c; continue; }
            if (c === "'") { mode = 'CHR'; out += c; continue; }
            out += c;
        } else if (mode === 'LINE') {
            if (c === '\n') { mode = 'NORMAL'; out += c; }
        } else if (mode === 'BLOCK') {
            if (c === '*' && c2 === '/') { mode = 'NORMAL'; i++; }
        } else if (mode === 'STR') {
            out += c;
            if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
            if (c === '"') mode = 'NORMAL';
        } else if (mode === 'CHR') {
            out += c;
            if (c === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
            if (c === "'") mode = 'NORMAL';
        }
    }
    return out;
}

/**
 * Brace-depth-aware boundary detector for C-family languages (C, C++ —
 * Phase 1 of the AST-chunker track). Single-pass char scan over `bytes`
 * with a state machine over comments / strings / raw strings (`R"d(...)d"`)
 * / preprocessor lines (with `\\\n` continuation), tracking effective
 * brace depth where `namespace ... { ... }` and `extern "..." { ... }`
 * blocks are *transparent* (they do not bump effective depth — their
 * contents are treated as top-level).
 *
 * Boundary line `L` is admitted when **all** of:
 *   - `L`'s start mode is NORMAL (not mid-block-comment, mid-string, etc.).
 *   - `L`'s start effective depth is 0.
 *   - `L` is not a continuation of a `\\\n`-extended preprocessor line.
 *   - The previous code char at depth 0 was `;`, `}`, BOF, or a transparent
 *     `{` open (i.e. we just finished a top-level statement / declaration).
 *   - `L`'s trimmed text is non-empty AND does not start with `//` (pure
 *     line-comment line), `#` (preprocessor — its own non-boundary block),
 *     or `}` (closing-brace-only line, e.g. `};`).
 *
 * Walk-back: for each admitted line `L`, walk preceding contiguous lines
 * that are doc-comments (line-comments, block-comment open/continuation/close)
 * or attribute specifiers (C++ `[[...]]`, GCC `__attribute__`); the
 * boundary moves back to the first walked-to line so the chunk includes
 * the attached preamble.
 *
 * Phase 1 limitation (deliberate): one chunk per top-level construct,
 * including whole class/struct bodies. Splitting class members into
 * separate chunks is Phase 2 — matches the Go corpus's winning shape
 * (per `tests/run-polyglot-benchmark.mjs` Armature meanRecall@5 = 0.883)
 * where one-chunk-per-top-level-decl proved sufficient for retrieval.
 *
 * @param {string} bytes
 * @returns {number[]} Char-indices of line starts that begin a new chunk.
 */
function findCFamilyBoundaries(bytes) {
    const lines = tokenizeLines(bytes);
    if (lines.length === 0) return [];

    const NORMAL = 0;
    const LINE_COMMENT = 1;
    const BLOCK_COMMENT = 2;
    const STRING = 3;
    const CHAR_LIT = 4;
    const RAW_STRING = 5;

    let mode = NORMAL;
    let depth = 0;
    /** @type {Array<'TRANSPARENT'|'OPAQUE'>} */
    const braceStack = [];
    /** @type {'BOF'|';'|'}'|'TRANSPARENT_OPEN'|'OTHER'} */
    let lastTerminator = 'BOF';
    let inPreproc = false;
    let prevLineEndedBackslash = false;
    let rawStringEnd = '';
    /** Position one-past the last `;`, `}`, transparent `{`, or BOF in
     *  NORMAL mode — used to slice the prefix when classifying a `{`. */
    let prefixStart = 0;

    /** @type {Array<{startMode:number, startDepth:number, startTerminator:string, isContinuation:boolean, inPreprocAtStart:boolean}>} */
    const lineInfo = [];

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const isContinuation = prevLineEndedBackslash;
        if (!isContinuation) inPreproc = false;

        if (!isContinuation && mode === NORMAL) {
            let p = line.start;
            while (p < line.end && (bytes[p] === ' ' || bytes[p] === '\t')) p++;
            if (p < line.end && bytes[p] === '#') inPreproc = true;
        }

        const lineHadPreproc = inPreproc;

        lineInfo.push({
            startMode: mode,
            startDepth: depth,
            startTerminator: lastTerminator,
            isContinuation,
            inPreprocAtStart: inPreproc,
        });

        let i = line.start;
        const endLine = line.end;
        while (i < endLine) {
            const c = bytes[i];
            const c2 = i + 1 < endLine ? bytes[i + 1] : '';

            if (mode === NORMAL) {
                if (c === '/' && c2 === '/') { mode = LINE_COMMENT; i += 2; continue; }
                if (c === '/' && c2 === '*') { mode = BLOCK_COMMENT; i += 2; continue; }
                if (c === '"') { mode = STRING; i++; continue; }
                if (c === "'") { mode = CHAR_LIT; i++; continue; }
                if (c === 'R' && c2 === '"') {
                    let j = i + 2;
                    let delim = '';
                    while (j < endLine && bytes[j] !== '(' && delim.length < 16) {
                        delim += bytes[j];
                        j++;
                    }
                    if (j < endLine && bytes[j] === '(') {
                        mode = RAW_STRING;
                        rawStringEnd = ')' + delim + '"';
                        i = j + 1;
                        continue;
                    }
                }
                if (c === '{') {
                    let transparent = false;
                    if (!inPreproc && depth === 0) {
                        const prefix = stripCommentsForPrefix(bytes.slice(prefixStart, i));
                        const trimmed = prefix.trim();
                        if (/^(inline\s+)?namespace\b/.test(trimmed)) transparent = true;
                        else if (/^extern\s+"[^"]*"\s*$/.test(trimmed)) transparent = true;
                    }
                    braceStack.push(transparent ? 'TRANSPARENT' : 'OPAQUE');
                    if (!inPreproc) {
                        if (!transparent) {
                            depth++;
                            if (depth === 1) lastTerminator = 'OTHER';
                        } else {
                            lastTerminator = 'TRANSPARENT_OPEN';
                            prefixStart = i + 1;
                        }
                    }
                    i++; continue;
                }
                if (c === '}') {
                    const kind = braceStack.pop() || 'OPAQUE';
                    if (!inPreproc) {
                        if (kind === 'OPAQUE') {
                            if (depth > 0) depth--;
                            if (depth === 0) {
                                lastTerminator = '}';
                                prefixStart = i + 1;
                            }
                        } else if (depth === 0) {
                            lastTerminator = '}';
                            prefixStart = i + 1;
                        }
                    }
                    i++; continue;
                }
                if (c === ';') {
                    if (depth === 0 && !inPreproc) {
                        lastTerminator = ';';
                        prefixStart = i + 1;
                    }
                    i++; continue;
                }
                if (depth === 0 && !inPreproc && c !== ' ' && c !== '\t' && c !== '\r') {
                    lastTerminator = 'OTHER';
                }
                i++;
            } else if (mode === LINE_COMMENT) {
                i++;
            } else if (mode === BLOCK_COMMENT) {
                if (c === '*' && c2 === '/') { mode = NORMAL; i += 2; continue; }
                i++;
            } else if (mode === STRING) {
                if (c === '\\' && i + 1 < endLine) { i += 2; continue; }
                if (c === '"') { mode = NORMAL; i++; continue; }
                i++;
            } else if (mode === CHAR_LIT) {
                if (c === '\\' && i + 1 < endLine) { i += 2; continue; }
                if (c === "'") { mode = NORMAL; i++; continue; }
                i++;
            } else if (mode === RAW_STRING) {
                if (c === ')' && bytes.substring(i, i + rawStringEnd.length) === rawStringEnd) {
                    mode = NORMAL;
                    i += rawStringEnd.length;
                    continue;
                }
                i++;
            }
        }

        const lastChar = endLine > line.start ? bytes[endLine - 1] : '';
        const hadBackslashContinuation = lastChar === '\\' && (mode === NORMAL || mode === LINE_COMMENT);
        if (mode === LINE_COMMENT) mode = NORMAL;
        prevLineEndedBackslash = hadBackslashContinuation;
        // Skip preprocessor lines from prefix used to classify the next `{`.
        // Without this, a `#include`/`#pragma`/etc. preceding `namespace foo {`
        // or `extern "C" {` poisons the namespace-detection regex, marking
        // the brace OPAQUE and dropping its contents one depth too deep.
        if (lineHadPreproc) {
            prefixStart = endLine + 1;
        }
    }

    /** @type {number[]} */
    const out = [];
    const seen = new Set();
    for (let li = 0; li < lines.length; li++) {
        const info = lineInfo[li];
        const line = lines[li];
        if (info.startMode !== NORMAL) continue;
        if (info.startDepth !== 0) continue;
        if (info.isContinuation) continue;
        if (info.inPreprocAtStart) continue;
        const t = info.startTerminator;
        if (t !== 'BOF' && t !== ';' && t !== '}' && t !== 'TRANSPARENT_OPEN') continue;

        const trimmed = line.text.trim();
        if (trimmed === '') continue;
        if (trimmed.startsWith('//')) continue;
        if (trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('}')) continue;

        let target = li;
        let probe = li - 1;
        while (probe >= 0) {
            const ptext = lines[probe].text.trim();
            if (ptext === '') break;
            if (ptext.startsWith('//')) { target = probe; probe--; continue; }
            if (ptext.startsWith('/*') || ptext.startsWith('*') || ptext.endsWith('*/')) {
                target = probe; probe--; continue;
            }
            if (ptext.startsWith('[[') || ptext.startsWith('__attribute__')) {
                target = probe; probe--; continue;
            }
            break;
        }
        const pos = lines[target].start;
        if (!seen.has(pos)) { seen.add(pos); out.push(pos); }
    }
    out.sort((a, b) => a - b);
    return out;
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
    const boundaries = language === 'cfamily'
        ? findCFamilyBoundaries(bytes)
        : findBoundaries(bytes, language);
    const initialRanges = buildChunkRanges(bytes, boundaries);
    const ranges = hardCutOversized(initialRanges, bytes);

    const utf8 = buildUtf8Offsets(bytes);
    const created_at = typeof metadata.created_at === 'number' ? metadata.created_at : 0;
    const updated_at = typeof metadata.updated_at === 'number' ? metadata.updated_at : created_at;
    const custom = metadata.custom == null ? {} : metadata.custom;
    const languageTag = language == null ? 'unknown' : language;

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
                language: languageTag,
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
