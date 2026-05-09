/**
 * Tests for `js/mcp/bridge.js` — connect/disconnect orchestration.
 *
 * Stubs `globalThis.fetch` so the protocol layer thinks it's talking to a
 * real MCP server. Asserts:
 *   - connect translates `tools/list` into `ToolRegistry.register()` calls
 *     with `mcp__<id>__<name>` names, `mcp.<id>` category, roles 'all'
 *   - Catalog auto-derives the registered MCP tools (no extra wiring)
 *   - disconnect calls ToolRegistry.unregister and aborts in-flight calls
 *   - reconnect cleans up stale registrations from a prior connect
 *   - sweepLedgersByToolId removes orphan sticky records
 *   - failed connect marks the server _unreachable
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../js/tools/registry.js';
import { Catalog } from '../js/intelligence/tools/catalog.js';
import { MCPServerRegistry } from '../js/mcp/registry.js';
import * as bridge from '../js/mcp/bridge.js';
import { State } from '../js/core.js';
import {
    getOrCreateLedger,
    sweepLedgersByToolId,
    _resetForTests as resetTaskState,
} from '../js/chat/task-state.js';

const ORIG_FETCH = globalThis.fetch;

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Build a fetch stub that responds to MCP requests with canned results.
 * `tools` is the array returned for tools/list; `toolsCallResult` is
 * returned for any tools/call.
 */
function makeFetchStub(tools, toolsCallResult) {
    const calls = [];
    const stub = async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ url, method: body.method, body });
        if (body.method === 'initialize') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub' } } });
        }
        if (body.method === 'tools/list') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools } });
        }
        if (body.method === 'tools/call') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: toolsCallResult || { content: [{ type: 'text', text: 'ok' }] } });
        }
        // notifications/initialized has no id, returns 202
        return new Response('', { status: 202 });
    };
    stub.calls = calls;
    return stub;
}

/** Wipe everything between cases so order doesn't matter. */
function resetAll() {
    bridge.__test.reset();
    MCPServerRegistry.__test_reset();
    resetTaskState();
    // Strip any prior `mcp__*` registrations from ToolRegistry — `unregister`
    // is the new symmetric API; this mirrors what bridge.disconnect does.
    const names = ToolRegistry.getDefinitions()
        .map(d => d.function?.name)
        .filter(n => typeof n === 'string' && n.startsWith('mcp__'));
    for (const n of names) ToolRegistry.unregister(n);
}

test('connect: translates tools/list into ToolRegistry entries', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([
        { name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
        { name: 'reverse', description: 'Reverse a string' },
    ]);
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });

    const result = await bridge.connect('demo');
    assert.equal(result.ok, true);
    assert.equal(result.toolCount, 2);

    const defs = ToolRegistry.getDefinitions().filter(d => d.function?.name?.startsWith('mcp__demo__'));
    assert.equal(defs.length, 2);
    const names = defs.map(d => d.function.name).sort();
    assert.deepEqual(names, ['mcp__demo__echo', 'mcp__demo__reverse']);

    // Catalog auto-derives via getDefinitions; categories pick up the override.
    const td = Catalog.getByName('mcp__demo__echo');
    assert.ok(td);
    assert.equal(td.category, 'mcp.demo');
    assert.match(td.description, /\[MCP Demo\]/);

    // Server record updated.
    const server = MCPServerRegistry.getServer('demo');
    assert.equal(server._toolCount, 2);
    assert.ok(server._lastSync !== null);

    globalThis.fetch = ORIG_FETCH;
});

test('connect: handler routes invocations through tools/call', async () => {
    resetAll();
    const stub = makeFetchStub(
        [{ name: 'echo', description: 'Echo' }],
        { content: [{ type: 'text', text: 'pong' }] }
    );
    globalThis.fetch = stub;
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');

    const result = await ToolRegistry.execute('mcp__demo__echo', { msg: 'hi' });
    assert.equal(result.result, 'pong');
    const callRecord = stub.calls.find(c => c.method === 'tools/call');
    assert.ok(callRecord);
    assert.deepEqual(callRecord.body.params, { name: 'echo', arguments: { msg: 'hi' } });

    globalThis.fetch = ORIG_FETCH;
});

