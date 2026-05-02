/**
 * Strategy router tests (1.4.17).
 *
 * Covers `js/intelligence/retrieval/router.js` per
 * `docs/DESIGN-retrieval.md` §"Strategy Router": applicability gating,
 * proportional quota allocation, fallback to Semantic when nothing is
 * viable, and `strategies_skipped` reason capture.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. The
 * router is a pure function over `(strategies, req)`; tests build
 * `Strategy`-shaped fakes with deterministic `applies_to`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    selectStrategies,
    DEFAULT_TOTAL_QUOTA,
    DEFAULT_FALLBACK_QUOTA,
    VIABILITY_THRESHOLD,
} from '../js/intelligence/retrieval/router.js';

/* ---------------- Fixture builders ---------------- */

/**
 * Build a `Strategy`-shaped fake that returns the given applicability.
 *
 * @param {string} name
 * @param {number} score
 * @param {string} [reason]
 * @returns {import('../js/intelligence/retrieval/contracts.js').Strategy}
 */
function fakeStrategy(name, score, reason = '') {
    return {
        name,
        applies_to: () => ({ score, reason: reason || `applicability=${score}` }),
        retrieve: async () => [],
    };
}

const baseReq = (overrides = {}) => ({
    task: 'unit-test',
    query: 'authentication middleware design',
    collections: ['docs'],
    budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
    history: null,
    filters: null,
    strategy_hints: null,
    priority_pins: null,
    task_ledger: null,
    ...overrides,
});

/* ---------------- Constants sanity ---------------- */

test('DEFAULT_TOTAL_QUOTA + DEFAULT_FALLBACK_QUOTA are positive integers', () => {
    assert.equal(typeof DEFAULT_TOTAL_QUOTA, 'number');
    assert.ok(DEFAULT_TOTAL_QUOTA > 0);
    assert.equal(typeof DEFAULT_FALLBACK_QUOTA, 'number');
    assert.ok(DEFAULT_FALLBACK_QUOTA > 0);
});

test('VIABILITY_THRESHOLD is 0.3 per design', () => {
    assert.equal(VIABILITY_THRESHOLD, 0.3);
});

/* ---------------- Empty / degenerate inputs ---------------- */

test('empty strategy array returns empty viable + empty skipped', () => {
    const r = selectStrategies([], baseReq());
    assert.deepEqual(r.viable, []);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.usedFallback, false);
});

test('non-array strategies returns empty (defensive)', () => {
    // @ts-expect-error — exercising defensive path
    const r = selectStrategies(null, baseReq());
    assert.deepEqual(r.viable, []);
});

/* ---------------- Single-strategy paths ---------------- */

test('single viable strategy gets full default quota', () => {
    const sem = fakeStrategy('semantic', 0.9, 'has query');
    const r = selectStrategies([sem], baseReq());
    assert.equal(r.viable.length, 1);
    assert.equal(r.viable[0].strategy.name, 'semantic');
    assert.equal(r.viable[0].quota, DEFAULT_TOTAL_QUOTA);
    assert.equal(r.viable[0].applicability.score, 0.9);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.usedFallback, false);
});

test('single non-viable + Semantic in list triggers fallback at 0.5', () => {
    const sem = fakeStrategy('semantic', 0.0, 'no query');
    const r = selectStrategies([sem], baseReq({ query: '' }));
    assert.equal(r.usedFallback, true);
    assert.equal(r.viable.length, 1);
    assert.equal(r.viable[0].strategy.name, 'semantic');
    assert.equal(r.viable[0].quota, DEFAULT_FALLBACK_QUOTA);
    assert.equal(r.viable[0].applicability.score, 0.5);
    assert.equal(r.viable[0].applicability.reason, 'fallback');
    // Semantic with score 0 still appears in skipped — it failed the threshold before fallback.
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'semantic');
});

test('no viable + no Semantic returns empty viable, all skipped', () => {
    const struct = fakeStrategy('structural', 0.0, 'no query');
    const r = selectStrategies([struct], baseReq({ query: '' }));
    assert.equal(r.viable.length, 0);
    assert.equal(r.usedFallback, false);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'structural');
    assert.equal(r.skipped[0].reason, 'no query');
});

/* ---------------- Multi-strategy quota normalization ---------------- */

test('two viable strategies get quotas proportional to applicability', () => {
    const sem = fakeStrategy('semantic', 0.9);
    const struct = fakeStrategy('structural', 0.3);
    const r = selectStrategies([sem, struct], baseReq());
    assert.equal(r.viable.length, 2);
    const semQ = r.viable.find((v) => v.strategy.name === 'semantic').quota;
    const structQ = r.viable.find((v) => v.strategy.name === 'structural').quota;
    // Semantic should get the larger share.
    assert.ok(semQ > structQ, `expected semantic quota (${semQ}) > structural (${structQ})`);
    // Each non-zero (Math.max(1, floor) guarantees floor of 1).
    assert.ok(semQ >= 1);
    assert.ok(structQ >= 1);
    // Sum should not exceed the total quota (floor truncation may leave 1-2 unallocated).
    assert.ok(semQ + structQ <= DEFAULT_TOTAL_QUOTA);
});

