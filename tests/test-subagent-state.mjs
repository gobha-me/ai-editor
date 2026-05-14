/**
 * Tests for the sub-agent state slot + pending-approval helpers landed
 * at 2.49.0.0 (slice 1 of github#24 Phase 1 per
 * `docs/DESIGN-sub-agents.md`).
 *
 * Pins:
 *   - `State.subagents` has the right initial shape (tree / transcripts
 *     / session_cost). DESIGN §"Gap 1" — single new top-level slot.
 *   - `setPendingSubAgentApproval` / `resolveSubAgentApproval` /
 *     `cancelSubAgentApproval` lifecycle mirrors the script-approval
 *     pair (DESIGN §"Gap 6").
 *   - `cancelToolLoop` releases an in-flight sub-agent approval so the
 *     Stop button does not leak the awaited Promise.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import {
    getPendingSubAgentApproval,
    setPendingSubAgentApproval,
    resolveSubAgentApproval,
    cancelSubAgentApproval,
    cancelToolLoop,
    resetToolLoopCancel,
    isToolLoopCancelled,
} from '../js/chat/state.js';

test('State.subagents has the documented initial shape', () => {
    // DESIGN §"Gap 1" — single top-level slot, three sub-keys.
    assert.ok(State.subagents && typeof State.subagents === 'object');
    assert.ok(State.subagents.tree && typeof State.subagents.tree === 'object');
    assert.ok(State.subagents.transcripts && typeof State.subagents.transcripts === 'object');
    assert.equal(Object.keys(State.subagents.tree).length, 0, 'tree starts empty');
    assert.equal(Object.keys(State.subagents.transcripts).length, 0, 'transcripts starts empty');
    assert.ok(State.subagents.session_cost && typeof State.subagents.session_cost === 'object');
    assert.equal(State.subagents.session_cost.dollars, 0);
    assert.equal(State.subagents.session_cost.tokens, 0);
});

test('pendingSubAgentApproval: getter returns null when nothing pending', () => {
    // Defensive — prior test runs may have left pending state if a
    // resolve was missed. Cancel proactively.
    cancelSubAgentApproval();
    assert.equal(getPendingSubAgentApproval(), null);
});

test('setPendingSubAgentApproval → resolveSubAgentApproval flow', async () => {
    let resolved = null;
    const promise = new Promise((resolve) => {
        setPendingSubAgentApproval({
            transcriptId: 'test-tx-1',
            task: 'read foo.js and summarize',
            profileName: 'subagent.v1',
            resolve,
        });
    });

    // Getter sees the pending state mid-flight.
    const pending = getPendingSubAgentApproval();
    assert.ok(pending);
    assert.equal(pending.transcriptId, 'test-tx-1');
    assert.equal(pending.task, 'read foo.js and summarize');
    assert.equal(pending.profileName, 'subagent.v1');

    // Resolve mirrors the script-approval envelope shape.
    const envelope = {
        status: 'completed',
        summary: 'foo.js exports a single function `bar()`.',
        artifacts: [],
        cost: { tokens_in: 1234, tokens_out: 567, dollars: 0.02, rounds: 2 },
        transcript_id: 'test-tx-1',
    };
    const didResolve = resolveSubAgentApproval(envelope);
    assert.equal(didResolve, true);

    resolved = await promise;
    assert.deepEqual(resolved, envelope);

    // Slot is empty post-resolve.
    assert.equal(getPendingSubAgentApproval(), null);
});

test('setPendingSubAgentApproval → cancelSubAgentApproval flow', async () => {
    let resolved = null;
    const promise = new Promise((resolve) => {
        setPendingSubAgentApproval({
            transcriptId: 'test-tx-2',
            task: 'audit imports',
            profileName: 'subagent.v1',
            resolve,
        });
    });

    const didCancel = cancelSubAgentApproval();
    assert.equal(didCancel, true);

    resolved = await promise;
    assert.equal(resolved.status, 'cancelled');
    assert.equal(resolved.cancelled, true);
    assert.equal(resolved.partial, true);
    assert.ok(typeof resolved.error === 'string');
    assert.equal(getPendingSubAgentApproval(), null);
});

test('cancelSubAgentApproval no-op when nothing pending', () => {
    cancelSubAgentApproval();
    const r = cancelSubAgentApproval();
    assert.equal(r, false);
});

test('cancelToolLoop releases a pending sub-agent approval', async () => {
    resetToolLoopCancel();
    let resolved = null;
    const promise = new Promise((resolve) => {
        setPendingSubAgentApproval({
            transcriptId: 'test-tx-3',
            task: 'unused',
            profileName: 'subagent.v1',
            resolve,
        });
    });

    cancelToolLoop();
    assert.equal(isToolLoopCancelled(), true);

    resolved = await promise;
    assert.equal(resolved.status, 'cancelled');
    assert.equal(getPendingSubAgentApproval(), null);

    resetToolLoopCancel();
});

test('cancelSubAgentApproval forwards optional summary / cost / transcript_id', async () => {
    let resolved = null;
    const promise = new Promise((resolve) => {
        setPendingSubAgentApproval({
            transcriptId: 'test-tx-4',
            task: 'partial run',
            profileName: 'subagent.v1',
            resolve,
        });
    });

    cancelSubAgentApproval({
        summary: 'stopped mid-loop',
        cost: { tokens_in: 100, tokens_out: 50 },
        transcript_id: 'test-tx-4',
    });

    resolved = await promise;
    assert.equal(resolved.summary, 'stopped mid-loop');
    assert.deepEqual(resolved.cost, { tokens_in: 100, tokens_out: 50 });
    assert.equal(resolved.transcript_id, 'test-tx-4');
});
