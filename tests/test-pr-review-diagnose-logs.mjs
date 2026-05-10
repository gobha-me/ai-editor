// @ts-check
/**
 * Tests for the PR Review "Diagnose & fix" log helpers.
 *
 * Pins:
 *   - concatJobLogs: deterministic ordering, separator format,
 *     skips empty/null logs, defensive on non-array inputs.
 *   - tailTruncate: keeps the tail (CI failures cluster at end),
 *     prepends a marker on truncation, no-ops under cap, defensive
 *     on non-string inputs.
 *
 * @since 2.14.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    concatJobLogs,
    tailTruncate,
    DEFAULT_LOG_CAP_BYTES,
} from '../js/pr-review/diagnose-logs.js';

// ============================================
// concatJobLogs
// ============================================

test('concatJobLogs: single job — header + log', () => {
    const out = concatJobLogs([{ id: 1, name: 'unit', log: 'ok\n' }]);
    assert.match(out, /^=== job: unit ===\n\nok\n$/);
});

test('concatJobLogs: two jobs joined with double-newline', () => {
    const out = concatJobLogs([
        { id: 1, name: 'a', log: 'AAA' },
        { id: 2, name: 'b', log: 'BBB' },
    ]);
    assert.equal(out, '=== job: a ===\n\nAAA\n\n=== job: b ===\n\nBBB');
});

test('concatJobLogs: deterministic across input orderings (sort by id)', () => {
    const sorted = [
        { id: 1, name: 'a', log: 'AAA' },
        { id: 2, name: 'b', log: 'BBB' },
        { id: 3, name: 'c', log: 'CCC' },
    ];
    const shuffled = [sorted[2], sorted[0], sorted[1]];
    assert.equal(concatJobLogs(shuffled), concatJobLogs(sorted));
});

test('concatJobLogs: skips jobs with empty/null/missing logs', () => {
    const out = concatJobLogs([
        { id: 1, name: 'a', log: '' },
        { id: 2, name: 'b', log: null },
        { id: 3, name: 'c' },
        { id: 4, name: 'd', log: 'D' },
    ]);
    assert.equal(out, '=== job: d ===\n\nD');
});

test('concatJobLogs: missing job name → defaults to "job"', () => {
    const out = concatJobLogs([{ id: 1, log: 'X' }]);
    assert.equal(out, '=== job: job ===\n\nX');
});

test('concatJobLogs: defensive on non-array input', () => {
    assert.equal(concatJobLogs(null), '');
    assert.equal(concatJobLogs(undefined), '');
    assert.equal(concatJobLogs('not-an-array'), '');
    assert.equal(concatJobLogs({}), '');
});

test('concatJobLogs: empty array → empty string', () => {
    assert.equal(concatJobLogs([]), '');
});

test('concatJobLogs: all jobs filtered out → empty string', () => {
    assert.equal(concatJobLogs([{ id: 1, log: '' }, { id: 2, log: null }]), '');
});

// ============================================
// tailTruncate
// ============================================

test('tailTruncate: under cap → no truncation', () => {
    const r = tailTruncate('hello', 100);
    assert.equal(r.text, 'hello');
    assert.equal(r.truncatedAtCap, false);
    assert.equal(r.totalBytes, 5);
});

test('tailTruncate: at cap → no truncation (boundary)', () => {
    const s = 'x'.repeat(100);
    const r = tailTruncate(s, 100);
    assert.equal(r.truncatedAtCap, false);
    assert.equal(r.text.length, 100);
});

test('tailTruncate: over cap → keeps tail with marker', () => {
    // 200 bytes input, cap 50 → keep last 50 + marker
    const s = 'a'.repeat(100) + 'b'.repeat(100);
    const r = tailTruncate(s, 50);
    assert.equal(r.truncatedAtCap, true);
    assert.equal(r.totalBytes, 200);
    // Tail is 50 'b's; head dropped includes the 'a's.
    assert.match(r.text, /^\[\.\.\. 150 bytes truncated from head \.\.\.\]\n\n/);
    assert.ok(r.text.endsWith('b'.repeat(50)));
});

test('tailTruncate: defensive on non-string input', () => {
    const r = tailTruncate(null, 50);
    assert.equal(r.text, '');
    assert.equal(r.truncatedAtCap, false);
    assert.equal(r.totalBytes, 0);
});

test('tailTruncate: zero/negative cap → falls back to default', () => {
    const r = tailTruncate('hi', 0);
    assert.equal(r.text, 'hi');
    assert.equal(r.truncatedAtCap, false);
    assert.equal(DEFAULT_LOG_CAP_BYTES > 0, true);
});

test('tailTruncate: NaN/Infinity cap → falls back to default', () => {
    const a = tailTruncate('hi', NaN);
    const b = tailTruncate('hi', Infinity);
    assert.equal(a.truncatedAtCap, false);
    assert.equal(b.truncatedAtCap, false);
});
