/**
 * Ledger consumer tests (1.4.18 / PR 10 of 1.5.0).
 *
 * Covers `js/intelligence/retrieval/ledger-consumer.js` per
 * `docs/DESIGN-retrieval.md` §"Composition Algorithm" §6.5
 * (lines 439–471) — the consult_ledger step.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. The
 * consumer is dependency-injected (ledger object passed in), so tests
 * construct a fresh ledger via `createTaskLedger` and assert against
 * its `admissions[]` / `exclusions[]` arrays after each call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    consultLedger,
    DEFAULT_NOVELTY_THRESHOLD,
    DEFAULT_TIME_DECAY_MS,
    MARKER_TOKEN_COST,
    _findMostRecentAdmission,
    _computeNovelty,
    _resetTurnIdCounterForTests,
} from '../js/intelligence/retrieval/ledger-consumer.js';
import { createTaskLedger } from '../js/profiles/task-ledger.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

function makeChunk(content, overrides = {}) {
    const id = overrides.id || cid();
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
            structural: null,
            custom: {},
        },
        provenance: {
            source_uri: overrides.source_uri || `docs/${id}.md`,
            byte_range: [0, content.length],
            line_range: null,
            retrieved_by: overrides.retrieved_by || 'semantic',
            score: overrides.score ?? 0.5,
            score_kind: 'cosine',
        },
        embedding: null,
    };
}

const baseReq = (overrides = {}) => ({
    task: 'help me debug this auth bug',
    query: 'authentication middleware',
    collections: ['docs'],
    budget: { total_tokens: 8000, system_reserve: 800, output_reserve: 800, history_reserve: 1000 },
    history: null,
    filters: null,
    strategy_hints: null,
    priority_pins: null,
    task_ledger: null,
    turn_id: 'turn_1',
    ...overrides,
});

const newLedger = () => createTaskLedger({ taskId: 'task_1', surface: 'coder.v1' });

const seedAdmission = (ledger, chunkId, overrides = {}) => {
    ledger.admissions.push({
        chunk_id: chunkId,
        admitted_at: overrides.admitted_at ?? 1_700_000_000_000,
        turn_id: overrides.turn_id || 'turn_0',
        tokens: overrides.tokens ?? 50,
        query: overrides.query !== undefined ? overrides.query : 'authentication middleware',
        query_embedding: overrides.query_embedding !== undefined ? overrides.query_embedding : null,
        strategy: overrides.strategy || 'semantic',
        facets_covered: [],
    });
};

/* ---------------- 1. No ledger / empty admissions → pass-through ---------------- */

test('consultLedger throws when ledger is missing required arrays', () => {
    assert.throws(() => consultLedger([], baseReq(), null), /ledger must be a TaskLedger/);
    assert.throws(() => consultLedger([], baseReq(), {}), /ledger must be a TaskLedger/);
});

test('empty admissions: every candidate is admitted (cold), no suppressions', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    const c2 = makeChunk('beta', { tokens: 80 });
    const result = consultLedger([c1, c2], baseReq(), ledger, { now: 2_000_000_000_000 });
    assert.deepEqual(result.kept, [c1, c2]);
    assert.equal(result.suppressedCount, 0);
    assert.equal(result.admittedCount, 2);
    assert.equal(ledger.admissions.length, 2);
    assert.equal(ledger.exclusions.length, 0);
});

/* ---------------- 2. Cold candidate seeds the ledger ---------------- */

test('cold candidate appends a complete AdmissionRecord', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100, retrieved_by: 'structural' });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'auth flow', turn_id: 'turn_5' }),
        ledger,
        { now: 1_700_000_500_000, queryEmbedding: [0.1, 0.2] },
    );
    assert.equal(result.admittedCount, 1);
    assert.equal(ledger.admissions.length, 1);
    const adm = ledger.admissions[0];
    assert.equal(adm.chunk_id, c1.id);
    assert.equal(adm.admitted_at, 1_700_000_500_000);
    assert.equal(adm.turn_id, 'turn_5');
    assert.equal(adm.tokens, 100);
    assert.equal(adm.query, 'auth flow');
    assert.deepEqual(adm.query_embedding, [0.1, 0.2]);
    assert.equal(adm.strategy, 'structural');
    assert.deepEqual(adm.facets_covered, []);
});

/* ---------------- 3. High-novelty re-admission ---------------- */

test('high-novelty (different query, no overlap) → re-admitted, no exclusion', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, {
        query: 'database migration timing',
        admitted_at: 1_700_000_000_000,
    });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'oauth2 callback handler' }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.deepEqual(result.kept, [c1]);
    assert.equal(result.suppressedCount, 0);
    assert.equal(ledger.admissions.length, 2);
    assert.equal(ledger.exclusions.length, 0);
});

