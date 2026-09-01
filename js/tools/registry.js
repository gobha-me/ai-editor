// @ts-check
/**
 * AI Editor - Tool Registry
 * Dynamic tool registration system for LLM function calling.
 *
 * Admission is profile-side (gitea#438 / 2.54.0). Tools no longer carry
 * a `roles:` field; profiles enumerate the tool names they admit in
 * `tools.admit`, and `Profiles.filterTools` matches by name (with
 * `'<prefix>__*'` glob support for MCP). The registry only stores the
 * definition + handler; it does not gate.
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
 * @property {'function'}             type
 * @property {ToolFunctionSchema}     function
 * @property {boolean}                [readOnly]   - True if the tool reads only and never mutates files / repo / persistent state. Used by Plan Mode (github#25) to filter the LLM's tool catalog. Default: undefined ⇒ treated as mutating (safe default — opt-in to read-only).
 * @property {string}                 [category]   - Category id used by the catalog adapter (e.g. `'mcp.<serverId>'`).
 * @property {'by-args' | 'never'}    [cache]      - Cache eligibility for the dup-detection layer (2.71.0 / gitea#472). `'by-args'` (default): result is a pure function of (toolName, args) — same-args calls served from cache; mutations to referenced paths / preview state invalidate via the existing FILE_MUTATING_TOOLS / PREVIEW_MUTATING_TOOLS walks. `'never'`: result depends on hidden state (active file, FS dirty state, remote CI status, iframe DOM, indexer state, user response, etc.) — bypass both same-request `toolCallCache` and cross-request `toolActionLog` dup hits. Required for any tool that aggregates over repo/remote state, takes no args but returns variable data, or otherwise reads state not captured by args. The lint test in [`tests/test-tool-cache-classifications.mjs`](../../tests/test-tool-cache-classifications.mjs) forces conscious classification at registration time so the next `list_X` tool doesn't reopen the gitea#301 / #472 wound.
 */

/**
 * @callback ToolHandler
 * @param {Object} args - Tool arguments (parsed from JSON)
 * @returns {Promise<Object>} Tool result object
 */

import { State, EventBus } from '../core.js';
import { EditorError, ErrorCode } from '../utils/errors.js';
import { Profiles } from '../profiles/registry.js';
import { PLUGIN_TOOL_NAMES } from '../profiles/resolve.js';
import { ConversationManager } from '../chat/conversations.js';
import { scanForInvisible } from '../security/untrusted-wrap.js';
import { getPlanMode } from '../chat/state.js';
import { getSideEffectByName } from '../intelligence/tools/side-effects.js';

/**
 * 2.76.0 (gitea#480) — plan-mode allowlist for tools whose `side_effects`
 * classification is `'write'` but whose effect stays inside the current
 * chat session (no file, repo, or remote mutation). Without this carve-out,
 * a strict `side_effects === 'read'` rule would block the planning LLM
 * from using its own working-memory surface. Kept deliberately tight —
 * `scratchpad_clear` is intentionally excluded (destructive bulk-drop),
 * mirroring the pre-fix posture pinned by `tests/test-plan-mode.mjs`.
 *
 * @type {Set<string>}
 */
const PLAN_MODE_SESSION_WRITE_ALLOWLIST = new Set([
    'scratchpad_write',
    'todo_write',
    // Preview action tools — mutate sandboxed iframe DOM / start-stop
    // the preview server; no repo / file / remote effect. Admitted in
    // plan mode to preserve pre-2.76.0 behavior (these were registered
    // with the legacy `readOnly: true` flag). See the matching
    // classification block in `js/intelligence/tools/side-effects.js`.
    'preview_click',
    'preview_fill',
    'preview_resize',
    'preview_start',
    'preview_stop',
]);

// 10 MB soft cap — any larger payload (pathological MCP return, oversized
// read_file) skips the invisible-Unicode scan to avoid blocking the main
// thread. The lint inside `js/security/invisible-unicode.js` is a single
// regex sweep + line-index pass, so 10 MB clean text completes well under
// a second; 100 MB would not.
const TOOL_RETURN_SCAN_MAX_BYTES = 10_000_000;

