/**
 * Git Provider Registry
 * 
 * Pluggable git hosting provider system. Mirrors LLM ProviderRegistry pattern
 * but supports multiple simultaneous connections (unlike LLM where one is active).
 * 
 * Provider interface defined in base.js.
 * Connection: { id, provider, label, url, token, enabled }
 * 
 * Usage:
 *   GitProviderRegistry.register(giteaProvider);
 *   GitProviderRegistry.addConnection({ id: 'home', provider: 'gitea', ... });
 *   const { provider, connection } = GitProviderRegistry.resolve('home');
 *   const repos = await provider.listRepos(connection);
 */

import { BASE_GIT_PROVIDER } from './base.js';

// ============================================
// REGISTRY
// ============================================

const _providers = new Map();
let _connections = [];    // Loaded from State.settings.connections

const GitProviderRegistry = {
    /**
     * Register a git provider plugin.
     * Merges with BASE_GIT_PROVIDER so providers only override what they need.
     */
    register(provider) {
        if (!provider.id || !provider.name) {
            console.error('[GitProviders] Provider missing id or name:', provider);
            return false;
        }
        const merged = { ...BASE_GIT_PROVIDER, ...provider };
        // Deep-merge contributes so partial declarations work
        merged.contributes = {
            ...BASE_GIT_PROVIDER.contributes,
            ...(provider.contributes || {})
        };
        _providers.set(merged.id, merged);
        console.log(`[GitProviders] Registered: ${merged.name} (${merged.id})`);
        return true;
    },

    /**
     * Get a provider by ID. Returns null if not found.
     */
    get(id) {
        return _providers.get(id) || null;
    },

    /**
     * List all registered providers.
     */
    list() {
        return Array.from(_providers.values());
    },

    // ========================================
    // CONNECTION MANAGEMENT
    // ========================================

    /**
     * Load connections from settings (called at init).
     */
    loadConnections(connections) {
        _connections = connections || [];
        console.log(`[GitProviders] Loaded ${_connections.length} connection(s)`);
    },

    /**
     * Add a new connection.
     * @returns {Object} The new connection
     */
    addConnection(config) {
        if (!config.id || !config.provider) {
            throw new Error('Connection requires id and provider');
        }
        if (!_providers.has(config.provider)) {
            throw new Error(`Unknown provider: ${config.provider}`);
        }
        // Prevent duplicate IDs
        if (_connections.find(c => c.id === config.id)) {
            throw new Error(`Connection ID already exists: ${config.id}`);
        }
        const conn = {
            id: config.id,
            provider: config.provider,
            label: config.label || config.id,
            url: config.url || _providers.get(config.provider).fixedUrl || '',
            token: config.token || '',
            enabled: config.enabled !== false
        };
        _connections.push(conn);
        return conn;
    },

    /**
     * Update an existing connection.
     */
    updateConnection(id, updates) {
        const idx = _connections.findIndex(c => c.id === id);
        if (idx === -1) throw new Error(`Connection not found: ${id}`);
        _connections[idx] = { ..._connections[idx], ...updates };
        return _connections[idx];
    },

    /**
     * Remove a connection by ID.
     */
    removeConnection(id) {
        const idx = _connections.findIndex(c => c.id === id);
        if (idx === -1) return false;
        _connections.splice(idx, 1);
        return true;
    },

    /**
     * Get a connection by ID.
     */
    getConnection(id) {
        return _connections.find(c => c.id === id) || null;
    },

    /**
     * List all connections (optionally filtered by enabled).
     */
    listConnections(enabledOnly = false) {
        return enabledOnly
            ? _connections.filter(c => c.enabled)
            : [..._connections];
    },

    /**
     * Test a connection without saving it.
     * Used by the settings UI to validate credentials.
     * @param {string} providerId - Provider ID (e.g., 'gitea')
     * @param {string} url - API base URL
     * @param {string} token - Authentication token
     * @returns {Promise<{ok: boolean, user?: string, error?: string}>}
     */
    async testConnection(providerId, url, token) {
        const provider = this.get(providerId);
        if (!provider) {
            return { ok: false, error: `Unknown provider: ${providerId}` };
        }

        // Create temporary connection object
        const tempConn = {
            id: '__test__',
            provider: providerId,
            url: url || provider.fixedUrl || '',
            token: token || '',
            enabled: true
        };

        try {
            // Call provider's test method
            const result = await provider.testConnection(tempConn);
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    },

    // ========================================
    // RESOLUTION
    // ========================================

    /**
     * Resolve a connectionId to { provider, connection }.
     * This is the primary way core code accesses the git API.
     */
    resolve(connectionId) {
        const connection = this.getConnection(connectionId);
        if (!connection) {
            throw new Error(`Connection not found: ${connectionId}`);
        }
        const provider = this.get(connection.provider);
        if (!provider) {
            throw new Error(`Provider not found: ${connection.provider}`);
        }
        return { provider, connection };
    },

    // ========================================
    // AGGREGATE OPERATIONS
    // ========================================

    /**
     * List repos from ALL enabled connections.
     * Returns repos annotated with connection metadata.
     */
    async listAllRepos() {
        const results = [];
        const errors = [];

        const enabled = _connections.filter(c => c.enabled);

        // Fetch in parallel for speed
        const fetches = enabled.map(async (conn) => {
            try {
                const provider = this.get(conn.provider);
                if (!provider) return;
                const repos = await provider.listRepos(conn);
                return repos.map(r => ({
                    ...r,
                    connectionId: conn.id,
                    connectionLabel: conn.label,
                    providerIcon: provider.icon,
                    providerId: provider.id
                }));
            } catch (err) {
                console.warn(`[GitProviders] Failed to list repos for ${conn.label}:`, err);
                errors.push({ connectionId: conn.id, error: err.message });
                return [];
            }
        });

        const batches = await Promise.all(fetches);
        for (const batch of batches) {
            if (batch) results.push(...batch);
        }

        return { repos: results, errors };
    },

    // ========================================
    // PROVIDER CONTRIBUTIONS
    // ========================================

    /**
     * Collect all UI contributions from all registered providers.
     * Used by SlotManager to render provider-contributed panels.
     */
    getAllContributions() {
        const all = { panels: [], tools: [], settings: [], menuItems: [] };
        for (const provider of _providers.values()) {
            const c = provider.contributes || {};
            if (c.panels) all.panels.push(...c.panels.map(p => ({ ...p, providerId: provider.id })));
            if (c.tools) all.tools.push(...c.tools.map(t => ({ ...t, providerId: provider.id })));
            if (c.settings) all.settings.push(...c.settings.map(s => ({ ...s, providerId: provider.id })));
            if (c.menuItems) all.menuItems.push(...c.menuItems.map(m => ({ ...m, providerId: provider.id })));
        }
        return all;
    },

    // ========================================
    // MIGRATION HELPERS
    // ========================================

    /**
     * Create a legacy-compatible connection from old settings.
     * Allows gradual migration from single-Gitea to multi-connection.
     * 
     * Call this at startup if connections[] is empty but giteaUrl/giteaToken exist.
     */
    migrateFromLegacySettings(settings) {
        if (_connections.length > 0) return false; // Already migrated
        if (!settings.giteaUrl || !settings.giteaToken) return false;

        const conn = this.addConnection({
            id: 'default-gitea',
            provider: 'gitea',
            label: new URL(settings.giteaUrl).hostname,
            url: settings.giteaUrl,
            token: settings.giteaToken,
            enabled: true
        });

        console.log(`[GitProviders] Migrated legacy Gitea settings to connection: ${conn.label}`);
        return true;
    }
};

export { GitProviderRegistry };
