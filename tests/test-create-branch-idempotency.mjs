// @ts-check
/**
 * Tests for the idempotent-on-existing-ref contract of `createBranch`
 * on the Gitea + GitHub + GitLab providers. The base-interface jsdoc at
 * [`js/git-providers/base.js`](../js/git-providers/base.js) pins the
 * contract: when the target ref already exists on the remote, the call
 * MUST resolve successfully and return the branch name rather than
 * throw. Each remote provider translates its own error envelope for
 * this case (Gitea: 500 + `PushRejected` / `reference already exists`;
 * GitHub: 422 + `Reference already exists`; GitLab: 400 + `Branch
 * already exists`) into the idempotent path.
 *
 * `git:branchCreated` is emitted only on the genuine-creation path —
 * the existing-ref path stays silent so downstream listeners don't
 * fire a "created" reaction for a branch that was already present.
 *
 * Mirrors the per-test merged-provider-clone stub idiom from
 * [`tests/test-pr-review-provider-shape.mjs`](./test-pr-review-provider-shape.mjs).
 *
 * @since 2.69.0 (Gitea + GitHub); 2.74.0 (GitLab cohort closure)
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';
import giteaProvider from '../js/git-providers/gitea.js';
import githubProvider from '../js/git-providers/github.js';
import gitlabProvider from '../js/git-providers/gitlab.js';
import { EventBus } from '../js/core.js';

function mergedClone(provider) {
    return { ...BASE_GIT_PROVIDER, ...provider };
}

/**
 * Capture every payload emitted on `git:branchCreated` for the body of
 * `fn`. Returns the captured payloads after `fn` resolves; always
 * unsubscribes (including on throw) so cross-test pollution is
 * impossible.
 */
async function captureBranchCreatedEvents(fn) {
    const events = [];
    const off = EventBus.on('git:branchCreated', (payload) => events.push(payload));
    try {
        await fn();
        return events;
    } finally {
        off();
    }
}

const FAKE_CONN = { id: 'c1', url: 'https://example.com', token: 'x' };
const BRANCH = 'issue/221-make-createbranch-idempotent';

// ============================================
// Gitea — happy path (genuine creation emits event)
// ============================================

test('Gitea: createBranch on a fresh ref returns name and emits git:branchCreated', async () => {
    const merged = mergedClone(giteaProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { name: BRANCH };
    };

    const events = await captureBranchCreatedEvents(async () => {
        const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
        assert.equal(result, BRANCH);
    });

    assert.equal(captured.method, 'POST');
    assert.equal(captured.endpoint, '/repos/o/r/branches');
    assert.deepEqual(captured.data, { new_branch_name: BRANCH, old_branch_name: 'main' });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, BRANCH);
});

// ============================================
// Gitea — idempotency on existing ref
// ============================================

test('Gitea: createBranch swallows 500 + PushRejected / reference already exists, returns name', async () => {
    const merged = mergedClone(giteaProvider);
    merged.request = async () => {
        // Verbatim shape of the production 500 body — branch name embedded
        // in the git push error.
        const body = `{"message":"PushRejected Error: ... remote: error: cannot lock ref 'refs/heads/${BRANCH}': reference already exists ..."}`;
        const err = new Error(`Gitea API Error: 500 - ${body}`);
        // @ts-ignore — provider error shape carries `status` on a plain Error
        err.status = 500;
        throw err;
    };

    const events = await captureBranchCreatedEvents(async () => {
        const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
        assert.equal(result, BRANCH);
    });
    // The existing-ref path is silent — no event fires.
    assert.equal(events.length, 0);
});

test('Gitea: createBranch swallows 500 even when only the PushRejected marker is present', async () => {
    // Belt-and-braces: the helper matches either marker so a minor
    // server-side message tweak (dropping the "reference already exists"
    // phrasing) doesn't silently regress the idempotency path.
    const merged = mergedClone(giteaProvider);
    merged.request = async () => {
        const err = new Error(`Gitea API Error: 500 - PushRejected: failed to update ref 'refs/heads/${BRANCH}'`);
        // @ts-ignore
        err.status = 500;
        throw err;
    };

    const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
    assert.equal(result, BRANCH);
});

test('Gitea: createBranch does NOT swallow unrelated 500 errors', async () => {
    // A 500 without the marker phrases is a real server-side failure
    // and MUST propagate.
    const merged = mergedClone(giteaProvider);
    merged.request = async () => {
        const err = new Error('Gitea API Error: 500 - internal database error');
        // @ts-ignore
        err.status = 500;
        throw err;
    };

    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /internal database error/
    );
});

test('Gitea: createBranch does NOT swallow PushRejected for a different branch name', async () => {
    // The helper requires the branch name to appear in the body so an
    // unrelated PushRejected (e.g. a hook failure on another ref) is
    // not silently treated as "this branch already exists."
    const merged = mergedClone(giteaProvider);
    merged.request = async () => {
        const err = new Error(`Gitea API Error: 500 - PushRejected on refs/heads/some-other-branch: reference already exists`);
        // @ts-ignore
        err.status = 500;
        throw err;
    };

    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /PushRejected/
    );
});

test('Gitea: createBranch propagates non-500 errors unchanged', async () => {
    const merged = mergedClone(giteaProvider);
    merged.request = async () => {
        const err = new Error('Gitea API Error: 404 - not found');
        // @ts-ignore
        err.status = 404;
        throw err;
    };
    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /404/
    );
});

