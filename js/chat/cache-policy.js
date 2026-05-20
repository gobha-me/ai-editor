// @ts-check
/**
 * Cache policy lookups that union the legacy hand-list
 * (`STATEFUL_READ_TOOLS` in `./tool-classifications.js`) with the
 * registry-driven `cache: 'never'` set introduced at 2.71.0 (gitea#472).
 *
 * Lives in its own module — separate from `tool-classifications.js` —
 * so the classification arrays stay pure-data and importable under
 * `node --test` with no browser shim. This module pulls in
 * `tools/registry.js` (which transitively pulls `core.js`), so any test
 * that needs `isStatefulRead` or `getStatefulReadToolsLive` must
 * `import './_node-shim.mjs'` first.
 *
 * @module chat/cache-policy
 */

import { STATEFUL_READ_TOOLS } from './tool-classifications.js';
import { ToolRegistry } from '../tools/registry.js';

/**
 * True iff `toolName` should bypass both dup-caches (same-request
 * `toolCallCache` and cross-request `toolActionLog`). Unions the legacy
 * `STATEFUL_READ_TOOLS` hand-list with the registry-driven
 * `cache: 'never'` set. New aggregating reads / state-dependent reads
 * declare `cache: 'never'` at their `ToolRegistry.register()` call site;
 * this helper picks them up automatically without anyone editing the
 * legacy const.
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function isStatefulRead(toolName) {
    if (STATEFUL_READ_TOOLS.includes(toolName)) return true;
    return ToolRegistry?.getCacheClass?.(toolName) === 'never';
}

/**
 * Live view of names that bypass dup-caches — unions the legacy const
 * with the registry-driven set. Computed on each access (the registry
 * is mutable via MCP bridge un/register; the cost is bounded by
 * `ToolRegistry.definitions.length`, well under the per-request tool
 * budget).
 *
 * Used by `tool-loop-core.js#buildToolActionLogEntry` to gate the
 * cross-request `result` persistence — entries for never-cached tools
 * carry only `resultSummary`, not the full payload.
 *
 * @returns {string[]}
 */
export function getStatefulReadToolsLive() {
    const fromRegistry = ToolRegistry?.definitions
        ? ToolRegistry.definitions
            .filter(d => d?.cache === 'never')
            .map(d => d?.function?.name)
            .filter(Boolean)
        : [];
    return Array.from(new Set([...STATEFUL_READ_TOOLS, ...fromRegistry]));
}
