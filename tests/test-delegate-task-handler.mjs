/**
 * Tests for `js/tools/subagent-tools.js#delegate_task` — the tool
 * handler that mounts the sub-agent approval card and (via the card)
 * runs the sub-agent loop. Slice 2 of github#24 Phase 1 (2.49.0).
 *
 * Pins (the load-bearing failure modes — DESIGN §Risks lines 528–536):
 *   - Argument validation: missing/empty `task` rejected before card mount.
 *   - Unknown profile rejected before card mount (silent fallback to
 *     chat.v1 would widen trust; we must surface the error instead).
 *   - Per-conversation cost cap rejected before card mount (DESIGN
 *     §Decision §6 workspace cap from Settings → Tools).
 *   - Per-call ceiling clamping: max_tokens / max_dollars /
 *     run_timeout_ms cannot raise above profile defaults.
 *   - **Triple-bound termination** — DESIGN §Risks: each of the four
 *     ceiling-break paths (cost cap, token cap, dollar cap, timeout) is
 *     verified independently so the mitigation holds if any one bound
 *     works alone. Token / dollar / timeout enforcement lives in the
 *     runner; this test pins the cost-cap (workspace-level) path the
 *     handler owns + the clamping invariants on the per-call ceilings.
 *
 * Browser-side end-to-end (card mount → loop → resolve) is pinned in
 * `tests/test-subagent-end-to-end.js` (manual track).
 *
 * Runs under `node --test`. Uses the node shim for browser globals.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { registerSubAgentTools } from '../js/tools/subagent-tools.js';
import {
    getPendingSubAgentApproval,
    resolveSubAgentApproval,
    cancelSubAgentApproval,
} from '../js/chat/state.js';

// Register the handler once; subsequent `register` calls are no-ops
// in the registry (idempotent).
registerSubAgentTools(ToolRegistry);

// Helpers to reset State.settings.subagent / State.subagents between
// tests so cap-overflow tests don't bleed into the next case.
function resetSubAgentSlot() {
    State.subagents = { tree: {}, transcripts: {}, session_cost: { dollars: 0, tokens: 0 } };
    if (State.settings && State.settings.subagent) {
        delete State.settings.subagent;
    }
}

/** Resolve the pending approval (mounted by the handler) with a stub
 *  envelope and return the handler's Promise resolution. The handler
 *  awaits `setPendingSubAgentApproval`'s Promise; we resolve it here
 *  with a synthetic envelope to simulate the card's Approve path. */
async function withStubResolution(invoke, envelope) {
    const handlerPromise = invoke();
    // Microtask defer so `setPendingSubAgentApproval` runs first.
    await Promise.resolve();
    const pending = getPendingSubAgentApproval();
    if (pending) {
        resolveSubAgentApproval(envelope);
    }
    return await handlerPromise;
}

test('delegate_task: missing task argument is rejected', async () => {
    resetSubAgentSlot();
    const result = await ToolRegistry.execute('delegate_task', {});
    assert.ok(result.error, 'should return an error envelope');
    assert.match(result.error, /task/i);
    // Card should NOT have mounted.
    assert.equal(getPendingSubAgentApproval(), null);
});

test('delegate_task: empty/whitespace task is rejected', async () => {
    resetSubAgentSlot();
    const result = await ToolRegistry.execute('delegate_task', { task: '   ' });
    assert.ok(result.error, 'should return an error envelope');
    assert.equal(getPendingSubAgentApproval(), null);
});

test('delegate_task: unknown profile is rejected before card mount', async () => {
    resetSubAgentSlot();
    const result = await ToolRegistry.execute('delegate_task', {
        task: 'find foo',
        profile: 'made-up.v1',
    });
    assert.ok(result.error, 'should return an error envelope');
    assert.match(result.error, /unknown profile/i);
    // The silent-fallback-to-chat.v1 widens trust — we must surface the error.
    assert.equal(getPendingSubAgentApproval(), null);
});

