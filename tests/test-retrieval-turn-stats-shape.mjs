// @ts-check
/**
 * Anti-regression test for the `retrieval:turn-stats` EventBus payload
 * shape contract.
 *
 * Origin: `RE-EVAL following 2.52.0` ICD #5 code-aware finding (b2) — the
 * producer at `js/intelligence/retrieval/manager.js` emits this event from
 * two call sites and the consumer at `js/intelligence/cost/cost-recorder.js`
 * reads it, with no shape pin between them. A rename on either side would
 * silently lose per-strategy cost attribution.
 *
 * Mirrors the 2.50.0 `tests/test-provider-capabilities-shape.mjs` idiom:
 * the producer-side seam (`_emitTurnStats`) and consumer-side listener
 * (`_onRetrievalTurnStats`) both call through `validateTurnStatsPayload`
 * — this test pins that validator.
 *
 * @since 2.62.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TURN_STATS_REQUIRED_KEYS,
    TURN_STATS_OPTIONAL_KEYS,
    TURN_STATS_STRATEGY_SLOT_KEYS,
    validateTurnStatsPayload,
} from '../js/intelligence/retrieval/turn-stats-shape.js';

test('turn-stats-shape: required-keys constant is frozen', () => {
    assert.ok(Object.isFrozen(TURN_STATS_REQUIRED_KEYS), 'TURN_STATS_REQUIRED_KEYS must be frozen');
    assert.deepEqual([...TURN_STATS_REQUIRED_KEYS], ['conversationId', 'strategyStats']);
});

test('turn-stats-shape: optional-keys constant is frozen', () => {
    assert.ok(Object.isFrozen(TURN_STATS_OPTIONAL_KEYS), 'TURN_STATS_OPTIONAL_KEYS must be frozen');
    assert.deepEqual([...TURN_STATS_OPTIONAL_KEYS], ['cache_hit']);
});

test('turn-stats-shape: strategy-slot-keys constant is frozen', () => {
    assert.ok(Object.isFrozen(TURN_STATS_STRATEGY_SLOT_KEYS), 'TURN_STATS_STRATEGY_SLOT_KEYS must be frozen');
    assert.deepEqual([...TURN_STATS_STRATEGY_SLOT_KEYS], ['hits', 'tokens']);
});

test('turn-stats-shape: happy-path producer payload passes', () => {
    const payload = {
        conversationId: 'c123',
        strategyStats: {
            semantic: { hits: 3, tokens: 0 },
            structural: { hits: 2, tokens: 0 },
            paraphrase: { hits: 0, tokens: 142 },
        },
    };
    const result = validateTurnStatsPayload(payload);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
});

test('turn-stats-shape: cache-hit producer payload passes', () => {
    const payload = {
        conversationId: 'c123',
        cache_hit: true,
        strategyStats: {
            cache: { hits: 1, tokens: 0 },
        },
    };
    const result = validateTurnStatsPayload(payload);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
});

test('turn-stats-shape: conversationId may be null (listener tolerates)', () => {
    const payload = {
        conversationId: null,
        strategyStats: { semantic: { hits: 1, tokens: 0 } },
    };
    const result = validateTurnStatsPayload(payload);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
});

test('turn-stats-shape: null payload fails', () => {
    const result = validateTurnStatsPayload(null);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /non-null object/);
});

test('turn-stats-shape: array payload fails', () => {
    const result = validateTurnStatsPayload([]);
    assert.equal(result.ok, false);
});

test('turn-stats-shape: missing conversationId fails', () => {
    const result = validateTurnStatsPayload({ strategyStats: { semantic: { hits: 1, tokens: 0 } } });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /conversationId/);
});

test('turn-stats-shape: missing strategyStats fails', () => {
    const result = validateTurnStatsPayload({ conversationId: 'c1' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /strategyStats/);
});

test('turn-stats-shape: extra top-level key fails (no-extras invariant)', () => {
    const result = validateTurnStatsPayload({
        conversationId: 'c1',
        strategyStats: { semantic: { hits: 1, tokens: 0 } },
        extra_field: 'oops',
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /unexpected key/);
});

test('turn-stats-shape: numeric conversationId fails', () => {
    const result = validateTurnStatsPayload({
        conversationId: 42,
        strategyStats: { semantic: { hits: 1, tokens: 0 } },
    });
    assert.equal(result.ok, false);
});

test('turn-stats-shape: empty strategyStats fails', () => {
    const result = validateTurnStatsPayload({ conversationId: 'c1', strategyStats: {} });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /non-empty/);
});

test('turn-stats-shape: strategy slot missing hits fails', () => {
    const result = validateTurnStatsPayload({
        conversationId: 'c1',
        strategyStats: { semantic: { tokens: 0 } },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /hits/);
});

test('turn-stats-shape: strategy slot missing tokens fails', () => {
    const result = validateTurnStatsPayload({
        conversationId: 'c1',
        strategyStats: { semantic: { hits: 1 } },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /tokens/);
});

test('turn-stats-shape: strategy slot with non-numeric hits fails', () => {
    const result = validateTurnStatsPayload({
        conversationId: 'c1',
        strategyStats: { semantic: { hits: '3', tokens: 0 } },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /hits.*finite number/);
});

test('turn-stats-shape: cache_hit must be boolean when present', () => {
    const result = validateTurnStatsPayload({
        conversationId: 'c1',
        cache_hit: 'true',
        strategyStats: { cache: { hits: 1, tokens: 0 } },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /cache_hit/);
});

test('turn-stats-shape: cache_hit absent is allowed (optional)', () => {
    const result = validateTurnStatsPayload({
        conversationId: 'c1',
        strategyStats: { semantic: { hits: 1, tokens: 0 } },
    });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
});
