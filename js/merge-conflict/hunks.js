// @ts-check
/**
 * Merge Conflict Resolver — pure hunk extractor.
 *
 * Given two text contents (the base branch's version and the head branch's
 * version of the same file), return a list of "conflict hunks" — regions
 * where the two diverge — in the shape the surface renders.
 *
 * v1 trade-off: this is a 2-way diff (base ↔ head), not a true 3-way merge
 * (no merge-base leg). The user picks Take theirs / Take ours per hunk to
 * reconcile divergences before commit. A future slice graduates this to
 * diff3 with the merge-base ref so cases where head diverged AFTER base
 * picked up an upstream change can be detected as conflicts the user would
 * otherwise silently overwrite.
 *
 * Browser-free: inlines a minimal Myers diff so the module has no
 * `js/core.js` transitive dependency and runs under `node --test`
 * without the shim.
 *
 * @since 2.18.0 (Touch 3 Merge Conflict Resolver — slice 1)
 * @module merge-conflict/hunks
 */

/**
 * @typedef {Object} ConflictHunk
 * @property {number}   id      Stable index, 0-based.
 * @property {number}   lineNo  1-based line number in `baseContent` where the
 *                              hunk's first divergence appears. For
 *                              insert-only hunks (theirs is empty), this is
 *                              the line *after* which the new lines would be
 *                              inserted on the base side.
 * @property {string[]} theirs  Lines from `baseContent` that diverge here
 *                              (empty for pure-insert hunks).
 * @property {string[]} ours    Lines from `headContent` that diverge here
 *                              (empty for pure-delete hunks).
 */

/**
 * Split text into an array of lines preserving the trailing-newline
 * distinction (`"a\nb\n".split('\n') === ['a','b','']` round-trips back to
 * the original via `.join('\n')`).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
    if (text == null) return [];
    return String(text).split('\n');
}

/**
 * Re-join lines using `\n`. Inverse of `splitLines` for any input.
 *
 * @param {string[]} lines
 * @returns {string}
 */
export function joinLines(lines) {
    return lines.join('\n');
}

/**
 * Myers diff (industry-standard line-level). Returns a flat sequence of
 * `{type: 'equal'|'insert'|'delete', oldLine?, newLine?}`.
 *
 * Same algorithm as `js/diff-viewer.js#myersDiff` — inlined here so this
 * module stays browser-free.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{type:'equal'|'insert'|'delete', oldLine?:number, newLine?:number}>}
 */
function myersDiff(a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    /** @type {Object.<number, number>} */
    const v = {};
    /** @type {Array<Object.<number, number>>} */
    const trace = [];

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
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[k] = x;
            if (x >= n && y >= m) {
                return _backtrack(trace, a, b, d);
            }
        }
    }
    return _backtrack(trace, a, b, max);
}

function _backtrack(trace, a, b, d) {
    /** @type {Array<{type:'equal'|'insert'|'delete', oldLine?:number, newLine?:number}>} */
    const changes = [];
    let x = a.length;
    let y = b.length;

    for (let i = d; i >= 0; i--) {
        const v = trace[i];
        const k = x - y;

        let prevK;
        if (k === -i || (k !== i && v[k - 1] < v[k + 1])) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        const prevX = v[prevK];
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
            changes.unshift({ type: 'equal', oldLine: x - 1, newLine: y - 1 });
            x--;
            y--;
        }

        if (i > 0) {
            if (x === prevX) {
                changes.unshift({ type: 'insert', newLine: y - 1 });
                y--;
            } else {
                changes.unshift({ type: 'delete', oldLine: x - 1 });
                x--;
            }
        }
    }
    return changes;
}

/**
 * Walk a Myers `changes` sequence and group consecutive non-`equal`
 * entries into hunk runs. Yielded as `[start, end)` half-open intervals.
 *
 * @param {Array<{type:string}>} changes
 * @returns {Array<[number, number]>}
 */
function _hunkRuns(changes) {
    const runs = [];
    let i = 0;
    while (i < changes.length) {
        if (changes[i].type === 'equal') {
            i++;
            continue;
        }
        const start = i;
        while (i < changes.length && changes[i].type !== 'equal') i++;
        runs.push([start, i]);
    }
    return runs;
}

/**
 * Extract conflict hunks from a base-vs-head 2-way diff.
 *
 * Edge cases:
 *   - Identical files → returns `[]`.
 *   - Pure-insert hunk (head adds lines base doesn't have): `theirs = []`,
 *     `lineNo` points to the position after the preceding equal line on
 *     the base side (`prevEqualOldLine + 2`, 1-based).
 *   - Pure-delete hunk (head removes lines base has): `ours = []`.
 *   - Empty input strings: treated as zero-length file (no hunks).
 *
 * @param {string} baseContent  File content on the merge target branch.
 * @param {string} headContent  File content on the merge source branch.
 * @returns {ConflictHunk[]}
 */
export function extractHunks(baseContent, headContent) {
    const baseLines = splitLines(baseContent);
    const headLines = splitLines(headContent);

    if (baseContent === headContent) return [];

    const changes = myersDiff(baseLines, headLines);
    const runs = _hunkRuns(changes);

    return runs.map(([start, end], idx) => {
        /** @type {string[]} */
        const theirs = [];
        /** @type {string[]} */
        const ours = [];
        let firstOldLine = -1;

        for (let j = start; j < end; j++) {
            const c = changes[j];
            if (c.type === 'delete') {
                if (firstOldLine < 0) firstOldLine = /** @type {number} */(c.oldLine);
                theirs.push(baseLines[/** @type {number} */(c.oldLine)]);
            } else if (c.type === 'insert') {
                ours.push(headLines[/** @type {number} */(c.newLine)]);
            }
        }

        // Pure-insert hunk: anchor `lineNo` to the line *after* the
        // preceding equal change (1-based). When the run starts at
        // index 0 with no preceding equal, anchor at line 1.
        if (firstOldLine < 0) {
            let anchor = 0;
            for (let j = start - 1; j >= 0; j--) {
                if (changes[j].type === 'equal') {
                    anchor = /** @type {number} */(changes[j].oldLine) + 1;
                    break;
                }
            }
            firstOldLine = anchor;
        }

        return {
            id: idx,
            lineNo: firstOldLine + 1,
            theirs,
            ours,
        };
    });
}
