// @ts-check
/**
 * PR Review — unified-diff parser + side-by-side pairing.
 *
 * Pure module. Parses the `patch` strings returned by
 * `Git.getPullRequestFiles()` (Gitea + GitHub return the same
 * unified-diff format) into a structure the surface can render
 * either unified (rows in order) or side-by-side (left/right pairs).
 *
 * The existing `js/editor/diff.js#computeSimpleDiff` is a different
 * shape (line-by-line, no hunks, no patch input) — used for in-chat
 * edit proposals. PR diffs need hunk + patch awareness, so this is
 * a separate parser.
 *
 * @since 2.12.0 (Touch 3 PR Review surface — slice 1)
 * @module pr-review/diff-parse
 */

/**
 * @typedef {Object} DiffRow
 * @property {'context'|'add'|'del'} kind
 * @property {number|null} l   - Old-file line number (null on add rows)
 * @property {number|null} r   - New-file line number (null on del rows)
 * @property {string} code     - The line content without the leading marker
 */

/**
 * @typedef {Object} DiffHunk
 * @property {string} header   - Original `@@ -... +... @@` header line
 * @property {number} oldStart
 * @property {number} newStart
 * @property {DiffRow[]} rows
 */

/**
 * @typedef {Object} ParsedPatch
 * @property {DiffHunk[]} hunks
 */

/**
 * @typedef {Object} SideRow
 * @property {DiffRow|null} left   - Old-side cell (null = blank, e.g. addition)
 * @property {DiffRow|null} right  - New-side cell (null = blank, e.g. deletion)
 */

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Default per-hunk row cap. Huge files (5k+ lines changed) would
 * otherwise block the main thread on render. 500 covers > 95% of
 * real review-sized hunks; the renderer surfaces a "N more rows"
 * placeholder for the remainder.
 */
export const DEFAULT_MAX_ROWS_PER_HUNK = 500;

/**
 * Parse a unified-diff `patch` string into hunks + rows.
 *
 * Empty / null / undefined patch returns `{ hunks: [] }`.
 * Lines beginning with `\` (e.g. "\ No newline at end of file") are
 * silently skipped — they don't carry a row in either side.
 *
 * @param {string|null|undefined} patch
 * @returns {ParsedPatch}
 */
export function parsePatch(patch) {
    if (!patch) return { hunks: [] };
    const lines = patch.split('\n');
    /** @type {DiffHunk[]} */
    const hunks = [];
    /** @type {DiffHunk|null} */
    let current = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
        const headerMatch = line.match(HUNK_HEADER_RE);
        if (headerMatch) {
            if (current) hunks.push(current);
            const oldStart = parseInt(headerMatch[1], 10);
            const newStart = parseInt(headerMatch[3], 10);
            current = { header: line, oldStart, newStart, rows: [] };
            oldLine = oldStart;
            newLine = newStart;
            continue;
        }
        if (!current) continue;
        const ch = line.charAt(0);
        const code = line.slice(1);
        if (ch === '+') {
            current.rows.push({ kind: 'add', l: null, r: newLine, code });
            newLine++;
        } else if (ch === '-') {
            current.rows.push({ kind: 'del', l: oldLine, r: null, code });
            oldLine++;
        } else if (ch === ' ') {
            current.rows.push({ kind: 'context', l: oldLine, r: newLine, code });
            oldLine++;
            newLine++;
        } else if (ch === '\\') {
            // "\ No newline at end of file" — affects the previous row's
            // semantics but doesn't render its own line.
        } else if (line === '') {
            // Trailing blank line in patch buffer — ignore.
        }
    }
    if (current) hunks.push(current);
    return { hunks };
}

/**
 * Pair a hunk's rows for side-by-side rendering.
 *
 * Algorithm: walk the rows. Context rows mirror to both sides.
 * For del/add runs: collect all consecutive dels then all consecutive
 * adds, then pair them line-by-line. Excess rows on either side
 * fill against `null` cells. Pure adds (no preceding del) and pure
 * dels (no following add) lay out asymmetrically.
 *
 * Why not Myers-grade alignment? Side-by-side is a presentation aid,
 * not the source of truth — the underlying patch is unchanged. Pairing
 * adjacent del/add by index covers the common rename/edit case;
 * git itself already separated the rows. Token-level intra-line diff
 * is a slice-2+ enhancement.
 *
 * @param {DiffRow[]} rows
 * @returns {SideRow[]}
 */
