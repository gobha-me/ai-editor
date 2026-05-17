// @ts-check
/**
 * Anti-regression tests for the public-export shape of the three MCP
 * modules: `bridge`, `registry`, `protocol`.
 *
 * Origin: `RE-EVAL following 2.55.0` ICD #6 code-aware finding #3 — no
 * test pins `Object.keys(MCPServerRegistry).sort()`, `Object.keys(bridge)`,
 * or `Object.keys(protocol)`. A renamed method or silently-dropped getter
 * would only surface at production call sites. Same gap ICD #4 cited for
 * `BASE_GIT_PROVIDER` (resolved at 2.50.0 via
 * `tests/test-provider-capabilities-shape.mjs`); same idiom applies here.
 *
 * The 2.62.0 row's seam-idiom (validator at a producer seam + frozen-key
 * constants) does NOT apply here — this is a public-export shape pin, not
 * a cross-module payload contract. The right precedent is the
 * `test-provider-capabilities-shape.mjs` capabilities pattern: read
 * `Object.keys(module).sort()` and deepEqual it against a frozen expected
 * list. Zero production-file edits — the modules under test stay the
 * source of truth for their own shape.
 *
 * @since 2.63.0
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as bridge from '../js/mcp/bridge.js';
import * as protocol from '../js/mcp/protocol.js';
import * as registryModule from '../js/mcp/registry.js';
import { MCPServerRegistry, LEGACY_GROUP_TAGS } from '../js/mcp/registry.js';

// ----- module-level export shape ------------------------------------------

test('public-surface-shape: bridge module exports exactly the five-name surface', () => {
    const keys = Object.keys(bridge).sort();
    assert.deepEqual(keys, [
        '__test',
        'connect',
        'disconnect',
        'disconnectAll',
        'getRegisteredToolNames',
    ]);
});

test('public-surface-shape: registry module exports exactly MCPServerRegistry + LEGACY_GROUP_TAGS', () => {
    const keys = Object.keys(registryModule).sort();
    assert.deepEqual(keys, ['LEGACY_GROUP_TAGS', 'MCPServerRegistry']);
});

test('public-surface-shape: MCPServerRegistry exposes exactly the nine-method surface', () => {
    const keys = Object.keys(MCPServerRegistry).sort();
    assert.deepEqual(keys, [
        '__test_reset',
        'addServer',
        'getServer',
        'listServers',
        'loadServers',
        'removeServer',
        'serialize',
        'testConnection',
        'updateServer',
    ]);
});

test('public-surface-shape: protocol module exports exactly the five-name surface', () => {
    const keys = Object.keys(protocol).sort();
    assert.deepEqual(keys, [
        '__test',
        'abort',
        'initialize',
        'toolsCall',
        'toolsList',
    ]);
});

// ----- __test namespace shape ---------------------------------------------

test('public-surface-shape: bridge.__test exposes exactly the five test-seam keys', () => {
    const keys = Object.keys(bridge.__test).sort();
    assert.deepEqual(keys, [
        'flattenCallResult',
        'isOwnedBy',
        'makeRegistration',
        'namespacedName',
        'reset',
    ]);
});

test('public-surface-shape: protocol.__test exposes exactly the five test-seam keys', () => {
    const keys = Object.keys(protocol.__test).sort();
    assert.deepEqual(keys, [
        'PROTOCOL_VERSION',
        'REQUEST_TIMEOUT_MS',
        'inflightSize',
        'resetState',
        'sessionFor',
    ]);
});

// ----- LEGACY_GROUP_TAGS membership ---------------------------------------

test('public-surface-shape: LEGACY_GROUP_TAGS is the five-tag back-compat list (post-2.54.0 dead-letter)', () => {
    // Pin membership only — the production constant is a plain `const` array,
    // not Object.freeze([]). Asserting Object.isFrozen would force a
    // production edit; that is a separate intentional change, out of scope
    // for the shape-pin row.
    assert.deepEqual([...LEGACY_GROUP_TAGS].sort(), [
        'coder',
        'full',
        'plugin-dev',
        'pm',
        'reviewer',
    ]);
});

// ----- record schemas (live + persisted) ----------------------------------

test('public-surface-shape: live record schema is exactly the ten-key shape', () => {
    MCPServerRegistry.__test_reset();
    const server = MCPServerRegistry.addServer({
        id: 'shape_probe',
        url: 'https://example.invalid/mcp',
    });
    const keys = Object.keys(server).sort();
    assert.deepEqual(keys, [
        '_lastSync',
        '_toolCount',
        '_unreachable',
        'enabled',
        'id',
        'label',
        'roles',
        'token',
        'transport',
        'url',
    ]);
    MCPServerRegistry.__test_reset();
});

test('public-surface-shape: persisted record schema is exactly the seven-key shape (runtime fields stripped)', () => {
    MCPServerRegistry.__test_reset();
    MCPServerRegistry.addServer({
        id: 'shape_probe',
        url: 'https://example.invalid/mcp',
    });
    const persisted = MCPServerRegistry.serialize();
    assert.equal(persisted.length, 1);
    const keys = Object.keys(persisted[0]).sort();
    assert.deepEqual(keys, [
        'enabled',
        'id',
        'label',
        'roles',
        'token',
        'transport',
        'url',
    ]);
    MCPServerRegistry.__test_reset();
});

// ----- bridge naming invariants -------------------------------------------

test('public-surface-shape: namespacedName produces mcp__<serverId>__<toolName>', () => {
    assert.equal(bridge.__test.namespacedName('demo', 'echo'), 'mcp__demo__echo');
});

test('public-surface-shape: isOwnedBy positive — same server prefix matches', () => {
    assert.equal(bridge.__test.isOwnedBy('demo', 'mcp__demo__echo'), true);
});

test('public-surface-shape: isOwnedBy negative — different server prefix does not match', () => {
    assert.equal(bridge.__test.isOwnedBy('demo', 'mcp__other__echo'), false);
});

// ----- makeRegistration definition shape ----------------------------------

test('public-surface-shape: makeRegistration definition has exactly {category, function, type}', () => {
    const server = { id: 'demo', label: 'Demo' };
    const mcpTool = { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: {} } };
    const { definition } = bridge.__test.makeRegistration(server, mcpTool);
    assert.deepEqual(Object.keys(definition).sort(), ['category', 'function', 'type']);
    assert.equal(definition.type, 'function');
    assert.equal(definition.category, 'mcp.demo');
});

test('public-surface-shape: makeRegistration definition.function has exactly {description, name, parameters}', () => {
    const server = { id: 'demo', label: 'Demo' };
    const mcpTool = { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: {} } };
    const { definition } = bridge.__test.makeRegistration(server, mcpTool);
    assert.deepEqual(Object.keys(definition.function).sort(), ['description', 'name', 'parameters']);
});

// ----- testConnection envelope shape (fetch stub) -------------------------
//
// Per ICD §"Other observations": "Bridge __test.reset() and
// protocol.__test.resetState() must be called together for clean inter-test
// isolation." We follow that here even though only the registry +
// protocol seams are exercised — keeps the discipline visible.

function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

test('public-surface-shape: testConnection success envelope is exactly {ok, serverInfo, toolCount}', async () => {
    MCPServerRegistry.__test_reset();
    protocol.__test.resetState();
    const ORIG_FETCH = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'initialize') {
            return jsonResponse({
                jsonrpc: '2.0',
                id: body.id,
                result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub' } },
            });
        }
        if (body.method === 'tools/list') {
            return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
        }
        return new Response('', { status: 202 });
    };
    try {
        const envelope = await MCPServerRegistry.testConnection({
            id: '__shape_probe',
            url: 'https://example.invalid/mcp',
        });
        assert.deepEqual(Object.keys(envelope).sort(), ['ok', 'serverInfo', 'toolCount']);
        assert.equal(envelope.ok, true);
        assert.equal(typeof envelope.toolCount, 'number');
    } finally {
        globalThis.fetch = ORIG_FETCH;
        protocol.__test.resetState();
        MCPServerRegistry.__test_reset();
    }
});

test('public-surface-shape: testConnection failure envelope is exactly {error, ok}', async () => {
    MCPServerRegistry.__test_reset();
    protocol.__test.resetState();
    const ORIG_FETCH = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error('stubbed network failure');
    };
    try {
        const envelope = await MCPServerRegistry.testConnection({
            id: '__shape_probe',
            url: 'https://example.invalid/mcp',
        });
        assert.deepEqual(Object.keys(envelope).sort(), ['error', 'ok']);
        assert.equal(envelope.ok, false);
        assert.equal(typeof envelope.error, 'string');
    } finally {
        globalThis.fetch = ORIG_FETCH;
        protocol.__test.resetState();
        MCPServerRegistry.__test_reset();
    }
});

// ----- transport coercion -------------------------------------------------

test('public-surface-shape: addServer coerces unknown transport to streamable-http; sse is preserved verbatim', () => {
    MCPServerRegistry.__test_reset();
    const bogus = MCPServerRegistry.addServer({
        id: 'shape_bogus',
        url: 'https://example.invalid/mcp',
        transport: 'mystery',
    });
    assert.equal(bogus.transport, 'streamable-http');
    const sse = MCPServerRegistry.addServer({
        id: 'shape_sse',
        url: 'https://example.invalid/mcp',
        transport: 'sse',
    });
    assert.equal(sse.transport, 'sse');
    MCPServerRegistry.__test_reset();
});
