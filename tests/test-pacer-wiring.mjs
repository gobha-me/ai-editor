/**
 * Production rate-limit pacer wiring tests (2.9.0).
 *
 * Three layers covered here. The math itself (header ingestion, 10%
 * headroom, null-cap fallback, per-model isolation) lives at
 * `evals/test-haystack.mjs:172-230` and isn't duplicated.
 *
 *   1. **Singleton identity** — `getPool()` returns the same instance
 *      across calls so every fetch chokepoint shares the same buckets.
 *   2. **Estimator monotonicity** — `estimateInputTokens` grows with
 *      payload size, accounts for tools, and carries the +256 headroom.
 *   3. **Wiring trace** — stub `globalThis.fetch` to return synthetic
 *      `x-ratelimit-*` headers; call `requestGhostTextCompletion`; assert
 *      the singleton's snapshot reflects the ingested values for the
 *      active model. Mirrors the fetch-stub pattern from
 *      `tests/test-ghost-text.mjs:135`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPool, estimateInputTokens } from '../js/llm/pacer.js';
import { requestGhostTextCompletion } from '../js/llm/completion.js';
import { State } from '../js/core.js';

/* ---------------- Singleton identity ---------------- */

test('getPool returns the same singleton instance across calls', () => {
    const a = getPool();
    const b = getPool();
    assert.equal(a, b, 'pool must be a process-global singleton');
});

test('getPool keeps per-model state isolated across calls', () => {
    const pool = getPool();
    const limA = pool.for('singleton-test-model-a');
    const limB = pool.for('singleton-test-model-b');
    assert.notEqual(limA, limB, 'distinct modelIds must yield distinct limiters');
    const limAagain = pool.for('singleton-test-model-a');
    assert.equal(limA, limAagain, 'same modelId must return the same limiter');
});

/* ---------------- Estimator monotonicity ---------------- */

test('estimateInputTokens grows with message payload', () => {
    const small = estimateInputTokens([{ role: 'user', content: 'hi' }], null);
    const large = estimateInputTokens(
        [{ role: 'user', content: 'x'.repeat(10_000) }],
        null
    );
    assert.ok(large > small, `expected large > small, got ${large} vs ${small}`);
});

test('estimateInputTokens factors tools array into the estimate', () => {
    const noTools = estimateInputTokens([{ role: 'user', content: 'hi' }], null);
    const withTools = estimateInputTokens(
        [{ role: 'user', content: 'hi' }],
        [
            { type: 'function', function: { name: 'get_weather', description: 'x'.repeat(500) } },
            { type: 'function', function: { name: 'send_email',  description: 'y'.repeat(500) } },
        ]
    );
    assert.ok(withTools > noTools, `tools must add to the estimate, got ${withTools} vs ${noTools}`);
});

test('estimateInputTokens carries the +256 headroom on empty input', () => {
    // JSON.stringify({ messages: [], tools: null }).length === 30
    // ceil(30 / 3.5) = 9; + 256 = 265
    const est = estimateInputTokens([], null);
    assert.ok(est >= 256, `headroom must be present even for empty input, got ${est}`);
    assert.ok(est < 300,  `headroom should be tight, got ${est}`);
});

test('estimateInputTokens tolerates null/undefined inputs', () => {
    const a = estimateInputTokens(null, null);
    const b = estimateInputTokens(undefined, undefined);
    assert.ok(Number.isFinite(a) && a >= 256);
    assert.ok(Number.isFinite(b) && b >= 256);
});

/* ---------------- Wiring trace (fetch stub) ---------------- */

function withStubbedFetch(stub, fn) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve()
        .then(() => fn())
        .finally(() => { globalThis.fetch = realFetch; });
}

function withSettings(settings, fn) {
    const prev = { ...State.settings };
    Object.assign(State.settings, settings);
    return Promise.resolve()
        .then(fn)
        .finally(() => { Object.assign(State.settings, prev); });
}

test('wiring: ghost-text fetch ingests x-ratelimit-* into the singleton pool', async () => {
    const modelId = 'pacer-wiring-trace-model';
    const resetAt = Date.now() + 60_000;

    await withSettings({
        llmEndpoint: 'https://example.test/v1',
        llmApiKey: 'k',
        llmModel: modelId,
    }, () => withStubbedFetch(
        async () => new Response(
            JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
            {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'x-ratelimit-limit-requests': '150',
                    'x-ratelimit-remaining-requests': '149',
                    'x-ratelimit-limit-tokens': '3000000',
                    'x-ratelimit-remaining-tokens': '2900000',
                    'x-ratelimit-reset-requests': String(resetAt),
                    'x-ratelimit-reset-tokens':   String(resetAt),
                },
            }
        ),
        async () => {
            await requestGhostTextCompletion({
                prefix: 'function f(){',
                suffix: '}',
                model: modelId,
            });

            const snap = getPool().for(modelId).snapshot();
            assert.equal(snap.rpmLimit,    150,      'rpmLimit must reflect ingested header');
            assert.equal(snap.tpmLimit,    3_000_000, 'tpmLimit must reflect ingested header');
            assert.equal(snap.remainingReq, 149,     'remainingReq must reflect ingested header');
            assert.equal(snap.remainingTok, 2_900_000, 'remainingTok must reflect ingested header');
            assert.equal(snap.resetReqAt,  resetAt,  'resetReqAt must reflect ingested header');
            assert.equal(snap.resetTokAt,  resetAt,  'resetTokAt must reflect ingested header');
        }
    ));
});

test('wiring: provider with no x-ratelimit-* headers leaves caps null (Ollama-shape)', async () => {
    const modelId = 'pacer-wiring-no-headers-model';

    await withSettings({
        llmEndpoint: 'https://example.test/v1',
        llmApiKey: 'k',
        llmModel: modelId,
    }, () => withStubbedFetch(
        async () => new Response(
            JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        ),
        async () => {
            await requestGhostTextCompletion({
                prefix: 'a',
                suffix: 'b',
                model: modelId,
            });

            const snap = getPool().for(modelId).snapshot();
            assert.equal(snap.rpmLimit,     null, 'rpmLimit stays null when header absent');
            assert.equal(snap.tpmLimit,     null, 'tpmLimit stays null when header absent');
            assert.equal(snap.remainingReq, null);
            assert.equal(snap.remainingTok, null);
        }
    ));
});
