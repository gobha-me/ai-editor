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
        // from the (now-updated) registry. Cheap because there's no
        // long-lived state and protocol calls are async.
        const handler = async () => {
            const bridge = await import('../js/mcp/bridge.js');
            await bridge.disconnectAll();
            await bootstrapAllServers();
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
