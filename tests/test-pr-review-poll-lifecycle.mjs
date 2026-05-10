// @ts-check
/**
 * Pure-math tests for the PR Review CI polling cadence.
 *
 * The live polling effect lives in `js/pr-review/PrReviewSurface.js`,
 * which has a top-level `await getPreact()` and is browser-only.
 * Cadence math is extracted to `js/pr-review/poll-cadence.js` so the
 * lifecycle contract can be pinned without spinning up a renderer.
 *
 * Trigger contract:
 *   shouldPoll(pr, ci) === true  ⇔  pr.state === 'open'
 *                                 && !pr.merged
 *                                 && ci.state === 'pending'
 *
 * Cadence contract:
 *   nextPollDelay(elapsed) === 10_000  for elapsed ∈ [0, 120_000)
 *   nextPollDelay(elapsed) === 30_000  for elapsed >= 120_000
 *
 * @since 2.13.2
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    nextPollDelay,
    shouldPoll,
    isTerminal,
    POLL_FAST_INTERVAL_MS,
    POLL_SLOW_INTERVAL_MS,
    POLL_FAST_WINDOW_MS,
} from '../js/pr-review/poll-cadence.js';

// ============================================
// nextPollDelay — fast/slow split at 2 minutes
// ============================================

test('nextPollDelay: 0ms elapsed → fast interval (10s)', () => {
    assert.equal(nextPollDelay(0), POLL_FAST_INTERVAL_MS);
});

test('nextPollDelay: just under 2-min window → still fast', () => {
    assert.equal(nextPollDelay(POLL_FAST_WINDOW_MS - 1), POLL_FAST_INTERVAL_MS);
});

test('nextPollDelay: exactly 2-min window → slow', () => {
    assert.equal(nextPollDelay(POLL_FAST_WINDOW_MS), POLL_SLOW_INTERVAL_MS);
});

test('nextPollDelay: well past 2-min window → slow', () => {
    assert.equal(nextPollDelay(10 * 60 * 1000), POLL_SLOW_INTERVAL_MS);
});

test('nextPollDelay: defends against bogus inputs (NaN / negative / Infinity)', () => {
    assert.equal(nextPollDelay(NaN), POLL_FAST_INTERVAL_MS);
    assert.equal(nextPollDelay(-1), POLL_FAST_INTERVAL_MS);
    assert.equal(nextPollDelay(Infinity), POLL_FAST_INTERVAL_MS);
    // @ts-expect-error — exercising the type-guard branch
    assert.equal(nextPollDelay('100'), POLL_FAST_INTERVAL_MS);
});

// ============================================
// shouldPoll — trigger contract
// ============================================

test('shouldPoll: open+pending PR triggers polling', () => {
    assert.equal(shouldPoll({ state: 'open', merged: false }, { state: 'pending' }), true);
});

test('shouldPoll: closed PR never polls (regardless of CI)', () => {
    assert.equal(shouldPoll({ state: 'closed', merged: false }, { state: 'pending' }), false);
});

test('shouldPoll: merged PR never polls (open state but merged flag)', () => {
    assert.equal(shouldPoll({ state: 'open', merged: true }, { state: 'pending' }), false);
});

test('shouldPoll: success/failure/error/unknown CI never polls', () => {
    const open = { state: 'open', merged: false };
    assert.equal(shouldPoll(open, { state: 'success' }), false);
    assert.equal(shouldPoll(open, { state: 'failure' }), false);
    assert.equal(shouldPoll(open, { state: 'error' }), false);
    assert.equal(shouldPoll(open, { state: 'unknown' }), false);
});

test('shouldPoll: missing pr or ci is a no-op (defensive)', () => {
    assert.equal(shouldPoll(null, { state: 'pending' }), false);
    assert.equal(shouldPoll({ state: 'open' }, null), false);
    assert.equal(shouldPoll(undefined, undefined), false);
});

// ============================================
// isTerminal — stop conditions
// ============================================

test('isTerminal: success/failure/error are terminal', () => {
    assert.equal(isTerminal('success'), true);
    assert.equal(isTerminal('failure'), true);
    assert.equal(isTerminal('error'), true);
});

test('isTerminal: pending and unknown are NOT terminal', () => {
    assert.equal(isTerminal('pending'), false);
    assert.equal(isTerminal('unknown'), false);
});

test('isTerminal: missing/null state is NOT terminal', () => {
    assert.equal(isTerminal(null), false);
    assert.equal(isTerminal(undefined), false);
    assert.equal(isTerminal(''), false);
});

// ============================================
// Lifecycle simulation — recursive setTimeout cadence
// ============================================
//
// The live effect uses recursive setTimeout where each next-tick is
// `nextPollDelay(Date.now() - startTime)`. This test reconstructs that
// math without DOM/preact: we walk a series of (elapsed) values that
// the live effect would compute and assert the cadence steps from
// 10s → 10s → … → 30s as elapsed crosses the 2-minute boundary.

test('lifecycle: cadence walk crosses fast→slow boundary at 2min', () => {
    const elapsedSamples = [
        0,           // first poll
        10_000,      // after first 10s tick
        20_000,
        110_000,
        119_999,     // last fast-window tick
        120_000,     // first slow-window tick
        150_000,
        300_000,
    ];
    const expected = [
        10_000,
        10_000,
        10_000,
        10_000,
        10_000,
        30_000,
        30_000,
        30_000,
    ];
    const actual = elapsedSamples.map(nextPollDelay);
    assert.deepEqual(actual, expected);
});
