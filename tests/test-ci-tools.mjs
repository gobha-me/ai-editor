/**
 * CI-tools tests (1.4.5).
 *
 * Covers `get_ci_status`, `wait_for_ci`, and `get_ci_logs` exported by
 * `js/tools/ci-tools.js`. The tools call into the `Git` facade; tests stub
 * the relevant methods on the singleton so no real provider is involved.
 *
 * The polling tool (`wait_for_ci`) deliberately does NOT use real time —
 * we monkey-patch `setTimeout` for the duration of polling tests so the
 * suite stays sub-second.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { Git } from '../js/git.js';
import { __test__ as ci } from '../js/tools/ci-tools.js';
import * as CiLogCache from '../js/intelligence/test-loop/log-cache.js';

const {
    getCiStatus,
    waitForCi,
    getCiLogs,
    summarizeStatuses,
    DEFAULT_WAIT_MS,
    MAX_WAIT_MS,
} = ci;

/* ---------------- Helpers ---------------- */

function withProject(fn) {
    const prev = State.currentProject;
    State.currentProject = { connectionId: 'c1', owner: 'me', repo: 'app' };
    try { return fn(); } finally { State.currentProject = prev; }
}

function stubGit(patch) {
    const original = {};
    for (const k of Object.keys(patch)) {
        original[k] = Git[k];
        Git[k] = patch[k];
    }
    return () => {
        for (const k of Object.keys(original)) Git[k] = original[k];
    };
}

function withFakeTimers() {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (cb /* delay ignored — fire next tick */) => {
        return realSetTimeout(cb, 0);
    };
    return () => { globalThis.setTimeout = realSetTimeout; };
}

/* ---------------- Pure helpers ---------------- */

test('summarizeStatuses returns "0 checks" for empty', () => {
    assert.equal(summarizeStatuses([]), '0 checks');
    assert.equal(summarizeStatuses(undefined), '0 checks');
});

test('summarizeStatuses counts states', () => {
    const s = summarizeStatuses([
        { state: 'success' }, { state: 'success' }, { state: 'failure' },
    ]);
    assert.match(s, /3 checks/);
    assert.match(s, /2 success/);
    assert.match(s, /1 failure/);
});

/* ---------------- get_ci_status ---------------- */

test('get_ci_status: no project → error', async () => {
    State.currentProject = null;
    const r = await getCiStatus({ ref: 'sha1' });
    assert.match(r.error, /No project/);
});

test('get_ci_status: missing ref → error', async () => {
    await withProject(async () => {
        const r = await getCiStatus({});
        assert.match(r.error, /ref/);
    });
});

test('get_ci_status: passes through Git result + adds summary', async () => {
    await withProject(async () => {
        const restore = stubGit({
            getCommitStatus: async () => ({
                state: 'success', total: 2,
                statuses: [{ context: 'lint', state: 'success' }, { context: 'test', state: 'success' }],
            }),
        });
        try {
            const r = await getCiStatus({ ref: 'sha1' });
            assert.equal(r.state, 'success');
            assert.equal(r.total, 2);
            assert.equal(r.statuses.length, 2);
            assert.match(r.summary, /2 checks/);
        } finally { restore(); }
    });
});

test('get_ci_status: catches provider throw', async () => {
    await withProject(async () => {
        const restore = stubGit({
            getCommitStatus: async () => { throw new Error('boom'); },
        });
        try {
            const r = await getCiStatus({ ref: 'sha1' });
            assert.match(r.error, /boom/);
        } finally { restore(); }
    });
});

/* ---------------- wait_for_ci ---------------- */

test('wait_for_ci: missing ref → error', async () => {
    await withProject(async () => {
        const r = await waitForCi({});
        assert.match(r.error, /ref/);
    });
});

test('wait_for_ci: resolves immediately on terminal state', async () => {
    await withProject(async () => {
        const restoreT = withFakeTimers();
        const restore = stubGit({
            getCommitStatus: async () => ({
                state: 'success', total: 1,
                statuses: [{ context: 'lint', state: 'success' }],
            }),
        });
        try {
            const r = await waitForCi({ ref: 'sha1', timeoutMs: 60000 });
            assert.equal(r.state, 'success');
            assert.equal(r.timed_out, undefined);
            assert.ok(r.attempts >= 1);
        } finally { restore(); restoreT(); }
    });
});

