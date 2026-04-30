/**
 * File-layer tests for js/intelligence/memory/file-layer.js. Pure
 * serialize/parse functions are tested directly; the lifecycle paths
 * (enable/disable, mutation subscription, initial flush, loadFromGit)
 * exercise the real store backed by `createMemoryFakeIDB()`.
 *
 * Pattern mirrors `tests/test-memory-store.mjs` (PR #2).
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    // Store surface
    create, list, softDelete, supersede, getById,
    // File-layer surface
    serialize, serializeIndex, parse,
    enable, disable, loadFromGit,
    getPendingContent, listPendingPaths, getDiagnostics, clearDiagnostics,
    isEnabled, getActiveWorkspaceId,
    categoryPath, indexPath,
    // Constants
    MEMORY_CATEGORIES,
    // Test seams
    _setIDBImpl, _resetIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
    _setGitClientForTests, _resetFileLayerForTests,
} from '../js/intelligence/memory/index.js';

const WS = 'gitea:xcaliber/ai-editor';

function wsInput(over = {}) {
    return {
        scope: 'workspace',
        owner_id_or_workspace_id: WS,
        key: 'preferred_test_runner',
        value: 'node:test',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:jeff',
        actor: 'user:jeff',
        ...over,
    };
}

function userInput(over = {}) {
    return {
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        key: 'pref',
        value: 'rust',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'jeff',
        actor: 'jeff',
        ...over,
    };
}

let fake;

beforeEach(() => {
    fake = createMemoryFakeIDB();
    _setIDBImpl(fake);
    _resetMutexForTests();
    _resetFileLayerForTests();
});

/* ============================================================ */
/* Pure: paths                                                  */
/* ============================================================ */

test('categoryPath returns .aieditor/memory/<category>.md', () => {
    assert.equal(categoryPath('preferences'), '.aieditor/memory/preferences.md');
    assert.equal(categoryPath('decisions'), '.aieditor/memory/decisions.md');
    assert.equal(categoryPath('project_context'), '.aieditor/memory/project_context.md');
    assert.equal(categoryPath('domain_knowledge'), '.aieditor/memory/domain_knowledge.md');
    assert.equal(categoryPath('workflow'), '.aieditor/memory/workflow.md');
});

test('categoryPath returns null for unknown category', () => {
    assert.equal(categoryPath('persona'), null);  // explicitly dropped
    assert.equal(categoryPath(''), null);
    assert.equal(categoryPath('not_a_category'), null);
});

test('indexPath returns .aieditor/memory/index.md', () => {
    assert.equal(indexPath(), '.aieditor/memory/index.md');
});

/* ============================================================ */
/* Pure: serialize + parse round-trip                           */
/* ============================================================ */

test('serialize → parse round-trips a single record', () => {
    const rec = {
        id: 'abc-123',
        scope: 'workspace',
        owner_id_or_workspace_id: WS,
        key: 'preferred_test_runner',
        value: 'node:test',
        category: 'preferences',
        source: 'user_explicit',
        embedding: null,
        embedding_model_id: '',
        created_at: 1714464000000,
        updated_at: 1714464000000,
        created_by: 'user:jeff',
        actor: 'user:jeff',
        superseded_by: null,
        expires_at: null,
        md_path: '.aieditor/memory/preferences.md',
    };
    const md = serialize([rec]);
    const { records, warnings } = parse(md);
    assert.equal(warnings.length, 0);
    assert.equal(records.length, 1);
    const got = records[0];
    assert.equal(got.id, rec.id);
    assert.equal(got.key, rec.key);
    assert.equal(got.value, rec.value);
    assert.equal(got.scope, rec.scope);
    assert.equal(got.created_at, rec.created_at);
    assert.equal(got.updated_at, rec.updated_at);
    assert.equal(got.actor, rec.actor);
    assert.equal(got.source, rec.source);
    assert.equal(got.superseded_by, null);
    assert.equal(got.expires_at, null);
});

