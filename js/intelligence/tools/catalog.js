// @ts-check
/**
 * Tool Catalog — read-only adapter over `js/tools/registry.js`.
 *
 * The Catalog is the registry of all `ToolDef`s available to a profile.
 * In the target architecture (DESIGN-tools.md §"The Tool Catalog") the
 * catalog is shared infrastructure backed by the same vector store as
 * retrieval. For Phase 1 / 1.3.4 it is a thin synchronous adapter over
 * the existing registry: every `ToolRegistry.register(...)` call becomes
 * one `ToolDef` here, derived on demand.
 *
 * Why an adapter and not a rewrite: the existing registry is the source
 * of truth for tool *handlers* (the executable plumbing). The admission
 * subsystem only cares about *definitions*. Wrapping rather than replacing
 * keeps PR 1 non-load-bearing — delete `js/intelligence/tools/` and the
 * editor still works exactly as today.
 *
 * Subsequent PRs (the Composer in PR 2, meta-tools in PR 3, sticky
 * admission in PR 4) consume this catalog. Nothing else does in 1.3.4.
 *
 * @module intelligence/tools/catalog
 */

import { ToolRegistry } from '../../tools/registry.js';
import { computeToolID } from './tool-id.js';
import { SIDE_EFFECTS_BY_NAME, getSideEffectByName } from './side-effects.js';

/**
 * @typedef {import('./contracts.js').ToolDef} ToolDef
 * @typedef {import('./contracts.js').ToolID} ToolID
 * @typedef {import('./contracts.js').ToolMetadata} ToolMetadata
 * @typedef {import('./contracts.js').AuthSpec} AuthSpec
 * @typedef {import('./contracts.js').SideEffectClass} SideEffectClass
 */

const PROFILE_NAMESPACE = 'coder';
const TOOL_VERSION = '1';

/**
 * Category mapping for the ~52 currently-registered tools. Categories use
 * dot-notation so the categorical-discovery strategy can navigate a tree
 * without a separate tree representation (DESIGN-tools.md §"Core
 * Contracts" line 155).
 *
 * Tools not listed here fall back to `"misc"` — better to surface a
 * gap than to misclassify silently.
 *
 * The categories mirror DESIGN-tools.md's §"Worked Example" and the
 * roadmap's static-set carve-out (`code.file.read`, `code.git.commit`).
 *
 * @type {Object.<string, string>}
 */