test('three viable strategies normalize correctly', () => {
    const a = fakeStrategy('a', 1.0);
    const b = fakeStrategy('b', 1.0);
    const c = fakeStrategy('c', 1.0);
    const r = selectStrategies([a, b, c], baseReq());
    assert.equal(r.viable.length, 3);
    // Equal applicability → equal quotas (modulo floor).
    const quotas = r.viable.map((v) => v.quota);
    assert.equal(quotas[0], quotas[1]);
    assert.equal(quotas[1], quotas[2]);
});

test('mixed viable / non-viable: low-score strategy lands in skipped', () => {
    const sem = fakeStrategy('semantic', 0.9);
    const struct = fakeStrategy('structural', 0.1, 'corpus has no structural meta');
    const r = selectStrategies([sem, struct], baseReq());
    assert.equal(r.viable.length, 1);
    assert.equal(r.viable[0].strategy.name, 'semantic');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].name, 'structural');
    assert.equal(r.skipped[0].score, 0.1);
    assert.equal(r.skipped[0].reason, 'corpus has no structural meta');
});

/* ---------------- Threshold edge cases ---------------- */

test('score = 0.3 exactly is viable (>= threshold)', () => {
    const s = fakeStrategy('semantic', 0.3);
    const r = selectStrategies([s], baseReq());
    assert.equal(r.viable.length, 1);
    assert.equal(r.skipped.length, 0);
});

test('score = 0.29 is below threshold (skipped, fallback to Semantic)', () => {
    const s = fakeStrategy('semantic', 0.29);
    const r = selectStrategies([s], baseReq());
    assert.equal(r.usedFallback, true);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].score, 0.29);
});

/* ---------------- Defensive paths ---------------- */

test('strategy whose applies_to throws is treated as score 0 + skipped', () => {
    const broken = {
        name: 'broken',
        applies_to: () => { throw new Error('boom'); },
        retrieve: async () => [],
    };
    const sem = fakeStrategy('semantic', 0.9);
    const r = selectStrategies([broken, sem], baseReq());
    // Semantic still admits.
    assert.equal(r.viable.length, 1);
    assert.equal(r.viable[0].strategy.name, 'semantic');
    // Broken in skipped with reason "applies_to threw".
    const skip = r.skipped.find((s) => s.name === 'broken');
    assert.ok(skip);
    assert.equal(skip.reason, 'applies_to threw');
});

test('strategy whose applies_to returns null is treated as score 0', () => {
    const nully = {
        name: 'nully',
        applies_to: () => null,
        retrieve: async () => [],
    };
    const sem = fakeStrategy('semantic', 0.9);
    const r = selectStrategies([nully, sem], baseReq());
    assert.equal(r.viable.length, 1);
    const skip = r.skipped.find((s) => s.name === 'nully');
    assert.ok(skip);
    assert.equal(skip.score, 0);
});

test('strategy whose applies_to returns NaN score is treated as 0', () => {
    const nany = fakeStrategy('nany', NaN, 'NaN test');
    const sem = fakeStrategy('semantic', 0.9);
    const r = selectStrategies([nany, sem], baseReq());
    assert.equal(r.viable.length, 1);
    const skip = r.skipped.find((s) => s.name === 'nany');
    assert.ok(skip);
    assert.equal(skip.score, 0);
});

test('strategy missing applies_to is silently dropped', () => {
    const broken = /** @type {any} */ ({ name: 'broken' });
    const sem = fakeStrategy('semantic', 0.9);
    const r = selectStrategies([broken, sem], baseReq());
    assert.equal(r.viable.length, 1);
    assert.equal(r.viable[0].strategy.name, 'semantic');
});

/* ---------------- Quota override ---------------- */

test('opts.totalQuota overrides default for viable path', () => {
    const sem = fakeStrategy('semantic', 0.9);
    const struct = fakeStrategy('structural', 0.3);
    const r = selectStrategies([sem, struct], baseReq(), { totalQuota: 24 });
    const total = r.viable.reduce((acc, v) => acc + v.quota, 0);
    assert.ok(total > DEFAULT_TOTAL_QUOTA, `expected > ${DEFAULT_TOTAL_QUOTA}, got ${total}`);
});

test('opts.fallbackQuota overrides default for fallback path', () => {
    const sem = fakeStrategy('semantic', 0.0, 'no query');
    const r = selectStrategies([sem], baseReq({ query: '' }), { fallbackQuota: 3 });
    assert.equal(r.viable[0].quota, 3);
});
