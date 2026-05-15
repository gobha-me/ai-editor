/**
 * `Profiles.filterTools(defs, profileName)` — name-membership admission
 * (gitea#438 / 2.54.0 inversion).
 *
 * Pre-2.54.0 admission was tag-intersection: tools self-tagged with
 * `roles: [...]`, profiles intersected via `tools.allowed_groups`. The
 * 2.54.0 inversion makes profiles enumerate explicit tool names in
 * `tools.admit`; the old test pinned cross-product equivalence with the
 * pre-2.0.0 `Roles.filterTools` shape and is no longer applicable.
 *
 * What this test pins now:
 *   1. Each picker profile (chat / coder / kb) admits a known explicit
 *      list — synthetic tool fixtures with the names from the migration
 *      lists in `js/profiles/{chat,coder,kb}-v1.js`.
 *   2. The `'mcp__*'` glob admits MCP-prefixed tool names; literal entries
 *      still match exactly.
 *   3. The `'*'` sentinel in `full.v1.tools.admit` is a wholesale bypass.
 *   4. Unknown / null / undefined profile names fall back to chat.v1 with
 *      a console warn.
 *   5. The defensive non-array-defs path returns an empty array.
 *   6. Output is a fresh array; the input is never mutated.
 *   7. Synthetic profiles (full / pm / reviewer / plugin-dev / chat-multi
 *      / rp / subagent) resolve via Profiles.get / has but stay out of
 *      Profiles.list (picker UI).
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Profiles } from '../js/profiles/index.js';

// ============================================
// Tool fixtures — name-shaped, no `roles:` field.
// ============================================
const TOOL_FIXTURES = [
    { type: 'function', function: { name: 'tool_explicit_a' } },
    { type: 'function', function: { name: 'tool_explicit_b' } },
    { type: 'function', function: { name: 'tool_excluded' } },
    { type: 'function', function: { name: 'mcp__github__create_issue' } },
    { type: 'function', function: { name: 'mcp__filesys__read_file' } },
    { type: 'function', function: { name: 'mcp_namespaceless' } }, // single underscore — must NOT match mcp__*
];

// ============================================
// Synthetic per-profile probes — overlay tool fixtures + admit lists.
// ============================================
//
// Tests how `filterTools` matches against an `admit` array containing a
// mix of literal names + the `mcp__*` glob. The probes are independent
// of the actual production profile registry; they exercise the filter
// logic directly via a pseudo-profile injected through filterTools'
// resolve path. Production profiles' admit lists are pinned separately
// in `tests/test-profile-admit-coverage.mjs`.

test('literal admit entries match by exact name', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'kb.v1').map(t => t.function.name);
    // kb.v1 admits read_file via the explicit list; mcp__* via the glob.
    // Synthesized fixtures don't include `read_file`, so we expect only
    // the mcp__-prefixed tools to admit (the literal names in TOOL_FIXTURES
    // are not in kb.v1's admit list). Glob matching gives us 2 admits.
    assert.deepEqual(got.sort(), ['mcp__filesys__read_file', 'mcp__github__create_issue']);
});

test('mcp__* glob matches double-underscore-prefixed names but NOT single-underscore', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'chat.v1').map(t => t.function.name);
    // chat.v1's admit list contains the mcp__* glob; none of the
    // tool_explicit_* fixtures are in chat.v1.admit.
    assert.ok(got.includes('mcp__github__create_issue'), 'mcp__github__create_issue must admit via glob');
    assert.ok(got.includes('mcp__filesys__read_file'),   'mcp__filesys__read_file must admit via glob');
    assert.ok(!got.includes('mcp_namespaceless'),        'single-underscore name must NOT match mcp__* glob');
    assert.ok(!got.includes('tool_excluded'),            'tool_excluded must not admit (not in chat.v1.admit)');
});

test('full.v1 wildcard admits every tool unfiltered', () => {
    const got = Profiles.filterTools(TOOL_FIXTURES, 'full.v1').map(t => t.function.name);
    assert.deepEqual(got, TOOL_FIXTURES.map(t => t.function.name));
});

test('full.v1 returns a fresh array (never the input reference)', () => {
    const out = Profiles.filterTools(TOOL_FIXTURES, 'full.v1');
    assert.notEqual(out, TOOL_FIXTURES);
    assert.deepEqual(out, TOOL_FIXTURES);
});

// ============================================
// Picker-profile admit-list snapshots (smoke level — full coverage in
// test-profile-admit-coverage.mjs).
// ============================================

test('chat.v1.admit covers the known production tool baseline', () => {
    // Smoke: chat.v1 admits a representative set including ask_user,
    // read_file (from chat baseline), and mcp__* glob entries.
    const probe = [
        { type: 'function', function: { name: 'ask_user' } },
        { type: 'function', function: { name: 'read_file' } },
        { type: 'function', function: { name: 'edit_file' } }, // coder-only — chat.v1 does NOT admit
    ];
    const got = Profiles.filterTools(probe, 'chat.v1').map(t => t.function.name);
    assert.ok(got.includes('ask_user'),  'chat.v1 must admit ask_user');
    assert.ok(got.includes('read_file'), 'chat.v1 must admit read_file');
    assert.ok(!got.includes('edit_file'), 'chat.v1 must NOT admit edit_file (coder-only)');
});

test('coder.v1 admits coder-only tools that chat.v1 rejects', () => {
    const probe = [
        { type: 'function', function: { name: 'edit_file' } },
        { type: 'function', function: { name: 'commit_files' } },
        { type: 'function', function: { name: 'run_code' } },
    ];
    const got = Profiles.filterTools(probe, 'coder.v1').map(t => t.function.name);
    assert.deepEqual(got.sort(), ['commit_files', 'edit_file', 'run_code']);
});

test('kb.v1 rejects every coder-only mutator', () => {
    const probe = [
        { type: 'function', function: { name: 'edit_file' } },
        { type: 'function', function: { name: 'commit_files' } },
        { type: 'function', function: { name: 'run_code' } },
        { type: 'function', function: { name: 'create_issue' } },
        { type: 'function', function: { name: 'read_file' } }, // kb admits this
    ];
    const got = Profiles.filterTools(probe, 'kb.v1').map(t => t.function.name);
    assert.deepEqual(got, ['read_file']);
});

test('subagent.v1 admit is the trust-boundary 8-read-only enumeration', () => {
    const probe = [
        { type: 'function', function: { name: 'read_file' } },        // admit
        { type: 'function', function: { name: 'read_lines' } },       // admit
        { type: 'function', function: { name: 'scan_file' } },        // admit
        { type: 'function', function: { name: 'search_in_files' } },  // admit
        { type: 'function', function: { name: 'list_dirty_files' } }, // admit
        { type: 'function', function: { name: 'list_tool_categories' } }, // admit
        { type: 'function', function: { name: 'list_tools_by_category' } }, // admit
        { type: 'function', function: { name: 'find_tool' } },        // admit
        { type: 'function', function: { name: 'edit_file' } },        // REJECT
        { type: 'function', function: { name: 'mcp__server__tool' } }, // REJECT (no glob)
        { type: 'function', function: { name: 'delegate_task' } },    // REJECT (no recursion)
    ];
    const got = Profiles.filterTools(probe, 'subagent.v1').map(t => t.function.name);
    assert.deepEqual(got.sort(), [
        'find_tool',
        'list_dirty_files',
        'list_tool_categories',
        'list_tools_by_category',
        'read_file',
        'read_lines',
        'scan_file',
        'search_in_files',
    ]);
});

// ============================================
// Edge cases.
// ============================================

test('unknown profile falls back to chat.v1', () => {
    const got     = Profiles.filterTools(TOOL_FIXTURES, 'nonexistent.v9').map(t => t.function.name);
    const chatGot = Profiles.filterTools(TOOL_FIXTURES, 'chat.v1').map(t => t.function.name);
    assert.deepEqual(got, chatGot);
});

test('null/undefined profileName falls back to chat.v1', () => {
    const chatGot = Profiles.filterTools(TOOL_FIXTURES, 'chat.v1').map(t => t.function.name);
    assert.deepEqual(Profiles.filterTools(TOOL_FIXTURES, null).map(t => t.function.name),      chatGot);
    assert.deepEqual(Profiles.filterTools(TOOL_FIXTURES, undefined).map(t => t.function.name), chatGot);
});

test('non-array defs returns empty array (defensive)', () => {
    assert.deepEqual(Profiles.filterTools(null,      'coder.v1'), []);
    assert.deepEqual(Profiles.filterTools(undefined, 'coder.v1'), []);
});

test('input array is not mutated', () => {
    const originalLength = TOOL_FIXTURES.length;
    Profiles.filterTools(TOOL_FIXTURES, 'reviewer.v1');
    assert.equal(TOOL_FIXTURES.length, originalLength);
});

// ============================================
// Synthetic registration sanity — proves slice 1's registry shape.
// ============================================

test('synthetic profiles resolve via Profiles.get', () => {
    assert.equal(Profiles.get('full.v1')?.name,        'full.v1');
    assert.equal(Profiles.get('plugin-dev.v1')?.name,  'plugin-dev.v1');
    assert.equal(Profiles.get('pm.v1')?.name,          'pm.v1');
    assert.equal(Profiles.get('reviewer.v1')?.name,    'reviewer.v1');
    assert.equal(Profiles.get('chat_multi.v1')?.name,  'chat_multi.v1');
    assert.equal(Profiles.get('rp.v1')?.name,          'rp.v1');
    assert.equal(Profiles.get('subagent.v1')?.name,    'subagent.v1');
});

test('synthetic profiles satisfy Profiles.has', () => {
    assert.equal(Profiles.has('full.v1'),       true);
    assert.equal(Profiles.has('plugin-dev.v1'), true);
    assert.equal(Profiles.has('pm.v1'),         true);
    assert.equal(Profiles.has('reviewer.v1'),   true);
    assert.equal(Profiles.has('subagent.v1'),   true);
});

test('synthetic profiles are excluded from Profiles.list (picker UI)', () => {
    // 2.6.0 — chat_multi.v1, rp.v1, kb.v1 shipped lookup-only alongside
    // the legacy-role synthetics. 2.8.0 — kb.v1 graduated to ENTRIES
    // carrying its KB-mode systemPrompt addendum. chat_multi.v1 and rp.v1
    // stay in SYNTHETIC_ENTRIES until each earns its own addendum.
    const names = Profiles.list().map(e => e.name);
    assert.deepEqual(names, ['chat.v1', 'coder.v1', 'kb.v1']);
});

test('plugin-dev.v1 carries the SDK addendum systemPrompt', () => {
    const profile = Profiles.get('plugin-dev.v1');
    assert.ok(profile, 'plugin-dev.v1 must resolve');
    assert.equal(typeof profile.systemPrompt, 'string');
    assert.ok(profile.systemPrompt.includes('PLUGIN EDITOR MODE'));
    assert.ok(profile.systemPrompt.includes('END SDK REFERENCE'));
});

test('kb.v1 carries the KB-mode addendum systemPrompt (2.8.0 promotion gate)', () => {
    const profile = Profiles.get('kb.v1');
    assert.ok(profile, 'kb.v1 must resolve');
    assert.equal(typeof profile.systemPrompt, 'string');
    assert.ok(profile.systemPrompt.includes('KB MODE'));
    assert.ok(profile.systemPrompt.includes('attached doc'));
    assert.ok(profile.systemPrompt.toLowerCase().includes('cite'));
});

test('non-systemPrompt-carrying profiles leave the field absent', () => {
    for (const name of ['chat.v1', 'coder.v1', 'full.v1', 'pm.v1', 'reviewer.v1']) {
        const profile = Profiles.get(name);
        assert.ok(profile, `${name} must resolve`);
        assert.equal(profile.systemPrompt ?? null, null, `${name}.systemPrompt should be absent or null`);
    }
});
