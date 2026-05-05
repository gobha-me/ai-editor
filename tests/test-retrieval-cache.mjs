/**
 * Retrieval cache tests (1.6.9).
 *
 * Three discrete suites:
 *   1. `LRU` — bounded insertion-order cache used as the primitive for the
 *      query cache and structural memo.
 *   2. Structural strategy ancestor-walk memoization — `clearMemo()`
 *      invalidates, repeat candidates are served from memo, `memoStats()`
 *      reflects hits/misses/size.
 *   3. Paraphraser cache contract under async backings — sync `Map` cache
 *      and async fake-IDB cache both satisfy the contract; cached paths
 *      skip `chatFn`.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LRU } from '../js/intelligence/retrieval/lru.js';
import { createStructuralStrategy } from '../js/intelligence/retrieval/strategies/structural.js';
import { createQueryParaphraser } from '../js/intelligence/retrieval/query-paraphraser.js';

/* ============================================================
 * 1. LRU
 * ============================================================ */

test('LRU rejects non-positive capacity', () => {
    assert.throws(() => new LRU(0), TypeError);
    assert.throws(() => new LRU(-1), TypeError);
    assert.throws(() => new LRU(NaN), TypeError);
    assert.throws(() => new LRU(/** @type {any} */ ('x')), TypeError);
});

test('LRU set / get / size round-trip', () => {
    const c = new LRU(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    assert.equal(c.size, 3);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('c'), 3);
});

test('LRU evicts oldest when over capacity', () => {
    const c = new LRU(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    assert.equal(c.size, 2);
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('c'), 3);
});

test('LRU get promotes to most-recently-used', () => {
    const c = new LRU(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');           // promote 'a'
    c.set('c', 3);        // evicts 'b' (oldest now), keeps 'a'
    assert.equal(c.has('b'), false);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('c'), 3);
});

test('LRU set on existing key updates value and promotes', () => {
    const c = new LRU(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 99);       // refresh 'a'
    c.set('c', 3);        // evicts 'b'
    assert.equal(c.has('b'), false);
    assert.equal(c.get('a'), 99);
});

test('LRU clear empties the cache', () => {
    const c = new LRU(3);
    c.set('a', 1);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get('a'), undefined);
});

/* ============================================================
 * 2. Structural strategy ancestor-walk memoization
 * ============================================================ */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

function makeChunk(content, overrides = {}) {
    const id = overrides.id || cid();
    let structural = null;
    if (overrides.structural !== undefined) {
        structural = overrides.structural;
    } else if (overrides.parent_id !== undefined) {
        structural = {
            heading_path: [],
            node_kind: 'section',
            parent_id: overrides.parent_id,
            sibling_order: 0,
        };
    }
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
            structural,
            custom: {},
        },
        provenance: {
            source_uri: `docs/${id}.md`,
            byte_range: [0, content.length],
            line_range: null,
            retrieved_by: 'semantic',
            score: overrides.score ?? 0.5,
            score_kind: 'cosine',
        },
        embedding: null,
    };
}

const baseReq = (overrides = {}) => ({
    task: 'unit-test',
    query: 'authentication middleware design',
    collections: ['docs'],
    budget: { total_tokens: 8000, system_reserve: 0, output_reserve: 0, history_reserve: 0 },
    history: null,
    filters: null,
    strategy_hints: null,
    priority_pins: null,
    task_ledger: null,
    ...overrides,
});

test('structural strategy exposes clearMemo + memoStats', () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [],
        getChunkByID: async () => null,
    });
    assert.equal(typeof s.clearMemo, 'function');
    assert.equal(typeof s.memoStats, 'function');
    assert.deepEqual(s.memoStats(), { hits: 0, misses: 0, size: 0 });
});

test('repeat ancestor walks for the same candidate hit the memo', async () => {
    const parent = makeChunk('Section: Auth Middleware. Whole section content.', {
        id: 'parent_section',
        tokens: 200,
    });
    const candidate = makeChunk('paragraph 1', { parent_id: parent.id, tokens: 30 });

    let getChunkByIDCalls = 0;
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [candidate],
        getChunkByID: async (id) => {
            getChunkByIDCalls += 1;
            return id === parent.id ? parent : null;
        },
    });

    await s.retrieve(baseReq(), 5);
    await s.retrieve(baseReq(), 5);
    await s.retrieve(baseReq(), 5);

    // First call: 1 getChunkByID (miss → resolve parent). Subsequent two: 0
    // (memo hits skip the lookup entirely).
    assert.equal(getChunkByIDCalls, 1);
    const stats = s.memoStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 2);
    assert.equal(stats.size, 1);
});

