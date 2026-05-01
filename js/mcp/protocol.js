// @ts-check
/**
 * AI Editor — MCP JSON-RPC 2.0 client
 *
 * Speaks the Model Context Protocol over HTTP transports only:
 *   - "streamable-http" (current spec): POST /mcp returning either
 *     application/json (single response) or text/event-stream (one or more
 *     SSE-framed JSON-RPC messages).
 *   - "sse" (legacy spec): POST messages, GET /sse for the response stream.
 *     1.4.2 ships only the streamable-http path; the transport field is
 *     plumbed but "sse" falls through to streamable-http with a logged
 *     warning. A dedicated SSE transport lands when a real-world server
 *     forces it.
 *
 * Stdio transport is intentionally absent: the editor runs in a browser
 * with no subprocess capability. A future backend relay companion would
 * fill that gap.
 *
 * Per-server `abort(serverId)` rejects in-flight `tools/call` Promises
 * cleanly when the bridge tears down a server.
 *
 * @module mcp/protocol
 */

import { EditorError, ErrorCode } from '../utils/errors.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ai-editor', version: '1.4.2' };
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Tracks AbortControllers per server so disconnect cancels in-flight
 * requests deterministically. Map<serverId, Set<AbortController>>.
 *
 * @type {Map<string, Set<AbortController>>}
 */
const _inflight = new Map();

/**
 * Per-server initialization state. Map<serverId, { initialized, sessionId }>.
 * The MCP spec lets servers return a session id via the
 * `Mcp-Session-Id` header on initialize; we echo it on subsequent calls.
 *
 * @type {Map<string, { initialized: boolean, sessionId: string|null }>}
 */
const _sessions = new Map();

let _nextRequestId = 1;

function nextId() {
    return _nextRequestId++;
}

function trackInflight(serverId, controller) {
    let set = _inflight.get(serverId);
    if (!set) {
        set = new Set();
        _inflight.set(serverId, set);
    }
    set.add(controller);
}

function untrackInflight(serverId, controller) {
    const set = _inflight.get(serverId);
    if (set) {
        set.delete(controller);
        if (set.size === 0) _inflight.delete(serverId);
    }
}

/**
 * Cancel every in-flight request for a server. Called by the bridge on
 * disconnect.
 *
 * @param {string} serverId
 */
export function abort(serverId) {
    const set = _inflight.get(serverId);
    if (!set) return;
    for (const c of set) {
        try { c.abort('mcp-disconnected'); } catch { /* swallow */ }
    }
    _inflight.delete(serverId);
    _sessions.delete(serverId);
}

/**
 * Build common headers for an MCP HTTP request.
 *
 * @param {{token?: string|null}} server
 * @param {string|null} sessionId
 * @returns {Record<string, string>}
 */
function buildHeaders(server, sessionId) {
    /** @type {Record<string, string>} */
    const h = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (server.token) h['Authorization'] = `Bearer ${server.token}`;
    if (sessionId) h['Mcp-Session-Id'] = sessionId;
    return h;
}

/**
 * Parse a streamable-http response. Per spec, the body is either:
 *   - application/json — single JSON-RPC response
 *   - text/event-stream — one or more SSE `data:` events, each containing
 *     a JSON-RPC message; we collect until the first matching response.
 *
 * @param {Response} response
 * @param {number} expectedId
 * @returns {Promise<Object>} JSON-RPC response object
 */
async function readJsonRpcResponse(response, expectedId) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
        const text = await response.text();
        if (!text) throw new EditorError('Empty MCP response body', { code: ErrorCode.NETWORK_OFFLINE });
        return JSON.parse(text);
    }
    if (ct.includes('text/event-stream')) {
        const text = await response.text();
        for (const event of text.split(/\r?\n\r?\n/)) {
            const dataLines = event.split(/\r?\n/).filter(l => l.startsWith('data:'));
            if (dataLines.length === 0) continue;
            const payload = dataLines.map(l => l.slice(5).trimStart()).join('\n');
            if (!payload) continue;
            try {
                const msg = JSON.parse(payload);
                if (msg.id === expectedId) return msg;
            } catch { /* skip non-JSON event */ }
        }
        throw new EditorError(`MCP SSE stream ended without response id=${expectedId}`, { code: ErrorCode.LLM_STREAM_ERROR });
    }
    const text = await response.text();
    throw new EditorError(
        `Unexpected MCP content-type: ${ct || '(none)'} — body: ${text.slice(0, 200)}`,
        { code: ErrorCode.LLM_API_ERROR }
    );
}

