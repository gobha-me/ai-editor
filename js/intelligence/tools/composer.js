// @ts-check
/**
 * Tools Composer — admission consumer for the 1.4.0 Tools track.
 *
 * The Composer is the first runtime consumer of the data foundation that
 * shipped in 1.3.4 (`tool-id.js`, `contracts.js`, `catalog.js`). It walks a
 * profile's `tools.static` set, resolves each name through the `Catalog`,
 * applies authorization gates against the caller's `user_groups`, and packs
 * the result against `budget_tokens`. The output is a structured
 * `ToolAdmissionResult` — `admitted[]`, `suppressed[]`, counters — that the
 * caller renders into the OpenAI tool-array shape via `renderForLLM`.
 *
 * **Phase 1 / PR 2 scope (this file):**
 *   - Static-set admission only. `source: "static"` on every admitted entry.
 *   - Authorization filter via `metadata.authorization.required_groups`,
 *     mirroring the legacy `Roles.filterTools()` semantics ("all" group is
 *     always allowed; the "full" role bypasses).
 *   - Budget packing in declared order. Over-budget entries land in
 *     `suppressed[]` with `reason: 'over_budget'`.
 *   - Skip-not-throw on names that do not resolve via `Catalog.getByName()`.
 *     Surfaced in `diagnostics.unresolved_static` so callers can tell
 *     "missing on purpose" (PR-3 meta-tools) from "registry forgot".
 *
 * **Out of scope (subsequent PRs):**
 *   - Sticky admission via `TaskLedger.tool_admissions` / `tool_invocations`.
 *   - Discovery (categorical / semantic).
 *   - Lazy schema expansion (`form: "short"` on discovery).
 *   - Deprecation handling (`metadata.deprecated`).
 *
 * Pure function — no `State` reads, no DOM, no logging side effects. The
 * caller is responsible for wiring the result into `LLMDebug` and the
 * outgoing tool-array on the request body.
 *
 * @module intelligence/tools/composer
 */

import { Catalog } from './catalog.js';

/**
 * @typedef {import('./contracts.js').ToolDef} ToolDef
 * @typedef {import('./contracts.js').ToolID} ToolID
 * @typedef {import('./contracts.js').ToolRequest} ToolRequest
 * @typedef {import('./contracts.js').ToolAdmissionResult} ToolAdmissionResult
 * @typedef {import('./contracts.js').AdmittedTool} AdmittedTool
 * @typedef {import('./contracts.js').SuppressionRecord} SuppressionRecord
 * @typedef {import('./contracts.js').ToolDiagnostics} ToolDiagnostics
 * @typedef {import('../../tools/registry.js').ToolDefinition} ToolDefinition
 */

/**
 * Test whether the caller's `user_groups` satisfies the tool's
 * `authorization.required_groups`. Mirrors `Roles.filterTools()`:
 *
 *   - The `"full"` group is the bypass — admits everything.
 *   - The `"all"` required-group always admits (every caller has implicit
 *     `"all"`).
 *   - Otherwise any overlap admits.
 *
 * Empty `required_groups` means "no restriction" (matches the legacy
 * "tool didn't declare a role" branch in `Roles.filterTools()` which
 * would also admit it under `'full'` and exclude under any other role —
 * we replicate "always admit if no requirement" here as the conservative
 * forward-compatible read).
 *
 * @param {string[]} requiredGroups
 * @param {string[]} userGroups
 * @returns {boolean}
 */
function isAuthorized(requiredGroups, userGroups) {
    if (Array.isArray(userGroups) && userGroups.includes('full')) return true;
    if (!Array.isArray(requiredGroups) || requiredGroups.length === 0) return true;
    if (requiredGroups.includes('all')) return true;
    if (!Array.isArray(userGroups)) return false;
    for (const g of userGroups) {
        if (requiredGroups.includes(g)) return true;
    }
    return false;
}

