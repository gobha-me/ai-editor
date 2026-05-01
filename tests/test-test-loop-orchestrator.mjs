/**
 * Test-driven loop orchestrator tests (1.4.5).
 *
 * Drives `runTestLoop` with stubs for both the chat-turn callback and the
 * `Git` facade, asserting:
 *   - bounds (max iterations, no-progress, abort, ci-pass exit)
 *   - TaskLedger writes per iteration
 *   - state-machine transitions emit `loop:state-changed`
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, EventBus } from '../js/core.js';
import { Git } from '../js/git.js';
import { ConversationManager } from '../js/chat/conversations.js';
import { _resetForTests as resetLedgers, getOrCreateLedger } from '../js/chat/task-state.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { runTestLoop, resolveBounds, buildIterationPrompt } from '../js/intelligence/test-loop/orchestrator.js';
import { _resetForTests as resetLoopState, getState as getLoopState } from '../js/intelligence/test-loop/state.js';

/* ---------------- helpers ---------------- */

async function withProject(fn) {
    const prev = State.currentProject;
    State.currentProject = { connectionId: 'c1', owner: 'me', repo: 'app' };
    State.currentBranch = 'main';
    try { return await fn(); } finally { State.currentProject = prev; }
}

function stubGit(patch) {
    const original = {};
    for (const k of Object.keys(patch)) {
        original[k] = Git[k];
        Git[k] = patch[k];
    }
    return () => { for (const k of Object.keys(original)) Git[k] = original[k]; };
}

function withFakeTimers() {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
    return () => { globalThis.setTimeout = realSetTimeout; };
}

async function withConversation(id, fn) {
    const prevGet = ConversationManager.getActiveId;
    ConversationManager.getActiveId = () => id;
    resetLedgers();
    resetLoopState();
    try { return await fn(); } finally {
        ConversationManager.getActiveId = prevGet;
    }
}

/**
 * Inject a `commit_files` invocation into the active conversation's ledger,
 * simulating the model having called it during the chat turn.
 */
function fakeCommitFilesInvocation(conversationId) {
    const ledger = getOrCreateLedger(conversationId, CODER_V1.name);
    ledger.tool_invocations.push({
        tool_id: 'commit_files',
        invoked_at: Date.now(),
        turn_id: 'turn-' + ledger.tool_invocations.length,
        args_summary: '{}',
        succeeded: true,
    });
}

/* ---------------- pure helpers ---------------- */

test('resolveBounds: defaults when settings absent', () => {
    const prev = State.settings.testLoop;
    State.settings.testLoop = undefined;
    try {
        const b = resolveBounds();
        assert.equal(b.maxIterations, 10);
        assert.equal(b.maxWallClockMs, 30 * 60 * 1000);
        assert.equal(b.maxTokensPerIteration, 8000);
        assert.equal(b.ciPollTimeoutMs, 5 * 60 * 1000);
    } finally { State.settings.testLoop = prev; }
});

test('resolveBounds: honors configured values', () => {
    const prev = State.settings.testLoop;
    State.settings.testLoop = {
        maxIterations: 3,
        maxWallClockMinutes: 1,
        maxTokensPerIteration: 1500,
        ciPollTimeoutMinutes: 2,
    };
    try {
        const b = resolveBounds();
        assert.equal(b.maxIterations, 3);
        assert.equal(b.maxWallClockMs, 60_000);
        assert.equal(b.maxTokensPerIteration, 1500);
        assert.equal(b.ciPollTimeoutMs, 120_000);
    } finally { State.settings.testLoop = prev; }
});

test('buildIterationPrompt: includes goal + iteration markers', () => {
    const prompt = buildIterationPrompt({
        iteration: 1, maxIterations: 5, goal: 'fix tests/foo.mjs',
        testHint: 'tests/foo.mjs', lastCiState: null, lastCiSummary: null, lastLogPath: null,
    });
    assert.match(prompt, /iteration 1 of 5/);
    assert.match(prompt, /fix tests\/foo\.mjs/);
    assert.match(prompt, /tests\/foo\.mjs/);
});

