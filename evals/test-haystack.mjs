/**
 * Pre-merge sanity tests for the NIAH eval harness.
 * Pure functions only — no IO, no API calls, no shim required.
 *
 * Run via: node --test evals/test-haystack.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHaystack, __testing } from './haystack.js';
import { scoreText } from './scoring.js';
import { estimateGridCost } from './cost-preflight.js';
import { RateLimiter, RateLimiterPool } from './pacing.js';
import { CHARS_PER_TOKEN } from '../js/intelligence/compression/tokens.js';

// Build a deterministic synthetic corpus with paragraph breaks so the
// snap-to-boundary logic has work to do.
const synthCorpus = (() => {
    const para = 'A'.repeat(400) + '.\n\nB'.repeat(1) + 'B'.repeat(400) + '.';
    const block = (para + '\n\n').repeat(50); // ~80K chars
    return block;
})();

test('buildHaystack places needle near the requested depth (snap-window-bounded)', () => {
    // The snap-to-boundary window is ±200 chars; max drift in absolute
    // depth terms is therefore 200 / fillerChars. At production scales
    // (≥30K tokens × 3.5 chars/tok = 105K chars) drift is < 0.2%; at the
    // 5K synthetic case here it's ~1.2% worst-case.
    const SNAP_WINDOW_CHARS = 200;
    const needle = 'NEEDLE-XYZ-1';
    const targetTokens = 5000;
    for (const depth of [0.05, 0.25, 0.50, 0.75, 0.95]) {
        const out = buildHaystack({
            corpus: synthCorpus, targetTokens, needle, depthPct: depth
        });
        assert.ok(out.text.includes(needle), `needle missing at depth=${depth}`);
        const fillerLen = out.text.length - needle.length - 4; // 2x '\n\n'
        const observedDepth = out.needleCharIndex / fillerLen;
        const drift = Math.abs(observedDepth - depth);
        const maxDrift = (SNAP_WINDOW_CHARS / fillerLen) + 0.001; // +epsilon for rounding
        assert.ok(drift < maxDrift,
            `depth drift at ${depth}: observed ${observedDepth.toFixed(4)} (drift ${drift.toFixed(4)}, max ${maxDrift.toFixed(4)})`);
    }
});

test('buildHaystack drift is well under 0.5% at production scale (100K tokens)', () => {
    // Asserts the user-facing claim from the plan that depth drift is
    // negligible at the actual eval lengths. Snap-window of 200 chars
    // over 350K filler chars = max 0.057% drift; assert under 0.1%.
    const needle = 'NEEDLE-PROD-1';
    for (const depth of [0.05, 0.25, 0.50, 0.75, 0.95]) {
        const out = buildHaystack({
            corpus: synthCorpus, targetTokens: 100_000, needle, depthPct: depth
        });
        const fillerLen = out.text.length - needle.length - 4;
        const observedDepth = out.needleCharIndex / fillerLen;
        const drift = Math.abs(observedDepth - depth);
        assert.ok(drift < 0.001, `production-scale drift at ${depth}: ${drift.toFixed(6)}`);
    }
});

test('buildHaystack honors target token length within rounding', () => {
    const needle = 'NEEDLE-A';
    const target = 4000;
    const out = buildHaystack({
        corpus: synthCorpus, targetTokens: target,
        needle, depthPct: 0.5
    });
    // actualTokens uses ceil(text.length / CHARS_PER_TOKEN); target ≈ floor(target * CHARS_PER_TOKEN) / CHARS_PER_TOKEN
    const expectedChars = target * CHARS_PER_TOKEN;
    const drift = Math.abs(out.text.length - expectedChars);
    // Needle length + delimiters add ~20 chars; allow 100-char wiggle.
    assert.ok(drift < 100, `length drift: target ${expectedChars}, got ${out.text.length}, drift ${drift}`);
});

test('buildHaystack rejects bad input', () => {
    assert.throws(() => buildHaystack({ corpus: '', targetTokens: 100, needle: 'X', depthPct: 0.5 }));
    assert.throws(() => buildHaystack({ corpus: 'abc', targetTokens: 0, needle: 'X', depthPct: 0.5 }));
    assert.throws(() => buildHaystack({ corpus: 'abc', targetTokens: 100, needle: '', depthPct: 0.5 }));
    assert.throws(() => buildHaystack({ corpus: 'abc', targetTokens: 100, needle: 'X', depthPct: 1.1 }));
    assert.throws(() => buildHaystack({ corpus: 'abc', targetTokens: 100, needle: 'X', depthPct: -0.1 }));
});

test('scoreText hits on exact, case-insensitive, whitespace-insensitive match', () => {
    assert.deepEqual(scoreText('the passcode is DELTA-RHINO-7 obviously', 'DELTA-RHINO-7').hit, true);
    assert.deepEqual(scoreText('it is delta-rhino-7', 'DELTA-RHINO-7').hit, true);
    assert.deepEqual(scoreText('answer:\n  DELTA-RHINO-7  ', 'DELTA-RHINO-7').hit, true);
});

test('scoreText misses when secret absent', () => {
    assert.deepEqual(scoreText('it was DELTA-RHINO-8', 'DELTA-RHINO-7').hit, false);
    assert.deepEqual(scoreText('', 'DELTA-RHINO-7').hit, false);
    assert.deepEqual(scoreText(null, 'DELTA-RHINO-7').hit, false);
});

test('scoreText evidence is first 80 chars, normalized', () => {
    const r = scoreText('  hello world\n\n  with  spaces  ' + 'x'.repeat(200), 'foo');
    assert.ok(r.evidence.length <= 80);
    assert.ok(!r.evidence.includes('  '));
});

test('estimateGridCost matches hand math on a tiny config', () => {
    const models = [
        { id: 'm1', pricing: { input: 1.0, output: 2.0 } }, // $/1M
        { id: 'm2', pricing: { input: 0.5, output: 1.0 } }
    ];
    const cfg = {
        tpmAssumed: 1_000_000,
        tiers: [
            { modelId: 'm1', lengths: [1000, 2000], depths: [0.5], replicates: 2 },
            { modelId: 'm2', lengths: [10000], depths: [0.1, 0.9], replicates: 1 }
        ]
    };
    const est = estimateGridCost(cfg, models);
    // Tier m1: calls = 2 lengths × 1 depth × 2 reps = 4
    //          inputTok = (1000+2000) × 1 × 2 = 6000
    //          outputTok = 4 × 50 = 200
    //          cost = 6000/1M × 1.0 + 200/1M × 2.0 = 0.006 + 0.0004 = 0.0064
    //          etaMs = 6000/1M × 60000 = 360
    assert.equal(est.perTier[0].calls, 4);
    assert.equal(est.perTier[0].inputTok, 6000);
    assert.equal(est.perTier[0].outputTok, 200);
    assert.ok(Math.abs(est.perTier[0].costUsd - 0.0064) < 1e-6);
    assert.equal(est.perTier[0].etaMs, 360);

    // Tier m2: calls = 1 × 2 × 1 = 2
    //          inputTok = 10000 × 2 × 1 = 20000
    //          outputTok = 2 × 50 = 100
    //          cost = 20000/1M × 0.5 + 100/1M × 1.0 = 0.01 + 0.0001 = 0.0101
    //          etaMs = 20000/1M × 60000 = 1200
    assert.equal(est.perTier[1].calls, 2);
    assert.equal(est.perTier[1].inputTok, 20000);
    assert.ok(Math.abs(est.perTier[1].costUsd - 0.0101) < 1e-6);
    assert.equal(est.perTier[1].etaMs, 1200);

    assert.equal(est.callCount, 6);
    assert.ok(Math.abs(est.totalUsd - (0.0064 + 0.0101)) < 1e-6);

    // Default: parallel tiers — total ETA = max(360, 1200) = 1200
    assert.equal(est.etaMs, 1200);

    // Sequential mode: total ETA = sum(360, 1200) = 1560
    const seq = estimateGridCost({ ...cfg, sequentialTiers: true }, models);
    assert.equal(seq.etaMs, 1560);
});

test('estimateGridCost handles missing pricing without throwing', () => {
    const models = [{ id: 'm1', pricing: null }];
    const cfg = { tiers: [{ modelId: 'm1', lengths: [1000], depths: [0.5], replicates: 1 }] };
    const est = estimateGridCost(cfg, models);
    assert.equal(est.perTier[0].costUsd, 0);
    assert.equal(est.perTier[0].pricingMissing, true);
});

test('snapToBoundary moves to nearest \\n\\n within ±200 chars', () => {
    const { snapToBoundary } = __testing;
    const s = 'aaaa\n\nbbbb\n\ncccc\n\ndddd';
    // Asking for index 5 (in 'aaaa\n\n') should snap to 4 (the boundary).
    assert.equal(snapToBoundary(s, 5), 4);
    // Asking for index 10 (in 'bbbb\n\n') should snap to the nearest break.
    const res = snapToBoundary(s, 10);
    assert.ok([4, 10].includes(res), `got ${res}`);
});

// ----------------------------- pacing -----------------------------

function fakeHeaders(map) {
    return { get: (k) => (k in map ? String(map[k]) : null) };
}

test('RateLimiter ingests headers and returns 0 wait when fresh', () => {
    const r = new RateLimiter({ perCallDelayMs: 0 });
    r.ingest(fakeHeaders({
        'x-ratelimit-limit-requests': 150,
        'x-ratelimit-remaining-requests': 149,
        'x-ratelimit-limit-tokens': 3_000_000,
        'x-ratelimit-remaining-tokens': 3_000_000,
        'x-ratelimit-reset-requests': Date.now() + 60_000,
        'x-ratelimit-reset-tokens':   Date.now() + 60_000
    }));
    assert.equal(r.msUntilNextSend(50_000), 0, 'fresh budget should not wait');
});

test('RateLimiter waits when expected tokens would breach the buffer floor', () => {
    const r = new RateLimiter({ perCallDelayMs: 0, tokenBufferPct: 0.10 });
    const resetAt = Date.now() + 5000;
    r.ingest(fakeHeaders({
        'x-ratelimit-limit-tokens':   3_000_000,
        'x-ratelimit-remaining-tokens': 350_000,        // floor = 300_000
        'x-ratelimit-reset-tokens':   resetAt,
        'x-ratelimit-limit-requests': 150,
        'x-ratelimit-remaining-requests': 100,
        'x-ratelimit-reset-requests': resetAt
    }));
    // Need 100K tokens; remaining 350K - 100K = 250K < 300K floor → wait.
    const wait = r.msUntilNextSend(100_000);
    assert.ok(wait > 0 && wait <= 5000, `expected wait ≤5s, got ${wait}`);
});

test('RateLimiter handles missing TPM cap (no header) by RPM-only', () => {
    const r = new RateLimiter({ perCallDelayMs: 0 });
    r.ingest(fakeHeaders({
        'x-ratelimit-limit-requests': 1000,
        'x-ratelimit-remaining-requests': 999,
        'x-ratelimit-reset-requests': Date.now() + 60_000
        // No TPM headers — emulates deepseek-v4-flash on Venice.
    }));
    assert.equal(r.msUntilNextSend(900_000), 0, 'should not block when TPM is null');
    assert.equal(r.tpmLimit, null);
});

test('RateLimiterPool returns distinct limiters per modelId', () => {
    const pool = new RateLimiterPool({ perCallDelayMs: 0 });
    const a = pool.for('model-a');
    const b = pool.for('model-b');
    const a2 = pool.for('model-a');
    assert.notEqual(a, b, 'different models get different limiters');
    assert.equal(a, a2, 'same model returns the same limiter');

    // State on one limiter does not bleed to another.
    a.ingest(fakeHeaders({
        'x-ratelimit-limit-tokens': 3_000_000,
        'x-ratelimit-remaining-tokens': 0
    }));
    assert.equal(a.tpmLimit, 3_000_000);
    assert.equal(a.remainingTok, 0);
    assert.equal(b.tpmLimit, null, 'b should be untouched by a.ingest');
    assert.equal(b.remainingTok, null);
});
