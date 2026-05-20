/**
 * Tests for the Gitea provider's `compareRefs` + `getChangedFilesBetween`
 * (2.69.0).
 *
 * Pinned semantics:
 *   - `compareRefs` returns `files: []` unconditionally on Gitea — the
 *     upstream `Compare` schema has no top-level `files` field (verified
 *     against Gitea 1.25 swagger). No debug logs fire on the normal path
 *     (instrumentation that fired 9+ times per user navigation pre-2.69.0
 *     is gone).
 *   - The "0 commits" diagnostic still fires (it surfaces ACL / ref-name
 *     issues that the API otherwise returns silently).
 *   - `getChangedFilesBetween` reads `commits[].files` from each /compare
 *     round-trip (Gitea's CommitAffectedFiles → filename + status), unions
 *     paths across both directions, and returns:
 *       * `[]` when both directions have zero commits
 *       * `Array<string>` when at least one commit carries a `files` array
 *       * `null` when commits exist but no commit carries `files`
 *         (server omitted them — caller falls back to a full re-walk)
 *       * `null` on any compare error
 *   - Same-branch short-circuit (branchA === branchB) returns `[]` without
 *     hitting the network — preserved from the base default.
 *
 * Network-free: stubs `this.request` on a provider instance via
 * Object.create(giteaProvider).
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import giteaProvider from '../js/git-providers/gitea.js';

// ============================================
// Helpers
// ============================================

/** Build a sandbox Gitea provider with a stubbed `request`. */
function makeGitea(stubRequest) {
    const inst = Object.create(giteaProvider);
    inst.name = 'gitea-test';
    inst.request = stubRequest;
    return inst;
}

/** Capture console.log calls within a block so we can assert silence. */
function captureConsoleLog(fn) {
    const calls = [];
    const orig = console.log;
    console.log = (...args) => calls.push(args);
    try {
        return Promise.resolve(fn()).finally(() => { console.log = orig; });
    } catch (e) {
        console.log = orig;
        throw e;
    }
}

// ============================================
// compareRefs — shape contract
// ============================================

test('compareRefs returns files: [] regardless of API response (Gitea Compare schema has no files field)', async () => {
    const inst = makeGitea(async (_conn, method, path) => {
        assert.equal(method, 'GET');
        assert.match(path, /\/repos\/o\/r\/compare\/main\.\.\.feat$/);
        return {
            total_commits: 2,
            commits: [
                { sha: 'a1', commit: { message: 'one', author: { name: 'jeff', date: '2026-05-19' } } },
                { sha: 'a2', commit: { message: 'two', author: { name: 'jeff', date: '2026-05-19' } } },
            ],
        };
    });
    const out = await inst.compareRefs({}, 'o', 'r', 'main', 'feat');
    assert.deepEqual(out.files, []);
    assert.equal(out.totalCommits, 2);
    assert.equal(out.commits.length, 2);
    assert.equal(out.commits[0].sha, 'a1');
    assert.equal(out.commits[0].message, 'one');
});

test('compareRefs is silent on the normal (commits-present) path — no 9×-per-session debug logs', async () => {
    const inst = makeGitea(async () => ({
        total_commits: 1,
        commits: [{ sha: 'x', commit: { message: 'm', author: { name: 'a', date: 'd' } } }],
    }));
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args);
    try {
        await inst.compareRefs({}, 'o', 'r', 'main', 'feat');
    } finally {
        console.log = orig;
    }
    assert.equal(logs.length, 0, `expected zero console.log calls, got ${logs.length}: ${JSON.stringify(logs)}`);
});

test('compareRefs logs the "0 commits" snippet when the response is empty (surfaces ACL / bad-ref issues)', async () => {
    const inst = makeGitea(async () => ({ total_commits: 0, commits: [] }));
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args);
    try {
        await inst.compareRefs({}, 'o', 'r', 'main', 'feat');
    } finally {
        console.log = orig;
    }
    assert.equal(logs.length, 1);
    assert.match(String(logs[0][0]), /Compare returned 0 commits/);
});

test('compareRefs tolerates null/undefined response gracefully', async () => {
    const inst = makeGitea(async () => null);
    const orig = console.log;
    console.log = () => {};
    let out;
    try {
        out = await inst.compareRefs({}, 'o', 'r', 'main', 'feat');
    } finally {
        console.log = orig;
    }
    assert.deepEqual(out, { commits: [], files: [], totalCommits: 0 });
});

// ============================================
// getChangedFilesBetween — Gitea override
// ============================================

test('getChangedFilesBetween short-circuits to [] when branchA === branchB', async () => {
    const inst = makeGitea(async () => { throw new Error('should not call'); });
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'main', 'main');
    assert.deepEqual(out, []);
});

