// @ts-check
/**
 * Tests for the slice-2 provider methods — Gitea + GitHub implement
 * `submitPullRequestReview`, `createReviewComment`, and a `capabilities`
 * getter; GitLab inherits the base `notSupported` throw.
 *
 * Each test stubs `request()` on a per-test merged provider clone
 * (mirroring how `git-providers/registry.js#register` builds the live
 * provider via `{ ...BASE_GIT_PROVIDER, ...provider }`) so endpoint /
 * body assertions don't hit the network.
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';
import giteaProvider from '../js/git-providers/gitea.js';
import githubProvider from '../js/git-providers/github.js';
import gitlabProvider from '../js/git-providers/gitlab.js';
import { ErrorCode } from '../js/utils/errors.js';

function mergedClone(provider) {
    return { ...BASE_GIT_PROVIDER, ...provider };
}

const FAKE_CONN = { id: 'c1', url: 'https://example.com', token: 'x' };

// ============================================
// Capabilities matrix
// ============================================

test('Gitea: capabilities advertises reviewSubmission + merge, not threadResolve/viewedFiles', () => {
    const caps = giteaProvider.capabilities;
    assert.equal(caps.reviewSubmission, true);
    assert.equal(caps.merge, true);
    assert.equal(caps.threadResolve, false);
    assert.equal(caps.viewedFiles, false);
});

test('GitHub: capabilities advertises reviewSubmission + merge, not threadResolve/viewedFiles', () => {
    const caps = githubProvider.capabilities;
    assert.equal(caps.reviewSubmission, true);
    assert.equal(caps.merge, true);
    assert.equal(caps.threadResolve, false);
    assert.equal(caps.viewedFiles, false);
});

test('Base: capabilities default to all false (no review submission)', () => {
    const baseCaps = BASE_GIT_PROVIDER.capabilities;
    assert.equal(baseCaps.reviewSubmission, false);
    assert.equal(baseCaps.merge, false);
});

test('GitLab: capabilities override declares mergeConflictResolution + five explicit-false flags', () => {
    // Slice 2 (2.19.0) added a minimal `capabilities` getter to GitLab
    // flipping `mergeConflictResolution` on. The other five flags were
    // made explicit `false` at 2.50.0 (ICD #4 finding #2) so the
    // shape-anti-regression at `test-provider-capabilities-shape.mjs`
    // can pin the six-flag contract. Each flag flips on in its own
    // slice with live testing.
    const caps = gitlabProvider.capabilities;
    assert.equal(caps.mergeConflictResolution, true);
    assert.equal(caps.reviewSubmission, false);
    assert.equal(caps.merge, false);
    assert.equal(caps.threadResolve, false);
    assert.equal(caps.viewedFiles, false);
    assert.equal(caps.rerunCi, false);
});

// ============================================
// Gitea — submitPullRequestReview
// ============================================

test('Gitea: submitPullRequestReview POSTs to /pulls/{n}/reviews with mapped enum + comments', async () => {
    const merged = mergedClone(giteaProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { id: 99, state: 'APPROVED', submitted_at: '2026-05-10T00:00:00Z', html_url: 'https://example.com/r/99' };
    };

    const result = await merged.submitPullRequestReview(FAKE_CONN, 'o', 'r', 7, {
        event: 'APPROVE',
        body: 'lgtm',
        comments: [
            { path: 'a.js', line: 5, side: 'RIGHT', body: 'nit' },
            { path: 'b.js', line: 3, side: 'LEFT', body: 'remove' },
        ],
    });

    assert.equal(captured.method, 'POST');
    assert.equal(captured.endpoint, '/repos/o/r/pulls/7/reviews');
    assert.equal(captured.data.event, 'APPROVED');
    assert.equal(captured.data.body, 'lgtm');
    assert.equal(captured.data.comments.length, 2);
    assert.deepEqual(captured.data.comments[0], { path: 'a.js', body: 'nit', new_position: 5 });
    assert.deepEqual(captured.data.comments[1], { path: 'b.js', body: 'remove', old_position: 3 });
    assert.equal(result.id, 99);
    assert.equal(result.state, 'APPROVED');
});

// ============================================
// GitHub — submitPullRequestReview
// ============================================

test('GitHub: submitPullRequestReview POSTs to /pulls/{n}/reviews with passthrough payload', async () => {
    const merged = mergedClone(githubProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { id: 5, state: 'COMMENTED', submitted_at: '2026-05-10T00:00:00Z' };
    };

    await merged.submitPullRequestReview(FAKE_CONN, 'o', 'r', 11, {
        event: 'COMMENT',
        body: 'see comments',
        comments: [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'fix' }],
    });

    assert.equal(captured.method, 'POST');
    assert.equal(captured.endpoint, '/repos/o/r/pulls/11/reviews');
    assert.equal(captured.data.event, 'COMMENT');
    assert.deepEqual(captured.data.comments, [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'fix' }]);
});

// ============================================
// GitHub — createReviewComment (line-anchored vs. reply)
// ============================================

test('GitHub: createReviewComment line-anchored requires commitSha', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async () => { throw new Error('should not be called'); };

    await assert.rejects(
        () => merged.createReviewComment(FAKE_CONN, 'o', 'r', 1, {
            body: 'x', path: 'a.js', line: 1, side: 'RIGHT', // commitSha missing
        }),
        /commitSha is required/
    );
});

test('GitHub: createReviewComment reply uses /comments/{id}/replies', async () => {
    const merged = mergedClone(githubProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { id: 200, body: data.body, user: { login: 'u' }, created_at: '2026-05-10T00:00:00Z' };
    };
    await merged.createReviewComment(FAKE_CONN, 'o', 'r', 8, {
        body: 'reply text',
        in_reply_to: 444,
    });
    assert.equal(captured.method, 'POST');
    assert.equal(captured.endpoint, '/repos/o/r/pulls/8/comments/444/replies');
    assert.deepEqual(captured.data, { body: 'reply text' });
});

test('GitHub: createReviewComment line-anchored uses /comments with commit_id', async () => {
    const merged = mergedClone(githubProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { id: 300, body: data.body, user: { login: 'u' }, created_at: '2026-05-10T00:00:00Z' };
    };
    await merged.createReviewComment(FAKE_CONN, 'o', 'r', 9, {
        body: 'inline',
        path: 'a.js',
        line: 12,
        side: 'RIGHT',
        commitSha: 'deadbeef',
    });
    assert.equal(captured.endpoint, '/repos/o/r/pulls/9/comments');
    assert.equal(captured.data.commit_id, 'deadbeef');
    assert.equal(captured.data.path, 'a.js');
    assert.equal(captured.data.line, 12);
    assert.equal(captured.data.side, 'RIGHT');
});

// ============================================
// Gitea — createReviewComment (reply uses single-comment review wrap)
// ============================================

test('Gitea: createReviewComment reply wraps as single-comment COMMENT review', async () => {
    const merged = mergedClone(giteaProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { id: 1 };
    };
    await merged.createReviewComment(FAKE_CONN, 'o', 'r', 4, {
        body: 'replying',
        in_reply_to: 999,
    });
    assert.equal(captured.method, 'POST');
    assert.equal(captured.endpoint, '/repos/o/r/pulls/4/reviews');
    assert.equal(captured.data.event, 'COMMENT');
    assert.deepEqual(captured.data.comments, [{ body: 'replying', reply: 999 }]);
});

// ============================================
// GitLab — inherits notSupported
// ============================================

test('GitLab: submitPullRequestReview throws GIT_NOT_SUPPORTED via base inheritance', async () => {
    const merged = mergedClone(gitlabProvider);
    await assert.rejects(
        () => merged.submitPullRequestReview(FAKE_CONN, 'o', 'r', 1, { event: 'COMMENT' }),
        (err) => err && err.code === ErrorCode.GIT_NOT_SUPPORTED
    );
});

test('GitLab: createReviewComment throws GIT_NOT_SUPPORTED', async () => {
    const merged = mergedClone(gitlabProvider);
    await assert.rejects(
        () => merged.createReviewComment(FAKE_CONN, 'o', 'r', 1, { body: 'x' }),
        (err) => err && err.code === ErrorCode.GIT_NOT_SUPPORTED
    );
});
