// @ts-check
/**
 * AI Editor — Meta-tools (PR 3 of the 1.4.0 Tools Phase 1 arc).
 *
 * Three discovery handlers that let the model navigate the catalog without
 * having every tool definition loaded into the prompt:
 *
 *   - list_tool_categories()             → CategoryInfo[]
 *   - list_tools_by_category(category)   → ToolSummary[]
 *   - find_tool(description)             → ToolSummary[]
 *
 * The names have been declared in `coder.v1.tools.static` since 1.3.4, where
 * they sat in `diagnostics.unresolved_static[]` because the handlers didn't
 * exist yet. After 1.3.16, the Composer admits all 9/9 static names.
 *
 * `find_tool` is **categorical/text scoring only** in 1.3.16; semantic
 * matching arrives in 1.4.1 per ROADMAP §1.4.1.
 *
 * Authorization: all three handlers register with `roles: 'all'`. Discovery
 * is read-only introspection; gating it by role would only confuse a `pm`
 * user about what's in the session. The existing `ToolRegistry.checkRoleAccess()`
 * still blocks invocation downstream — so a `pm` user can *see* `commit_files`
 * but won't be allowed to *call* it.
 *
 * Sources:
 *   - `docs/DESIGN-tools.md` §"Meta-Tools" (lines 226–273)
 *   - `docs/ROADMAP.md` §1.3.16
 *
 * @module tools/meta-tools
 */

import { Catalog } from '../intelligence/tools/catalog.js';

/* -------------------------------------------------------------------------- */
/* find_tool — categorical/text scoring                                       */
/* -------------------------------------------------------------------------- */

const FIND_TOOL_K = 8;

/**
 * Score a `ToolDef` for a tokenized query. Higher is better.
 *
 * Weights are integers chosen so an exact-name hit dominates description
 * hits, which dominate category hits. Tie-break by `cost_estimate` ASC at
 * the call site (cheaper to admit wins among same-score matches).
 *
 * @param {import('../intelligence/tools/contracts.js').ToolDef} td
 * @param {string[]} terms  Lowercased ≥2-char tokens.
 * @returns {number}
 */
function _scoreToolForQuery(td, terms) {
    let score = 0;
    const name = td.name.toLowerCase();
    const desc = (td.description || '').toLowerCase();
    const cat  = td.category.toLowerCase();
    for (const t of terms) {
        if (name === t)            score += 100;
        else if (name.includes(t)) score += 30;
        if (desc.includes(t))      score += 10;
        if (cat.includes(t))       score += 5;
    }
    return score;
}

/* -------------------------------------------------------------------------- */
/* Tool registration                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Register the three meta-tools on the supplied registry. Idempotent only
 * across registry-clear/register cycles — calling twice on the same registry
 * will register duplicates (matches the pattern of every other `register*Tools`
 * factory in `js/tools/`).
 *
 * @param {Object} registry  ToolRegistry instance.
 */
export function registerMetaTools(registry) {

    /* ============================================================ */
    /* list_tool_categories                                         */
    /* ============================================================ */
    registry.register('list_tool_categories', async () => {
        return { categories: Catalog.listCategories() };
    }, {
        type: 'function',
        function: {
            name: 'list_tool_categories',
            description: 'Enumerate all tool categories with counts and 1-line descriptions. The cheapest discovery call — use this first when you need to figure out what kinds of tools are available. Returns {categories: CategoryInfo[]}; each entry has {category, description, tool_count}. Then call list_tools_by_category to drill into one.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
        roles: 'all',
    });

    /* ============================================================ */
    /* list_tools_by_category                                       */
    /* ============================================================ */
    registry.register('list_tools_by_category', async (args) => {
        const a = args || {};
        const category = typeof a.category === 'string' ? a.category : '';
        if (category.length === 0) {
            return {
                error: 'category is required (string). Call list_tool_categories first to see available categories.',
            };
        }
        const defs = Catalog.listByCategoryPrefix(category);
        return {
            category,
            count: defs.length,
            tools: defs.map(td => Catalog.defToToolSummary(td)),
        };
    }, {
        type: 'function',
        function: {
            name: 'list_tools_by_category',
            description: 'List every tool whose category starts with the given prefix (dot-segment aware: "code.git" matches "code.git.commit" and "code.git.pr" but not "code.gitsomething"). Returns ToolSummary[] — name, description, costs, category, side_effects — without the full schema. Use this after list_tool_categories to discover tools by area.',
            parameters: {
                type: 'object',
                properties: {
                    category: {
                        type: 'string',
                        description: 'Category or category prefix (e.g. "code.file", "code.git", "memory"). See list_tool_categories for valid values.',
                    },
                },
                required: ['category'],
            },
        },
        roles: 'all',
    });

    /* ============================================================ */
    /* find_tool                                                    */
    /* ============================================================ */
    registry.register('find_tool', async (args) => {
        const a = args || {};
        const description = typeof a.description === 'string' ? a.description.trim() : '';
        if (description.length === 0) {
            return {
                error: 'description is required (string). Describe the capability you need (e.g. "read a file", "create pull request").',
            };
        }
        const terms = description
            .toLowerCase()
            .split(/\s+/)
            .filter(t => t.length >= 2);
        if (terms.length === 0) {
            return {
                description,
                count: 0,
                tools: [],
                note: 'no scorable terms (need ≥2-char tokens); categorical/text match only in 1.3.16, semantic in 1.4.1',
            };
        }

        const all = Catalog.listAll();
        /** @type {{td: import('../intelligence/tools/contracts.js').ToolDef, score: number}[]} */
        const scored = [];
        for (const td of all) {
            const s = _scoreToolForQuery(td, terms);
            if (s > 0) scored.push({ td, score: s });
        }
        scored.sort((x, y) => (y.score - x.score) || (x.td.metadata.cost_estimate - y.td.metadata.cost_estimate));

        const top = scored.slice(0, FIND_TOOL_K).map(({ td }) => Catalog.defToToolSummary(td));
        return {
            description,
            count: top.length,
            tools: top,
            note: 'categorical/text match only; semantic search ships in 1.4.1',
        };
    }, {
        type: 'function',
        function: {
            name: 'find_tool',
            description: 'Find tools whose name, description, or category match a freeform capability description. Returns up to 8 ToolSummary entries ranked by match strength. Categorical/text match in 1.3.16; semantic match in 1.4.1. Use this when you know what you want to do but not which tool name does it.',
            parameters: {
                type: 'object',
                properties: {
                    description: {
                        type: 'string',
                        description: 'Freeform capability description (e.g. "read a file", "open pull request", "remember a fact").',
                    },
                },
                required: ['description'],
            },
        },
        roles: 'all',
    });
}

// Test seams.
export const _testing = {
    _scoreToolForQuery,
    FIND_TOOL_K,
};