test('serialize → parse round-trips multiple records', () => {
    const recs = [
        {
            id: 'aaa', scope: 'workspace', owner_id_or_workspace_id: WS,
            key: 'beta', value: 'v2', category: 'preferences', source: 'user_explicit',
            embedding: null, embedding_model_id: '',
            created_at: 1, updated_at: 1, created_by: 'u', actor: 'u',
            superseded_by: null, expires_at: null, md_path: '.aieditor/memory/preferences.md',
        },
        {
            id: 'bbb', scope: 'workspace', owner_id_or_workspace_id: WS,
            key: 'alpha', value: 'v1', category: 'preferences', source: 'agent_proposed',
            embedding: null, embedding_model_id: '',
            created_at: 2, updated_at: 2, created_by: 'agent', actor: 'agent',
            superseded_by: null, expires_at: null, md_path: '.aieditor/memory/preferences.md',
        },
    ];
    const md = serialize(recs);
    const { records, warnings } = parse(md);
    assert.equal(warnings.length, 0);
    assert.equal(records.length, 2);
    // Sorted by key in serialization → alpha first, beta second.
    assert.equal(records[0].key, 'alpha');
    assert.equal(records[1].key, 'beta');
});

test('serialize → parse round-trips structured (object) values', () => {
    const rec = {
        id: 'obj-1', scope: 'workspace', owner_id_or_workspace_id: WS,
        key: 'config', value: { theme: 'dark', tabSize: 4, plugins: ['vim', 'lint'] },
        category: 'preferences', source: 'user_explicit',
        embedding: null, embedding_model_id: '',
        created_at: 1, updated_at: 1, created_by: 'u', actor: 'u',
        superseded_by: null, expires_at: null, md_path: '.aieditor/memory/preferences.md',
    };
    const md = serialize([rec]);
    const { records } = parse(md);
    assert.deepEqual(records[0].value, rec.value);
});

test('serialize round-trips strings with quotes, newlines, unicode', () => {
    const rec = {
        id: 'esc-1', scope: 'workspace', owner_id_or_workspace_id: WS,
        key: 'tricky', value: 'has "quotes" and\nnewlines and 日本語',
        category: 'preferences', source: 'user_explicit',
        embedding: null, embedding_model_id: '',
        created_at: 1, updated_at: 1, created_by: 'u:tricky"name', actor: 'u:tricky"name',
        superseded_by: null, expires_at: null, md_path: '.aieditor/memory/preferences.md',
    };
    const md = serialize([rec]);
    const { records, warnings } = parse(md);
    assert.equal(warnings.length, 0);
    assert.equal(records[0].value, rec.value);
    assert.equal(records[0].created_by, rec.created_by);
});

/* ============================================================ */
/* Pure: determinism                                            */
/* ============================================================ */

test('serialize is deterministic (byte-identical output for same input)', () => {
    const recs = [
        {
            id: 'aaa', scope: 'workspace', owner_id_or_workspace_id: WS,
            key: 'gamma', value: 'g', category: 'preferences', source: 'user_explicit',
            embedding: null, embedding_model_id: '',
            created_at: 1, updated_at: 1, created_by: 'u', actor: 'u',
            superseded_by: null, expires_at: null, md_path: null,
        },
        {
            id: 'bbb', scope: 'workspace', owner_id_or_workspace_id: WS,
            key: 'alpha', value: 'a', category: 'preferences', source: 'user_explicit',
            embedding: null, embedding_model_id: '',
            created_at: 2, updated_at: 2, created_by: 'u', actor: 'u',
            superseded_by: null, expires_at: null, md_path: null,
        },
        {
            id: 'ccc', scope: 'workspace', owner_id_or_workspace_id: WS,
            key: 'beta', value: 'b', category: 'preferences', source: 'user_explicit',
            embedding: null, embedding_model_id: '',
            created_at: 3, updated_at: 3, created_by: 'u', actor: 'u',
            superseded_by: null, expires_at: null, md_path: null,
        },
    ];
    const md1 = serialize(recs);
    const md2 = serialize([...recs].reverse());  // different input order
    assert.equal(md1, md2, 'output must not depend on input order');
});

test('serialize produces empty string for empty input', () => {
    assert.equal(serialize([]), '');
    assert.equal(serialize(null), '');
});

/* ============================================================ */
/* Pure: conflict resolution                                    */
/* ============================================================ */

