// @ts-check
/**
 * StructureExtractor — populates `Chunk.metadata.structural` for content
 * types with meaningful hierarchy (prose, code). Implements
 * [DESIGN-retrieval.md](../../../docs/DESIGN-retrieval.md) §"StructureExtractor":
 * a pass that runs after the chunker, dispatched by `content_type`, that
 * fills `heading_path` / `node_kind` / `parent_id` / `sibling_order` so the
 * Phase 1 Structural strategy (PR 8 of 1.5.0) can ancestor-walk over chunk
 * metadata without a separate tree artifact.
 *
 * Pure function: `(chunks: Chunk[]) → Chunk[]`. No I/O, no async, no
 * external state. Mirrors the chunker contract pinned by
 * [prose-chunker.js](./chunkers/prose-chunker.js) at 1.4.10 — same
 * "produce fresh chunks, never mutate input" stance.
 *
 * Phase 1 scope per the design doc:
 *   - **prose**: heading hierarchy (`#`/`##`/...) over chunks. Documents
 *     with no headings have no hierarchy → chunks pass through with
 *     `structural: null` (per the design's "with heading structure"
 *     qualifier).
 *   - **code**: declaration-kind labeling per chunk. CodeChunker Phase 1
 *     emits flat top-level declarations, so `parent_id` is always null.
 *     The `node_kind` value is the still-useful citation context. The
 *     Structural strategy ancestor-walk is a no-op for code in Phase 1
 *     and gains power either when AST chunking lands (1.5.5, gated) or
 *     when the extractor learns to nest function-inside-class.
 *   - **conversation / structured / spec**: pass through unchanged — the
 *     design says these don't carry structural metadata, and the spec
 *     chunker is deferred past Phase 1.
 *
 * **Production wiring (since 1.5.14):** [`pipeline.js:62`](./pipeline.js)
 * imports `extractStructure` and runs it as the post-pass after every
 * chunker dispatch; the retrieval Manager drives `runChunkerPipeline`
 * on every chunked source, so `metadata.structural` is populated on
 * every chunk in the production store. Removability is inverted —
 * deleting this module breaks the Structural strategy's ancestor walk
 * and degrades `findRelevantFiles()` recall. ICD contract:
 * [`docs/ICD-intelligence-composers.md`](../../../docs/ICD-intelligence-composers.md).
 *
 * @module intelligence/retrieval/structure-extractor
 */

/**
 * @typedef {import('./contracts.js').Chunk} Chunk
 * @typedef {import('./contracts.js').ChunkID} ChunkID
 * @typedef {import('./contracts.js').StructuralMeta} StructuralMeta
 * @typedef {import('./contracts.js').ContentType} ContentType
 */

/**
 * The `node_kind` vocabulary the StructureExtractor emits. The contract
 * typedef in [contracts.js](./contracts.js) is intentionally open-ended
 * (`"section" | "function" | "type" | "test" | ...`), so this constant
 * pins the extractor's actual output set — consumers (the Phase 1
 * Structural strategy + Diagnostics) read against a stable surface.
 *
 * Frozen so a typo in a downstream filter (`NODE_KIND.functoin`) errors
 * instead of silently never matching.
 */
export const NODE_KIND = Object.freeze({
    section: 'section',
    function: 'function',
    class: 'class',
    variable: 'variable',
    type: 'type',
    import: 'import',
    export: 'export',
    code: 'code',
});

/**
 * Heading detection regex. Line-anchored via the `m` flag and global so
 * we can iterate every heading match in a chunk's content. Mirrors the
 * prose chunker's `/^#+\s/` test on a trimmed line — same
 * leading-whitespace tolerance. Capture groups: `1` = the `#` run (level
 * via length); `2` = the heading text (trailing whitespace trimmed by
 * the consumer).
 */
