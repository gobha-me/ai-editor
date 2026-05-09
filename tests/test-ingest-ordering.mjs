/**
 * Ingest ordering — sort + extension-scan fallback (2.4.0).
 *
 * Pure-helper coverage for `js/intelligence/retrieval/ingest-ordering.js`:
 * sort stability, unknown-extension treatment, empty inputs, and the
 * extension-scan fallback that kicks in when no upstream language
 * stats are available. Token-budget cap lives in
 * `tests/test-ingest-budget.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    sortFilesByLanguageWeight,
    extensionScanFallback,
    orderByLanguageStats,
} from '../js/intelligence/retrieval/ingest-ordering.js';

/* ---------------- sortFilesByLanguageWeight ---------------- */

test('sort puts higher-weight language files first', () => {
    const files = [
        { path: 'a.py',  size: 100 },
        { path: 'b.js',  size: 100 },
        { path: 'c.py',  size: 100 },
    ];
    const langs = [
        { language: 'JavaScript', weight: 0.7, extensions: ['.js'] },
        { language: 'Python',     weight: 0.3, extensions: ['.py'] },
    ];
    const out = sortFilesByLanguageWeight(files, langs);
    assert.equal(out[0].path, 'b.js');
    assert.equal(out[1].path, 'a.py');
    assert.equal(out[2].path, 'c.py');
});

test('sort is stable within a language (preserves original index on tie)', () => {
    const files = [
        { path: 'd.py',  size: 100 },
        { path: 'a.py',  size: 100 },
        { path: 'c.py',  size: 100 },
        { path: 'b.py',  size: 100 },
    ];
    const langs = [
        { language: 'Python', weight: 1.0, extensions: ['.py'] },
    ];
    const out = sortFilesByLanguageWeight(files, langs);
    assert.deepEqual(out.map(f => f.path), ['d.py', 'a.py', 'c.py', 'b.py']);
});

test('sort: files with unknown extensions sort to end but are not dropped', () => {
    const files = [
        { path: 'a.xyz', size: 100 },
        { path: 'b.js',  size: 100 },
        { path: 'c.foo', size: 100 },
    ];
    const langs = [
        { language: 'JavaScript', weight: 1.0, extensions: ['.js'] },
    ];
    const out = sortFilesByLanguageWeight(files, langs);
    assert.equal(out.length, 3);
    assert.equal(out[0].path, 'b.js');
    // Unknown-extension files retain original order behind known files.
    assert.deepEqual(out.slice(1).map(f => f.path), ['a.xyz', 'c.foo']);
});

test('sort: empty langs preserves tree order', () => {
    const files = [
        { path: 'a.py',  size: 100 },
        { path: 'b.js',  size: 100 },
    ];
    const out1 = sortFilesByLanguageWeight(files, []);
    assert.deepEqual(out1.map(f => f.path), ['a.py', 'b.js']);
    // @ts-expect-error - defensive on bad input
    const out2 = sortFilesByLanguageWeight(files, null);
    assert.deepEqual(out2.map(f => f.path), ['a.py', 'b.js']);
});

test('sort: empty files returns an empty array (does not throw)', () => {
    assert.deepEqual(sortFilesByLanguageWeight([], []), []);
    assert.deepEqual(
        sortFilesByLanguageWeight([], [{ language: 'X', weight: 1, extensions: ['.x'] }]),
        [],
    );
});

test('sort: returns a new array, does not mutate input', () => {
    const files = [
        { path: 'a.py', size: 100 },
        { path: 'b.js', size: 100 },
    ];
    const original = files.slice();
    const langs = [{ language: 'JavaScript', weight: 1.0, extensions: ['.js'] }];
    sortFilesByLanguageWeight(files, langs);
    assert.deepEqual(files, original);
});

test('sort: respects multi-extension languages (first occurrence wins)', () => {
    const files = [
        { path: 'a.tsx', size: 100 },
        { path: 'b.py',  size: 100 },
        { path: 'c.ts',  size: 100 },
    ];
    const langs = [
        { language: 'TypeScript', weight: 0.8, extensions: ['.ts', '.tsx'] },
        { language: 'Python',     weight: 0.2, extensions: ['.py'] },
    ];
    const out = sortFilesByLanguageWeight(files, langs);
    // Both .ts and .tsx are TypeScript, should both come before Python.
    assert.equal(out[2].path, 'b.py');
    assert.ok(['a.tsx', 'c.ts'].includes(out[0].path));
    assert.ok(['a.tsx', 'c.ts'].includes(out[1].path));
});

/* ---------------- extensionScanFallback ---------------- */