// ============================================
// GitHub — happy path (genuine creation emits event)
// ============================================

test('GitHub: createBranch on a fresh ref returns name and emits git:branchCreated', async () => {
    const merged = mergedClone(githubProvider);
    const calls = [];
    merged.request = async (_conn, method, endpoint, data) => {
        calls.push({ method, endpoint, data });
        if (method === 'GET') {
            return { commit: { sha: 'deadbeefcafe' } };
        }
        return { ref: `refs/heads/${BRANCH}` };
    };

    const events = await captureBranchCreatedEvents(async () => {
        const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
        assert.equal(result, BRANCH);
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].endpoint, '/repos/o/r/branches/main');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].endpoint, '/repos/o/r/git/refs');
    assert.deepEqual(calls[1].data, { ref: `refs/heads/${BRANCH}`, sha: 'deadbeefcafe' });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, BRANCH);
});

// ============================================
// GitHub — idempotency on existing ref
// ============================================

test('GitHub: createBranch swallows 422 + Reference already exists, returns name', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async (_conn, method) => {
        if (method === 'GET') {
            return { commit: { sha: 'deadbeefcafe' } };
        }
        const err = new Error('GitHub: Reference already exists');
        // @ts-ignore
        err.status = 422;
        throw err;
    };

    const events = await captureBranchCreatedEvents(async () => {
        const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
        assert.equal(result, BRANCH);
    });
    assert.equal(events.length, 0);
});

test('GitHub: createBranch does NOT swallow unrelated 422 validation errors', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async (_conn, method) => {
        if (method === 'GET') {
            return { commit: { sha: 'deadbeefcafe' } };
        }
        const err = new Error('GitHub: Validation Failed — invalid ref name');
        // @ts-ignore
        err.status = 422;
        throw err;
    };
    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /Validation Failed/
    );
});

test('GitHub: createBranch propagates non-422 errors unchanged', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async (_conn, method) => {
        if (method === 'GET') {
            return { commit: { sha: 'deadbeefcafe' } };
        }
        const err = new Error('GitHub: not found');
        // @ts-ignore
        err.status = 404;
        throw err;
    };
    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /not found/
    );
});

// ============================================
// GitLab — happy path (genuine creation emits event)
// ============================================

test('GitLab: createBranch on a fresh ref returns name and emits git:branchCreated', async () => {
    const merged = mergedClone(gitlabProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint, data) => {
        captured = { method, endpoint, data };
        return { name: BRANCH };
    };

    const events = await captureBranchCreatedEvents(async () => {
        const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
        assert.equal(result, BRANCH);
    });

    assert.equal(captured.method, 'POST');
    // GitLab URL-encodes owner/repo as a single path segment.
    assert.equal(captured.endpoint, '/projects/o%2Fr/repository/branches');
    assert.deepEqual(captured.data, { branch: BRANCH, ref: 'main' });
    assert.equal(events.length, 1);
    assert.equal(events[0].name, BRANCH);
});

// ============================================
// GitLab — idempotency on existing ref
// ============================================

test('GitLab: createBranch swallows 400 + Branch already exists, returns name', async () => {
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => {
        // Verbatim shape of the production 400 body — GitLab's canonical
        // message does not include the branch name, mirroring GitHub.
        const err = new Error('GitLab: Branch already exists');
        // @ts-ignore — provider error shape carries `status` on a plain Error
        err.status = 400;
        throw err;
    };

    const events = await captureBranchCreatedEvents(async () => {
        const result = await merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main');
        assert.equal(result, BRANCH);
    });
    // The existing-ref path is silent — no event fires.
    assert.equal(events.length, 0);
});

test('GitLab: createBranch does NOT swallow unrelated 400 validation errors', async () => {
    // A 400 without the canonical marker is a real validation failure
    // and MUST propagate.
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => {
        const err = new Error('GitLab: 400 validation failed — invalid ref name');
        // @ts-ignore
        err.status = 400;
        throw err;
    };
    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /validation failed/
    );
});

test('GitLab: createBranch propagates non-400 errors unchanged', async () => {
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => {
        const err = new Error('GitLab: not found');
        // @ts-ignore
        err.status = 404;
        throw err;
    };
    await assert.rejects(
        () => merged.createBranch(FAKE_CONN, 'o', 'r', BRANCH, 'main'),
        /not found/
    );
});

// ============================================
// Base contract — jsdoc-pinned idempotency advertised at the seam
// ============================================

test('Base: createBranch jsdoc declares the idempotent-on-existing-ref contract', async () => {
    // Source-scan idiom (matches `tests/test-plugin-editor-auto-switch-retired.mjs`):
    // the seam's contract lives in the base.js docstring; if a future
    // edit drops the idempotency language, this test fails and forces
    // a re-read of the per-provider implementations.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const base = await readFile(
        fileURLToPath(new URL('../js/git-providers/base.js', import.meta.url)),
        'utf8'
    );

    // Locate the createBranch jsdoc + signature window.
    const idx = base.indexOf('async createBranch(connection, owner, repo, name, from');
    assert.ok(idx > 0, 'createBranch declaration found in base.js');
    const window = base.slice(Math.max(0, idx - 2000), idx);
    assert.match(window, /[Ii]dempotent/);
    assert.match(window, /already exists/);
});
