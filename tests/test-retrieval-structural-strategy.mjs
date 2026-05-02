/**
 * Structural strategy tests (1.4.16).
 *
 * Covers `js/intelligence/retrieval/strategies/structural.js` per
 * `docs/DESIGN-retrieval.md` §"Structural (Phase 1: ancestor-walk)":
 * candidate semantic chunks → walk one step up to immediate parent if
 * parent fits per-chunk budget → dedup by ChunkID → return top quota,
 * including the failure-mode paths (no structural meta, null parent_id,
 * stale parent ref, oversized parent).
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. The
 * strategy is dependency-injected (runSemanticRetrieve + getChunkByID),
 * so tests construct deterministic fakes and never touch the Semantic
 * strategy or a real chunk store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStructuralStrategy } from '../js/intelligence/retrieval/strategies/structural.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

/**
 * Build a `ChunkRef`. `overrides.parent_id` populates the structural
 * meta; pass `parent_id: null` for an explicit root or omit it (and
 * `structural`) for no structural meta at all.
 *
 * @param {string} content
 * @param {object} [overrides]
 * @returns {import('../js/intelligence/retrieval/contracts.js').ChunkRef}
 */
function makeChunk(content, overrides = {}) {
    const id = overrides.id || cid();
    /** @type {import('../js/intelligence/retrieval/contracts.js').StructuralMeta|null} */
    let structural = null;
    if (overrides.structural !== undefined) {
        structural = overrides.structural;
    } else if (overrides.parent_id !== undefined) {
        structural = {
            heading_path: overrides.heading_path || [],
            node_kind: overrides.node_kind || 'section',
            parent_id: overrides.parent_id,
            sibling_order: overrides.sibling_order ?? 0,
        };
    }
    return {
        id,
        collection: overrides.collection || 'docs',
        content,
        tokens: overrides.tokens ?? Math.max(1, Math.ceil(content.length / 4)),
        metadata: {
            source_uri: overrides.source_uri || `docs/${id}.md`,
            content_type: overrides.content_type || 'prose',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: overrides.content_hash || 'deadbeef',
            structural,
            custom: overrides.custom || {},
        },
        provenance: {
            source_uri: overrides.source_uri || `docs/${id}.md`,
            byte_range: overrides.byte_range || [0, content.length],
            line_range: overrides.line_range || null,
            retrieved_by: overrides.retrieved_by || 'semantic',
            score: overrides.score ?? 0.5,
            score_kind: overrides.score_kind || 'cosine',
        },
        embedding: null,
    };
}

/** Async fake for `runSemanticRetrieve`. Returns the supplied list capped at `k`. */
const semanticFake = (chunks) => async (_req, k) => chunks.slice(0, k);

/**
 * Async fake for `getChunkByID`. Builds an ID → chunk map and resolves
 * by lookup; returns null on miss (the design's stale-ref path).
 *
 * @param {import('../js/intelligence/retrieval/contracts.js').ChunkRef[]} chunks
 */
function getByIdFake(chunks) {
    const map = new Map();
    for (const c of chunks) map.set(c.id, c);
    return async (id) => map.get(id) || null;
}

const baseReq = (overrides = {}) => ({
    task: 'unit-test',
    query: 'authentication middleware design',
    collections: ['docs'],
    budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
    history: null,
    filters: null,
    strategy_hints: null,
    priority_pins: null,
    task_ledger: null,
    ...overrides,
});

/* ---------------- Factory validation ---------------- */

test('createStructuralStrategy throws when runSemanticRetrieve missing', () => {
    assert.throws(
        () => createStructuralStrategy(/** @type {any} */ ({ getChunkByID: async () => null })),
        /runSemanticRetrieve must be a function/,
    );
});

test('createStructuralStrategy throws when runSemanticRetrieve is not a function', () => {
    assert.throws(
        () => createStructuralStrategy(/** @type {any} */ ({ runSemanticRetrieve: 42, getChunkByID: async () => null })),
        /runSemanticRetrieve must be a function/,
    );
});

test('createStructuralStrategy throws when getChunkByID missing', () => {
    assert.throws(
        () => createStructuralStrategy(/** @type {any} */ ({ runSemanticRetrieve: async () => [] })),
        /getChunkByID must be a function/,
    );
});

test('createStructuralStrategy throws when getChunkByID is not a function', () => {
    assert.throws(
        () => createStructuralStrategy(/** @type {any} */ ({ runSemanticRetrieve: async () => [], getChunkByID: 'no' })),
        /getChunkByID must be a function/,
    );
});

test('createStructuralStrategy returns Strategy-shaped object', () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [],
        getChunkByID: async () => null,
    });
    assert.equal(s.name, 'structural');
    assert.equal(typeof s.applies_to, 'function');
    assert.equal(typeof s.retrieve, 'function');
});

/* ---------------- applies_to ---------------- */

test('applies_to returns 0 for null/empty/whitespace query', () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [],
        getChunkByID: async () => null,
    });
    assert.equal(s.applies_to(/** @type {any} */ (baseReq({ query: null }))).score, 0);
    assert.equal(s.applies_to(baseReq({ query: '' })).score, 0);
    assert.equal(s.applies_to(baseReq({ query: '   \t\n' })).score, 0);
});