test('delegate_task: happy path mounts approval card and returns envelope', async () => {
    resetSubAgentSlot();
    const synthetic = {
        status: 'completed',
        summary: 'found 3 call sites in foo.js',
        artifacts: [],
        cost: { tokens: 1234, dollars: 0.012, rounds: 2 },
        transcript_id: 'fake-transcript-id',
    };
    const result = await withStubResolution(
        () => ToolRegistry.execute('delegate_task', {
            task: 'find call sites of parseConfig',
            context_hint: 'check src/ first',
        }),
        synthetic,
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.summary, 'found 3 call sites in foo.js');
    assert.deepEqual(result.cost, { tokens: 1234, dollars: 0.012, rounds: 2 });
    assert.equal(result.transcript_id, 'fake-transcript-id');
});

test('delegate_task: ceiling clamping — max_tokens cannot raise above profile default', async () => {
    resetSubAgentSlot();
    // subagent.v1 default: 50000. Parent asks for 999999 → clamps to 50000.
    let observedCeilings = null;
    const handlerPromise = ToolRegistry.execute('delegate_task', {
        task: 'audit',
        max_tokens: 999999,
    });
    await Promise.resolve();
    const pending = getPendingSubAgentApproval();
    observedCeilings = pending?.capabilitySummary?.ceilings;
    cancelSubAgentApproval();
    await handlerPromise;
    assert.ok(observedCeilings, 'capability summary should carry ceilings');
    assert.equal(observedCeilings.max_tokens, 50000, 'clamped to profile default');
});

test('delegate_task: ceiling clamping — max_dollars cannot raise above profile default', async () => {
    resetSubAgentSlot();
    let observedCeilings = null;
    const handlerPromise = ToolRegistry.execute('delegate_task', {
        task: 'audit',
        max_dollars: 99.99,
    });
    await Promise.resolve();
    observedCeilings = getPendingSubAgentApproval()?.capabilitySummary?.ceilings;
    cancelSubAgentApproval();
    await handlerPromise;
    assert.equal(observedCeilings.max_dollars, 0.5, 'clamped to subagent.v1 default');
});

test('delegate_task: ceiling clamping — run_timeout_ms cannot raise above profile default', async () => {
    resetSubAgentSlot();
    let observedCeilings = null;
    const handlerPromise = ToolRegistry.execute('delegate_task', {
        task: 'audit',
        run_timeout_ms: 9999999,
    });
    await Promise.resolve();
    observedCeilings = getPendingSubAgentApproval()?.capabilitySummary?.ceilings;
    cancelSubAgentApproval();
    await handlerPromise;
    assert.equal(observedCeilings.run_timeout_ms, 300000, 'clamped to 5-min default');
});

test('delegate_task: ceiling clamping — parent narrows OK', async () => {
    resetSubAgentSlot();
    let observedCeilings = null;
    const handlerPromise = ToolRegistry.execute('delegate_task', {
        task: 'small audit',
        max_tokens: 5000,
        max_dollars: 0.05,
        run_timeout_ms: 30000,
    });
    await Promise.resolve();
    observedCeilings = getPendingSubAgentApproval()?.capabilitySummary?.ceilings;
    cancelSubAgentApproval();
    await handlerPromise;
    assert.equal(observedCeilings.max_tokens, 5000);
    assert.equal(observedCeilings.max_dollars, 0.05);
    assert.equal(observedCeilings.run_timeout_ms, 30000);
});

test('delegate_task: workspace cost cap rejected — running spend + max_dollars > cap', async () => {
    resetSubAgentSlot();
    // Set up: $4.80 already spent in this conversation; default cap $5.00;
    // this call's max_dollars 0.5 → would push to $5.30 → rejected.
    State.subagents.session_cost.dollars = 4.8;
    const result = await ToolRegistry.execute('delegate_task', {
        task: 'audit',
    });
    assert.ok(result.error, 'should return an error envelope');
    assert.match(result.error, /per-conversation cost cap/i);
    assert.equal(getPendingSubAgentApproval(), null, 'card should not mount');
});

