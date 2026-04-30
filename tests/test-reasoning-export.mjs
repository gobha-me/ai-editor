/**
 * Tests for reasoning preservation across the export shape (1.3.1).
 *
 * The export contract: an assistant turn carrying a ReasoningBlock must
 * round-trip through JSON serialization unchanged, so 1.3.4's
 * `.aieditor.session` archive can step through what the model thought
 * at each step. These tests pin the contract independent of the DOM
 * walker in js/chat/export.js — that path is browser-tested via
 * tests/index.html since it depends on getChatContainer().
 *
 * What we lock in here:
 *   1. ReasoningBlock shape — five fields, no surprises.
 *   2. JSON round-trip preserves every field.
 *   3. Renderer guard: `reasoning && reasoning.content && length > 0`
 *      treats absence and empty-string identically (no empty bubble).
 *   4. enrichAssistantTurn drops empty reasoning so persisted turns
 *      never carry a no-op ReasoningBlock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichAssistantTurn } from '../js/chat/turn-enrich.js';
import { splitThinkBlocks } from '../js/llm/utils.js';

function makeBlock(overrides = {}) {
    return {
        provider: 'venice',
        format: 'tag',
        content: 'thought process here',
        started_at: 1700000000000,
        ended_at: 1700000000500,
        ...overrides,
    };
}

test('export: ReasoningBlock JSON round-trip preserves all five fields', () => {
    const block = makeBlock();
    const turn = enrichAssistantTurn(
        { role: 'assistant', content: 'answer', timestamp: 1700000000600 },
        { reasoning: block }
    );
    const restored = JSON.parse(JSON.stringify(turn));
    assert.deepEqual(restored.reasoning, block);
});

test('export: round-trip preserves multi-line reasoning content', () => {
    const block = makeBlock({ content: 'line one\nline two\nline three' });
    const restored = JSON.parse(JSON.stringify({ reasoning: block }));
    assert.equal(restored.reasoning.content, 'line one\nline two\nline three');
});

test('export: renderer guard — absent reasoning is falsy', () => {
    const turn = { role: 'assistant', content: 'x' };
    const guard = turn.reasoning && turn.reasoning.content && turn.reasoning.content.length > 0;
    assert.equal(guard, undefined, 'absent reasoning short-circuits to undefined');
});

test('export: renderer guard — empty content suppresses bubble', () => {
    const turn = { role: 'assistant', content: 'x', reasoning: makeBlock({ content: '' }) };
    const guard = turn.reasoning && turn.reasoning.content && turn.reasoning.content.length > 0;
    assert.ok(!guard, 'empty content fails the guard');
});

test('export: renderer guard — non-empty content passes', () => {
    const turn = { role: 'assistant', content: 'x', reasoning: makeBlock({ content: 'real' }) };
    const guard = turn.reasoning && turn.reasoning.content && turn.reasoning.content.length > 0;
    assert.ok(guard, 'real content passes the guard');
});

test('export: enrichAssistantTurn drops empty reasoning before persistence', () => {
    const turn = enrichAssistantTurn(
        { role: 'assistant', content: 'x' },
        { reasoning: makeBlock({ content: '' }) }
    );
    assert.equal('reasoning' in turn, false, 'empty block never persisted');
});

test('export: splitThinkBlocks → enrichAssistantTurn pipeline preserves content', () => {
    // End-to-end: simulated raw response → split → enrich → serialize.
    const raw = '<think>step 1\nstep 2</think>final answer';
    const split = splitThinkBlocks(raw);
    assert.equal(split.content, 'final answer');
    assert.equal(split.reasoning, 'step 1\nstep 2');

    const turn = enrichAssistantTurn(
        { role: 'assistant', content: split.content, timestamp: 1 },
        {
            reasoning: split.reasoning ? {
                provider: 'test', format: 'tag',
                content: split.reasoning, started_at: 0, ended_at: 1,
            } : null
        }
    );
    const restored = JSON.parse(JSON.stringify(turn));
    assert.equal(restored.content, 'final answer');
    assert.equal(restored.reasoning.content, 'step 1\nstep 2');
});

test('export: format field is the discriminator for future native/channel formats', () => {
    // Phase 1 only emits format: 'tag'. Native and channel are reserved
    // for OpenAI o1 / Anthropic extended-thinking integrations later.
    const tag = makeBlock({ format: 'tag' });
    const native = makeBlock({ format: 'native' });
    const channel = makeBlock({ format: 'channel' });
    for (const block of [tag, native, channel]) {
        const restored = JSON.parse(JSON.stringify({ reasoning: block }));
        assert.equal(restored.reasoning.format, block.format);
    }
});

test('export: provider field nullable for unknown providers', () => {
    const block = makeBlock({ provider: null });
    const restored = JSON.parse(JSON.stringify({ reasoning: block }));
    assert.equal(restored.reasoning.provider, null);
});

test('export: timestamps are millisecond integers, not Date objects', () => {
    const block = makeBlock();
    assert.equal(typeof block.started_at, 'number');
    assert.equal(typeof block.ended_at, 'number');
    // After round-trip — Date objects don't survive JSON; numbers do.
    const restored = JSON.parse(JSON.stringify({ reasoning: block }));
    assert.equal(typeof restored.reasoning.started_at, 'number');
    assert.equal(restored.reasoning.started_at, block.started_at);
});
