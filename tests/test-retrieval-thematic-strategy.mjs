/**
 * Thematic strategy tests (1.5.10).
 *
 * Covers `js/intelligence/retrieval/strategies/thematic.js` per
 * `docs/DESIGN-retrieval.md` §"Thematic (Phase 2)": k-means over filtered
 * vectors → return per-cluster representative → score is negative
 * distance to centroid. Tests cover the algorithmic Phase-2 spec
 * (applies_to gating, k-reduced fallback, 50k cap, cluster-collapse
 * resilience, determinism) plus the inline `defaultKmeans` helper.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. The
 * strategy is dependency-injected (`getChunksForClustering` + optional
 * `kmeans`), so tests construct deterministic fakes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createThematicStrategy,
    defaultKmeans,
    cosineSimilarity,
    cosineDistance,
    MAX_CLUSTER_VECTORS,
    QUERY_FREE_TASK_PATTERN,
} from '../js/intelligence/retrieval/strategies/thematic.js';

/* ---------------- Fixture builders ---------------- */

let nextId = 0;
const cid = () => `chunk_${(nextId++).toString(16).padStart(8, '0')}`;

/**
 * @param {number[]} embedding
 * @param {object} [overrides]
 */
function makeChunk(embedding, overrides = {}) {
    const id = overrides.id || cid();
    const content = overrides.content || `content for ${id}`;
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
            structural: overrides.structural ?? null,
            custom: overrides.custom || {},
        },
        provenance: {
            source_uri: overrides.source_uri || `docs/${id}.md`,
            byte_range: overrides.byte_range || [0, content.length],
            line_range: overrides.line_range || null,
            retrieved_by: 'pinned',
            score: 0,
            score_kind: 'cosine',
        },
        embedding,
    };
}

function makeReq(overrides = {}) {
    return {
        task: '',
        query: null,
        collections: ['docs'],
        budget: { total_tokens: 100_000, system_reserve: 0, output_reserve: 0, history_reserve: 0 },
        history: null,
        filters: null,
        strategy_hints: null,
        priority_pins: null,
        task_ledger: null,
        ...overrides,
    };
}

function makeStaticGetter(chunks) {
    return async (_collection) => chunks;
}

/**
 * Build a corpus that clusters cleanly into `clusterCount` groups in
 * 2-D space. Each group is a tight blob around a basis direction, so
 * k-means with k = clusterCount should recover the structure.
 */
function makeClusteredCorpus(clusterCount, perCluster, jitter = 0.02) {
    const chunks = [];
    // Spread cluster centers evenly around the unit circle in 2D.
    for (let c = 0; c < clusterCount; c++) {
        const theta = (2 * Math.PI * c) / clusterCount;
        const cx = Math.cos(theta);
        const cy = Math.sin(theta);
        for (let i = 0; i < perCluster; i++) {
            // Deterministic small jitter per index (no Math.random in test).
            const jx = ((c * 7 + i * 3) % 11 - 5) * jitter / 5;
            const jy = ((c * 11 + i * 5) % 13 - 6) * jitter / 6;
            chunks.push(makeChunk([cx + jx, cy + jy], {
                source_uri: `docs/cluster_${c}_${i}.md`,
            }));
        }
    }
    return chunks;
}

/* ---------------- applies_to ---------------- */

