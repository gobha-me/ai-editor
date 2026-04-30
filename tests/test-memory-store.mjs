/**
 * CRUD-surface tests for js/intelligence/memory/store.js. The IDB layer
 * is swapped for the in-memory `createMemoryFakeIDB()` fake; the
 * `KeyMutex` runs as in production. Tests are deterministic and
 * single-tab — concurrent-write behavior lives in test-memory-races.mjs.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    create, update, supersede, softDelete, purgeExpired,
    getById, getByKey, list, searchSemantic,
    DELETED_SENTINEL,
    audit,
    _setIDBImpl, _resetIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
} from '../js/intelligence/memory/index.js';

let fake;

beforeEach(() => {
    fake = createMemoryFakeIDB();
    _setIDBImpl(fake);
    _resetMutexForTests();
});

function input(over = {}) {
    return {
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        key: 'preferred_language',
        value: 'rust',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'jeff',
        actor: 'jeff',
        ...over,
    };
}

/* ============================================================ */
/* create + getById                                             */
/* ============================================================ */

test('create generates id, timestamps, defaults; getById returns it', async () => {
    const rec = await create(input());
    assert.equal(typeof rec.id, 'string');
    assert.ok(rec.id.length > 0);
    assert.ok(rec.created_at > 0);
    assert.equal(rec.created_at, rec.updated_at);
    assert.equal(rec.embedding, null, 'default embedding is null');
    assert.equal(rec.superseded_by, null);
    assert.equal(rec.expires_at, null);
    assert.equal(rec.md_path, null);

    const got = await getById(rec.id);
    assert.deepEqual(got, rec);
});

test('create canonicalizes the key', async () => {
    const rec = await create(input({ key: '  PREFERRED_LANGUAGE  ' }));
    assert.equal(rec.key, 'preferred_language');
});

test('create rejects malformed input via assertValid', async () => {
    await assert.rejects(() => create(input({ scope: 'persona' })), /Invalid memory record/);
});

test('create writes one audit entry of action=create', async () => {
    const rec = await create(input(), { reason: 'initial seed' });
    const entries = await audit.listForRecord(rec.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'create');
    assert.equal(entries[0].before, null);
    assert.equal(entries[0].reason, 'initial seed');
});

/* ============================================================ */
/* getByKey                                                     */
/* ============================================================ */

test('getByKey returns the active head; null when no record exists', async () => {
    const a = await create(input());
    const got = await getByKey({ scope: 'user', owner_id_or_workspace_id: 'jeff', key: 'preferred_language' });
    assert.equal(got.id, a.id);

    const miss = await getByKey({ scope: 'user', owner_id_or_workspace_id: 'jeff', key: 'never_set' });
    assert.equal(miss, null);
});

test('getByKey returns null when every record in the chain is deleted', async () => {
    const a = await create(input());
    await softDelete(a.id, { actor: 'jeff' });
    const got = await getByKey({ scope: 'user', owner_id_or_workspace_id: 'jeff', key: 'preferred_language' });
    assert.equal(got, null);
});

/* ============================================================ */
/* update                                                       */
/* ============================================================ */

test('update preserves identity fields and bumps updated_at', async () => {
    const a = await create(input({ value: 'rust' }));
    const before = a.updated_at;
    // Force a different ts. now() in the store reads Date.now(), so wait a ms.
    await new Promise((r) => setTimeout(r, 2));
    const b = await update(a.id, { value: 'go' }, { actor: 'jeff', reason: 'changed mind' });
    assert.equal(b.id, a.id);
    assert.equal(b.scope, a.scope);
    assert.equal(b.owner_id_or_workspace_id, a.owner_id_or_workspace_id);
    assert.equal(b.key, a.key);
    assert.equal(b.created_at, a.created_at);
    assert.equal(b.value, 'go');
    assert.ok(b.updated_at > before);
});

test('update rejects identity-bearing field changes', async () => {
    const a = await create(input());
    await assert.rejects(() => update(a.id, { scope: 'workspace' }, { actor: 'jeff' }), /cannot change scope/);
    await assert.rejects(() => update(a.id, { key: 'new' }, { actor: 'jeff' }), /cannot change key/);
});

test('update rejects superseded or deleted records', async () => {
    const a = await create(input());
    await softDelete(a.id, { actor: 'jeff' });
    await assert.rejects(() => update(a.id, { value: 'go' }, { actor: 'jeff' }), /superseded or deleted/);
});

