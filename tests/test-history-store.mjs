/**
 * Tests for js/chat/history-store.js — the single owner of `State.chatHistory`
 * mutations + persistence introduced at 1.11.0.
 *
 * Asserts:
 *   - append/splice/replace/clear/setLength mutate `State.chatHistory` in place
 *     (preserving array reference identity for any captured consumer).
 *   - Each method calls `Storage.set('chatHistory', …)` exactly once per call.
 *   - splice returns the removed slice and matches Array.prototype.splice
 *     semantics for the (start) and (start, deleteCount) arg shapes.
 *
 * Runs under `node --test`. Stubs `Storage.set` with a counting spy so the
 * test doesn't depend on IDB/localStorage behavior under the node shim.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, Storage } from '../js/core.js';
import { ChatHistoryStore } from '../js/chat/history-store.js';

// ============================================
// Spy harness — count Storage.set calls and capture the last (key, value)
// ============================================

const _origSet = Storage.set.bind(Storage);
let _calls = [];

function installSpy() {
    _calls = [];
    Storage.set = (key, value) => {
        _calls.push({ key, value });
        // Don't actually persist — keeps tests independent of IDB/LS behavior.
    };
}

function restoreSpy() {
    Storage.set = _origSet;
}

function setsForChatHistory() {
    return _calls.filter(c => c.key === 'chatHistory');
}

function reset() {
    State.chatHistory.length = 0;
    _calls = [];
}

test.before(installSpy);
test.after(restoreSpy);

// ============================================
// append
// ============================================

test('append: pushes the message and persists once', () => {
    reset();
    const ref = State.chatHistory;
    ChatHistoryStore.append({ role: 'user', content: 'hello' });
    assert.equal(State.chatHistory.length, 1);
    assert.equal(State.chatHistory[0].role, 'user');
    assert.equal(State.chatHistory[0].content, 'hello');
    assert.equal(setsForChatHistory().length, 1);
    // Reference identity preserved
    assert.equal(State.chatHistory, ref);
});

test('append: persisted value is the live array', () => {
    reset();
    ChatHistoryStore.append({ role: 'user', content: 'a' });
    ChatHistoryStore.append({ role: 'assistant', content: 'b' });
    const sets = setsForChatHistory();
    assert.equal(sets.length, 2);
    // Last set captured the live array (length 2 at that point)
    assert.equal(sets[1].value.length, 2);
});

// ============================================
// splice
// ============================================

test('splice(start): truncates from start and persists once', () => {
    reset();
    State.chatHistory.push({ role: 'u', content: '1' });
    State.chatHistory.push({ role: 'a', content: '2' });
    State.chatHistory.push({ role: 'u', content: '3' });
    _calls = [];
    const removed = ChatHistoryStore.splice(1);
    assert.equal(State.chatHistory.length, 1);
    assert.equal(State.chatHistory[0].content, '1');
    assert.equal(removed.length, 2);
    assert.equal(removed[0].content, '2');
    assert.equal(removed[1].content, '3');
    assert.equal(setsForChatHistory().length, 1);
});

test('splice(start, count): removes count elements from start', () => {
    reset();
    State.chatHistory.push({ role: 'u', content: '1' });
    State.chatHistory.push({ role: 'a', content: '2' });
    State.chatHistory.push({ role: 'u', content: '3' });
    State.chatHistory.push({ role: 'a', content: '4' });
    _calls = [];
    const removed = ChatHistoryStore.splice(0, 2);
    assert.equal(State.chatHistory.length, 2);
    assert.equal(State.chatHistory[0].content, '3');
    assert.equal(removed.length, 2);
    assert.equal(removed[0].content, '1');
    assert.equal(setsForChatHistory().length, 1);
});

// ============================================
// setLength — used by handlers.js error rollback
// ============================================

test('setLength(n): truncates to length and persists once', () => {
    reset();
    State.chatHistory.push({ role: 'u', content: '1' });
    State.chatHistory.push({ role: 'a', content: '2' });
    State.chatHistory.push({ role: 'u', content: '3' });
    _calls = [];
    ChatHistoryStore.setLength(1);
    assert.equal(State.chatHistory.length, 1);
    assert.equal(State.chatHistory[0].content, '1');
    assert.equal(setsForChatHistory().length, 1);
});

// ============================================
// replace — used by load / undoPrune / boot restore
// ============================================

test('replace(arr): overwrites contents in place, preserving identity', () => {
    reset();
    State.chatHistory.push({ role: 'old', content: 'x' });
    const ref = State.chatHistory;
    _calls = [];
    ChatHistoryStore.replace([
        { role: 'u', content: 'a' },
        { role: 'a', content: 'b' },
    ]);
    assert.equal(State.chatHistory.length, 2);
    assert.equal(State.chatHistory[0].content, 'a');
    assert.equal(State.chatHistory[1].content, 'b');
    assert.equal(setsForChatHistory().length, 1);
    // Reference identity — critical: virtualizer / metadata probes capture
    // the array; replace must not detach the existing reference.
    assert.equal(State.chatHistory, ref);
});

test('replace(arr) with empty array clears in place', () => {
    reset();
    State.chatHistory.push({ role: 'u', content: 'x' });
    const ref = State.chatHistory;
    _calls = [];
    ChatHistoryStore.replace([]);
    assert.equal(State.chatHistory.length, 0);
    assert.equal(State.chatHistory, ref);
    assert.equal(setsForChatHistory().length, 1);
});

test('replace(undefined) treats as empty without throwing', () => {
    reset();
    State.chatHistory.push({ role: 'u', content: 'x' });
    _calls = [];
    ChatHistoryStore.replace(undefined);
    assert.equal(State.chatHistory.length, 0);
    assert.equal(setsForChatHistory().length, 1);
});

// ============================================
// clear
// ============================================

test('clear: empties in place and persists once', () => {
    reset();
    State.chatHistory.push({ role: 'u', content: '1' });
    State.chatHistory.push({ role: 'a', content: '2' });
    const ref = State.chatHistory;
    _calls = [];
    ChatHistoryStore.clear();
    assert.equal(State.chatHistory.length, 0);
    assert.equal(State.chatHistory, ref);
    assert.equal(setsForChatHistory().length, 1);
});

// ============================================
// Persist-once guarantee — no method writes more than once per call
// ============================================

test('persist-once: every public method calls Storage.set exactly once', () => {
    reset();
    ChatHistoryStore.append({ role: 'u', content: '1' });
    assert.equal(setsForChatHistory().length, 1, 'append');

    _calls = [];
    ChatHistoryStore.splice(0);
    assert.equal(setsForChatHistory().length, 1, 'splice');

    _calls = [];
    ChatHistoryStore.replace([{ role: 'u', content: 'x' }]);
    assert.equal(setsForChatHistory().length, 1, 'replace');

    _calls = [];
    ChatHistoryStore.setLength(0);
    assert.equal(setsForChatHistory().length, 1, 'setLength');

    _calls = [];
    ChatHistoryStore.clear();
    assert.equal(setsForChatHistory().length, 1, 'clear');
});
