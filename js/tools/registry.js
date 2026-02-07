/**
 * AI Editor - Tool Registry
 * Dynamic tool registration system for LLM function calling
 */

export const ToolRegistry = {
    handlers: new Map(),
    definitions: [],
    
    /**
     * Register a tool with its handler and definition.
     * @param {string} name - Tool name
     * @param {Function} handler - Async function that executes the tool
     * @param {Object} definition - OpenAI function definition
     */
    register(name, handler, definition) {
        this.handlers.set(name, handler);
        this.definitions.push(definition);
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
     * Get all tool definitions.
     * @returns {Array} Array of tool definitions
     */
    getDefinitions() {
        return this.definitions;
    },
    
    /**
     * Get tools filtered for a specific role.
     * @param {string} role - Role name ('developer', 'chat', etc)
     * @returns {Array} Filtered tool definitions
     */
    getToolsForRole(role = 'developer') {
        // For now, return all tools for developer role
        // Chat role would filter out file-editing tools
        if (role === 'chat') {
            // Chat role: read-only tools
            return this.definitions.filter(def => {
                const name = def.function?.name || '';
                return !name.includes('replace') && 
                       !name.includes('insert') && 
                       !name.includes('delete') &&
                       !name.includes('create');
            });
        }
        return this.definitions;
    },
    
    /**
     * Clear all registered tools (useful for testing).
     */
    clear() {
        this.handlers.clear();
        this.definitions = [];
    }
};