test('parse resolves duplicate keys by latest updated_at; emits warning', () => {
    const recOlder = {
        id: 'old-id', scope: 'workspace', owner_id_or_workspace_id: WS,
        key: 'dup_key', value: 'v_old', category: 'preferences', source: 'user_explicit',
        embedding: null, embedding_model_id: '',
        created_at: 1000, updated_at: 1000, created_by: 'u', actor: 'u',
        superseded_by: null, expires_at: null, md_path: null,
    };
    const recNewer = {
        ...recOlder, id: 'new-id', value: 'v_new', updated_at: 2000,
    };
    // Manually concatenate (simulating a merge artifact).
    const md = serialize([recOlder]) + '\n' + serialize([recNewer]);
    const { records, warnings } = parse(md);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'new-id', 'newer updated_at wins');
    assert.equal(records[0].value, 'v_new');
    const dups = warnings.filter((w) => w.type === 'duplicate_key');
    assert.equal(dups.length, 1);
    assert.equal(dups[0].kept, 'new-id');
    assert.equal(dups[0].dropped, 'old-id');
});

test('parse keeps well-formed blocks when one block is malformed', () => {
    const goodRec = {
        id: 'good', scope: 'workspace', owner_id_or_workspace_id: WS,
        key: 'good_key', value: 'v', category: 'preferences', source: 'user_explicit',
        embedding: null, embedding_model_id: '',
        created_at: 1, updated_at: 1, created_by: 'u', actor: 'u',
        superseded_by: null, expires_at: null, md_path: null,
    };
    const goodMd = serialize([goodRec]);
    // Inject a malformed block — body that's not valid JSON.
    const malformed = '---\nid: "bad"\nkey: "broken"\n---\n{unclosed json\n';
    const md = goodMd + '\n' + malformed;
    const { records, warnings } = parse(md);
    assert.equal(records.length, 1);
    assert.equal(records[0].id, 'good');
    assert.ok(warnings.some((w) => w.type === 'malformed_body' || w.type === 'validation_failed'));
});

test('parse skips records that fail validation (e.g. invalid scope)', () => {
    const md = [
        '---',
        'actor: "u"',
        'category: "preferences"',
        'created_at: 1',
        'created_by: "u"',
        'expires_at: null',
        'id: "x"',
        'key: "k"',
        'md_path: null',
        'owner_id_or_workspace_id: "w"',
        'scope: "persona"',  // invalid — Phase 1 dropped persona
        'source: "user_explicit"',
        'superseded_by: null',
        'updated_at: 1',
        '---',
        '"v"',
        '',
    ].join('\n');
    const { records, warnings } = parse(md);
    assert.equal(records.length, 0);
    assert.ok(warnings.some((w) => w.type === 'validation_failed'));
});

test('parse handles empty content gracefully', () => {
    assert.deepEqual(parse(''), { records: [], warnings: [] });
    assert.deepEqual(parse('   \n\n  '), { records: [], warnings: [] });
});

/* ============================================================ */
/* store md_path defaulting (PR #3 store.js change)             */
/* ============================================================ */

test('store.create populates md_path for workspace-scope records', async () => {
    const rec = await create(wsInput({ category: 'decisions' }));
    assert.equal(rec.md_path, '.aieditor/memory/decisions.md');
});

test('store.create leaves md_path null for user-scope records', async () => {
    const rec = await create(userInput());
    assert.equal(rec.md_path, null);
});

test('store.create respects explicit md_path override', async () => {
    const rec = await create(wsInput({ md_path: '.aieditor/memory/custom.md' }));
    assert.equal(rec.md_path, '.aieditor/memory/custom.md');
});

test('store.supersede populates md_path on the new workspace-scope head', async () => {
    const a = await create(wsInput());
    const { new: b } = await supersede(a.id, wsInput({ value: 'changed', category: 'decisions' }));
    assert.equal(b.md_path, '.aieditor/memory/decisions.md');
});

/* ============================================================ */
/* Lifecycle: enable / disable                                  */
/* ============================================================ */

test('enable activates the layer; disable clears state', async () => {
    assert.equal(isEnabled(), false);
    assert.equal(getActiveWorkspaceId(), null);
    await enable(WS);
    assert.equal(isEnabled(), true);
    assert.equal(getActiveWorkspaceId(), WS);
    disable();
    assert.equal(isEnabled(), false);
    assert.equal(getActiveWorkspaceId(), null);
    assert.equal(listPendingPaths().length, 0);
});