test('getChangedFilesBetween short-circuits to [] when either branch is missing', async () => {
    const inst = makeGitea(async () => { throw new Error('should not call'); });
    assert.deepEqual(await inst.getChangedFilesBetween({}, 'o', 'r', '', 'main'), []);
    assert.deepEqual(await inst.getChangedFilesBetween({}, 'o', 'r', 'feat', ''), []);
});

test('getChangedFilesBetween unions commits[].files paths from BOTH compare directions', async () => {
    const inst = makeGitea(async (_conn, _method, path) => {
        // a→b
        if (path.endsWith('/compare/feat...main')) {
            return {
                total_commits: 2,
                commits: [
                    { sha: 'b1', files: [{ filename: 'a.js', status: 'modified' }, { filename: 'b.js', status: 'added' }] },
                    { sha: 'b2', files: [{ filename: 'b.js', status: 'modified' }] },
                ],
            };
        }
        // b→a
        if (path.endsWith('/compare/main...feat')) {
            return {
                total_commits: 1,
                commits: [
                    { sha: 'c1', files: [{ filename: 'c.js', status: 'added' }, { filename: 'a.js', status: 'modified' }] },
                ],
            };
        }
        throw new Error(`unexpected ${path}`);
    });
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(new Set(out), new Set(['a.js', 'b.js', 'c.js']));
});

test('getChangedFilesBetween returns [] when both directions show zero commits (branches identical content-wise)', async () => {
    const inst = makeGitea(async () => ({ total_commits: 0, commits: [] }));
    // Suppress the "0 commits" log emitted by compareRefs — but here we call
    // request() directly inside the override, so no compareRefs log fires.
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'feat', 'main');
    assert.deepEqual(out, []);
});

test('getChangedFilesBetween returns null when commits exist but NO commit has a files array (forces safe re-walk)', async () => {
    const inst = makeGitea(async () => ({
        total_commits: 3,
        commits: [
            { sha: 'a1', commit: { message: 'one' } }, // no files
            { sha: 'a2', commit: { message: 'two' } }, // no files
        ],
    }));
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'feat', 'main');
    assert.equal(out, null);
});

test('getChangedFilesBetween skips files entries lacking a usable filename', async () => {
    const inst = makeGitea(async (_conn, _method, path) => {
        if (path.endsWith('/compare/a...b')) {
            return {
                total_commits: 1,
                commits: [{
                    sha: 'x',
                    files: [
                        { filename: 'good.js', status: 'modified' },
                        { filename: '', status: 'modified' },   // empty string → drop
                        { filename: null, status: 'modified' }, // null → drop
                        {},                                      // missing key → drop
                        null,                                    // null entry → drop
                        { filename: 'also.js', status: 'added' },
                    ],
                }],
            };
        }
        return { total_commits: 0, commits: [] };
    });
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.deepEqual(new Set(out), new Set(['good.js', 'also.js']));
});

test('getChangedFilesBetween returns null when one compare throws (Promise.all short-circuits)', async () => {
    const inst = makeGitea(async (_conn, _method, path) => {
        if (path.endsWith('/compare/a...b')) {
            return { total_commits: 1, commits: [{ sha: 'x', files: [{ filename: 'a.js' }] }] };
        }
        throw new Error('partial failure');
    });
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.equal(out, null);
});

test('getChangedFilesBetween mixes populated + unpopulated commits — populated paths still surface', async () => {
    const inst = makeGitea(async (_conn, _method, path) => {
        if (path.endsWith('/compare/a...b')) {
            return {
                total_commits: 2,
                commits: [
                    { sha: 'x1' }, // no files
                    { sha: 'x2', files: [{ filename: 'only.js', status: 'modified' }] },
                ],
            };
        }
        return { total_commits: 0, commits: [] };
    });
    const out = await inst.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.deepEqual(out, ['only.js']);
});

test('getChangedFilesBetween issues both /compare round-trips with the correct base/head pairs', async () => {
    const calls = [];
    const inst = makeGitea(async (_conn, _method, path) => {
        calls.push(path);
        return { total_commits: 0, commits: [] };
    });
    await inst.getChangedFilesBetween({}, 'o', 'r', 'feat', 'main');
    assert.equal(calls.length, 2);
    const seen = new Set(calls);
    assert.ok([...seen].some(p => p.endsWith('/compare/feat...main')), `missing feat→main: ${[...seen]}`);
    assert.ok([...seen].some(p => p.endsWith('/compare/main...feat')), `missing main→feat: ${[...seen]}`);
});

test('getChangedFilesBetween URL-encodes branch names with special chars', async () => {
    const calls = [];
    const inst = makeGitea(async (_conn, _method, path) => {
        calls.push(path);
        return { total_commits: 0, commits: [] };
    });
    await inst.getChangedFilesBetween({}, 'o', 'r', 'release/2.0', 'feat/x#42');
    // "/" stays unencoded per encodeURIComponent's spec — but "#" must encode.
    assert.ok(calls.every(p => !p.includes('#')), `# must be %23-encoded: ${calls}`);
});
