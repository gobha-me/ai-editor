/**
 * Tests for js/tools/memory-tools.js — the three LLM tools that wrap the
 * memory subsystem. Mirrors the boot pattern in test-memory-store.mjs:
 * IDB swapped for the `createMemoryFakeIDB()` fake; KeyMutex resets each
 * test. Embeddings are injected via `_setEmbeddingsClientForTests()`;
 * workspace id via `_setWorkspaceIdForTests()`.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    audit,
    getById,
    softDelete,
    _setIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
} from '../js/intelligence/memory/index.js';
import { State } from '../js/core.js';
import { ToolRegistry } from '../js/tools/registry.js';
import {
    registerMemoryTools,
    _setEmbeddingsClientForTests,
    _setWorkspaceIdForTests,
    _resetMemoryToolsForTests,
} from '../js/tools/memory-tools.js';

/* ============================================================ */
/* Test harness                                                 */
/* ============================================================ */

let stub;
let stubCalls;

function freshRegistry() {
    ToolRegistry.clear();
    registerMemoryTools(ToolRegistry);
    return ToolRegistry;
}

beforeEach(() => {
    _setIDBImpl(createMemoryFakeIDB());
    _resetMutexForTests();
    _resetMemoryToolsForTests();

    stubCalls = [];
    stub = {
        embed: async (text) => { stubCalls.push(text); return [1, 0, 0]; },
        isEnabled: () => true,
    };
    _setEmbeddingsClientForTests(stub);
    _setWorkspaceIdForTests('ws-test');

    // Stable user id for predictable assertions.
    if (typeof globalThis.localStorage !== 'undefined') {
        globalThis.localStorage.clear();
    }

    // Default role/model for the audit-format assertions. `coder` —
    // memory tools are most associated with the coder workflow and the
    // The active profile must be one of the surfaces registered for
    // `memory_remember`. Picking `coder.v1` also keeps the post-1.18.0
    // default scope at `'workspace'` (chat-side profiles default to
    // `'user'` per chat.v1.memory.default_scope; tests would otherwise
    // need explicit `scope: 'workspace'` on every admit).
    // 2.0.0 — slice 3: profile-keyed (was role-keyed pre-2.0.0).
    State.settings = State.settings || {};
    State.settings.profile = 'coder.v1';
    State.settings.llmModel = 'opus-test';
    State.settings.embeddingModel = 'stub-model';
    State.scratchpad = {};
});

/* ============================================================ */
/* memory_remember                                              */
/* ============================================================ */

test('memory_remember happy path → action=created, record persisted, audit shows actor agent:<model>', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'test_runner', value: 'Vitest', category: 'decisions', source: 'user_explicit', reason: 'user said so',
    });
    assert.equal(out.success, true);
    assert.equal(out.action, 'created');
    assert.equal(out.scope, 'workspace');
    assert.equal(out.embedded, true);

    const rec = await getById(out.id);
    assert.equal(rec.value, 'Vitest');
    assert.equal(rec.category, 'decisions');
    assert.equal(rec.source, 'user_explicit');
    assert.equal(rec.scope, 'workspace');
    assert.equal(rec.owner_id_or_workspace_id, 'ws-test');
    assert.equal(rec.md_path, '.aieditor/memory/decisions.md');

    const entries = await audit.listForRecord(out.id);
    assert.equal(entries[0].action, 'create');
    assert.equal(entries[0].actor, 'agent:opus-test');
    assert.equal(entries[0].reason, 'user said so');
});

test('memory_remember idempotent on same (scope, owner, key) → action=superseded, two records in store', async () => {
    const reg = freshRegistry();
    const a = await reg.execute('memory_remember', {
        key: 'lang', value: 'rust', category: 'preferences', source: 'user_explicit',
    });
    const b = await reg.execute('memory_remember', {
        key: 'lang', value: 'go', category: 'preferences', source: 'user_explicit', reason: 'changed mind',
    });
    assert.equal(a.action, 'created');
    assert.equal(b.action, 'superseded');
    assert.equal(b.superseded_id, a.id);

    const oldRec = await getById(a.id);
    assert.equal(oldRec.superseded_by, b.id);

    const newRec = await getById(b.id);
    assert.equal(newRec.value, 'go');
    assert.equal(newRec.superseded_by, null);
});