const CATEGORY_BY_NAME = {
    // meta — discovery interface (1.3.16; ROADMAP §1.3.16, DESIGN-tools.md §"Meta-Tools").
    'list_tool_categories':   'meta',
    'list_tools_by_category': 'meta',
    'find_tool':              'meta',

    // introspection — self-introspection Phase 1 (2.90.0, gitea#504)
    // + Phase 2 (2.92.0, gitea#506: runtime state + telemetry readers).
    'list_conversations':     'introspection',
    'read_chat_history':      'introspection',
    'search_chat_history':    'introspection',
    'get_active_profile':     'introspection',
    'list_loaded_tools':      'introspection',
    'get_budget_state':       'introspection',
    'get_token_usage':        'introspection',
    'get_retrieval_stats':    'introspection',
    'get_recent_errors':      'introspection',

    // code.file
    'read_file': 'code.file.read',
    'read_lines': 'code.file.read',
    'read_current_file': 'code.file.read',
    'read_function': 'code.file.read',
    'open_file': 'code.file.navigate',
    'list_open_tabs': 'code.file.navigate',
    'create_file': 'code.file.write',
    'delete_file': 'code.file.write',
    'write_file': 'code.file.write',
    'edit_file': 'code.file.edit',
    'replace_lines': 'code.file.edit',
    'insert_lines': 'code.file.edit',
    'delete_lines': 'code.file.edit',
    'replace_selection': 'code.file.edit',
    'insert_at_cursor': 'code.file.edit',

    // code.scan
    'scan_file': 'code.scan',
    'find_references': 'code.scan',
    'search_in_files': 'code.scan',

    // code.cursor
    'goto_line': 'code.cursor',
    'select_range': 'code.cursor',

    // code.project
    'list_projects': 'code.project',
    'set_active_project': 'code.project',
    'get_project_tree': 'code.project',
    'peek_project_tree': 'code.project.xref',
    'peek_project_file': 'code.project.xref',
    'peek_read_lines': 'code.project.xref',

    // code.git
    'commit_files': 'code.git.commit',
    'list_dirty_files': 'code.git.status',

    // code.git.pr
    'create_pull_request': 'code.git.pr',
    'list_pull_requests': 'code.git.pr',
    'read_pull_request': 'code.git.pr',
    'add_pr_review': 'code.git.pr',
    'merge_pull_request': 'code.git.pr',
    'get_ci_status': 'code.git.ci',
    'get_ci_logs': 'code.git.ci',
    'wait_for_ci': 'code.git.ci',

    // code.issue
    'list_issues': 'code.issue',
    'read_issue': 'code.issue',
    'create_issue': 'code.issue',
    'update_issue': 'code.issue',
    'add_issue_comment': 'code.issue',

    // code.context (retrieval bridge)
    'find_relevant_files': 'code.context',
    'get_embeddings_status': 'code.context',
    'index_project': 'code.context',

    // memory
    'memory_remember': 'memory',
    'memory_recall': 'memory',
    'memory_revise': 'memory',

    // scratchpad (session-scoped memory)
    'scratchpad_write': 'scratchpad',
    'scratchpad_read': 'scratchpad',
    'scratchpad_clear': 'scratchpad',

    // interaction (user-facing prompts)
    'ask_user': 'interaction',

    // plan (Plan Mode artifacts — github#25 + gitea#424, 2.52.0)
    'submit_plan_for_approval': 'plan',
    'read_approved_plan':       'plan',

    // plugin
    'read_plugin_source': 'plugin',
    'write_plugin_source': 'plugin',
    'run_plugin': 'plugin',
    'list_user_plugins': 'plugin',

    // docs
    'read_docs': 'docs',

    // eval
    'run_code': 'eval',
};

// 2.76.0 (gitea#480) — `SIDE_EFFECTS_BY_NAME` + lookup lifted to
// `./side-effects.js` so the tool-registry dispatch gate can read the
// same classification without forming an import cycle (catalog.js itself
// depends on `ToolRegistry.getDefinitions`). `getSideEffectByName` below
// is the single lookup; the table itself is re-imported above for
// test-seam access only.

/**
 * One-line descriptions for each category, used by the `list_tool_categories`
 * meta-tool (1.3.16). Parallel to `CATEGORY_BY_NAME`. A category with no
 * entry surfaces an empty `description: ''` at lookup — surfaces the gap
 * honestly rather than fabricating a label.
 *
 * @type {Object.<string, string>}
 */
const CATEGORY_DESCRIPTIONS = {
    'meta':              'Discovery: enumerate tools and find capabilities by description.',
    'introspection':     'Self-introspection — chat history (list/read/search), active profile, loaded tools, budget posture, token usage, retrieval index, recent errors.',
    'code.file.read':    'Read-only file access (full files, line ranges, current buffer).',
    'code.file.navigate':'Open files in the editor and inspect open tabs.',
    'code.file.write':   'Create, overwrite, or delete entire files.',
    'code.file.edit':    'In-place edits — replace, insert, or delete lines or selection.',
    'code.scan':         'Read-only structural scans: symbols, references, project text search.',
    'code.cursor':       'Move the editor cursor or change the selection.',
    'code.project':      'Project-tree introspection and active-project switching.',
    'code.project.xref': 'Cross-project peeks — read trees and files outside the active project.',
    'code.git.commit':   'Commit staged file changes to the active branch.',
    'code.git.status':   'Read uncommitted file state.',
    'code.git.pr':       'Pull-request lifecycle: create, list, review, merge.',
    'code.git.ci':       'CI status and log retrieval.',
    'code.issue':        'Issue tracker CRUD (provider-backed).',
    'code.context':      'Retrieval bridge — semantic file relevance and project indexing.',
    'memory':            'Long-term curated facts (cross-session, scoped).',
    'scratchpad':        'Session-scoped key-value notes (cleared per task).',
    'interaction':       'Pause and ask the user — structured questions, choices, free-text.',
    'plan':              'Plan Mode artifacts — submit a plan for approval, read back the approved plan during execution.',
    'plugin':            'Plugin source read/write and runtime invocation.',
    'docs':              'Read project / app documentation.',
    'eval':              'Execute code in a sandboxed runner.',
    'misc':              'Uncategorized — fallback bucket.',
};

