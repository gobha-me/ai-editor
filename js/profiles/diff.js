// @ts-check
/**
 * Profile diffing — structured object differ for `Profile` objects.
 *
 * NOT to be confused with [`js/editor/diff.js`](../editor/diff.js), which
 * is a line-based *string* differ for the editor's diff view. Different
 * shape entirely: that one walks `\n`-split arrays index-aligned; this
 * one walks structured objects and reports field-level deltas.
 *
 * Edge-case policy mirrors `mergeDeep` in
 * [`./inheritance.js`](./inheritance.js) byte-for-byte so a resolved-mode
 * diff never lies about what `resolveProfile` would have produced:
 *
 *   - `undefined` keys in either side are *absent* (mirrors merger
 *     line 118: `if (ov === undefined) continue;`).
 *   - Plain objects on both sides recurse.
 *   - Arrays — or any side-shape mismatch (object vs primitive, etc.) —
 *     replace wholesale (mirrors merger lines 126-128). Emitted as a
 *     single `'array_replaced'` entry, never element-wise diffs.
 *   - `null` is a primitive (mirrors merger), so null↔value is
 *     `'changed'`, not `'removed'`.
 *
 * Entry order is deterministic: depth-first traversal with keys
 * lexicographically sorted at every object level. Fixture diffs in the
 * regression harness are stable across runs.
 *
 * @module profiles/diff
 */

import { resolveProfile } from './inheritance.js';

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 *
 * @typedef {Object} ProfileDiffEntry
 * @property {string[]} path                                  Property path, e.g. `['compression', 'preserve_recent']`. Empty array means the diff sits at the root.
 * @property {'added'|'removed'|'changed'|'array_replaced'} kind
 * @property {unknown} [before]                               Value on side A (omitted when `kind === 'added'`).
 * @property {unknown} [after]                                Value on side B (omitted when `kind === 'removed'`).
 *
 * @typedef {Object} ProfileDiff
 * @property {string} nameA
 * @property {string} nameB
 * @property {'raw'|'resolved'} mode
 * @property {ProfileDiffEntry[]} entries
 * @property {boolean} equal                                  Convenience: `entries.length === 0`.
 *
 * @typedef {Object} DiffOptions
 * @property {'raw'|'resolved'} [mode]                        Default `'resolved'`. In raw mode the differ walks the inputs as-is; in resolved mode each side is `resolveProfile(input, lookup)`-merged first.
 * @property {(name: string) => Profile|null} [lookup]        Required when `mode === 'resolved'`. Typically `Profiles.get`.
 * @property {string[]} [ignorePaths]                         Dot-paths to suppress (e.g. `['name', 'version']` when comparing across profile identities).
 */

/**
 * Diff two profiles. Returns a structured delta plus a convenience
 * `equal` flag.
 *
 * Resolved mode is the default because resolved profiles describe what
 * the runtime actually sees — that's the load-bearing contract from
 * 2.0.0 onward (see [`./resolve.js`](./resolve.js)). Raw mode preserves
 * the leaf-author-intent view (which fields a profile *explicitly*
 * overrides) and is what the future "advanced view" picker UI in 2.0.x
 * stabilization will consume.
 *
 * @param {Profile} profileA
 * @param {Profile} profileB
 * @param {DiffOptions} [options]
 * @returns {ProfileDiff}
 */
export function diffProfiles(profileA, profileB, options = {}) {
    const mode = options.mode || 'resolved';
    const ignore = new Set(options.ignorePaths || []);

    let a = profileA;
    let b = profileB;
    if (mode === 'resolved') {
        if (typeof options.lookup !== 'function') {
            throw new TypeError(
                "diffProfiles: options.lookup is required when mode === 'resolved'",
            );
        }
        a = resolveProfile(profileA, options.lookup);
        b = resolveProfile(profileB, options.lookup);
    }

    /** @type {ProfileDiffEntry[]} */
    const entries = [];
    walkDiff(a, b, [], entries, ignore);

    return {
        nameA: nameOf(a),
        nameB: nameOf(b),
        mode,
        entries,
        equal: entries.length === 0,
    };
}

/**
 * @param {unknown} av
 * @param {unknown} bv
 * @param {string[]} path
 * @param {ProfileDiffEntry[]} entries
 * @param {Set<string>} ignore
 */
