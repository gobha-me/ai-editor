/**
 * Race-safety tests for js/intelligence/memory/store.js. The KeyMutex in
 * `utils.js` serializes concurrent mutations on the same chain key so that
 * a 50-way concurrent update against a single record produces exactly 50
 * audit entries with monotonic seq, no lost intermediate states, and no
 * `before` snapshot equal to its predecessor's `after` (which would mean
 * two updates read the same `before` — the failure mode #188 exhibited).
 *
 * Different keys still proceed concurrently — we exercise that too.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    create, update, softDelete,
    audit,
    DELETED_SENTINEL,
    _setIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
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
/* same-key concurrent updates                                   */
/* ============================================================ */

test('50 concurrent updates on the same record serialize through the mutex', async () => {
    const a = await create(input({ value: 0 }));
    const N = 50;

    // Fire all updates as concurrently as Promise.all allows.
    const promises = [];
    for (let i = 1; i <= N; i++) {
        promises.push(update(a.id, { value: i }, { actor: 'jeff', reason: `bump-${i}` }));
    }
    const results = await Promise.all(promises);
    assert.equal(results.length, N);

    // Audit must contain create + N updates = N+1 entries for this record.
    const entries = await audit.listForRecord(a.id);
    assert.equal(entries.length, N + 1);

    // First entry is the create.
    assert.equal(entries[0].action, 'create');

    // Every subsequent entry is an update.
    for (let i = 1; i < entries.length; i++) {
        assert.equal(entries[i].action, 'update');
    }

    // Seq must be strictly monotonic (autoincrement guarantees this).
    for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i].seq > entries[i - 1].seq, `seq regressed at i=${i}`);
    }

    // Race detector: each update's `before` must equal the previous
    // update's `after`. If any two updates raced and read the same
    // pre-state, this would fail.
    for (let i = 2; i < entries.length; i++) {
        assert.deepEqual(
            entries[i].before,
            entries[i - 1].after,
            `update[${i}].before != update[${i - 1}].after — mutex did not serialize`,
        );
    }

    // Final state's `value` reflects exactly one of the writes (1..N).
    // Order isn't guaranteed because Promise.all queues in submission
    // order but the mutex picks them up FIFO; the outcome is which
    // value happens to land last.
    const final = entries[entries.length - 1].after;
    assert.ok(typeof final.value === 'number' && final.value >= 1 && final.value <= N);
});

test('different keys mutate concurrently without interference', async () => {
    const N = 20;
    const records = [];
    for (let i = 0; i < N; i++) {
        records.push(await create(input({ key: `key_${i}`, value: 0 })));
    }

    // Fire one update against each key in parallel.
    const results = await Promise.all(
        records.map((r, i) => update(r.id, { value: i + 100 }, { actor: 'jeff' })),
    );
    assert.equal(results.length, N);
    for (let i = 0; i < N; i++) {
        assert.equal(results[i].value, i + 100);
    }

    // Each record gets exactly one create + one update.
    for (const r of records) {
        const entries = await audit.listForRecord(r.id);
        assert.equal(entries.length, 2);
    }
});

test('two concurrent softDeletes on the same record — exactly one wins, the other rejects', async () => {
    // softDelete is the right conflict pair to test serialization with
    // rejection: both calls want to write `superseded_by`, so under the
    // mutex one writes first, the second reads the now-non-null
    // `superseded_by` and throws. (Concurrent update+softDelete do NOT
    // conflict in this design — update never touches `superseded_by`,
    // so softDelete after it still sees a null head and proceeds.)
    let successes = 0;
    let rejections = 0;
    for (let trial = 0; trial < 10; trial++) {
        const r = await create(input({ key: `t${trial}` }));
        const p1 = softDelete(r.id, { actor: 'a' }).then(
            () => { successes++; },
            () => { rejections++; },
        );
        const p2 = softDelete(r.id, { actor: 'b' }).then(
            () => { successes++; },
            () => { rejections++; },
        );
        await Promise.all([p1, p2]);
    }

    // For each trial, exactly one softDelete wins and one rejects.
    assert.equal(successes, 10);
    assert.equal(rejections, 10);
});

/* ============================================================ */
/* mutex memory hygiene                                          */
/* ============================================================ */

test('mutex chains drain after operations resolve', async () => {
    const r = await create(input({ key: 'drain' }));
    await update(r.id, { value: 'a' }, { actor: 'jeff' });
    await update(r.id, { value: 'b' }, { actor: 'jeff' });
    // Reset mutex to confirm draining doesn't break anything.
    _resetMutexForTests();
    const r2 = await update(r.id, { value: 'c' }, { actor: 'jeff' });
    assert.equal(r2.value, 'c');
});
