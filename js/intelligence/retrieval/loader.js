// @ts-check
/**
 * Loader — the source-fetching seam of the retrieval ingest pipeline.
 *
 * Per [`docs/DESIGN-retrieval.md`](../../../../docs/DESIGN-retrieval.md)
 * §"Ingest Pipeline" lines 273-275:
 *
 *   > Fetches raw source. One loader per source kind. Loaders return
 *   > `(bytes, source_uri, content_hash, content_type_hint)`. They do
 *   > not interpret content — that is the chunker's job.
 *
 * Sits between the file walker (the controller's job at 1.4.23) and the
 * chunker pipeline shipped at 1.4.19. The pipeline maps a `LoadedSource`
 * directly into a `ChunkerInput`; the chunk store (1.4.20) consumes the
 * `content_hash` via `setSourceHash` to make subsequent ingests
 * incremental.
 *
 * **Phase-1 scope decisions** (called out so future readers don't have
 * to reverse-engineer them from behavior):
 *
 *   1. **Single factory, not three.** The "one loader per source kind"
 *      design line resolves at the *call site*, not in this module.
 *      `createLoader` takes a `fetchBytes` callback so the caller wires
 *      it to whichever byte source is appropriate — `Git.getFile(...)`
 *      for production, an in-memory `Map` for tests, an MCP fetcher for
 *      a hypothetical plugin source. Mirrors the DI pattern the strategies
 *      use for `embedQuery` (1.4.15) and `getChunkByID` (1.4.16, 1.4.17).
 *
 *   2. **Stateless across `load()` calls.** No internal cache. Caller
 *      controls freshness; the chunk store caches embeddings keyed by
 *      `content_hash`, which is the right level for re-ingest economy.
 *
 *   3. **No binary detection in Phase 1.** The walker (1.4.23) is the
 *      right boundary — `IgnoreManager.isIgnored` already filters
 *      production paths. If `fetchBytes` returns binary-as-string the
 *      chunkers produce noise but don't crash; a binary-rejection helper
 *      can ship at 1.4.23 if measurement shows it's needed.
 *
 *   4. **Unknown extension throws, doesn't default to prose.** Loaders
 *      fail loudly on accidental wire-up of unsupported types — mirrors
 *      `runChunkerPipeline`'s rejection of unknown `content_type`. The
 *      caller decides what to do: skip the source, supply a
 *      `contentTypeOverride`, or surface a diagnostic.
 *
 *   5. **No file-size limit.** The 250KB legacy ceiling lives in the
 *      walker, not at this seam. The Loader returns whatever
 *      `fetchBytes` gives it.
 *
 *   6. **`content_hash` algorithm: FNV-1a-twice.** Same as `chunk-id.js`
 *      (the change-detection fingerprint is non-cryptographic — what the
 *      design's incremental-ingest protocol needs is "different bytes →
 *      different hash with overwhelming probability," nothing more). The
 *      FNV routine is inlined here rather than imported from
 *      `chunk-id.js` because that module's `fnv1a32` is private; promotion
 *      to a shared util is deferred until a third consumer appears,
 *      matching the inline-cosine decision from 1.4.20's store.
 *
 * **Out of scope for 1.4.21:**
 *   - File-system / Git-tree walking (1.4.23 controller).
 *   - Production wire-up to `Git.getFile(...)` (1.4.23 controller).
 *   - BM25 index construction (`tokenizeBM25` is exported from
 *     [`strategies/semantic.js`](./strategies/semantic.js); the producer
 *     ships between 1.4.22 and 1.5.1).
 *   - Concurrency / retry / backoff (controller's job).
 *   - Migration of `find_relevant_files` off `js/context-manager.js`
 *     — ✓ shipped at 1.5.14 (legacy module retired in the same cutover).
 *   - `spec` content_type — deferred past Phase 1 per the design's
 *     §"Chunker" table; this module does not produce `"spec"` hints.
 *
 * **Production wiring (since 1.5.14):** `createProductionLoader`
 * (`./wiring.js`) wraps `createLoader` for the retrieval Manager;
 * deleting this module would break ingest. Removability is inverted.
 *
 * @module intelligence/retrieval/loader
 */

/**
 * @typedef {import('./contracts.js').ContentType} ContentType
 * @typedef {import('./contracts.js').LoadedSource} LoadedSource
 */