test('applies_to returns 0.8 for non-empty query', () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: async () => [],
        getChunkByID: async () => null,
    });
    const a = s.applies_to(baseReq());
    assert.equal(a.score, 0.8);
    assert.match(a.reason, /Phase-1/);
});

/* ---------------- retrieve happy paths ---------------- */

test('retrieve expands a single chunk to its parent when parent fits budget', async () => {
    const parent = makeChunk('Section: Auth Middleware. Whole section content goes here.', {
        id: 'parent_section',
        tokens: 200,
    });
    const candidate = makeChunk('paragraph 1 of section', {
        parent_id: parent.id,
        score: 0.91,
        tokens: 30,
    });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([parent]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, parent.id);
    assert.equal(out[0].provenance.retrieved_by, 'structural');
    assert.equal(out[0].provenance.score_kind, 'structural_expanded');
    assert.equal(out[0].provenance.score, 0.91);
    assert.equal(out[0].content, parent.content);
});

test('retrieve dedups multiple sibling chunks sharing a parent', async () => {
    const parent = makeChunk('shared parent section', { id: 'parent_x', tokens: 150 });
    const a = makeChunk('para A', { parent_id: parent.id, score: 0.9, tokens: 30 });
    const b = makeChunk('para B', { parent_id: parent.id, score: 0.85, tokens: 30 });
    const c = makeChunk('para C', { parent_id: parent.id, score: 0.8, tokens: 30 });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([a, b, c]),
        getChunkByID: getByIdFake([parent]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, parent.id);
});

test('retrieve respects quota cap', async () => {
    const candidates = [];
    const parents = [];
    for (let i = 0; i < 10; i++) {
        const p = makeChunk(`section ${i} content`, { id: `p_${i}`, tokens: 50 });
        parents.push(p);
        candidates.push(makeChunk(`fragment ${i}`, { parent_id: p.id, score: 1 - i * 0.05, tokens: 20 }));
    }
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake(candidates),
        getChunkByID: getByIdFake(parents),
    });
    const out = await s.retrieve(baseReq(), 3);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(c => c.id), ['p_0', 'p_1', 'p_2']);
});

/* ---------------- retrieve graceful-degrade paths ---------------- */

test('chunk with structural=null passes through unchanged', async () => {
    const candidate = makeChunk('orphan fragment', { score: 0.7 });
    // Don't set parent_id ⇒ structural stays null per fixture builder.
    assert.equal(candidate.metadata.structural, null);
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, candidate.id);
    assert.equal(out[0].provenance.retrieved_by, 'semantic');
    assert.equal(out[0].provenance.score_kind, 'cosine');
});

test('chunk with parent_id=null (root) passes through unchanged', async () => {
    const candidate = makeChunk('root section content', {
        parent_id: null,
        score: 0.7,
    });
    assert.equal(candidate.metadata.structural.parent_id, null);
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, candidate.id);
});

test('stale parent_id (getChunkByID returns null) passes through unchanged', async () => {
    const candidate = makeChunk('paragraph', {
        parent_id: 'no_such_parent',
        score: 0.7,
    });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([]), // empty store → all lookups miss
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, candidate.id);
    assert.equal(out[0].provenance.retrieved_by, 'semantic');
});

test('oversized parent (tokens > perChunkBudget) leaves candidate unchanged', async () => {
    // budget = 8000 - 800 - 800 - 1000 = 5400 ; quota=4 ⇒ perChunkBudget=1350
    const huge = makeChunk('giant section', { id: 'huge_p', tokens: 9999 });
    const candidate = makeChunk('frag', { parent_id: huge.id, score: 0.6, tokens: 30 });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([huge]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, candidate.id, 'oversized parent rejected, original returned');
});

/* ---------------- Empty-result paths ---------------- */

test('quota <= 0 returns empty', async () => {
    const candidate = makeChunk('frag', { parent_id: 'p1' });
    const parent = makeChunk('section', { id: 'p1', tokens: 50 });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([parent]),
    });
    assert.deepEqual(await s.retrieve(baseReq(), 0), []);
    assert.deepEqual(await s.retrieve(baseReq(), -1), []);
    assert.deepEqual(await s.retrieve(baseReq(), Number.NaN), []);
});

test('empty req.collections returns empty', async () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([makeChunk('x')]),
        getChunkByID: getByIdFake([]),
    });
    assert.deepEqual(await s.retrieve(baseReq({ collections: [] }), 4), []);
});

test('empty/whitespace query returns empty', async () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([makeChunk('x')]),
        getChunkByID: getByIdFake([]),
    });
    assert.deepEqual(await s.retrieve(baseReq({ query: '' }), 4), []);
    assert.deepEqual(await s.retrieve(baseReq({ query: '   ' }), 4), []);
});

test('runSemanticRetrieve returns [] → empty result', async () => {
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([]),
        getChunkByID: getByIdFake([]),
    });
    assert.deepEqual(await s.retrieve(baseReq(), 4), []);
});

