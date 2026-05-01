/**
 * Tests for the cost-store layer (1.2.1).
 *
 * Pure-function aggregation logic over the in-memory localStorage stub
 * from `_node-shim.mjs`. Browser IDB path is exercised in the manual
 * verification per ROADMAP §1.2.1; here we validate the math.
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Storage } from '../js/core.js';
import {
    recordTurn,
    getConvCost,
    removeConvCost,
    getDailyMap,
    getDailySeries,
    getMonthSpend,
    getTodaySpend,
    getBudget,
    setBudget,
    localDateKey,
    daysBetween,
    DAILY_RETENTION_DAYS,
    _resetDaily,
} from '../js/intelligence/cost/cost-store.js';

// ============================================
// helpers
// ============================================

function clearStorage() {
    // Storage maintains its own _cache + persists to localStorage. To
    // wipe between tests, drop everything and let _resetDaily clean
    // the daily key.
    if (typeof globalThis.localStorage?.clear === 'function') {
        globalThis.localStorage.clear();
    }
    // Storage._cache is a Map inside core.js — re-import would be
    // overkill, so bulk-remove the keys we touch.
    Storage.remove('cost-daily');
    Storage.remove('cost-budget');
    for (let i = 0; i < 100; i++) Storage.remove(`cost-by-conv-c${i}`);
}

// Storage.init() is not called — Storage.{get,set,remove} hit the
// in-memory `_cache` Map regardless of whether IDB has been opened, so
// these tests work entirely off the shim's localStorage write-through.

// ============================================
// Date helpers
// ============================================

test('daysBetween counts whole days', () => {
    assert.equal(daysBetween('2026-04-01', '2026-04-10'), 9);
    assert.equal(daysBetween('2026-04-10', '2026-04-01'), -9);
    assert.equal(daysBetween('2026-04-01', '2026-04-01'), 0);
});

test('localDateKey is YYYY-MM-DD', () => {
    const k = localDateKey(new Date('2026-04-29T15:30:00'));
    assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
});

// ============================================
// recordTurn — per-conv aggregation
// ============================================

test('recordTurn aggregates input/output/cost on a conversation', () => {
    clearStorage();
    recordTurn({
        conversationId: 'c1',
        modelId: 'm1',
        provider: 'venice',
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 200,
        reasoningTokens: 0,
        cost: 0.10,
        cacheSavings: 0.02,
        byTool: { read_file: { calls: 1, estTokens: 100 } },
        timestamp: Date.now(),
    });
    recordTurn({
        conversationId: 'c1',
        modelId: 'm1',
        provider: 'venice',
        inputTokens: 2000,
        outputTokens: 800,
        cachedTokens: 0,
        reasoningTokens: 50,
        cost: 0.20,
        cacheSavings: 0,
        byTool: { read_file: { calls: 2, estTokens: 300 }, edit_file: { calls: 1, estTokens: 50 } },
        timestamp: Date.now(),
    });

    const cc = getConvCost('c1');
    assert.ok(cc, 'record exists');
    assert.equal(cc.inputTokens, 3000);
    assert.equal(cc.outputTokens, 1300);
    assert.equal(cc.cachedTokens, 200);
    assert.equal(cc.reasoningTokens, 50);
    assert.ok(Math.abs(cc.cost - 0.30) < 1e-9, `cost=${cc.cost}`);
    assert.equal(cc.requests, 2);
    assert.equal(cc.byTool.read_file.calls, 3);
    assert.equal(cc.byTool.read_file.estTokens, 400);
    assert.equal(cc.byTool.edit_file.calls, 1);
    assert.equal(cc.byModel.m1.tokens, 3000 + 1300);
});

test('recordTurn isolates conversations', () => {
    clearStorage();
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'p',
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.01, cacheSavings: 0, byTool: {},
    });
    recordTurn({
        conversationId: 'c2', modelId: 'm', provider: 'p',
        inputTokens: 200, outputTokens: 100, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.02, cacheSavings: 0, byTool: {},
    });
    const a = getConvCost('c1');
    const b = getConvCost('c2');
    assert.equal(a.cost, 0.01);
    assert.equal(b.cost, 0.02);
    assert.equal(a.requests, 1);
    assert.equal(b.requests, 1);
});

test('recordTurn with no conversationId only updates daily rollup', () => {
    clearStorage();
    recordTurn({
        conversationId: null, modelId: 'm', provider: 'p',
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.05, cacheSavings: 0, byTool: {},
    });
    const today = localDateKey();
    const map = getDailyMap();
    assert.ok(Math.abs(map[today].cost - 0.05) < 1e-9);
    assert.equal(map[today].requests, 1);
});

test('removeConvCost erases the record', () => {
    clearStorage();
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'p',
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.01, cacheSavings: 0, byTool: {},
    });
    assert.ok(getConvCost('c1'));
    removeConvCost('c1');
    assert.equal(getConvCost('c1'), null);
});

// ============================================
// Daily rollup + prune
// ============================================

test('daily rollup sums multiple turns within the day', () => {
    clearStorage();
    const ts = Date.now();
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'venice',
        inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.10, cacheSavings: 0, byTool: {}, timestamp: ts,
    });
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'openrouter',
        inputTokens: 500, outputTokens: 200, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.05, cacheSavings: 0, byTool: {}, timestamp: ts,
    });
    const today = localDateKey(ts);
    const map = getDailyMap();
    assert.ok(Math.abs(map[today].cost - 0.15) < 1e-9);
    assert.equal(map[today].requests, 2);
    assert.equal(map[today].byProvider.venice.cost, 0.10);
    assert.equal(map[today].byProvider.openrouter.cost, 0.05);
});

test('daily prune drops entries older than DAILY_RETENTION_DAYS', () => {
    clearStorage();
    const now = Date.now();
    const oldTs = now - (DAILY_RETENTION_DAYS + 5) * 86400000;
    const recentTs = now - 2 * 86400000;

    // Seed an "old" day directly into the map then write a recent turn —
    // the recent write should prune the old key.
    Storage.set('cost-daily', {
        [localDateKey(oldTs)]: { inputTokens: 1, outputTokens: 1, cost: 0.01, requests: 1, byProvider: {} },
        [localDateKey(recentTs)]: { inputTokens: 1, outputTokens: 1, cost: 0.01, requests: 1, byProvider: {} },
    });
    recordTurn({
        conversationId: null, modelId: 'm', provider: 'p',
        inputTokens: 10, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.005, cacheSavings: 0, byTool: {}, timestamp: now,
    });

    const map = getDailyMap();
    assert.equal(map[localDateKey(oldTs)], undefined, 'old day pruned');
    assert.ok(map[localDateKey(recentTs)], 'recent day survives');
    assert.ok(map[localDateKey(now)], 'today recorded');
});

test('getDailySeries returns a fixed-length window with zero fill', () => {
    clearStorage();
    const now = Date.now();
    recordTurn({
        conversationId: null, modelId: 'm', provider: 'p',
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.10, cacheSavings: 0, byTool: {}, timestamp: now,
    });
    const series = getDailySeries(7, now);
    assert.equal(series.length, 7);
    // The last entry must be today.
    assert.equal(series[series.length - 1].date, localDateKey(now));
    assert.ok(Math.abs(series[series.length - 1].entry.cost - 0.10) < 1e-9);
    // Earlier entries should be zero-filled.
    assert.equal(series[0].entry.cost, 0);
    assert.equal(series[0].entry.requests, 0);
});

test('getMonthSpend sums across days in the same month', () => {
    clearStorage();
    const baseDay = new Date(2026, 3, 5).getTime(); // 2026-04-05 local
    Storage.set('cost-daily', {
        '2026-04-05': { inputTokens: 0, outputTokens: 0, cost: 1.00, requests: 0, byProvider: {} },
        '2026-04-15': { inputTokens: 0, outputTokens: 0, cost: 2.50, requests: 0, byProvider: {} },
        '2026-03-30': { inputTokens: 0, outputTokens: 0, cost: 9.00, requests: 0, byProvider: {} },
    });
    const spend = getMonthSpend(baseDay);
    assert.ok(Math.abs(spend - 3.50) < 1e-9, `spend=${spend}`);
});

test('getTodaySpend reads today only', () => {
    clearStorage();
    const today = localDateKey();
    Storage.set('cost-daily', {
        [today]: { inputTokens: 0, outputTokens: 0, cost: 0.42, requests: 0, byProvider: {} },
    });
    assert.ok(Math.abs(getTodaySpend() - 0.42) < 1e-9);
});

// ============================================
// Budget
// ============================================

test('budget round-trip (default null/null)', () => {
    clearStorage();
    const b1 = getBudget();
    assert.equal(b1.daily, null);
    assert.equal(b1.monthly, null);

    setBudget({ daily: 1.50, monthly: 20 });
    const b2 = getBudget();
    assert.equal(b2.daily, 1.50);
    assert.equal(b2.monthly, 20);
});

test('setBudget rejects non-positive values (treats as null)', () => {
    clearStorage();
    setBudget({ daily: 0, monthly: -5 });
    const b = getBudget();
    assert.equal(b.daily, null);
    assert.equal(b.monthly, null);
});

test('setBudget accepts only-daily / only-monthly', () => {
    clearStorage();
    setBudget({ daily: 2, monthly: null });
    let b = getBudget();
    assert.equal(b.daily, 2);
    assert.equal(b.monthly, null);

    setBudget({ daily: null, monthly: 50 });
    b = getBudget();
    assert.equal(b.daily, null);
    assert.equal(b.monthly, 50);
});

// ============================================
// _resetDaily clears just the rollup
// ============================================

test('_resetDaily clears rollup but per-conv records survive', () => {
    clearStorage();
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'p',
        inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.01, cacheSavings: 0, byTool: {},
    });
    _resetDaily();
    assert.deepEqual(getDailyMap(), {});
    assert.ok(getConvCost('c1'), 'per-conv survives');
});

// ============================================
// 1.3.18 — tool-definition cost recorder fields
// ============================================

test('recordTurn aggregates toolDefTokens / toolDefBaseline / toolDefUnfiltered', () => {
    clearStorage();
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'venice',
        inputTokens: 1000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.10, cacheSavings: 0, byTool: {},
        toolDefTokens: 1500, toolDefBaseline: 5000, toolDefUnfiltered: 10000,
    });
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'venice',
        inputTokens: 2000, outputTokens: 800, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.20, cacheSavings: 0, byTool: {},
        toolDefTokens: 1700, toolDefBaseline: 5000, toolDefUnfiltered: 10000,
    });

    const cc = getConvCost('c1');
    assert.equal(cc.toolDefTokens, 3200);
    assert.equal(cc.toolDefBaseline, 10000);
    assert.equal(cc.toolDefUnfiltered, 20000);

    const today = localDateKey();
    const day = getDailyMap()[today];
    assert.equal(day.toolDefTokens, 3200);
    assert.equal(day.toolDefBaseline, 10000);
    assert.equal(day.toolDefUnfiltered, 20000);
});

test('recordTurn defaults missing tool-def fields to 0 (legacy emitters)', () => {
    clearStorage();
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'p',
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.01, cacheSavings: 0, byTool: {},
        // toolDef* fields intentionally omitted.
    });
    const cc = getConvCost('c1');
    assert.equal(cc.toolDefTokens, 0);
    assert.equal(cc.toolDefBaseline, 0);
    assert.equal(cc.toolDefUnfiltered, 0);
});

test('recordTurn is NaN-safe over legacy on-disk ConvCost (no toolDef fields)', () => {
    clearStorage();
    // Simulate a record written by 1.3.17 or earlier: the new fields
    // are absent on disk. The next recordTurn must NOT yield NaN sums.
    Storage.set('cost-by-conv-c1', {
        id: 'c1',
        inputTokens: 100, outputTokens: 50, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.01, cacheSavings: 0, requests: 1,
        byTool: {}, byModel: {}, firstAt: 1, lastAt: 1,
        // toolDefTokens / toolDefBaseline / toolDefUnfiltered missing
    });
    recordTurn({
        conversationId: 'c1', modelId: 'm', provider: 'p',
        inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.001, cacheSavings: 0, byTool: {},
        toolDefTokens: 100, toolDefBaseline: 500, toolDefUnfiltered: 1000,
    });
    const cc = getConvCost('c1');
    assert.equal(cc.toolDefTokens, 100, 'undefined + 100 must be 100, not NaN');
    assert.equal(cc.toolDefBaseline, 500);
    assert.equal(cc.toolDefUnfiltered, 1000);
    assert.equal(Number.isFinite(cc.toolDefTokens), true);
});

test('recordTurn is NaN-safe over legacy on-disk DailyEntry (no toolDef fields)', () => {
    clearStorage();
    const today = localDateKey();
    // Simulate a daily entry from before 1.3.18.
    Storage.set('cost-daily', {
        [today]: { inputTokens: 100, outputTokens: 50, cost: 0.01, requests: 1, byProvider: {} },
    });
    recordTurn({
        conversationId: null, modelId: 'm', provider: 'p',
        inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0,
        cost: 0.001, cacheSavings: 0, byTool: {},
        toolDefTokens: 200, toolDefBaseline: 1000, toolDefUnfiltered: 2000,
    });
    const day = getDailyMap()[today];
    assert.equal(day.toolDefTokens, 200);
    assert.equal(day.toolDefBaseline, 1000);
    assert.equal(day.toolDefUnfiltered, 2000);
});

test('getDailySeries zero-fills tool-def fields on missing days', () => {
    clearStorage();
    const series = getDailySeries(3);
    assert.equal(series.length, 3);
    for (const { entry } of series) {
        assert.equal(entry.toolDefTokens, 0);
        assert.equal(entry.toolDefBaseline, 0);
        assert.equal(entry.toolDefUnfiltered, 0);
    }
});
