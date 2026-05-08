/**
 * Capacity-cap tests for the task ledger (1.15.0 / Task Ledger Phase 1).
 *
 * Covers `_spillIfAtCapacity` in `js/intelligence/retrieval/ledger-consumer.js`
 * + the integration via `appendAdmission` inside `consultLedger`. Phase 1
 * enforces the count cap directly: at-or-over cap, the oldest record's
 * `query_embedding` is nulled (memory hygiene) and the record is shifted
 * off with a single `console.warn`. After every consultation pass the
 * array length stays `<= capacity`.
 *
 * Capacity is overridden to 3 in these tests so the table fits in head;
 * production cap is 500 (`coder-v1.task_ledger.capacity`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    consultLedger,
    _spillIfAtCapacity,
} from '../js/intelligence/retrieval/ledger-consumer.js';
import { createTaskLedger } from '../js/profiles/task-ledger.js';

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

function makeChunk(content, overrides = {}) {
    const id = overrides.id || cid();
    return {
        id,
        collection: 'docs',
        content,
        tokens: overrides.tokens ?? Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri: `docs/${id}.md`,
            content_type: 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: 'deadbeef',
            structural: null,
            custom: {},
        },
        provenance: {
            source_uri: `docs/${id}.md`,
            byte_range: [0, content.length],
            line_range: null,
            retrieved_by: 'semantic',
            score: 0.5,
            score_kind: 'cosine',
        },
        embedding: null,
    };
}

const baseReq = (overrides = {}) => ({
    task: '',
    query: 'auth',
    collections: ['docs'],
    budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
    history: null,
    filters: null,
    strategy_hints: null,
    priority_pins: null,
    task_ledger: null,
    turn_id: 'turn_x',
    ...overrides,
});

/* ---------------- _spillIfAtCapacity unit ---------------- */

test('_spillIfAtCapacity: under cap is a no-op', () => {
    const ledger = createTaskLedger({ taskId: 't1', surface: 'coder.v1', capacity: 3 });
    ledger.admissions.push({
        chunk_id: 'a', admitted_at: 1, turn_id: 't', tokens: 10,
        query: 'q', query_embedding: [0.1, 0.2], strategy: 'semantic', facets_covered: [],
    });
    const r = _spillIfAtCapacity(ledger);
    assert.deepEqual(r, { spilled: 0, dropped: 0 });
    assert.equal(ledger.admissions.length, 1);
    assert.deepEqual(ledger.admissions[0].query_embedding, [0.1, 0.2]);
});

test('_spillIfAtCapacity at cap: drops oldest, nulls its embedding, single warn', () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const ledger = createTaskLedger({ taskId: 't2', surface: 'coder.v1', capacity: 3 });
        for (let i = 0; i < 3; i++) {
            ledger.admissions.push({
                chunk_id: `c${i}`, admitted_at: i, turn_id: 't', tokens: 10,
                query: 'q', query_embedding: [i, 0], strategy: 'semantic', facets_covered: [],
            });
        }
        const r = _spillIfAtCapacity(ledger);
        assert.deepEqual(r, { spilled: 1, dropped: 1 });
        assert.equal(ledger.admissions.length, 2, 'oldest shifted off');
        assert.equal(ledger.admissions[0].chunk_id, 'c1', 'former index 1 now index 0');
        assert.equal(ledger.admissions[1].chunk_id, 'c2');
        assert.equal(warns.length, 1, 'single warn per drop');
        assert.match(warns[0], /\[task-ledger\] t2: dropped oldest admission record at cap=3/);
    } finally {
        console.warn = orig;
    }
});

