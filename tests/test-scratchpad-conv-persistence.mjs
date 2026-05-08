/**
 * Tests for per-conversation scratchpad persistence (1.11.0).
 *
 * Pre-1.11.0 the scratchpad lived only at `State.scratchpad` and was reset on
 * every refresh / new chat / conversation switch. From 1.11.0 it rides in the
 * `conv-{id}` payload alongside todos and survives refresh; new chat still
 * blanks it (correct semantics: new chat = blank pad), and deleting the last
 * conversation still blanks it (correct: pad goes with the chat that owned it).
 *
 * Asserts:
 *   - save() includes a `scratchpad` field in the conv-{id} payload.
 *   - load() restores `State.scratchpad` from the payload.
 *   - load() with a payload that lacks the field defaults to `{}`.
 *   - create() clears `State.scratchpad`.
 *   - delete() of the last conversation clears `State.scratchpad`.
 *   - Each lifecycle hook emits `scratchpad:changed` on the EventBus.
 *
 * Stubs Storage with an in-memory Map so the test controls every byte;
 * doesn't depend on IDB / localStorage shim behavior.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, Storage, EventBus } from '../js/core.js';
import { ConversationManager } from '../js/chat/conversations.js';

// ============================================
// Storage stub — in-memory Map, replaces Storage.set/get/remove for the suite.
// ============================================

const _origGet = Storage.get.bind(Storage);
const _origSet = Storage.set.bind(Storage);
const _origRemove = Storage.remove.bind(Storage);

let store = new Map();

function installStub() {
    store = new Map();
    Storage.get = (key, defaultValue = null) => (store.has(key) ? store.get(key) : defaultValue);
    Storage.set = (key, value) => { store.set(key, value); };
    Storage.remove = (key) => { store.delete(key); };
}

function restoreStub() {
    Storage.get = _origGet;
    Storage.set = _origSet;
    Storage.remove = _origRemove;
}

// EventBus spy
let events = [];
function captureEvents(...names) {
    events = [];
    const handlers = names.map(name => {
        const fn = (payload) => { events.push({ name, payload }); };
        EventBus.on(name, fn);
        return { name, fn };
    });
    return () => {
        for (const { name, fn } of handlers) EventBus.off(name, fn);
    };
}

function reset() {
    store.clear();
    State.chatHistory.length = 0;
    State.scratchpad = {};
    State.toolActionLog = [];
    State.todo = [];
    State.lastExchangeTokens = null;
    events = [];
}

test.before(installStub);
test.after(restoreStub);

// ============================================
// save() — payload includes scratchpad
// ============================================

test('save: conv-{id} payload includes scratchpad field', () => {
    reset();
    State.chatHistory.push({ role: 'user', content: 'hello' });
    State.scratchpad = { plan: 'step 1', notes: 'be careful' };
    store.set('activeConversation', 'abc');

    ConversationManager.save();

    const payload = store.get('conv-abc');
    assert.ok(payload, 'payload exists');
    assert.deepEqual(payload.scratchpad, { plan: 'step 1', notes: 'be careful' });
});

test('save: scratchpad is shallow-copied, not the live reference', () => {
    reset();
    State.chatHistory.push({ role: 'user', content: 'hi' });
    State.scratchpad = { x: '1' };
    store.set('activeConversation', 'abc');

    ConversationManager.save();
    const payload = store.get('conv-abc');
    // Mutate State.scratchpad after save — payload must not see the change.
    State.scratchpad.x = '2';
    State.scratchpad.y = 'leaked';
    assert.equal(payload.scratchpad.x, '1');
    assert.equal(payload.scratchpad.y, undefined);
});

test('save: empty scratchpad becomes empty object in payload, not undefined', () => {
    reset();
    State.chatHistory.push({ role: 'user', content: 'hi' });
    State.scratchpad = {};
    store.set('activeConversation', 'abc');
    ConversationManager.save();
    const payload = store.get('conv-abc');
    assert.deepEqual(payload.scratchpad, {});
});

// ============================================
// load() — restores scratchpad and emits scratchpad:changed
// ============================================

test('load: restores State.scratchpad from payload', () => {
    reset();
    store.set('conv-xyz', {
        messages: [{ role: 'user', content: 'previously saved' }],
        scratchpad: { plan: 'restore me', step: 'two' },
        todos: [],
    });
    const cleanup = captureEvents('scratchpad:changed', 'conversation:loaded');

    ConversationManager.load('xyz');

    assert.deepEqual(State.scratchpad, { plan: 'restore me', step: 'two' });
    const restored = events.find(e => e.name === 'scratchpad:changed');
    assert.ok(restored, 'scratchpad:changed must fire on load');
    assert.equal(restored.payload?.action, 'restored');
    cleanup();
});

test('load: payload missing scratchpad defaults to {}', () => {
    reset();
    State.scratchpad = { stale: 'should-be-replaced' };
    store.set('conv-xyz', {
        messages: [{ role: 'user', content: 'old payload' }],
        // no scratchpad field — pre-1.11.0 conversation
        todos: [],
    });
    ConversationManager.load('xyz');
    assert.deepEqual(State.scratchpad, {});
});

test('load: payload with non-object scratchpad defaults to {}', () => {
    reset();
    store.set('conv-xyz', {
        messages: [{ role: 'user', content: 'corrupt' }],
        scratchpad: 'not-an-object',
        todos: [],
    });
    ConversationManager.load('xyz');
    assert.deepEqual(State.scratchpad, {});
});

// ============================================
// create() — clears State.scratchpad and emits scratchpad:changed
// ============================================

test('create: clears State.scratchpad and emits scratchpad:changed', () => {
    reset();
    State.scratchpad = { something: 'from-prior-chat' };
    const cleanup = captureEvents('scratchpad:changed', 'conversation:created');

    const id = ConversationManager.create();
    assert.ok(id);
    assert.deepEqual(State.scratchpad, {});
    const cleared = events.find(e => e.name === 'scratchpad:changed');
    assert.ok(cleared, 'scratchpad:changed must fire on create');
    assert.equal(cleared.payload?.action, 'cleared');
    cleanup();
});

// ============================================
// delete() — when removing the last conversation, scratchpad is cleared
// ============================================

test('delete: last conversation clears State.scratchpad', () => {
    reset();
    // Seed one conversation in the index + payload, mark it active.
    store.set('conversations', [{
        id: 'only', title: 'only', createdAt: 1, updatedAt: 1, messageCount: 0,
    }]);
    store.set('conv-only', {
        messages: [],
        scratchpad: { irrelevant: 'true' },
        todos: [],
    });
    store.set('activeConversation', 'only');
    State.scratchpad = { live: 'data' };
    const cleanup = captureEvents('scratchpad:changed', 'conversation:deleted', 'conversation:loaded');

    const ok = ConversationManager.delete('only');
    assert.equal(ok !== false, true);
    assert.deepEqual(State.scratchpad, {});
    const cleared = events.find(e => e.name === 'scratchpad:changed');
    assert.ok(cleared, 'scratchpad:changed must fire on last-conversation delete');
    assert.equal(cleared.payload?.action, 'cleared');
    cleanup();
});

// ============================================
// Round-trip — save → load preserves scratchpad shape exactly
// ============================================

test('round-trip: save then load preserves the full scratchpad', () => {
    reset();
    State.chatHistory.push({ role: 'user', content: 'q' });
    const original = {
        plan: 'p',
        nested: { a: 1, b: [2, 3] },
        empty: '',
    };
    State.scratchpad = { ...original };
    store.set('activeConversation', 'rt');

    ConversationManager.save();
    State.scratchpad = { stale: 'replace-me' };
    State.chatHistory.length = 0;
    ConversationManager.load('rt');

    assert.deepEqual(State.scratchpad, original);
});