test('delegate_task: workspace cost cap honors overlay from Settings', async () => {
    resetSubAgentSlot();
    State.settings.subagent = { sessionCap: 1.0 };  // tighter than default
    State.subagents.session_cost.dollars = 0.6;
    // Profile default max_dollars = 0.5. 0.6 + 0.5 > 1.0 → reject.
    const result = await ToolRegistry.execute('delegate_task', {
        task: 'audit',
    });
    assert.ok(result.error, 'should return an error envelope');
    assert.match(result.error, /per-conversation cost cap/i);
    assert.match(result.error, /\$1\.00/, 'message echoes the overlay cap');
});

test('delegate_task: capability summary surfaces admitted-tool list + ceilings', async () => {
    resetSubAgentSlot();
    // 2.54.0 (gitea#438) — admission is name-based against
    // subagent.v1.admit (the 8-tool read-only set). Pre-2.54.0 a
    // delegate_task tagged `roles: 'all'` would over-admit to
    // subagent.v1 via the legacy `'all'` tag short-circuit; the
    // inversion correctly omits it. Register a known-admitted fixture
    // (`read_file` IS in subagent.v1.admit) so the capability summary
    // has something to surface.
    ToolRegistry.register('read_file', async () => ({}), {
        function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    });
    let cap = null;
    const handlerPromise = ToolRegistry.execute('delegate_task', {
        task: 'audit',
    });
    await Promise.resolve();
    cap = getPendingSubAgentApproval()?.capabilitySummary;
    cancelSubAgentApproval();
    await handlerPromise;
    assert.ok(cap, 'capability summary should be present on pending state');
    assert.equal(cap.profile, 'subagent.v1');
    assert.equal(cap.profileRegistered, true);
    assert.ok(Array.isArray(cap.admittedTools) && cap.admittedTools.length > 0,
        'subagent.v1 admits read-only tools');
    assert.ok(cap.admittedTools.includes('read_file'),
        'read_file is in subagent.v1.admit and registered → must surface');
    // Default profile has no write tools — DESIGN §"Approval-card capability summary".
    assert.deepEqual(cap.writeTools, [], 'subagent.v1 has no write tools');
    assert.deepEqual(cap.memoryWriteTools, [], 'subagent.v1 has no memory tools');
});

test('delegate_task: per-call narrow intersects against profile (cannot raise)', async () => {
    resetSubAgentSlot();
    // Register fixture tools the per-call narrow can intersect against.
    // subagent.v1.tools.static admits 'read_file' (roles: 'all') but not
    // 'edit_file' (roles: ['coder']).
    const reg = (name, roles = 'all') => ToolRegistry.register(
        name, async () => ({}),
        { function: { name, description: `Fixture tool ${name}.`, parameters: { type: 'object', properties: {} } }, roles }
    );
    reg('read_file');
    reg('edit_file', ['coder']);

    let cap = null;
    const handlerPromise = ToolRegistry.execute('delegate_task', {
        task: 'narrowed task',
        tools: ['read_file', 'edit_file'],
    });
    await Promise.resolve();
    cap = getPendingSubAgentApproval()?.capabilitySummary;
    cancelSubAgentApproval();
    await handlerPromise;
    assert.deepEqual(cap.admittedTools, ['read_file'],
        'edit_file dropped — not in subagent.v1');
    assert.deepEqual(cap.writeTools, [],
        'no write tool admitted even after the parent asked for one');
});

test('delegate_task: rejected envelope flows back to parent', async () => {
    resetSubAgentSlot();
    const result = await withStubResolution(
        () => ToolRegistry.execute('delegate_task', { task: 'small audit' }),
        { status: 'rejected', feedback: 'use read_file directly', transcript_id: 't-1' },
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.feedback, 'use read_file directly');
});

test('delegate_task: cancelled envelope flows back to parent', async () => {
    resetSubAgentSlot();
    const handlerPromise = ToolRegistry.execute('delegate_task', { task: 'small audit' });
    await Promise.resolve();
    cancelSubAgentApproval({ transcript_id: 't-2', summary: 'partial' });
    const result = await handlerPromise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.equal(result.partial, true);
});
