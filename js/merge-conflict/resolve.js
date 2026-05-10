// @ts-check
/**
 * Merge Conflict Resolver — pure resolution applicator.
 *
 * Given the same `baseContent` + `headContent` pair `extractHunks` was run
 * over, plus a `resolutions` map keyed by hunk id, return a single
 * "resolved" file string suitable for writing back to the head branch.
 *
 * Walks the Myers `changes` sequence in lockstep with the hunks: for each
 * equal-line run, copy the base/head content (they match by definition);
 * for each diverged hunk, splice in the chosen side's lines.
 *
 * This must produce the SAME hunk shape `extractHunks` does for the input
 * pair so the `id`s align — we re-run the diff internally rather than
 * accepting the hunks array as input. That avoids a class of bug where a
 * caller hands stale hunks against fresh content.
 *
 * @since 2.18.0 (Touch 3 Merge Conflict Resolver — slice 1)
 *   - 2.19.0 (slice 2): adds `'both'` choice to `applyResolutions`.
 *   - 2.21.0 (slice 3): adds `{choice:'ai', content:string[]}` object form.
 * @module merge-conflict/resolve
 */

import { splitLines, joinLines, extractHunks } from './hunks.js';

/**
 * @typedef {{choice:'ai', content:string[]}} AiResolutionChoice
 * @typedef {'theirs'|'ours'|'both'|AiResolutionChoice} ResolutionChoice
 * @typedef {Object.<number, ResolutionChoice>} Resolutions  Keys are hunk ids.
 *
 * `'both'` (added 2.19.0 — slice 2) emits the theirs lines first, then the
 * ours lines, with no separator. Order matches the design canvas
 * convention; conflict-marker preservation is intentionally out of scope
 * until dogfood asks for it.
 *
 * `{choice:'ai', content:string[]}` (added 2.21.0 — slice 3) emits an
 * arbitrary line array produced by an LLM proposal that the user
 * approved. The surface normalizes equality with the three string
 * choices on approve, so this form only lands when AI output diverges
 * from `theirs` / `ours` / `[...theirs, ...ours]`.
 */

/**
 * Inlined Myers diff (same algorithm as hunks.js — kept private here so
 * resolve.js stays browser-free without a circular import on a shared
 * helper).
 *
 * @param {string[]} a
 * @param {string[]} b
 */
function _myers(a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const v = /** @type {Object.<number, number>} */ ({});
    const trace = /** @type {Array<Object.<number, number>>} */ ([]);

    v[1] = 0;
    for (let d = 0; d <= max; d++) {
        trace.push({ ...v });
        for (let k = -d; k <= d; k += 2) {
            let x;
            if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
                x = v[k + 1];
            } else {
                x = v[k - 1] + 1;
            }
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) { x++; y++; }
            v[k] = x;
            if (x >= n && y >= m) return _back(trace, a, b, d);
        }
    }
    return _back(trace, a, b, max);
}

function _back(trace, a, b, d) {
    const changes = [];
    let x = a.length;
    let y = b.length;
    for (let i = d; i >= 0; i--) {
        const v = trace[i];
        const k = x - y;
        let prevK;
        if (k === -i || (k !== i && v[k - 1] < v[k + 1])) prevK = k + 1;
        else prevK = k - 1;
        const prevX = v[prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            changes.unshift({ type: 'equal', oldLine: x - 1, newLine: y - 1 });
            x--; y--;
        }
        if (i > 0) {
            if (x === prevX) { changes.unshift({ type: 'insert', newLine: y - 1 }); y--; }
            else { changes.unshift({ type: 'delete', oldLine: x - 1 }); x--; }
        }
    }
    return changes;
}

/**
 * Apply per-hunk resolutions to produce a single resolved file string.
 *
 * Throws when:
 *   - `resolutions` is missing an entry for any hunk id (`Incomplete resolutions`).
 *   - A resolution value is not the literal string `'theirs'`, `'ours'`,
 *     `'both'`, or the object form `{choice:'ai', content:string[]}`
 *     (`Unknown resolution choice`).
 *
 * @param {string} baseContent
 * @param {string} headContent
 * @param {Resolutions} resolutions
 * @returns {string}
 */