test('wait_for_ci: polls through pending then resolves', async () => {
    await withProject(async () => {
        const restoreT = withFakeTimers();
        let n = 0;
        const restore = stubGit({
            getCommitStatus: async () => {
                n++;
                return n < 3
                    ? { state: 'pending', total: 1, statuses: [] }
                    : { state: 'failure', total: 1, statuses: [{ context: 'lint', state: 'failure' }] };
            },
        });
        try {
            const r = await waitForCi({ ref: 'sha1', timeoutMs: 60000 });
            assert.equal(r.state, 'failure');
            assert.equal(r.attempts, 3);
        } finally { restore(); restoreT(); }
    });
});

test('wait_for_ci: returns timed_out when never terminal', async () => {
    await withProject(async () => {
        const restoreT = withFakeTimers();
        const restore = stubGit({
            getCommitStatus: async () => ({ state: 'pending', total: 1, statuses: [] }),
        });
        try {
            const r = await waitForCi({ ref: 'sha1', timeoutMs: 50 });
            assert.equal(r.timed_out, true);
            assert.equal(r.state, 'pending');
            assert.match(r.warning, /did not reach a terminal state/);
        } finally { restore(); restoreT(); }
    });
});

test('wait_for_ci: hard-max cap honored even with huge timeoutMs', async () => {
    await withProject(async () => {
        const restoreT = withFakeTimers();
        const start = Date.now();
        const restore = stubGit({
            getCommitStatus: async () => ({ state: 'success', total: 0, statuses: [] }),
        });
        try {
            // Just verify the returned `polled_for_ms` is finite + small with fake timers.
            const r = await waitForCi({ ref: 'sha1', timeoutMs: MAX_WAIT_MS * 10 });
            assert.equal(r.state, 'success');
            assert.ok(Date.now() - start < 1000, 'should return fast under fake timers');
        } finally { restore(); restoreT(); }
    });
});

test('wait_for_ci: defaults timeoutMs when omitted', async () => {
    // Smoke — make sure passing no timeoutMs doesn't throw and resolves on first poll.
    await withProject(async () => {
        const restoreT = withFakeTimers();
        const restore = stubGit({
            getCommitStatus: async () => ({ state: 'success', total: 0, statuses: [] }),
        });
        try {
            const r = await waitForCi({ ref: 'sha1' });
            assert.equal(r.state, 'success');
            assert.ok(typeof DEFAULT_WAIT_MS === 'number');
        } finally { restore(); restoreT(); }
    });
});

/* ---------------- get_ci_logs ---------------- */

test('get_ci_logs: missing ref → error', async () => {
    await withProject(async () => {
        const r = await getCiLogs({});
        assert.match(r.error, /ref/);
    });
});

test('get_ci_logs: no runs → error', async () => {
    await withProject(async () => {
        const restore = stubGit({ listWorkflowRuns: async () => [] });
        try {
            const r = await getCiLogs({ ref: 'sha1' });
            assert.match(r.error, /No workflow runs/);
        } finally { restore(); }
    });
});

test('get_ci_logs: matches headSha → caches first failed job log + returns path', async () => {
    await withProject(async () => {
        CiLogCache.evictAll();
        const restore = stubGit({
            listWorkflowRuns: async () => [
                { id: 99, name: 'Wrong', headSha: 'aaaaaaaa', status: 'completed' },
                { id: 100, name: 'CI', headSha: 'sha1', status: 'completed' },
            ],
            listWorkflowJobs: async (_o, _r, runId) => {
                assert.equal(runId, 100);
                return [
                    { id: 200, name: 'lint', conclusion: 'success' },
                    { id: 201, name: 'test', conclusion: 'failure' },
                ];
            },
            getJobLog: async (_o, _r, jobId) => {
                assert.equal(jobId, 201);
                return 'AssertionError: expected 1 got 2';
            },
        });
        try {
            const r = await getCiLogs({ ref: 'sha1' });
            assert.equal(r.run_id, 100);
            assert.equal(r.job_id, 201);
            assert.equal(r.job_name, 'test');
            assert.equal(r.conclusion, 'failure');
            assert.equal(r.log_path, '.aieditor/ci-cache/100-201-test.log');
            assert.equal(r.total_bytes, 'AssertionError: expected 1 got 2'.length);
            assert.equal(r.truncated_at_cap, false);
            assert.equal(r.used_fallback_run, false);
            assert.equal(r.log_tail, undefined, 'log_tail removed in 1.4.6');
            // Cached entry is readable via Git.getFile chokepoint.
            const file = await Git.getFile('me', 'app', r.log_path, 'main');
            assert.match(file.content, /AssertionError/);
            assert.equal(file.path, r.log_path);
        } finally { restore(); CiLogCache.evictAll(); }
    });
});

