/**
 * Audit-log tests for js/intelligence/memory/audit.js. Exercises the
 * append-only contract and the read paths (list, listForRecord). Heavy
 * concurrency is in test-memory-races.mjs; this file covers correctness.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    audit,
    _setIDBImpl, _resetIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
    MEMORY_LIMITS,
} from '../js/intelligence/memory/index.js';

let fake;

beforeEach(() => {
    fake = createMemoryFakeIDB();
    _setIDBImpl(fake);
    _resetMutexForTests();
});

function entry(over = {}) {
    return {
        actor: 'jeff',
        action: 'create',
        record_id: 'rec-1',
        before: null,
        after: { id: 'rec-1', value: 'v1' },
        reason: 'initial',
        ...over,
    };
}

/* ============================================================ */
/* append                                                       */
/* ============================================================ */

test('append assigns a monotonic seq starting at 1', async () => {
    const s1 = await audit.append(entry());
    const s2 = await audit.append(entry({ action: 'update', before: { v: 1 }, after: { v: 2 } }));
    const s3 = await audit.append(entry({ action: 'softDelete', before: { v: 2 }, after: null }));
    assert.equal(s1, 1);
    assert.equal(s2, 2);
    assert.equal(s3, 3);
});

test('append injects ts when omitted, preserves provided ts', async () => {
    const t0 = Date.now();
    await audit.append(entry());
    await audit.append(entry({ ts: 12345 }));
    const all = await audit.list();
    assert.ok(all[0].ts >= t0);
    assert.equal(all[1].ts, 12345);
});

test('append rejects malformed entries', async () => {
    await assert.rejects(() => audit.append(null), /entry must be an object/);
    await assert.rejects(() => audit.append({ ...entry(), action: 'wat' }), /action must be one of/);
    await assert.rejects(() => audit.append({ ...entry(), record_id: '' }), /record_id must be a non-empty string/);
    await assert.rejects(() => audit.append({ ...entry(), actor: 42 }), /actor must be a string/);
    await assert.rejects(() => audit.append({ ...entry(), reason: 42 }), /reason must be a string/);
});

test('append enforces actor and reason length caps', async () => {
    const longActor = 'a'.repeat(MEMORY_LIMITS.ACTOR_MAX_LENGTH + 1);
    const longReason = 'r'.repeat(MEMORY_LIMITS.REASON_MAX_LENGTH + 1);
    await assert.rejects(() => audit.append(entry({ actor: longActor })), /actor must be ≤/);
    await assert.rejects(() => audit.append(entry({ reason: longReason })), /reason must be ≤/);
});

/* ============================================================ */
/* list / listForRecord                                          */
/* ============================================================ */

test('list returns entries in seq order', async () => {
    await audit.append(entry({ record_id: 'a' }));
    await audit.append(entry({ record_id: 'b' }));
    await audit.append(entry({ record_id: 'c' }));
    const all = await audit.list();
    assert.deepEqual(all.map((e) => e.record_id), ['a', 'b', 'c']);
});

test('list respects sinceTs filter', async () => {
    await audit.append(entry({ ts: 100 }));
    await audit.append(entry({ ts: 200 }));
    await audit.append(entry({ ts: 300 }));
    const out = await audit.list({ sinceTs: 200 });
    assert.equal(out.length, 2);
    for (const e of out) assert.ok(e.ts >= 200);
});

test('list respects limit', async () => {
    for (let i = 0; i < 5; i++) await audit.append(entry({ record_id: `r${i}` }));
    const out = await audit.list({ limit: 2 });
    assert.equal(out.length, 2);
    assert.equal(out[0].record_id, 'r0');
});

test('listForRecord filters by record_id only', async () => {
    await audit.append(entry({ record_id: 'a' }));
    await audit.append(entry({ record_id: 'b', action: 'update', before: {}, after: {} }));
    await audit.append(entry({ record_id: 'a', action: 'softDelete', before: {}, after: null }));
    const a = await audit.listForRecord('a');
    assert.equal(a.length, 2);
    for (const e of a) assert.equal(e.record_id, 'a');
});

/* ============================================================ */
/* concurrency                                                  */
/* ============================================================ */

test('100 concurrent appends preserve count and monotonic seq', async () => {
    const promises = [];
    for (let i = 0; i < 100; i++) {
        promises.push(audit.append(entry({ record_id: `r${i}` })));
    }
    const seqs = await Promise.all(promises);
    assert.equal(seqs.length, 100);

    // Seqs must be unique and form a contiguous range starting at 1.
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
        assert.equal(sorted[i], i + 1, `seq ${i} mismatch`);
    }

    // The audit log itself must read out 100 entries in seq order.
    const all = await audit.list();
    assert.equal(all.length, 100);
    for (let i = 1; i < all.length; i++) {
        assert.ok(all[i].seq > all[i - 1].seq);
    }
});

test('before/after snapshots round-trip through the store unchanged', async () => {
    const before = { id: 'x', key: 'k', value: 'old', tags: ['a', 'b'] };
    const after = { id: 'x', key: 'k', value: 'new', tags: ['a', 'b', 'c'] };
    await audit.append(entry({ action: 'update', record_id: 'x', before, after }));
    const got = (await audit.list())[0];
    assert.deepEqual(got.before, before);
    assert.deepEqual(got.after, after);
});
