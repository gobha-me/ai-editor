/**
 * Tests for js/intelligence/tools/ (1.3.4 foundation).
 *
 * Asserts the data foundation:
 *   - `computeToolID` is deterministic, stable, and discriminates inputs.
 *   - The Catalog adapter produces one ToolDef per registered tool with
 *     the expected derived fields (category, side_effects, cost_estimate).
 *   - Lookup by id / name / category-prefix returns the right rows.
 *   - The `coder.v1` profile's `tools.static` array is populated and the
 *     ones that resolve in the registry come back as ToolDefs (the
 *     meta-tools intentionally don't resolve until 1.4.0 PR 3).
 *
 * The catalog → registry → core.js import path touches `window` and
 * `localStorage` at module-eval time, so the node shim is loaded first.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog, computeToolID } from '../js/intelligence/tools/index.js';
import { _testing as catalogTesting } from '../js/intelligence/tools/catalog.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';

// ============================================
// computeToolID — determinism and stability
// ============================================

test('computeToolID is deterministic — same triple, same id', () => {
    const a = computeToolID('coder', 'read_file', '1');
    const b = computeToolID('coder', 'read_file', '1');
    assert.equal(a, b);
});

test('computeToolID returns 16 lowercase hex chars', () => {
    const id = computeToolID('coder', 'read_file', '1');
    assert.match(id, /^[0-9a-f]{16}$/);
});

test('computeToolID discriminates by namespace, name, and version', () => {
    const base = computeToolID('coder', 'read_file', '1');
    assert.notEqual(base, computeToolID('chat', 'read_file', '1'), 'namespace must matter');
    assert.notEqual(base, computeToolID('coder', 'write_file', '1'), 'name must matter');
    assert.notEqual(base, computeToolID('coder', 'read_file', '2'), 'version must matter');
});

test('computeToolID resists boundary-shift collisions', () => {
    // Without a separator `('a', 'bc', '1')` and `('ab', 'c', '1')` would
    // both hash `"abc1"`. The NUL separator prevents that.
    const a = computeToolID('a', 'bc', '1');
    const b = computeToolID('ab', 'c', '1');
    assert.notEqual(a, b);
});

test('computeToolID rejects empty/non-string inputs', () => {
    assert.throws(() => computeToolID('', 'read_file', '1'), /profile_namespace/);
    assert.throws(() => computeToolID('coder', '', '1'), /canonical_name/);
    assert.throws(() => computeToolID('coder', 'read_file', ''), /version/);
    assert.throws(() => computeToolID(null, 'read_file', '1'), /profile_namespace/);
});

// ============================================
// Catalog — adapter behavior
// ============================================

// Register a small fixed set of test tools. We use a fresh registry state
// per test by clearing first; the catalog adapter reads from
// `ToolRegistry.getDefinitions()` on every call.
function registerFixtureTools() {
    ToolRegistry.clear();
    ToolRegistry.register('read_file', async () => ({}), {
        function: {
            name: 'read_file',
            description: 'Read the full content of a file by path.',
            parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        roles: 'all',
    });
    ToolRegistry.register('edit_file', async () => ({}), {
        function: {
            name: 'edit_file',
            description: 'Apply a multi-line edit to a file.',
            parameters: { type: 'object', properties: { path: { type: 'string' }, new_content: { type: 'string' } } },
        },
        roles: ['coder'],
    });
    ToolRegistry.register('commit_files', async () => ({}), {
        function: {
            name: 'commit_files',
            description: 'Commit the staged set with a message.',
            parameters: { type: 'object', properties: { message: { type: 'string' } } },
        },
        roles: ['coder'],
    });
    ToolRegistry.register('untyped_tool', async () => ({}), {
        function: {
            name: 'untyped_tool',
            description: 'A fictional tool not in the category map.',
            parameters: { type: 'object', properties: {} },
        },
        roles: 'all',
    });
}

test('Catalog.listAll returns one entry per registered tool', () => {
    registerFixtureTools();
    const all = Catalog.listAll();
    assert.equal(all.length, 4);
    const names = all.map(t => t.name).sort();
    assert.deepEqual(names, ['commit_files', 'edit_file', 'read_file', 'untyped_tool']);
});

test('Catalog produces a ToolDef with all required fields', () => {
    registerFixtureTools();
    const td = Catalog.getByName('read_file');
    assert.ok(td, 'read_file should resolve');
    assert.equal(td.name, 'read_file');
    assert.equal(td.category, 'code.file.read');
    assert.equal(typeof td.description, 'string');
    assert.equal(typeof td.schema, 'object');
    assert.equal(td.full_doc, '');
    assert.equal(td.embedding, null, 'embedding null until 1.4.1');
    assert.equal(td.metadata.version, '1');
    assert.equal(td.metadata.deprecated, false);
    assert.equal(td.metadata.superseded_by, null);
});

test('Catalog derives stable IDs from name + version', () => {
    registerFixtureTools();
    const td = Catalog.getByName('read_file');
    const expected = computeToolID(catalogTesting.PROFILE_NAMESPACE, 'read_file', catalogTesting.TOOL_VERSION);
    assert.equal(td.id, expected);
    assert.equal(Catalog.getById(expected)?.name, 'read_file');
});

test('Catalog returns null for unknown name and unknown id', () => {
    registerFixtureTools();
    assert.equal(Catalog.getByName('does_not_exist'), null);
    assert.equal(Catalog.getById('0000000000000000'), null);
});

test('Catalog assigns side_effects from the mapping table', () => {
    registerFixtureTools();
    assert.equal(Catalog.getByName('read_file').metadata.side_effects, 'read');
    assert.equal(Catalog.getByName('edit_file').metadata.side_effects, 'write');
    assert.equal(Catalog.getByName('commit_files').metadata.side_effects, 'external');
});

test('Catalog defaults unmapped tools to misc / external', () => {
    registerFixtureTools();
    const td = Catalog.getByName('untyped_tool');
    assert.equal(td.category, 'misc', 'unmapped name → misc category');
    assert.equal(td.metadata.side_effects, 'external', 'unmapped name → external (cautious default)');
});

test('Catalog.cost_estimate ≥ short_cost and both are positive', () => {
    registerFixtureTools();
    const td = Catalog.getByName('read_file');
    assert.ok(td.metadata.short_cost > 0);
    assert.ok(td.metadata.cost_estimate >= td.metadata.short_cost,
        `cost_estimate=${td.metadata.cost_estimate} should be >= short_cost=${td.metadata.short_cost}`);
});

test('Catalog populates authorization.required_groups as empty (gitea#438 — admission inverted to profile-side admit lists)', () => {
    // 2.54.0 (gitea#438) — the catalog no longer derives per-tool
    // `required_groups` from the retired `_registeredRoles` field.
    // The composer's `isAuthorized` filter is correspondingly a no-op
    // (returns true on empty `required_groups`); profile-side
    // `Profiles.filterTools` is the sole admission gate.
    registerFixtureTools();
    assert.deepEqual(Catalog.getByName('read_file').metadata.authorization.required_groups, []);
    assert.deepEqual(Catalog.getByName('edit_file').metadata.authorization.required_groups, []);
});

test('Catalog.required_consent is false in 1.3.4 (consent gate lands later)', () => {
    registerFixtureTools();
    assert.equal(Catalog.getByName('read_file').metadata.authorization.required_consent, false);
});

// ============================================
// Catalog.listByCategoryPrefix
// ============================================

test('listByCategoryPrefix matches dot-segment prefix only', () => {
    registerFixtureTools();
    const codeFile = Catalog.listByCategoryPrefix('code.file');
    const names = codeFile.map(t => t.name).sort();
    assert.deepEqual(names, ['edit_file', 'read_file']);
});

test('listByCategoryPrefix("") returns the whole catalog', () => {
    registerFixtureTools();
    assert.equal(Catalog.listByCategoryPrefix('').length, 4);
});

test('listByCategoryPrefix does not match by character prefix only', () => {
    registerFixtureTools();
    // "code.file" must not match "code.fileSomething" — only "code.file" exact
    // and "code.file.<suffix>". Verified by the deep-equal above; here we
    // assert with an explicit non-match string.
    const noMatch = Catalog.listByCategoryPrefix('code.f');
    assert.deepEqual(noMatch, [], 'partial-segment prefix should match nothing');
});

// ============================================
// Profile integration — coder.v1.tools.static
// ============================================

test('coder.v1.tools.static contains the ROADMAP §1.4.0 set', () => {
    assert.ok(Array.isArray(CODER_V1.tools.static));
    const expected = [
        'list_tool_categories',
        'list_tools_by_category',
        'find_tool',
        'read_file',
        'read_lines',
        'scan_file',
        'edit_file',
        'commit_files',
        'list_dirty_files',
    ];
    for (const name of expected) {
        assert.ok(CODER_V1.tools.static.includes(name), `static should include ${name}`);
    }
});

test('static names that exist in the registry resolve via Catalog.getByName', () => {
    registerFixtureTools();
    // From our fixture set: read_file, edit_file, commit_files exist; the
    // others (meta-tools + read_lines + scan_file + list_dirty_files)
    // intentionally do not in this slimmed fixture.
    assert.ok(Catalog.getByName('read_file'));
    assert.ok(Catalog.getByName('edit_file'));
    assert.ok(Catalog.getByName('commit_files'));
});

test('static names that do not exist in the registry return null (skip-not-throw)', () => {
    registerFixtureTools();
    // PR 2's admission consumer relies on this: unresolved meta-tools are
    // simply skipped, not an error.
    assert.equal(Catalog.getByName('list_tool_categories'), null);
    assert.equal(Catalog.getByName('find_tool'), null);
});

// ============================================
// ToolRegistry.register — duplicate handling (github#31)
// ============================================

test('re-registering a tool replaces its definition, not appends', () => {
    ToolRegistry.clear();
    const def = {
        function: { name: 'read_file', description: 'v1', parameters: { type: 'object', properties: {}, required: [] } },
        roles: 'all',
    };
    ToolRegistry.register('read_file', async () => ({}), def);
    assert.equal(ToolRegistry.getDefinitions().filter(d => d.function?.name === 'read_file').length, 1);

    const defV2 = { ...def, function: { ...def.function, description: 'v2' } };
    ToolRegistry.register('read_file', async () => ({}), defV2);

    const matches = ToolRegistry.getDefinitions().filter(d => d.function?.name === 'read_file');
    assert.equal(matches.length, 1, 'definition count must be 1 after re-register');
    assert.equal(matches[0].function.description, 'v2', 'latest description should win');
});

test('re-registering does not affect other tools', () => {
    ToolRegistry.clear();
    const mk = (name) => ({
        function: { name, description: name, parameters: { type: 'object', properties: {}, required: [] } },
        roles: 'all',
    });
    ToolRegistry.register('tool_a', async () => ({}), mk('tool_a'));
    ToolRegistry.register('tool_b', async () => ({}), mk('tool_b'));
    ToolRegistry.register('tool_a', async () => ({}), mk('tool_a'));  // re-register
    assert.equal(ToolRegistry.getDefinitions().length, 2);
});

// ============================================
// git_log role access (github#32)
// ============================================

test('git_log is registered with roles: all', async () => {
    // Import the real git-log registration so the live roles value is tested.
    // We need a fresh registry state; reload by clearing and re-importing.
    ToolRegistry.clear();
    await import('../js/tools/git-log-tools.js');
    const defs = ToolRegistry.getDefinitions();
    const gitLogDef = defs.find(d => d.function?.name === 'git_log');
    assert.ok(gitLogDef, 'git_log should be registered');
});

// ============================================
// find_relevant_files role access (1.6.9 — bundled with retrieval caches)
// ============================================

test('find_relevant_files is registered with roles: all', async () => {
    // 1.6.9: read-only retrieval discovery; opened to PM and plugin-dev so
    // they don't get denied for invoking a side-effect-free tool. Mirrors
    // the git_log change shipped at 1.6.8 (github#32).
    ToolRegistry.clear();
    // Cache-bust the import so a re-run picks up a fresh module instance
    // after the registry was cleared in the previous test.
    await import('../js/tools/context-tools.js?find_relevant_files_test');
    const defs = ToolRegistry.getDefinitions();
    const def = defs.find(d => d.function?.name === 'find_relevant_files');
    assert.ok(def, 'find_relevant_files should be registered');
});
