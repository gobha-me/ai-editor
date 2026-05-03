/**
 * Test-query fixture corpus tests (1.5.3).
 *
 * Covers `js/intelligence/retrieval/test-corpus.js` — the corpus the
 * 1.5.4 measurement PR will drive through `createComparisonHarness`
 * (1.5.2) against legacy `js/context-manager.js` and the new Composer.
 * Each test() block focused on a single invariant, mirroring sibling
 * test files (`test-retrieval-comparison.mjs`, etc.). Pure-data, no
 * DOM / State / network — runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    QUERY_CORPUS,
    QUERY_FIXTURES,
    QUERY_CATEGORIES,
    getQueriesByCategory,
} from '../js/intelligence/retrieval/test-corpus.js';

import { createComparisonHarness } from '../js/intelligence/retrieval/comparison.js';

/* ============================================================
 * QUERY_CATEGORIES — the enum-like surface
 * ============================================================ */

test('QUERY_CATEGORIES exposes the six Phase-1 buckets', () => {
    assert.equal(QUERY_CATEGORIES.FILE_DISCOVERY, 'file-discovery');
    assert.equal(QUERY_CATEGORIES.FUNCTION_DISCOVERY, 'function-discovery');
    assert.equal(QUERY_CATEGORIES.TOPIC, 'topic');
    assert.equal(QUERY_CATEGORIES.BUG_INVESTIGATION, 'bug-investigation');
    assert.equal(QUERY_CATEGORIES.ONBOARDING, 'onboarding');
    assert.equal(QUERY_CATEGORIES.TASK_RELATED, 'task-related');
});

test('QUERY_CATEGORIES is frozen — mutation attempts fail silently or throw in strict mode', () => {
    assert.ok(Object.isFrozen(QUERY_CATEGORIES));
});

test('QUERY_CATEGORIES values are unique', () => {
    const values = Object.values(QUERY_CATEGORIES);
    assert.equal(new Set(values).size, values.length);
});

/* ============================================================
 * QUERY_FIXTURES — corpus shape & per-fixture invariants
 * ============================================================ */

test('QUERY_FIXTURES is non-empty and within the harness "O(20-200)" sweet spot', () => {
    assert.ok(QUERY_FIXTURES.length >= 30, `expected ≥30 fixtures, got ${QUERY_FIXTURES.length}`);
    assert.ok(QUERY_FIXTURES.length <= 200, `expected ≤200 fixtures, got ${QUERY_FIXTURES.length}`);
});

test('QUERY_FIXTURES is frozen — mutation attempts cannot drift the corpus mid-batch', () => {
    assert.ok(Object.isFrozen(QUERY_FIXTURES));
});

test('every fixture has the four required string fields', () => {
    for (const f of QUERY_FIXTURES) {
        assert.equal(typeof f.id, 'string', `fixture missing string id: ${JSON.stringify(f)}`);
        assert.ok(f.id.length > 0, `fixture has empty id: ${JSON.stringify(f)}`);
        assert.equal(typeof f.query, 'string', `fixture ${f.id} missing string query`);
        assert.ok(f.query.length > 0, `fixture ${f.id} has empty query`);
        assert.equal(typeof f.category, 'string', `fixture ${f.id} missing string category`);
        assert.equal(typeof f.intent, 'string', `fixture ${f.id} missing string intent`);
        assert.ok(f.intent.length > 0, `fixture ${f.id} has empty intent`);
    }
});

test('every fixture id is unique', () => {
    const ids = QUERY_FIXTURES.map((f) => f.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `duplicate fixture ids found: ${dupes.join(', ')}`);
});

test('every fixture id is kebab-case (lowercase letters, digits, hyphens only)', () => {
    const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const f of QUERY_FIXTURES) {
        assert.ok(kebab.test(f.id), `fixture id is not kebab-case: ${f.id}`);
    }
});

test('every fixture query is unique', () => {
    const qs = QUERY_FIXTURES.map((f) => f.query);
    const dupes = qs.filter((q, i) => qs.indexOf(q) !== i);
    assert.deepEqual(dupes, [], `duplicate fixture queries found: ${dupes.join(' | ')}`);
});