test('memory_remember defaults: scope→workspace, source→agent_proposed → returns pending_consent (PR #6)', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow',
    });
    // PR #6 contract: agent_proposed (the default source) defers durability
    // to user consent. The tool returns a candidate id and writes nothing.
    assert.equal(out.status, 'pending_consent');
    assert.equal(typeof out.candidate_id, 'string');
    assert.ok(out.candidate_id.length > 0);
    assert.equal(out.scope, 'workspace');
    assert.equal(out.source, 'agent_proposed');
    // No record exists; consent flow has to resolve the candidate first.
    assert.equal(out.id, undefined);
});

test("1.18.0 — memory_remember default scope follows the active profile (role='full' → chat.v1 → 'user')", async () => {
    // Pre-1.18.0 the default was a hardcoded `'workspace'` for every
    // profile. 1.18.0 routes the default through `resolveMemoryConfig`:
    // coder.v1 → clamp(`'session'`) = `'workspace'`; non-coder profiles
    // (`full.v1`, `pm.v1`, `reviewer.v1`) inherit `chat.v1` = `'user'`.
    // This is the explicit regression test for the user-visible change
    // called out in CHANGELOG §1.18.0.
    // 2.0.0 — slice 3: profile-keyed (was role-keyed pre-2.0.0).
    State.settings.profile = 'full.v1';
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow', source: 'user_explicit',
    });
    assert.equal(out.success, true);
    assert.equal(out.scope, 'user');
});

test('memory_remember with scope=workspace and no active workspace → actionable error', async () => {
    _setWorkspaceIdForTests(null);
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow', scope: 'workspace',
    });
    assert.ok(out.error);
    assert.match(out.error, /workspace memory requires an active project/);
});

test('memory_remember rejects invalid category with enum-listing error', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'nonsense',
    });
    assert.ok(out.error);
    assert.match(out.error, /category must be one of/);
});

test('memory_remember rejects invalid source', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow', source: 'made_up',
    });
    assert.ok(out.error);
    assert.match(out.error, /source must be one of/);
});

test('memory_remember rejects scope=persona with helpful message about the kickoff drop', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow', scope: 'persona',
    });
    assert.ok(out.error);
    assert.match(out.error, /persona/);
    assert.match(out.error, /1\.3\.0/);
});

test('memory_remember when embed() returns null still persists the record with embedded:false', async () => {
    stub.embed = async () => null;
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow', source: 'user_explicit',
    });
    assert.equal(out.success, true);
    assert.equal(out.embedded, false);

    const rec = await getById(out.id);
    assert.equal(rec.embedding, null);
});

test('memory_remember with user scope uses Storage(memoryUserId) as owner', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'preferences', scope: 'user', source: 'user_explicit',
    });
    const rec = await getById(out.id);
    assert.equal(rec.scope, 'user');
    assert.ok(typeof rec.owner_id_or_workspace_id === 'string' && rec.owner_id_or_workspace_id.length > 0);
    // user-scope records do NOT auto-populate md_path
    assert.equal(rec.md_path, null);
});

/* ============================================================ */
/* memory_recall                                                */
/* ============================================================ */

