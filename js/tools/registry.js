/**
 * AI Editor - Tool Registry
 * Dynamic tool registration system for LLM function calling with role-based access control
 */

import { Roles, State } from '../core.js';

export const ToolRegistry = {
    handlers: new Map(),
    definitions: [],
    
    /**
     * Register a tool with its handler and definition.
     * 
     * @param {string} name - Tool name
     * @param {Function} handler - Async function that executes the tool
     * @param {Object} definition - OpenAI function definition with additional metadata
     * @param {string|string[]} definition.roles - Required: Role(s) that can access this tool
     *                                              - 'all': available to all roles
     *                                              - ['coder', 'pm']: specific roles only
     * 
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
            ...definition,
            _registeredRoles: toolRoles
        };
        
        this.handlers.set(name, handler);
        this.definitions.push(enrichedDefinition);
        
        console.log(`[ToolRegistry] ✅ Registered tool: ${name} (roles: ${toolRoles.join(', ')})`);
    },
    
    /**
     * Execute a registered tool by name.
     * @param {string} name - Tool name
     * @param {Object} args - Tool arguments
     * @returns {Promise<Object>} Tool result
     */
    async execute(name, args) {
        const handler = this.handlers.get(name);
        if (!handler) {
            throw new Error(`Unknown tool: ${name}`);
        }
        return handler(args);
    },
    
    /**
     * Get all tool definitions (unfiltered).
     * @returns {Array} Array of tool definitions
     */
    getDefinitions() {
        return this.definitions;
    },
    
    /**
     * Get tools filtered for a specific role.
     * Delegates to Roles.filterTools() which applies role-based filtering.
     * 
     * @param {string} roleId - Role name (defaults to current active role from State)
     * @returns {Array} Filtered tool definitions
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
     * @returns {Object} { total, byRole: { roleId: count } }
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