test('extensionScanFallback weights sum to ~1', () => {
    const files = [
        { path: 'a.js', size: 100 },
        { path: 'b.js', size: 100 },
        { path: 'c.py', size: 50 },
    ];
    const out = extensionScanFallback(files);
    const sum = out.reduce((s, e) => s + e.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `expected sum ~= 1, got ${sum}`);
});

test('extensionScanFallback: dominant language is first', () => {
    const files = [
        { path: 'a.js', size: 1000 },
        { path: 'b.js', size: 1000 },
        { path: 'c.py', size: 50 },
    ];
    const out = extensionScanFallback(files);
    assert.equal(out[0].language, 'JavaScript');
    assert.ok(out[0].weight > out[1].weight);
});

test('extensionScanFallback groups multiple extensions under the same language', () => {
    const files = [
        { path: 'a.js',  size: 100 },
        { path: 'b.mjs', size: 100 },
        { path: 'c.cjs', size: 100 },
    ];
    const out = extensionScanFallback(files);
    assert.equal(out.length, 1);
    assert.equal(out[0].language, 'JavaScript');
    assert.ok(out[0].extensions.includes('.js'));
    assert.ok(out[0].extensions.includes('.mjs'));
    assert.ok(out[0].extensions.includes('.cjs'));
});

test('extensionScanFallback: unknown extension produces a synthetic Other entry', () => {
    const files = [
        { path: 'a.foo', size: 100 },
        { path: 'b.js',  size: 100 },
    ];
    const out = extensionScanFallback(files);
    const other = out.find(e => e.language.startsWith('Other'));
    assert.ok(other, 'expected an Other (.foo) entry');
    assert.deepEqual(other.extensions, ['.foo']);
});

test('extensionScanFallback: missing size treated as 1 byte (file count drives ordering)', () => {
    const files = [
        { path: 'a.js' },
        { path: 'b.js' },
        { path: 'c.py' },
    ];
    const out = extensionScanFallback(files);
    // 2 .js files vs 1 .py file -> JavaScript dominant.
    assert.equal(out[0].language, 'JavaScript');
});

test('extensionScanFallback: files without extension contribute nothing', () => {
    const files = [
        { path: 'Makefile',   size: 1000 },
        { path: 'Dockerfile', size: 1000 },
        { path: 'a.js',       size: 100 },
    ];
    const out = extensionScanFallback(files);
    assert.equal(out.length, 1);
    assert.equal(out[0].language, 'JavaScript');
});

test('extensionScanFallback: empty input returns empty array', () => {
    assert.deepEqual(extensionScanFallback([]), []);
    // @ts-expect-error
    assert.deepEqual(extensionScanFallback(null), []);
});

/* ---------------- orderByLanguageStats orchestrator ---------------- */

test('orderByLanguageStats uses provider stats when available', async () => {
    const files = [
        { path: 'a.py', size: 100 },
        { path: 'b.js', size: 100 },
    ];
    const getLanguages = async () => [
        { language: 'JavaScript', weight: 0.9, extensions: ['.js'] },
        { language: 'Python',     weight: 0.1, extensions: ['.py'] },
    ];
    const result = await orderByLanguageStats(files, { owner: 'o', repo: 'r' }, getLanguages);
    assert.equal(result.source, 'provider');
    assert.equal(result.files[0].path, 'b.js');
});

test('orderByLanguageStats falls back to extension scan on null', async () => {
    const files = [
        { path: 'a.py', size: 100 },
        { path: 'b.py', size: 100 },
        { path: 'c.js', size: 50 },
    ];
    const getLanguages = async () => null;
    const result = await orderByLanguageStats(files, { owner: 'o', repo: 'r' }, getLanguages);
    assert.equal(result.source, 'fallback');
    assert.equal(result.files[0].path, 'a.py');
});

test('orderByLanguageStats falls back on getLanguages throw', async () => {
    const files = [
        { path: 'a.js', size: 100 },
    ];
    const getLanguages = async () => { throw new Error('network'); };
    const result = await orderByLanguageStats(files, { owner: 'o', repo: 'r' }, getLanguages);
    assert.equal(result.source, 'fallback');
    assert.equal(result.files.length, 1);
});

test('orderByLanguageStats handles missing getLanguages callback', async () => {
    const files = [
        { path: 'a.js', size: 100 },
    ];
    // @ts-expect-error - callable not provided
    const result = await orderByLanguageStats(files, { owner: 'o', repo: 'r' }, null);
    assert.equal(result.source, 'fallback');
});

test('orderByLanguageStats: source=none for files without extensions', async () => {
    const files = [
        { path: 'Makefile',   size: 100 },
        { path: 'Dockerfile', size: 100 },
    ];
    const getLanguages = async () => null;
    const result = await orderByLanguageStats(files, { owner: 'o', repo: 'r' }, getLanguages);
    assert.equal(result.source, 'none');
    assert.equal(result.files.length, 2);
});