test('memory_recall with query → searchSemantic path, ranked by similarity', async () => {
    const reg = freshRegistry();
    // Seed three workspace memories with distinct embeddings.
    stub.embed = async (text) => {
        if (text.startsWith('rust')) return [1, 0, 0];
        if (text.startsWith('go')) return [0, 1, 0];
        return [0, 0, 1];
    };
    await reg.execute('memory_remember', { key: 'rust', value: 'rust lang', category: 'preferences', source: 'user_explicit' });
    await reg.execute('memory_remember', { key: 'go', value: 'go lang', category: 'preferences', source: 'user_explicit' });
    await reg.execute('memory_remember', { key: 'zig', value: 'zig lang', category: 'preferences', source: 'user_explicit' });

    // Query embedding aligns with rust.
    stub.embed = async (text) => {
        if (text === 'rust query') return [1, 0, 0];
        return [0, 0, 0];
    };
    const out = await reg.execute('memory_recall', { query: 'rust query', scope: 'workspace' });
    assert.equal(out.success, true);
    assert.ok(out.count >= 1);
    assert.equal(out.results[0].key, 'rust');
});

test('memory_recall without query → list path, sorted by updated_at desc', async () => {
    const reg = freshRegistry();
    await reg.execute('memory_remember', { key: 'first', value: '1', category: 'workflow', source: 'user_explicit' });
    await new Promise((r) => setTimeout(r, 5));
    await reg.execute('memory_remember', { key: 'second', value: '2', category: 'workflow', source: 'user_explicit' });

    const out = await reg.execute('memory_recall', { scope: 'workspace' });
    assert.equal(out.success, true);
    assert.equal(out.count, 2);
    assert.equal(out.results[0].key, 'second');
    assert.equal(out.results[1].key, 'first');
});

test("memory_recall scope='all' merges results from both user and workspace", async () => {
    const reg = freshRegistry();
    await reg.execute('memory_remember', { key: 'k_user', value: 'u', category: 'preferences', scope: 'user', source: 'user_explicit' });
    await reg.execute('memory_remember', { key: 'k_ws', value: 'w', category: 'preferences', scope: 'workspace', source: 'user_explicit' });

    const out = await reg.execute('memory_recall', { scope: 'all' });
    assert.equal(out.success, true);
    assert.equal(out.count, 2);
    const keys = out.results.map((r) => r.key).sort();
    assert.deepEqual(keys, ['k_user', 'k_ws']);
});

test('memory_recall scope=workspace with no active workspace → success but empty + note', async () => {
    _setWorkspaceIdForTests(null);
    const reg = freshRegistry();
    const out = await reg.execute('memory_recall', { scope: 'workspace' });
    assert.equal(out.success, true);
    assert.equal(out.count, 0);
    assert.equal(out.note, 'no_workspace_active');
});

test('memory_recall query falls back to list when query embedding returns null', async () => {
    const reg = freshRegistry();
    await reg.execute('memory_remember', { key: 'k1', value: 'v1', category: 'workflow', source: 'user_explicit' });

    stub.embed = async () => null;
    const out = await reg.execute('memory_recall', { query: 'anything', scope: 'workspace' });
    assert.equal(out.success, true);
    assert.equal(out.count, 1);
    assert.match(out.note || '', /embeddings_unavailable/);
});

test('memory_recall category filter restricts results', async () => {
    const reg = freshRegistry();
    await reg.execute('memory_remember', { key: 'a', value: '1', category: 'preferences', source: 'user_explicit' });
    await reg.execute('memory_remember', { key: 'b', value: '2', category: 'workflow', source: 'user_explicit' });

    const out = await reg.execute('memory_recall', { scope: 'workspace', category: 'workflow' });
    assert.equal(out.count, 1);
    assert.equal(out.results[0].key, 'b');
});

test('memory_recall limit clamps result count', async () => {
    const reg = freshRegistry();
    for (let i = 0; i < 5; i++) {
        await reg.execute('memory_remember', { key: `k${i}`, value: String(i), category: 'workflow', source: 'user_explicit' });
    }
    const out = await reg.execute('memory_recall', { scope: 'workspace', limit: 2 });
    assert.equal(out.count, 2);
});

/* ============================================================ */
/* memory_revise                                                */
/* ============================================================ */