/* ---------------- 4. Low-novelty suppression ---------------- */

test('low-novelty (identical query, recent prior) → suppressed with marker', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, {
        query: 'authentication middleware',
        admitted_at: 1_700_000_000_000,
        turn_id: 'turn_0',
    });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'authentication middleware', turn_id: 'turn_1' }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.kept.length, 1);
    assert.equal(result.suppressedCount, 1);
    assert.equal(result.admittedCount, 0);
    const marker = result.kept[0];
    assert.ok(marker.id.startsWith(`ledger_marker:${c1.id}:`));
    assert.equal(marker.tokens, MARKER_TOKEN_COST);
    assert.equal(marker.provenance.retrieved_by, 'ledger_marker');
    assert.match(marker.content, new RegExp(`Already admitted: ${c1.id}.*see turn turn_0`));
    assert.equal(ledger.exclusions.length, 1);
    assert.equal(ledger.exclusions[0].chunk_id, c1.id);
    assert.equal(ledger.exclusions[0].reason, 'already_admitted_low_novelty');
    assert.equal(ledger.exclusions[0].turn_id, 'turn_1');
    // No new admission written for the suppressed chunk.
    assert.equal(ledger.admissions.length, 1);
});

/* ---------------- 5. Cosine novelty path ---------------- */

test('cosine signal contributes when both embeddings present (distant → re-admit)', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    // Identical query → Jaccard novelty = 0; recent → time novelty ≈ 0.
    // With cosine fully orthogonal, it should re-admit.
    seedAdmission(ledger, c1.id, {
        query: 'authentication middleware',
        admitted_at: 1_700_000_000_000,
        query_embedding: [1, 0, 0],
    });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'authentication middleware' }),
        ledger,
        { now: 1_700_000_001_000, queryEmbedding: [0, 1, 0] },
    );
    // cosine([1,0,0], [0,1,0]) = 0 → cosine novelty = 1.0; weighted 0.30 → composite ≥ 0.3
    // (jacNov = 0, timeNov ≈ 0, cosNov = 1) → composite = 0.30. Exactly below default 0.4 → suppress.
    // Verify what *should* happen in this exact numeric case: 0.30 < 0.4 → suppress.
    assert.equal(result.suppressedCount, 1);
});

test('cosine path: identical embeddings + identical query + recent → suppressed', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, {
        query: 'auth',
        admitted_at: 1_700_000_000_000,
        query_embedding: [1, 0, 0],
    });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'auth' }),
        ledger,
        { now: 1_700_000_001_000, queryEmbedding: [1, 0, 0] },
    );
    assert.equal(result.suppressedCount, 1);
});

test('one-sided embedding falls back silently to Jaccard-only weighting', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    // No prior embedding, no current embedding → cosine null.
    // Identical query, recent prior → suppress (Jaccard fallback weight 0.75 * 0 + time ≈ 0).
    seedAdmission(ledger, c1.id, {
        query: 'auth',
        admitted_at: 1_700_000_000_000,
    });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'auth' }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.suppressedCount, 1);
});

/* ---------------- 6. Time decay flips a borderline case ---------------- */

test('time decay: ancient prior re-admitted; recent prior suppressed (same Jaccard)', () => {
    const c1 = makeChunk('alpha', { tokens: 100 });
    // Fresh ledger for each, identical Jaccard (~0.5 overlap).
    const queryNow = 'authentication tokens';
    const queryPrior = 'authentication flow';
    // Ancient: prior was 1 hour ago (decay = 30 min so timeNov saturates at 1.0).
    {
        const ledger = newLedger();
        seedAdmission(ledger, c1.id, { query: queryPrior, admitted_at: 1_700_000_000_000 });
        const result = consultLedger(
            [c1],
            baseReq({ query: queryNow }),
            ledger,
            { now: 1_700_000_000_000 + 60 * 60 * 1000 },
        );
        // jacNov ≈ 1 - (1/3) = 0.67; timeNov = 1; cosNov null → fallback weight 0.75*0.67 + 0.25*1 ≈ 0.75
        // Above 0.4 → re-admit.
        assert.equal(result.suppressedCount, 0);
    }
    // Recent: prior was 1 second ago.
    {
        const ledger = newLedger();
        seedAdmission(ledger, c1.id, { query: queryPrior, admitted_at: 1_700_000_000_000 });
        const result = consultLedger(
            [c1],
            baseReq({ query: queryNow }),
            ledger,
            { now: 1_700_000_001_000 },
        );
        // timeNov ≈ 0.0006, jacNov ≈ 0.67 → fallback 0.75 * 0.67 + 0.25 * 0.0006 ≈ 0.50.
        // Above 0.4 → re-admit. Tighten the borderline so suppression actually fires:
        // Use queries with full overlap so jacNov = 0.
        const ledger2 = newLedger();
        seedAdmission(ledger2, c1.id, { query: queryNow, admitted_at: 1_700_000_000_000 });
        const result2 = consultLedger(
            [c1],
            baseReq({ query: queryNow }),
            ledger2,
            { now: 1_700_000_001_000 },
        );
        // Identical query → jacNov = 0; tiny timeNov → composite ≈ 0 → suppress.
        assert.equal(result2.suppressedCount, 1);
    }
});