const HEADING_RE = /^[ \t]*(#+)[ \t]+([^\n]+)/gm;

/**
 * Find every markdown-style heading in a chunk's content, in document
 * order. Returns an array of `{ level, text }`; empty if none.
 *
 * Why every heading rather than just the first: the prose chunker's
 * 100-char overlap can pull the previous chunk's defining heading
 * forward into chunk N's content. When the previous chunk was small
 * (e.g. just the heading + a short body), the overlap drags in both
 * chunk N-1's heading AND any heading that started chunk N's source
 * slice. The extractor needs to walk all candidates to skip the overlap
 * leak and land on the right heading.
 *
 * @param {string} content
 * @returns {Array<{ level: number, text: string }>}
 */
function detectAllHeadings(content) {
    const re = new RegExp(HEADING_RE.source, HEADING_RE.flags);
    /** @type {Array<{ level: number, text: string }>} */
    const out = [];
    let m;
    while ((m = re.exec(content)) !== null) {
        out.push({ level: m[1].length, text: m[2].trim() });
    }
    return out;
}

/**
 * Build structural metadata for a prose chunk batch by walking heading
 * levels. A chunk that begins a new heading section becomes a "section"
 * node; continuation chunks (no leading heading) inherit the most-recent
 * heading's `heading_path` and `parent_id` so the ancestor walk reaches
 * the same section root.
 *
 * If no chunk in the batch carries a heading, the document has no
 * hierarchy → chunks pass through unchanged (`structural: null`), per
 * the design's "with heading structure" qualifier.
 *
 * Overlap-noise suppression: the prose chunker's 100-char overlap can
 * pull earlier chunks' headings forward into chunk N's content
 * (especially when prior chunks were shorter than 100 chars — the
 * overlap then drags through several previous headings, not just the
 * immediately-prior one). For each chunk we walk every detected heading
 * candidate and pick the first one whose `(level, text)` hasn't already
 * been emitted in this batch. The known limitation: two genuinely-
 * identical sibling headings (e.g. two `## Examples` sections) collapse
 * to the first; for Phase 1 we accept that — the cost dashboard will
 * surface if it matters.
 *
 * The dedup set is per-`extractStructure` call, so the same `(level,
 * text)` pair appearing in different documents (different batches) is
 * not affected.
 *
 * @param {Chunk[]} chunks
 * @returns {Chunk[]}
 */
function extractProse(chunks) {
    const allHeadings = chunks.map((c) => detectAllHeadings(c.content));
    /** @type {Array<{level:number,text:string}|null>} */
    const headings = new Array(chunks.length);
    /** @type {Set<string>} `${level}\0${text}` keys of every heading already emitted in this batch. */
    const seen = new Set();
    for (let i = 0; i < chunks.length; i++) {
        /** @type {{level:number,text:string}|null} */
        let chosen = null;
        for (const candidate of allHeadings[i]) {
            const key = `${candidate.level}\0${candidate.text}`;
            if (!seen.has(key)) {
                chosen = candidate;
                seen.add(key);
                break;
            }
        }
        headings[i] = chosen;
    }
    if (headings.every((h) => h === null)) {
        return chunks;
    }

    /** @type {Array<{ level: number, chunk_id: ChunkID, text: string }>} */
    const stack = [];
    /** @type {Map<ChunkID|null, number>} */
    const siblingCounts = new Map();
    /** @type {ChunkID|null} */
    let currentSectionId = null;
    /** @type {string[]|null} Last computed heading_path for continuation chunks. */
    let currentHeadingPath = null;

    /** @type {Chunk[]} */
    const out = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const heading = headings[i];

        /** @type {ChunkID|null} */
        let parent_id;
        /** @type {string[]} */
        let heading_path;
        /** @type {number} */
        let sibling_order;

        if (heading !== null) {
            while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
                stack.pop();
            }
            parent_id = stack.length > 0 ? stack[stack.length - 1].chunk_id : null;
            const next = (siblingCounts.get(parent_id) || 0);
            sibling_order = next;
            siblingCounts.set(parent_id, next + 1);
            heading_path = stack.map((s) => s.text).concat([heading.text]);
            stack.push({ level: heading.level, chunk_id: chunk.id, text: heading.text });
            currentSectionId = chunk.id;
            currentHeadingPath = heading_path;
        } else if (currentSectionId !== null && currentHeadingPath !== null) {
            parent_id = currentSectionId;
            heading_path = currentHeadingPath;
            const next = (siblingCounts.get(parent_id) || 0);
            sibling_order = next;
            siblingCounts.set(parent_id, next + 1);
        } else {
            out.push(chunk);
            continue;
        }

        /** @type {StructuralMeta} */
        const structural = {
            heading_path,
            node_kind: NODE_KIND.section,
            parent_id,
            sibling_order,
        };
        out.push({
            ...chunk,
            metadata: {
                ...chunk.metadata,
                structural,
            },
        });
    }

    return out;
}