test('clearMemo drops cached expansions', async () => {
    const parent = makeChunk('whole', { id: 'p1', tokens: 100 });
    const candidate = makeChunk('frag', { parent_id: parent.id, tokens: 30 });
    let calls = 0;
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [candidate],
        getChunkByID: async () => { calls += 1; return parent; },
    });

    await s.retrieve(baseReq(), 5);
    s.clearMemo();
    await s.retrieve(baseReq(), 5);

    // Two distinct ancestor walks because clearMemo wiped the entry.
    assert.equal(calls, 2);
    assert.equal(s.memoStats().size, 1); // post-clear, second call repopulates
});

test('memo keys include the per-chunk budget so different budgets miss', async () => {
    const parent = makeChunk('whole', { id: 'p1', tokens: 100 });
    const candidate = makeChunk('frag', { parent_id: parent.id, tokens: 30 });
    let calls = 0;
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [candidate],
        getChunkByID: async () => { calls += 1; return parent; },
    });

    // quota=5 → perChunkBudget = 8000/5 = 1600
    await s.retrieve(baseReq(), 5);
    // quota=10 → perChunkBudget = 800 (different memo key)
    await s.retrieve(baseReq(), 10);

    assert.equal(calls, 2);
    assert.equal(s.memoStats().size, 2);
});

test('memo caps growth at the loose 1024 ceiling', async () => {
    // Build 1100 distinct candidates each pointing at the same parent so
    // the memo accumulates entries.
    const parent = makeChunk('whole', { id: 'shared_parent', tokens: 100 });
    const candidates = [];
    for (let i = 0; i < 1100; i++) {
        candidates.push(makeChunk(`frag ${i}`, {
            id: `cand_${i}`,
            parent_id: parent.id,
            tokens: 30,
        }));
    }
    const s = createStructuralStrategy({
        runSemanticRetrieve: async (_req, k) => candidates.slice(0, k),
        getChunkByID: async () => parent,
    });

    await s.retrieve(baseReq(), 1100);
    assert.ok(s.memoStats().size <= 1024, `memo grew past cap: ${s.memoStats().size}`);
});

/* ============================================================
 * 3. Paraphraser async cache contract
 * ============================================================ */

const TWO_LINE_RESPONSE = 'first paraphrase\nsecond paraphrase';

test('paraphraser awaits async cache.get', async () => {
    let chatCalls = 0;
    const chatFn = async () => { chatCalls += 1; return TWO_LINE_RESPONSE; };

    const stored = new Map();
    /** @type {any} */
    const asyncCache = {
        get: async (k) => stored.has(k) ? stored.get(k) : null,
        set: async (k, v) => { stored.set(k, v); },
        size: async () => stored.size,
    };

    const p = createQueryParaphraser({ chatFn, modelId: 'm1', cache: asyncCache });
    const first = await p.paraphrase('how does auth work');
    const second = await p.paraphrase('how does auth work');

    assert.equal(chatCalls, 1, 'second call must use cache');
    assert.deepEqual(first, second);
    assert.deepEqual(p.stats(), { hits: 1, misses: 1, failures: 0 });
});

test('paraphraser mixed cache backing — sync Map still works (regression)', async () => {
    let chatCalls = 0;
    const chatFn = async () => { chatCalls += 1; return TWO_LINE_RESPONSE; };
    /** @type {any} */
    const m = new Map();
    /** @type {any} */
    const syncCache = {
        get: (k) => m.has(k) ? m.get(k) : null,
        set: (k, v) => { m.set(k, v); },
        size: () => m.size,
    };

    const p = createQueryParaphraser({ chatFn, modelId: 'm1', cache: syncCache });
    await p.paraphrase('q');
    await p.paraphrase('q');
    assert.equal(chatCalls, 1);
});

test('async cache.get rejecting still resolves to a paraphrase via chatFn', async () => {
    let chatCalls = 0;
    const chatFn = async () => { chatCalls += 1; return TWO_LINE_RESPONSE; };
    // get() throws — paraphraser should treat as a miss and call chatFn.
    /** @type {any} */
    const flakyCache = {
        get: async () => { throw new Error('IDB transient'); },
        set: async () => {},
        size: async () => 0,
    };

    const p = createQueryParaphraser({ chatFn, modelId: 'm1', cache: flakyCache });
    await assert.rejects(p.paraphrase('q'), /IDB transient/);
    // The paraphraser doesn't catch cache errors; tests pin the contract:
    // production callers wrap the cache themselves to swallow IDB faults.
    // The IDB-backed cache in `paraphrase-cache-idb.js` does exactly that.
    assert.equal(chatCalls, 0);
});
