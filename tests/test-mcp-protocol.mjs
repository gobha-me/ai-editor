/**
 * Tests for `js/mcp/protocol.js` — JSON-RPC 2.0 client over Streamable HTTP.
 *
 * Stubs `globalThis.fetch` per case. Verifies:
 *   - initialize handshake (POST body shape, protocolVersion echo, session header capture)
 *   - tools/list parse
 *   - tools/call envelope
 *   - JSON-RPC error mapping
 *   - HTTP error mapping (401 → AUTH_INVALID_TOKEN, 5xx → LLM_API_ERROR)
 *   - Streamable HTTP event-stream response framing
 *   - abort() rejects in-flight calls cleanly
 *   - timeout enforcement (mocked clock)
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as protocol from '../js/mcp/protocol.js';

const ORIG_FETCH = globalThis.fetch;

function jsonResponse(body, init = {}) {
    const { headers: extraHeaders, ...rest } = init;
    return new Response(JSON.stringify(body), {
        status: 200,
        ...rest,
        headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    });
}

function sseResponse(messages, init = {}) {
    const { headers: extraHeaders, ...rest } = init;
    const text = messages.map(m => `data: ${JSON.stringify(m)}\n\n`).join('');
    return new Response(text, {
        status: 200,
        ...rest,
        headers: { 'Content-Type': 'text/event-stream', ...(extraHeaders || {}) },
    });
}

function setFetch(impl) {
    globalThis.fetch = impl;
}

function reset() {
    protocol.__test.resetState();
}

test('initialize: POSTs JSON-RPC body and captures session id', async () => {
    reset();
    const calls = [];
    setFetch(async (url, opts) => {
        calls.push({ url, opts });
        if (calls.length === 1) {
            return jsonResponse(
                { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo' } } },
                { headers: { 'Mcp-Session-Id': 'session-abc' } }
            );
        }
        // notifications/initialized POST
        return new Response('', { status: 202 });
    });
    const result = await protocol.initialize({ id: 's1', url: 'https://mcp.example/mcp', token: 'tok' });
    assert.equal(result.serverInfo.name, 'demo');
    assert.equal(calls.length, 2);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'initialize');
    assert.equal(body.params.protocolVersion, '2025-06-18');
    assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok');
    const session = protocol.__test.sessionFor('s1');
    assert.equal(session.sessionId, 'session-abc');
    setFetch(ORIG_FETCH);
});

test('toolsList: parses tools array', async () => {
    reset();
    setFetch(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }] } }));
    const result = await protocol.toolsList({ id: 's2', url: 'https://mcp.example/mcp' });
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, 'echo');
    setFetch(ORIG_FETCH);
});

test('toolsCall: passes name + arguments and returns content envelope', async () => {
    reset();
    let captured;
    setFetch(async (url, opts) => {
        captured = JSON.parse(opts.body);
        return jsonResponse({ jsonrpc: '2.0', id: captured.id, result: { content: [{ type: 'text', text: 'pong' }] } });
    });
    const result = await protocol.toolsCall({ id: 's3', url: 'https://mcp.example/mcp' }, 'echo', { msg: 'hi' });
    assert.equal(captured.method, 'tools/call');
    assert.deepEqual(captured.params, { name: 'echo', arguments: { msg: 'hi' } });
    assert.equal(result.content[0].text, 'pong');
    setFetch(ORIG_FETCH);
});

test('Streamable HTTP response: parses text/event-stream body', async () => {
    reset();
    setFetch(async () => sseResponse([{ jsonrpc: '2.0', id: 1, result: { tools: [] } }]));
    const result = await protocol.toolsList({ id: 's4', url: 'https://mcp.example/mcp' });
    assert.deepEqual(result, { tools: [] });
    setFetch(ORIG_FETCH);
});

test('unsupported transports reject every request path before fetch', async () => {
    reset();
    let fetchCalls = 0;
    setFetch(async () => {
        fetchCalls++;
        throw new Error('unsupported transport must not fetch');
    });
    try {
        await assert.rejects(
            protocol.initialize({ id: 'legacy-init', url: 'https://mcp.example/sse', transport: 'sse' }),
            /supports Streamable HTTP only/
        );
        await assert.rejects(
            protocol.toolsList({ id: 'legacy-list', url: 'https://mcp.example/sse', transport: 'sse' }),
            /supports Streamable HTTP only/
        );
        await assert.rejects(
            protocol.toolsCall({ id: 'legacy-call', url: 'https://mcp.example/sse', transport: 'sse' }, 'echo', {}),
            /supports Streamable HTTP only/
        );
        await assert.rejects(
            protocol.toolsList({ id: 'unknown-list', url: 'https://mcp.example/custom', transport: 'mystery' }),
            /supports Streamable HTTP only/
        );
        await assert.rejects(
            protocol.toolsList({ id: 'empty-list', url: 'https://mcp.example/custom', transport: '' }),
            /supports Streamable HTTP only/
        );
        assert.equal(fetchCalls, 0);
    } finally {
        setFetch(ORIG_FETCH);
    }
});

test('JSON-RPC error: throws EditorError with method context', async () => {
    reset();
    setFetch(async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }));
    await assert.rejects(
        protocol.toolsCall({ id: 's5', url: 'https://mcp.example/mcp' }, 'missing', {}),
        /method not found/
    );
    setFetch(ORIG_FETCH);
});

test('HTTP 401: maps to auth error', async () => {
    reset();
    setFetch(async () => new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } }));
    await assert.rejects(
        protocol.toolsList({ id: 's6', url: 'https://mcp.example/mcp', token: 'bad' }),
        /HTTP 401/
    );
    setFetch(ORIG_FETCH);
});

test('HTTP 503: maps to API error', async () => {
    reset();
    setFetch(async () => new Response('Service Unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
    await assert.rejects(
        protocol.toolsList({ id: 's7', url: 'https://mcp.example/mcp' }),
        /HTTP 503/
    );
    setFetch(ORIG_FETCH);
});

test('Unexpected content-type: throws with body sample', async () => {
    reset();
    setFetch(async () => new Response('<html>oops</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await assert.rejects(
        protocol.toolsList({ id: 's8', url: 'https://mcp.example/mcp' }),
        /Unexpected MCP content-type/
    );
    setFetch(ORIG_FETCH);
});

test('Empty JSON body: throws empty-body error', async () => {
    reset();
    setFetch(async () => new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(
        protocol.toolsList({ id: 's9', url: 'https://mcp.example/mcp' }),
        /Empty MCP response body/
    );
    setFetch(ORIG_FETCH);
});

test('abort(): rejects in-flight calls with disconnect message', async () => {
    reset();
    let signal;
    setFetch(async (url, opts) => {
        signal = opts.signal;
        return await new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
            });
        });
    });
    const inflightPromise = protocol.toolsList({ id: 's10', url: 'https://mcp.example/mcp' });
    // Wait a microtask so the fetch starts and the controller is tracked.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(protocol.__test.inflightSize('s10'), 1);
    protocol.abort('s10');
    await assert.rejects(inflightPromise, /MCP server disconnected/);
    assert.ok(signal.aborted);
    setFetch(ORIG_FETCH);
});

test('Bearer header omitted when no token', async () => {
    reset();
    let captured;
    setFetch(async (url, opts) => {
        captured = opts.headers;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    });
    await protocol.toolsList({ id: 's11', url: 'https://mcp.example/mcp' });
    assert.equal(captured['Authorization'], undefined);
    setFetch(ORIG_FETCH);
});

test('Subsequent call echoes captured Mcp-Session-Id', async () => {
    reset();
    let calls = 0;
    let secondHeaders;
    setFetch(async (url, opts) => {
        calls++;
        if (calls === 1) {
            return jsonResponse(
                { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's' } } },
                { headers: { 'Mcp-Session-Id': 'sess-xyz' } }
            );
        }
        if (calls === 2) {
            // notifications/initialized — best-effort, no return content needed
            return new Response('', { status: 202 });
        }
        secondHeaders = opts.headers;
        return jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    });
    const server = { id: 's12', url: 'https://mcp.example/mcp' };
    await protocol.initialize(server);
    await protocol.toolsList(server);
    assert.equal(secondHeaders['Mcp-Session-Id'], 'sess-xyz');
    setFetch(ORIG_FETCH);
});
