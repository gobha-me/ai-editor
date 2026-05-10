// @ts-check
/**
 * Tests for js/pr-review/diff-parse.js — unified-diff parser
 * + side-by-side pairing + row truncation.
 *
 * @since 2.12.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parsePatch,
    pairSideBySide,
    truncateRows,
    countChanges,
    splitUnifiedDiffByFile,
    DEFAULT_MAX_ROWS_PER_HUNK
} from '../js/pr-review/diff-parse.js';

// ============================================
// parsePatch
// ============================================

test('parsePatch: empty / null / undefined returns empty hunks', () => {
    assert.deepEqual(parsePatch(null), { hunks: [] });
    assert.deepEqual(parsePatch(undefined), { hunks: [] });
    assert.deepEqual(parsePatch(''), { hunks: [] });
});

test('parsePatch: single hunk with context + del + add + context', () => {
    const patch = [
        '@@ -10,4 +10,4 @@',
        ' const x = 1;',
        '-const y = 2;',
        '+const y = 22;',
        ' const z = 3;'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks.length, 1);
    const h = parsed.hunks[0];
    assert.equal(h.oldStart, 10);
    assert.equal(h.newStart, 10);
    assert.equal(h.rows.length, 4);
    assert.deepEqual(h.rows[0], { kind: 'context', l: 10, r: 10, code: 'const x = 1;' });
    assert.deepEqual(h.rows[1], { kind: 'del', l: 11, r: null, code: 'const y = 2;' });
    assert.deepEqual(h.rows[2], { kind: 'add', l: null, r: 11, code: 'const y = 22;' });
    assert.deepEqual(h.rows[3], { kind: 'context', l: 12, r: 12, code: 'const z = 3;' });
});

test('parsePatch: multi-hunk patch tracks each header', () => {
    const patch = [
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '+B',
        '@@ -50,1 +50,2 @@',
        ' x',
        '+y'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks.length, 2);
    assert.equal(parsed.hunks[0].oldStart, 1);
    assert.equal(parsed.hunks[1].oldStart, 50);
    assert.equal(parsed.hunks[1].newStart, 50);
    assert.equal(parsed.hunks[1].rows.length, 2);
});

test('parsePatch: hunk header without count (single line) uses defaults', () => {
    const patch = [
        '@@ -5 +5 @@',
        '-old',
        '+new'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks.length, 1);
    assert.equal(parsed.hunks[0].oldStart, 5);
    assert.equal(parsed.hunks[0].newStart, 5);
});

test('parsePatch: skips "\\ No newline at end of file" markers', () => {
    const patch = [
        '@@ -1,1 +1,1 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks.length, 1);
    assert.equal(parsed.hunks[0].rows.length, 2);
    assert.equal(parsed.hunks[0].rows[0].kind, 'del');
    assert.equal(parsed.hunks[0].rows[1].kind, 'add');
});

test('parsePatch: additions-only hunk (new file or pure insertion)', () => {
    const patch = [
        '@@ -0,0 +1,3 @@',
        '+line one',
        '+line two',
        '+line three'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks[0].rows.length, 3);
    assert.equal(parsed.hunks[0].rows.every(r => r.kind === 'add'), true);
    assert.deepEqual(parsed.hunks[0].rows.map(r => r.r), [1, 2, 3]);
    assert.deepEqual(parsed.hunks[0].rows.map(r => r.l), [null, null, null]);
});

test('parsePatch: deletions-only hunk (file deletion)', () => {
    const patch = [
        '@@ -1,3 +0,0 @@',
        '-line one',
        '-line two',
        '-line three'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks[0].rows.length, 3);
    assert.equal(parsed.hunks[0].rows.every(r => r.kind === 'del'), true);
    assert.deepEqual(parsed.hunks[0].rows.map(r => r.l), [1, 2, 3]);
    assert.deepEqual(parsed.hunks[0].rows.map(r => r.r), [null, null, null]);
});

test('parsePatch: line content preserved verbatim including leading spaces', () => {
    const patch = [
        '@@ -1,2 +1,2 @@',
        ' function foo() {',
        '-    return 1;',
        '+    return 2;',
        ' }'
    ].join('\n');
    const parsed = parsePatch(patch);
    assert.equal(parsed.hunks[0].rows[1].code, '    return 1;');
    assert.equal(parsed.hunks[0].rows[2].code, '    return 2;');
});

// ============================================
// pairSideBySide
// ============================================

test('pairSideBySide: context rows mirror to both sides', () => {
    const rows = [
        { kind: 'context', l: 1, r: 1, code: 'a' },
        { kind: 'context', l: 2, r: 2, code: 'b' }
    ];
    const paired = pairSideBySide(rows);
    assert.equal(paired.length, 2);
    assert.equal(paired[0].left.code, 'a');
    assert.equal(paired[0].right.code, 'a');
    assert.equal(paired[1].left.code, 'b');
    assert.equal(paired[1].right.code, 'b');
});

test('pairSideBySide: equal-length del/add run pairs line-by-line', () => {
    const rows = [
        { kind: 'del', l: 5, r: null, code: 'old1' },
        { kind: 'del', l: 6, r: null, code: 'old2' },
        { kind: 'add', l: null, r: 5, code: 'new1' },
        { kind: 'add', l: null, r: 6, code: 'new2' }
    ];
    const paired = pairSideBySide(rows);
    assert.equal(paired.length, 2);
    assert.equal(paired[0].left.code, 'old1');
    assert.equal(paired[0].right.code, 'new1');
    assert.equal(paired[1].left.code, 'old2');
    assert.equal(paired[1].right.code, 'new2');
});

test('pairSideBySide: del-3 + add-1 leaves trailing dels with null right', () => {
    const rows = [
        { kind: 'del', l: 1, r: null, code: 'a' },
        { kind: 'del', l: 2, r: null, code: 'b' },
        { kind: 'del', l: 3, r: null, code: 'c' },
        { kind: 'add', l: null, r: 1, code: 'X' }
    ];
    const paired = pairSideBySide(rows);
    assert.equal(paired.length, 3);
    assert.equal(paired[0].right.code, 'X');
    assert.equal(paired[1].right, null);
    assert.equal(paired[2].right, null);
    assert.equal(paired[2].left.code, 'c');
});

test('pairSideBySide: del-1 + add-3 leaves trailing adds with null left', () => {
    const rows = [
        { kind: 'del', l: 1, r: null, code: 'X' },
        { kind: 'add', l: null, r: 1, code: 'a' },
        { kind: 'add', l: null, r: 2, code: 'b' },
        { kind: 'add', l: null, r: 3, code: 'c' }
    ];
    const paired = pairSideBySide(rows);
    assert.equal(paired.length, 3);
    assert.equal(paired[0].left.code, 'X');
    assert.equal(paired[1].left, null);
    assert.equal(paired[2].left, null);
    assert.equal(paired[2].right.code, 'c');
});

test('pairSideBySide: pure-add run (no preceding del)', () => {
    const rows = [
        { kind: 'context', l: 1, r: 1, code: 'a' },
        { kind: 'add', l: null, r: 2, code: 'X' },
        { kind: 'add', l: null, r: 3, code: 'Y' }
    ];
    const paired = pairSideBySide(rows);
    assert.equal(paired.length, 3);
    assert.equal(paired[0].left.code, 'a');
    assert.equal(paired[1].left, null);
    assert.equal(paired[1].right.code, 'X');
    assert.equal(paired[2].left, null);
});

test('pairSideBySide: pure-del run (no following add)', () => {
    const rows = [
        { kind: 'del', l: 1, r: null, code: 'X' },
        { kind: 'del', l: 2, r: null, code: 'Y' },
        { kind: 'context', l: 3, r: 1, code: 'a' }
    ];
    const paired = pairSideBySide(rows);
    assert.equal(paired.length, 3);
    assert.equal(paired[0].right, null);
    assert.equal(paired[1].right, null);
    assert.equal(paired[2].right.code, 'a');
});

// ============================================
// truncateRows
// ============================================

test('truncateRows: returns rows unchanged when within cap', () => {
    const rows = [
        { kind: 'context', l: 1, r: 1, code: 'a' },
        { kind: 'context', l: 2, r: 2, code: 'b' }
    ];
    const result = truncateRows(rows, 100);
    assert.equal(result.rows.length, 2);
    assert.equal(result.truncated, 0);
});

test('truncateRows: truncates over-cap rows + reports remainder', () => {
    const rows = Array.from({ length: 750 }, (_, i) => ({
        kind: 'context', l: i + 1, r: i + 1, code: `line ${i}`
    }));
    const result = truncateRows(rows, 500);
    assert.equal(result.rows.length, 500);
    assert.equal(result.truncated, 250);
});

test('truncateRows: default cap is DEFAULT_MAX_ROWS_PER_HUNK', () => {
    const rows = Array.from({ length: DEFAULT_MAX_ROWS_PER_HUNK + 5 }, (_, i) => ({
        kind: 'context', l: i + 1, r: i + 1, code: `x`
    }));
    const result = truncateRows(rows);
    assert.equal(result.rows.length, DEFAULT_MAX_ROWS_PER_HUNK);
    assert.equal(result.truncated, 5);
});

// ============================================
// countChanges
// ============================================

test('countChanges: sums add/del across all hunks', () => {
    const patch = [
        '@@ -1,3 +1,3 @@',
        ' x',
        '-y',
        '+Y',
        ' z',
        '@@ -50,1 +50,3 @@',
        ' a',
        '+b',
        '+c'
    ].join('\n');
    const parsed = parsePatch(patch);
    const counts = countChanges(parsed);
    assert.equal(counts.additions, 3);
    assert.equal(counts.deletions, 1);
});

test('countChanges: empty patch yields zero counts', () => {
    assert.deepEqual(countChanges({ hunks: [] }), { additions: 0, deletions: 0 });
});

// ============================================
// splitUnifiedDiffByFile
// ============================================

test('splitUnifiedDiffByFile: empty / null / undefined returns empty Map', () => {
    assert.equal(splitUnifiedDiffByFile(null).size, 0);
    assert.equal(splitUnifiedDiffByFile(undefined).size, 0);
    assert.equal(splitUnifiedDiffByFile('').size, 0);
});

test('splitUnifiedDiffByFile: single-file diff returns one entry keyed on new path', () => {
    const raw = [
        'diff --git a/js/foo.js b/js/foo.js',
        'index abc..def 100644',
        '--- a/js/foo.js',
        '+++ b/js/foo.js',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    assert.equal(map.size, 1);
    const patch = map.get('js/foo.js');
    assert.ok(patch);
    assert.ok(patch.startsWith('@@ -1,3 +1,3 @@'));
    assert.ok(patch.includes('-b'));
    assert.ok(patch.includes('+B'));
    // Must NOT include the `diff --git`, `index`, `---`, `+++` headers —
    // the caller wants the same shape as a per-file `patch` field.
    assert.ok(!patch.includes('diff --git'));
    assert.ok(!patch.includes('index '));
    assert.ok(!patch.includes('--- a/'));
    assert.ok(!patch.includes('+++ b/'));
});

test('splitUnifiedDiffByFile: multi-file diff returns one entry per file', () => {
    const raw = [
        'diff --git a/a.js b/a.js',
        'index 111..222 100644',
        '--- a/a.js',
        '+++ b/a.js',
        '@@ -1,1 +1,1 @@',
        '-old A',
        '+new A',
        'diff --git a/b.js b/b.js',
        'index 333..444 100644',
        '--- a/b.js',
        '+++ b/b.js',
        '@@ -1,1 +1,1 @@',
        '-old B',
        '+new B'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    assert.equal(map.size, 2);
    assert.ok(map.get('a.js').includes('+new A'));
    assert.ok(map.get('b.js').includes('+new B'));
    // Each file's patch is independent — no cross-file leakage.
    assert.ok(!map.get('a.js').includes('+new B'));
    assert.ok(!map.get('b.js').includes('+new A'));
});

test('splitUnifiedDiffByFile: new-file diff (status: added) keyed on new path', () => {
    const raw = [
        'diff --git a/new.js b/new.js',
        'new file mode 100644',
        'index 000..abc',
        '--- /dev/null',
        '+++ b/new.js',
        '@@ -0,0 +1,2 @@',
        '+line one',
        '+line two'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    assert.equal(map.size, 1);
    assert.ok(map.get('new.js').startsWith('@@ -0,0 +1,2 @@'));
});

test('splitUnifiedDiffByFile: renamed file uses new path as key', () => {
    const raw = [
        'diff --git a/old/path.js b/new/path.js',
        'similarity index 95%',
        'rename from old/path.js',
        'rename to new/path.js',
        '--- a/old/path.js',
        '+++ b/new/path.js',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    assert.equal(map.size, 1);
    assert.ok(map.has('new/path.js'));
    assert.ok(!map.has('old/path.js'));
});

test('splitUnifiedDiffByFile: file with no hunks (e.g., binary or mode-only) is skipped', () => {
    const raw = [
        'diff --git a/binary.png b/binary.png',
        'index 111..222',
        'Binary files a/binary.png and b/binary.png differ',
        'diff --git a/text.js b/text.js',
        '--- a/text.js',
        '+++ b/text.js',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    // Binary file has no @@ hunks → not added to the map; text file is.
    assert.equal(map.size, 1);
    assert.ok(map.has('text.js'));
    assert.ok(!map.has('binary.png'));
});

test('splitUnifiedDiffByFile: filename with spaces still parses', () => {
    const raw = [
        'diff --git a/folder/has space.js b/folder/has space.js',
        '--- a/folder/has space.js',
        '+++ b/folder/has space.js',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    assert.equal(map.size, 1);
    assert.ok(map.has('folder/has space.js'));
});

test('splitUnifiedDiffByFile: output feeds back into parsePatch cleanly', () => {
    const raw = [
        'diff --git a/foo.js b/foo.js',
        '--- a/foo.js',
        '+++ b/foo.js',
        '@@ -10,2 +10,3 @@',
        ' context',
        '-removed',
        '+added one',
        '+added two'
    ].join('\n');
    const map = splitUnifiedDiffByFile(raw);
    const parsed = parsePatch(map.get('foo.js'));
    assert.equal(parsed.hunks.length, 1);
    assert.equal(parsed.hunks[0].oldStart, 10);
    assert.equal(parsed.hunks[0].rows.length, 4);
    assert.equal(parsed.hunks[0].rows.filter(r => r.kind === 'add').length, 2);
    assert.equal(parsed.hunks[0].rows.filter(r => r.kind === 'del').length, 1);
});