test('every fixture category is one of QUERY_CATEGORIES values', () => {
    const valid = new Set(Object.values(QUERY_CATEGORIES));
    for (const f of QUERY_FIXTURES) {
        assert.ok(
            valid.has(f.category),
            `fixture ${f.id} has unknown category: ${f.category}`,
        );
    }
});

test('every QUERY_CATEGORIES value is referenced by at least one fixture', () => {
    const seen = new Set(QUERY_FIXTURES.map((f) => f.category));
    for (const cat of Object.values(QUERY_CATEGORIES)) {
        assert.ok(seen.has(cat), `category ${cat} has no fixtures`);
    }
});

/* ============================================================
 * 1.5.5 reframe — every fixture has a non-empty curated expectedPaths
 * ============================================================ */

test('every fixture has expectedPaths: string[] with ≥1 entry (1.5.5 reframe)', () => {
    for (const f of QUERY_FIXTURES) {
        assert.ok(Array.isArray(f.expectedPaths), `fixture ${f.id} missing expectedPaths array`);
        assert.ok(f.expectedPaths.length >= 1, `fixture ${f.id} has empty expectedPaths`);
        for (const p of f.expectedPaths) {
            assert.equal(typeof p, 'string', `fixture ${f.id} has non-string entry in expectedPaths`);
            assert.ok(p.length > 0, `fixture ${f.id} has empty-string entry in expectedPaths`);
        }
    }
});

test('expectedPaths are sorted alphabetically (so diffs are minimal when entries are added)', () => {
    for (const f of QUERY_FIXTURES) {
        const sorted = f.expectedPaths.slice().sort();
        assert.deepEqual(
            f.expectedPaths,
            sorted,
            `fixture ${f.id} expectedPaths not alphabetically sorted`,
        );
    }
});

test('expectedPaths entries are unique within a fixture', () => {
    for (const f of QUERY_FIXTURES) {
        const set = new Set(f.expectedPaths);
        assert.equal(
            set.size,
            f.expectedPaths.length,
            `fixture ${f.id} has duplicate entries in expectedPaths`,
        );
    }
});

test('per-category bucket sizes are within ~3x of the median (rough balance, no big skews)', () => {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const f of QUERY_FIXTURES) {
        counts[f.category] = (counts[f.category] || 0) + 1;
    }
    const sorted = Object.values(counts).slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (const [cat, n] of Object.entries(counts)) {
        assert.ok(
            n >= 3 && n <= median * 3,
            `category ${cat} count ${n} is way out of balance (median ${median})`,
        );
    }
});

/* ============================================================
 * QUERY_CORPUS — flat-string view derived from QUERY_FIXTURES
 * ============================================================ */

test('QUERY_CORPUS is frozen and non-empty', () => {
    assert.ok(Object.isFrozen(QUERY_CORPUS));
    assert.ok(QUERY_CORPUS.length > 0);
});

test('QUERY_CORPUS length matches QUERY_FIXTURES length', () => {
    assert.equal(QUERY_CORPUS.length, QUERY_FIXTURES.length);
});

test('QUERY_CORPUS is element-for-element parallel to QUERY_FIXTURES.map(f => f.query)', () => {
    for (let i = 0; i < QUERY_FIXTURES.length; i += 1) {
        assert.equal(
            QUERY_CORPUS[i],
            QUERY_FIXTURES[i].query,
            `QUERY_CORPUS[${i}] diverged from QUERY_FIXTURES[${i}].query`,
        );
    }
});

test('every QUERY_CORPUS entry is a non-empty string', () => {
    for (const q of QUERY_CORPUS) {
        assert.equal(typeof q, 'string');
        assert.ok(q.length > 0);
    }
});

/* ============================================================
 * getQueriesByCategory — the accessor helper
 * ============================================================ */

