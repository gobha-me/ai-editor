// @ts-check
/**
 * AI Editor — MCPServerRegistry
 *
 * N-of-each connection list for Model Context Protocol servers. Mirrors
 * `GitProviderRegistry` (`js/git-providers/registry.js`) — same shape, same
 * persistence pattern, same Test/Add/Remove/Edit verbs. The deliberate
 * symmetry lets the Settings → MCP Servers tab copy the connections-tab
 * skeleton without inventing a new vocabulary.
 *
 * Per-server record:
 *   { id, label, url, token, transport, enabled, roles, _toolCount, _lastSync, _unreachable }
 *
 * Persistence: `State.settings.mcpServers[]`. Loaded by
 * `plugins/mcp-bridge.js` at init via `loadServers(...)`.
 *
 * @module mcp/registry
 */

import * as protocol from './protocol.js';

/** @type {Array<Object>} */
let _servers = [];

const VALID_TRANSPORTS = new Set(['streamable-http', 'sse']);
const BUILTIN_ROLES = ['full', 'coder', 'pm', 'reviewer', 'plugin-dev'];

/**
 * Normalise a roles value into a canonical array.
 * Accepts: 'all' (string), ['all'], ['full','coder',...], or undefined/null → 'all'.
 * @param {string|string[]|null|undefined} roles
 * @returns {string|string[]}
 */
function normaliseRoles(roles) {
    if (!roles || (Array.isArray(roles) && roles.length === 0)) return 'all';
    if (typeof roles === 'string') return roles === 'all' ? 'all' : [roles];
    if (Array.isArray(roles)) {
        if (roles.includes('all')) return 'all';
        return roles.filter(r => BUILTIN_ROLES.includes(r));
    }
    return 'all';
}

const MCPServerRegistry = {
    /**
     * Load servers from settings (called by the bundled plugin at init).
     * Coerces unknown fields to safe defaults so partial old records don't
     * crash the registry.
     *
     * @param {Array<Object>|null|undefined} servers
     */
    loadServers(servers) {
        _servers = (servers || [])
            .filter(s => s && typeof s === 'object')
            .map(s => ({
                id: String(s.id || ''),
                label: String(s.label || s.id || ''),
                url: String(s.url || ''),
                token: String(s.token || ''),
                transport: VALID_TRANSPORTS.has(s.transport) ? s.transport : 'streamable-http',
                enabled: s.enabled !== false,
                roles: normaliseRoles(s.roles),
                _toolCount: Number.isFinite(s._toolCount) ? s._toolCount : 0,
                _lastSync: s._lastSync || null,
                _unreachable: !!s._unreachable,
            }))
            .filter(s => s.id && s.url);
        console.log(`[MCPRegistry] Loaded ${_servers.length} server(s)`);
    },

    /**
     * Add a new server.
     * @param {Object} config
     * @returns {Object}
     */
    addServer(config) {
        if (!config || !config.id || !config.url) {
            throw new Error('MCP server requires id and url');
        }
        if (_servers.find(s => s.id === config.id)) {
            throw new Error(`MCP server ID already exists: ${config.id}`);
        }
        const transport = VALID_TRANSPORTS.has(config.transport) ? config.transport : 'streamable-http';
        const server = {
            id: config.id,
            label: config.label || config.id,
            url: config.url,
            token: config.token || '',
            transport,
            enabled: config.enabled !== false,
            roles: normaliseRoles(config.roles),
            _toolCount: 0,
            _lastSync: null,
            _unreachable: false,
        };
        _servers.push(server);
        return server;
    },

    /**
     * Update an existing server.
     * @param {string} id
     * @param {Object} updates
     * @returns {Object}
     */
    updateServer(id, updates) {
        const idx = _servers.findIndex(s => s.id === id);
        if (idx === -1) throw new Error(`MCP server not found: ${id}`);
        const next = { ..._servers[idx], ...updates };
        if (updates.transport && !VALID_TRANSPORTS.has(updates.transport)) {
            next.transport = _servers[idx].transport;
        }
        if ('roles' in updates) {
            next.roles = normaliseRoles(updates.roles);
        }
        _servers[idx] = next;
        return next;
    },

    /**
     * Remove a server by ID.
     * @param {string} id
     * @returns {boolean}
     */
    removeServer(id) {
        const idx = _servers.findIndex(s => s.id === id);
        if (idx === -1) return false;
        _servers.splice(idx, 1);
        return true;
    },

    /**
     * Get a server by ID.
     * @param {string} id
     * @returns {Object|null}
     */
    getServer(id) {
        return _servers.find(s => s.id === id) || null;
    },

    /**
     * List servers (optionally filter to enabled-only).
     * @param {boolean} [enabledOnly]
     * @returns {Array<Object>}
     */
    listServers(enabledOnly = false) {
        return enabledOnly
            ? _servers.filter(s => s.enabled)
            : [..._servers];
    },

    /**
     * Test a server connection by attempting `initialize` + `tools/list`.
     * Returns the live tool count without mutating the registry.
     *
     * @param {{id?: string, url: string, token?: string, transport?: string}} cfg
     * @returns {Promise<{ok: boolean, toolCount?: number, serverInfo?: Object, error?: string}>}
     */
    async testConnection(cfg) {
        const id = cfg.id || `__test_${Date.now()}`;
        const probe = {
            id,
            url: cfg.url,
            token: cfg.token || '',
            transport: cfg.transport || 'streamable-http',
        };
        try {
            const init = await protocol.initialize(probe);
            const list = await protocol.toolsList(probe);
            const toolCount = Array.isArray(list?.tools) ? list.tools.length : 0;
            protocol.abort(id);
            return { ok: true, toolCount, serverInfo: init?.serverInfo };
        } catch (err) {
            protocol.abort(id);
            return { ok: false, error: err?.message || String(err) };
        }
    },

    /**
     * Snapshot for persistence — strips runtime fields.
     * @returns {Array<Object>}
     */
    serialize() {
        return _servers.map(s => ({
            id: s.id,
            label: s.label,
            url: s.url,
            token: s.token,
            transport: s.transport,
            enabled: s.enabled,
            roles: s.roles,
        }));
    },

    /** Test seam — reset the in-memory list between cases. */
    __test_reset() {
        _servers = [];
    },
};

export { MCPServerRegistry, BUILTIN_ROLES };