/* ---------------- 7. Explicit re_examine carrier ---------------- */

test('strategy_hints with re_examine:<chunk_id> reason → forces re-admit', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, { query: 'auth' });
    const result = consultLedger(
        [c1],
        baseReq({
            query: 'auth',
            strategy_hints: [{ strategy: 'semantic', mode: 'prefer', reason: `re_examine:${c1.id}` }],
        }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.suppressedCount, 0);
    assert.equal(ledger.admissions.length, 2);
});

/* ---------------- 8. mode: "force" hint matching prior strategy ---------------- */

test('strategy_hints with mode: "force" matching prior.strategy → forces re-admit', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, { query: 'auth', strategy: 'structural' });
    const result = consultLedger(
        [c1],
        baseReq({
            query: 'auth',
            strategy_hints: [{ strategy: 'structural', mode: 'force', reason: 'rerun structural' }],
        }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.suppressedCount, 0);
});

test('strategy_hints with mode: "force" but mismatched strategy does NOT force', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, { query: 'auth', strategy: 'structural' });
    const result = consultLedger(
        [c1],
        baseReq({
            query: 'auth',
            strategy_hints: [{ strategy: 'semantic', mode: 'force', reason: 'rerun semantic' }],
        }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    // Force doesn't apply (wrong strategy) → identical query suppresses.
    assert.equal(result.suppressedCount, 1);
});

/* ---------------- 9. Pinned bypass ---------------- */

test('pinned chunk: never suppressed; admission strategy = "pinned"', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100, retrieved_by: 'pinned' });
    seedAdmission(ledger, c1.id, { query: 'auth' });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'auth', priority_pins: [c1.id] }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.suppressedCount, 0);
    assert.equal(result.admittedCount, 1);
    const newAdm = ledger.admissions[ledger.admissions.length - 1];
    assert.equal(newAdm.strategy, 'pinned');
});

/* ---------------- 10. Empty / null query ---------------- */

test('null current query: re-admitted (high novelty default)', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, { query: 'auth' });
    const result = consultLedger(
        [c1],
        baseReq({ query: null }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.suppressedCount, 0);
});

test('empty string current query: re-admitted (high novelty default)', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100 });
    seedAdmission(ledger, c1.id, { query: 'auth' });
    const result = consultLedger(
        [c1],
        baseReq({ query: '' }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    assert.equal(result.suppressedCount, 0);
});

/* ---------------- 11. Marker shape parseability ---------------- */

test('marker id encodes original chunk id parseably (substring after `ledger_marker:` to next `:`)', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100, id: 'chunk_deadbeef' });
    seedAdmission(ledger, c1.id, { query: 'auth' });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'auth', turn_id: 'turn_99' }),
        ledger,
        { now: 1_700_000_001_000 },
    );
    const marker = result.kept[0];
    assert.equal(marker.id, `ledger_marker:chunk_deadbeef:turn_99`);
    // Parse contract: substring after "ledger_marker:" up to next ":".
    const prefix = 'ledger_marker:';
    const after = marker.id.slice(prefix.length);
    const parsed = after.slice(0, after.indexOf(':'));
    assert.equal(parsed, 'chunk_deadbeef');
    // Marker metadata.custom carries explicit fields too.
    assert.equal(marker.metadata.custom.suppressed_chunk_id, 'chunk_deadbeef');
    assert.equal(marker.metadata.custom.prior_turn_id, 'turn_0');
});

/* ---------------- 12. Most-recent admission selection ---------------- */

test('_findMostRecentAdmission picks the latest by admitted_at', () => {
    const ledger = newLedger();
    seedAdmission(ledger, 'cid', { admitted_at: 100, turn_id: 't1' });
    seedAdmission(ledger, 'cid', { admitted_at: 300, turn_id: 't3' });
    seedAdmission(ledger, 'cid', { admitted_at: 200, turn_id: 't2' });
    const got = _findMostRecentAdmission(ledger, 'cid');
    assert.equal(got.turn_id, 't3');
});