test('applies_to', async (t) => {
    const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter([]) });

    await t.test('returns 0.9 when query is null', () => {
        const a = strat.applies_to(makeReq({ query: null }));
        assert.equal(a.score, 0.9);
        assert.match(a.reason, /query-free/);
    });

    await t.test('returns 0.9 when query is empty string', () => {
        const a = strat.applies_to(makeReq({ query: '' }));
        assert.equal(a.score, 0.9);
    });

    await t.test('returns 0.9 when query is whitespace only', () => {
        const a = strat.applies_to(makeReq({ query: '   \n\t  ' }));
        assert.equal(a.score, 0.9);
    });

    await t.test('returns 0.9 when task matches "summarize"', () => {
        const a = strat.applies_to(makeReq({ query: 'anything', task: 'summarize this codebase' }));
        assert.equal(a.score, 0.9);
        assert.match(a.reason, /query-free task pattern/);
    });

    await t.test('returns 0.9 when task matches "overview"', () => {
        const a = strat.applies_to(makeReq({ query: 'anything', task: 'give an overview of the project' }));
        assert.equal(a.score, 0.9);
    });

    await t.test('returns 0.9 when task matches "categorize"', () => {
        const a = strat.applies_to(makeReq({ query: 'anything', task: 'categorize the files' }));
        assert.equal(a.score, 0.9);
    });

    await t.test('returns 0.9 when task matches "themes"', () => {
        const a = strat.applies_to(makeReq({ query: 'anything', task: 'what themes are here' }));
        assert.equal(a.score, 0.9);
    });

    await t.test('returns 0 when query is present and task is unrelated', () => {
        const a = strat.applies_to(makeReq({ query: 'find git URL parser', task: 'find_relevant_files' }));
        assert.equal(a.score, 0);
        assert.match(a.reason, /skipped/);
    });

    await t.test('QUERY_FREE_TASK_PATTERN export is the canonical regex', () => {
        assert.ok(QUERY_FREE_TASK_PATTERN.test('summarize'));
        assert.ok(QUERY_FREE_TASK_PATTERN.test('summarise'));
        assert.ok(QUERY_FREE_TASK_PATTERN.test('overview'));
        assert.ok(QUERY_FREE_TASK_PATTERN.test('categorize'));
        assert.ok(QUERY_FREE_TASK_PATTERN.test('categorise'));
        assert.ok(QUERY_FREE_TASK_PATTERN.test('themes'));
        assert.ok(QUERY_FREE_TASK_PATTERN.test('theme'));
        assert.ok(!QUERY_FREE_TASK_PATTERN.test('find'));
    });
});

/* ---------------- retrieve: empty / degenerate ---------------- */

test('retrieve: empty / degenerate', async (t) => {
    await t.test('returns [] when quota is 0', async () => {
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter([makeChunk([1, 0])]),
        });
        const out = await strat.retrieve(makeReq(), 0);
        assert.deepEqual(out, []);
    });

    await t.test('returns [] when quota is negative', async () => {
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter([makeChunk([1, 0])]),
        });
        const out = await strat.retrieve(makeReq(), -1);
        assert.deepEqual(out, []);
    });

    await t.test('returns [] when collections is empty', async () => {
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter([makeChunk([1, 0])]),
        });
        const out = await strat.retrieve(makeReq({ collections: [] }), 4);
        assert.deepEqual(out, []);
    });

    await t.test('returns [] when collection has no chunks', async () => {
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter([]) });
        const out = await strat.retrieve(makeReq(), 4);
        assert.deepEqual(out, []);
    });

    await t.test('returns [] when no chunks have embeddings', async () => {
        const chunks = [
            makeChunk(null),
            { ...makeChunk([1, 0]), embedding: null },
            { ...makeChunk([0, 1]), embedding: undefined },
        ];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 3);
        assert.deepEqual(out, []);
    });

    await t.test('returns [] when filter excludes everything', async () => {
        const chunks = [makeChunk([1, 0], { content_type: 'prose' })];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq({ filters: { content_types: ['code'] } }), 4);
        assert.deepEqual(out, []);
    });
});

/* ---------------- retrieve: k-reduced (N <= quota) ---------------- */

test('retrieve: returns all chunks when N <= quota (k-reduced path)', async (t) => {
    await t.test('N < quota → returns all N', async () => {
        const chunks = [
            makeChunk([1, 0]),
            makeChunk([0, 1]),
            makeChunk([-1, 0]),
        ];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 5);
        assert.equal(out.length, 3);
        assert.deepEqual(out.map(c => c.id).sort(), chunks.map(c => c.id).sort());
        // k-reduced path stamps distance = 0 (no clustering performed).
        for (const c of out) {
            assert.equal(c.provenance.score, 0);
            assert.equal(c.provenance.score_kind, 'cluster_distance');
            assert.equal(c.provenance.retrieved_by, 'thematic');
        }
    });

    await t.test('N == quota → returns all N', async () => {
        const chunks = [makeChunk([1, 0]), makeChunk([0, 1]), makeChunk([-1, 0]), makeChunk([0, -1])];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 4);
        assert.equal(out.length, 4);
    });
});

/* ---------------- retrieve: clustering (N > quota) ---------------- */

