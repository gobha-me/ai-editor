// @ts-check
/**
 * Tests for the 2.13.2 `rerunWorkflowJobs` provider method — Gitea +
 * GitHub implement near-identical Actions endpoints; GitLab inherits
 * the base `notSupported` throw.
 *
 * Each test stubs `request()` on a per-test merged provider clone
 * (mirroring how `git-providers/registry.js#register` builds the live
 * provider via `{ ...BASE_GIT_PROVIDER, ...provider }`) so endpoint
 * assertions don't hit the network.
 *
 * @since 2.13.2
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
// Capability matrix — rerunCi
// ============================================

test('Gitea: capabilities advertises rerunCi', () => {
    assert.equal(giteaProvider.capabilities.rerunCi, true);
});

test('GitHub: capabilities advertises rerunCi', () => {
    assert.equal(githubProvider.capabilities.rerunCi, true);
});

test('Base: capabilities default rerunCi to false', () => {
    const baseCaps = BASE_GIT_PROVIDER.capabilities;
    assert.equal(baseCaps.rerunCi, false);
});

test('GitLab: capabilities override does NOT advertise rerunCi (kept default-falsy at call sites)', () => {
    // Slice 2 (2.19.0) of Touch 3 Merge Conflict Resolver added a
    // minimal `capabilities` getter to GitLab declaring only
    // `mergeConflictResolution`. The rerun-failed CI track for GitLab
    // remains its own future slice with its own live testing.
    const caps = gitlabProvider.capabilities;
    assert.notEqual(caps.rerunCi, true);
});

// ============================================
// Gitea — rerun-failed endpoint
// ============================================

test('Gitea: rerunWorkflowJobs POSTs to /actions/runs/{id}/rerun-failed', async () => {
    const merged = mergedClone(giteaProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint) => {
        captured = { method, endpoint };
        return null;
    };

    const result = await merged.rerunWorkflowJobs(FAKE_CONN, 'o', 'r', 12345);

    assert.equal(captured.method, 'POST');
    assert.equal(captured.endpoint, '/repos/o/r/actions/runs/12345/rerun-failed');
    assert.equal(result.ok, true);
    assert.equal(result.runId, 12345);
});

test('Gitea: rerunWorkflowJobs accepts string runId', async () => {
    const merged = mergedClone(giteaProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint) => {
        captured = { method, endpoint };
        return null;
    };
    await merged.rerunWorkflowJobs(FAKE_CONN, 'o', 'r', 'abc-99');
    assert.equal(captured.endpoint, '/repos/o/r/actions/runs/abc-99/rerun-failed');
});

// ============================================
// GitHub — rerun-failed-jobs endpoint
// ============================================

test('GitHub: rerunWorkflowJobs POSTs to /actions/runs/{id}/rerun-failed-jobs', async () => {
    const merged = mergedClone(githubProvider);
    let captured = null;
    merged.request = async (_conn, method, endpoint) => {
        captured = { method, endpoint };
        return null;
    };

    const result = await merged.rerunWorkflowJobs(FAKE_CONN, 'o', 'r', 9876);

    assert.equal(captured.method, 'POST');
    // Note the trailing `-jobs` — distinct from Gitea's path.
    assert.equal(captured.endpoint, '/repos/o/r/actions/runs/9876/rerun-failed-jobs');
    assert.equal(result.ok, true);
    assert.equal(result.runId, 9876);
});

// ============================================
// GitLab — inherits notSupported
// ============================================

test('GitLab: rerunWorkflowJobs throws GIT_NOT_SUPPORTED via base inheritance', async () => {
    const merged = mergedClone(gitlabProvider);
    await assert.rejects(
        () => merged.rerunWorkflowJobs(FAKE_CONN, 'o', 'r', 1),
        (err) => err && err.code === ErrorCode.GIT_NOT_SUPPORTED
    );
});

// ============================================
// Provider request error propagates (not swallowed)
// ============================================

test('Gitea: rerunWorkflowJobs surfaces request errors instead of swallowing', async () => {
    const merged = mergedClone(giteaProvider);
    const err = new Error('Gitea API Error: 404 - run not found');
    err.status = 404;
    merged.request = async () => { throw err; };

    await assert.rejects(
        () => merged.rerunWorkflowJobs(FAKE_CONN, 'o', 'r', 999),
        /run not found/
    );
});

test('GitHub: rerunWorkflowJobs surfaces request errors instead of swallowing', async () => {
    const merged = mergedClone(githubProvider);
    const err = new Error('GitHub: Forbidden');
    err.status = 403;
    merged.request = async () => { throw err; };

    await assert.rejects(
        () => merged.rerunWorkflowJobs(FAKE_CONN, 'o', 'r', 999),
        /Forbidden/
    );
});
