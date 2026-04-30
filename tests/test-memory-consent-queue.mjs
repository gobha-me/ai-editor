/**
 * Tests for js/intelligence/memory/consent-queue.js — the in-memory
 * pending-consent buffer for `agent_proposed` `memory_remember` calls
 * (Memory PR #6, Touch 1 Flow 1).
 *
 * Boot pattern matches test-memory-store.mjs: IDB swapped for the
 * Map-backed fake; KeyMutex resets between cases. The queue itself has
 * no persistence — each test gets a clean queue via _resetForTests().
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    consentEnqueue,
    consentGet,
    consentList,
    consentAccept,
    consentDismiss,
    consentClearAll,
    audit,
    getById,
    getByKey,
    create,
    MEMORY_EVENTS,
    _setIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
    _resetConsentQueueForTests,
    _setConsentEmbeddingsForTests,
} from '../js/intelligence/memory/index.js';
import { EventBus } from '../js/core.js';

let stub;
beforeEach(() => {
    _setIDBImpl(createMemoryFakeIDB());
    _resetMutexForTests();
    _resetConsentQueueForTests();

    stub = {
        embed: async (text) => [text.length, 0, 0],
    };
    _setConsentEmbeddingsForTests(stub);
});

function candidateInput(over = {}) {
    return {
        scope: 'workspace',
        owner_id_or_workspace_id: 'ws-test',
        key: 'preferred_test_runner',
        value: 'node:test',
        category: 'preferences',
        actor: 'agent:opus-test',
        reason: 'inferred from last 3 turns',
        ...over,
    };
}

/* ============================================================ */
/* enqueue                                                      */
/* ============================================================ */

