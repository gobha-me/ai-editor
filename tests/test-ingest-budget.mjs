/**
 * Ingest token-budget cap (2.4.0).
 *
 * Pure-helper coverage for `capByTokenBudget` — the accumulator that
 * replaces the legacy `slice(0, maxIndexFiles)` truncation. Walks
 * an already-ordered file list adding estimated tokens until either
 * the token budget or the file-count safety net closes.
 *
 * Uses `chars/3.5` byte→token math (see
 * `js/intelligence/compression/tokens.js` `estimateTokensFromSize`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    capByTokenBudget,
    DEFAULT_MAX_INDEX_TOKENS,
    DEFAULT_MAX_INDEX_FILES,
} from '../js/intelligence/retrieval/ingest-ordering.js';

/* ---------------- Token budget honored ---------------- */

test('capByTokenBudget stops once the token budget is exceeded', () => {
    // 10 files * 3500 bytes each = 10 files * 1000 tokens = 10000 tokens
    const files = Array.from({ length: 10 }, (_, i) => ({
        path: `f${i}.js`, size: 3500,
    }));
    const out = capByTokenBudget(files, { maxIndexTokens: 3000 });
    // First 3 files = 3000 tokens exactly, the 4th would push us over.
    assert.equal(out.files.length, 3);
    assert.equal(out.estTotalTokens, 3000);
    assert.equal(out.droppedForBudget, 7);
});

test('capByTokenBudget reports estTotalTokens for telemetry', () => {
    const files = [
        { path: 'a.js', size: 350 },
        { path: 'b.js', size: 700 },
    ];
    const out = capByTokenBudget(files, { maxIndexTokens: 10_000 });
    // 350 / 3.5 = 100, 700 / 3.5 = 200, total = 300
    assert.equal(out.estTotalTokens, 300);
    assert.equal(out.files.length, 2);
    assert.equal(out.droppedForBudget, 0);
});

test('capByTokenBudget always includes the first file (degenerate-case guard)', () => {
    // One huge file that alone exceeds the budget.
    const files = [
        { path: 'huge.js', size: 1_000_000 },
        { path: 'b.js',    size: 100 },
    ];
    const out = capByTokenBudget(files, { maxIndexTokens: 100 });
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0].path, 'huge.js');
    assert.equal(out.droppedForBudget, 1);
});

test('capByTokenBudget: zero budget still emits the first file', () => {
    const files = [
        { path: 'a.js', size: 350 },
        { path: 'b.js', size: 350 },
    ];
    // Zero / negative budget treated as default; defensive.
    const out = capByTokenBudget(files, { maxIndexTokens: 0 });
    assert.ok(out.files.length >= 1);
});

/* ---------------- File ceiling honored independently ---------------- */

test('capByTokenBudget honors the file ceiling separately from the token budget', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
        path: `f${i}.js`, size: 35,
    }));
    const out = capByTokenBudget(files, {
        maxIndexTokens: 1_000_000,  // huge, won't fire
        maxIndexFiles: 5,
    });
    assert.equal(out.files.length, 5);
    assert.equal(out.droppedForBudget, 45);
});

test('capByTokenBudget: file ceiling takes precedence when smaller', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
        path: `f${i}.js`, size: 1,
    }));
    const out = capByTokenBudget(files, {
        maxIndexTokens: 1_000_000,
        maxIndexFiles: 10,
    });
    assert.equal(out.files.length, 10);
});

/* ---------------- Defaults ---------------- */

test('capByTokenBudget uses DEFAULT_MAX_INDEX_TOKENS when no settings passed', () => {
    // Build a file just over the default so we observe the boundary.
    const files = [
        { path: 'a.js', size: DEFAULT_MAX_INDEX_TOKENS * 3.5 + 100 },  // > default budget
        { path: 'b.js', size: 100 },
    ];
    const out = capByTokenBudget(files);
    // First-file degenerate-case guard always lets a.js through.
    assert.equal(out.files[0].path, 'a.js');
    // b.js is dropped because we're already over the default budget.
    assert.equal(out.files.length, 1);
});

test('capByTokenBudget exports sensible defaults', () => {
    assert.ok(DEFAULT_MAX_INDEX_TOKENS > 100_000);
    assert.ok(DEFAULT_MAX_INDEX_FILES >= 1000);
});

/* ---------------- Defensive input handling ---------------- */

test('capByTokenBudget: empty file list returns empty result', () => {
    const out = capByTokenBudget([]);
    assert.deepEqual(out.files, []);
    assert.equal(out.droppedForBudget, 0);
    assert.equal(out.estTotalTokens, 0);
});

test('capByTokenBudget: missing size on file treated as 0 tokens', () => {
    const files = [
        { path: 'a.js' },                 // no size
        { path: 'b.js', size: 350 },      // 100 tokens
    ];
    const out = capByTokenBudget(files, { maxIndexTokens: 500 });
    assert.equal(out.files.length, 2);
    assert.equal(out.estTotalTokens, 100);
});

test('capByTokenBudget: null/undefined input returns empty result', () => {
    // @ts-expect-error - defensive on bad caller input
    const out1 = capByTokenBudget(null);
    assert.equal(out1.files.length, 0);
    // @ts-expect-error
    const out2 = capByTokenBudget(undefined);
    assert.equal(out2.files.length, 0);
});

test('capByTokenBudget: negative file ceiling falls back to default', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
        path: `f${i}.js`, size: 35,
    }));
    const out = capByTokenBudget(files, { maxIndexFiles: -1 });
    // Negative => default ceiling => all 3 included.
    assert.equal(out.files.length, 3);
});