/**
 * JS / TS top-level construct → `node_kind` label. Mirrors the
 * `BoundaryMatch.kind` set used by
 * [code-chunker.js](./chunkers/code-chunker.js)'s `matchJsBoundary`,
 * collapsed into the design's `node_kind` vocabulary
 * (`docs/DESIGN-retrieval.md` §"StructuralMeta": "function | type | test
 * | ..."). The set is intentionally small — fine-grained splits
 * (`type` vs `interface` vs `enum`) collapse to `"type"` until a strategy
 * consumer asks for the distinction.
 */
const JS_KIND_BY_BOUNDARY = {
    'function': NODE_KIND.function,
    'class': NODE_KIND.class,
    'var': NODE_KIND.variable,
    'type': NODE_KIND.type,
    'import': NODE_KIND.import,
    'export': NODE_KIND.export,
};

/**
 * Python top-level construct → `node_kind` label. `def` and `async def`
 * both map to `"function"` so JS/TS functions and Python defs share a
 * vocabulary downstream.
 */
const PY_KIND_BY_BOUNDARY = {
    'def': NODE_KIND.function,
    'class': NODE_KIND.class,
    'import': NODE_KIND.import,
};

/**
 * Detect a JS/TS top-level construct kind from the first non-blank line of
 * a code chunk's content. Returns `null` if no boundary regex matches —
 * the chunk is then labeled as the generic `"code"` kind (e.g. file-level
 * comments, declaration-less prelude).
 *
 * Patterns mirror `matchJsBoundary` in
 * [code-chunker.js](./chunkers/code-chunker.js); kept duplicated here
 * deliberately so a chunker tweak doesn't silently shift the extractor's
 * labeling. A future cleanup PR can lift them into a shared module
 * once both stabilize.
 *
 * @param {string} line
 * @returns {string|null}
 */
