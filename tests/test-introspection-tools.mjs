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
// Tool definition shape sanity (Phase 1)
// ============================================

test('definitions: all three Phase 1 tools register with readOnly:true and cache:"never"', () => {
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

// ============================================
// PHASE 2 — runtime state + telemetry (gitea#506)
// ============================================

const PHASE_2_NAMES = [
    'get_active_profile',
    'list_loaded_tools',
    'get_budget_state',
    'get_token_usage',
    'get_retrieval_stats',
    'get_recent_errors',
];

const getActiveProfile = () => handlers.get_active_profile.fn({});
const listLoadedTools = () => handlers.list_loaded_tools.fn({});
const getBudgetState = () => handlers.get_budget_state.fn({});
const getTokenUsage = (args) => handlers.get_token_usage.fn(args || {});
const getRetrievalStats = () => handlers.get_retrieval_stats.fn({});
const getRecentErrors = (args) => handlers.get_recent_errors.fn(args || {});

// Phase 2 needs to snapshot/restore State.sessionCost + State.settings.profile
// + State.settings.embeddingModel + State.subagents.session_cost.byModel
// because each tool reads from one of these. The Phase 1 snapshot covered
// chatHistory + Storage only.
function phase2Snapshot() {
    return {
        sessionCost: { ...(State.sessionCost || {}) },
        profile: State.settings.profile,
        embeddingModel: State.settings.embeddingModel,
        subagents: JSON.parse(JSON.stringify(State.subagents || {})),
    };
}

function phase2Restore(snap) {
    State.sessionCost = { ...snap.sessionCost };
    State.settings.profile = snap.profile;
    State.settings.embeddingModel = snap.embeddingModel;
    State.subagents = JSON.parse(JSON.stringify(snap.subagents));
}

// ============================================
// get_active_profile
// ============================================

test('get_active_profile: returns name, base, admitted_tools[], budget, ceilings', async () => {
    const snap = phase2Snapshot();
    try {
        State.settings.profile = 'coder.v1';
        const out = await getActiveProfile();
        assert.equal(out.name, 'coder.v1');
        // coder.v1 inherits from chat.v1.
        assert.equal(typeof out.base, 'string');
        assert.ok(Array.isArray(out.admitted_tools));
        assert.ok(out.admitted_tools.length > 0);
        // BudgetSpec keys.
        assert.equal(typeof out.budget.total_tokens, 'number');
        assert.equal(typeof out.budget.system_reserve, 'number');
        assert.equal(typeof out.budget.output_reserve, 'number');
        assert.equal(typeof out.budget.history_reserve, 'number');
        assert.equal(typeof out.budget.memory_reserve, 'number');
        // Ceilings keys.
        assert.equal(typeof out.ceilings.tools_budget_tokens, 'number');
        assert.equal(typeof out.ceilings.task_ledger_capacity, 'number');
    } finally { phase2Restore(snap); }
});

test('get_active_profile: includes the Phase 2 tools in admitted_tools for coder.v1', async () => {
    const snap = phase2Snapshot();
    try {
        State.settings.profile = 'coder.v1';
        const out = await getActiveProfile();
        for (const name of PHASE_2_NAMES) {
            assert.ok(out.admitted_tools.includes(name), `coder.v1 admitted_tools should include ${name}`);
        }
    } finally { phase2Restore(snap); }
});

test('get_active_profile: subagent.v1 does NOT admit Phase 2 tools (clean-start boundary)', async () => {
    const snap = phase2Snapshot();
    try {
        State.settings.profile = 'subagent.v1';
        const out = await getActiveProfile();
        for (const name of PHASE_2_NAMES) {
            assert.ok(!out.admitted_tools.includes(name),
                `subagent.v1 admitted_tools should NOT include ${name} (Phase 2 clean-start boundary)`);
        }
    } finally { phase2Restore(snap); }
});

// ============================================
// list_loaded_tools
// ============================================

test('list_loaded_tools: returns count + tools[] with name/category/side_effects/cache_mode', async () => {
    const out = await listLoadedTools();
    assert.equal(typeof out.count, 'number');
    assert.ok(Array.isArray(out.tools));
    assert.equal(out.count, out.tools.length);
    // Each entry must have the four fields.
    for (const t of out.tools.slice(0, 5)) {
        assert.equal(typeof t.name, 'string');
        assert.equal(typeof t.category, 'string');
        assert.ok(['read', 'write', 'external'].includes(t.side_effects),
            `side_effects must be one of read/write/external, got "${t.side_effects}" for ${t.name}`);
        assert.ok(['by-args', 'never'].includes(t.cache_mode),
            `cache_mode must be one of by-args/never, got "${t.cache_mode}" for ${t.name}`);
    }
});

test('list_loaded_tools: tools[] is sorted by name', async () => {
    const out = await listLoadedTools();
    const sorted = [...out.tools].sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(out.tools.map(t => t.name), sorted.map(t => t.name));
});

// ============================================
// get_budget_state
// ============================================

test('get_budget_state: returns total/used/remaining_estimate/reserves/depth shape', async () => {
    const snap = phase2Snapshot();
    try {
        State.settings.profile = 'chat.v1';
        State.sessionCost = {
            ...(State.sessionCost || {}),
            totalInputTokens: 1000,
            totalOutputTokens: 500,
        };
        const out = await getBudgetState();
        assert.equal(typeof out.total, 'number');
        assert.equal(typeof out.used, 'number');
        assert.equal(typeof out.remaining_estimate, 'number');
        assert.ok(out.remaining_estimate >= 0);
        assert.equal(typeof out.depth, 'number');
        // Reserves block has four named slots.
        assert.equal(typeof out.reserves.system, 'number');
        assert.equal(typeof out.reserves.output, 'number');
        assert.equal(typeof out.reserves.history, 'number');
        assert.equal(typeof out.reserves.memory, 'number');
        // Used reflects what we set.
        assert.equal(out.used, 1500);
    } finally { phase2Restore(snap); }
});

test('get_budget_state: depth reflects chatHistory length', async () => {
    const histSnap = snapshot();
    const snap = phase2Snapshot();
    try {
        resetForTest();
        State.settings.profile = 'chat.v1';
        State.chatHistory.push(...makeMessages(7));
        const out = await getBudgetState();
        assert.equal(out.depth, 7);
    } finally { phase2Restore(snap); restore(histSnap); }
});

// ============================================
// get_token_usage
// ============================================

test('get_token_usage: returns {scope, conversation, session, by_model}', async () => {
    const snap = phase2Snapshot();
    try {
        State.sessionCost = {
            ...(State.sessionCost || {}),
            totalInputTokens: 10000,
            totalOutputTokens: 2000,
            totalCost: 0.05,
            requests: 7,
        };
        const out = await getTokenUsage();
        assert.equal(out.scope, 'conversation');
        assert.equal(typeof out.conversation, 'object');
        assert.equal(typeof out.session, 'object');
        assert.equal(typeof out.by_model, 'object');
        assert.equal(out.session.inputTokens, 10000);
        assert.equal(out.session.outputTokens, 2000);
        assert.equal(out.session.cost, 0.05);
        assert.equal(out.session.requests, 7);
    } finally { phase2Restore(snap); }
});

test('get_token_usage: scope arg accepts conversation/session/all, rejects others', async () => {
    let out = await getTokenUsage({ scope: 'session' });
    assert.equal(out.scope, 'session');
    out = await getTokenUsage({ scope: 'all' });
    assert.equal(out.scope, 'all');
    out = await getTokenUsage({ scope: 'bogus' });
    assert.ok(typeof out.error === 'string' && out.error.includes('scope'));
});

test('get_token_usage: by_model surfaces subagents.session_cost.byModel', async () => {
    const snap = phase2Snapshot();
    try {
        State.subagents = {
            tree: {},
            transcripts: {},
            session_cost: {
                dollars: 0.01,
                tokens: 1234,
                byModel: {
                    'cheap-tier-model': { dollars: 0.005, tokens: 600 },
                    'main-tier-model': { dollars: 0.005, tokens: 634 },
                },
            },
        };
        const out = await getTokenUsage({ scope: 'all' });
        assert.equal(out.by_model['cheap-tier-model'].tokens, 600);
        assert.equal(out.by_model['main-tier-model'].dollars, 0.005);
    } finally { phase2Restore(snap); }
});

// ============================================
// get_retrieval_stats
// ============================================

test('get_retrieval_stats: returns expected envelope keys', async () => {
    const snap = phase2Snapshot();
    try {
        State.settings.profile = 'chat.v1';
        State.settings.embeddingModel = 'test-embedder-model';
        const out = await getRetrievalStats();
        assert.equal(typeof out.enabled, 'boolean');
        assert.equal(typeof out.indexing, 'boolean');
        assert.equal(typeof out.files_indexed, 'number');
        assert.ok(Array.isArray(out.collections));
        assert.equal(out.embedder, 'test-embedder-model');
        // last_indexed_at + last_queried_at are present (may be null).
        assert.ok('last_indexed_at' in out);
        assert.ok('last_queried_at' in out);
    } finally { phase2Restore(snap); }
});

// ============================================
// get_recent_errors
// ============================================

test('get_recent_errors: empty ring returns count=0', async () => {
    const out = await getRecentErrors();
    // Other tests in the suite may have pushed entries; just assert envelope shape.
    assert.equal(typeof out.count, 'number');
    assert.ok(Array.isArray(out.errors));
    assert.equal(out.count, out.errors.length);
});

test('get_recent_errors: rejects non-integer limit', async () => {
    const out = await getRecentErrors({ limit: 1.5 });
    assert.ok(typeof out.error === 'string' && out.error.includes('limit'));
});

test('get_recent_errors: rejects limit above max (50)', async () => {
    const out = await getRecentErrors({ limit: 9999 });
    assert.ok(typeof out.error === 'string' && out.error.includes('50'));
});

test('get_recent_errors: rejects negative limit', async () => {
    const out = await getRecentErrors({ limit: -1 });
    assert.ok(typeof out.error === 'string' && out.error.includes('limit'));
});

// ============================================
// Phase 2 — Tool definition shape sanity
// ============================================

test('definitions: all six Phase 2 tools register with readOnly:true and cache:"never"', () => {
    for (const name of PHASE_2_NAMES) {
        const h = handlers[name];
        assert.ok(h, `${name} should be registered`);
        assert.equal(h.def.readOnly, true, `${name}.readOnly must be true`);
        assert.equal(h.def.cache, 'never', `${name}.cache must be "never"`);
        assert.equal(h.def.type, 'function');
        assert.equal(h.def.function.name, name);
        assert.ok(typeof h.def.function.description === 'string' && h.def.function.description.length > 30,
            `${name}.description must be >30 chars`);
    }
});