test('update preserves md_path when partial does not include it', async () => {
    const a = await create(input({ md_path: '.aieditor/memory/preferences.md' }));
    const b = await update(a.id, { value: 'zig' }, { actor: 'jeff' });
    assert.equal(b.md_path, '.aieditor/memory/preferences.md');
});

test('update appends an audit entry of action=update with before/after snapshots', async () => {
    const a = await create(input({ value: 'rust' }));
    await update(a.id, { value: 'go' }, { actor: 'jeff' });
    const entries = await audit.listForRecord(a.id);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].action, 'update');
    assert.equal(entries[1].before.value, 'rust');
    assert.equal(entries[1].after.value, 'go');
});

/* ============================================================ */
/* supersede                                                    */
/* ============================================================ */

test('supersede creates a new head and marks the old superseded_by', async () => {
    const a = await create(input({ source: 'agent_proposed' }));
    const { old, new: b } = await supersede(a.id, input({ source: 'user_explicit', value: 'corrected' }));
    assert.notEqual(b.id, a.id);
    assert.equal(old.superseded_by, b.id);
    assert.equal(b.superseded_by, null);

    // getByKey now resolves to the new head.
    const head = await getByKey({ scope: 'user', owner_id_or_workspace_id: 'jeff', key: 'preferred_language' });
    assert.equal(head.id, b.id);
});

test('supersede appends two audit entries (supersede on old, create on new)', async () => {
    const a = await create(input());
    const { new: b } = await supersede(a.id, input({ value: 'go' }));
    const oldEntries = await audit.listForRecord(a.id);
    const newEntries = await audit.listForRecord(b.id);
    assert.ok(oldEntries.some((e) => e.action === 'supersede'));
    assert.ok(newEntries.some((e) => e.action === 'create'));
});

test('supersede refuses if the old record was already superseded', async () => {
    const a = await create(input());
    await supersede(a.id, input({ value: 'go' }));
    await assert.rejects(() => supersede(a.id, input({ value: 'zig' })), /already superseded/);
});

/* ============================================================ */
/* softDelete                                                   */
/* ============================================================ */

test('softDelete sets superseded_by=DELETED_SENTINEL and excludes from default list', async () => {
    const a = await create(input());
    await softDelete(a.id, { actor: 'jeff', reason: 'wrong fact' });
    const raw = await getById(a.id);
    assert.equal(raw.superseded_by, DELETED_SENTINEL);

    const ls = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff' });
    assert.equal(ls.length, 0);
});

test('list({includeSuperseded:true}) sees deleted records', async () => {
    const a = await create(input());
    await softDelete(a.id, { actor: 'jeff' });
    const ls = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff', includeSuperseded: true });
    assert.equal(ls.length, 1);
    assert.equal(ls[0].id, a.id);
});

test('softDelete refuses an already-deleted record', async () => {
    const a = await create(input());
    await softDelete(a.id, { actor: 'jeff' });
    await assert.rejects(() => softDelete(a.id, { actor: 'jeff' }), /already superseded or deleted/);
});

/* ============================================================ */
/* purgeExpired                                                 */
/* ============================================================ */

test('purgeExpired soft-deletes only records with expires_at < cutoff', async () => {
    const past = await create(input({ key: 'past', expires_at: 1000 }));
    const future = await create(input({ key: 'future', expires_at: Date.now() + 86400000 }));
    const noTtl = await create(input({ key: 'no_ttl' }));

    const count = await purgeExpired(Date.now());
    assert.equal(count, 1);

    const pastRaw = await getById(past.id);
    assert.equal(pastRaw.superseded_by, DELETED_SENTINEL);
    const futureRaw = await getById(future.id);
    assert.equal(futureRaw.superseded_by, null);
    const noTtlRaw = await getById(noTtl.id);
    assert.equal(noTtlRaw.superseded_by, null);
});

test('purgeExpired emits audit action=expire', async () => {
    const a = await create(input({ expires_at: 1000 }));
    await purgeExpired(Date.now());
    const entries = await audit.listForRecord(a.id);
    assert.ok(entries.some((e) => e.action === 'expire'));
});

/* ============================================================ */
/* scope isolation                                              */
/* ============================================================ */