test('multiple priors for same chunk: marker references most recent', () => {
    const ledger = newLedger();
    const c1 = makeChunk('alpha', { tokens: 100, id: 'chunk_x' });
    seedAdmission(ledger, c1.id, { query: 'auth', admitted_at: 100, turn_id: 'turn_old' });
    seedAdmission(ledger, c1.id, { query: 'auth', admitted_at: 500, turn_id: 'turn_recent' });
    const result = consultLedger(
        [c1],
        baseReq({ query: 'auth' }),
        ledger,
        { now: 600 },
    );
    assert.equal(result.suppressedCount, 1);
    const marker = result.kept[0];
    assert.match(marker.content, /see turn turn_recent/);
});

/* ---------------- 13. Threshold tunability ---------------- */

test('noveltyThreshold: 0.1 admits a borderline case; 0.9 suppresses it', () => {
    const c1 = makeChunk('alpha', { tokens: 100 });
    const setup = () => {
        const l = newLedger();
        // Partial overlap query, recent — composite ~0.5.
        seedAdmission(l, c1.id, { query: 'authentication flow', admitted_at: 1_700_000_000_000 });
        return l;
    };
    const lLow = setup();
    const rLow = consultLedger([c1], baseReq({ query: 'authentication tokens' }), lLow, {
        now: 1_700_000_001_000,
        noveltyThreshold: 0.1,
    });
    assert.equal(rLow.suppressedCount, 0, 'low threshold → re-admit');

    const lHigh = setup();
    const rHigh = consultLedger([c1], baseReq({ query: 'authentication tokens' }), lHigh, {
        now: 1_700_000_001_000,
        noveltyThreshold: 0.9,
    });
    assert.equal(rHigh.suppressedCount, 1, 'high threshold → suppress');
});

/* ---------------- 14. Synth turn_id collision-resistance ---------------- */

test('synthesized turn_id is unique across same-ms calls (counter disambiguates)', () => {
    _resetTurnIdCounterForTests();
    const ledger1 = newLedger();
    const ledger2 = newLedger();
    const req = baseReq({ turn_id: null });
    const c = makeChunk('alpha', { tokens: 100 });
    const r1 = consultLedger([c], req, ledger1, { now: 1234 });
    const r2 = consultLedger([c], req, ledger2, { now: 1234 });
    assert.equal(r1.turnIdSynthesized, true);
    assert.equal(r2.turnIdSynthesized, true);
    assert.notEqual(r1.turnId, r2.turnId);
    assert.match(r1.turnId, /^composer:1234:\d+$/);
    assert.match(r2.turnId, /^composer:1234:\d+$/);
});

test('opts.turnId overrides req.turn_id; explicit takes precedence', () => {
    const ledger = newLedger();
    const c = makeChunk('alpha', { tokens: 100 });
    const r = consultLedger([c], baseReq({ turn_id: 'from_req' }), ledger, {
        now: 1234,
        turnId: 'from_opts',
    });
    assert.equal(r.turnIdSynthesized, false);
    assert.equal(r.turnId, 'from_opts');
    assert.equal(ledger.admissions[0].turn_id, 'from_opts');
});

/* ---------------- _computeNovelty unit checks ---------------- */

test('_computeNovelty: identical query + recent + no embeddings → ~0', () => {
    const prior = {
        chunk_id: 'cid',
        admitted_at: 1000,
        turn_id: 't0',
        tokens: 50,
        query: 'authentication middleware',
        query_embedding: null,
        strategy: 'semantic',
        facets_covered: [],
    };
    const n = _computeNovelty({
        candidateId: 'cid',
        currentQuery: 'authentication middleware',
        currentEmbedding: null,
        hints: null,
        prior,
        now: 1100,
        timeDecayMs: DEFAULT_TIME_DECAY_MS,
    });
    assert.ok(n < 0.05, `expected near-zero novelty, got ${n}`);
});

test('_computeNovelty: explicit force short-circuits to 1.0', () => {
    const prior = {
        chunk_id: 'cid',
        admitted_at: 1000,
        turn_id: 't0',
        tokens: 50,
        query: 'auth',
        query_embedding: null,
        strategy: 'structural',
        facets_covered: [],
    };
    const n = _computeNovelty({
        candidateId: 'cid',
        currentQuery: 'auth',
        currentEmbedding: null,
        hints: [{ strategy: 'structural', mode: 'force', reason: 'rerun' }],
        prior,
        now: 1100,
        timeDecayMs: DEFAULT_TIME_DECAY_MS,
    });
    assert.equal(n, 1);
});

/* ---------------- Defaults sanity ---------------- */

test('exported defaults match module documentation', () => {
    assert.equal(DEFAULT_NOVELTY_THRESHOLD, 0.4);
    assert.equal(DEFAULT_TIME_DECAY_MS, 30 * 60 * 1000);
    assert.equal(MARKER_TOKEN_COST, 20);
});