/**
 * Render one `ToolDef` to the OpenAI tool-array shape that
 * `js/chat/handlers.js` and `js/llm/api.js` already consume. The shape is
 * identical to what `ToolRegistry.getDefinitions()` returns today, minus
 * the internal `_registeredRoles` field (the admission decision has
 * already happened, so callers don't need to re-filter).
 *
 * @param {ToolDef} td
 * @returns {ToolDefinition}
 */
function toOpenAIShape(td) {
    return {
        type: 'function',
        function: {
            name: td.name,
            description: td.description,
            parameters: td.schema,
        },
    };
}

/**
 * Compose the per-call admission. Pure function: same inputs → same
 * outputs, no side effects.
 *
 * Order of operations:
 *   1. For each name in `profile_static`, resolve via `Catalog.getByName`.
 *      Null → push to `unresolved_static`, skip.
 *   2. Authorization filter via `isAuthorized`. Failures land in
 *      `suppressed` with `reason: 'unauthorized'`.
 *   3. Budget packing. Walk in declared order; admit when
 *      `tokens_used + cost_estimate ≤ budget_tokens`. Otherwise suppress
 *      with `reason: 'over_budget'`.
 *
 * @param {ToolRequest} request
 * @returns {ToolAdmissionResult}
 */
export function composeAdmission(request) {
    const profileStatic = Array.isArray(request?.profile_static) ? request.profile_static : [];
    const userGroups = Array.isArray(request?.user_groups) ? request.user_groups : [];
    const budget = typeof request?.budget_tokens === 'number' && request.budget_tokens > 0
        ? request.budget_tokens
        : Infinity;

    /** @type {AdmittedTool[]} */
    const admitted = [];
    /** @type {SuppressionRecord[]} */
    const suppressed = [];
    /** @type {string[]} */
    const unresolved = [];
    let tokensUsed = 0;

    for (const name of profileStatic) {
        const td = Catalog.getByName(name);
        if (!td) {
            unresolved.push(name);
            continue;
        }

        if (!isAuthorized(td.metadata.authorization.required_groups, userGroups)) {
            suppressed.push({
                tool_id: td.id,
                reason: 'unauthorized',
                detail: `requires one of: ${td.metadata.authorization.required_groups.join(', ') || '(none)'}`,
            });
            continue;
        }

        const cost = td.metadata.cost_estimate;
        if (tokensUsed + cost > budget) {
            suppressed.push({
                tool_id: td.id,
                reason: 'over_budget',
                detail: `cost=${cost}, used=${tokensUsed}, budget=${budget}`,
            });
            continue;
        }

        admitted.push({
            tool_id: td.id,
            form: 'full',           // PR 2 always full; lazy expansion arrives later.
            rendered: JSON.stringify(toOpenAIShape(td)),
            source: 'static',
        });
        tokensUsed += cost;
    }

    /** @type {ToolDiagnostics} */
    const diagnostics = {
        static_admitted: admitted.length,
        sticky_admitted: 0,
        discovery_admitted: 0,
        suppressed: suppressed.length,
        unresolved_static: unresolved,
    };

    return {
        admitted,
        suppressed,
        diagnostics,
        tokens_used: tokensUsed,
    };
}

/**
 * Convert a `ToolAdmissionResult` to the OpenAI tool-array the existing
 * chat path expects. Order is preserved from `admitted[]` so the caller
 * controls priority (the `LLMTools.getToolsForRole()` consumer keeps
 * declared order).
 *
 * Re-resolves through the `Catalog` rather than parsing `AdmittedTool.rendered`
 * — the rendered field is a diagnostic record (what *was* sent), not an
 * authoritative source. If the registry mutates between admission and
 * render (a plugin registers mid-call), we still emit the registered shape.
 *
 * @param {ToolAdmissionResult} result
 * @returns {ToolDefinition[]}
 */
export function renderForLLM(result) {
    if (!result || !Array.isArray(result.admitted)) return [];
    /** @type {ToolDefinition[]} */
    const out = [];
    for (const a of result.admitted) {
        const td = Catalog.getById(a.tool_id);
        if (!td) continue; // tool was removed between admit and render — drop silently
        out.push(toOpenAIShape(td));
    }
    return out;
}

export const _testing = {
    isAuthorized,
    toOpenAIShape,
};