/**
 * Public Loader handle. Returned by `createLoader`. Single async method
 * matching the design's contract: input is a source URI, output is the
 * four-tuple `(bytes, source_uri, content_hash, content_type_hint)`
 * shaped as a plain object.
 *
 * @typedef {Object} Loader
 * @property {(source_uri: string) => Promise<LoadedSource>} load
 */

/**
 * Options to `createLoader`.
 *
 * @typedef {Object} LoaderOptions
 * @property {(source_uri: string) => Promise<string>}                 fetchBytes            Required. Resolves to the source's raw UTF-8 bytes.
 * @property {((source_uri: string) => (ContentType|null))|undefined} [contentTypeOverride] Optional. Returns a non-null `ContentType` to override extension-based detection; `null` falls through to extension detection.
 */

/* ---------------- Extension → content_type ---------------- */

/**
 * Phase 1 extension table. Originally mirrored the legacy
 * `js/context-manager.js` mapping (retired at 1.5.14); kept here for the
 * subset of content types the shipped chunkers handle:
 *
 *   - `code`: JS/TS family + Python.
 *   - `prose`: Markdown + plain-text + reStructuredText.
 *   - `structured`: JSON + JSONL/NDJSON.
 *
 * `conversation` has no extension assignment — callers always supply it
 * via `contentTypeOverride` (the URI is typically `memory://session/...`)
 * or via `metadata.custom.format` at the chunker layer. `spec` is deferred
 * past Phase 1.
 *
 * Keys are lowercase, no leading dot. Lookup is case-insensitive (see
 * `extractExtension`).
 *
 * @type {Readonly<Object<string, ContentType>>}
 */
const CONTENT_TYPE_BY_EXTENSION = Object.freeze({
    js: 'code',
    mjs: 'code',
    cjs: 'code',
    jsx: 'code',
    ts: 'code',
    tsx: 'code',
    py: 'code',
    pyw: 'code',
    pyi: 'code',
    // C-family extensions admitted in 1.7.0 alongside the brace-depth-aware
    // chunker in `chunkers/code-chunker.js#findCFamilyBoundaries`.
    c: 'code',
    cc: 'code',
    cpp: 'code',
    cxx: 'code',
    h: 'code',
    hh: 'code',
    hpp: 'code',
    hxx: 'code',
    md: 'prose',
    markdown: 'prose',
    txt: 'prose',
    rst: 'prose',
    json: 'structured',
    jsonl: 'structured',
    ndjson: 'structured',
});

/**
 * Pull the extension off a source URI. Strips a query string and fragment
 * before looking for the last dot in the path component, so
 * `memory://x.json?v=1#frag` resolves to `json`. Returns `null` if no
 * extension is present (no dot, or the dot is at the start of the
 * basename — a dotfile like `.gitignore` has no extension).
 *
 * Pure string manipulation; no `URL` parsing because source URIs include
 * non-URL forms in tests (e.g. bare paths) and `URL` rejects those.
 *
 * @param {string} source_uri
 * @returns {string|null} Lowercase extension without leading dot.
 */
function extractExtension(source_uri) {
    const queryAt = source_uri.indexOf('?');
    const fragAt = source_uri.indexOf('#');
    let end = source_uri.length;
    if (queryAt !== -1) end = Math.min(end, queryAt);
    if (fragAt !== -1) end = Math.min(end, fragAt);
    const path = source_uri.slice(0, end);
    const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
    const dot = basename.lastIndexOf('.');
    if (dot <= 0 || dot === basename.length - 1) return null;
    return basename.slice(dot + 1).toLowerCase();
}

/**
 * Map a source URI to its Phase-1 `ContentType` based on extension. Pure
 * function — no I/O, no async. Returns `null` when the URI has no
 * extension or the extension isn't in the Phase-1 table; the caller
 * (typically `createLoader`) decides whether that's a hard error or a
 * cue to consult a `contentTypeOverride`.
 *
 * Exposed independently of `createLoader` because the controller (1.4.23)
 * may want to filter the walker's output by content type before invoking
 * `load()` — having the dispatch logic available as a pure helper lets
 * callers compose without instantiating a Loader.
 *
 * @param {string} source_uri
 * @returns {ContentType|null}
 */
