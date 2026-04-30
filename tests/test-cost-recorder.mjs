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

import { __test } from '../js/intelligence/cost/cost-recorder.js';

const { _attributeTools } = __test;

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
