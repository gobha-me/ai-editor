/**
 * Cross-product equivalence: `Profiles.filterTools(defs, profileName)` ≡
 * legacy `Roles.filterTools(defs)` for every (legacy role, mapped profile)
 * pair.
 *
 * This is the load-bearing test for slice 2 (1.24.0) of the path-to-2.0.0
 * profile arc. Slice 2 flips every consumer site that today calls
 * `Roles.filterTools(defs)` (or branches on `State.settings.role`) to
 * `Profiles.filterTools(defs, getActiveProfileName(State.settings))`. That
 * flip is only safe if the two filters return byte-identical sets for
 * every migrated user. This test pins that.
 *
 * The test does NOT import `Roles` from `js/core.js` — that module pulls
 * in browser-only globals (`window.addEventListener`, etc.) and would
 * break under `node --test`. Instead it reproduces the legacy semantic
 * inline as `legacyRolesFilter(defs, role)` and compares against
 * `Profiles.filterTools(defs, profileName)`. The legacy semantic is
 * literally the seven lines at [`js/core.js:1395–1414`](../js/core.js).
 *
 * Cross product: 6 tool-side `roles:` declarations × 6 profiles × the
 * 5 legacy roles that the 2.0.0 migration script handles.
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Profiles } from '../js/profiles/index.js';

// ============================================
// Legacy `Roles.filterTools` semantic, reproduced inline.
// ============================================
//
// Pre-2.0.0 [`js/core.js:1395–1414`](../js/core.js):
//
//   filterTools(toolDefinitions) {
//       const activeRole = State.settings.role;
//       if (activeRole === 'full') return toolDefinitions;
//       return toolDefinitions.filter(tool => {
//           const toolRoles = tool._registeredRoles || [];
//           if (toolRoles.includes('all')) return true;
//           return toolRoles.includes(activeRole);
//       });
//   }
//
// Reproduced here so the test does not depend on `js/core.js` (browser-
// only). Slice 3 (2.0.0) replaces the in-tree `Roles.filterTools` with a
// thin `Profiles.filterTools` alias; this stays as the truth-table.
function legacyRolesFilter(defs, role) {
    if (role === 'full') return defs.slice();
    return defs.filter(def => {
        const toolRoles = (def && def._registeredRoles) || [];
        if (toolRoles.includes('all')) return true;
        return toolRoles.includes(role);
    });
}

// ============================================
// 2.0.0 migration mapping — `settings.role` → `settings.profile`.
// ============================================
//
// Pinned here so the test agrees with the migration script that lands
// at slice 3. Any divergence here vs. the migration script is the bug.
const ROLE_TO_PROFILE = {
    coder:        'coder.v1',
    full:         'full.v1',
    pm:           'pm.v1',
    reviewer:     'reviewer.v1',
    'plugin-dev': 'plugin-dev.v1',
};

// Tool-side `roles:` declarations exhaustively covering the shapes the
// production tool registry emits today. Each `_registeredRoles` shape is
// the post-normalization array `js/tools/registry.js#register` stores.
const TOOL_FIXTURES = [
    { function: { name: 'tool_all' },         _registeredRoles: ['all'] },
    { function: { name: 'tool_coder_only' },  _registeredRoles: ['coder'] },
    { function: { name: 'tool_pm_only' },     _registeredRoles: ['pm'] },
    { function: { name: 'tool_reviewer' },    _registeredRoles: ['reviewer'] },
    { function: { name: 'tool_plugin_dev' },  _registeredRoles: ['plugin-dev'] },
    { function: { name: 'tool_coder_pm' },    _registeredRoles: ['coder', 'pm'] },
];

const LEGACY_ROLES = Object.keys(ROLE_TO_PROFILE);

// ============================================
// Cross-product equivalence — the load-bearing assertion.
// ============================================

test('Profiles.filterTools matches legacy Roles.filterTools across (role, profile) cross product', () => {
    const failures = [];
    for (const role of LEGACY_ROLES) {
        const profileName = ROLE_TO_PROFILE[role];
        const legacy = legacyRolesFilter(TOOL_FIXTURES, role).map(t => t.function.name);
        const profileFiltered = Profiles.filterTools(TOOL_FIXTURES, profileName).map(t => t.function.name);
        if (legacy.length !== profileFiltered.length || legacy.some((n, i) => n !== profileFiltered[i])) {
            failures.push({ role, profileName, legacy, profileFiltered });
        }
    }
    if (failures.length > 0) {
        const lines = failures.map(f =>
            `  role=${f.role} profile=${f.profileName}\n    legacy:  ${JSON.stringify(f.legacy)}\n    profile: ${JSON.stringify(f.profileFiltered)}`
        ).join('\n');
        assert.fail(`Filter divergence on:\n${lines}`);
    }
});

// ============================================
// Per-profile spot checks — make divergence diagnosable.
// ============================================

test('coder.v1 admits all + coder + coder/pm intersection; rejects pm/reviewer/plugin-dev', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'coder.v1').map(t => t.function.name);
    assert.deepEqual(got, ['tool_all', 'tool_coder_only', 'tool_coder_pm']);
});

test('full.v1 admits everything (the * bypass)', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'full.v1').map(t => t.function.name);
    assert.deepEqual(got, TOOL_FIXTURES.map(t => t.function.name));
});

test('pm.v1 admits all + pm-tagged + coder/pm intersection only', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'pm.v1').map(t => t.function.name);
    assert.deepEqual(got, ['tool_all', 'tool_pm_only', 'tool_coder_pm']);
});

test('reviewer.v1 admits all + reviewer-tagged only', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'reviewer.v1').map(t => t.function.name);
    assert.deepEqual(got, ['tool_all', 'tool_reviewer']);
});

test('plugin-dev.v1 admits all + plugin-dev-tagged only', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'plugin-dev.v1').map(t => t.function.name);
    assert.deepEqual(got, ['tool_all', 'tool_plugin_dev']);
});

test('chat.v1 admits all + pm + reviewer + coder/pm intersection (covers historical pm + reviewer migration target via picker)', () => {
    // Picker-selected chat.v1 is intentionally wider than pm.v1 / reviewer.v1
    // because it represents "I want a generic chat surface with full issue
    // access" rather than a granular pm-only or reviewer-only surface.
    const got = Profiles.filterTools(TOOL_FIXTURES, 'chat.v1').map(t => t.function.name);
    assert.deepEqual(got, ['tool_all', 'tool_pm_only', 'tool_reviewer', 'tool_coder_pm']);
});

// ============================================
// Edge cases.
// ============================================

test('unknown profile falls back to chat.v1', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'nonexistent.v9').map(t => t.function.name);
    const chatGot = Profiles.filterTools(TOOL_FIXTURES, 'chat.v1').map(t => t.function.name);
    assert.deepEqual(got, chatGot);
});

test('null/undefined profileName falls back to chat.v1', () => {
    const chatGot = Profiles.filterTools(TOOL_FIXTURES, 'chat.v1').map(t => t.function.name);
    assert.deepEqual(Profiles.filterTools(TOOL_FIXTURES, null).map(t => t.function.name), chatGot);
    assert.deepEqual(Profiles.filterTools(TOOL_FIXTURES, undefined).map(t => t.function.name), chatGot);
});

test('non-array defs returns empty array (defensive)', () => {
    // Mirrors the defensive `if (!Array.isArray(defs)) return []` in
    // `js/profiles/registry.js#filterTools` — a callsite that hands in
    // `null` or `undefined` should not throw.
    assert.deepEqual(Profiles.filterTools(null, 'coder.v1'), []);
    assert.deepEqual(Profiles.filterTools(undefined, 'coder.v1'), []);
});

test('input array is not mutated', () => {
    const originalLength = TOOL_FIXTURES.length;
    Profiles.filterTools(TOOL_FIXTURES, 'reviewer.v1');
    assert.equal(TOOL_FIXTURES.length, originalLength);
});

test('full.v1 returns a fresh array (not the same reference)', () => {
    const out = Profiles.filterTools(TOOL_FIXTURES, 'full.v1');
    assert.notEqual(out, TOOL_FIXTURES);
    assert.deepEqual(out, TOOL_FIXTURES);
});

// ============================================
// Synthetic registration sanity — proves slice 1's registry shape.
// ============================================

test('synthetic profiles resolve via Profiles.get', () => {
    assert.equal(Profiles.get('full.v1')?.name, 'full.v1');
    assert.equal(Profiles.get('plugin-dev.v1')?.name, 'plugin-dev.v1');
    assert.equal(Profiles.get('pm.v1')?.name, 'pm.v1');
    assert.equal(Profiles.get('reviewer.v1')?.name, 'reviewer.v1');
});

test('synthetic profiles satisfy Profiles.has', () => {
    assert.equal(Profiles.has('full.v1'), true);
    assert.equal(Profiles.has('plugin-dev.v1'), true);
    assert.equal(Profiles.has('pm.v1'), true);
    assert.equal(Profiles.has('reviewer.v1'), true);
});

test('synthetic profiles are excluded from Profiles.list (picker UI)', () => {
    // 2.6.0 — chat_multi.v1, rp.v1, kb.v1 ship lookup-only alongside the
    // legacy-role synthetics until per-profile systemPrompt addenda land
    // (promotion gate documented in `js/profiles/registry.js` and ROADMAP
    // §"After 2.0.0").
    const names = Profiles.list().map(e => e.name);
    assert.deepEqual(names, ['chat.v1', 'coder.v1']);
});

test('plugin-dev.v1 carries the SDK addendum systemPrompt', () => {
    const profile = Profiles.get('plugin-dev.v1');
    assert.ok(profile, 'plugin-dev.v1 must resolve');
    assert.equal(typeof profile.systemPrompt, 'string');
    assert.ok(profile.systemPrompt.includes('PLUGIN EDITOR MODE'));
    assert.ok(profile.systemPrompt.includes('END SDK REFERENCE'));
});

test('non-synthetic profiles do not carry systemPrompt (slice 1 — additive optional)', () => {
    // chat.v1 / coder.v1 / full.v1 / pm.v1 / reviewer.v1 leave systemPrompt
    // absent; only plugin-dev.v1 carries it. Slice 2 (1.24.0) flips
    // js/prompts.js to read from `profile.systemPrompt`; until then the
    // absence is the expected shape.
    for (const name of ['chat.v1', 'coder.v1', 'full.v1', 'pm.v1', 'reviewer.v1']) {
        const profile = Profiles.get(name);
        assert.ok(profile, `${name} must resolve`);
        assert.equal(profile.systemPrompt ?? null, null, `${name}.systemPrompt should be absent or null`);
    }
});