test('connect: isError envelope surfaces as handler error', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub(
        [{ name: 'echo', description: 'Echo' }],
        { content: [{ type: 'text', text: 'kaboom' }], isError: true }
    );
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');

    const result = await ToolRegistry.execute('mcp__demo__echo', {});
    assert.match(result.error, /isError.*kaboom/);

    globalThis.fetch = ORIG_FETCH;
});

test('disconnect: unregisters tools and sweeps stale ledger entries', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([{ name: 'echo', description: 'Echo' }]);
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');

    // Plant a sticky entry so disconnect's sweep has something to remove.
    const ledger = getOrCreateLedger('conv-1', 'coder.v1');
    ledger.tool_admissions.push({
        tool_id: 'mcp__demo__echo',
        admitted_at: 1, form: 'full', source: 'discovery', cost: 100, last_used_at: 1,
    });
    ledger.tool_invocations.push({
        tool_id: 'mcp__demo__echo', invoked_at: 1, turn_id: 't', args_summary: '', succeeded: true,
    });

    const { unregistered, swept } = await bridge.disconnect('demo');
    assert.equal(unregistered, 1);
    assert.equal(swept.admissionsRemoved, 1);
    assert.equal(swept.invocationsRemoved, 1);

    const after = ToolRegistry.getDefinitions().find(d => d.function?.name === 'mcp__demo__echo');
    assert.equal(after, undefined);
    assert.equal(ledger.tool_admissions.length, 0);
    assert.equal(ledger.tool_invocations.length, 0);

    globalThis.fetch = ORIG_FETCH;
});

test('reconnect: clears stale registrations before re-registering', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([
        { name: 'echo', description: 'Echo' },
        { name: 'reverse', description: 'Reverse' },
    ]);
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');

    // Server-side schema change — second connect shows fewer tools.
    globalThis.fetch = makeFetchStub([{ name: 'echo', description: 'Echo' }]);
    await bridge.connect('demo');

    const remaining = ToolRegistry.getDefinitions().filter(d => d.function?.name?.startsWith('mcp__demo__'));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].function.name, 'mcp__demo__echo');

    globalThis.fetch = ORIG_FETCH;
});

test('connect: failed handshake marks server unreachable', async () => {
    resetAll();
    globalThis.fetch = async () => new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });

    const result = await bridge.connect('demo');
    assert.equal(result.ok, false);
    const server = MCPServerRegistry.getServer('demo');
    assert.equal(server._unreachable, true);

    globalThis.fetch = ORIG_FETCH;
});

test('connect: disabled server short-circuits with error', async () => {
    resetAll();
    MCPServerRegistry.addServer({ id: 'demo', url: 'https://mcp.example/mcp', enabled: false });
    const result = await bridge.connect('demo');
    assert.equal(result.ok, false);
    assert.match(result.error, /disabled/);
});

test('sweepLedgersByToolId: only removes matching predicate', () => {
    resetAll();
    const ledger = getOrCreateLedger('conv-1', 'coder.v1');
    ledger.tool_admissions.push(
        { tool_id: 'mcp__a__x', admitted_at: 1, form: 'full', source: 'discovery', cost: 1, last_used_at: 1 },
        { tool_id: 'mcp__b__y', admitted_at: 1, form: 'full', source: 'discovery', cost: 1, last_used_at: 1 },
        { tool_id: 'read_file',  admitted_at: 1, form: 'full', source: 'discovery', cost: 1, last_used_at: 1 },
    );
    const stats = sweepLedgersByToolId(id => id.startsWith('mcp__a__'));
    assert.equal(stats.admissionsRemoved, 1);
    assert.equal(ledger.tool_admissions.length, 2);
    const remaining = ledger.tool_admissions.map(a => a.tool_id).sort();
    assert.deepEqual(remaining, ['mcp__b__y', 'read_file']);
});

test('makeRegistration: short-circuits when server is disabled at call time', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([{ name: 'echo', description: 'Echo' }]);
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');
    MCPServerRegistry.updateServer('demo', { enabled: false });

    const result = await ToolRegistry.execute('mcp__demo__echo', {});
    // 1.6.10: error string widened to point the LLM at the recovery action.
    assert.match(result.error, /disabled/);
    assert.match(result.error, /Settings → MCP Servers/);

    globalThis.fetch = ORIG_FETCH;
});

