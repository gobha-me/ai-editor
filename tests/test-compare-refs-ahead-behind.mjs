/**
 * Tests for `getBranchAheadBehind` (1.12.0):
 *   - GitHub override: single /compare round-trip, reads ahead_by + behind_by
 *     from the response.
 *   - Base default: two compareRefs() calls, derives counts from
 *     `commits.length` (used by Gitea + GitLab).
 *   - Same-ref / missing args → { ahead: 0, behind: 0 } early.
 *   - compareRefs throws → { ahead: null, behind: null } (callers treat null
 *     as "unknown", not "0").
 *
 * The test imports the GitHub provider and the base provider directly and
 * stubs the request/compareRefs methods — no live network.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import githubProvider from '../js/git-providers/github.js';
import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';

// ============================================
// Helper: build a sandbox provider that delegates to a stub `compareRefs`
// while keeping the base default `getBranchAheadBehind` intact.
// ============================================

function makeBaseLike(stubCompareRefs) {
    const inst = Object.create(BASE_GIT_PROVIDER);
    inst.name = 'test';
    inst.compareRefs = async (...args) => stubCompareRefs(...args);
    return inst;
}

// ============================================
// Same-ref / missing args
// ============================================

test('base.getBranchAheadBehind returns 0/0 when branch === base', async () => {
    const inst = makeBaseLike(() => {
        throw new Error('should not be called');
    });
    assert.deepEqual(
        await inst.getBranchAheadBehind({}, 'o', 'r', 'main', 'main'),
        { ahead: 0, behind: 0 }
    );
});

test('base.getBranchAheadBehind returns 0/0 when base is missing', async () => {
    const inst = makeBaseLike(() => {
        throw new Error('should not be called');
    });
    assert.deepEqual(
        await inst.getBranchAheadBehind({}, 'o', 'r', 'feature', ''),
        { ahead: 0, behind: 0 }
    );
});

test('base.getBranchAheadBehind returns 0/0 when branch is missing', async () => {
    const inst = makeBaseLike(() => {
        throw new Error('should not be called');
    });
    assert.deepEqual(
        await inst.getBranchAheadBehind({}, 'o', 'r', '', 'main'),
        { ahead: 0, behind: 0 }
    );
});

// ============================================
// Base default: two-call pattern derives counts from commits.length
// ============================================

test('base default uses compareRefs(base→branch) for ahead and (branch→base) for behind', async () => {
    const seen = [];
    const inst = makeBaseLike((connection, owner, repo, base, head) => {
        seen.push({ base, head });
        // base→branch returns 7 commits ("ahead"); branch→base returns 2 ("behind")
        if (base === 'main' && head === 'feat') {
            return { commits: new Array(7).fill({ sha: 'x' }), totalCommits: 7 };
        }
        if (base === 'feat' && head === 'main') {
            return { commits: new Array(2).fill({ sha: 'y' }), totalCommits: 2 };
        }
        throw new Error(`unexpected compare(${base}, ${head})`);
    });

    const out = await inst.getBranchAheadBehind({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, { ahead: 7, behind: 2 });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { base: 'main', head: 'feat' });
    assert.deepEqual(seen[1], { base: 'feat', head: 'main' });
});

test('base default falls back to totalCommits when commits[] missing', async () => {
    const inst = makeBaseLike(async (_c, _o, _r, base, head) => {
        if (base === 'main' && head === 'feat') return { totalCommits: 4 };
        if (base === 'feat' && head === 'main') return { totalCommits: 1 };
        return {};
    });
    const out = await inst.getBranchAheadBehind({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, { ahead: 4, behind: 1 });
});

test('base default returns null/null on compareRefs error', async () => {
    const inst = makeBaseLike(async () => {
        throw new Error('boom');
    });
    const out = await inst.getBranchAheadBehind({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, { ahead: null, behind: null });
});

// ============================================
// GitHub override: single round-trip, reads ahead_by + behind_by
// ============================================

test('GitHubProvider.getBranchAheadBehind makes ONE request and reads ahead_by/behind_by', async () => {
    const inst = Object.create(githubProvider);
    inst.name = 'github-test';
    let calls = 0;
    inst.request = async (_conn, method, path) => {
        calls++;
        assert.equal(method, 'GET');
        assert.match(path, /\/repos\/o\/r\/compare\/main\.\.\.feat$/);
        return { ahead_by: 7, behind_by: 2 };
    };
    const out = await inst.getBranchAheadBehind({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, { ahead: 7, behind: 2 });
    assert.equal(calls, 1, 'GitHub should not need a second compare() call');
});

test('GitHubProvider returns null/null when the API omits ahead_by/behind_by', async () => {
    const inst = Object.create(githubProvider);
    inst.name = 'github-test';
    inst.request = async () => ({ /* no ahead_by */ });
    const out = await inst.getBranchAheadBehind({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, { ahead: null, behind: null });
});

test('GitHubProvider returns null/null when the request throws', async () => {
    const inst = Object.create(githubProvider);
    inst.name = 'github-test';
    inst.request = async () => { throw new Error('404'); };
    const out = await inst.getBranchAheadBehind({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, { ahead: null, behind: null });
});

test('GitHubProvider compareRefs surfaces aheadBy/behindBy in its return shape', async () => {
    const inst = Object.create(githubProvider);
    inst.name = 'github-test';
    inst.request = async () => ({
        commits: [{ sha: 'abc', commit: { message: 'm', author: { name: 'a', date: 'd' } } }],
        files: [{ filename: 'x', status: 'modified', additions: 1, deletions: 0, patch: '' }],
        total_commits: 1,
        ahead_by: 1,
        behind_by: 3,
    });
    const out = await inst.compareRefs({}, 'o', 'r', 'main', 'feat');
    assert.equal(out.aheadBy, 1);
    assert.equal(out.behindBy, 3);
    assert.equal(out.totalCommits, 1);
});