function matchJsKind(line) {
    if (/^import\b/.test(line)) return 'import';
    if (/^export\s*[{*]/.test(line)) return 'export';
    if (/^(export\s+(default\s+)?)?(async\s+)?function\b/.test(line)) return 'function';
    if (/^(export\s+(default\s+)?)?(abstract\s+)?class\b/.test(line)) return 'class';
    if (/^(export\s+)?(const|let|var)\s+\w/.test(line)) return 'var';
    if (/^(export\s+)?(type|interface|enum)\s+\w/.test(line)) return 'type';
    if (/^export\s+default\b/.test(line)) return 'export';
    return null;
}

/**
 * Detect a Python top-level construct kind. Decorators are skipped over
 * — the boundary's "real" kind is the following def/class, matching the
 * chunker's decorator-attaches-back behavior.
 *
 * @param {string} line
 * @returns {string|null}
 */
function matchPyKind(line) {
    if (/^(import|from)\s+\w/.test(line)) return 'import';
    if (/^(async\s+)?def\s+\w/.test(line)) return 'def';
    if (/^class\s+\w/.test(line)) return 'class';
    return null;
}

/**
 * Resolve a chunk's `node_kind` by scanning its content for the first
 * boundary-matching line. Decorators (Python) are skipped.
 *
 * @param {string} content
 * @param {"javascript"|"typescript"|"python"|null} language
 * @returns {string}
 */
function detectCodeKind(content, language) {
    if (language == null) return NODE_KIND.code;
    const matcher = language === 'python' ? matchPyKind : matchJsKind;
    const lines = content.split('\n');
    for (const raw of lines) {
        const line = raw;
        if (line.trim().length === 0) continue;
        if (language === 'python' && /^@\w/.test(line)) continue;
        const kind = matcher(line);
        if (kind != null) {
            const table = language === 'python' ? PY_KIND_BY_BOUNDARY : JS_KIND_BY_BOUNDARY;
            return table[kind] || NODE_KIND.code;
        }
        return NODE_KIND.code;
    }
    return NODE_KIND.code;
}

/**
 * Map a `source_uri` extension to a known language family. Mirrors
 * [code-chunker.js](./chunkers/code-chunker.js)'s `LANG_BY_EXT` /
 * `detectLanguage` so the structure extractor uses the same alphabet.
 *
 * @param {string} source_uri
 * @returns {"javascript"|"typescript"|"python"|null}
 */
function detectLanguage(source_uri) {
    const m = /\.([^.\/]+)$/.exec(source_uri);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return 'javascript';
    if (ext === 'ts' || ext === 'tsx') return 'typescript';
    if (ext === 'py') return 'python';
    return null;
}

/**
 * Build structural metadata for a code chunk batch. Phase 1 CodeChunker
 * emits flat top-level declarations, so every chunk is a sibling at root:
 * `parent_id = null`, `heading_path = []`, `sibling_order` = chunk index.
 * `node_kind` carries the detected declaration kind.
 *
 * Code chunks for unknown extensions (CodeChunker's degenerate
 * single-chunk-per-file path) get `node_kind: "code"` — generic but still
 * useful for `node_kind`-based filters.
 *
 * @param {Chunk[]} chunks
 * @returns {Chunk[]}
 */
function extractCode(chunks) {
    if (chunks.length === 0) return chunks;
    const language = detectLanguage(chunks[0].metadata.source_uri);
    return chunks.map((chunk, i) => {
        const node_kind = detectCodeKind(chunk.content, language);
        /** @type {StructuralMeta} */
        const structural = {
            heading_path: [],
            node_kind,
            parent_id: null,
            sibling_order: i,
        };
        return {
            ...chunk,
            metadata: {
                ...chunk.metadata,
                structural,
            },
        };
    });
}

/**
 * Enrich a chunker's output with structural metadata, dispatched by
 * `content_type`. Returns chunks unchanged for content types that don't
 * carry hierarchy (`conversation`, `structured`, `spec`).
 *
 * Mixed `content_type` in a single batch is rejected — the extractor runs
 * per-source, and a single source has a single content type. Detecting
 * the mixed case at the boundary surfaces upstream wiring bugs early.
 *
 * @param {Chunk[]} chunks
 * @returns {Chunk[]}
 * @throws {TypeError} On non-array input or mixed `content_type`.
 */
export function extractStructure(chunks) {
    if (!Array.isArray(chunks)) {
        throw new TypeError('extractStructure: chunks must be an array');
    }
    if (chunks.length === 0) return chunks;

    const content_type = chunks[0].metadata.content_type;
    for (let i = 1; i < chunks.length; i++) {
        if (chunks[i].metadata.content_type !== content_type) {
            throw new TypeError(
                `extractStructure: mixed content_type in batch (chunk 0 is "${content_type}", chunk ${i} is "${chunks[i].metadata.content_type}")`,
            );
        }
    }

    if (content_type === 'prose') return extractProse(chunks);
    if (content_type === 'code') return extractCode(chunks);
    return chunks;
}
