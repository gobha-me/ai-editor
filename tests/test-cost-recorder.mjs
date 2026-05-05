/**
 * Tests for cost-recorder per-tool attribution (1.2.1).
 *
 * The recorder's full event pipeline binds to State.settings, EventBus,
 * ConversationManager and Storage — exercised in browser. Here we
 * unit-test the pure attribution helper exported via __test.
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Storage } from '../js/core.js';
import { getConvCost } from '../js/intelligence/cost/cost-store.js';
import { __test } from '../js/intelligence/cost/cost-recorder.js';

const { _attributeTools, _onCostUpdated, _onRetrievalTurnStats, _drainPendingStrategy, _pendingByStrategy } = __test;

function clearCostStorage() {
    if (typeof globalThis.localStorage?.clear === 'function') {
        globalThis.localStorage.clear();
    }
    Storage.remove('cost-daily');
    Storage.remove('cost-budget');
    for (let i = 0; i < 100; i++) Storage.remove(`cost-by-conv-c${i}`);
    Storage.remove('cost-by-conv-cR');
}

test('attribute returns empty when no tool messages', () => {
    const out = _attributeTools([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
    ], 1000);
    assert.deepEqual(out, {});
});

test('attribute counts calls per tool name resolved via tool_call_id', () => {
    const out = _attributeTools([
        { role: 'user', content: 'go' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'tc1', function: { name: 'read_file' } },
                { id: 'tc2', function: { name: 'edit_file' } },
            ],
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'file body…' },
        { role: 'tool', tool_call_id: 'tc2', content: 'edit ok' },
    ], 1000);
    assert.equal(out.read_file.calls, 1);
    assert.equal(out.edit_file.calls, 1);
});

test('attribute groups multiple invocations of the same tool', () => {
    const out = _attributeTools([
        { role: 'user', content: 'a' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 't1', function: { name: 'read_file' } },
                { id: 't2', function: { name: 'read_file' } },
            ],
        },
        { role: 'tool', tool_call_id: 't1', content: 'X' },
        { role: 'tool', tool_call_id: 't2', content: 'Y' },
    ], 100);
    assert.equal(out.read_file.calls, 2);
    assert.ok(out.read_file.estTokens > 0);
});

test('attribute splits estimated tokens proportionally to result bytes', () => {
    // Two reads with very different result sizes. Attribution should
    // favor the larger one.
    const big = 'X'.repeat(1000);
    const small = 'Y'.repeat(100);
    const out = _attributeTools([
        { role: 'user', content: 'a' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                { id: 'a', function: { name: 'read_file' } },
                { id: 'b', function: { name: 'edit_file' } },
            ],
        },
        { role: 'tool', tool_call_id: 'a', content: big },
        { role: 'tool', tool_call_id: 'b', content: small },
    ], 1100);
    assert.ok(out.read_file.estTokens >= out.edit_file.estTokens * 5,
        `read=${out.read_file.estTokens}, edit=${out.edit_file.estTokens}`);
});

test('attribute falls back to message.name when tool_call_id is missing', () => {
    const out = _attributeTools([
        { role: 'tool', name: 'mystery_tool', content: 'res' },
    ], 50);
    assert.equal(out.mystery_tool.calls, 1);
});

test('attribute uses "unknown" when neither tool_call_id nor name resolves', () => {
    const out = _attributeTools([
        { role: 'tool', content: 'orphan' },
    ], 50);
    assert.equal(out.unknown.calls, 1);
});

// ============================================
// 1.3.18 — _onCostUpdated forwards tool-def metrics
// ============================================

test('_onCostUpdated forwards toolDef* fields into the per-conv ConvCost', async () => {
    clearCostStorage();
    Storage.set('activeConversation', 'cR');

    await _onCostUpdated({
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
        sessionCost: {},
        modelId: 'm-test',
        messages: [],
        toolCalls: null,
        toolDefTokens: 1820,
        toolDefBaseline: 6420,
        toolDefUnfiltered: 10400,
    });

    const cc = getConvCost('cR');
    assert.ok(cc, 'ConvCost record exists');
    assert.equal(cc.toolDefTokens, 1820);
    assert.equal(cc.toolDefBaseline, 6420);
    assert.equal(cc.toolDefUnfiltered, 10400);
});

test('_onCostUpdated defaults absent toolDef* fields to 0 (legacy emitter)', async () => {
    clearCostStorage();
    Storage.set('activeConversation', 'cR');

    await _onCostUpdated({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        sessionCost: {},
        modelId: 'm-test',
        messages: [],
        toolCalls: null,
        // toolDefTokens / toolDefBaseline / toolDefUnfiltered intentionally absent
    });

    const cc = getConvCost('cR');
    assert.ok(cc);
    assert.equal(cc.toolDefTokens, 0);
    assert.equal(cc.toolDefBaseline, 0);
    assert.equal(cc.toolDefUnfiltered, 0);
});

test('_onCostUpdated kill-switch invariant: admitted == baseline ⇒ 0% reduction', async () => {
    clearCostStorage();
    Storage.set('activeConversation', 'cR');

    // Mirrors the legacy-path emission in `getToolsForRole()` when
    // `?toolsCompose=off` flips composerActive false.
    const same = 6420;
    await _onCostUpdated({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        sessionCost: {},
        modelId: 'm-test',
        messages: [],
        toolCalls: null,
        toolDefTokens: same,
        toolDefBaseline: same,
        toolDefUnfiltered: 10400,
    });

    const cc = getConvCost('cR');
    assert.equal(cc.toolDefTokens, cc.toolDefBaseline,
        'kill-switch path: admitted equals baseline so the dashboard reads 0%');
});

test('_onCostUpdated ignores payloads without usage', async () => {
    clearCostStorage();
    Storage.set('activeConversation', 'cR');
    await _onCostUpdated({ usage: null });
    assert.equal(getConvCost('cR'), null);
});

// ============================================
// 1.6.8 — retrieval:turn-stats buffer + drain
// ============================================

test('_onRetrievalTurnStats buffers stats; next _onCostUpdated drains them into byStrategy', async () => {
    clearCostStorage();
    _pendingByStrategy.clear();
    Storage.set('activeConversation', 'cR');

    _onRetrievalTurnStats({
        conversationId: 'cR',
        strategyStats: {
            semantic:   { hits: 4, tokens: 0 },
            paraphrase: { hits: 0, tokens: 250 },
            structural: { hits: 1, tokens: 0 },
        },
    });

    await _onCostUpdated({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        sessionCost: {},
        modelId: 'm-test',
        messages: [],
        toolCalls: null,
    });

    const cc = getConvCost('cR');
    assert.ok(cc, 'record exists');
    assert.equal(cc.byStrategy.semantic.hits, 4);
    assert.equal(cc.byStrategy.paraphrase.tokens, 250);
    assert.equal(cc.byStrategy.structural.hits, 1);
    // Buffer must be drained — a second cost:updated should not double-count.
    await _onCostUpdated({
        usage: { prompt_tokens: 50, completion_tokens: 25 },
        sessionCost: {},
        modelId: 'm-test',
        messages: [],
        toolCalls: null,
    });
    const cc2 = getConvCost('cR');
    assert.equal(cc2.byStrategy.semantic.hits, 4, 'drain — no double-count');
});

test('_onRetrievalTurnStats ignores empty / null payloads', () => {
    _pendingByStrategy.clear();
    _onRetrievalTurnStats(null);
    _onRetrievalTurnStats({});
    _onRetrievalTurnStats({ conversationId: 'cR', strategyStats: {} });
    _onRetrievalTurnStats({ conversationId: null, strategyStats: { semantic: { hits: 1, tokens: 0 } } });
    assert.equal(_pendingByStrategy.size, 0, 'no pending entries created');
});

test('_drainPendingStrategy drops entries whose TTL has elapsed', () => {
    _pendingByStrategy.clear();
    // Stash with an old timestamp so the next drain ages out.
    _pendingByStrategy.set('cR', {
        byStrategy: { semantic: { hits: 9, tokens: 0 } },
        ts: Date.now() - 70_000, // 70s ago — past the 60s TTL
    });
    const drained = _drainPendingStrategy('cR');
    assert.deepEqual(drained, {}, 'stale entry returns empty');
    assert.equal(_pendingByStrategy.has('cR'), false, 'stale entry removed');
});

test('_onRetrievalTurnStats — last-write-wins per conv when fired twice before drain', async () => {
    clearCostStorage();
    _pendingByStrategy.clear();
    Storage.set('activeConversation', 'cR');

    _onRetrievalTurnStats({
        conversationId: 'cR',
        strategyStats: { semantic: { hits: 2, tokens: 0 } },
    });
    _onRetrievalTurnStats({
        conversationId: 'cR',
        strategyStats: { semantic: { hits: 7, tokens: 0 } },
    });

    await _onCostUpdated({
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        sessionCost: {},
        modelId: 'm-test',
        messages: [],
        toolCalls: null,
    });

    const cc = getConvCost('cR');
    assert.equal(cc.byStrategy.semantic.hits, 7, 'second emit overwrites first');
});