test('memory_revise patches value in place and re-embeds', async () => {
    const reg = freshRegistry();
    const created = await reg.execute('memory_remember', {
        key: 'k', value: 'old', category: 'workflow', source: 'user_explicit',
    });

    stubCalls.length = 0;
    const out = await reg.execute('memory_revise', {
        id: created.id, value: 'new', reason: 'corrected',
    });
    assert.equal(out.success, true);
    assert.equal(out.id, created.id);

    const rec = await getById(created.id);
    assert.equal(rec.value, 'new');
    // Re-embed sees the canonical-text format `key: value`
    assert.ok(stubCalls.some((t) => t.includes('new')));
});

test('memory_revise can change source without touching value', async () => {
    const reg = freshRegistry();
    // Seed with `inferred` (bypasses the consent queue per PR #6) so we
    // have a real record id; revise to `user_explicit`, the realistic
    // upgrade path when an inferred fact gets confirmed.
    const created = await reg.execute('memory_remember', {
        key: 'k', value: 'kept', category: 'workflow', source: 'inferred',
    });
    const out = await reg.execute('memory_revise', {
        id: created.id, source: 'user_explicit', reason: 'user confirmed',
    });
    assert.equal(out.success, true);
    const rec = await getById(created.id);
    assert.equal(rec.value, 'kept');
    assert.equal(rec.source, 'user_explicit');
});

test('memory_revise on unknown id returns "not found" error', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_revise', {
        id: 'does-not-exist', value: 'x', reason: 'nope',
    });
    assert.ok(out.error);
    assert.match(out.error, /not found/i);
});

test('memory_revise on superseded record returns guidance to use memory_recall', async () => {
    const reg = freshRegistry();
    const a = await reg.execute('memory_remember', { key: 'k', value: '1', category: 'workflow', source: 'user_explicit' });
    await softDelete(a.id, { actor: 'tester' });
    const out = await reg.execute('memory_revise', {
        id: a.id, value: '2', reason: 'after delete',
    });
    assert.ok(out.error);
    assert.match(out.error, /superseded/i);
});

test('memory_revise without reason is rejected', async () => {
    const reg = freshRegistry();
    const created = await reg.execute('memory_remember', { key: 'k', value: 'v', category: 'workflow', source: 'user_explicit' });
    const out = await reg.execute('memory_revise', { id: created.id, value: 'v2' });
    assert.ok(out.error);
    assert.match(out.error, /reason is required/);
});

test('memory_revise with no field changes is rejected (id+reason alone is a no-op)', async () => {
    const reg = freshRegistry();
    const created = await reg.execute('memory_remember', { key: 'k', value: 'v', category: 'workflow', source: 'user_explicit' });
    const out = await reg.execute('memory_revise', { id: created.id, reason: 'just because' });
    assert.ok(out.error);
    assert.match(out.error, /at least one of value\/category\/source/);
});

/* ============================================================ */
/* Role gating (via registry.execute)                           */
/* ============================================================ */

test('profile=reviewer.v1 cannot call memory_remember (admission gate denial)', async () => {
    const reg = freshRegistry();
    State.settings.profile = 'reviewer.v1';
    const out = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'workflow',
    });
    assert.ok(out.error);
    assert.match(out.error, /not permitted/);
});

test('profile=reviewer.v1 can call memory_recall (read-only is allowed for all)', async () => {
    const reg = freshRegistry();
    // First seed a record from a profile that admits memory_remember.
    // Use coder.v1 so the default scope is `'workspace'` (post-1.18.0).
    State.settings.profile = 'coder.v1';
    await reg.execute('memory_remember', {
        key: 'seed', value: 's', category: 'workflow', source: 'user_explicit',
    });
    // Now switch to reviewer.v1 and recall.
    State.settings.profile = 'reviewer.v1';
    const out = await reg.execute('memory_recall', { scope: 'workspace' });
    assert.equal(out.success, true);
    assert.equal(out.count, 1);
});