test('enqueue returns a UUID-shaped candidate_id and emits CONSENT_REQUESTED', async () => {
    /** @type {any[]} */
    const events = [];
    const off = EventBus.on(MEMORY_EVENTS.CONSENT_REQUESTED, (p) => events.push(p));

    const { candidate_id } = consentEnqueue(candidateInput());
    assert.equal(typeof candidate_id, 'string');
    // RFC 4122 v4 shape: 8-4-4-4-12 hex with the literal `4` prefix on group 3.
    assert.match(candidate_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    assert.equal(events.length, 1);
    assert.equal(events[0].candidate.candidate_id, candidate_id);
    assert.equal(events[0].candidate.key, 'preferred_test_runner');
    assert.equal(events[0].candidate.scope, 'workspace');
    off();
});

test('enqueue canonicalizes the key (lowercase + trim)', () => {
    const { candidate_id } = consentEnqueue(candidateInput({ key: '  PREFERRED_LANGUAGE  ' }));
    const c = consentGet(candidate_id);
    assert.equal(c.key, 'preferred_language');
});

test('list returns a snapshot in insertion order; clearAll empties without emitting RESOLVED', () => {
    /** @type {any[]} */
    const resolved = [];
    const off = EventBus.on(MEMORY_EVENTS.CONSENT_RESOLVED, (p) => resolved.push(p));

    consentEnqueue(candidateInput({ key: 'a' }));
    consentEnqueue(candidateInput({ key: 'b' }));
    consentEnqueue(candidateInput({ key: 'c' }));
    assert.equal(consentList().length, 3);

    consentClearAll();
    assert.equal(consentList().length, 0);
    // Deliberate: clearAll is silent. CONSENT_RESOLVED is for individual
    // accept/dismiss only.
    assert.equal(resolved.length, 0);
    off();
});

/* ============================================================ */
/* accept                                                       */
/* ============================================================ */

test('accept (no existing key) calls create, emits CREATED then CONSENT_RESOLVED with record_id', async () => {
    /** @type {any[]} */
    const order = [];
    const offC = EventBus.on(MEMORY_EVENTS.CREATED, (p) => order.push({ kind: 'created', record_id: p.record.id }));
    const offR = EventBus.on(MEMORY_EVENTS.CONSENT_RESOLVED, (p) => order.push({ kind: 'resolved', ...p }));

    const { candidate_id } = consentEnqueue(candidateInput());
    const rec = await consentAccept(candidate_id);

    assert.equal(rec.value, 'node:test');
    assert.equal(rec.source, 'user_explicit');
    assert.equal(rec.scope, 'workspace');

    // CREATED fires from the store; CONSENT_RESOLVED fires from the queue.
    // Ordering matters — observers (like the Settings tab) listen for
    // CREATED to refresh, then the consent card collapses on RESOLVED.
    assert.equal(order.length, 2);
    assert.equal(order[0].kind, 'created');
    assert.equal(order[1].kind, 'resolved');
    assert.equal(order[1].outcome, 'accepted');
    assert.equal(order[1].record_id, rec.id);

    // Candidate is dropped from the queue.
    assert.equal(consentGet(candidate_id), null);
    assert.equal(consentList().length, 0);
    offC(); offR();
});

test('accept with edited value writes the edit, not the original candidate value', async () => {
    const { candidate_id } = consentEnqueue(candidateInput({ value: 'original' }));
    const rec = await consentAccept(candidate_id, { value: 'edited' });
    assert.equal(rec.value, 'edited');

    const persisted = await getById(rec.id);
    assert.equal(persisted.value, 'edited');
});

test('accept when an existing record at (scope, owner, key) exists takes the supersede branch', async () => {
    // Seed an existing user_explicit record.
    const seed = await create({
        scope: 'workspace',
        owner_id_or_workspace_id: 'ws-test',
        key: 'preferred_test_runner',
        value: 'vitest',
        category: 'preferences',
        source: 'user_explicit',
        created_by: 'user:seed',
        actor: 'user:seed',
    });

    /** @type {any[]} */
    const events = [];
    const offC = EventBus.on(MEMORY_EVENTS.CREATED, (p) => events.push({ kind: 'created', id: p.record.id }));
    const offU = EventBus.on(MEMORY_EVENTS.UPDATED, (p) => events.push({ kind: 'updated', before: p.before.id, after: p.after.id }));

    const { candidate_id } = consentEnqueue(candidateInput({ value: 'node:test' }));
    const newRec = await consentAccept(candidate_id);

    // The store's supersede() emits UPDATED, not CREATED. The new record
    // gets a fresh id and the old record's superseded_by points to it.
    const updateEvents = events.filter((e) => e.kind === 'updated');
    assert.equal(updateEvents.length, 1);
    assert.equal(updateEvents[0].before, seed.id);
    assert.equal(updateEvents[0].after, newRec.id);
    assert.notEqual(newRec.id, seed.id);

    const oldRec = await getById(seed.id);
    assert.equal(oldRec.superseded_by, newRec.id);
    offC(); offU();
});

test('accept on an unknown candidate id throws', async () => {
    await assert.rejects(
        () => consentAccept('does-not-exist'),
        /candidate.*not found/,
    );
});

test('accept respects opts.source override (e.g. for non-UI callers)', async () => {
    const { candidate_id } = consentEnqueue(candidateInput());
    const rec = await consentAccept(candidate_id, { source: 'inferred' });
    assert.equal(rec.source, 'inferred');
});

test('accept with a working embedder populates record.embedding', async () => {
    const { candidate_id } = consentEnqueue(candidateInput({ value: 'hello' }));
    const rec = await consentAccept(candidate_id);
    // Stub returns [text.length, 0, 0] — the canonical embed text is
    // `${key}: ${value}` which has positive length.
    assert.ok(Array.isArray(rec.embedding));
    assert.ok(rec.embedding[0] > 0);
});

test('accept swallows embedder errors and persists with embedding=null', async () => {
    _setConsentEmbeddingsForTests({
        embed: async () => { throw new Error('provider down'); },
    });
    const { candidate_id } = consentEnqueue(candidateInput());
    const rec = await consentAccept(candidate_id);
    assert.equal(rec.embedding, null);
});

/* ============================================================ */
/* dismiss                                                      */
/* ============================================================ */

test('dismiss emits CONSENT_RESOLVED with outcome=dismissed; no store write, no audit entry', async () => {
    /** @type {any[]} */
    const created = [];
    /** @type {any[]} */
    const resolved = [];
    const offC = EventBus.on(MEMORY_EVENTS.CREATED, (p) => created.push(p));
    const offR = EventBus.on(MEMORY_EVENTS.CONSENT_RESOLVED, (p) => resolved.push(p));

    const { candidate_id } = consentEnqueue(candidateInput());
    consentDismiss(candidate_id, { reason: 'not interesting' });

    assert.equal(created.length, 0, 'no CREATED event — record never written');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].outcome, 'dismissed');
    assert.equal(resolved[0].candidate_id, candidate_id);

    // Candidate is dropped.
    assert.equal(consentGet(candidate_id), null);

    // The dismissal would only have an audit row if some record were
    // written; because we never wrote one, the audit log is empty.
    const allAudit = await audit.list({});
    assert.equal(allAudit.length, 0);
    offC(); offR();
});

test('dismiss is idempotent (second call is a no-op, no second event)', () => {
    /** @type {any[]} */
    const events = [];
    const off = EventBus.on(MEMORY_EVENTS.CONSENT_RESOLVED, (p) => events.push(p));

    const { candidate_id } = consentEnqueue(candidateInput());
    consentDismiss(candidate_id);
    consentDismiss(candidate_id);
    assert.equal(events.length, 1);
    off();
});

/* ============================================================ */
/* Edge cases                                                   */
/* ============================================================ */

test('enqueue throws on null/undefined input', () => {
    assert.throws(() => consentEnqueue(null), /input must be an object/);
    assert.throws(() => consentEnqueue(undefined), /input must be an object/);
});

test('after accept, the candidate cannot be re-resolved (drop-before-write contract)', async () => {
    const { candidate_id } = consentEnqueue(candidateInput());
    await consentAccept(candidate_id);
    await assert.rejects(
        () => consentAccept(candidate_id),
        /candidate.*not found/,
    );
    // dismiss after accept is a silent no-op (idempotency).
    consentDismiss(candidate_id);
});