/* ---------------- Budget math ---------------- */

test('semantic step receives k = quota * 3 headroom', async () => {
    let observedK = -1;
    const candidate = makeChunk('x');
    const s = createStructuralStrategy({
        runSemanticRetrieve: async (_req, k) => { observedK = k; return [candidate]; },
        getChunkByID: getByIdFake([]),
    });
    await s.retrieve(baseReq(), 5);
    assert.equal(observedK, 15);
});

test('non-positive perChunkBudget disables expansion', async () => {
    const parent = makeChunk('parent', { id: 'p_zero', tokens: 1 });
    const candidate = makeChunk('frag', { parent_id: parent.id, score: 0.5, tokens: 1 });
    // total - reserves = 0 ⇒ perChunkBudget = 0 ⇒ expansion off.
    const tightBudget = baseReq({
        budget: { total_tokens: 1000, system_reserve: 400, output_reserve: 400, history_reserve: 200 },
    });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([parent]),
    });
    const out = await s.retrieve(tightBudget, 4);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, candidate.id, 'no expansion when perChunkBudget == 0');
});

/* ---------------- Determinism + non-mutation ---------------- */

test('determinism: same input → same output across runs', async () => {
    const parent = makeChunk('p', { id: 'det_p', tokens: 50 });
    const candidates = [
        makeChunk('a', { id: 'a', parent_id: parent.id, score: 0.9 }),
        makeChunk('b', { id: 'b', parent_id: null, score: 0.8 }),
        makeChunk('c', { id: 'c', score: 0.7 }), // no structural
    ];
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake(candidates),
        getChunkByID: getByIdFake([parent]),
    });
    const r1 = await s.retrieve(baseReq(), 4);
    const r2 = await s.retrieve(baseReq(), 4);
    assert.deepEqual(r1.map(c => c.id), r2.map(c => c.id));
});

test('input candidates are not mutated', async () => {
    const parent = makeChunk('section', { id: 'mut_p', tokens: 50 });
    const candidate = makeChunk('frag', { parent_id: parent.id, score: 0.8, tokens: 20 });
    const snapshot = JSON.parse(JSON.stringify(candidate));
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([parent]),
    });
    await s.retrieve(baseReq(), 4);
    assert.deepEqual(JSON.parse(JSON.stringify(candidate)), snapshot);
});

/* ---------------- Code passthrough (Phase-1 no-op) ---------------- */

test('code chunks with parent_id=null pass through unchanged (Phase-1 no-op)', async () => {
    // Mirrors what extractCode emits in 1.4.14: flat top-level code,
    // every chunk has parent_id=null.
    const code1 = makeChunk('function authMiddleware() {}', {
        id: 'code_1',
        content_type: 'code',
        source_uri: 'src/auth.js',
        parent_id: null,
        node_kind: 'function',
        score: 0.92,
        tokens: 30,
    });
    const code2 = makeChunk('class Authenticator {}', {
        id: 'code_2',
        content_type: 'code',
        source_uri: 'src/auth.js',
        parent_id: null,
        node_kind: 'class',
        score: 0.88,
        tokens: 30,
    });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([code1, code2]),
        getChunkByID: getByIdFake([]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, code1.id);
    assert.equal(out[1].id, code2.id);
    // No structural expansion: provenance preserved from semantic.
    assert.equal(out[0].provenance.retrieved_by, 'semantic');
    assert.equal(out[1].provenance.retrieved_by, 'semantic');
});

/* ---------------- Provenance carry-forward edges ---------------- */

test('expanded chunk uses parent byte_range, not candidate byte_range', async () => {
    const parent = makeChunk('whole section content', {
        id: 'p_brange',
        tokens: 150,
        byte_range: [100, 500],
    });
    const candidate = makeChunk('frag', {
        parent_id: parent.id,
        byte_range: [120, 160],
        score: 0.9,
        tokens: 20,
    });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([candidate]),
        getChunkByID: getByIdFake([parent]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.deepEqual(out[0].provenance.byte_range, [100, 500]);
});

test('mixed-result batch: expanded + degraded chunks coexist', async () => {
    const parent = makeChunk('section', { id: 'mix_p', tokens: 50 });
    const expanding = makeChunk('frag1', { parent_id: parent.id, score: 0.9 });
    const orphan = makeChunk('orphan_no_meta', { score: 0.85 }); // no structural
    const root = makeChunk('root_chunk', { parent_id: null, score: 0.8 });
    const s = createStructuralStrategy({
        runSemanticRetrieve: semanticFake([expanding, orphan, root]),
        getChunkByID: getByIdFake([parent]),
    });
    const out = await s.retrieve(baseReq(), 4);
    assert.equal(out.length, 3);
    assert.equal(out[0].id, parent.id);
    assert.equal(out[0].provenance.retrieved_by, 'structural');
    assert.equal(out[1].id, orphan.id);
    assert.equal(out[1].provenance.retrieved_by, 'semantic');
    assert.equal(out[2].id, root.id);
    assert.equal(out[2].provenance.retrieved_by, 'semantic');
});
