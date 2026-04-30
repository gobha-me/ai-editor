// @ts-check
/**
 * Deterministic ToolID hashing.
 *
 * `ToolID = hash(profile_namespace || canonical_name || version)` per
 * DESIGN-tools.md §"Tool Identity and Stability". The hash must be:
 *
 *   - **Deterministic** across runs and across browsers (so audit logs
 *     written today resolve tomorrow).
 *   - **Synchronous** — admission decisions happen on the LLM-call hot
 *     path; we cannot await SubtleCrypto. (SubtleCrypto.digest is the
 *     "obvious" choice but is async-only.)
 *   - **Available with no build step** — vanilla browser JS, no imports,
 *     no Node-only APIs.
 *
 * Implementation: a small synchronous FNV-1a 32-bit hash applied twice
 * (over the canonical input and over the rotated input), concatenated to
 * 16 hex characters. FNV-1a is sufficient for non-cryptographic identity
 * — it has good avalanche over short inputs and no surprising collisions
 * within the address space we'll see (≤200 tools per profile).
 *
 * The dual-pass widens the output to 64 bits so accidental collisions
 * across the catalog are vanishingly unlikely. If a stronger guarantee
 * becomes needed (e.g. cryptographic audit), this module can swap to an
 * async SubtleCrypto path; callers compute the ID once at registration.
 *
 * @module intelligence/tools/tool-id
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over a UTF-8 byte view of the input. Returns an unsigned
 * 32-bit integer (Math.imul keeps us in int32 land; `>>> 0` re-casts to
 * unsigned for the hex string).
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
 * Compute a stable ToolID from `(profile_namespace, canonical_name,
 * version)`. The triple is joined by NUL bytes so namespaces and names
 * cannot collide via boundary-shifting (`a||bc` vs `ab||c`).
 *
 * @param {string} profile_namespace  e.g. `"coder"` for `coder.v1`.
 * @param {string} canonical_name     The tool's registry key, e.g. `"read_file"`.
 * @param {string} version            Tool's metadata version, e.g. `"1"`.
 * @returns {string} 16-character lowercase hex string.
 */
export function computeToolID(profile_namespace, canonical_name, version) {
    if (typeof profile_namespace !== 'string' || profile_namespace.length === 0) {
        throw new Error('computeToolID: profile_namespace must be a non-empty string');
    }
    if (typeof canonical_name !== 'string' || canonical_name.length === 0) {
        throw new Error('computeToolID: canonical_name must be a non-empty string');
    }
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error('computeToolID: version must be a non-empty string');
    }
    const sep = '\u0000';
    const fwd = `${profile_namespace}${sep}${canonical_name}${sep}${version}`;
    const rev = `${version}${sep}${canonical_name}${sep}${profile_namespace}`;
    const hi = fnv1a32(fwd).toString(16).padStart(8, '0');
    const lo = fnv1a32(rev).toString(16).padStart(8, '0');
    return hi + lo;
}