/**
 * Approximate token count for a serializable object. Mirrors the
 * `CHARS_PER_TOKEN = 4` heuristic used by
 * `js/intelligence/compression/tokens.js`. Exact counts arrive when a
 * `tiktoken`-equivalent module lands.
 *
 * @param {unknown} obj
 * @returns {number}
 */
function approxTokens(obj) {
    if (obj == null) return 0;
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * Derive a category for a tool whose name is not in `CATEGORY_BY_NAME`.
 * Falls back to `"misc"` so a missing entry is visible to operators
 * rather than silently misfiled under an existing category.
 *
 * @param {string} name
 * @returns {string}
 */
function deriveCategory(name) {
    if (name in CATEGORY_BY_NAME) return CATEGORY_BY_NAME[name];
    return 'misc';
}

/**
 * Build a `ToolDef` from one entry in `ToolRegistry.definitions`.
 * Pure derivation — no IO, no mutation of the source registry.
 *
 * @param {Object} def  Entry from `ToolRegistry.getDefinitions()`.
 * @returns {ToolDef|null}
 */
function defToToolDef(def) {
    const fn = def && def.function;
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return null;

    const name = fn.name;
    const description = typeof fn.description === 'string' ? fn.description : '';
    const schema = fn.parameters || { type: 'object', properties: {} };

    // 2.54.0 (gitea#438) — admission inverted from tool-side `roles:`
    // tags to profile-side `tools.admit` name lists. The catalog no
    // longer derives per-tool `required_groups` from `_registeredRoles`
    // (that field is gone); the authorization filter at
    // `composer.js#isAuthorized` becomes a no-op and the chat loop's
    // profile-side `Profiles.filterTools` is the sole admission gate.
    // The empty `required_groups` array is preserved for downstream
    // shape compatibility (some debug surfaces read it); future
    // gitea#440 / Phase 4 work may retire it entirely.
    /** @type {AuthSpec} */
    const authorization = {
        required_groups: [],
        required_consent: false,
        rate_limit: null,
    };

    const short_cost = approxTokens(`${name}: ${description}`);
    const cost_estimate = short_cost + approxTokens(schema);

    /** @type {ToolMetadata} */
    const metadata = {
        version: TOOL_VERSION,
        authorization,
        side_effects: getSideEffectByName(name),
        cost_estimate,
        short_cost,
        examples: null,
        deprecated: false,
        superseded_by: null,
    };

    // Registration-time category override (1.4.2). MCP-bridged tools know
    // their category at registration (e.g. `mcp.<serverId>`); the
    // `CATEGORY_BY_NAME` map only knows the static catalog. Prefer the
    // declared category when present, fall back to the lookup otherwise.
    const category = typeof def.category === 'string' && def.category.length > 0
        ? def.category
        : deriveCategory(name);

    return {
        id: computeToolID(PROFILE_NAMESPACE, name, TOOL_VERSION),
        name,
        category,
        description,
        schema,
        full_doc: '',
        embedding: null,
        metadata,
    };
}

/**
 * Produce the current snapshot of all `ToolDef`s. Built on each call
 * because the registry is mutable (plugins can register tools at any
 * time). The set is small enough (~52 tools) that re-deriving is cheap
 * and avoids cache-invalidation footguns.
 *
 * @returns {ToolDef[]}
 */
function buildAll() {
    const defs = ToolRegistry.getDefinitions();
    /** @type {ToolDef[]} */
    const out = [];
    for (const def of defs) {
        const td = defToToolDef(def);
        if (td) out.push(td);
    }
    return out;
}

/**
 * Look up a tool by deterministic ToolID. Returns null when the ID
 * doesn't resolve in the current registry — callers should treat this
 * as "tool was migrated or removed" and fall back to audit metadata,
 * not crash.
 *
 * @param {ToolID} id
 * @returns {ToolDef|null}
 */
function getById(id) {
    const all = buildAll();
    for (const td of all) {
        if (td.id === id) return td;
    }
    return null;
}

/**
 * Look up a tool by canonical name. Null when the name isn't registered
 * — used by `coder.v1.tools.static` resolution: a name in the static
 * array that doesn't yet exist in the registry (e.g. the meta-tools in
 * 1.3.4, before PR 3 adds them) simply returns null and the consumer
 * skips it.
 *
 * @param {string} name
 * @returns {ToolDef|null}
 */
function getByName(name) {
    const all = buildAll();
    for (const td of all) {
        if (td.name === name) return td;
    }
    return null;
}

/**
 * List tools whose category begins with `prefix` (dot-segment aware).
 * `"code.git"` matches `"code.git.commit"` and `"code.git.pr"` but not
 * `"code.gitsomething"`.
 *
 * @param {string} prefix
 * @returns {ToolDef[]}
 */
function listByCategoryPrefix(prefix) {
    if (typeof prefix !== 'string') return [];
    const all = buildAll();
    if (prefix === '') return all;
    return all.filter(td => td.category === prefix || td.category.startsWith(prefix + '.'));
}

/**
 * List every `ToolDef` in the catalog (one per registered tool).
 *
 * @returns {ToolDef[]}
 */
function listAll() {
    return buildAll();
}

/**
 * Aggregate the catalog by category. One entry per unique category seen
 * across registered tools, with `tool_count` and a 1-line description from
 * `CATEGORY_DESCRIPTIONS`. Categories absent from the description map yield
 * an empty `description` — surfaces a gap to the operator rather than
 * crashing the discovery flow.
 *
 * The `list_tool_categories` meta-tool (1.3.16) is a thin wrapper over this.
 *
 * @returns {import('./contracts.js').CategoryInfo[]}
 */
function listCategories() {
    const all = buildAll();
    const counts = new Map();
    for (const td of all) {
        counts.set(td.category, (counts.get(td.category) || 0) + 1);
    }
    /** @type {import('./contracts.js').CategoryInfo[]} */
    const out = [];
    for (const [category, tool_count] of counts.entries()) {
        out.push({
            category,
            description: CATEGORY_DESCRIPTIONS[category] || '',
            tool_count,
        });
    }
    out.sort((a, b) => a.category.localeCompare(b.category));
    return out;
}

/**
 * Project a `ToolDef` to the cheap, schema-less `ToolSummary` shape returned
 * by every meta-tool (1.3.16). Dual of `defToToolDef` — same input, lighter
 * output, no `schema`/`full_doc`/`metadata` blob.
 *
 * @param {ToolDef} td
 * @returns {import('./contracts.js').ToolSummary}
 */
function defToToolSummary(td) {
    return {
        tool_id: td.id,
        name: td.name,
        description: td.description,
        short_cost: td.metadata.short_cost,
        full_cost: td.metadata.cost_estimate,
        category: td.category,
        side_effects: td.metadata.side_effects,
    };
}

/**
 * Resolve a tool's deterministic ID from its canonical registry name.
 * Pure function — does not consult the live registry — so it works for
 * tools that were already unregistered (the listener path that drops
 * stale embeddings on `tools:unregistered`).
 *
 * @param {string} name
 * @returns {ToolID}
 */
function toolNameToID(name) {
    return computeToolID(PROFILE_NAMESPACE, name, TOOL_VERSION);
}

export const Catalog = {
    getById,
    getByName,
    listByCategoryPrefix,
    listAll,
    listCategories,
    defToToolSummary,
    toolNameToID,
};

// Test seams — unit tests assert on derivation in isolation from the
// registry singleton. Not part of the public surface; underscore prefix
// signals "do not import from product code."
export const _testing = {
    defToToolDef,
    defToToolSummary,
    deriveCategory,
    // 2.76.0 (gitea#480) — `deriveSideEffects` lifted to `./side-effects.js`
    // and renamed `getSideEffectByName`. Re-exposed here under the legacy
    // name so existing unit tests don't have to chase the rename.
    deriveSideEffects: getSideEffectByName,
    SIDE_EFFECTS_BY_NAME,
    approxTokens,
    CATEGORY_DESCRIPTIONS,
    PROFILE_NAMESPACE,
    TOOL_VERSION,
};
