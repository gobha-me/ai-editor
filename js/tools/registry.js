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
 * @property {boolean}            [readOnly]        - True if the tool reads only and never mutates files / repo / persistent state. Used by Plan Mode (github#25) to filter the LLM's tool catalog. Default: undefined ⇒ treated as mutating (safe default — opt-in to read-only).
 */

/**
 * @callback ToolHandler
 * @param {Object} args - Tool arguments (parsed from JSON)
 * @returns {Promise<Object>} Tool result object
 */

import { State, EventBus } from '../core.js';
import { EditorError, ErrorCode } from '../utils/errors.js';
import { Profiles } from '../profiles/registry.js';
import { ConversationManager } from '../chat/conversations.js';
import { scanForInvisible } from '../security/untrusted-wrap.js';

// 10 MB soft cap — any larger payload (pathological MCP return, oversized
// read_file) skips the invisible-Unicode scan to avoid blocking the main
// thread. The lint inside `js/security/invisible-unicode.js` is a single
// regex sweep + line-index pass, so 10 MB clean text completes well under
// a second; 100 MB would not.
const TOOL_RETURN_SCAN_MAX_BYTES = 10_000_000;

/**
 * 2.0.0 — slice 3: legacy admission-tag list. Pre-2.0.0 these were
 * "role IDs"; post-2.0.0 they're consumed as group tags by
 * `Profile.tools.allowed_groups`. The `register()` validator below
 * rejects any other value at registration time so tool authors
 * surface the typo immediately.
 *
 * @type {string[]}
 */
const LEGAL_GROUP_TAGS = ['all', 'coder', 'pm', 'reviewer', 'plugin-dev', 'full'];

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
        
        // 3. Validate group tags against the legacy 5-key tag list.
        //    2.0.0 — slice 3: pre-2.0.0 this validated against `Roles.exists()`;
        //    profile-keyed admission consumes the same tag vocabulary, so
        //    the validator stays a flat allowlist of legal tags.
        const invalidRoles = toolRoles.filter(r => !LEGAL_GROUP_TAGS.includes(r));
        if (invalidRoles.length > 0) {
            throw new Error(
                `Tool "${name}" references invalid role(s): ${invalidRoles.join(', ')}. ` +
                `Valid tags: ${LEGAL_GROUP_TAGS.join(', ')}`
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
     * Check whether the active profile is allowed to invoke a given tool.
     *
     * **2.0.0 — slice 3 flip.** Was role-keyed pre-2.0.0 (`State.settings.role`
     * → special-case `'full'` → intersect `_registeredRoles` with the role).
     * Now delegates to `Profiles.filterTools` so the runtime tool-execute
     * gate and the per-turn admission filter share a single implementation.
     * The pre-2.0.0 `'full'` bypass is preserved via `full.v1`'s
     * `tools.allowed_groups: ['*']` short-circuit inside `filterTools`.
     *
     * @param {string} name - Tool name
     * @returns {{ allowed: boolean, reason?: string }}
     */
    checkRoleAccess(name) {
        const def = this.definitions.find(
            d => d.function?.name === name
        );
        if (!def) {
            // Unknown tool — let execute() handle the "not found" error
            return { allowed: true };
        }

        // 2.8.0 — `ConversationManager.getEffectiveProfileName()` lets
        // a per-chat profile binding win over `State.settings.profile`.
        const profileName = ConversationManager.getEffectiveProfileName();
        const filtered = Profiles.filterTools([def], profileName);
        if (filtered.length === 1) {
            return { allowed: true };
        }

        const toolRoles = def._registeredRoles || [];
        return {
            allowed: false,
            reason: `Profile '${profileName}' is not permitted to use tool '${name}'. ` +
                    `Tool requires one of: ${toolRoles.join(', ') || '(none declared)'}. ` +
                    `Switch profile via the new-chat picker or in Settings.`
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
            console.warn(`[ToolRegistry] 🚫 Profile violation: ${name} blocked for profile '${ConversationManager.getEffectiveProfileName()}'`);
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
            // Invisible-Unicode scan on every tool return (PR #296 / 1.6.12
            // covered only `read_issue` / `read_pull_request`). Mirrors the
            // `_security.invisibleUnicode` shape those tools attach so the
            // chat layer surfaces both with the same render path. Skipped
            // when the tool already populated the field — issue/PR's
            // narrower scan of just the untrusted span has better
            // signal-to-noise than a re-scan over the whole envelope.
            scanToolReturn(name, result);
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
     * Get tools filtered for a specific profile.
     *
     * **2.0.0 — slice 3 flip.** Was `getToolsForRole(roleId)` pre-2.0.0;
     * now keyed on profile name with the body delegating to
     * `Profiles.filterTools`. Caller-supplied profileName is honored;
     * default reads `ConversationManager.getEffectiveProfileName()` so
     * per-chat profile bindings win over `State.settings.profile`
     * (2.8.0). The legacy name `_registeredRoles` on tool defs is
     * preserved — those values are admission tags consumed by
     * `Profile.tools.allowed_groups`.
     *
     * Renamed from `getToolsForRole`; the legacy alias is preserved
     * below for any plugin-side caller that still imports the old
     * name (deprecation shim retires at 2.1.0).
     *
     * @param {string} [profileName] - Profile name (defaults to active)
     * @returns {ToolDefinition[]}
     */
    getToolsForProfile(profileName) {
        const name = profileName || ConversationManager.getEffectiveProfileName();
        return Profiles.filterTools(this.definitions, name);
    },

    /**
     * Filter a tool-definition list down to read-only entries. Used by
     * Plan Mode (github#25) to constrain what the LLM can call while a
     * plan is being assembled. The filter is applied on top of role
     * filtering / Composer admission — i.e. callers pass the list they
     * would otherwise send to the LLM, and this drops any tool whose
     * definition lacks an explicit `readOnly: true` flag.
     *
     * Default-mutating is the safe default: a tool author who forgets
     * to declare read-only-ness loses plan-mode admission, not the
     * other way around (opt-in, not opt-out). MCP tools land without
     * this flag and therefore can't be invoked while planning, which
     * is the conservative choice — most MCP servers expose write
     * actions, and the registry can't introspect their semantics.
     *
     * @param {ToolDefinition[]} defs
     * @returns {ToolDefinition[]}
     */
    filterReadOnly(defs) {
        return defs.filter(tool => tool && tool.readOnly === true);
    },
    
    /**
     * Get statistics about registered tools.
     *
     * **2.0.0 — slice 3.** Was role-keyed pre-2.0.0 (5 entries via
     * `Roles.list()`); now profile-keyed (2 entries via `Profiles.list()`
     * — chat + coder). Synthetic profiles (`full`/`pm`/`reviewer`/
     * `plugin-dev`) are excluded from the dashboard mirror of their
     * exclusion from the picker; they're migration targets, not
     * user-facing surfaces.
     *
     * @returns {{total: number, byRole: Object.<string, number>}}
     */
    getStats() {
        const stats = {
            total: this.definitions.length,
            byRole: {}
        };
        for (const entry of Profiles.list()) {
            stats.byRole[entry.name] = Profiles.filterTools(this.definitions, entry.name).length;
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

/**
 * Scan a tool's return payload for invisible Unicode and attach findings
 * to `result._security.invisibleUnicode` in-place. Mutating the result
 * mirrors the issue/PR pattern (see `js/tools/issue-tools.js`,
 * `js/tools/pr-tools.js`) — a single render path then surfaces the
 * warning consistently regardless of which tool produced it.
 *
 * Exported for the test harness; not part of the registry's public API.
 *
 * @param {string} name
 * @param {Object} result
 * @returns {void}
 */
export function scanToolReturn(name, result) {
    try {
        if (result?._security?.invisibleUnicode) return;
        const serialized = JSON.stringify(result);
        if (typeof serialized !== 'string') return;
        if (serialized.length > TOOL_RETURN_SCAN_MAX_BYTES) {
            console.warn(`[security] invisible-unicode scan skipped — tool '${name}' return exceeds ${TOOL_RETURN_SCAN_MAX_BYTES} bytes (${serialized.length})`);
            return;
        }
        const scanResult = scanForInvisible(serialized, name);
        if (!scanResult) return;
        if (!result._security) result._security = {};
        result._security.invisibleUnicode = scanResult;
        console.warn(`[security] invisible-unicode in tool return '${name}':`, scanResult);
    } catch (err) {
        // Circular references or non-serializable returns shouldn't break
        // tool execution — log and proceed with the unscanned result.
        console.warn(`[security] invisible-unicode scan failed for tool '${name}':`, err);
    }
}
