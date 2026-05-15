// @ts-check
/**
 * AI Editor — MCP bridge
 *
 * Owns connect/disconnect orchestration for an MCP server: handshake the
 * protocol, translate `tools/list` results into `ToolRegistry` registrations
 * with namespaced names + `mcp.<serverId>` category, wire each handler back
 * to a `tools/call` over the wire. On disconnect, unregister tools, abort
 * in-flight requests, sweep stale entries from any live `TaskLedger` so
 * the sticky ledger doesn't grow orphan records forever.
 *
 * Naming: `mcp__<serverId>__<toolName>` (double underscore separator). The
 * convention matches Claude Code's MCP namespacing and is opaque everywhere
 * else in the codebase (verified — no consumer splits tool names on `_`).
 *
 * Reconnect-after-schema-change is handled by always running disconnect's
 * unregister pass before re-registering on connect.
 *
 * @module mcp/bridge
 */

import { ToolRegistry } from '../tools/registry.js';
import * as protocol from './protocol.js';
import { MCPServerRegistry } from './registry.js';
import { sweepLedgersByToolId } from '../chat/task-state.js';

const TOOL_NAME_PREFIX = 'mcp__';

/** @type {Map<string, string[]>} */
const _registeredToolNames = new Map();

/**
 * Build the canonical tool name for an MCP-bridged tool.
 *
 * @param {string} serverId
 * @param {string} mcpToolName
 * @returns {string}
 */
function namespacedName(serverId, mcpToolName) {
    return `${TOOL_NAME_PREFIX}${serverId}__${mcpToolName}`;
}

/**
 * True if `name` is the bridge namespace for `serverId`.
 *
 * @param {string} serverId
 * @param {string} name
 * @returns {boolean}
 */
function isOwnedBy(serverId, name) {
    return typeof name === 'string' && name.startsWith(`${TOOL_NAME_PREFIX}${serverId}__`);
}

/**
 * Convert an MCP `tools/call` result envelope into a flat string for the
 * chat surface. Spec returns `{content: [{type, text|data, ...}], isError}`.
 *
 * @param {{ content?: Array<Object>, isError?: boolean }} envelope
 * @returns {{ ok: boolean, text: string }}
 */
function flattenCallResult(envelope) {
    if (!envelope || !Array.isArray(envelope.content)) {
        return { ok: !envelope?.isError, text: '' };
    }
    const parts = [];
    for (const c of envelope.content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        else if (c.type === 'image') parts.push(`[image ${c.mimeType || 'unknown'}]`);
        else if (c.type === 'resource') parts.push(`[resource ${c.resource?.uri || ''}]`);
        else parts.push(JSON.stringify(c));
    }
    return { ok: !envelope.isError, text: parts.join('\n') };
}

/**
 * Build the `ToolRegistry` definition + handler for one MCP tool advertised
 * by `server`. Handler closes over `serverId` so disconnects don't leak.
 *
 * @param {Object} server                 MCPServerRegistry record
 * @param {{name: string, description?: string, inputSchema?: Object}} mcpTool
 */
function makeRegistration(server, mcpTool) {
    const localName = namespacedName(server.id, mcpTool.name);
    const description = mcpTool.description
        ? `[MCP ${server.label || server.id}] ${mcpTool.description}`
        : `MCP tool from ${server.label || server.id}`;
    const parameters = mcpTool.inputSchema && typeof mcpTool.inputSchema === 'object'
        ? mcpTool.inputSchema
        : { type: 'object', properties: {}, required: [] };

    const definition = {
        type: 'function',
        function: {
            name: localName,
            description,
            parameters,
        },
        category: `mcp.${server.id}`,
    };

    const handler = async (args) => {
        const live = MCPServerRegistry.getServer(server.id);
        if (!live || !live.enabled) {
            return { error: `MCP server "${server.id}" is disabled. Re-enable it in Settings → MCP Servers, or use a different tool.` };
        }
        try {
            const envelope = await protocol.toolsCall(live, mcpTool.name, args || {});
            const flat = flattenCallResult(envelope);
            if (!flat.ok) {
                return { error: `MCP tool ${mcpTool.name} reported isError: ${flat.text || '(no detail)'}` };
            }
            return { result: flat.text };
        } catch (err) {
            return { error: err?.message || String(err) };
        }
    };

    return { localName, definition, handler };
}

