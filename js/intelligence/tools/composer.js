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
 * **Phase 1 scope (this file):**
 *   - Static-set admission. `source: "static"` on entries from
 *     `request.profile_static`.
 *   - **Sticky admission** (added 1.3.17 / PR 4) via
 *     `request.task_ledger.tool_admissions`. Tools the model invoked on a
 *     prior turn re-admit additively on top of the static set. Skipped if
 *     the same `tool_id` already admitted from static (the ledger never
 *     duplicates static membership). `source: "sticky"` on entries.
 *   - Authorization filter via `metadata.authorization.required_groups`,
 *     mirroring the legacy `Roles.filterTools()` semantics ("all" group is
 *     always allowed; the "full" role bypasses). Applies uniformly to
 *     static AND sticky entries — an authorization change mid-task drops
 *     a previously-sticky tool with `reason: 'unauthorized'`.
 *   - Budget packing. Static admits first (declared order); sticky admits
 *     after, in ledger order. Sticky overflow lands in `suppressed[]` with
 *     `reason: 'over_budget'` — protecting the static set's budget claim.
 *   - Skip-not-throw on names that do not resolve via `Catalog.getByName()`.
 *     Surfaced in `diagnostics.unresolved_static` so callers can tell
 *     "missing on purpose" (PR-3 meta-tools) from "registry forgot".
 *
 * **Out of scope (subsequent PRs):**
 *   - Discovery (categorical / semantic) — sub-prompt that returns "admit
 *     these" hints to the Composer mid-call.
 *   - Lazy schema expansion (`form: "short"` on discovery).
 *   - LRU eviction of sticky entries when memory pressure exceeds budget.
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
 * `js/chat/handlers.js` and `js/llm/api.js` already consume.
 *
 * `form: "short"` (1.4.1 lazy expansion) omits the `parameters` key
 * entirely; the OpenAI tool-call spec defaults missing `parameters` to
 * `{type: "object", properties: {}}`, so the model still sees a callable
 * function — just without the schema. The first successful invocation
 * promotes the ledger entry to `"full"` (see `task-state.js#recordInvocation`),
 * after which the next-turn admission renders the full schema.
 *
 * @param {ToolDef}                td
 * @param {"short"|"full"}        [form]  Defaults to `"full"` for back-compat.
 * @returns {ToolDefinition}
 */
function toOpenAIShape(td, form) {
    /** @type {{name: string, description: string, parameters?: Object}} */
    const fn = {
        name: td.name,
        description: td.description,
    };
    if (form !== 'short') {
        fn.parameters = td.schema;
    }
    return {
        type: 'function',
        function: fn,
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
 *   3. Budget packing for static. Walk in declared order; admit when
 *      `tokens_used + cost_estimate ≤ budget_tokens`. Otherwise suppress
 *      with `reason: 'over_budget'`.
 *   4. Sticky pass — for each entry in `task_ledger.tool_admissions`,
 *      resolve via `Catalog.getById` (preferred) or `Catalog.getByName`
 *      (fallback for ledgers built before stable `ToolID` propagation).
 *      Skip if the same `tool_id` already admitted from static.
 *      Authorization + budget gates apply identically to static; ledger-
 *      ordered packing means an early-discovered tool wins over a later
 *      one when budget tightens.
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
            form: 'full',           // Static path is always full; lazy expansion (1.4.1) only applies to discovery.
            rendered: JSON.stringify(toOpenAIShape(td, 'full')),
            source: 'static',
        });
        tokensUsed += cost;
    }

    const staticCount = admitted.length;
    let stickyAdmitted = 0;

    // 1.3.17 / PR 4 — sticky admission via the unified TaskLedger. The
    // ledger's `tool_admissions[]` carries entries the chat-side hook
    // wrote when the model invoked a non-static tool on a prior turn.
    // Order in the ledger reflects discovery order, so packing in that
    // order means the earliest-discovered tool gets priority when the
    // budget tightens — matching the operator's intuition that "you've
    // been using this all task" beats "you tried this once recently."
    const ledger = request?.task_ledger;
    /** @type {Set<string>} */
    const admittedIds = new Set(admitted.map(a => a.tool_id));
    if (ledger && Array.isArray(ledger.tool_admissions)) {
        for (const rec of ledger.tool_admissions) {
            if (!rec || typeof rec.tool_id !== 'string') continue;

            // Resolve. Prefer ToolID (stable across registry edits), fall
            // back to name for ledgers built before ToolIDs landed in
            // every record (records today persist `tool_id === toolName`,
            // matching `task-state.js#recordInvocation`).
            const td = Catalog.getById(rec.tool_id) || Catalog.getByName(rec.tool_id);
            if (!td) {
                // Ledger references a tool the registry no longer knows
                // about (plugin unloaded mid-session, etc.). Drop silently
                // — sticky admission is best-effort, not a hard contract.
                continue;
            }

            // Static wins — never duplicate the same tool across sources.
            // Compare on the resolved Catalog ID (`td.id`) because the
            // ledger entry's `tool_id` is name-keyed today (per
            // `task-state.js#recordInvocation`) while `admitted[]` carries
            // the hash-based `td.id`.
            if (admittedIds.has(td.id)) continue;

            if (!isAuthorized(td.metadata.authorization.required_groups, userGroups)) {
                suppressed.push({
                    tool_id: td.id,
                    reason: 'unauthorized',
                    detail: `requires one of: ${td.metadata.authorization.required_groups.join(', ') || '(none)'}`,
                });
                continue;
            }

            // Honor the ledger's recorded form. Pre-1.4.1 ledgers wrote
            // `'full'` only; 1.4.1's `recordDiscoveryAdmissions` adds
            // `'short'` entries that promote to `'full'` on first
            // successful invocation. Default to `'full'` for back-compat.
            // Cost differs by form: short admissions pay `short_cost`
            // (~50 tokens) instead of `cost_estimate` (~200-800).
            const form = rec.form === 'short' ? 'short' : 'full';
            const cost = form === 'short'
                ? (typeof td.metadata.short_cost === 'number' ? td.metadata.short_cost : td.metadata.cost_estimate)
                : td.metadata.cost_estimate;
            if (tokensUsed + cost > budget) {
                suppressed.push({
                    tool_id: td.id,
                    reason: 'over_budget',
                    detail: `cost=${cost}, used=${tokensUsed}, budget=${budget}, form=${form}`,
                });
                continue;
            }

            admitted.push({
                tool_id: td.id,
                form,
                rendered: JSON.stringify(toOpenAIShape(td, form)),
                source: 'sticky',
            });
            admittedIds.add(td.id);
            tokensUsed += cost;
            stickyAdmitted++;
        }
    }

    /** @type {ToolDiagnostics} */
    const diagnostics = {
        static_admitted: staticCount,
        sticky_admitted: stickyAdmitted,
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
        out.push(toOpenAIShape(td, a.form));
    }
    return out;
}

export const _testing = {
    isAuthorized,
    toOpenAIShape,
};
