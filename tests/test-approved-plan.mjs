/**
 * Tests for the approved-plan slot + `read_approved_plan` tool (gitea#424 — 2.52.0).
 *
 * gitea#424 — model inlined a full DESIGN.md into the plan body then
 * regenerated the same text via create_file during execution because the
 * approved plan was unreachable after the approval card resolved. The
 * fix: `resolvePlanApproval` captures the plan into `State.approvedPlan`
 * on `status='approved'`; `read_approved_plan` surfaces it back to the
 * model so the executor can reference instead of regenerate.
 *
 * Covers:
 *   - `resolvePlanApproval({ status: 'approved' })` writes plan + approvedAt
 *   - `resolvePlanApproval({ status: 'rejected' })` does NOT write
 *   - `cancelPlanApproval` does NOT write
 *   - New approval overwrites the prior slot
 *   - A rejection after a prior approval leaves the prior slot intact
 *     (re-plan iteration doesn't blow away an earlier approved plan)
 *   - `clearApprovedPlan` resets the slot
 *   - `setApprovedPlan` direct write (test-seeded paths)
 *   - `read_approved_plan` handler — post-approval returns { plan, approved_at }
 *   - `read_approved_plan` handler — pre-approval returns the explicit error
 *   - `registerPlanTools` registers `read_approved_plan` as readOnly, roles=all,
 *     no required parameters
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    setPendingPlanApproval,
    resolvePlanApproval,
    cancelPlanApproval,
    getPendingPlanApproval,
    getApprovedPlan,
    setApprovedPlan,
    clearApprovedPlan,
    getPlanMode,
    setPlanMode,
} from '../js/chat/state.js';
import { registerPlanTools } from '../js/tools/plan-tools.js';
import { buildSystemPrompt } from '../js/prompts.js';

function _reset() {
    if (getPendingPlanApproval()) cancelPlanApproval();
    clearApprovedPlan();
}

// Capture the two registered handlers + definitions from a stub registry
// so tests can drive them without booting the real ToolRegistry.
function _captureRegistrations() {
    const captured = new Map();
    const stub = {
        register(name, handler, definition) {
            captured.set(name, { handler, definition });
        },
    };
    registerPlanTools(stub);
    return captured;
}

// ============================================
// Slot accessors
// ============================================

test('getApprovedPlan returns null when nothing has been approved', () => {
    _reset();
    assert.equal(getApprovedPlan(), null);
});

test('setApprovedPlan + clearApprovedPlan round-trip', () => {
    _reset();
    setApprovedPlan({ plan: 'seeded', approvedAt: 1000 });
    assert.deepEqual(getApprovedPlan(), { plan: 'seeded', approvedAt: 1000 });
    clearApprovedPlan();
    assert.equal(getApprovedPlan(), null);
});

// ============================================
// resolvePlanApproval write semantics
// ============================================

test('resolvePlanApproval({status:"approved"}) writes plan + approvedAt to approvedPlan', async () => {
    _reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    const planBody = '# Plan\n\nStep 1: ...';
    setPendingPlanApproval({ plan: planBody, resolve: _resolveFn });
    const t0 = Date.now();
    resolvePlanApproval({ status: 'approved' });
    const slot = getApprovedPlan();
    assert.ok(slot, 'approvedPlan slot was written');
    assert.equal(slot.plan, planBody);
    assert.ok(typeof slot.approvedAt === 'number');
    assert.ok(slot.approvedAt >= t0, 'approvedAt timestamp is contemporaneous');
    await p; // drain the promise so it doesn't dangle
    _reset();
});

test('resolvePlanApproval({status:"rejected"}) does NOT write approvedPlan', async () => {
    _reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingPlanApproval({ plan: 'not yet', resolve: _resolveFn });
    resolvePlanApproval({ status: 'rejected', feedback: 'try again' });
    assert.equal(getApprovedPlan(), null);
    await p;
    _reset();
});

test('cancelPlanApproval does NOT write approvedPlan', async () => {
    _reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingPlanApproval({ plan: 'about to bail', resolve: _resolveFn });
    cancelPlanApproval();
    assert.equal(getApprovedPlan(), null);
    await p;
    _reset();
});

test('A rejection after a prior approval leaves the prior slot intact', async () => {
    _reset();
    // Approve plan A
    let r1;
    const p1 = new Promise(r => { r1 = r; });
    setPendingPlanApproval({ plan: 'plan A', resolve: r1 });
    resolvePlanApproval({ status: 'approved' });
    await p1;
    const after1 = getApprovedPlan();
    assert.equal(after1.plan, 'plan A');

    // Submit plan B and reject — A should still be in the slot
    let r2;
    const p2 = new Promise(r => { r2 = r; });
    setPendingPlanApproval({ plan: 'plan B', resolve: r2 });
    resolvePlanApproval({ status: 'rejected', feedback: 'no' });
    await p2;
    const after2 = getApprovedPlan();
    assert.equal(after2.plan, 'plan A', 'rejection does not erase the prior approval');
    _reset();
});

test('Second approval overwrites the prior approved plan', async () => {
    _reset();
    let r1;
    const p1 = new Promise(r => { r1 = r; });
    setPendingPlanApproval({ plan: 'first', resolve: r1 });
    resolvePlanApproval({ status: 'approved' });
    await p1;
    assert.equal(getApprovedPlan().plan, 'first');

    let r2;
    const p2 = new Promise(r => { r2 = r; });
    setPendingPlanApproval({ plan: 'second', resolve: r2 });
    resolvePlanApproval({ status: 'approved' });
    await p2;
    assert.equal(getApprovedPlan().plan, 'second', 'newer approval overwrites');
    _reset();
});

test('Empty-string plan in pending does not get written even on approval', async () => {
    _reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    // Force a malformed pending (the handler-side validator normally
    // rejects this earlier, but the slot's guard is independent).
    setPendingPlanApproval({ plan: '', resolve: _resolveFn });
    resolvePlanApproval({ status: 'approved' });
    assert.equal(getApprovedPlan(), null, 'empty plan body is not a valid approved plan');
    await p;
    _reset();
});

// ============================================
// read_approved_plan tool registration + handler
// ============================================

test('registerPlanTools registers read_approved_plan as readOnly, roles=all, no required params', () => {
    const captured = _captureRegistrations();
    const entry = captured.get('read_approved_plan');
    assert.ok(entry, 'read_approved_plan was registered');
    assert.equal(entry.definition.readOnly, true);
    assert.equal(entry.definition.function.name, 'read_approved_plan');
    assert.deepEqual(entry.definition.function.parameters.required, [],
        'read_approved_plan takes no required arguments');
    assert.deepEqual(entry.definition.function.parameters.properties, {},
        'read_approved_plan has an empty properties object');
});

test('read_approved_plan handler returns { plan, approved_at } when the slot is populated', async () => {
    _reset();
    setApprovedPlan({ plan: '# Plan body', approvedAt: 1234567890 });
    const captured = _captureRegistrations();
    const entry = captured.get('read_approved_plan');
    const result = await entry.handler();
    assert.equal(result.plan, '# Plan body');
    assert.equal(result.approved_at, 1234567890);
    assert.ok(!result.error);
    _reset();
});

test('read_approved_plan handler returns an explicit error when no plan has been approved', async () => {
    _reset();
    const captured = _captureRegistrations();
    const entry = captured.get('read_approved_plan');
    const result = await entry.handler();
    assert.ok(result.error, 'pre-approval call returns an error envelope');
    assert.ok(/No approved plan/.test(result.error));
    assert.ok(!result.plan);
});

test('read_approved_plan handler ignores its arguments (no-arg contract)', async () => {
    _reset();
    setApprovedPlan({ plan: 'X', approvedAt: 1 });
    const captured = _captureRegistrations();
    const entry = captured.get('read_approved_plan');
    // Pass anything; the handler doesn't read args.
    const r1 = await entry.handler();
    const r2 = await entry.handler({});
    const r3 = await entry.handler({ unexpected: 'arg' });
    assert.equal(r1.plan, 'X');
    assert.equal(r2.plan, 'X');
    assert.equal(r3.plan, 'X');
    _reset();
});

// ============================================
// submit_plan_for_approval description carries the "describe, don't inline" guidance
// ============================================

test('submit_plan_for_approval description discourages inlining production-ready content (gitea#424 stop-gap A)', () => {
    const captured = _captureRegistrations();
    const entry = captured.get('submit_plan_for_approval');
    assert.ok(entry, 'submit_plan_for_approval was registered');
    const desc = entry.definition.function.description;
    const paramDesc = entry.definition.function.parameters.properties.plan.description;
    // Description-level reminder
    assert.ok(/intent/i.test(desc) || /not inline/i.test(desc),
        'top-level description references intent / not-inline guidance');
    // Parameter-level reminder (the spot the model reads when filling the field)
    assert.ok(/intent/i.test(paramDesc),
        'plan-parameter description names the intent framing');
    assert.ok(/do NOT inline/i.test(paramDesc) || /do not inline/i.test(paramDesc),
        'plan-parameter description includes the explicit "do not inline" guidance');
});

// ============================================
// System-prompt injection (gitea#478 — 2.77.0)
// ============================================
//
// The slot has been readable on-demand via `read_approved_plan` since
// 2.52.0 (gitea#424), but live sessions showed models re-calling
// `submit_plan_for_approval` with substantially identical plans after the
// original plan-submission chat message aged out of the windowed context.
// The passive-push reminder in `buildSystemPrompt` keeps the approved plan
// continuously visible per turn, plus an anti-resubmit nudge.

test('<approved-plan-current> block is absent when slot is empty (gitea#478)', () => {
    _reset();
    const prompt = buildSystemPrompt();
    assert.ok(!prompt.includes('<approved-plan-current>'),
        'no approved-plan block when slot is null');
});

test('<approved-plan-current> block is present + carries plan body + ISO approvedAt (gitea#478)', () => {
    _reset();
    setApprovedPlan({ plan: '# X\nstep 1', approvedAt: 1700000000000 });
    try {
        const prompt = buildSystemPrompt();
        assert.ok(prompt.includes('<approved-plan-current>'),
            'opening tag must appear after approval');
        assert.ok(prompt.includes('</approved-plan-current>'),
            'closing tag must appear after approval');
        assert.ok(prompt.includes('step 1'),
            'plan body must appear verbatim inside the block');
        assert.ok(prompt.includes('2023-11-14T22:13:20.000Z'),
            'approvedAt must serialize as ISO string');
        assert.ok(/do NOT re-submit/i.test(prompt),
            'anti-resubmit nudge (the load-bearing sentence) must be present');
    } finally {
        _reset();
    }
});

test('<approved-plan-current> block survives independent of plan-mode state (gitea#478)', () => {
    _reset();
    // Post-approval state: plan mode lifts but the approved plan slot stays
    // populated. The resubmit bug fires precisely in this window.
    const wasPlanMode = getPlanMode();
    try {
        setPlanMode(false);
        setApprovedPlan({ plan: 'P', approvedAt: 1 });
        const prompt = buildSystemPrompt();
        assert.equal(getPlanMode(), false, 'precondition: plan mode is off');
        assert.ok(prompt.includes('<approved-plan-current>'),
            'approved-plan block is independent of getPlanMode()');
        assert.ok(!prompt.includes('--- PLAN MODE ACTIVE ---'),
            'precondition: PLAN MODE ACTIVE block does not appear');
    } finally {
        setPlanMode(wasPlanMode);
        _reset();
    }
});