export function applyResolutions(baseContent, headContent, resolutions) {
    if (baseContent === headContent) return baseContent;

    const baseLines = splitLines(baseContent);
    const headLines = splitLines(headContent);
    const changes = _myers(baseLines, headLines);

    // CRLF coercion for AI-emitted content. The Myers + splitLines/
    // joinLines pipeline carries `\r` through equal-run lines verbatim,
    // but AI content from the LLM arrives as bare strings. Coerce so a
    // CRLF file stays CRLF after an AI splice. Detection is permissive
    // (any CRLF in base or head). The rare "AI hunk at EOF of CRLF file
    // without trailing newline" edge case adds a benign CR at EOF.
    const isCrlf = /\r\n/.test(baseContent) || /\r\n/.test(headContent);

    // Hunk id assignment must match `extractHunks`: id = run index.
    const hunks = extractHunks(baseContent, headContent);
    for (const h of hunks) {
        if (!Object.prototype.hasOwnProperty.call(resolutions, h.id)) {
            throw new Error(`Incomplete resolutions: missing id ${h.id}`);
        }
        const v = resolutions[h.id];
        if (!_isValidChoice(v)) {
            throw new Error(`Unknown resolution choice for id ${h.id}: ${JSON.stringify(v)}`);
        }
    }

    /** @type {string[]} */
    const out = [];
    let i = 0;
    let hunkIdx = 0;

    while (i < changes.length) {
        const c = changes[i];
        if (c.type === 'equal') {
            out.push(baseLines[/** @type {number} */(c.oldLine)]);
            i++;
            continue;
        }
        // Hunk run — gather both sides, then emit per the chosen strategy.
        const choice = resolutions[hunkIdx];
        const start = i;
        while (i < changes.length && changes[i].type !== 'equal') i++;
        /** @type {string[]} */
        const theirsLines = [];
        /** @type {string[]} */
        const oursLines = [];
        for (let j = start; j < i; j++) {
            const cj = changes[j];
            if (cj.type === 'delete') {
                theirsLines.push(baseLines[/** @type {number} */(cj.oldLine)]);
            } else if (cj.type === 'insert') {
                oursLines.push(headLines[/** @type {number} */(cj.newLine)]);
            }
        }
        if (choice === 'theirs') out.push(...theirsLines);
        else if (choice === 'ours') out.push(...oursLines);
        else if (choice === 'both') out.push(...theirsLines, ...oursLines);
        else if (typeof choice === 'object' && choice && choice.choice === 'ai') {
            if (isCrlf) {
                for (const l of choice.content) {
                    out.push(l.endsWith('\r') ? l : l + '\r');
                }
            } else {
                out.push(...choice.content);
            }
        }
        hunkIdx++;
    }

    return joinLines(out);
}

/**
 * @param {*} v
 * @returns {boolean}
 */
function _isValidChoice(v) {
    if (v === 'theirs' || v === 'ours' || v === 'both') return true;
    if (typeof v !== 'object' || v === null) return false;
    if (v.choice !== 'ai') return false;
    if (!Array.isArray(v.content)) return false;
    for (const line of v.content) {
        if (typeof line !== 'string') return false;
    }
    return true;
}

/**
 * Convenience: a resolutions map covering every hunk id with the same
 * choice. Useful for the surface's "Take all theirs" / "Take all ours"
 * affordance (slice-2 candidate, but the helper costs nothing now).
 *
 * @param {ConflictHunk[]} hunks
 * @param {ResolutionChoice} choice
 * @returns {Resolutions}
 */
export function uniformResolutions(hunks, choice) {
    /** @type {Resolutions} */
    const out = {};
    for (const h of hunks) out[h.id] = choice;
    return out;
}

/**
 * @typedef {import('./hunks.js').ConflictHunk} ConflictHunk
 */