test('user and workspace records with the same key do not collide', async () => {
    const u = await create(input({ scope: 'user', owner_id_or_workspace_id: 'jeff', key: 'editor' }));
    const w = await create(input({ scope: 'workspace', owner_id_or_workspace_id: 'gobha/ai-editor', key: 'editor' }));
    assert.notEqual(u.id, w.id);

    const fromUser = await getByKey({ scope: 'user', owner_id_or_workspace_id: 'jeff', key: 'editor' });
    const fromWs = await getByKey({ scope: 'workspace', owner_id_or_workspace_id: 'gobha/ai-editor', key: 'editor' });
    assert.equal(fromUser.id, u.id);
    assert.equal(fromWs.id, w.id);
});

/* ============================================================ */
/* list filtering                                               */
/* ============================================================ */

test('list filters by category when provided', async () => {
    await create(input({ key: 'a', category: 'preferences' }));
    await create(input({ key: 'b', category: 'decisions' }));
    await create(input({ key: 'c', category: 'preferences' }));

    const prefs = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff', category: 'preferences' });
    assert.equal(prefs.length, 2);
    for (const r of prefs) assert.equal(r.category, 'preferences');
});

test('list excludes expired records by default', async () => {
    await create(input({ key: 'fresh' }));
    await create(input({ key: 'stale', expires_at: 1000 }));
    const ls = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff' });
    assert.equal(ls.length, 1);
    assert.equal(ls[0].key, 'fresh');
});

test('list({includeExpired:true}) returns expired records too', async () => {
    await create(input({ key: 'fresh' }));
    await create(input({ key: 'stale', expires_at: 1000 }));
    const ls = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff', includeExpired: true });
    assert.equal(ls.length, 2);
});

test('list applies offset + limit', async () => {
    for (let i = 0; i < 5; i++) {
        await create(input({ key: `k${i}` }));
        await new Promise((r) => setTimeout(r, 1));
    }
    const page1 = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff', limit: 2 });
    const page2 = await list({ scope: 'user', owner_id_or_workspace_id: 'jeff', offset: 2, limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 2);
    assert.notDeepEqual(page1.map((r) => r.id), page2.map((r) => r.id));
});

/* ============================================================ */
/* searchSemantic                                               */
/* ============================================================ */

test('searchSemantic ranks by cosine similarity descending', async () => {
    await create(input({ key: 'a', value: 'rust', embedding: [1, 0, 0] }));
    await create(input({ key: 'b', value: 'go', embedding: [0.9, 0.1, 0] }));
    await create(input({ key: 'c', value: 'js', embedding: [0, 1, 0] }));

    const out = await searchSemantic({
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        queryEmbedding: [1, 0, 0],
        topK: 3,
    });
    assert.equal(out.length, 3);
    assert.equal(out[0].record.key, 'a');
    assert.equal(out[1].record.key, 'b');
    assert.equal(out[2].record.key, 'c');
    assert.ok(out[0].similarity >= out[1].similarity);
    assert.ok(out[1].similarity >= out[2].similarity);
});

test('searchSemantic skips records with embedding === null (pending indexing)', async () => {
    await create(input({ key: 'a', embedding: [1, 0, 0] }));
    await create(input({ key: 'b', embedding: null }));
    const out = await searchSemantic({
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        queryEmbedding: [1, 0, 0],
        topK: 10,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].record.key, 'a');
});

test('searchSemantic excludes superseded and deleted records', async () => {
    const a = await create(input({ key: 'a', embedding: [1, 0, 0] }));
    await softDelete(a.id, { actor: 'jeff' });
    const out = await searchSemantic({
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        queryEmbedding: [1, 0, 0],
    });
    assert.equal(out.length, 0);
});

test('searchSemantic respects topK', async () => {
    for (let i = 0; i < 5; i++) {
        await create(input({ key: `k${i}`, embedding: [1, i / 10, 0] }));
    }
    const out = await searchSemantic({
        scope: 'user',
        owner_id_or_workspace_id: 'jeff',
        queryEmbedding: [1, 0, 0],
        topK: 2,
    });
    assert.equal(out.length, 2);
});

test('searchSemantic throws on empty queryEmbedding', async () => {
    await assert.rejects(
        () => searchSemantic({ scope: 'user', owner_id_or_workspace_id: 'jeff', queryEmbedding: [] }),
        /non-empty number\[\]/,
    );
});
