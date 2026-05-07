/**
 * Tests for the provider `usage` field extractor (1.8.5).
 *
 * Pure helper — no browser globals required, no Storage. We import the
 * shim anyway so this file stays consistent with the rest of the suite
 * (transitive imports may grow over time).
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractUsage } from '../js/intelligence/cost/usage-shape.js';

test('null / undefined / missing usage returns all-zeros', () => {
    const expected = {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
    };
    assert.deepEqual(extractUsage(null), expected);
    assert.deepEqual(extractUsage(undefined), expected);
    assert.deepEqual(extractUsage({}), expected);
    assert.deepEqual(extractUsage('not an object'), expected);
});

test('OpenAI shape — prompt_tokens / completion_tokens / *_details', () => {
    const out = extractUsage({
        prompt_tokens: 1200,
        completion_tokens: 350,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 120 },
    });
    assert.equal(out.inputTokens, 1200);
    assert.equal(out.outputTokens, 350);
    assert.equal(out.cachedTokens, 800);
    assert.equal(out.reasoningTokens, 120);
    assert.equal(out.cacheReadTokens, 0);
    assert.equal(out.cacheCreationTokens, 0);
});

test('Anthropic shape — input_tokens / output_tokens / cache_*_input_tokens', () => {
    const out = extractUsage({
        input_tokens: 900,
        output_tokens: 220,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 50,
    });
    assert.equal(out.inputTokens, 900);
    assert.equal(out.outputTokens, 220);
    assert.equal(out.cacheReadTokens, 700);
    assert.equal(out.cacheCreationTokens, 50);
    // No OpenAI prompt_tokens_details.cached_tokens, so cachedTokens
    // falls back to cacheReadTokens — keeps _computeCost's discount alive
    // for direct Anthropic providers without a separate pricing path.
    assert.equal(out.cachedTokens, 700);
    assert.equal(out.reasoningTokens, 0);
});

test('Mixed shape — OpenAI counts win, Anthropic-native cache fields surface', () => {
    // Pattern seen when OpenRouter normalizes a Claude response to OpenAI
    // shape but leaks Anthropic-native cache fields alongside.
    const out = extractUsage({
        prompt_tokens: 1500,
        completion_tokens: 400,
        prompt_tokens_details: { cached_tokens: 1100 },
        cache_read_input_tokens: 1100,
        cache_creation_input_tokens: 200,
    });
    assert.equal(out.inputTokens, 1500);
    assert.equal(out.outputTokens, 400);
    // OpenAI's cached_tokens wins for `cachedTokens` — that's the field
    // _computeCost already prices against.
    assert.equal(out.cachedTokens, 1100);
    assert.equal(out.cacheReadTokens, 1100);
    assert.equal(out.cacheCreationTokens, 200);
});

test('Mixed shape — Anthropic cache fields fill in when OpenAI cached_tokens absent', () => {
    // OpenRouter sometimes returns OpenAI prompt/completion totals but no
    // prompt_tokens_details object at all. Anthropic-native cache fields
    // become the cachedTokens fallback so cost discounting still fires.
    const out = extractUsage({
        prompt_tokens: 1500,
        completion_tokens: 400,
        cache_read_input_tokens: 900,
    });
    assert.equal(out.inputTokens, 1500);
    assert.equal(out.outputTokens, 400);
    assert.equal(out.cachedTokens, 900);
    assert.equal(out.cacheReadTokens, 900);
    assert.equal(out.cacheCreationTokens, 0);
});

test('Non-numeric / negative / NaN values fall through cleanly', () => {
    const out = extractUsage({
        prompt_tokens: 'not a number',
        completion_tokens: NaN,
        input_tokens: 500,
        output_tokens: 120,
        prompt_tokens_details: { cached_tokens: undefined },
        cache_read_input_tokens: 'oops',
    });
    // prompt_tokens / completion_tokens were non-numeric, so the
    // Anthropic fallback wins. cache_read_input_tokens was a string,
    // so it does NOT contaminate cacheReadTokens or cachedTokens.
    assert.equal(out.inputTokens, 500);
    assert.equal(out.outputTokens, 120);
    assert.equal(out.cachedTokens, 0);
    assert.equal(out.cacheReadTokens, 0);
    assert.equal(out.cacheCreationTokens, 0);
    assert.equal(out.reasoningTokens, 0);
});

test('returned shape is exactly the documented six fields', () => {
    const out = extractUsage({ prompt_tokens: 1, completion_tokens: 1 });
    assert.deepEqual(Object.keys(out).sort(), [
        'cacheCreationTokens',
        'cacheReadTokens',
        'cachedTokens',
        'inputTokens',
        'outputTokens',
        'reasoningTokens',
    ]);
});
