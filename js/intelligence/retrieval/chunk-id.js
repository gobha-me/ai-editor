// @ts-check
/**
 * Deterministic ChunkID hashing.
 *
 * `ChunkID = hash(collection || source_uri || normalized_byte_range || chunker_version)`
 * per DESIGN-retrieval.md §"Chunk Identity and Stability". The hash must be:
 *
 *   - **Deterministic** across runs and across browsers (so a project
 *     indexed today, re-opened tomorrow, finds the same chunks under the
 *     same IDs — that's the whole feedback-survives-re-embed story).
 *   - **Synchronous** — admission and ingest both call this in tight
 *     loops; SubtleCrypto.digest is async-only, which would force the
 *     ingest pipeline to await per chunk.
 *   - **Available with no build step** — vanilla browser JS, no imports,
 *     no Node-only APIs (project constraint).
 *
 * Implementation: the same FNV-1a-twice technique
 * [tool-id.js](./../tools/tool-id.js) uses for `ToolID`. FNV-1a is
 * sufficient for non-cryptographic identity over the address spaces
 * we'll see (collections × sources × chunks-per-source). The dual-pass
 * widens the output to 64 bits so accidental collisions across an
 * indexed workspace stay vanishingly unlikely.
 *
 * If a stronger guarantee becomes needed (e.g. cryptographic feedback
 * audit), this module can swap to an async SubtleCrypto path; callers
 * compute IDs at ingest time, not on the retrieval hot path, so paying
 * an `await` there is acceptable when the day comes.
 *
 * @module intelligence/retrieval/chunk-id
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a UTF-8 byte view of the input. Returns an unsigned
 * 32-bit integer.
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
 * Canonicalize a `[start, end)` byte range to the half-open string form
 * the ChunkID hash consumes. Sorts so a swapped range hashes the same as
 * the canonical one (loaders that report ranges out-of-order shouldn't
 * spawn ghost chunks). Negative values are rejected — they mean a loader
 * bug, not a range to clamp.
 *
 * @param {[number, number]} range
 * @returns {string} `"start..end"` with both numbers as base-10 integers.
 */
export function normalizeByteRange(range) {
    if (!Array.isArray(range) || range.length !== 2) {
        throw new TypeError('normalizeByteRange: expected [start, end] tuple');
    }
    const [a, b] = range;
    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
        throw new TypeError('normalizeByteRange: range bounds must be finite numbers');
    }
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new TypeError('normalizeByteRange: range bounds must be integers');
    }
    if (a < 0 || b < 0) {
        throw new RangeError('normalizeByteRange: range bounds must be non-negative');
    }
    const lo = a <= b ? a : b;
    const hi = a <= b ? b : a;
    return `${lo}..${hi}`;
}

/**
 * Compute a stable ChunkID from
 * `(collection, source_uri, byte_range, chunker_version)`. The four-tuple
 * is joined by NUL bytes so component values containing the literal
 * separator cannot collide via boundary-shifting
 * (`a||b/c` vs `a/b||c`). The hash is computed twice — once over the
 * forward join and once over the reversed join — and concatenated to a
 * 16-character hex string for a 64-bit identity space.
 *
 * @param {Object}             input
 * @param {string}             input.collection       Logical collection name.
 * @param {string}             input.source_uri       Canonical source identifier.
 * @param {[number, number]}   input.byte_range       Half-open `[start, end)` byte range over the source.
 * @param {string}             input.chunker_version  Bumped on chunker logic changes; participates in the ID.
 * @returns {string} 16-character lowercase hex string.
 */
export function computeChunkID({ collection, source_uri, byte_range, chunker_version }) {
    if (typeof collection !== 'string' || collection.length === 0) {
        throw new TypeError('computeChunkID: collection must be a non-empty string');
    }
    if (typeof source_uri !== 'string' || source_uri.length === 0) {
        throw new TypeError('computeChunkID: source_uri must be a non-empty string');
    }
    if (typeof chunker_version !== 'string' || chunker_version.length === 0) {
        throw new TypeError('computeChunkID: chunker_version must be a non-empty string');
    }
    const range = normalizeByteRange(byte_range);
    const sep = '\u0000';
    const fwd = `${collection}${sep}${source_uri}${sep}${range}${sep}${chunker_version}`;
    const rev = `${chunker_version}${sep}${range}${sep}${source_uri}${sep}${collection}`;
    const hi = fnv1a32(fwd).toString(16).padStart(8, '0');
    const lo = fnv1a32(rev).toString(16).padStart(8, '0');
    return hi + lo;
}