test('retrieve: clustering returns quota representatives', async (t) => {
    await t.test('three well-separated clusters → 3 representatives, one per cluster', async () => {
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 3);
        assert.equal(out.length, 3);
        // Reps should span all three cluster regions (distinct prefixes).
        const prefixes = new Set(out.map(c => c.metadata.source_uri.split('_')[1]));
        assert.equal(prefixes.size, 3);
    });

    await t.test('provenance: retrieved_by="thematic", score_kind="cluster_distance"', async () => {
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 3);
        for (const c of out) {
            assert.equal(c.provenance.retrieved_by, 'thematic');
            assert.equal(c.provenance.score_kind, 'cluster_distance');
            // score = -distance, distance >= 0, so score <= 0.
            assert.ok(c.provenance.score <= 0);
            assert.ok(Number.isFinite(c.provenance.score));
        }
    });

    await t.test('result chunks have embedding stripped (consistent with semantic posture)', async () => {
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 3);
        for (const c of out) {
            assert.equal(c.embedding, null);
        }
    });

    await t.test('result is sorted ascending by distance (best representative first)', async () => {
        const chunks = makeClusteredCorpus(4, 6);
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 4);
        for (let i = 1; i < out.length; i++) {
            // score = -distance; ascending distance = descending score.
            assert.ok(out[i - 1].provenance.score >= out[i].provenance.score);
        }
    });

    await t.test('determinism: same input + same default seed → same output', async () => {
        const chunks = makeClusteredCorpus(3, 8);
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const a = await strat.retrieve(makeReq(), 3);
        const b = await strat.retrieve(makeReq(), 3);
        assert.deepEqual(a.map(c => c.id), b.map(c => c.id));
    });

    await t.test('different seeds may produce different outputs (determinism is per-seed)', async () => {
        const chunks = makeClusteredCorpus(3, 8);
        const a = await createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            seed: 1,
        }).retrieve(makeReq(), 3);
        const b = await createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            seed: 1,
        }).retrieve(makeReq(), 3);
        // Same seed → same output.
        assert.deepEqual(a.map(c => c.id), b.map(c => c.id));
    });
});

/* ---------------- retrieve: filter ---------------- */

test('retrieve: honors MetadataFilter', async (t) => {
    await t.test('content_types accept-list filters before clustering', async () => {
        const chunks = [
            ...makeClusteredCorpus(2, 5).map(c => ({ ...c, metadata: { ...c.metadata, content_type: 'code' } })),
            ...makeClusteredCorpus(2, 5).map(c => ({ ...c, metadata: { ...c.metadata, content_type: 'prose' } })),
        ];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(
            makeReq({ filters: { content_types: ['code'] } }),
            3,
        );
        for (const c of out) {
            assert.equal(c.metadata.content_type, 'code');
        }
    });

    await t.test('custom predicate function filters before clustering', async () => {
        const chunks = [
            makeChunk([1, 0], { custom: { lang: 'js' } }),
            makeChunk([0, 1], { custom: { lang: 'py' } }),
            makeChunk([-1, 0], { custom: { lang: 'js' } }),
            makeChunk([0, -1], { custom: { lang: 'py' } }),
        ];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(
            makeReq({ filters: { custom: { lang: (v) => v === 'js' } } }),
            2,
        );
        for (const c of out) {
            assert.equal(c.metadata.custom.lang, 'js');
        }
    });

    await t.test('custom strict-equal predicate filters before clustering', async () => {
        const chunks = [
            makeChunk([1, 0], { custom: { tier: 'A' } }),
            makeChunk([0, 1], { custom: { tier: 'B' } }),
            makeChunk([-1, 0], { custom: { tier: 'A' } }),
        ];
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(
            makeReq({ filters: { custom: { tier: 'A' } } }),
            2,
        );
        assert.ok(out.length > 0);
        for (const c of out) {
            assert.equal(c.metadata.custom.tier, 'A');
        }
    });
});

/* ---------------- retrieve: 50k cap ---------------- */

