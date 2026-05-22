/**
 * Tests for js/tools/meta-tools.js + catalog extensions
 * (1.3.16 — PR 3 of the 1.4.0 Tools Phase 1 arc).
 *
 * Asserts the discovery handlers and the Composer-integration exit signal:
 *   - After registerMetaTools, each meta-tool resolves through the Catalog
 *     and lands in `category: 'meta'`.
 *   - `list_tool_categories` returns a sorted CategoryInfo[] with counts.
 *   - `list_tools_by_category(prefix)` honors dot-segment prefix matching
 *     and projects each match through `defToToolSummary`.
 *   - `find_tool(query)` scores name/description/category substrings, caps
 *     output at K=8, and rejects empty input.
 *   - **Exit-criteria signal:** with the static set fully registered,
 *     `composeAdmission(coder.v1.tools.static)` returns
 *     `unresolved_static: []` and admits the full static set.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog, composeAdmission } from '../js/intelligence/tools/index.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { registerMetaTools } from '../js/tools/meta-tools.js';

// ============================================
// Fixture — register meta-tools + the six other coder.v1 essentials.
// ============================================

const META_NAMES = ['list_tool_categories', 'list_tools_by_category', 'find_tool'];
const FULL_USER_GROUPS = ['full'];

function registerStaticFixture() {
    ToolRegistry.clear();
    registerMetaTools(ToolRegistry);
    const reg = (name, description, parameters = { type: 'object', properties: {} }, roles = 'all') =>
        ToolRegistry.register(name, async () => ({}), {
            function: { name, description, parameters }, roles,
        });
    reg('read_file',        'Read the full content of a file.',     { type: 'object', properties: { path: { type: 'string' } } });
    reg('read_lines',       'Read a line range from a file.',       { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } });
    reg('scan_file',        'Scan a file for top-level symbols.',   { type: 'object', properties: { path: { type: 'string' } } });
    reg('edit_file',        'Edit a file in place.',                { type: 'object', properties: { path: { type: 'string' } } }, ['coder']);
    reg('commit_files',     'Commit staged files to the branch.',   { type: 'object', properties: { message: { type: 'string' } } }, ['coder']);
    reg('list_dirty_files', 'List uncommitted files.',              { type: 'object', properties: {} });
    // 1.4.5 CI tools (added to the static set alongside the test-driven loop)
    reg('get_ci_status',    'Fetch CI status for a ref.',           { type: 'object', properties: { ref: { type: 'string' } } }, ['coder']);
    reg('wait_for_ci',      'Poll CI until terminal state.',        { type: 'object', properties: { ref: { type: 'string' } } }, ['coder']);
    reg('get_ci_logs',      'Fetch a CI job log tail.',             { type: 'object', properties: { ref: { type: 'string' } } }, ['coder']);
    // 1.8.4 — structural-anchor tools promoted to static (github#34
    // sibling fix). The exit-criteria assertion below
    // (`unresolved_static: []`) requires every name in
    // CODER_V1.tools.static to resolve through the catalog, so this
    // fixture must register them too.
    reg('scratchpad_write', 'Write a note to the scratchpad.',      { type: 'object', properties: { key: { type: 'string' }, content: { type: 'string' } } });
    reg('scratchpad_read',  'Read from the scratchpad.',            { type: 'object', properties: { key: { type: 'string' } } });
    reg('scratchpad_clear', 'Clear scratchpad entries.',            { type: 'object', properties: { key: { type: 'string' } } });
    reg('todo_write',       'Replace the conversation todo list.',  { type: 'object', properties: { todos: { type: 'array' } } });
    reg('todo_read',        'Read the conversation todo list.',     { type: 'object', properties: {} });
    // 1.9.0 — `ask_user` (github#33 Phase 1) joined the static set
    // for the same compression-survival reason as scratchpad/todo.
    reg('ask_user',         'Ask the user a structured question.',  { type: 'object', properties: { question: { type: 'string' }, type: { type: 'string' } } });
    // 1.10.0 — `submit_plan_for_approval` (github#25) joined the
    // static set as the always-admitted approval gate for Plan Mode.
    reg('submit_plan_for_approval', 'Submit an implementation plan for user approval.', { type: 'object', properties: { plan: { type: 'string' } } });
    // 1.16.0 — `submit_script_for_approval` (LLM-authored automation
    // Phase 1) joined the static set; the runtime filter in
    // `js/llm/api.js` controls whether it's admitted to the per-turn
    // tool list. Static enumeration must still resolve it through the
    // catalog so the unresolved_static exit signal stays clean.
    reg('submit_script_for_approval', 'Submit a JS script for user approval and sandboxed run.', { type: 'object', properties: { source: { type: 'string' }, description: { type: 'string' }, expected_output: { type: 'string' } } });
    // 1.22.0 — preview tools (DESIGN-preview.md Tier 1) joined the
    // coder static set. Same compression-survival rationale as the
    // 1.16.0 script tool: static enumeration must resolve them through
    // the catalog so the unresolved_static exit signal stays clean.
    reg('preview_start',    'Start a sandboxed preview iframe.',    { type: 'object', properties: { path: { type: 'string' } } });
    reg('preview_stop',     'Stop a running preview server.',       { type: 'object', properties: { serverId: { type: 'string' } } });
    reg('preview_list',     'List running preview servers.',        { type: 'object', properties: {} });
    // 2.7.0 — Tier 2 capture readers joined the coder static set; same
    // compression-survival rationale.
    reg('preview_console_logs', 'Read captured console.* output from a preview.', { type: 'object', properties: { serverId: { type: 'string' } } });
    reg('preview_errors',       'Read captured uncaught errors from a preview.',   { type: 'object', properties: { serverId: { type: 'string' } } });
    reg('preview_logs',         'Read SW route stages for a preview.',             { type: 'object', properties: { serverId: { type: 'string' } } });
    reg('preview_network',      'List finished workspace fetches for a preview.',  { type: 'object', properties: { serverId: { type: 'string' } } });
    // 2.10.0 — Tier 3a driveable preview tools joined the coder static set;
    // same compression-survival rationale.
    reg('preview_snapshot', 'Snapshot the live DOM in a preview.',  { type: 'object', properties: { serverId: { type: 'string' } } });
    reg('preview_click',    'Click an element in a preview.',       { type: 'object', properties: { serverId: { type: 'string' }, selector: { type: 'string' } } });
    reg('preview_fill',     'Fill a form field in a preview.',      { type: 'object', properties: { serverId: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } } });
    reg('preview_inspect',  'Inspect computed style of an element.', { type: 'object', properties: { serverId: { type: 'string' }, selector: { type: 'string' } } });
    reg('preview_resize',   'Resize the preview iframe element.',   { type: 'object', properties: { serverId: { type: 'string' } } });
    // 2.49.0 — `delegate_task` (sub-agents Phase 1 slice 2) joined the
    // coder static set; the runtime filter in `js/llm/api.js`
    // (`applySubAgentToolFilter`) controls whether it's admitted to the
    // per-turn tool list. Static enumeration must still resolve it
    // through the catalog so the unresolved_static exit signal stays clean.
    reg('delegate_task', 'Delegate a focused sub-task to a bounded child sub-agent.', { type: 'object', properties: { task: { type: 'string' }, context_hint: { type: 'string' } } });
    // 2.90.0 — introspection Phase 1 (gitea#504) joined the coder static
    // set alongside the meta-tools; structural anchor for fresh-context
    // spawns under the 3.X amendment direction. Static enumeration must
    // resolve them through the catalog so the unresolved_static exit
    // signal stays clean.
    reg('list_conversations',  'List chat conversations.',                { type: 'object', properties: {} });
    reg('read_chat_history',   'Read a slice of chat-history messages.',  { type: 'object', properties: { conversation_id: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } });
    reg('search_chat_history', 'Search chat-history by keyword.',         { type: 'object', properties: { query: { type: 'string' }, conversation_id: { type: 'string' }, max_hits: { type: 'number' } } });
    // 2.92.0 — introspection Phase 2 (gitea#506) joined the coder static
    // set alongside Phase 1; runtime state + telemetry readers, same
    // structural-anchor rationale. Static enumeration must resolve them
    // through the catalog so the unresolved_static exit signal stays clean.
    reg('get_active_profile',  'Read the currently-active profile shape.', { type: 'object', properties: {} });
    reg('list_loaded_tools',   'Enumerate every tool currently registered on the runtime.', { type: 'object', properties: {} });
    reg('get_budget_state',    'Estimate of the current context budget posture.', { type: 'object', properties: {} });
    reg('get_token_usage',     'Token + cost telemetry across three lenses.', { type: 'object', properties: { scope: { type: 'string' } } });
    reg('get_retrieval_stats', 'Snapshot of the retrieval subsystem.',     { type: 'object', properties: {} });
    reg('get_recent_errors',   'Read up to 50 most-recent errors from the global ring.', { type: 'object', properties: { limit: { type: 'number' } } });
}

// ============================================
// Catalog resolution — meta-tools are first-class catalog citizens
// ============================================

test('after registerMetaTools, each meta-tool resolves via Catalog.getByName()', () => {
    registerStaticFixture();
    for (const name of META_NAMES) {
        const td = Catalog.getByName(name);
        assert.ok(td, `Catalog.getByName(${name}) should resolve`);
        assert.equal(td.name, name);
    }
});

test('meta-tools land in category: "meta"', () => {
    registerStaticFixture();
    for (const name of META_NAMES) {
        const td = Catalog.getByName(name);
        assert.equal(td.category, 'meta', `${name} should be category meta`);
    }
});

test('meta-tools have side_effects: "read"', () => {
    registerStaticFixture();
    for (const name of META_NAMES) {
        const td = Catalog.getByName(name);
        assert.equal(td.metadata.side_effects, 'read');
    }
});

// ============================================
// list_tool_categories — handler shape
// ============================================

test('list_tool_categories returns {categories: CategoryInfo[]}', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tool_categories', {});
    assert.ok(Array.isArray(result.categories), 'should return categories array');
    assert.ok(result.categories.length >= 1);
    for (const c of result.categories) {
        assert.equal(typeof c.category, 'string');
        assert.equal(typeof c.description, 'string');
        assert.equal(typeof c.tool_count, 'number');
        assert.ok(c.tool_count >= 1);
    }
});

test('list_tool_categories includes "meta" with tool_count >= 3', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tool_categories', {});
    const meta = result.categories.find(c => c.category === 'meta');
    assert.ok(meta, 'should include meta category');
    assert.ok(meta.tool_count >= 3, 'meta should have 3+ tools (the meta-tools themselves)');
    assert.ok(meta.description.length > 0, 'meta should have a description');
});

test('list_tool_categories returns categories sorted alphabetically', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tool_categories', {});
    const cats = result.categories.map(c => c.category);
    const sorted = [...cats].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(cats, sorted);
});

// ============================================
// list_tools_by_category — prefix matching + ToolSummary shape
// ============================================

test('list_tools_by_category("code.file.read") returns the registered read tools', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tools_by_category', { category: 'code.file.read' });
    const names = result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['read_file', 'read_lines']);
    assert.equal(result.count, 2);
    assert.equal(result.category, 'code.file.read');
});

test('list_tools_by_category("code.file") returns all file-area tools (prefix is dot-segment aware)', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tools_by_category', { category: 'code.file' });
    const names = result.tools.map(t => t.name).sort();
    // code.file.read (read_file, read_lines) + code.file.edit (edit_file)
    assert.deepEqual(names, ['edit_file', 'read_file', 'read_lines']);
    assert.equal(result.count, 3);
});

test('list_tools_by_category returns ToolSummary shape per entry', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tools_by_category', { category: 'meta' });
    assert.ok(result.tools.length >= 3);
    for (const ts of result.tools) {
        assert.equal(typeof ts.tool_id, 'string');
        assert.equal(typeof ts.name, 'string');
        assert.equal(typeof ts.description, 'string');
        assert.equal(typeof ts.short_cost, 'number');
        assert.equal(typeof ts.full_cost, 'number');
        assert.equal(typeof ts.category, 'string');
        assert.equal(typeof ts.side_effects, 'string');
    }
});

test('list_tools_by_category("") returns {error}', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('list_tools_by_category', { category: '' });
    assert.ok(result.error, 'empty category should produce an error');
    assert.match(result.error, /required/);
});

test('list_tools_by_category prefix is dot-segment aware', async () => {
    registerStaticFixture();
    // 'code.file' must NOT match 'code.scan' even though both start with 'code'.
    const result = await ToolRegistry.execute('list_tools_by_category', { category: 'code.file' });
    for (const t of result.tools) {
        assert.ok(
            t.category === 'code.file' || t.category.startsWith('code.file.'),
            `prefix matching should reject ${t.category}`
        );
    }
});

// ============================================
// find_tool — scoring + cap + error path + self-discovery
// ============================================

test('find_tool("read") ranks read_file in top 3', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('find_tool', { description: 'read' });
    const top3 = result.tools.slice(0, 3).map(t => t.name);
    assert.ok(top3.includes('read_file'), `read_file should be in top 3, got ${top3.join(', ')}`);
});

test('find_tool("list categories") ranks list_tool_categories first', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('find_tool', { description: 'list categories' });
    assert.ok(result.tools.length > 0);
    assert.equal(result.tools[0].name, 'list_tool_categories');
});

test('find_tool("") returns {error}', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('find_tool', { description: '' });
    assert.ok(result.error, 'empty description should produce an error');
    assert.match(result.error, /required/);
});

test('find_tool caps results at K=8', async () => {
    ToolRegistry.clear();
    registerMetaTools(ToolRegistry);
    // Register 12 fixture tools all matching the keyword "doit".
    for (let i = 0; i < 12; i++) {
        ToolRegistry.register(`doit_${i}`, async () => ({}), {
            function: {
                name: `doit_${i}`,
                description: `tool ${i} that does it`,
                parameters: { type: 'object', properties: {} },
            },
            roles: 'all',
        });
    }
    const result = await ToolRegistry.execute('find_tool', { description: 'doit' });
    assert.equal(result.tools.length, 8, 'should cap at K=8');
    assert.equal(result.count, 8);
});

test('find_tool("discover") returns find_tool itself (meta-tools live in their own catalog)', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('find_tool', { description: 'discover capabilities' });
    const names = result.tools.map(t => t.name);
    // 'find_tool' description contains "Find tools whose..." — "find" matches via name+desc.
    // 'list_tool_categories' description contains "discover" → matches via description.
    assert.ok(
        names.includes('find_tool') || names.includes('list_tool_categories') || names.includes('list_tools_by_category'),
        `at least one meta-tool should self-discover, got ${names.join(', ')}`
    );
});

test('find_tool response carries a mode field (semantic|categorical)', async () => {
    registerStaticFixture();
    const result = await ToolRegistry.execute('find_tool', { description: 'read' });
    assert.equal(typeof result.mode, 'string');
    assert.ok(result.mode === 'semantic' || result.mode === 'categorical',
        `expected mode ∈ {semantic, categorical}, got ${result.mode}`);
});

// ============================================
// Composer integration — closes the unresolved_static gap (the exit signal)
// ============================================

test('coder.v1 admission: unresolved_static is empty after meta-tools register', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'coder-session',
        query: null,
        budget_tokens: CODER_V1.tools.budget_tokens,
        profile_static: CODER_V1.tools.static,
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: CODER_V1.tools.expansion_mode,
    });
    assert.deepEqual(result.diagnostics.unresolved_static, [], 'no unresolved names after 1.3.16');
});

test('coder.v1 admission: admitted.length matches static set length', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'coder-session',
        query: null,
        budget_tokens: CODER_V1.tools.budget_tokens,
        profile_static: CODER_V1.tools.static,
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: CODER_V1.tools.expansion_mode,
    });
    // Pin to the source so future static-set additions don't drift past a magic number.
    assert.equal(result.admitted.length, CODER_V1.tools.static.length);
});

test('coder.v1 admission: tokens_used stays within budget_tokens', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'coder-session',
        query: null,
        budget_tokens: CODER_V1.tools.budget_tokens,
        profile_static: CODER_V1.tools.static,
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: CODER_V1.tools.expansion_mode,
    });
    assert.ok(
        result.tokens_used <= CODER_V1.tools.budget_tokens,
        `tokens_used ${result.tokens_used} must be <= budget ${CODER_V1.tools.budget_tokens}`
    );
});