/**
 * Send a JSON-RPC request. Returns the parsed `result` field or throws.
 *
 * @param {{id: string, url: string, token?: string|null, transport?: string}} server
 * @param {string} method
 * @param {Object|null} params
 * @returns {Promise<any>}
 */
async function rpc(server, method, params) {
    const id = nextId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const session = _sessions.get(server.id) || { initialized: false, sessionId: null };
    const controller = new AbortController();
    trackInflight(server.id, controller);

    const timer = setTimeout(() => {
        try { controller.abort('mcp-timeout'); } catch { /* swallow */ }
    }, REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(server.url, {
            method: 'POST',
            headers: buildHeaders(server, session.sessionId),
            body,
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new EditorError(
                `MCP HTTP ${response.status} on ${method}: ${text.slice(0, 200)}`,
                { code: response.status === 401 || response.status === 403
                    ? ErrorCode.AUTH_INVALID_TOKEN
                    : ErrorCode.LLM_API_ERROR }
            );
        }

        const sessionHeader = response.headers.get('Mcp-Session-Id');
        if (sessionHeader && method === 'initialize') {
            _sessions.set(server.id, { initialized: false, sessionId: sessionHeader });
        }

        const message = await readJsonRpcResponse(response, id);
        if (message.error) {
            const err = message.error;
            throw new EditorError(
                `MCP error ${err.code} on ${method}: ${err.message || 'unknown'}`,
                { code: ErrorCode.LLM_API_ERROR }
            );
        }
        return message.result;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            const reason = controller.signal.reason;
            if (reason === 'mcp-disconnected') {
                throw new EditorError(`MCP server disconnected during ${method}`, { code: ErrorCode.NETWORK_OFFLINE });
            }
            if (reason === 'mcp-timeout') {
                throw new EditorError(`MCP timeout on ${method} after ${REQUEST_TIMEOUT_MS}ms`, { code: ErrorCode.NETWORK_TIMEOUT });
            }
        }
        if (err instanceof EditorError) throw err;
        throw EditorError.wrap(err, { code: ErrorCode.LLM_API_ERROR });
    } finally {
        clearTimeout(timer);
        untrackInflight(server.id, controller);
    }
}

/**
 * Initialize an MCP session. Returns the server's advertised capabilities.
 *
 * @param {{id: string, url: string, token?: string|null, transport?: string}} server
 * @returns {Promise<{ protocolVersion: string, capabilities: Object, serverInfo: Object }>}
 */
export async function initialize(server) {
    const result = await rpc(server, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: CLIENT_INFO,
    });
    const session = _sessions.get(server.id) || { initialized: false, sessionId: null };
    session.initialized = true;
    _sessions.set(server.id, session);
    // Per spec, send the initialized notification (no id, no response).
    try {
        await fetch(server.url, {
            method: 'POST',
            headers: buildHeaders(server, session.sessionId),
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        });
    } catch { /* notification is best-effort */ }
    return result;
}

/**
 * List the tools advertised by a server. Pass cursor for pagination.
 *
 * @param {{id: string, url: string, token?: string|null}} server
 * @param {string|null} [cursor]
 * @returns {Promise<{ tools: Array<{name: string, description?: string, inputSchema?: Object}>, nextCursor?: string|null }>}
 */
export async function toolsList(server, cursor) {
    const params = cursor ? { cursor } : {};
    return await rpc(server, 'tools/list', params);
}

/**
 * Invoke a tool on the server. Returns the spec'd `{content, isError}` shape.
 *
 * @param {{id: string, url: string, token?: string|null}} server
 * @param {string} name
 * @param {Object} args
 * @returns {Promise<{ content: Array<Object>, isError?: boolean }>}
 */
export async function toolsCall(server, name, args) {
    return await rpc(server, 'tools/call', { name, arguments: args || {} });
}

/**
 * Test seam — exposed for unit tests. Lets `tests/test-mcp-protocol.mjs`
 * inject a fetch stub and reset the request counter between cases.
 */
export const __test = {
    resetState() {
        _inflight.clear();
        _sessions.clear();
        _nextRequestId = 1;
    },
    inflightSize(serverId) {
        const s = _inflight.get(serverId);
        return s ? s.size : 0;
    },
    sessionFor(serverId) {
        return _sessions.get(serverId) || null;
    },
    PROTOCOL_VERSION,
    REQUEST_TIMEOUT_MS,
};