test('buildIterationPrompt: points at cached log path + tool hints on iter 2+', () => {
    const prompt = buildIterationPrompt({
        iteration: 2, maxIterations: 5, goal: 'fix bug',
        testHint: null,
        lastCiState: 'failure', lastCiSummary: '1 check: 1 failure',
        lastLogPath: '.aieditor/ci-cache/100-201-test.log',
    });
    assert.match(prompt, /Previous CI/);
    assert.match(prompt, /failure/);
    assert.match(prompt, /\.aieditor\/ci-cache\/100-201-test\.log/);
    assert.match(prompt, /read_file/);
    assert.match(prompt, /read_lines/);
    assert.match(prompt, /scan_file/);
    assert.match(prompt, /Adjust your patch/);
    assert.doesNotMatch(prompt, /```/, 'no embedded log block — model fetches via tools');
});

/* ---------------- runTestLoop control flow ---------------- */

test('runTestLoop: throws on missing callback', async () => {
    await assert.rejects(
        () => runTestLoop({ goal: 'g' }),
        /runChatTurn callback is required/
    );
});

test('runTestLoop: throws on empty goal', async () => {
    await assert.rejects(
        () => runTestLoop({ goal: '   ', runChatTurn: async () => {} }),
        /goal must be a non-empty string/
    );
});

test('runTestLoop: exits no_progress when model never commits', async () => {
    await withProject(async () => {
        await withConversation('conv-1', async () => {
            const restoreT = withFakeTimers();
            try {
                const result = await runTestLoop({
                    goal: 'do nothing',
                    bounds: { maxIterations: 5, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 1000 },
                    runChatTurn: async () => { /* model does not commit */ },
                });
                assert.equal(result.exitReason, 'no_progress');
                assert.equal(result.iterations, 1);
                const ledger = getOrCreateLedger('conv-1', CODER_V1.name);
                assert.equal(ledger.loop_iterations.length, 1);
                assert.equal(ledger.loop_iterations[0].exit_reason, 'no_progress');
            } finally { restoreT(); }
        });
    });
});

test('runTestLoop: exits ci_pass after a successful CI', async () => {
    await withProject(async () => {
        await withConversation('conv-2', async () => {
            const restoreT = withFakeTimers();
            const restoreGit = stubGit({
                listBranches: async () => [{ name: 'main', sha: 'abc1234567', protected: false }],
                getCommitStatus: async () => ({ state: 'success', total: 1, statuses: [{ context: 'lint', state: 'success' }] }),
            });
            try {
                const result = await runTestLoop({
                    goal: 'fix it',
                    bounds: { maxIterations: 3, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 30_000 },
                    runChatTurn: async () => {
                        fakeCommitFilesInvocation('conv-2');
                    },
                });
                assert.equal(result.exitReason, 'ci_pass');
                assert.equal(result.iterations, 1);
                assert.equal(result.lastCiState, 'success');
                assert.equal(result.lastCommitSha, 'abc1234567');
            } finally { restoreGit(); restoreT(); }
        });
    });
});

test('runTestLoop: exits max_iterations when CI keeps failing', async () => {
    await withProject(async () => {
        await withConversation('conv-3', async () => {
            const restoreT = withFakeTimers();
            const restoreGit = stubGit({
                listBranches: async () => [{ name: 'main', sha: 'sha1', protected: false }],
                getCommitStatus: async () => ({ state: 'failure', total: 1, statuses: [{ context: 'lint', state: 'failure' }] }),
                listWorkflowRuns: async () => [{ id: 1, name: 'CI', headSha: 'sha1' }],
                listWorkflowJobs: async () => [{ id: 10, name: 'lint', conclusion: 'failure' }],
                getJobLog: async () => 'syntax error at line 7',
            });
            try {
                const result = await runTestLoop({
                    goal: 'fix lint',
                    bounds: { maxIterations: 2, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 30_000 },
                    runChatTurn: async () => { fakeCommitFilesInvocation('conv-3'); },
                });
                assert.equal(result.exitReason, 'max_iterations');
                assert.equal(result.iterations, 2);
                const ledger = getOrCreateLedger('conv-3', CODER_V1.name);
                assert.equal(ledger.loop_iterations.length, 2);
                assert.equal(ledger.loop_iterations[0].exit_reason, 'ci_fail');
                assert.equal(ledger.loop_iterations[0].ci_state, 'failure');
            } finally { restoreGit(); restoreT(); }
        });
    });
});

test('runTestLoop: exits user_abort when abortRequested set mid-loop', async () => {
    await withProject(async () => {
        await withConversation('conv-4', async () => {
            const restoreT = withFakeTimers();
            const restoreGit = stubGit({
                listBranches: async () => [{ name: 'main', sha: 'sha1' }],
                getCommitStatus: async () => ({ state: 'failure', total: 1, statuses: [] }),
                listWorkflowRuns: async () => [{ id: 1, headSha: 'sha1' }],
                listWorkflowJobs: async () => [{ id: 10, name: 'job', conclusion: 'failure' }],
                getJobLog: async () => 'fail',
            });
            const { requestAbort } = await import('../js/intelligence/test-loop/state.js');
            try {
                const result = await runTestLoop({
                    goal: 'work',
                    bounds: { maxIterations: 5, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 30_000 },
                    runChatTurn: async () => {
                        fakeCommitFilesInvocation('conv-4');
                        requestAbort();
                    },
                });
                assert.equal(result.exitReason, 'user_abort');
            } finally { restoreGit(); restoreT(); }
        });
    });
});

test('runTestLoop: exits error when runChatTurn throws', async () => {
    await withProject(async () => {
        await withConversation('conv-5', async () => {
            const restoreT = withFakeTimers();
            try {
                const result = await runTestLoop({
                    goal: 'fail',
                    bounds: { maxIterations: 3, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 30_000 },
                    runChatTurn: async () => { throw new Error('chat down'); },
                });
                assert.equal(result.exitReason, 'error');
            } finally { restoreT(); }
        });
    });
});

test('runTestLoop: emits loop:state-changed events through the run', async () => {
    await withProject(async () => {
        await withConversation('conv-6', async () => {
            const restoreT = withFakeTimers();
            const restoreGit = stubGit({
                listBranches: async () => [{ name: 'main', sha: 'sha1' }],
                getCommitStatus: async () => ({ state: 'success', total: 1, statuses: [] }),
            });
            const events = [];
            const off = EventBus.on('loop:state-changed', (s) => events.push(s.status));
            try {
                await runTestLoop({
                    goal: 'pass',
                    bounds: { maxIterations: 3, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 30_000 },
                    runChatTurn: async () => { fakeCommitFilesInvocation('conv-6'); },
                });
                // We expect to see iterating, awaiting_ci, finished at minimum.
                assert.ok(events.includes('iterating'), `events should include iterating: ${events.join(',')}`);
                assert.ok(events.includes('awaiting_ci'), `events should include awaiting_ci: ${events.join(',')}`);
                assert.ok(events.includes('finished'), `events should include finished: ${events.join(',')}`);
            } finally {
                if (typeof off === 'function') off();
                restoreGit();
                restoreT();
            }
        });
    });
});

test('runTestLoop: exits wall_clock when elapsed exceeds budget before next iteration', async () => {
    await withProject(async () => {
        await withConversation('conv-7', async () => {
            // Start with already-elapsed clock by making maxWallClockMs near zero.
            const restoreT = withFakeTimers();
            try {
                const result = await runTestLoop({
                    goal: 'time out',
                    bounds: { maxIterations: 5, maxWallClockMs: 0, maxTokensPerIteration: 1000, ciPollTimeoutMs: 1000 },
                    runChatTurn: async () => { /* never reached */ },
                });
                assert.equal(result.exitReason, 'wall_clock');
            } finally { restoreT(); }
        });
    });
});

test('runTestLoop: state singleton resets between back-to-back runs', async () => {
    await withProject(async () => {
        await withConversation('conv-8', async () => {
            const restoreT = withFakeTimers();
            const restoreGit = stubGit({
                listBranches: async () => [{ name: 'main', sha: 'sha1' }],
                getCommitStatus: async () => ({ state: 'success', total: 0, statuses: [] }),
            });
            try {
                await runTestLoop({
                    goal: 'one',
                    bounds: { maxIterations: 1, maxWallClockMs: 60_000, maxTokensPerIteration: 1000, ciPollTimeoutMs: 30_000 },
                    runChatTurn: async () => { fakeCommitFilesInvocation('conv-8'); },
                });
                const after = getLoopState();
                assert.equal(after.status, 'finished');
                assert.equal(after.exitReason, 'ci_pass');
            } finally { restoreGit(); restoreT(); }
        });
    });
});