test('_spillIfAtCapacity at cap with already-compacted oldest: still drops, spilled=0', () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const ledger = createTaskLedger({ taskId: 't3', surface: 'coder.v1', capacity: 3 });
        // Oldest already has no embedding (e.g. spilled by a prior path).
        ledger.admissions.push({
            chunk_id: 'old', admitted_at: 0, turn_id: 't', tokens: 10,
            query: 'q', query_embedding: null, strategy: 'semantic', facets_covered: [],
        });
        for (let i = 1; i < 3; i++) {
            ledger.admissions.push({
                chunk_id: `c${i}`, admitted_at: i, turn_id: 't', tokens: 10,
                query: 'q', query_embedding: [i, 0], strategy: 'semantic', facets_covered: [],
            });
        }
        const r = _spillIfAtCapacity(ledger);
        assert.deepEqual(r, { spilled: 0, dropped: 1 });
        assert.equal(ledger.admissions.length, 2);
        assert.equal(warns.length, 1);
    } finally {
        console.warn = orig;
    }
});

test('_spillIfAtCapacity defaults to 500 when ledger.capacity missing', () => {
    const ledger = createTaskLedger({ taskId: 't4', surface: 'coder.v1' });
    delete ledger.capacity;
    const r = _spillIfAtCapacity(ledger);
    assert.deepEqual(r, { spilled: 0, dropped: 0 });
});

test('_spillIfAtCapacity tolerates malformed input', () => {
    assert.deepEqual(_spillIfAtCapacity(null), { spilled: 0, dropped: 0 });
    assert.deepEqual(_spillIfAtCapacity({}), { spilled: 0, dropped: 0 });
    assert.deepEqual(_spillIfAtCapacity({ admissions: 'not an array' }), { spilled: 0, dropped: 0 });
});

/* ---------------- End-to-end: appendAdmission honors cap via consultLedger ---------------- */

test('consultLedger admissions stay <= capacity across many cold candidates', () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const ledger = createTaskLedger({ taskId: 'long_task', surface: 'coder.v1', capacity: 3 });
        // Five distinct cold candidates over five turns. Each call seeds
        // one new admission; the cap enforcement keeps the array bounded.
        const ids = [];
        for (let i = 0; i < 5; i++) {
            const chunk = makeChunk(`payload-${i}`, { tokens: 50 });
            ids.push(chunk.id);
            consultLedger(
                [chunk],
                baseReq({ query: `q-${i}`, turn_id: `turn_${i}` }),
                ledger,
                { now: 1_700_000_000_000 + i, queryEmbedding: [i, 0] },
            );
            assert.ok(
                ledger.admissions.length <= 3,
                `after ${i + 1} admissions, length is ${ledger.admissions.length} (cap=3)`,
            );
        }
        // Final state: only the 3 most-recent admissions survive.
        assert.equal(ledger.admissions.length, 3);
        assert.equal(ledger.admissions[0].chunk_id, ids[2], 'oldest survivor is admission #3');
        assert.equal(ledger.admissions[1].chunk_id, ids[3]);
        assert.equal(ledger.admissions[2].chunk_id, ids[4]);
        // Two drops happened (admissions 1 and 2 were evicted).
        assert.equal(warns.length, 2);
    } finally {
        console.warn = orig;
    }
});

test('consultLedger pinned chunk admission is also subject to cap', () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
        const ledger = createTaskLedger({ taskId: 'pinned_task', surface: 'coder.v1', capacity: 2 });
        // Pre-fill to cap with cold admissions.
        const c1 = makeChunk('one');
        const c2 = makeChunk('two');
        consultLedger([c1], baseReq({ query: 'q1' }), ledger, { now: 1_000_000 });
        consultLedger([c2], baseReq({ query: 'q2' }), ledger, { now: 1_000_001 });
        assert.equal(ledger.admissions.length, 2);
        // Now admit a pinned chunk — the cap should evict the oldest, not skip the pinned.
        const pin = makeChunk('pinned');
        consultLedger(
            [pin],
            baseReq({ query: 'q3', priority_pins: [pin.id] }),
            ledger,
            { now: 1_000_002 },
        );
        assert.equal(ledger.admissions.length, 2);
        assert.equal(ledger.admissions[0].chunk_id, c2.id, 'c1 evicted by cap');
        assert.equal(ledger.admissions[1].chunk_id, pin.id);
        assert.equal(ledger.admissions[1].strategy, 'pinned');
    } finally {
        console.warn = orig;
    }
});