export function detectContentType(source_uri) {
    if (typeof source_uri !== 'string' || source_uri.length === 0) return null;
    const ext = extractExtension(source_uri);
    if (ext === null) return null;
    return CONTENT_TYPE_BY_EXTENSION[ext] ?? null;
}

/* ---------------- Source-level content hash ---------------- */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a UTF-8 byte view of the input. Inlined from
 * `chunk-id.js`'s private `fnv1a32` rather than imported (the source
 * module does not export it; promotion to a shared util is deferred
 * until a third consumer appears).
 *
 * @param {string} s
 * @returns {number}
 */
function fnv1a32(s) {
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
    return h >>> 0;
}

/**
 * Compute a stable source-level content hash for the design's
 * incremental-ingest protocol (DESIGN-retrieval lines 313-316). FNV-1a-twice
 * — once forward, once reversed — joined as a 16-character hex string.
 * Non-cryptographic; "different bytes → different hash with overwhelming
 * probability" is the only requirement.
 *
 * Empty `bytes` returns a fixed sentinel so `getSourceHash` round-trips
 * across an empty source (the chunker pipeline already short-circuits on
 * `bytes.length === 0`, so an empty source produces zero chunks but a
 * valid hash entry).
 *
 * @param {string} bytes
 * @returns {string} 16-character lowercase hex string.
 */
export function computeSourceHash(bytes) {
    if (typeof bytes !== 'string') {
        throw new TypeError('computeSourceHash: bytes must be a string');
    }
    if (bytes.length === 0) return '0000000000000000';
    const hi = fnv1a32(bytes).toString(16).padStart(8, '0');
    // Reverse pass widens the output to 64 bits and breaks symmetry under
    // boundary-shifting payloads — same technique chunk-id.js uses.
    let reversed = '';
    for (let i = bytes.length - 1; i >= 0; i--) reversed += bytes[i];
    const lo = fnv1a32(reversed).toString(16).padStart(8, '0');
    return hi + lo;
}

/* ---------------- Factory ---------------- */

/**
 * Construct a Loader. The returned handle exposes a single async `load`
 * method matching the design's `(source_uri) → (bytes, source_uri,
 * content_hash, content_type_hint)` contract.
 *
 * `fetchBytes` is the integration seam. Callers wire it to whichever
 * byte source is appropriate:
 *
 *   - Production: `(uri) => Git.getFile(...)` (controller at 1.4.23).
 *   - Tests: `(uri) => Promise.resolve(map.get(uri))` over a fixture map.
 *   - Plugin sources: `(uri) => mcpClient.fetch(uri)` etc.
 *
 * `contentTypeOverride`, when provided, is consulted before extension-
 * based detection. A non-null return value wins; `null` falls back to
 * `detectContentType(source_uri)`. Useful for `memory://session/...`
 * URIs (no extension) and for forcing `conversation` on JSON-serialized
 * `HistoryTurn[]` payloads.
 *
 * @param {LoaderOptions} options
 * @returns {Loader}
 */
export function createLoader(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createLoader: options must be an object');
    }
    const { fetchBytes, contentTypeOverride } = options;
    if (typeof fetchBytes !== 'function') {
        throw new TypeError('createLoader: fetchBytes must be a function');
    }
    if (contentTypeOverride !== undefined && typeof contentTypeOverride !== 'function') {
        throw new TypeError('createLoader: contentTypeOverride must be a function when provided');
    }

    return {
        async load(source_uri) {
            if (typeof source_uri !== 'string' || source_uri.length === 0) {
                throw new TypeError('createLoader.load: source_uri must be a non-empty string');
            }
            const overridden = contentTypeOverride ? contentTypeOverride(source_uri) : null;
            const content_type_hint = overridden ?? detectContentType(source_uri);
            if (content_type_hint == null) {
                throw new TypeError(
                    `createLoader.load: unknown content_type for source_uri ${JSON.stringify(source_uri)}`,
                );
            }
            const bytes = await fetchBytes(source_uri);
            if (typeof bytes !== 'string') {
                throw new TypeError(
                    `createLoader.load: fetchBytes must resolve to a string (got ${typeof bytes})`,
                );
            }
            const content_hash = computeSourceHash(bytes);
            return { bytes, source_uri, content_hash, content_type_hint };
        },
    };
}