export const ToolRegistry = {
    /** @type {Map<string, ToolHandler>} */
    handlers: new Map(),
    /** @type {ToolDefinition[]} */
    definitions: [],
    
    /**
     * Register a tool with its handler and definition.
     * @param {string} name
     * @param {ToolHandler} handler
     * @param {Object} definition - OpenAI function definition (`type`, `function`, optional `readOnly`, optional `category`).
     * @returns {void}
     */
    register(name, handler, definition) {
        // 2.54.0 (gitea#438) — admission moved to the profile side.
        // Tools no longer carry a `roles:` field; profiles enumerate
        // explicit tool names in `tools.admit` and `Profiles.filterTools`
        // matches by name (with `'<prefix>__*'` glob support for MCP).
        // The pre-2.54.0 `roles:` validation block + `_registeredRoles`
        // enrichment are retired; `register()` is now a pure store.
        const enrichedDefinition = {
            type: 'function',  // Ensure always present
            ...definition,
        };

        this.handlers.set(name, handler);

        const existingIdx = this.definitions.findIndex(d => d.function?.name === name);
        if (existingIdx !== -1) {
            this.definitions.splice(existingIdx, 1);
            console.log(`[ToolRegistry] ♻️ Re-registered tool: ${name}`);
        } else {
            console.log(`[ToolRegistry] ✅ Registered tool: ${name}`);
        }
        this.definitions.push(enrichedDefinition);

        // gitea#439 — default-OFF dev warning. 2.54.0's inversion accepted
        // "newly-registered tool admitted by no profile = silently unreachable"
        // as the cost of fixing silent over-admission; this surfaces it.
        // Only fires on first registration: re-register implies the tool
        // was already in the registry (if it was admit-clean then, it still
        // is; HMR/MCP-reconnect would otherwise re-warn for the same tool).
        //
        // 2.58.0 (gitea#442) — pass `PLUGIN_TOOL_NAMES` overlay so the
        // plugin SDK + doc tools (admitted via the `plugin.enabled` flag
        // rather than per-profile `tools.admit`) don't trip the warn.
        // The `'<overlay>'` synthetic admitter pushed by
        // `findAdmittingProfiles` keeps the result non-empty for these
        // names without claiming a picker-profile admits them.
        if (existingIdx === -1) {
            const admitters = Profiles.findAdmittingProfiles(name, { overlayNames: PLUGIN_TOOL_NAMES });
            if (admitters.length === 0) {
                console.warn(`[ToolRegistry] tool '${name}' is not admitted by any profile; add to profile X.tools.admit (e.g. chat.v1, coder.v1, kb.v1)`);
            }
        }
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
     * Cache eligibility class for a registered tool (2.71.0 / gitea#472).
     *
     * Lifts the dup-cache classification onto the tool descriptor so the
     * decision lives next to the registration site rather than in a
     * hand-maintained array in `js/chat/tool-classifications.js`. The
     * legacy `STATEFUL_READ_TOOLS` const documents the pre-2.71.0
     * baseline; the runtime check at `tool-loop-core.js` (`isStatefulRead`)
     * unions the legacy const with this registry-driven set.
     *
     * @param {string} name
     * @returns {'by-args' | 'never'} `'never'` if the tool was registered
     *   with `cache: 'never'`. Default `'by-args'` covers status-quo behavior
     *   (pure function of args; invalidation handled by the existing
     *   FILE_MUTATING_TOOLS / PREVIEW_MUTATING_TOOLS walks).
     */
    getCacheClass(name) {
        const def = this.definitions.find(d => d.function?.name === name);
        return def?.cache === 'never' ? 'never' : 'by-args';
    },

    /**
     * Check whether a given profile is allowed to invoke a given tool.
     *
     * **2.49.0.0 — extracted from `checkRoleAccess`.** The explicit-
     * profile entry-point used by `executeWithProfile` (slice 1 of
     * github#24 Phase 1; see
     * [`docs/DESIGN-sub-agents.md`](../../docs/DESIGN-sub-agents.md)
     * §"Decision §4 — Tool scoping is intersection, not union" for why
     * the sub-agent loop needs a profile-explicit gate instead of the
     * conversation-binding default).
     *
     * @param {string} name        Tool name
     * @param {string} profileName Profile name to gate against (e.g. `'subagent.v1'`)
     * @returns {{ allowed: boolean, reason?: string }}
     */
    checkRoleAccessForProfile(name, profileName) {
        const def = this.definitions.find(
            d => d.function?.name === name
        );
        if (!def) {
            // Unknown tool — let execute() handle the "not found" error
            return { allowed: true };
        }

        const filtered = Profiles.filterTools([def], profileName);
        if (filtered.length === 1) {
            return { allowed: true };
        }

        return {
            allowed: false,
            reason: `Profile '${profileName}' is not permitted to use tool '${name}'. ` +
                    `Profiles list admitted tools in tools.admit (gitea#438). ` +
                    `Switch profile via the new-chat picker or in Settings.`
        };
    },

    /**
     * Check whether the active profile is allowed to invoke a given tool.
     *
     * **2.0.0 — slice 3 flip.** Was role-keyed pre-2.0.0 (`State.settings.role`
     * → special-case `'full'` → intersect `_registeredRoles` with the role).
     * Now delegates to `Profiles.filterTools` so the runtime tool-execute
     * gate and the per-turn admission filter share a single implementation.
     * The pre-2.0.0 `'full'` bypass is preserved via `full.v1`'s
     * `tools.admit: ['*']` short-circuit inside `filterTools` (gitea#438).
     *
     * **2.49.0.0** — body lifted to `checkRoleAccessForProfile`; this
     * wrapper preserves the conversation-binding default. Equivalence
     * pinned by `tests/test-tool-registry-execute-with-profile.mjs`.
     *
     * @param {string} name - Tool name
     * @returns {{ allowed: boolean, reason?: string }}
     */
    checkRoleAccess(name) {
        // 2.8.0 — `ConversationManager.getEffectiveProfileName()` lets
        // a per-chat profile binding win over `State.settings.profile`.
        return this.checkRoleAccessForProfile(name, ConversationManager.getEffectiveProfileName());
    },

    /**
     * Check whether plan mode admits a given tool.
     *
     * **2.76.0 (gitea#480) — authoritative dispatch-side gate.** Pre-2.76.0
     * the only plan-mode filter was the LLM-visible tool list (`applyPlanModeFilter`
     * in `js/llm/api.js`), keyed on the opt-in `readOnly: true` flag. Two
     * write tools (`write_file`, `create_pull_request`) shipped without
     * the flag *and* the dispatch path had no second check, so a model
     * call that landed via cache / sub-agent / stale tool-message would
     * execute without gating. Real incident: PR #259 created on
     * `xcaliber/HTML-Games` while plan mode was active.
     *
     * The fix shifts the source of truth to `side_effects` (already
     * classified per tool in `js/intelligence/tools/side-effects.js`).
     * Admit-when-planMode: `side_effects === 'read'` OR name in the
     * session-write allowlist (`scratchpad_write`, `todo_write`).
     * Fail-closed default catches future tools without a classification
     * (including MCP-bridged tools, which surface as `'external'`).
     *
     * When plan mode is OFF this method returns `{ allowed: true }`
     * unconditionally — the role/profile gate downstream is the only
     * filter that applies.
     *
     * @param {string} name Tool name
     * @returns {{ allowed: boolean, reason?: string, sideEffect?: string }}
     */
    checkPlanModeAccess(name) {
        if (!getPlanMode()) {
            return { allowed: true };
        }
        if (PLAN_MODE_SESSION_WRITE_ALLOWLIST.has(name)) {
            return { allowed: true };
        }
        const sideEffect = getSideEffectByName(name);
        if (sideEffect === 'read') {
            return { allowed: true };
        }
        return {
            allowed: false,
            sideEffect,
            reason: `Tool '${name}' is blocked in plan mode (side_effects='${sideEffect}'). ` +
                    `Plan mode admits read-only tools plus a small session-write allowlist ` +
                    `(scratchpad_write, todo_write); submit your plan via submit_plan_for_approval ` +
                    `to leave plan mode and run mutating tools.`
        };
    },

    /**
     * Execute a registered tool by name under an explicit profile.
     *
     * **2.49.0.0 — slice 1 of github#24 Phase 1.** Additive entry-point
     * for the sub-agent tool loop. The sub-agent runs in a context where
     * `ConversationManager.getEffectiveProfileName()` returns the
     * *parent* conversation's profile, not the sub-agent's — so the
     * default `execute(name, args)` path would gate against the wrong
     * profile. `executeWithProfile(name, args, 'subagent.v1')` consults
     * the explicit profile name; everything else (handler dispatch,
     * error envelopes, `scanToolReturn`) is byte-identical.
     *
     * The existing `execute` delegates here with the conversation-bound
     * profile name, so there is one implementation body. Equivalence
     * pinned by `tests/test-tool-registry-execute-with-profile.mjs`.
     *
     * @param {string} name
     * @param {Object} args
     * @param {string} profileName Profile name to gate against.
     * @returns {Promise<Object>}
     */
    async executeWithProfile(name, args, profileName) {
        // === PLAN MODE ENFORCEMENT (dispatch-side gate) ===
        // 2.76.0 (gitea#480) — runs before profile/role check so a
        // blocked-in-plan-mode tool returns the plan-mode reason rather
        // than a misleading profile-violation reason. The list-side
        // `applyPlanModeFilter` in `js/llm/api.js` is the first gate
        // (cheaper — never sends the tool to the model); this is the
        // authoritative second gate that catches calls landing via
        // cached tool messages, sub-agent paths, or MCP shims that
        // bypass the list filter.
        const planAccess = this.checkPlanModeAccess(name);
        if (!planAccess.allowed) {
            console.warn(`[ToolRegistry] 🚫 Plan mode block: ${name} (side_effects='${planAccess.sideEffect}')`);
            return { error: planAccess.reason };
        }

        // === ROLE ENFORCEMENT (server-side gate) ===
        const access = this.checkRoleAccessForProfile(name, profileName);
        if (!access.allowed) {
            console.warn(`[ToolRegistry] 🚫 Profile violation: ${name} blocked for profile '${profileName}'`);
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
     * Execute a registered tool by name.
     * Enforces role-based access control before invoking the handler.
     *
     * **2.49.0.0** — body lifted to `executeWithProfile`; this wrapper
     * preserves the conversation-binding default. Equivalence pinned by
     * `tests/test-tool-registry-execute-with-profile.mjs`.
     *
     * @param {string} name
     * @param {Object} args
     * @returns {Promise<Object>}
     */
    async execute(name, args) {
        return this.executeWithProfile(name, args, ConversationManager.getEffectiveProfileName());
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
     * The 2.0.0 slice-3 rename ran with a 2.1.0-targeted deprecation
     * shim under the old `getToolsForRole` name; that shim retired at
     * 2.1.0 as planned. There is no plugin-side alias today — callers
     * import `getToolsForProfile` directly. See
     * [`docs/DESIGN-tools.md`](../../docs/DESIGN-tools.md)
     * §"Per-export contract" for the admission contract.
     *
     * @param {string} [profileName] - Profile name (defaults to active)
     * @returns {ToolDefinition[]}
     */
    getToolsForProfile(profileName) {
        const name = profileName || ConversationManager.getEffectiveProfileName();
        return Profiles.filterTools(this.definitions, name);
    },

    /**
     * Filter a tool-definition list down to entries admitted by plan mode.
     * Used by `applyPlanModeFilter` in `js/llm/api.js` to constrain the
     * LLM's tool catalog while a plan is being assembled.
     *
     * **2.76.0 (gitea#480) — migrated from `readOnly === true` to
     * `side_effects`.** Pre-2.76.0 the filter consulted the opt-in
     * `readOnly: true` flag on each definition; that flag was missed on
     * `write_file` + `create_pull_request` and the dispatch path had no
     * second check, so the gate could be bypassed. The source of truth
     * is now `js/intelligence/tools/side-effects.js`, consulted via
     * `checkPlanModeAccess(name)`. The `readOnly` field on definitions
     * stays as a documentation axis but no longer gates behavior.
     *
     * Fail-closed semantics: tools without a `side_effects` entry
     * default to `'external'` and are dropped (including MCP-bridged
     * tools, which can't be classified without server-specific
     * introspection — the conservative correct outcome).
     *
     * Name preserved for compatibility — `js/llm/api.js` and any other
     * consumer of the public surface (per `docs/DESIGN-tools.md`)
     * continue to call `filterReadOnly`. The function is no longer
     * planMode-state-sensitive: it always returns the plan-mode-admitted
     * subset regardless of whether plan mode is active. Callers gate on
     * `getPlanMode()` themselves before deciding whether to apply the
     * filter at all.
     *
     * @param {ToolDefinition[]} defs
     * @returns {ToolDefinition[]}
     */
    filterReadOnly(defs) {
        return defs.filter(tool => {
            const name = tool?.function?.name;
            if (typeof name !== 'string') return false;
            if (PLAN_MODE_SESSION_WRITE_ALLOWLIST.has(name)) return true;
            return getSideEffectByName(name) === 'read';
        });
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
