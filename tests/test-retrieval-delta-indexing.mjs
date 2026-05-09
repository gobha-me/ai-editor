/**
 * Tests for `tryDeltaIndexFromBranch` (manager-helpers.js).
 *
 * The pure decision tree that drives the retrieval index's branch-switch
 * delta path. Production wiring lives at `manager.js#_tryDeltaIndexFromBranch`,
 * which is a thin wrapper that supplies live deps (Storage / Git / clone /
 * load / reindex). Verifying the wrapper itself happens in the browser
 * preview as part of the release-readiness gate.
 *
 * Pinned semantics:
 *   - Returns `{ ok: true, reindexed, totalDelta }` when delta succeeded.
 *   - Returns `{ ok: false, reason }` when the path declined for a reason
 *     the caller can log + fall back to a full re-walk.
 *   - Empty diff + no dirty tabs → ok=true, totalDelta=0 (clone suffices).
 *   - Diff null (provider failure) → ok=false, reason=diff-unavailable.
 *   - Dirty open tabs are unioned with the diff list.
 *   - Same-branch / missing previousBranch / missing source-index all
 *     short-circuit before any IO.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryDeltaIndexFromBranch } from '../js/intelligence/retrieval/manager-helpers.js';

/** Build a deps object with sensible defaults; override per-test. */
function makeDeps(overrides = {}) {
    const calls = {
        hasSourceIndex: 0,
        fetchDiff: 0,
        cloneIndex: 0,
        loadIndex: 0,
        reindexChanged: [],
    };
    const deps = {
        previousBranch: 'main',
        branch: 'feature',
        openTabs: [],
        hasSourceIndex: () => { calls.hasSourceIndex++; return { chunks: ['stub'] }; },
        fetchDiff: async () => { calls.fetchDiff++; return ['a.js']; },
        cloneIndex: () => { calls.cloneIndex++; return true; },
        loadIndex: async () => { calls.loadIndex++; return true; },
        reindexChanged: async (paths) => { calls.reindexChanged.push(paths); return paths.length; },
        ...overrides,
    };
    return { deps, calls };
}

test('happy path: diff has 2 files → reindexes exactly those 2', async () => {
    const { deps, calls } = makeDeps({
        fetchDiff: async () => ['a.js', 'b.js'],
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.equal(r.ok, true);
    assert.equal(r.reindexed, 2);
    assert.equal(r.totalDelta, 2);
    assert.equal(calls.cloneIndex, 1, 'clone runs before reindex');
    assert.equal(calls.loadIndex, 1, 'load runs after clone');
    assert.deepEqual(calls.reindexChanged, [['a.js', 'b.js']]);
});

test('empty diff + no dirty tabs → cloned index suffices, no reindex', async () => {
    const { deps, calls } = makeDeps({
        fetchDiff: async () => [],
        openTabs: [],
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: true, reindexed: 0, totalDelta: 0 });
    assert.equal(calls.reindexChanged.length, 0, 'reindex not called when delta is empty');
});

test('dirty open tabs are unioned with the diff list', async () => {
    const { deps, calls } = makeDeps({
        fetchDiff: async () => ['a.js'],
        openTabs: [
            { path: 'a.js', dirty: true },        // duplicate — should not reappear
            { path: 'b.js', dirty: true },
            { path: 'c.js', dirty: false },        // not dirty — skip
            { path: '', dirty: true },             // empty path — skip
            null,                                  // junk entry — skip
            { dirty: true },                       // missing path — skip
        ],
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.equal(r.ok, true);
    assert.equal(r.totalDelta, 2);
    const seen = new Set(calls.reindexChanged[0]);
    assert.deepEqual(seen, new Set(['a.js', 'b.js']));
});

test('missing previousBranch → declined with reason=no-previous-branch', async () => {
    const { deps, calls } = makeDeps({
        previousBranch: undefined,
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'no-previous-branch' });
    assert.equal(calls.hasSourceIndex, 0, 'no IO before short-circuit');
    assert.equal(calls.fetchDiff, 0);
});

test('previousBranch === branch → declined with reason=no-previous-branch', async () => {
    const { deps } = makeDeps({
        previousBranch: 'main',
        branch: 'main',
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'no-previous-branch' });
});

test('no source index → declined with reason=no-source-index, no IO', async () => {
    const { deps, calls } = makeDeps({
        hasSourceIndex: () => null,    // nothing persisted for previousBranch
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'no-source-index' });
    assert.equal(calls.fetchDiff, 0, 'diff fetch skipped when no source index');
    assert.equal(calls.cloneIndex, 0);
});

test('fetchDiff throws → declined with reason=diff-unavailable, no clone', async () => {
    const { deps, calls } = makeDeps({
        fetchDiff: async () => { throw new Error('network'); },
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'diff-unavailable' });
    assert.equal(calls.cloneIndex, 0, 'no clone if diff is unknown');
});

test('fetchDiff returns null → declined with reason=diff-unavailable', async () => {
    const { deps, calls } = makeDeps({
        fetchDiff: async () => null,    // provider explicitly says "unsupported"
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'diff-unavailable' });
    assert.equal(calls.cloneIndex, 0);
});

test('cloneIndex returns false → declined with reason=clone-failed', async () => {
    const { deps, calls } = makeDeps({
        cloneIndex: () => false,
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'clone-failed' });
    assert.equal(calls.loadIndex, 0, 'no load after clone failure');
});

test('loadIndex returns false → declined with reason=load-failed', async () => {
    const { deps, calls } = makeDeps({
        loadIndex: async () => false,
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.deepEqual(r, { ok: false, reason: 'load-failed' });
    assert.equal(calls.reindexChanged.length, 0);
});

test('all dirty tabs but empty diff → reindexes only the dirty tabs', async () => {
    const { deps, calls } = makeDeps({
        fetchDiff: async () => [],
        openTabs: [{ path: 'wip.js', dirty: true }],
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.equal(r.ok, true);
    assert.equal(r.totalDelta, 1);
    assert.deepEqual(calls.reindexChanged, [['wip.js']]);
});

test('reindexChanged returns count is propagated', async () => {
    const { deps } = makeDeps({
        fetchDiff: async () => ['a.js', 'b.js', 'c.js'],
        reindexChanged: async () => 2,    // simulate one file 404 → silently dropped
    });
    const r = await tryDeltaIndexFromBranch(deps);
    assert.equal(r.ok, true);
    assert.equal(r.reindexed, 2, 'reindexed reflects actual ingest count');
    assert.equal(r.totalDelta, 3, 'totalDelta is the union pre-ingest');
});