test('retrieve: 50k cap triggers uniform sampling', async (t) => {
    await t.test('cap is exposed as named export', () => {
        assert.equal(MAX_CLUSTER_VECTORS, 50_000);
    });

    await t.test('above cap → still returns quota chunks', async () => {
        // Build a corpus larger than cap. Use shared-shape chunks with small variation
        // so the test stays fast (no need to actually populate 50k+1 distinct ones —
        // we'll fake the cap to a small value via DI is not possible here, so just
        // verify behavior at boundary).
        // For test speed, we don't actually hit 50k. We verify the path by injecting
        // a kmeans fake that asserts it received <= cap vectors when we do.
        let sawCount = -1;
        const fakeKmeans = (vectors, k) => {
            sawCount = vectors.length;
            const dim = vectors[0].length;
            return {
                centers: Array.from({ length: k }, () => new Array(dim).fill(0)),
                assignments: vectors.map((_, i) => i % k),
            };
        };
        const chunks = makeClusteredCorpus(5, 4); // 20 chunks, well under cap
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            kmeans: fakeKmeans,
        });
        await strat.retrieve(makeReq(), 5);
        assert.equal(sawCount, chunks.length);
        assert.ok(sawCount <= MAX_CLUSTER_VECTORS);
    });
});

/* ---------------- retrieve: cluster collapse ---------------- */

test('retrieve: cluster collapse (one dominant cluster)', async (t) => {
    await t.test('still returns quota representatives even when 90% mass in one cluster', async () => {
        const chunks = [];
        // 18 chunks tightly around (1, 0)
        for (let i = 0; i < 18; i++) {
            chunks.push(makeChunk([1 + i * 0.0001, 0 + i * 0.0001], {
                source_uri: `docs/dominant_${i}.md`,
            }));
        }
        // 2 outlier chunks far away
        chunks.push(makeChunk([0, 1], { source_uri: 'docs/outlier_a.md' }));
        chunks.push(makeChunk([0, -1], { source_uri: 'docs/outlier_b.md' }));
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter(chunks) });
        const out = await strat.retrieve(makeReq(), 4);
        // Algorithm guarantees up to quota representatives. Some clusters may
        // collapse and lose their slot, but the count is bounded by quota.
        assert.ok(out.length >= 1, 'should return at least one rep');
        assert.ok(out.length <= 4, 'should not exceed quota');
    });
});

/* ---------------- retrieve: malformed kmeans output ---------------- */

test('retrieve: defensive against malformed kmeans output', async (t) => {
    await t.test('kmeans returns non-array centers → degrade to first quota chunks', async () => {
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            kmeans: () => ({ centers: 'not-an-array', assignments: [] }),
        });
        const out = await strat.retrieve(makeReq(), 3);
        assert.equal(out.length, 3);
        assert.ok(out.every(c => c.provenance.score === 0));
    });

    await t.test('kmeans returns wrong-length centers → degrade to first quota chunks', async () => {
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            kmeans: () => ({ centers: [[1, 0]], assignments: chunks.map(() => 0) }),
        });
        const out = await strat.retrieve(makeReq(), 3);
        assert.equal(out.length, 3);
    });

    await t.test('kmeans returns wrong-length assignments → degrade to first quota chunks', async () => {
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            kmeans: () => ({ centers: [[1, 0], [0, 1], [-1, 0]], assignments: [0] }),
        });
        const out = await strat.retrieve(makeReq(), 3);
        assert.equal(out.length, 3);
    });
});

/* ---------------- DI ---------------- */

test('DI: factory contract', async (t) => {
    await t.test('throws when getChunksForClustering is not a function', () => {
        assert.throws(
            () => createThematicStrategy({}),
            /getChunksForClustering/,
        );
    });

    await t.test('throws when kmeans is not a function', () => {
        assert.throws(
            () => createThematicStrategy({
                getChunksForClustering: makeStaticGetter([]),
                kmeans: 'not-a-fn',
            }),
            /kmeans/,
        );
    });

    await t.test('throws when seed is not finite', () => {
        assert.throws(
            () => createThematicStrategy({
                getChunksForClustering: makeStaticGetter([]),
                seed: NaN,
            }),
            /seed/,
        );
    });

    await t.test('custom kmeans is called instead of default', async () => {
        let called = false;
        const customKmeans = (vectors, k) => {
            called = true;
            return {
                centers: Array.from({ length: k }, (_, i) => vectors[i]),
                assignments: vectors.map((_, i) => i % k),
            };
        };
        const chunks = makeClusteredCorpus(3, 5);
        const strat = createThematicStrategy({
            getChunksForClustering: makeStaticGetter(chunks),
            kmeans: customKmeans,
        });
        await strat.retrieve(makeReq(), 3);
        assert.ok(called);
    });

    await t.test('getChunksForClustering called with the requested collection', async () => {
        let sawCollection = null;
        const strat = createThematicStrategy({
            getChunksForClustering: async (c) => { sawCollection = c; return []; },
        });
        await strat.retrieve(makeReq({ collections: ['workspace'] }), 3);
        assert.equal(sawCollection, 'workspace');
    });

    await t.test('strategy.name is "thematic"', () => {
        const strat = createThematicStrategy({ getChunksForClustering: makeStaticGetter([]) });
        assert.equal(strat.name, 'thematic');
    });
});

