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
    assert.match(result.error, /not enabled/);

    globalThis.fetch = ORIG_FETCH;
});
