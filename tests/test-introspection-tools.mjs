/**
 * Tests for js/tools/introspection-tools.js — gitea#504, self-introspection
 * Phase 1 (2.90.0). Covers the three handlers (`list_conversations`,
 * `read_chat_history`, `search_chat_history`) and the `_testing` helpers
 * (`tokenize`, `normalizeMessage`, `makeSnippet`, etc.).
 *
 * Strategy:
 *   - Build a stub registry that captures `register(name, fn, def)` calls so
 *     each handler can be invoked with arg objects directly. Matches the
 *     pattern in `test-tools-foundation.mjs` for similar handler-shape probes.
 *   - Snapshot/restore `State.chatHistory` + relevant `Storage` keys around
 *     each test so cases stay independent.
 *
 * Runs under `node --test`. See `[[reference_testing_ci]]` — file name must
 * match the `tests/test-*.mjs` glob.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, Storage } from '../js/core.js';
import {
    registerIntrospectionTools,
    _testing,
} from '../js/tools/introspection-tools.js';

// ============================================
// Stub registry — capture handlers + defs.
// ============================================

const handlers = {};
const stubRegistry = {
    register(name, fn, def) {
        handlers[name] = { fn, def };
    },
};
registerIntrospectionTools(stubRegistry);

const listConvos = (args) => handlers.list_conversations.fn(args || {});
const readHistory = (args) => handlers.read_chat_history.fn(args || {});
const searchHistory = (args) => handlers.search_chat_history.fn(args || {});

// ============================================
// State + Storage helpers
// ============================================

const STORAGE_KEYS_TO_SNAPSHOT = ['conversations', 'activeConversation'];

function snapshot() {
    return {
        chatHistory: State.chatHistory.slice(),
        storage: STORAGE_KEYS_TO_SNAPSHOT.reduce((acc, k) => {
            acc[k] = Storage.get(k, undefined);
            return acc;
        }, {}),
    };
}

function restore(snap) {
    State.chatHistory.length = 0;
    if (Array.isArray(snap.chatHistory) && snap.chatHistory.length > 0) {
        State.chatHistory.push(...snap.chatHistory);
    }
    for (const k of STORAGE_KEYS_TO_SNAPSHOT) {
        const stored = snap.storage[k];
        if (stored === undefined) {
            Storage.remove(k);
        } else {
            Storage.set(k, stored);
        }
    }
}

function resetForTest() {
    State.chatHistory.length = 0;
    Storage.remove('conversations');
    Storage.remove('activeConversation');
}

function makeMessages(n, role = 'user', prefix = 'message') {
    return Array.from({ length: n }, (_, i) => ({
        role,
        content: `${prefix} ${i}`,
        timestamp: 1716422400 + i,
    }));
}

// ============================================
// _testing.tokenize
// ============================================

test('tokenize: lowercases, splits on whitespace, drops <2-char tokens', () => {
    assert.deepEqual(_testing.tokenize('  the COMPRESSION bug  '), ['the', 'compression', 'bug']);
    assert.deepEqual(_testing.tokenize('a bb cccc'), ['bb', 'cccc']);
    assert.deepEqual(_testing.tokenize(''), []);
    assert.deepEqual(_testing.tokenize('   '), []);
    assert.deepEqual(_testing.tokenize(null), []);
});

// ============================================
// _testing.normalizeMessage
// ============================================

test('normalizeMessage: string content passes through', () => {
    const out = _testing.normalizeMessage({ role: 'user', content: 'hello world' });
    assert.equal(out.content, 'hello world');
    assert.equal(out.tool_calls, undefined);
});

test('normalizeMessage: multimodal array stringifies text, marks images', () => {
    const out = _testing.normalizeMessage({
        role: 'user',
        content: [
            { type: 'text', text: 'look at' },
            { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
            { type: 'text', text: 'this' },
        ],
    });
    assert.equal(out.content, 'look at [image] this');
});

test('normalizeMessage: tool-call-only assistant gets <tool_calls: ...> summary', () => {
    const out = _testing.normalizeMessage({
        role: 'assistant',
        content: '',
        tool_calls: [
            { function: { name: 'read_file' } },
            { function: { name: 'edit_file' } },
        ],
    });
    assert.equal(out.content, '<tool_calls: read_file, edit_file>');
    assert.deepEqual(out.tool_calls, [{ name: 'read_file' }, { name: 'edit_file' }]);
});

test('normalizeMessage: tool result preserves content, drops _display', () => {
    const out = _testing.normalizeMessage({
        role: 'tool',
        content: '{"ok":true}',
        _display: 'rendered html',
    });
    assert.equal(out.content, '{"ok":true}');
    assert.equal(out.tool_calls, undefined);
});

// ============================================
// list_conversations
// ============================================

test('list_conversations: empty state returns active_id=null and empty array', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        const out = await listConvos();
        assert.equal(out.active_id, null);
        assert.equal(out.count, 0);
        assert.deepEqual(out.conversations, []);
    } finally { restore(snap); }
});

test('list_conversations: returns sorted index + active id', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('conversations', [
            { id: 'a', title: 'A', createdAt: 100, updatedAt: 200, messageCount: 3 },
            { id: 'b', title: 'B', createdAt: 50,  updatedAt: 500, messageCount: 7 },
        ]);
        Storage.set('activeConversation', 'a');
        const out = await listConvos();
        assert.equal(out.active_id, 'a');
        assert.equal(out.count, 2);
        // Sorted by updatedAt desc.
        assert.equal(out.conversations[0].id, 'b');
        assert.equal(out.conversations[1].id, 'a');
    } finally { restore(snap); }
});

test('list_conversations: caps at LIST_MAX (50)', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        const index = Array.from({ length: 60 }, (_, i) => ({
            id: `c${i}`, title: `t${i}`, createdAt: i, updatedAt: i, messageCount: 0,
        }));
        Storage.set('conversations', index);
        const out = await listConvos();
        assert.equal(out.count, 50);
        assert.equal(out.conversations.length, 50);
    } finally { restore(snap); }
});

// ============================================
// read_chat_history
// ============================================

test('read_chat_history: empty active conversation returns total=0', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        const out = await readHistory({});
        assert.equal(out.conversation_id, null);
        assert.equal(out.total, 0);
        assert.deepEqual(out.messages, []);
    } finally { restore(snap); }
});

test('read_chat_history: reads active with default limit=20', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'active-1');
        State.chatHistory.push(...makeMessages(30));
        const out = await readHistory({});
        assert.equal(out.conversation_id, 'active-1');
        assert.equal(out.total, 30);
        assert.equal(out.offset, 0);
        assert.equal(out.limit, 20);
        assert.equal(out.messages.length, 20);
        assert.equal(out.messages[0].index, 0);
        assert.equal(out.messages[0].content, 'message 0');
        assert.equal(out.messages[19].index, 19);
    } finally { restore(snap); }
});

test('read_chat_history: pagination via offset + limit', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'active-1');
        State.chatHistory.push(...makeMessages(30));
        const out = await readHistory({ offset: 20, limit: 10 });
        assert.equal(out.total, 30);
        assert.equal(out.messages.length, 10);
        assert.equal(out.messages[0].index, 20);
        assert.equal(out.messages[9].index, 29);
    } finally { restore(snap); }
});

test('read_chat_history: limit cap rejects >READ_MAX_LIMIT', async () => {
    const out = await readHistory({ limit: 999 });
    assert.ok(typeof out.error === 'string' && out.error.includes('100'));
});

test('read_chat_history: negative offset rejected', async () => {
    const out = await readHistory({ offset: -1 });
    assert.ok(typeof out.error === 'string' && out.error.includes('offset'));
});

test('read_chat_history: non-integer limit rejected', async () => {
    const out = await readHistory({ limit: 1.5 });
    assert.ok(typeof out.error === 'string');
});

test('read_chat_history: bogus conversation_id returns error envelope', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        const out = await readHistory({ conversation_id: 'does-not-exist' });
        assert.ok(typeof out.error === 'string' && out.error.includes('does-not-exist'));
    } finally { restore(snap); }
});

test('read_chat_history: reads non-active conversation from Storage', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'active-1');
        Storage.set('conv-other-1', {
            messages: [
                { role: 'user', content: 'archived hello', timestamp: 1 },
                { role: 'assistant', content: 'archived reply', timestamp: 2 },
            ],
        });
        const out = await readHistory({ conversation_id: 'other-1' });
        assert.equal(out.conversation_id, 'other-1');
        assert.equal(out.total, 2);
        assert.equal(out.messages[0].content, 'archived hello');
    } finally { restore(snap); }
});

test('read_chat_history: multimodal envelope flattens text + [image]', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push({
            role: 'user',
            content: [
                { type: 'text', text: 'hi' },
                { type: 'image_url', image_url: { url: 'data:...' } },
            ],
            timestamp: 100,
        });
        const out = await readHistory({});
        assert.equal(out.messages[0].content, 'hi [image]');
    } finally { restore(snap); }
});

test('read_chat_history: tool-call-only message surfaces <tool_calls: ...> + tool_calls field', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push({
            role: 'assistant',
            content: '',
            tool_calls: [
                { function: { name: 'read_file' } },
                { function: { name: 'edit_file' } },
            ],
            timestamp: 100,
        });
        const out = await readHistory({});
        assert.equal(out.messages[0].content, '<tool_calls: read_file, edit_file>');
        assert.deepEqual(out.messages[0].tool_calls, [{ name: 'read_file' }, { name: 'edit_file' }]);
    } finally { restore(snap); }
});

// ============================================
// search_chat_history
// ============================================

test('search_chat_history: missing query is an error', async () => {
    const out = await searchHistory({});
    assert.ok(typeof out.error === 'string' && out.error.includes('query'));
});

test('search_chat_history: AND-match hits message containing all tokens', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push(
            { role: 'user', content: 'the compression bug ate my lunch', timestamp: 100 },
            { role: 'assistant', content: 'compression alone', timestamp: 101 },
            { role: 'user', content: 'bug alone', timestamp: 102 },
        );
        const out = await searchHistory({ query: 'compression bug' });
        assert.equal(out.count, 1);
        assert.equal(out.hits[0].message_index, 0);
        assert.equal(out.hits[0].role, 'user');
        assert.equal(out.hits[0].conversation_id, 'a1');
        assert.ok(out.hits[0].score >= 2);
    } finally { restore(snap); }
});

test('search_chat_history: zero hits when no message matches all tokens', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push(
            { role: 'user', content: 'hello world', timestamp: 100 },
        );
        const out = await searchHistory({ query: 'nope absent' });
        assert.equal(out.count, 0);
        assert.deepEqual(out.hits, []);
    } finally { restore(snap); }
});

test('search_chat_history: query with no scorable tokens returns helpful message', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push({ role: 'user', content: 'hello', timestamp: 100 });
        const out = await searchHistory({ query: 'a b' });
        assert.equal(out.count, 0);
        assert.ok(typeof out.message === 'string' && out.message.includes('scorable'));
    } finally { restore(snap); }
});

test('search_chat_history: conversation_id="*" scans all stored conversations', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push({ role: 'user', content: 'active hit one', timestamp: 100 });
        Storage.set('conversations', [
            { id: 'a1', title: 'active', createdAt: 1, updatedAt: 2, messageCount: 1 },
            { id: 'b2', title: 'archived', createdAt: 1, updatedAt: 1, messageCount: 1 },
        ]);
        Storage.set('conv-b2', {
            messages: [{ role: 'user', content: 'archived hit two', timestamp: 50 }],
        });
        const out = await searchHistory({ query: 'hit', conversation_id: '*' });
        assert.equal(out.scope, '*');
        assert.equal(out.count, 2);
        const convIds = out.hits.map(h => h.conversation_id).sort();
        assert.deepEqual(convIds, ['a1', 'b2']);
    } finally { restore(snap); }
});

test('search_chat_history: max_hits caps result count', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        for (let i = 0; i < 20; i++) {
            State.chatHistory.push({ role: 'user', content: `match ${i}`, timestamp: 100 + i });
        }
        const out = await searchHistory({ query: 'match', max_hits: 5 });
        assert.equal(out.count, 5);
    } finally { restore(snap); }
});

test('search_chat_history: max_hits >50 rejected', async () => {
    const out = await searchHistory({ query: 'x', max_hits: 999 });
    assert.ok(typeof out.error === 'string' && out.error.includes('50'));
});

test('search_chat_history: results sort by score desc then timestamp desc', async () => {
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push(
            { role: 'user', content: 'bug', timestamp: 100 },           // score 1
            { role: 'user', content: 'bug bug bug', timestamp: 50 },    // score 3 (older)
            { role: 'user', content: 'bug bug', timestamp: 200 },       // score 2
        );
        const out = await searchHistory({ query: 'bug' });
        assert.equal(out.hits[0].score, 3);
        assert.equal(out.hits[1].score, 2);
        assert.equal(out.hits[2].score, 1);
    } finally { restore(snap); }
});

test('search_chat_history: snippet caps long content with ellipsis', async () => {
    const long = 'a'.repeat(400) + ' compression ' + 'z'.repeat(400);
    const snap = snapshot();
    try {
        resetForTest();
        Storage.set('activeConversation', 'a1');
        State.chatHistory.push({ role: 'user', content: long, timestamp: 100 });
        const out = await searchHistory({ query: 'compression' });
        assert.equal(out.count, 1);
        const snippet = out.hits[0].snippet;
        assert.ok(snippet.length <= _testing.SEARCH_SNIPPET_CHARS + 2,
            `snippet length ${snippet.length} should not exceed ${_testing.SEARCH_SNIPPET_CHARS}+2`);
        assert.ok(snippet.includes('compression'));
        assert.ok(snippet.startsWith('…') || snippet.endsWith('…'));
    } finally { restore(snap); }
});

// ============================================
// Tool definition shape sanity
// ============================================

test('definitions: all three tools register with readOnly:true and cache:"never"', () => {
    for (const name of ['list_conversations', 'read_chat_history', 'search_chat_history']) {
        const h = handlers[name];
        assert.ok(h, `${name} should be registered`);
        assert.equal(h.def.readOnly, true);
        assert.equal(h.def.cache, 'never');
        assert.equal(h.def.type, 'function');
        assert.equal(h.def.function.name, name);
        assert.ok(typeof h.def.function.description === 'string' && h.def.function.description.length > 30);
    }
});
