// @ts-check
/**
 * Anti-regression test for the Venice prompt-cache breakpoint
 * (gitea#423, shipped 2.50.0.1).
 *
 * Venice's OpenAI-compat API supports Anthropic-style prompt caching
 * via `cache_control: {type: 'ephemeral'}` on message content blocks
 * ([`swaggers/venice.yaml:112`](../swaggers/venice.yaml)). A real
 * dogfood session against `xcaliber/HTML-Games#215` measured ~209k
 * tokens (~23% of session spend) re-billed on the stable tool-defs
 * prefix. Marking the last system message with `cache_control` causes
 * Venice's prefix cache to retain (tools + system) across requests,
 * eliminating the re-bill on cache hits.
 *
 * This test pins the transform shape: the right place, the right
 * content-block array, the opt-out toggle, the idempotency guard, and
 * the per-provider scoping (BASE_PROVIDER doesn't touch content).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import veniceProvider from '../js/providers/venice.js';
import { ProviderRegistry } from '../js/providers/registry.js';

// BASE_PROVIDER is registered under id 'openai' (see registry.js:191).
// Pulling it through the registry avoids needing to export it.
const BASE_PROVIDER = ProviderRegistry.get('openai');

function makeBody(systemMessages, otherMessages = []) {
    const messages = [];
    for (const content of systemMessages) messages.push({ role: 'system', content });
    for (const m of otherMessages) messages.push(m);
    return { model: 'qwen-3-6-plus', messages };
}

test('default-on: bare settings produce a cache_control breakpoint on the system message', () => {
    const body = makeBody(['You are a helpful coder.']);
    veniceProvider.transformRequest(body, { veniceParameters: {} });

    const sys = body.messages[0];
    assert.equal(sys.role, 'system');
    assert.equal(Array.isArray(sys.content), true,
        'system content must be wrapped as a content-block array');
    assert.equal(sys.content.length, 1);
    assert.deepEqual(sys.content[0], {
        type: 'text',
        text: 'You are a helpful coder.',
        cache_control: { type: 'ephemeral' }
    });
});

test('explicit opt-out: enablePromptCache=false leaves system content as a string', () => {
    const body = makeBody(['You are a helpful coder.']);
    veniceProvider.transformRequest(body, {
        veniceParameters: { enablePromptCache: false }
    });
    assert.equal(body.messages[0].content, 'You are a helpful coder.');
});

test('idempotency: running transformRequest twice does not double-wrap', () => {
    const body = makeBody(['You are a helpful coder.']);
    veniceProvider.transformRequest(body, { veniceParameters: {} });
    veniceProvider.transformRequest(body, { veniceParameters: {} });

    const sys = body.messages[0];
    assert.equal(Array.isArray(sys.content), true);
    assert.equal(sys.content.length, 1,
        'second pass must detect array-shape and skip rather than re-wrap');
    assert.equal(sys.content[0].cache_control.type, 'ephemeral');
});

test('no system message: body with only user/assistant roles passes through unchanged', () => {
    const body = makeBody([], [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
    ]);
    const before = JSON.stringify(body);
    veniceProvider.transformRequest(body, { veniceParameters: {} });
    assert.equal(JSON.stringify(body), before,
        'transform must be a no-op when there is no system message');
});

test('empty system content: empty string stays untouched (no array wrap)', () => {
    const body = makeBody(['']);
    veniceProvider.transformRequest(body, { veniceParameters: {} });
    assert.equal(body.messages[0].content, '',
        'empty system content is degenerate; do not bloat it with a no-op cache breakpoint');
});

test('multiple system messages (summarizer case): only the LAST system gets marked', () => {
    const body = makeBody([
        'Earlier conversation summary part 1.',
        'Earlier conversation summary part 2.',
        'Live system prompt with tools.'
    ], [
        { role: 'user', content: 'what next?' }
    ]);
    veniceProvider.transformRequest(body, { veniceParameters: {} });

    assert.equal(typeof body.messages[0].content, 'string',
        'first system entry stays as a string');
    assert.equal(typeof body.messages[1].content, 'string',
        'middle system entry stays as a string');
    assert.equal(Array.isArray(body.messages[2].content), true,
        'last system entry gets the cache_control breakpoint');
    assert.equal(body.messages[2].content[0].cache_control.type, 'ephemeral');
});

test('non-Venice no-op: BASE_PROVIDER.transformRequest does not touch system content', () => {
    const body = makeBody(['You are a helpful coder.']);
    BASE_PROVIDER.transformRequest(body, { veniceParameters: {} });
    assert.equal(body.messages[0].content, 'You are a helpful coder.',
        'the prompt-cache transform must stay scoped to the venice provider; BASE_PROVIDER is a no-op so OpenAI/OpenRouter/Ollama keep their string-content contract');
});
