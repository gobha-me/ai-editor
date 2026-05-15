// @ts-check
/**
 * Profile inheritance — deep-merge a profile on top of its `base` chain.
 *
 * Per `docs/DESIGN-profiles.md` §"Inheritance" *"At validation time, the
 * resolved profile is constructed by deep-merging the named profile's
 * overrides on top of the base's values. This is the only profile-
 * composition mechanism; there is no multi-inheritance, no mixin, no
 * late binding."*
 *
 * Failure modes (per DESIGN-profiles.md §"Failure Modes"):
 *   - "Base profile reference cycles" → throws.
 *   - "Profile name unknown to registry" → throws (when a `base` name
 *     does not resolve via the supplied lookup).
 *
 * No registry is built into this helper; the caller passes a `lookup`
 * function so a future `Profiles.get(name)` can be wired in cleanly.
 * Tests pass an in-test map.
 *
 * Pure: input profiles are not mutated; the returned object is fresh.
 *
 * @module profiles/inheritance
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Resolve a profile against its `base` chain.
 *
 * Walks the chain bottom-up — deepest base first — and folds each level's
 * overrides into the accumulator. Plain-object values deep-merge; array
 * values are *replaced wholesale* by the override (per design *"no
 * multi-inheritance"* — a coder profile that wants to extend the base
 * `tools.static` writes the full extended array, it does not append).
 * Primitives in the override replace primitives in the base.
 *
 * The `name`, `version`, and `base` top-level fields of the *outermost*
 * (input) profile are preserved on the resolved object — the caller still
 * gets back a profile labeled with the leaf's identity.
 *
 * @param {Profile} profile               The leaf profile to resolve.
 * @param {(name: string) => Profile|null} lookup  Resolver for `base` names; returns null on miss.
 * @returns {Profile}                     A fresh, fully-merged profile.
 * @throws {Error} On unknown base name or cycle in the base chain.
 */
export function resolveProfile(profile, lookup) {
    if (!profile || typeof profile !== 'object') {
        throw new TypeError('resolveProfile: profile must be an object');
    }
    if (typeof lookup !== 'function') {
        throw new TypeError('resolveProfile: lookup must be a function');
    }

    // Walk the chain leaf → root, recording each profile we visit.
    // Cycle detection uses a Set keyed by the `name` field.
    const chain = [];
    const seen = new Set();
    let cursor = profile;
    while (cursor) {
        if (typeof cursor.name !== 'string' || !cursor.name) {
            throw new Error('resolveProfile: every profile in the chain must declare a string `name`');
        }
        if (seen.has(cursor.name)) {
            throw new Error(`resolveProfile: cycle detected in profile base chain at '${cursor.name}'`);
        }
        seen.add(cursor.name);
        chain.push(cursor);

        const baseName = cursor.base;
        if (baseName == null) break;
        if (typeof baseName !== 'string') {
            throw new TypeError(`resolveProfile: profile '${cursor.name}' has non-string base`);
        }
        const next = lookup(baseName);
        if (!next) {
            throw new Error(`resolveProfile: unknown base profile '${baseName}' referenced by '${cursor.name}'`);
        }
        cursor = next;
    }

    // Fold root → leaf so leaf overrides win.
    let acc = /** @type {Record<string, unknown>} */ ({});
    for (let i = chain.length - 1; i >= 0; i--) {
        acc = mergeDeep(acc, /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (chain[i])));
    }

    // The merged accumulator carries the leaf's name/version/base as a
    // natural consequence of leaf-wins ordering, so no explicit fix-up is
    // needed. Return the typed view.
    return /** @type {Profile} */ (/** @type {unknown} */ (acc));
}

/**
 * Deep-merge `override` onto `base`, returning a fresh object. Plain
 * objects (own enumerable keys, no prototype chain inspection) recurse;
 * arrays in the override fully replace arrays in the base; everything
 * else is replaced verbatim.
 *
 * Treats `null` as a primitive (replaces). `undefined` keys in `override`
 * do not erase keys in `base` — pass an explicit value to override.
 *
 * Special case for the `tools` block (gitea#438 / 2.54.0):
 * `admit_add` and `admit_remove` are inheritance operators that
 * narrow/widen an inherited `admit` array without restating it.
 * Resolution order: (1) base.admit (or [] if absent); (2) subtract
 * override.admit_remove; (3) union override.admit_add. If override
 * also carries a literal `admit` array, that wins wholesale and the
 * operators are warned-then-ignored. The operator keys never appear
 * on the merged output — they're consumed during resolution.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} override
 * @param {string} [parentKey] Path key for context-sensitive merging (internal recursion).
 * @returns {Record<string, unknown>}
 */
function mergeDeep(base, override, parentKey) {
    /** @type {Record<string, unknown>} */
    const out = {};
    // Copy base first.
    for (const k of Object.keys(base)) {
        out[k] = base[k];
    }
    // Apply override.
    for (const k of Object.keys(override)) {
        const ov = override[k];
        if (ov === undefined) continue;
        const bv = out[k];
        if (isPlainObject(bv) && isPlainObject(ov)) {
            out[k] = mergeDeep(
                /** @type {Record<string, unknown>} */ (bv),
                /** @type {Record<string, unknown>} */ (ov),
                k,
            );
        } else {
            // Arrays + primitives + null + dissimilar shapes → replace.
            out[k] = ov;
        }
    }
    // Tools-block admit operators — applied AFTER the literal merge so
    // admit_add / admit_remove reference the inherited base.admit.
    if (parentKey === 'tools') {
        applyAdmitOperators(out, base, override);
    }
    return out;
}

/**
 * Apply `admit_add` / `admit_remove` operators to the merged tools block.
 * Mutates `out` in place (already a fresh object from mergeDeep).
 * Strips operator keys from the output regardless of whether they fired.
 *
 * @param {Record<string, unknown>} out      Merged tools block (mutated).
 * @param {Record<string, unknown>} base     Inherited tools block.
 * @param {Record<string, unknown>} override Child's tools overrides.
 */
function applyAdmitOperators(out, base, override) {
    const hasLiteralAdmit = Array.isArray(override.admit);
    const addOp = override.admit_add;
    const removeOp = override.admit_remove;
    const hasOps = Array.isArray(addOp) || Array.isArray(removeOp);

    // Operator keys never persist on the merged output.
    delete out.admit_add;
    delete out.admit_remove;

    if (hasLiteralAdmit) {
        if (hasOps) {
            console.warn(
                '[profiles/inheritance] admit_add/admit_remove ignored because override declares literal admit; operators are only honored when narrowing/widening an inherited list',
            );
        }
        // Literal admit already won via mergeDeep's array-replace.
        return;
    }
    if (!hasOps) return;

    const inherited = Array.isArray(base.admit) ? /** @type {string[]} */ (base.admit) : [];
    const removeSet = new Set(Array.isArray(removeOp) ? /** @type {string[]} */ (removeOp) : []);
    const addList = Array.isArray(addOp) ? /** @type {string[]} */ (addOp) : [];
    /** @type {Set<string>} */
    const next = new Set();
    for (const name of inherited) if (!removeSet.has(name)) next.add(name);
    for (const name of addList) next.add(name);
    out.admit = Array.from(next);
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}
