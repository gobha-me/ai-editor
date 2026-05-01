/**
 * Tests for js/intelligence/tools/composer.js + js/utils/tools-compose-flag.js
 * (1.3.14 — PR 2 of the 1.4.0 Tools Phase 1 arc).
 *
 * Asserts the admission consumer's behavior:
 *   - `composeAdmission` admits resolvable static names, skips unresolved
 *     ones (surfacing them in `diagnostics.unresolved_static`), filters by
 *     `user_groups`, and packs against `budget_tokens`.
 *   - `renderForLLM` returns the OpenAI tool-array shape and preserves
 *     declared order.
 *   - `LLMDebug.attachToolDiagnostics` mirrors the compression-diagnostics
 *     pin/stash split.
 *   - The URL flag `?toolsCompose=off` reads from `window.location.search`,
 *     caches on first call, and resets cleanly via `_resetCacheForTests`.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog, computeToolID, composeAdmission, renderForLLM } from '../js/intelligence/tools/index.js';
import { _testing as composerTesting } from '../js/intelligence/tools/composer.js';
import { _testing as catalogTesting } from '../js/intelligence/tools/catalog.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { createTaskLedger } from '../js/profiles/task-ledger.js';
import { LLMDebug } from '../js/llm/debug.js';
import { isToolsComposeDisabled, _resetCacheForTests as resetFlagCache } from '../js/utils/tools-compose-flag.js';

// ============================================
// Fixture — register the static set so static-resolution can be tested.
// ============================================

function registerStaticFixture() {
    ToolRegistry.clear();
    const reg = (name, description, parameters, roles = 'all') =>
        ToolRegistry.register(name, async () => ({}), {
            function: { name, description, parameters: parameters || { type: 'object', properties: {} } },
            roles,
        });
    // Six of nine names from coder.v1.tools.static. The three meta-tools
    // are intentionally absent so the unresolved branch is exercised.
    reg('read_file', 'Read the full content of a file.', { type: 'object', properties: { path: { type: 'string' } } });
    reg('read_lines', 'Read a line range.', { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } } });
    reg('scan_file', 'Scan a file for top-level symbols.', { type: 'object', properties: { path: { type: 'string' } } });
    reg('edit_file', 'Edit a file.', { type: 'object', properties: { path: { type: 'string' } } }, ['coder']);
    reg('commit_files', 'Commit staged files.', { type: 'object', properties: { message: { type: 'string' } } }, ['coder']);
    reg('list_dirty_files', 'List uncommitted files.', { type: 'object', properties: {} });
}

const CODER_USER_GROUPS = ['coder'];
const FULL_USER_GROUPS = ['full'];

// ============================================
// composeAdmission — admission semantics
// ============================================

test('composeAdmission admits all profile_static names that resolve', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit',
        query: null,
        budget_tokens: 100000,
        profile_static: ['read_file', 'read_lines', 'scan_file', 'edit_file', 'commit_files', 'list_dirty_files'],
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 6);
    const names = result.admitted.map(a => Catalog.getById(a.tool_id).name).sort();
    assert.deepEqual(names, ['commit_files', 'edit_file', 'list_dirty_files', 'read_file', 'read_lines', 'scan_file']);
});

test('composeAdmission skips unresolved names without throwing and lists them in unresolved_static', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit',
        query: null,
        budget_tokens: 100000,
        profile_static: ['list_tool_categories', 'find_tool', 'read_file'],
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 1);
    assert.equal(Catalog.getById(result.admitted[0].tool_id).name, 'read_file');
    assert.deepEqual(result.diagnostics.unresolved_static, ['list_tool_categories', 'find_tool']);
});

test('composeAdmission filters by user_groups against authorization.required_groups', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit',
        query: null,
        budget_tokens: 100000,
        // edit_file and commit_files require ['coder']; read_file is 'all'.
        profile_static: ['read_file', 'edit_file', 'commit_files'],
        task_ledger: null,
        user_groups: ['pm'],          // pm has none of those groups; only 'all'-tagged tool admits.
        discovery_call: null,
        expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 1);
    assert.equal(Catalog.getById(result.admitted[0].tool_id).name, 'read_file');
    assert.equal(result.suppressed.length, 2);
    for (const s of result.suppressed) {
        assert.equal(s.reason, 'unauthorized');
    }
});

test('composeAdmission with full user_groups bypasses required_groups gate', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit',
        query: null,
        budget_tokens: 100000,
        profile_static: ['read_file', 'edit_file', 'commit_files'],
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 3);
});

test('composeAdmission respects budget_tokens — over-budget tools land in suppressed', () => {
    registerStaticFixture();
    // First admit one tool to set an expected cost, then re-run with a
    // shrunken budget so the second tool overflows.
    const probe = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const firstCost = probe.tokens_used;
    assert.ok(firstCost > 0);

    const result = composeAdmission({
        task: 'unit', query: null,
        // Allow the first tool but not the second.
        budget_tokens: firstCost,
        profile_static: ['read_file', 'edit_file'],
        task_ledger: null,
        user_groups: FULL_USER_GROUPS,
        discovery_call: null,
        expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 1);
    assert.equal(Catalog.getById(result.admitted[0].tool_id).name, 'read_file');
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0].reason, 'over_budget');
});

test('composeAdmission with empty profile_static returns empty admitted, no error', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: [], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.deepEqual(result.admitted, []);
    assert.deepEqual(result.suppressed, []);
    assert.deepEqual(result.diagnostics.unresolved_static, []);
    assert.equal(result.tokens_used, 0);
});

test('composeAdmission stamps source:"static" on every admitted tool', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file', 'edit_file'],
        task_ledger: null, user_groups: FULL_USER_GROUPS,
        discovery_call: null, expansion_mode: 'full',
    });
    for (const a of result.admitted) {
        assert.equal(a.source, 'static');
        assert.equal(a.form, 'full', 'PR 2 always admits in full form (lazy expansion deferred)');
    }
});

test('composeAdmission tokens_used equals sum of admitted cost_estimate', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file', 'edit_file', 'commit_files'],
        task_ledger: null, user_groups: FULL_USER_GROUPS,
        discovery_call: null, expansion_mode: 'full',
    });
    let expected = 0;
    for (const a of result.admitted) {
        expected += Catalog.getById(a.tool_id).metadata.cost_estimate;
    }
    assert.equal(result.tokens_used, expected);
});

test('composeAdmission diagnostics counters match admitted/suppressed shapes', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file', 'list_tool_categories'],
        task_ledger: null, user_groups: FULL_USER_GROUPS,
        discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.diagnostics.static_admitted, result.admitted.length);
    assert.equal(result.diagnostics.sticky_admitted, 0);
    assert.equal(result.diagnostics.discovery_admitted, 0);
    assert.equal(result.diagnostics.suppressed, result.suppressed.length);
});

// ============================================
// renderForLLM — OpenAI shape compatibility
// ============================================

test('renderForLLM returns OpenAI tool-array shape compatible with chat handlers', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file', 'edit_file'],
        task_ledger: null, user_groups: FULL_USER_GROUPS,
        discovery_call: null, expansion_mode: 'full',
    });
    const rendered = renderForLLM(result);
    assert.equal(rendered.length, 2);
    for (const r of rendered) {
        assert.equal(r.type, 'function');
        assert.equal(typeof r.function.name, 'string');
        assert.equal(typeof r.function.description, 'string');
        assert.equal(typeof r.function.parameters, 'object');
    }
});

test('renderForLLM preserves declared order from admitted[]', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['edit_file', 'read_file', 'commit_files'],   // unusual order
        task_ledger: null, user_groups: FULL_USER_GROUPS,
        discovery_call: null, expansion_mode: 'full',
    });
    const rendered = renderForLLM(result);
    assert.deepEqual(rendered.map(r => r.function.name), ['edit_file', 'read_file', 'commit_files']);
});

// ============================================
// coder.v1 fixture — 12 names → 6 admitted, 6 unresolved
// (3 meta-tools + 3 CI tools intentionally absent from this fixture)
// ============================================

test('coder.v1.tools.static against the 6-tool fixture: 6 admitted, 6 unresolved', () => {
    registerStaticFixture();
    const result = composeAdmission({
        task: 'coder-session', query: null,
        budget_tokens: CODER_V1.tools.budget_tokens,
        profile_static: CODER_V1.tools.static,
        task_ledger: null,
        user_groups: ['coder'],
        discovery_call: null,
        expansion_mode: CODER_V1.tools.expansion_mode,
    });
    assert.equal(result.admitted.length, 6);
    assert.deepEqual(result.diagnostics.unresolved_static, [
        'list_tool_categories', 'list_tools_by_category', 'find_tool',
        'get_ci_status', 'wait_for_ci', 'get_ci_logs',
    ]);
});

// ============================================
// Composer integration with Catalog — name → ToolID determinism
// ============================================

test('Composer integration: name → ToolID matches computeToolID across calls', () => {
    registerStaticFixture();
    const expectedId = computeToolID(catalogTesting.PROFILE_NAMESPACE, 'read_file', catalogTesting.TOOL_VERSION);
    const a = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const b = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(a.admitted[0].tool_id, expectedId);
    assert.equal(a.admitted[0].tool_id, b.admitted[0].tool_id);
});

// ============================================
// Internal helper — isAuthorized
// ============================================

test('isAuthorized: full group bypasses required_groups', () => {
    assert.equal(composerTesting.isAuthorized(['admin'], ['full']), true);
    assert.equal(composerTesting.isAuthorized([], ['full']), true);
});

test('isAuthorized: required "all" admits everyone', () => {
    assert.equal(composerTesting.isAuthorized(['all'], ['pm']), true);
    assert.equal(composerTesting.isAuthorized(['all'], []), true);
});

test('isAuthorized: empty required_groups admits everyone', () => {
    assert.equal(composerTesting.isAuthorized([], ['pm']), true);
});

test('isAuthorized: requires overlap between required and user groups', () => {
    assert.equal(composerTesting.isAuthorized(['coder'], ['pm']), false);
    assert.equal(composerTesting.isAuthorized(['coder'], ['coder']), true);
});

// ============================================
// LLMDebug.attachToolDiagnostics — pin/stash split
// ============================================

test('LLMDebug.attachToolDiagnostics pins onto _current exchange when one is open', () => {
    const exchange = LLMDebug.startExchange({ model: 'test', stream: true, tools: [], messages: [] });
    LLMDebug.attachToolDiagnostics({ static_admitted: 6, sticky_admitted: 0, discovery_admitted: 0, suppressed: 0, unresolved_static: [] });
    assert.ok(exchange.tools);
    assert.equal(exchange.tools.static_admitted, 6);
    LLMDebug._current = null;
});

test('LLMDebug.attachToolDiagnostics stashes onto _pending when no exchange open', () => {
    LLMDebug._current = null;
    LLMDebug._pendingTools = null;
    LLMDebug.attachToolDiagnostics({ static_admitted: 1, sticky_admitted: 0, discovery_admitted: 0, suppressed: 0, unresolved_static: [] });
    assert.ok(LLMDebug._pendingTools);
    assert.equal(LLMDebug._pendingTools.static_admitted, 1);
    // Now opening a new exchange should drain the pending stash.
    const exchange = LLMDebug.startExchange({ model: 'test', stream: true, tools: [], messages: [] });
    assert.ok(exchange.tools);
    assert.equal(exchange.tools.static_admitted, 1);
    assert.equal(LLMDebug._pendingTools, null, 'pending should drain on startExchange');
    LLMDebug._current = null;
});

test('LLMDebug.attachToolDiagnostics ignores null/undefined input', () => {
    LLMDebug._current = null;
    LLMDebug._pendingTools = null;
    LLMDebug.attachToolDiagnostics(null);
    LLMDebug.attachToolDiagnostics(undefined);
    assert.equal(LLMDebug._pendingTools, null);
});

// ============================================
// Sticky admission via task_ledger.tool_admissions (1.3.17 / Tools PR 4)
// ============================================
//
// Each test stages a TaskLedger with one or more admission records that
// reference a tool name *not* in the static set (`find_references`,
// `search_in_files`), so the static loop ignores them and the sticky pass
// is the only path that can admit them.

function registerStickyFixture() {
    // Same as registerStaticFixture but adds two non-static read tools the
    // sticky tests will reference.
    registerStaticFixture();
    const reg = (name, description, parameters = { type: 'object', properties: {} }, roles = 'all') =>
        ToolRegistry.register(name, async () => ({}), {
            function: { name, description, parameters }, roles,
        });
    reg('find_references',  'Find references to a symbol across the project.',
        { type: 'object', properties: { symbol: { type: 'string' } } });
    reg('search_in_files',  'Full-text search across project files.',
        { type: 'object', properties: { query: { type: 'string' } } });
}

function makeLedgerWith(...toolNames) {
    const ledger = createTaskLedger({ taskId: 't', surface: 'coder.v1' });
    for (const name of toolNames) {
        ledger.tool_admissions.push({
            tool_id: name,
            admitted_at: 1700000000000,
            form: 'full',
            source: 'discovery',
            cost: 0,
            last_used_at: 1700000000000,
        });
    }
    return ledger;
}

test('sticky admission: a non-static ledger entry admits with source:"sticky"', () => {
    registerStickyFixture();
    const ledger = makeLedgerWith('find_references');
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 2, 'one static + one sticky');
    const stickies = result.admitted.filter(a => a.source === 'sticky');
    assert.equal(stickies.length, 1);
    assert.equal(Catalog.getById(stickies[0].tool_id).name, 'find_references');
    assert.equal(result.diagnostics.sticky_admitted, 1);
    assert.equal(result.diagnostics.static_admitted, 1);
});

test('sticky admission: same tool in static AND ledger admits exactly once (static wins)', () => {
    registerStickyFixture();
    const ledger = makeLedgerWith('read_file');  // already in profile_static below
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file', 'edit_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 2, 'no duplicate of read_file');
    for (const a of result.admitted) {
        assert.equal(a.source, 'static', 'static wins when names overlap');
    }
    assert.equal(result.diagnostics.sticky_admitted, 0);
});

test('sticky admission: unauthorized sticky tool lands in suppressed', () => {
    registerStickyFixture();
    // edit_file requires ['coder']; user is 'pm' (no overlap, no full bypass).
    const ledger = makeLedgerWith('edit_file');
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: ['pm'], discovery_call: null, expansion_mode: 'full',
    });
    // Only the static read_file admits; edit_file is sticky-suppressed.
    assert.equal(result.admitted.length, 1);
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0].reason, 'unauthorized');
    assert.equal(Catalog.getById(result.suppressed[0].tool_id).name, 'edit_file');
    assert.equal(result.diagnostics.sticky_admitted, 0);
});

test('sticky admission: over-budget sticky tool lands in suppressed (static is protected)', () => {
    registerStickyFixture();
    // Probe each tool's individual cost so we can size the budget tightly.
    const probeStatic = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const staticCost = probeStatic.tokens_used;

    const ledger = makeLedgerWith('find_references');
    const result = composeAdmission({
        task: 'unit', query: null,
        budget_tokens: staticCost,    // exactly the static cost — no room for sticky
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 1, 'only the static tool admits');
    assert.equal(result.admitted[0].source, 'static');
    assert.equal(result.suppressed.length, 1);
    assert.equal(result.suppressed[0].reason, 'over_budget');
    assert.equal(result.diagnostics.sticky_admitted, 0);
});

test('sticky admission: ledger entry referencing a removed tool is silently dropped', () => {
    registerStickyFixture();
    // Stage a ledger that points at a tool the registry doesn't know about.
    const ledger = makeLedgerWith('this_tool_does_not_exist');
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 1, 'static still admits');
    assert.equal(result.suppressed.length, 0, 'unknown sticky entry is dropped, not suppressed');
    assert.equal(result.diagnostics.sticky_admitted, 0);
    assert.deepEqual(result.diagnostics.unresolved_static, [], 'unresolved_static covers profile_static, not sticky');
});

test('sticky admission: respects ledger order when budget partially fits', () => {
    registerStickyFixture();
    // Probe each candidate sticky tool's cost.
    const probe = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['find_references', 'search_in_files'],
        task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const findCost = Catalog.getByName('find_references').metadata.cost_estimate;

    // Budget = static + first sticky exactly. Second sticky must overflow.
    const staticProbe = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const ledger = makeLedgerWith('find_references', 'search_in_files');
    const result = composeAdmission({
        task: 'unit', query: null,
        budget_tokens: staticProbe.tokens_used + findCost,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const admittedNames = result.admitted.map(a => Catalog.getById(a.tool_id).name);
    assert.deepEqual(admittedNames, ['read_file', 'find_references']);
    assert.equal(result.diagnostics.sticky_admitted, 1);
    assert.equal(result.suppressed.length, 1);
    assert.equal(Catalog.getById(result.suppressed[0].tool_id).name, 'search_in_files');
});

test('sticky admission: tokens_used equals static + sticky admitted costs', () => {
    registerStickyFixture();
    const ledger = makeLedgerWith('find_references', 'search_in_files');
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    let expected = 0;
    for (const a of result.admitted) {
        expected += Catalog.getById(a.tool_id).metadata.cost_estimate;
    }
    assert.equal(result.tokens_used, expected);
});

test('sticky admission: null task_ledger preserves 1.3.14 behavior (no sticky pass)', () => {
    registerStickyFixture();
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file', 'edit_file'],
        task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 2);
    for (const a of result.admitted) {
        assert.equal(a.source, 'static');
    }
    assert.equal(result.diagnostics.sticky_admitted, 0);
});

test('sticky admission: ledger.form = "short" is honored on the admitted entry', () => {
    registerStickyFixture();
    const ledger = createTaskLedger({ taskId: 't', surface: 'coder.v1' });
    ledger.tool_admissions.push({
        tool_id: 'find_references',
        admitted_at: 1700000000000,
        form: 'short',
        source: 'discovery',
        cost: 0,
        last_used_at: 1700000000000,
    });
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const sticky = result.admitted.find(a => a.source === 'sticky');
    assert.ok(sticky, 'sticky entry admits');
    assert.equal(sticky.form, 'short', 'form is copied from the ledger record');
});

// ============================================
// 1.4.1 — lazy schema expansion via `form: 'short'` rendering
// ============================================

test('renderForLLM omits `parameters` when admission form is "short"', () => {
    registerStickyFixture();
    const ledger = createTaskLedger({ taskId: 't', surface: 'coder.v1' });
    ledger.tool_admissions.push({
        tool_id: 'find_references',
        admitted_at: 1700000000000,
        form: 'short',
        source: 'discovery',
        cost: 50,
        last_used_at: 1700000000000,
    });
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['read_file'],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const rendered = renderForLLM(result);
    const findRef = rendered.find(r => r.function.name === 'find_references');
    assert.ok(findRef, 'find_references renders');
    assert.equal(typeof findRef.function.name, 'string');
    assert.equal(typeof findRef.function.description, 'string');
    assert.ok(!('parameters' in findRef.function),
        '`parameters` MUST be absent on short-form admissions (lazy schema expansion)');

    const readFile = rendered.find(r => r.function.name === 'read_file');
    assert.ok(readFile, 'read_file (static, full form) renders');
    assert.equal(typeof readFile.function.parameters, 'object',
        '`parameters` MUST be present on full-form admissions');
});

test('renderForLLM mixed short+full ledger renders each per-entry form', () => {
    registerStickyFixture();
    const ledger = createTaskLedger({ taskId: 't', surface: 'coder.v1' });
    ledger.tool_admissions.push({
        tool_id: 'find_references',
        admitted_at: 1700000000000, form: 'short', source: 'discovery', cost: 50, last_used_at: 1700000000000,
    });
    ledger.tool_admissions.push({
        tool_id: 'search_in_files',
        admitted_at: 1700000000000, form: 'full', source: 'discovery', cost: 200, last_used_at: 1700000000000,
    });
    const result = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: [],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const rendered = renderForLLM(result);
    const findRef = rendered.find(r => r.function.name === 'find_references');
    const search = rendered.find(r => r.function.name === 'search_in_files');
    assert.ok(!('parameters' in findRef.function), 'short → no parameters');
    assert.equal(typeof search.function.parameters, 'object', 'full → has parameters');
});

test('sticky admission: short-form pays short_cost against budget (not cost_estimate)', () => {
    registerStickyFixture();
    // Probe the full cost so we can size budget tightly between short and full.
    const probe = composeAdmission({
        task: 'unit', query: null, budget_tokens: 100000,
        profile_static: ['find_references'], task_ledger: null,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    const fullCost = probe.tokens_used;
    const shortCost = Catalog.getByName('find_references').metadata.short_cost;
    assert.ok(shortCost < fullCost, 'short_cost should be smaller than cost_estimate');

    // Budget that fits the short entry but NOT the full one.
    const ledger = createTaskLedger({ taskId: 't', surface: 'coder.v1' });
    ledger.tool_admissions.push({
        tool_id: 'find_references',
        admitted_at: 1700000000000, form: 'short', source: 'discovery', cost: shortCost, last_used_at: 1700000000000,
    });
    const result = composeAdmission({
        task: 'unit', query: null,
        budget_tokens: shortCost,           // only short fits
        profile_static: [],
        task_ledger: ledger,
        user_groups: FULL_USER_GROUPS, discovery_call: null, expansion_mode: 'full',
    });
    assert.equal(result.admitted.length, 1, 'short-form fits where full would have been over-budget');
    assert.equal(result.tokens_used, shortCost);
});

// ============================================
// URL flag — ?toolsCompose=off
// ============================================

test('isToolsComposeDisabled() defaults to false when URL has no flag', () => {
    resetFlagCache();
    // Node-shim's window.location is undefined; default-false branch.
    assert.equal(isToolsComposeDisabled(), false);
});

test('isToolsComposeDisabled() reads ?toolsCompose=off|false|0|disabled', () => {
    const fixtures = [
        { search: '?toolsCompose=off', expected: true },
        { search: '?toolsCompose=false', expected: true },
        { search: '?toolsCompose=0', expected: true },
        { search: '?toolsCompose=disabled', expected: true },
        { search: '?toolsCompose=on', expected: false },
        { search: '?toolsCompose=', expected: false },
        { search: '?other=off', expected: false },
        { search: '', expected: false },
    ];
    for (const f of fixtures) {
        resetFlagCache();
        globalThis.window.location = { search: f.search };
        assert.equal(isToolsComposeDisabled(), f.expected, `?${f.search} → ${f.expected}`);
    }
    delete globalThis.window.location;
});

test('isToolsComposeDisabled() caches first read', () => {
    resetFlagCache();
    globalThis.window.location = { search: '?toolsCompose=off' };
    assert.equal(isToolsComposeDisabled(), true);
    // Mutate the URL — cached value should not change.
    globalThis.window.location = { search: '?toolsCompose=on' };
    assert.equal(isToolsComposeDisabled(), true, 'cache should hold');
    resetFlagCache();
    assert.equal(isToolsComposeDisabled(), false, 'cache reset → re-read');
    delete globalThis.window.location;
});

test('_resetCacheForTests round-trip works', () => {
    resetFlagCache();
    globalThis.window.location = { search: '?toolsCompose=off' };
    assert.equal(isToolsComposeDisabled(), true);
    resetFlagCache();
    globalThis.window.location = { search: '' };
    assert.equal(isToolsComposeDisabled(), false);
    delete globalThis.window.location;
});