// gitea#21: MCP server `roles` field gates tool visibility/execution.
// The bridge passes `server.roles` straight to ToolRegistry.register(),
// so the existing checkRoleAccess() machinery enforces it. These tests
// guard the wire-up so a future refactor can't quietly regress to the
// pre-1.6.10 hardcoded `roles: 'all'`.
test('makeRegistration: server without roles → tool registered with roles "all"', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([{ name: 'echo', description: 'Echo' }]);
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');

    const def = ToolRegistry.getDefinitions().find(d => d.function?.name === 'mcp__demo__echo');
    assert.ok(def, 'tool should be registered');
    // Internal field set by ToolRegistry.register() at line ~87 — the canonical
    // place to check the resolved role set.
    assert.deepEqual(def._registeredRoles, ['all']);

    globalThis.fetch = ORIG_FETCH;
});

test('makeRegistration: server.roles array survives bridge → registry → checkRoleAccess', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([{ name: 'echo', description: 'Echo' }]);
    MCPServerRegistry.addServer({
        id: 'demo',
        label: 'Demo',
        url: 'https://mcp.example/mcp',
        roles: ['coder'],
    });
    await bridge.connect('demo');

    const def = ToolRegistry.getDefinitions().find(d => d.function?.name === 'mcp__demo__echo');
    assert.ok(def);
    assert.deepEqual(def._registeredRoles, ['coder']);

    // 2.0.0 — slice 3: profile-keyed gate. Save/restore the active
    // profile so we don't leak into later tests.
    const priorProfile = State.settings.profile;
    try {
        State.settings.profile = 'coder.v1';
        assert.equal(ToolRegistry.checkRoleAccess('mcp__demo__echo').allowed, true);

        State.settings.profile = 'pm.v1';
        const blocked = ToolRegistry.checkRoleAccess('mcp__demo__echo');
        assert.equal(blocked.allowed, false);
        assert.match(blocked.reason, /pm\.v1.*not permitted/);

        // 'full.v1' carries `tools.allowed_groups: ['*']` — bypass.
        State.settings.profile = 'full.v1';
        assert.equal(ToolRegistry.checkRoleAccess('mcp__demo__echo').allowed, true);
    } finally {
        State.settings.profile = priorProfile;
    }

    globalThis.fetch = ORIG_FETCH;
});

test('reconnect: server.roles change re-registers tools with the new roles', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([{ name: 'echo', description: 'Echo' }]);
    MCPServerRegistry.addServer({
        id: 'demo',
        label: 'Demo',
        url: 'https://mcp.example/mcp',
        roles: ['coder'],
    });
    await bridge.connect('demo');

    let def = ToolRegistry.getDefinitions().find(d => d.function?.name === 'mcp__demo__echo');
    assert.deepEqual(def._registeredRoles, ['coder']);

    // The Settings tab fires `mcp:serversChanged` after editing roles; the
    // bridge handles that with disconnectAll → bootstrapAllServers, but the
    // primitive being exercised is the same: a fresh connect after the
    // record's roles change.
    MCPServerRegistry.updateServer('demo', { roles: ['pm', 'reviewer'] });
    await bridge.connect('demo');

    def = ToolRegistry.getDefinitions().find(d => d.function?.name === 'mcp__demo__echo');
    assert.deepEqual(def._registeredRoles.sort(), ['pm', 'reviewer']);

    globalThis.fetch = ORIG_FETCH;
});

test('disconnect: emits tools:unregistered event per tool', async () => {
    resetAll();
    globalThis.fetch = makeFetchStub([
        { name: 'echo', description: 'Echo' },
        { name: 'reverse', description: 'Reverse' },
    ]);
    MCPServerRegistry.addServer({ id: 'demo', label: 'Demo', url: 'https://mcp.example/mcp' });
    await bridge.connect('demo');

    const { EventBus } = await import('../js/core.js');
    const seen = [];
    const off = EventBus.on('tools:unregistered', (payload) => seen.push(payload));

    await bridge.disconnect('demo');
    off();

    const names = seen.map(p => p.name).sort();
    assert.deepEqual(names, ['mcp__demo__echo', 'mcp__demo__reverse']);

    globalThis.fetch = ORIG_FETCH;
});