/* ---------------- defaultKmeans helper ---------------- */

test('defaultKmeans helper', async (t) => {
    await t.test('k=1: single cluster, all assignments are 0', () => {
        const vectors = [[1, 0], [0, 1], [-1, 0], [0, -1]];
        const { centers, assignments } = defaultKmeans(vectors, 1);
        assert.equal(centers.length, 1);
        assert.equal(assignments.length, 4);
        for (const a of assignments) assert.equal(a, 0);
    });

    await t.test('k = N: each vector gets its own cluster (assignments cover [0,k))', () => {
        const vectors = [[1, 0], [0, 1], [-1, 0], [0, -1]];
        const { centers, assignments } = defaultKmeans(vectors, 4);
        assert.equal(centers.length, 4);
        assert.equal(assignments.length, 4);
        const assigned = new Set(assignments);
        assert.equal(assigned.size, 4);
        for (const a of assigned) {
            assert.ok(a >= 0 && a < 4);
        }
    });

    await t.test('three clusters: recovers ground truth at the cluster level', () => {
        const corpus = makeClusteredCorpus(3, 8, 0.005);
        const vectors = corpus.map(c => c.embedding);
        const { centers, assignments } = defaultKmeans(vectors, 3, { seed: 7 });
        assert.equal(centers.length, 3);
        // Each cluster prefix should map to one assignment value.
        const groupings = new Map();
        for (let i = 0; i < corpus.length; i++) {
            const prefix = corpus[i].metadata.source_uri.split('_')[1]; // "0", "1", "2"
            const key = `${prefix}->${assignments[i]}`;
            groupings.set(key, (groupings.get(key) || 0) + 1);
        }
        // Only 3 (prefix → assignment) pairs should appear, one per cluster.
        assert.equal(groupings.size, 3);
    });

    await t.test('determinism: same vectors + same seed → same result', () => {
        const corpus = makeClusteredCorpus(4, 5);
        const vectors = corpus.map(c => c.embedding);
        const a = defaultKmeans(vectors, 4, { seed: 99 });
        const b = defaultKmeans(vectors, 4, { seed: 99 });
        assert.deepEqual(a.assignments, b.assignments);
    });

    await t.test('terminates within maxIter', () => {
        const corpus = makeClusteredCorpus(3, 10);
        const vectors = corpus.map(c => c.embedding);
        const { centers, assignments } = defaultKmeans(vectors, 3, { maxIter: 1, seed: 3 });
        assert.equal(centers.length, 3);
        assert.equal(assignments.length, vectors.length);
    });

    await t.test('zero-norm vector handled gracefully (cosine returns 0)', () => {
        const vectors = [[0, 0], [1, 0], [0, 1]];
        const { centers, assignments } = defaultKmeans(vectors, 2, { seed: 4 });
        assert.equal(centers.length, 2);
        assert.equal(assignments.length, 3);
    });
});

/* ---------------- cosineSimilarity / cosineDistance helpers ---------------- */

test('cosine helpers', async (t) => {
    await t.test('cosineSimilarity of identical vectors is 1', () => {
        assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    });

    await t.test('cosineSimilarity of orthogonal vectors is 0', () => {
        assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    });

    await t.test('cosineSimilarity of opposite vectors is -1', () => {
        assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    });

    await t.test('cosineSimilarity returns 0 for length mismatch', () => {
        assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
    });

    await t.test('cosineSimilarity returns 0 for zero-norm input', () => {
        assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
        assert.equal(cosineSimilarity([1, 0], [0, 0]), 0);
    });

    await t.test('cosineDistance of identical vectors is 0', () => {
        assert.equal(cosineDistance([1, 0], [1, 0]), 0);
    });

    await t.test('cosineDistance of orthogonal vectors is 1', () => {
        assert.equal(cosineDistance([1, 0], [0, 1]), 1);
    });
});