test('enable rejects empty workspaceId', async () => {
    await assert.rejects(() => enable(''), /workspaceId must be a non-empty string/);
    await assert.rejects(() => enable(null), /workspaceId must be a non-empty string/);
});

test('enable is idempotent for the same workspace', async () => {
    await enable(WS);
    await enable(WS);  // no throw
    assert.equal(isEnabled(), true);
});

test('enable refuses to switch workspaces without explicit disable', async () => {
    await enable(WS);
    await assert.rejects(() => enable('other:ws'), /disable\(\) before switching/);
});

/* ============================================================ */
/* Lifecycle: initial flush on enable                           */
/* ============================================================ */

test('enable flushes existing workspace records to pending content', async () => {
    await create(wsInput({ key: 'a', value: 'va' }));
    await create(wsInput({ key: 'b', value: 'vb', category: 'decisions' }));
    await create(userInput({ key: 'should_skip' }));  // user-scope — should not project

    await enable(WS);

    const prefsPath = categoryPath('preferences');
    const decisionsPath = categoryPath('decisions');
    const prefsContent = getPendingContent(prefsPath);
    const decisionsContent = getPendingContent(decisionsPath);

    assert.ok(prefsContent && prefsContent.includes('"a"'), 'preferences.md should hold the a record');
    assert.ok(decisionsContent && decisionsContent.includes('"b"'), 'decisions.md should hold the b record');

    // Index regenerates with non-zero categories.
    const idx = getPendingContent(indexPath());
    assert.ok(idx && idx.includes('preferences.md'));
    assert.ok(idx && idx.includes('decisions.md'));
});

test('enable on an empty workspace produces no pending content', async () => {
    await enable(WS);
    assert.equal(listPendingPaths().length, 0);
});

test('re-enabling against an already-projected workspace is a no-op (deterministic content)', async () => {
    await create(wsInput({ key: 'a', value: 'va' }));
    await enable(WS);
    const before = getPendingContent(categoryPath('preferences'));
    disable();
    await enable(WS);
    const after = getPendingContent(categoryPath('preferences'));
    assert.equal(after, before, 'serialization must be byte-identical across enable cycles');
});

/* ============================================================ */
/* Mutation subscription                                        */
/* ============================================================ */

test('workspace-scope create event regenerates the affected category file', async () => {
    await enable(WS);
    assert.equal(getPendingContent(categoryPath('preferences')), null);
    await create(wsInput({ key: 'fresh', value: 'v' }));
    const content = getPendingContent(categoryPath('preferences'));
    assert.ok(content && content.includes('"fresh"'));
    assert.ok(content.includes('"v"'));
});

test('user-scope event does NOT trigger a write', async () => {
    await enable(WS);
    await create(userInput({ key: 'usr_only' }));
    assert.equal(listPendingPaths().length, 0);
});

test('event for a different workspace does NOT trigger a write', async () => {
    await enable(WS);
    await create(wsInput({ owner_id_or_workspace_id: 'other:ws', key: 'k' }));
    assert.equal(listPendingPaths().length, 0);
});

test('softDelete event regenerates the file (record removed)', async () => {
    await create(wsInput({ key: 'k1' }));
    await create(wsInput({ key: 'k2', category: 'decisions' }));
    await enable(WS);
    const a = await create(wsInput({ key: 'k3' }));
    let content = getPendingContent(categoryPath('preferences'));
    assert.ok(content && content.includes('"k3"'));
    await softDelete(a.id, { actor: 'u' });
    content = getPendingContent(categoryPath('preferences'));
    assert.ok(content && !content.includes('"k3"'));
});

test('disable unsubscribes — subsequent mutations do not regenerate', async () => {
    await enable(WS);
    await create(wsInput({ key: 'before_disable' }));
    assert.ok(getPendingContent(categoryPath('preferences')));
    disable();
    await create(wsInput({ key: 'after_disable' }));
    assert.equal(getPendingContent(categoryPath('preferences')), null,
        'no listener active → no pending content');
});

/* ============================================================ */
/* loadFromGit                                                  */
/* ============================================================ */

