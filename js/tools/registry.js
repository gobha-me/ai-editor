// @ts-check
/**
 * AI Editor - Tool Registry
 * Dynamic tool registration system for LLM function calling with role-based access control
 *
 * @module tools/registry
 */

/**
 * @typedef {Object} ToolFunctionSchema
 * @property {string} name
 * @property {string} description
 * @property {Object} parameters - JSON Schema for tool arguments
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {'function'}         type
 * @property {ToolFunctionSchema} function
 * @property {string|string[]}    roles            - 'all' or array of role IDs
 * @property {string[]}           [_registeredRoles] - Normalized role array (set at registration)
 */

/**
 * @callback ToolHandler
 * @param {Object} args - Tool arguments (parsed from JSON)
 * @returns {Promise<Object>} Tool result object
 */

import { Roles, State, EventBus } from '../core.js';
import { EditorError, ErrorCode } from '../utils/errors.js';

export const ToolRegistry = {
    /** @type {Map<string, ToolHandler>} */
    handlers: new Map(),
    /** @type {ToolDefinition[]} */
    definitions: [],
    
    /**
     * Register a tool with its handler and definition.
     * @param {string} name
     * @param {ToolHandler} handler
     * @param {Object} definition - OpenAI function definition with roles metadata
     * @param {string|string[]} definition.roles - 'all' or array of role IDs
     * @returns {void}
     * @throws {Error} If roles field is missing or references invalid roles
     */
    register(name, handler, definition) {
        // === ROLE VALIDATION (STRICT) ===
        
        // 1. Require explicit roles declaration
        if (!definition.roles) {
            throw new Error(
                `Tool "${name}" missing required "roles" field. ` +
                `Must be 'all' or an array of role IDs (e.g., ['coder', 'pm']).`
            );
        }
        
        // 2. Normalize to array
        let toolRoles;
        if (definition.roles === 'all') {
            toolRoles = ['all'];
        } else if (Array.isArray(definition.roles)) {
            toolRoles = definition.roles;
        } else {
            throw new Error(
                `Tool "${name}" has invalid "roles" field. ` +
                `Expected 'all' or array of role IDs, got: ${typeof definition.roles}`
            );
        }
        
        // 3. Validate role IDs exist (skip 'all')
        const invalidRoles = toolRoles.filter(r => r !== 'all' && !Roles.exists(r));
        if (invalidRoles.length > 0) {
            throw new Error(
                `Tool "${name}" references invalid role(s): ${invalidRoles.join(', ')}. ` +
                `Valid roles: ${Roles.list().map(r => r.id).join(', ')}, 'all'`
            );
        }
        
        // === REGISTRATION ===
        
        // Store the normalized roles array in the definition for filtering
        const enrichedDefinition = {
            type: 'function',  // Ensure always present
            ...definition,
            _registeredRoles: toolRoles
        };
        
        this.handlers.set(name, handler);

        const existingIdx = this.definitions.findIndex(d => d.function?.name === name);
        if (existingIdx !== -1) {
            this.definitions.splice(existingIdx, 1);
            console.log(`[ToolRegistry] ♻️ Re-registered tool: ${name} (roles: ${toolRoles.join(', ')})`);
        } else {
            console.log(`[ToolRegistry] ✅ Registered tool: ${name} (roles: ${toolRoles.join(', ')})`);
        }
        this.definitions.push(enrichedDefinition);
    },

    /**
     * Remove a previously registered tool. Used by the MCP bridge on
     * disconnect; harmless to call for an unknown name.
     *
     * @param {string} name
     * @returns {boolean} True if a tool was actually removed.
     */
    unregister(name) {
        const hadHandler = this.handlers.delete(name);
        const idx = this.definitions.findIndex(d => d.function?.name === name);
        if (idx !== -1) {
            this.definitions.splice(idx, 1);
        }
        const removed = hadHandler || idx !== -1;
        if (removed) {
            console.log(`[ToolRegistry] 🗑 Unregistered tool: ${name}`);
            // Downstream caches keyed on the tool (e.g. the find_tool
            // embeddings side-table) listen for this to drop their entries.
            // The registry itself stays ID-naive — listeners that need the
            // ToolID resolve it via the catalog's deterministic mapping.
            try { EventBus.emit('tools:unregistered', { name }); } catch { /* swallow */ }
        }
        return removed;
    },

    /**
     * Check whether the active role is allowed to invoke a given tool.
     * @param {string} name - Tool name
     * @returns {{ allowed: boolean, reason?: string }}
     */
    checkRoleAccess(name) {
        const activeRole = State.settings.role;
        
        // 'full' role bypasses all restrictions
        if (activeRole === 'full') {
            return { allowed: true };
        }
        
        const def = this.definitions.find(
            d => d.function?.name === name
        );
        if (!def) {
            // Unknown tool — let execute() handle the "not found" error
            return { allowed: true };
        }
        
        const toolRoles = def._registeredRoles || [];
        if (toolRoles.includes('all') || toolRoles.includes(activeRole)) {
            return { allowed: true };
        }
        
        return {
            allowed: false,
            reason: `Role '${activeRole}' is not permitted to use tool '${name}'. ` +
                    `Allowed roles: ${toolRoles.join(', ')}. ` +
                    `Switch to an appropriate role or use a different tool.`
        };
    },
    
    /**
     * Execute a registered tool by name.
     * Enforces role-based access control before invoking the handler.
     * @param {string} name
     * @param {Object} args
     * @returns {Promise<Object>}
     */
    async execute(name, args) {
        // === ROLE ENFORCEMENT (server-side gate) ===
        const access = this.checkRoleAccess(name);
        if (!access.allowed) {
            console.warn(`[ToolRegistry] 🚫 Role violation: ${name} blocked for role '${State.settings.role}'`);
            return { error: access.reason };
        }
        
        const handler = this.handlers.get(name);
        if (!handler) {
            return { error: `Unknown tool: '${name}'. Use get_project_tree or list_issues to see what's available.` };
        }
        try {
            const result = await handler(args);
            // GUARANTEE: never return null/undefined/empty
            if (result === null || result === undefined) {
                return { error: `Tool '${name}' returned no result. This is a bug — please try a different approach.` };
            }
            return result;
        } catch (error) {
            // Structured errors — use .code + .recoveryHint when available
            if (error instanceof EditorError && error.recoveryHint) {
                return { error: `${error.message}. ${error.recoveryHint}`, code: error.code };
            }
            // Legacy status-based fallback
            if (error.status === 404) {
                return { error: `Not found (404). ${args?.path ? `'${args.path}' does not exist.` : ''} Use get_project_tree to see available files.` };
            }
            if (error.status === 403) {
                return { error: `Permission denied (403). Check API token permissions.` };
            }
            if (error.status === 409) {
                return { error: `Conflict (409). The file may have been modified. Refresh and try again.` };
            }
            if (error.status === 422) {
                return { error: `Validation error (422): ${error.message}. Check your parameters.` };
            }
            if (error.message?.includes('timeout')) {
                return { error: `Tool '${name}' timed out. Try a smaller operation or retry.` };
            }
            // Unknown errors — stringify so the LLM always knows what happened
            return { error: `Tool '${name}' failed: ${error.message || String(error)}` };
        }
    },
    
    /**
     * Get all tool definitions (unfiltered).
     * @returns {ToolDefinition[]}
     */
    getDefinitions() {
        return this.definitions;
    },
    
    /**
     * Get tools filtered for a specific role.
     * @param {string} [roleId] - Role name (defaults to current active role)
     * @returns {ToolDefinition[]}
     */
    getToolsForRole(roleId) {
        const activeRole = roleId || State.settings.role;
        
        // If 'full' role, return everything
        if (activeRole === 'full') {
            return this.definitions;
        }
        
        // Filter based on tool's registered roles
        return this.definitions.filter(tool => {
            const toolRoles = tool._registeredRoles || [];
            return toolRoles.includes('all') || toolRoles.includes(activeRole);
        });
    },
    
    /**
     * Get statistics about registered tools.
     * @returns {{total: number, byRole: Object.<string, number>}}
     */
    getStats() {
        const stats = {
            total: this.definitions.length,
            byRole: {}
        };
        
        // Count tools per role
        const allRoles = Roles.list();
        for (const role of allRoles) {
            // Temporarily set role and filter
            const filtered = this.definitions.filter(tool => {
                const toolRoles = tool._registeredRoles || [];
                if (role.id === 'full') return true;
                return toolRoles.includes('all') || toolRoles.includes(role.id);
            });
            stats.byRole[role.id] = filtered.length;
        }
        
        return stats;
    },
    
    /**
     * Clear all registered tools (useful for testing or hot reload).
     */
    clear() {
        this.handlers.clear();
        this.definitions = [];
        console.log('[ToolRegistry] Cleared all tools');
    }
};
