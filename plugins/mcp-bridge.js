/**
 * Plugin: MCP Bridge
 *
 * Bundled adapter that imports Model Context Protocol servers as
 * `ToolRegistry` entries via `Plugins.registerMCPServer(...)`. Each
 * server's `tools/list` becomes Catalog entries under the
 * `mcp.<serverId>` category, named `mcp__<serverId>__<toolName>`.
 *
 * MCP tools are NOT in any profile's static set. They reach the model
 * only through `find_tool` (semantic) / `list_tools_by_category`
 * (categorical) discovery and sticky admission once invoked. This
 * preserves the §1.4.0 admissibility contract: connecting an MCP server
 * costs ~0 baseline tokens.
 *
 * Server connection records live in `State.settings.mcpServers[]`,
 * mirroring the `GitProviderRegistry` `connections[]` pattern. The
 * dedicated Settings → MCP Servers tab manages them; the plugin only
 * orchestrates connect/disconnect on enable/disable + on
 * `mcp:serversChanged` events.
 *
 * Kill-switch: `?mcpBridge=off` skips connection on init. Connection
 * records remain readable in Settings; tools simply don't register.
 *
 * @plugin mcp-bridge
 */

import { Plugins, EventBus, State } from '../js/core.js';

const PLUGIN_ID = 'mcp-bridge';

function killSwitchActive() {
    try {
        return new URLSearchParams(window.location.search).get('mcpBridge') === 'off';
    } catch {
        return false;
    }
}

async function bootstrapAllServers() {
    const { MCPServerRegistry } = await import('../js/mcp/registry.js');
    const servers = MCPServerRegistry.listServers(true);
    for (const server of servers) {
        await Plugins.registerMCPServer(PLUGIN_ID, {
            id: server.id,
            label: server.label,
            url: server.url,
            token: server.token,
            transport: server.transport,
            enabled: server.enabled,
        });
    }
}

/**
 * Snapshot the current MCP-bridged tool registrations as a per-server
 * tool-name set. Captures the server label too — the post-toggle handler
 * needs the label even if the server config was just deleted.
 *
 * @param {{ getRegisteredToolNames: () => Map<string, string[]> }} bridge
 * @param {{ getServer: (id: string) => Object | null }} registry
 * @returns {Map<string, { label: string, names: Set<string> }>}
 */
function snapshotRegistrations(bridge, registry) {
    const snap = new Map();
    for (const [serverId, names] of bridge.getRegisteredToolNames().entries()) {
        const rec = registry.getServer(serverId);
        const label = (rec && rec.label) || serverId;
        snap.set(serverId, { label, names: new Set(names) });
    }
    return snap;
}

/**
 * Compare pre/post snapshots and emit a system chat message per
 * meaningful transition. Message format mirrors github#23's acceptance
 * criterion: "[MCP] Server <label> disabled — N tools removed."
 *
 * Transitions:
 *   - pre has tools, post has none      → disabled / removed.
 *   - pre had none, post has tools      → enabled / available.
 *   - pre and post differ in name set   → reconnected (server schema
 *                                         changed; tool set rotated).
 *   - identical sets                    → no message (config noise like
 *                                         renaming a label fires no chat
 *                                         turn).
 *
 * @param {Map<string, {label: string, names: Set<string>}>} pre
 * @param {Map<string, {label: string, names: Set<string>}>} post
 * @param {(role: string, content: string) => void} addMessage
 */
function emitDiffMessages(pre, post, addMessage) {
    const allIds = new Set([...pre.keys(), ...post.keys()]);
    for (const id of allIds) {
        const before = pre.get(id);
        const after = post.get(id);
        const beforeCount = before ? before.names.size : 0;
        const afterCount = after ? after.names.size : 0;
        const label = (after && after.label) || (before && before.label) || id;

        if (beforeCount > 0 && afterCount === 0) {
            addMessage('system', `[MCP] Server "${label}" disabled — ${beforeCount} tool${beforeCount === 1 ? '' : 's'} removed.`);
        } else if (beforeCount === 0 && afterCount > 0) {
            addMessage('system', `[MCP] Server "${label}" enabled — ${afterCount} tool${afterCount === 1 ? '' : 's'} available.`);
        } else if (beforeCount > 0 && afterCount > 0) {
            const a = before.names;
            const b = after.names;
            let changed = a.size !== b.size;
            if (!changed) {
                for (const n of a) { if (!b.has(n)) { changed = true; break; } }
            }
            if (changed) {
                addMessage('system', `[MCP] Server "${label}" reconnected — ${afterCount} tool${afterCount === 1 ? '' : 's'} available.`);
            }
        }
    }
}

const MCPBridgePlugin = {
    id: PLUGIN_ID,
    name: 'MCP Bridge',
    version: '1.0.0',
    description: 'Connect Model Context Protocol servers as discoverable tools (configure in Settings → MCP Servers)',
    author: 'AI Editor',
    defaultEnabled: false,

    async init() {
        const { MCPServerRegistry } = await import('../js/mcp/registry.js');
        MCPServerRegistry.loadServers(State.settings.mcpServers || []);

        if (killSwitchActive()) {
            console.log('[mcp-bridge] kill-switch active (?mcpBridge=off) — skipping connection bootstrap');
            return {};
        }

        await bootstrapAllServers();

        // Live reload: the Settings tab emits `mcp:serversChanged` after any
        // add/edit/remove/toggle. We disconnect everything and reconnect
        // from the (now-updated) registry — cheap because there's no
        // long-lived state and protocol calls are async. The diff between
        // the pre- and post-snapshot drives a system chat message per
        // server transition (github#23), so the LLM's prior-turn tool list
        // doesn't go stale silently.
        //
        // Attached only after the initial bootstrapAllServers() above so
        // first-load registration doesn't fire a barrage of "enabled"
        // messages on every page load.
        const handler = async () => {
            const bridge = await import('../js/mcp/bridge.js');
            const { MCPServerRegistry } = await import('../js/mcp/registry.js');
            const pre = snapshotRegistrations(bridge, MCPServerRegistry);
            await bridge.disconnectAll();
            await bootstrapAllServers();
            const post = snapshotRegistrations(bridge, MCPServerRegistry);
            try {
                const { addMessage } = await import('../js/chat/messages.js');
                emitDiffMessages(pre, post, addMessage);
            } catch (err) {
                console.warn('[mcp-bridge] state-message dispatch failed:', err?.message || err);
            }
        };
        EventBus.on('mcp:serversChanged', handler);
        return { _handler: handler };
    },

    async destroy(instance) {
        if (instance && instance._handler) {
            try { EventBus.off('mcp:serversChanged', instance._handler); } catch { /* swallow */ }
        }
        const bridge = await import('../js/mcp/bridge.js');
        await bridge.disconnectAll();
    },
};

Plugins.register(MCPBridgePlugin);

export const __test = {
    snapshotRegistrations,
    emitDiffMessages,
};
