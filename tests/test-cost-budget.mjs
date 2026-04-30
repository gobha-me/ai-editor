/**
 * Tests for the budget threshold helpers (1.2.1).
 *
 * Pure functions — no IO; no shim required.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    checkThresholds,
    pickWorse,
    WARN_THRESHOLD,
    OVER_THRESHOLD,
} from '../js/intelligence/cost/budget.js';

test('null/zero cap is always ok', () => {
    assert.equal(checkThresholds(0, null).level, 'ok');
    assert.equal(checkThresholds(100, null).level, 'ok');
    assert.equal(checkThresholds(100, 0).level, 'ok');
    assert.equal(checkThresholds(100, -1).level, 'ok');
});

test('below WARN_THRESHOLD is ok', () => {
    const cap = 10;
    assert.equal(checkThresholds(cap * 0.5, cap).level, 'ok');
    assert.equal(checkThresholds(cap * (WARN_THRESHOLD - 0.01), cap).level, 'ok');
});

test('at WARN_THRESHOLD is warn', () => {
    const cap = 10;
    assert.equal(checkThresholds(cap * WARN_THRESHOLD, cap).level, 'warn');
    assert.equal(checkThresholds(cap * 0.85, cap).level, 'warn');
    assert.equal(checkThresholds(cap * (OVER_THRESHOLD - 0.01), cap).level, 'warn');
});

test('at or above OVER_THRESHOLD is over', () => {
    const cap = 10;
    assert.equal(checkThresholds(cap * OVER_THRESHOLD, cap).level, 'over');
    assert.equal(checkThresholds(cap * 1.5, cap).level, 'over');
    assert.equal(checkThresholds(cap * 5, cap).level, 'over');
});

test('checkThresholds echoes spend and cap', () => {
    const r = checkThresholds(8, 10);
    assert.equal(r.spend, 8);
    assert.equal(r.cap, 10);
    assert.equal(r.percent, 0.8);
});

test('pickWorse returns over when monthly is over and daily is ok', () => {
    const daily = checkThresholds(1, 10);     // 10% — ok
    const monthly = checkThresholds(50, 40);  // 125% — over
    const w = pickWorse({ daily, monthly });
    assert.equal(w.level, 'over');
    assert.equal(w.reason, 'monthly');
});

test('pickWorse returns warn when daily is warn and monthly is ok', () => {
    const daily = checkThresholds(8.5, 10);   // 85% — warn
    const monthly = checkThresholds(2, 100);  // 2% — ok
    const w = pickWorse({ daily, monthly });
    assert.equal(w.level, 'warn');
    assert.equal(w.reason, 'daily');
});

test('pickWorse picks the worse of two warns by recovering monthly when monthly is over', () => {
    const daily = checkThresholds(8.5, 10);   // warn
    const monthly = checkThresholds(105, 100); // over
    const w = pickWorse({ daily, monthly });
    assert.equal(w.level, 'over');
    assert.equal(w.reason, 'monthly');
});

test('pickWorse all-ok returns ok with reason null', () => {
    const daily = checkThresholds(1, 10);
    const monthly = checkThresholds(2, 100);
    const w = pickWorse({ daily, monthly });
    assert.equal(w.level, 'ok');
    assert.equal(w.reason, null);
});