test('getQueriesByCategory returns all queries in the requested category', () => {
    const fileDiscovery = getQueriesByCategory(QUERY_CATEGORIES.FILE_DISCOVERY);
    const expected = QUERY_FIXTURES
        .filter((f) => f.category === QUERY_CATEGORIES.FILE_DISCOVERY)
        .map((f) => f.query);
    assert.deepEqual(fileDiscovery, expected);
});

test('getQueriesByCategory partitions the corpus exactly (sum of buckets = total)', () => {
    let total = 0;
    for (const cat of Object.values(QUERY_CATEGORIES)) {
        total += getQueriesByCategory(cat).length;
    }
    assert.equal(total, QUERY_FIXTURES.length);
});

test('getQueriesByCategory returns a fresh array on each call', () => {
    const cat = QUERY_CATEGORIES.TOPIC;
    const first = getQueriesByCategory(cat);
    const second = getQueriesByCategory(cat);
    assert.notStrictEqual(first, second);
    assert.deepEqual(first, second);
    first.push('mutation');
    assert.notDeepEqual(getQueriesByCategory(cat), first);
});

test('getQueriesByCategory returns [] for unknown category', () => {
    assert.deepEqual(getQueriesByCategory('not-a-category'), []);
    assert.deepEqual(getQueriesByCategory(''), []);
});

test('getQueriesByCategory returns [] (does not throw) for non-string input', () => {
    // @ts-expect-error — exercising the defensive branch
    assert.deepEqual(getQueriesByCategory(undefined), []);
    // @ts-expect-error
    assert.deepEqual(getQueriesByCategory(null), []);
    // @ts-expect-error
    assert.deepEqual(getQueriesByCategory(42), []);
    // @ts-expect-error
    assert.deepEqual(getQueriesByCategory({}), []);
});

/* ============================================================
 * Integration with the comparison harness — proves the corpus
 * actually drives `compareBatch` end-to-end without surprises.
 * ============================================================ */

test('QUERY_CORPUS feeds compareBatch end-to-end without throwing', async () => {
    let calls = 0;
    const h = createComparisonHarness({
        runLegacy: async (q) => {
            calls += 1;
            return [{ path: `legacy-${q}`, similarity: 1, summary: '' }];
        },
        runNew: async (q) => ({
            blocks: [{ position: 'retrieved', chunks: [`c-${q}`] }],
            chunks_by_id: {
                [`c-${q}`]: { metadata: { source_uri: `new-${q}` } },
            },
            used_tokens: 0,
            diagnostics: {},
        }),
        now: () => 0,
    });
    const report = await h.compareBatch(QUERY_CORPUS);
    assert.equal(report.total, QUERY_CORPUS.length);
    assert.equal(report.legacyFailures, 0);
    assert.equal(report.newFailures, 0);
    assert.equal(calls, QUERY_CORPUS.length);
    // Per-query entries one-to-one with corpus, in input order.
    for (let i = 0; i < QUERY_CORPUS.length; i += 1) {
        assert.equal(report.perQuery[i].query, QUERY_CORPUS[i]);
    }
});

test('QUERY_CORPUS produces a deterministic histogram when both pipelines disagree fully', async () => {
    // Both pipelines return disjoint single-result sets → Jaccard 0 for every
    // query → every result lands in the 0.0-0.2 bucket.
    const h = createComparisonHarness({
        runLegacy: async () => [{ path: 'L', similarity: 1, summary: '' }],
        runNew: async () => ({
            blocks: [{ position: 'retrieved', chunks: ['c'] }],
            chunks_by_id: { c: { metadata: { source_uri: 'N' } } },
            used_tokens: 0,
            diagnostics: {},
        }),
        now: () => 0,
    });
    const report = await h.compareBatch(QUERY_CORPUS);
    assert.equal(report.histogram['0.0-0.2'], QUERY_CORPUS.length);
    assert.equal(report.histogram['0.2-0.4'], 0);
    assert.equal(report.histogram['0.4-0.6'], 0);
    assert.equal(report.histogram['0.6-0.8'], 0);
    assert.equal(report.histogram['0.8-1.0'], 0);
    assert.equal(report.meanAgreement, 0);
});