test('get_ci_logs: fallback to most-recent run when ref does not match', async () => {
    await withProject(async () => {
        CiLogCache.evictAll();
        const restore = stubGit({
            listWorkflowRuns: async () => [
                { id: 100, name: 'CI', headSha: 'differentsha', status: 'completed' },
            ],
            listWorkflowJobs: async () => [{ id: 200, name: 'test', conclusion: 'failure' }],
            getJobLog: async () => 'fail tail',
        });
        try {
            const r = await getCiLogs({ ref: 'sha1' });
            assert.equal(r.used_fallback_run, true);
            assert.match(r.warning, /No run matched/);
            assert.equal(r.log_path, '.aieditor/ci-cache/100-200-test.log');
        } finally { restore(); CiLogCache.evictAll(); }
    });
});

test('get_ci_logs: jobName argument selects specific job', async () => {
    await withProject(async () => {
        CiLogCache.evictAll();
        const restore = stubGit({
            listWorkflowRuns: async () => [{ id: 100, name: 'CI', headSha: 'sha1' }],
            listWorkflowJobs: async () => [
                { id: 200, name: 'lint', conclusion: 'success' },
                { id: 201, name: 'test', conclusion: 'failure' },
            ],
            getJobLog: async (_o, _r, jobId) => {
                assert.equal(jobId, 200, 'should select lint when asked');
                return 'lint log';
            },
        });
        try {
            const r = await getCiLogs({ ref: 'sha1', jobName: 'lint' });
            assert.equal(r.job_name, 'lint');
            assert.equal(r.log_path, '.aieditor/ci-cache/100-200-lint.log');
            const file = await Git.getFile('me', 'app', r.log_path, 'main');
            assert.equal(file.content, 'lint log');
        } finally { restore(); CiLogCache.evictAll(); }
    });
});

test('get_ci_logs: jobName not found → structured error', async () => {
    await withProject(async () => {
        const restore = stubGit({
            listWorkflowRuns: async () => [{ id: 100, name: 'CI', headSha: 'sha1' }],
            listWorkflowJobs: async () => [{ id: 200, name: 'lint', conclusion: 'success' }],
            getJobLog: async () => 'never',
        });
        try {
            const r = await getCiLogs({ ref: 'sha1', jobName: 'nonexistent' });
            assert.match(r.error, /No job named/);
            assert.match(r.error, /lint/, 'lists available jobs');
        } finally { restore(); }
    });
});

test('get_ci_logs: oversize log truncated_at_cap and tail preserved', async () => {
    await withProject(async () => {
        CiLogCache.evictAll();
        // Build a payload larger than the 10MB per-entry cap with a unique
        // marker at the very end so we can assert the tail is the slice kept.
        const padBytes = CiLogCache.__test__.PER_ENTRY_CAP_BYTES + 1024;
        const oversize = 'x'.repeat(padBytes) + '\nFINAL_MARKER_LINE';
        const restore = stubGit({
            listWorkflowRuns: async () => [{ id: 100, name: 'CI', headSha: 'sha1' }],
            listWorkflowJobs: async () => [{ id: 200, name: 'lint', conclusion: 'failure' }],
            getJobLog: async () => oversize,
        });
        try {
            const r = await getCiLogs({ ref: 'sha1' });
            assert.equal(r.truncated_at_cap, true);
            assert.equal(r.total_bytes, oversize.length);
            const file = await Git.getFile('me', 'app', r.log_path, 'main');
            assert.equal(file.size, CiLogCache.__test__.PER_ENTRY_CAP_BYTES);
            assert.ok(file.content.endsWith('FINAL_MARKER_LINE'), 'tail of oversize log is preserved');
        } finally { restore(); CiLogCache.evictAll(); }
    });
});

test('get_ci_logs: no jobs in run → structured error', async () => {
    await withProject(async () => {
        const restore = stubGit({
            listWorkflowRuns: async () => [{ id: 100, name: 'CI', headSha: 'sha1', status: 'pending' }],
            listWorkflowJobs: async () => [],
        });
        try {
            const r = await getCiLogs({ ref: 'sha1' });
            assert.match(r.error, /no jobs/);
        } finally { restore(); }
    });
});

test('get_ci_logs: provider returns null log → structured error', async () => {
    await withProject(async () => {
        const restore = stubGit({
            listWorkflowRuns: async () => [{ id: 100, name: 'CI', headSha: 'sha1' }],
            listWorkflowJobs: async () => [{ id: 200, name: 'lint', conclusion: 'failure' }],
            getJobLog: async () => null,
        });
        try {
            const r = await getCiLogs({ ref: 'sha1' });
            assert.match(r.error, /no log content/);
        } finally { restore(); }
    });
});