test('tool embeddings cache drops entry on tools:unregistered', async () => {
    resetAll();
    const { _testing } = await import('../js/intelligence/tools/embeddings.js');
    const { Catalog } = await import('../js/intelligence/tools/catalog.js');

    // Register a fake native tool, populate the cache via the test seam,
    // then unregister and assert the cache shrinks.
    const fakeName = 'unit_test_unregister_target';
    ToolRegistry.register(fakeName, async () => ({ result: 'ok' }), {
        type: 'function',
        function: { name: fakeName, description: 'fixture', parameters: { type: 'object', properties: {} } },
        roles: 'all',
        category: 'misc',
    });

    // Stub the embedder so we don't load Transformers.js in a node test.
    _testing._setEmbedderForTests({
        embed: async () => [0.1, 0.2, 0.3],
        isEnabled: () => true,
        cosineSimilarity: () => 0.5,
    });
    _testing._clearCacheForTests();

    const td = Catalog.getByName(fakeName);
    assert.ok(td, 'fixture tool should resolve via Catalog');
    const { getToolEmbedding } = await import('../js/intelligence/tools/embeddings.js');
    const vec = await getToolEmbedding(td);
    assert.ok(Array.isArray(vec));
    assert.equal(_testing._getCacheSize(), 1);

    ToolRegistry.unregister(fakeName);

    // Microtask drain — EventBus.emit is sync, but be defensive.
    await Promise.resolve();
    assert.equal(_testing._getCacheSize(), 0, 'tool embedding should be evicted on unregister');

    _testing._setEmbedderForTests(null);
});

test('mcp-bridge __test.emitDiffMessages: classifies disable / enable / reconnect / no-op', async () => {
    const { __test } = await import('../plugins/mcp-bridge.js');
    const messages = [];
    const fakeAdd = (role, content) => messages.push({ role, content });

    const pre = new Map([
        ['srv-disabled', { label: 'DisabledOne', names: new Set(['mcp__srv-disabled__a', 'mcp__srv-disabled__b']) }],
        ['srv-rotate',   { label: 'Rotate',      names: new Set(['mcp__srv-rotate__old']) }],
        ['srv-stable',   { label: 'Stable',      names: new Set(['mcp__srv-stable__x']) }],
    ]);
    const post = new Map([
        ['srv-rotate',   { label: 'Rotate', names: new Set(['mcp__srv-rotate__new', 'mcp__srv-rotate__extra']) }],
        ['srv-stable',   { label: 'Stable', names: new Set(['mcp__srv-stable__x']) }],
        ['srv-enabled',  { label: 'NewServer', names: new Set(['mcp__srv-enabled__only']) }],
    ]);

    __test.emitDiffMessages(pre, post, fakeAdd);

    const contents = messages.map(m => m.content).sort();
    assert.equal(messages.length, 3, 'expected exactly 3 transitions (disable, reconnect, enable); no-op stable server stays silent');
    assert.ok(messages.every(m => m.role === 'system'));
    assert.ok(contents.some(c => c.includes('"DisabledOne"') && c.includes('disabled') && c.includes('2 tools removed')));
    assert.ok(contents.some(c => c.includes('"Rotate"') && c.includes('reconnected') && c.includes('2 tools available')));
    assert.ok(contents.some(c => c.includes('"NewServer"') && c.includes('enabled') && c.includes('1 tool available')));
});

test('mcp-bridge __test.emitDiffMessages: pluralizes tool counts correctly', async () => {
    const { __test } = await import('../plugins/mcp-bridge.js');
    const messages = [];
    const fakeAdd = (role, content) => messages.push({ role, content });

    __test.emitDiffMessages(
        new Map([['srv', { label: 'Solo', names: new Set(['mcp__srv__one']) }]]),
        new Map(),
        fakeAdd,
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /1 tool removed/);
    assert.doesNotMatch(messages[0].content, /1 tools/);
});