function walkDiff(av, bv, path, entries, ignore) {
    if (ignore.has(path.join('.'))) return;

    const aDefined = av !== undefined;
    const bDefined = bv !== undefined;

    if (!aDefined && !bDefined) return;
    if (!aDefined) {
        entries.push({ path: path.slice(), kind: 'added', after: bv });
        return;
    }
    if (!bDefined) {
        entries.push({ path: path.slice(), kind: 'removed', before: av });
        return;
    }

    if (isPlainObject(av) && isPlainObject(bv)) {
        const a = /** @type {Record<string, unknown>} */ (av);
        const b = /** @type {Record<string, unknown>} */ (bv);
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of [...keys].sort()) {
            walkDiff(a[k], b[k], [...path, k], entries, ignore);
        }
        return;
    }

    if (deepEqual(av, bv)) return;

    if (Array.isArray(av) || Array.isArray(bv)) {
        entries.push({ path: path.slice(), kind: 'array_replaced', before: av, after: bv });
    } else {
        entries.push({ path: path.slice(), kind: 'changed', before: av, after: bv });
    }
}

/**
 * Render a diff to a human-readable markdown string. Used by the
 * regression harness to make failure messages self-explanatory and by
 * any future UI consumer that wants to surface a profile delta.
 *
 * Array entries follow a simple readability heuristic: when both sides
 * are length ≤ 3, the full JSON is inlined; otherwise just the lengths
 * are shown. Threshold pinned at 3 because the load-bearing array
 * fields in profiles (e.g. `compression.rules`, `tools.static` for
 * chat.v1) are tiny — inlining them is cheap and informative — while
 * coder.v1's `tools.static` (~26 entries) would dominate the failure
 * message if inlined.
 *
 * @param {ProfileDiff} diff
 * @returns {string}
 */
export function formatProfileDiff(diff) {
    const lines = [];
    lines.push(`# Profile diff: ${diff.nameA} → ${diff.nameB} (mode: ${diff.mode})`);
    lines.push('');

    if (diff.equal) {
        lines.push('_No differences._');
        return lines.join('\n');
    }

    /** @type {Map<ProfileDiffEntry['kind'], ProfileDiffEntry[]>} */
    const grouped = new Map();
    for (const entry of diff.entries) {
        if (!grouped.has(entry.kind)) grouped.set(entry.kind, []);
        /** @type {ProfileDiffEntry[]} */ (grouped.get(entry.kind)).push(entry);
    }

    /** @type {ProfileDiffEntry['kind'][]} */
    const ORDER = ['added', 'removed', 'changed', 'array_replaced'];
    for (const kind of ORDER) {
        const items = grouped.get(kind) || [];
        if (items.length === 0) continue;
        lines.push(`## ${kind} (${items.length})`);
        for (const entry of items) {
            const p = entry.path.length === 0 ? '<root>' : entry.path.join('.');
            switch (entry.kind) {
                case 'added':
                    lines.push(`- \`${p}\`: ${formatValue(entry.after)}`);
                    break;
                case 'removed':
                    lines.push(`- \`${p}\`: ${formatValue(entry.before)}`);
                    break;
                case 'changed':
                    lines.push(`- \`${p}\`: ${formatValue(entry.before)} → ${formatValue(entry.after)}`);
                    break;
                case 'array_replaced':
                    lines.push(`- \`${p}\`: ${formatArrayChange(entry.before, entry.after)}`);
                    break;
            }
        }
        lines.push('');
    }

    return lines.join('\n').replace(/\n+$/, '');
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function formatValue(v) {
    if (v === undefined) return '_undefined_';
    if (v === null) return '`null`';
    if (typeof v === 'string') return `\`"${v}"\``;
    if (typeof v === 'number' || typeof v === 'boolean') return `\`${v}\``;
    if (Array.isArray(v)) {
        if (v.length <= 3) return `\`${JSON.stringify(v)}\``;
        return `[array len=${v.length}]`;
    }
    if (typeof v === 'object' && v !== null) {
        const keys = Object.keys(/** @type {Record<string, unknown>} */ (v));
        return `{object keys=${keys.length}}`;
    }
    return `\`${String(v)}\``;
}

/**
 * @param {unknown} before
 * @param {unknown} after
 */
function formatArrayChange(before, after) {
    const beforeArr = Array.isArray(before) ? before : null;
    const afterArr = Array.isArray(after) ? after : null;

    if (beforeArr && afterArr && beforeArr.length <= 3 && afterArr.length <= 3) {
        return `\`${JSON.stringify(beforeArr)}\` → \`${JSON.stringify(afterArr)}\``;
    }
    const lenA = beforeArr ? beforeArr.length : '?';
    const lenB = afterArr ? afterArr.length : '?';
    return `[array len=${lenA}] → [array len=${lenB}]`;
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

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    if (Array.isArray(b)) return false;
    const ao = /** @type {Record<string, unknown>} */ (a);
    const bo = /** @type {Record<string, unknown>} */ (b);
    const keysA = Object.keys(ao);
    const keysB = Object.keys(bo);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
        if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
        if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function nameOf(v) {
    if (v && typeof v === 'object' && 'name' in v) {
        const n = /** @type {{name: unknown}} */ (v).name;
        if (typeof n === 'string') return n;
    }
    return '<unknown>';
}
