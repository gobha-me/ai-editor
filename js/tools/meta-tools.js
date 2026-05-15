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
 * Authorization: discovery is read-only introspection. All three
 * handlers are listed in every picker profile's `tools.admit` array
 * (gitea#438) — gating discovery by profile would only confuse the
 * model about what's in the session. The existing
 * `ToolRegistry.checkRoleAccess()` still blocks *invocation* downstream
 * — so a `kb.v1` user's model can *see* `commit_files` via discovery
 * but won't be allowed to *call* it.
 *
 * Sources:
 *   - `docs/DESIGN-tools.md` §"Meta-Tools" (lines 226–273)
 *   - `docs/ROADMAP.md` §1.3.16
 *
 * @module tools/meta-tools
 */

import { Catalog } from '../intelligence/tools/catalog.js';
import { findToolsBySemantic, DEFAULT_TOP_K } from '../intelligence/tools/embeddings.js';

/* -------------------------------------------------------------------------- */
/* find_tool — semantic (1.4.1) with categorical fallback                     */
/* -------------------------------------------------------------------------- */

const FIND_TOOL_K = DEFAULT_TOP_K;

/**
 * Categorical scoring path — preserved verbatim from 1.3.16 as the
 * fallback when semantic ranking is unavailable (embeddings disabled,
 * embedder errored, no matches above threshold). Public so tests can
 * exercise it directly.
 *
 * @param {string} description
 * @param {import('../intelligence/tools/contracts.js').ToolDef[]} defs
 * @returns {Array<{td: import('../intelligence/tools/contracts.js').ToolDef, score: number}>}
 */
function _scoreCategorical(description, defs) {
    const terms = description
        .toLowerCase()
        .split(/\s+/)
        .filter(t => t.length >= 2);
    if (terms.length === 0) return [];
    const scored = [];
    for (const td of defs) {
        const s = _scoreToolForQuery(td, terms);
        if (s > 0) scored.push({ td, score: s });
    }
    scored.sort((x, y) => (y.score - x.score) || (x.td.metadata.cost_estimate - y.td.metadata.cost_estimate));
    return scored;
}

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
        readOnly: true,
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
        readOnly: true,
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

        const all = Catalog.listAll();

        // Semantic path first (k-NN over tool embeddings). Falls back to
        // categorical when embeddings are disabled, the embedder errored,
        // or nothing scored above the threshold.
        let mode = 'categorical';
        let note = '';
        let ranked = [];

        try {
            const sem = await findToolsBySemantic(description, all, { topK: FIND_TOOL_K });
            if (sem.mode === 'semantic' && sem.ranked.length > 0) {
                mode = 'semantic';
                note = 'semantic match (cosine ≥ threshold)';
                ranked = sem.ranked;
            } else if (sem.mode === 'disabled') {
                note = 'semantic disabled, categorical fallback';
            } else if (sem.mode === 'unavailable') {
                note = 'semantic unavailable (embeddings error); categorical fallback';
            } else {
                // semantic ran but returned 0 above threshold
                note = 'no semantic matches above threshold; categorical fallback';
            }
        } catch (e) {
            note = `semantic raised (${e?.message || e}); categorical fallback`;
        }

        if (mode !== 'semantic') {
            const cat = _scoreCategorical(description, all);
            ranked = cat.slice(0, FIND_TOOL_K);
            if (ranked.length === 0 && note === '') {
                note = 'no scorable terms (need ≥2-char tokens for categorical match)';
            }
        }

        const tools = ranked.map(({ td }) => Catalog.defToToolSummary(td));
        return {
            description,
            count: tools.length,
            tools,
            mode,
            note,
        };
    }, {
        type: 'function',
        function: {
            name: 'find_tool',
            description: 'Find tools whose name, description, or category match a freeform capability description. Returns up to 8 ToolSummary entries ranked by match strength. Semantic match (k-NN over embeddings) when available, with categorical fallback. Use this when you know what you want to do but not which tool name does it.',
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
        readOnly: true,
    });
}

// Test seams.
export const _testing = {
    _scoreToolForQuery,
    _scoreCategorical,
    FIND_TOOL_K,
};