test('loadFromGit reads via injected client and seeds the store', async () => {
    // Pre-build markdown content for one record.
    const seedRec = {
        id: 'seed-1', scope: 'workspace', owner_id_or_workspace_id: WS,
        key: 'seeded', value: 'from_disk', category: 'preferences', source: 'user_explicit',
        embedding: null, embedding_model_id: '',
        created_at: 1, updated_at: 1, created_by: 'u', actor: 'u',
        superseded_by: null, expires_at: null, md_path: '.aieditor/memory/preferences.md',
    };
    const md = serialize([seedRec]);

    const fakeGit = {
        async getFile(owner, repo, path) {
            if (path === '.aieditor/memory/preferences.md') return { content: md };
            const err = new Error('404');
            throw err;
        },
    };

    await enable(WS);
    const result = await loadFromGit({ owner: 'xcaliber', repo: 'ai-editor', branch: 'main', gitClient: fakeGit });
    assert.equal(result.seeded, 1);
    assert.equal(result.skipped, 0);

    // The store now has a record with key=seeded; id will be fresh (see file-layer comment).
    const records = await list({ scope: 'workspace', owner_id_or_workspace_id: WS, category: 'preferences' });
    const seeded = records.find((r) => r.key === 'seeded');
    assert.ok(seeded, 'record was seeded into the store');
    assert.equal(seeded.value, 'from_disk');
});

test('loadFromGit accumulates parse warnings into diagnostics', async () => {
    const malformed = '---\nid: "x"\nscope: "workspace"\n---\n{not_json\n';
    const fakeGit = {
        async getFile(owner, repo, path) {
            if (path === '.aieditor/memory/preferences.md') return { content: malformed };
            throw new Error('404');
        },
    };
    await enable(WS);
    const result = await loadFromGit({ owner: 'x', repo: 'r', gitClient: fakeGit });
    assert.equal(result.seeded, 0);
    assert.ok(result.warnings >= 1);
    const diag = getDiagnostics();
    assert.ok(diag.warnings.length >= 1);
});

test('loadFromGit treats getFile errors as "file absent" (no warning)', async () => {
    const fakeGit = {
        async getFile() { throw new Error('404 Not Found'); },
    };
    await enable(WS);
    const result = await loadFromGit({ owner: 'x', repo: 'r', gitClient: fakeGit });
    assert.equal(result.seeded, 0);
    assert.equal(result.warnings, 0);
});

test('loadFromGit refuses when not enabled', async () => {
    await assert.rejects(
        () => loadFromGit({ owner: 'x', repo: 'r', gitClient: { getFile: async () => ({}) } }),
        /enable\(workspaceId\) must be called first/,
    );
});

/* ============================================================ */
/* Diagnostics                                                  */
/* ============================================================ */

test('clearDiagnostics empties the warnings buffer', async () => {
    const malformed = '---\nbad\n';
    const fakeGit = {
        async getFile(owner, repo, path) {
            if (path === '.aieditor/memory/preferences.md') return { content: malformed };
            throw new Error('404');
        },
    };
    await enable(WS);
    await loadFromGit({ owner: 'x', repo: 'r', gitClient: fakeGit });
    assert.ok(getDiagnostics().warnings.length > 0);
    clearDiagnostics();
    assert.equal(getDiagnostics().warnings.length, 0);
});

/* ============================================================ */
/* Index regeneration                                           */
/* ============================================================ */

test('serializeIndex omits zero-count categories and includes counts', () => {
    const out = serializeIndex({ preferences: 3, decisions: 1, project_context: 0 });
    assert.ok(out.includes('preferences.md'));
    assert.ok(out.includes('3 records'));
    assert.ok(out.includes('decisions.md'));
    assert.ok(out.includes('1 record'));
    assert.ok(!out.includes('project_context.md'));
});

test('index regenerates after a mutation reaches a new category', async () => {
    await enable(WS);
    await create(wsInput({ key: 'a', category: 'preferences' }));
    let idx = getPendingContent(indexPath());
    assert.ok(idx && idx.includes('preferences.md'));
    assert.ok(idx && !idx.includes('decisions.md'));

    await create(wsInput({ key: 'b', category: 'decisions' }));
    idx = getPendingContent(indexPath());
    assert.ok(idx && idx.includes('preferences.md'));
    assert.ok(idx && idx.includes('decisions.md'));
});
