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
// coder.v1 fixture — 9 names → 6 admitted, 3 unresolved
// ============================================

test('coder.v1.tools.static against the 6-tool fixture: 6 admitted, 3 unresolved meta-tools', () => {
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