/**
 * Connect to a server: handshake, list tools, register each into
 * ToolRegistry. Idempotent — calling twice cleanly reconnects (unregisters
 * stale names first, then re-registers).
 *
 * @param {string} serverId
 * @returns {Promise<{ ok: boolean, toolCount: number, error?: string }>}
 */
export async function connect(serverId) {
    const server = MCPServerRegistry.getServer(serverId);
    if (!server) return { ok: false, toolCount: 0, error: `Unknown MCP server: ${serverId}` };
    if (!server.enabled) return { ok: false, toolCount: 0, error: `MCP server "${serverId}" is disabled` };

    // Tear down any prior registration so a server-side schema change doesn't
    // leave stale tool names registered.
    await disconnect(serverId, { sweepLedgers: false });

    try {
        await protocol.initialize(server);
        const list = await protocol.toolsList(server);
        const tools = Array.isArray(list?.tools) ? list.tools : [];

        /** @type {string[]} */
        const registered = [];
        for (const mcpTool of tools) {
            if (!mcpTool || typeof mcpTool.name !== 'string') continue;
            const { localName, definition, handler } = makeRegistration(server, mcpTool);
            try {
                ToolRegistry.register(localName, handler, definition);
                registered.push(localName);
            } catch (err) {
                console.warn(`[MCP bridge] Skip ${localName}: ${err?.message || err}`);
            }
        }
        _registeredToolNames.set(serverId, registered);

        MCPServerRegistry.updateServer(serverId, {
            _toolCount: registered.length,
            _lastSync: Date.now(),
            _unreachable: false,
        });

        console.log(`[MCP bridge] Connected ${serverId}: ${registered.length} tool(s)`);
        return { ok: true, toolCount: registered.length };
    } catch (err) {
        protocol.abort(serverId);
        MCPServerRegistry.updateServer(serverId, { _unreachable: true });
        console.warn(`[MCP bridge] Connect failed for ${serverId}:`, err);
        return { ok: false, toolCount: 0, error: err?.message || String(err) };
    }
}

/**
 * Disconnect a server: unregister tools, abort in-flight calls, sweep
 * sticky-ledger orphans by name prefix.
 *
 * @param {string} serverId
 * @param {{sweepLedgers?: boolean}} [opts]
 * @returns {Promise<{ unregistered: number, swept: ReturnType<typeof sweepLedgersByToolId>|null }>}
 */
export async function disconnect(serverId, opts = {}) {
    const sweep = opts.sweepLedgers !== false;

    const names = _registeredToolNames.get(serverId) || [];
    let unregistered = 0;
    for (const name of names) {
        if (ToolRegistry.unregister(name)) unregistered++;
    }
    _registeredToolNames.delete(serverId);

    protocol.abort(serverId);

    let swept = null;
    if (sweep) {
        swept = sweepLedgersByToolId(toolId => isOwnedBy(serverId, toolId));
    }

    if (unregistered > 0) {
        console.log(`[MCP bridge] Disconnected ${serverId}: -${unregistered} tool(s)`);
    }
    return { unregistered, swept };
}

/**
 * Tear down every connected server. Used by tests and the `?mcpBridge=off`
 * kill-switch to wipe state cleanly.
 *
 * @returns {Promise<void>}
 */
export async function disconnectAll() {
    const ids = Array.from(_registeredToolNames.keys());
    for (const id of ids) {
        await disconnect(id);
    }
}

/** @returns {Map<string, string[]>} Test seam — current registration map. */
export function getRegisteredToolNames() {
    return new Map(_registeredToolNames);
}

/** Test seam. */
export const __test = {
    namespacedName,
    isOwnedBy,
    flattenCallResult,
    makeRegistration,
    reset() {
        _registeredToolNames.clear();
    },
};