export function pairSideBySide(rows) {
    /** @type {SideRow[]} */
    const paired = [];
    let i = 0;
    while (i < rows.length) {
        const row = rows[i];
        if (row.kind === 'context') {
            paired.push({ left: row, right: row });
            i++;
            continue;
        }
        if (row.kind === 'del' || row.kind === 'add') {
            /** @type {DiffRow[]} */
            const dels = [];
            while (i < rows.length && rows[i].kind === 'del') {
                dels.push(rows[i]);
                i++;
            }
            /** @type {DiffRow[]} */
            const adds = [];
            while (i < rows.length && rows[i].kind === 'add') {
                adds.push(rows[i]);
                i++;
            }
            const max = Math.max(dels.length, adds.length);
            for (let j = 0; j < max; j++) {
                paired.push({
                    left: dels[j] || null,
                    right: adds[j] || null
                });
            }
            continue;
        }
        // Defensive: unknown row kind — skip, don't infinite-loop.
        i++;
    }
    return paired;
}

/**
 * Cap the visible-row count of a hunk. Returns the kept rows plus a
 * `truncated` count the caller renders as a "N more rows" placeholder.
 *
 * @param {DiffRow[]} rows
 * @param {number} [max=DEFAULT_MAX_ROWS_PER_HUNK]
 * @returns {{ rows: DiffRow[], truncated: number }}
 */
export function truncateRows(rows, max = DEFAULT_MAX_ROWS_PER_HUNK) {
    if (rows.length <= max) return { rows, truncated: 0 };
    return { rows: rows.slice(0, max), truncated: rows.length - max };
}

/**
 * Split a raw multi-file unified diff (the kind returned by
 * `GET /repos/{o}/{r}/pulls/{n}.diff` on Gitea or by GitHub's
 * `application/vnd.github.v3.diff` media type) into per-file patches.
 *
 * Returns a Map keyed on the *new* filename (`b/<path>` from the
 * `diff --git` header). The patch value contains the full per-file
 * section including the `@@` hunk headers — the same shape that
 * `parsePatch` consumes — so the caller can use it as a drop-in
 * replacement for an absent `file.patch` field.
 *
 * Used by the PR Review surface as the always-works fallback when the
 * structured PR-files endpoint omits patch text (Gitea quirk: large
 * PRs return null per-file `patch` even though the unified diff
 * endpoint always works).
 *
 * @param {string|null|undefined} rawDiff
 * @returns {Map<string, string>}  filename → patch text (just the hunks)
 */
export function splitUnifiedDiffByFile(rawDiff) {
    /** @type {Map<string, string>} */
    const out = new Map();
    if (!rawDiff) return out;
    // Split on `^diff --git ` boundaries; first chunk is empty unless
    // the diff begins with something else, so always slice(1).
    const sections = rawDiff.split(/^diff --git /m).slice(1);
    for (const section of sections) {
        const headerLine = section.split('\n', 1)[0];
        const m = headerLine.match(/a\/(.+?) b\/(.+)/);
        if (!m) continue;
        const filename = m[2];
        // Keep only hunk content — discard the `index <sha>..<sha>`,
        // mode lines, and the `--- a/` / `+++ b/` markers. Caller
        // wants the same shape as a per-file `patch` string.
        const lines = section.split('\n');
        const patchLines = [];
        let inHunk = false;
        for (const line of lines) {
            if (line.startsWith('@@')) {
                inHunk = true;
                patchLines.push(line);
            } else if (inHunk) {
                // Stop at the next `diff --git` (shouldn't happen since we
                // pre-split, but defensive).
                if (line.startsWith('diff --git ')) break;
                patchLines.push(line);
            }
        }
        if (patchLines.length > 0) {
            out.set(filename, patchLines.join('\n'));
        }
    }
    return out;
}

/**
 * Sum additions / deletions across a parsed patch — used by the file
 * tree row to render `+N −M` counts when the file's `additions` /
 * `deletions` aren't supplied separately by the provider.
 *
 * @param {ParsedPatch} parsed
 * @returns {{ additions: number, deletions: number }}
 */
export function countChanges(parsed) {
    let additions = 0;
    let deletions = 0;
    for (const hunk of parsed.hunks) {
        for (const row of hunk.rows) {
            if (row.kind === 'add') additions++;
            else if (row.kind === 'del') deletions++;
        }
    }
    return { additions, deletions };
}
