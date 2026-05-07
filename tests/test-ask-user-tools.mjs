/**
 * Tests for js/tools/ask-user-tools.js (github#33 Phase 1 — ask_user).
 *
 * Asserts:
 *   - ask_user registers with `roles: 'all'` (normalized to ['all'])
 *   - argument validation: empty/missing question, bad type, missing options
 *     for choice modes, malformed option entries
 *   - happy path: handler returns a Promise; setPendingUserResponse is called
 *     with the right shape; resolveUserResponse settles with
 *     { status: 'answered', answer }
 *   - cancel path: cancelUserResponse settles the same Promise with
 *     { status: 'cancelled', cancelled: true }
 *   - free_text mode allows omitting `options`
 *
 * Runs under `node --test`. Mirrors tests/test-todo-tools.mjs scaffolding.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../js/tools/registry.js';
import { registerAskUserTools } from '../js/tools/ask-user-tools.js';
import {
    getPendingUserResponse,
    resolveUserResponse,
    cancelUserResponse,
} from '../js/chat/state.js';

// ============================================
// Harness
// ============================================

function setup() {
    ToolRegistry.clear();
    registerAskUserTools(ToolRegistry);
    // Ensure no stale pending state from a previous test
    if (getPendingUserResponse()) cancelUserResponse();
}

function getHandler(name) {
    const handler = ToolRegistry.handlers.get(name);
    assert.ok(handler, `tool ${name} should be registered`);
    return handler;
}

// ============================================
// Registration shape
// ============================================

test('ask_user registers with roles: all', () => {
    setup();
    const defs = ToolRegistry.getDefinitions();
    const def = defs.find(d => d.function?.name === 'ask_user');
    assert.ok(def, 'ask_user must be in definitions');
    assert.ok(Array.isArray(def._registeredRoles), 'roles array should be set');
    assert.deepEqual(def._registeredRoles, ['all']);
    // Confirm the schema declares the three modes the issue specifies.
    const enumValues = def.function?.parameters?.properties?.type?.enum;
    assert.deepEqual(
        new Set(enumValues),
        new Set(['single_choice', 'multi_select', 'free_text']),
    );
});

// ============================================
// Validation
// ============================================

test('ask_user rejects missing/empty question', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const r1 = await ask_user({ type: 'free_text' });
    assert.match(r1.error, /question/i);
    const r2 = await ask_user({ type: 'free_text', question: '   ' });
    assert.match(r2.error, /question/i);
});

test('ask_user rejects unknown type', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const r = await ask_user({ question: 'pick', type: 'dropdown' });
    assert.match(r.error, /type/i);
});

test('ask_user rejects single_choice without options', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const r = await ask_user({ question: 'pick', type: 'single_choice' });
    assert.match(r.error, /options/i);
});

test('ask_user rejects multi_select with empty options array', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const r = await ask_user({ question: 'pick', type: 'multi_select', options: [] });
    assert.match(r.error, /options/i);
});

test('ask_user rejects malformed option entries', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const r = await ask_user({
        question: 'pick',
        type: 'single_choice',
        options: [{ label: 'A' }],  // missing value
    });
    assert.match(r.error, /label.*value|value.*label/i);
});

test('ask_user accepts free_text without options', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const promise = ask_user({ question: 'How are you?', type: 'free_text' });
    // Pending should be set synchronously
    const pending = getPendingUserResponse();
    assert.ok(pending, 'free_text should set pending state without options');
    assert.equal(pending.type, 'free_text');
    // Settle so the Promise resolves and we don't leak between tests
    resolveUserResponse({ type: 'free_text', text: 'fine' });
    const result = await promise;
    assert.equal(result.status, 'answered');
});

// ============================================
// Happy path — resolveUserResponse
// ============================================

test('ask_user pends, then resolveUserResponse settles with the answer', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const promise = ask_user({
        question: 'Which approach?',
        type: 'single_choice',
        options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
        ],
    });
    const pending = getPendingUserResponse();
    assert.ok(pending, 'pending state must be set after handler invocation');
    assert.equal(pending.question, 'Which approach?');
    assert.equal(pending.type, 'single_choice');
    assert.equal(pending.options.length, 2);
    assert.equal(pending.allow_custom, true, 'allow_custom defaults to true');

    const ok = resolveUserResponse({ type: 'single_choice', value: 'a' });
    assert.equal(ok, true, 'resolveUserResponse should return true when a Promise was settled');
    const result = await promise;
    assert.equal(result.status, 'answered');
    assert.equal(result.answer.type, 'single_choice');
    assert.equal(result.answer.value, 'a');
    assert.equal(getPendingUserResponse(), null, 'pending must be cleared after resolve');
});

test('ask_user honors allow_custom: false', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const promise = ask_user({
        question: 'Pick one.',
        type: 'single_choice',
        options: [{ label: 'A', value: 'a' }],
        allow_custom: false,
    });
    const pending = getPendingUserResponse();
    assert.equal(pending.allow_custom, false);
    resolveUserResponse({ type: 'single_choice', value: 'a' });
    await promise;
});

// ============================================
// Cancel path
// ============================================

test('cancelUserResponse settles the Promise with cancelled:true', async () => {
    setup();
    const ask_user = getHandler('ask_user');
    const promise = ask_user({ question: 'Answer me', type: 'free_text' });
    assert.ok(getPendingUserResponse(), 'pending must be set');
    const ok = cancelUserResponse();
    assert.equal(ok, true);
    const result = await promise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.match(result.error, /cancel/i);
    assert.equal(getPendingUserResponse(), null);
});

test('resolveUserResponse on no-pending is a no-op', () => {
    setup();
    const ok = resolveUserResponse({ value: 'x' });
    assert.equal(ok, false);
});

test('cancelUserResponse on no-pending is a no-op', () => {
    setup();
    const ok = cancelUserResponse();
    assert.equal(ok, false);
});
