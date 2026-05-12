/**
 * Tests for Plan Mode (github#25 — 1.10.0).
 *
 * Exercises the pure-state surface in js/chat/state.js (planMode flag,
 * pendingPlanApproval slot, resolve/cancel envelopes, EventBus emission)
 * plus the registry filterReadOnly helper and the submit_plan_for_approval
 * tool registration. DOM-side card mount/unmount and the chat-loop
 * auto-toggle-off path are exercised in the browser suite
 * (tests/index.html).
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus, Storage } from '../js/core.js';
import {
    getPlanMode,
    setPlanMode,
    getPendingPlanApproval,
    setPendingPlanApproval,
    resolvePlanApproval,
    cancelPlanApproval,
    cancelToolLoop,
    resetToolLoopCancel,
} from '../js/chat/state.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { registerPlanTools } from '../js/tools/plan-tools.js';
import { registerScratchpadTools } from '../js/tools/scratchpad-tools.js';
import { registerTodoTools } from '../js/tools/todo-tools.js';

function reset() {
    setPlanMode(false);
    if (getPendingPlanApproval()) {
        cancelPlanApproval();
    }
    resetToolLoopCancel();
}

// ============================================
// Plan-mode flag
// ============================================

test('setPlanMode flips the flag and is idempotent', () => {
    reset();
    assert.equal(getPlanMode(), false);
    setPlanMode(true);
    assert.equal(getPlanMode(), true);
    setPlanMode(true);
    assert.equal(getPlanMode(), true, 'idempotent set keeps flag true');
    setPlanMode(false);
    assert.equal(getPlanMode(), false);
});

test('setPlanMode persists via Storage (2.40.0 — IDB-backed, prefixed)', () => {
    reset();
    setPlanMode(true);
    // Storage holds a real boolean and prefixes the localStorage write-through.
    assert.equal(Storage.get('chat.planMode'), true);
    assert.equal(localStorage.getItem('ai-editor-chat.planMode'), 'true');
    setPlanMode(false);
    assert.equal(Storage.get('chat.planMode'), false);
    assert.equal(localStorage.getItem('ai-editor-chat.planMode'), 'false');
    // The pre-2.40.0 unprefixed legacy key is never written.
    assert.equal(localStorage.getItem('chat.planMode'), null);
});

test('setPlanMode emits plan-mode:changed only on transition', () => {
    reset();
    let count = 0;
    const handler = () => count++;
    EventBus.on('plan-mode:changed', handler);
    try {
        setPlanMode(true);
        setPlanMode(true);  // no-op
        setPlanMode(false);
        setPlanMode(false); // no-op
        assert.equal(count, 2);
    } finally {
        EventBus.off('plan-mode:changed', handler);
    }
});

test('setPlanMode coerces truthy / falsy values to boolean', () => {
    reset();
    setPlanMode(1);
    assert.equal(getPlanMode(), true);
    setPlanMode(0);
    assert.equal(getPlanMode(), false);
    setPlanMode('yes');
    assert.equal(getPlanMode(), true);
    setPlanMode('');
    assert.equal(getPlanMode(), false);
});

// ============================================
// Pending plan-approval slot
// ============================================

test('setPendingPlanApproval stores plan and resolve fn; getter returns same object', () => {
    reset();
    let _resolveFn = null;
    const promise = new Promise(r => { _resolveFn = r; });
    setPendingPlanApproval({ plan: 'do the thing', resolve: _resolveFn });
    const pending = getPendingPlanApproval();
    assert.equal(pending.plan, 'do the thing');
    assert.equal(typeof pending.resolve, 'function');
    // Cleanup
    cancelPlanApproval();
    return promise.then(env => {
        assert.equal(env.status, 'cancelled');
    });
});

test('setPendingPlanApproval emits plan_approval:pending', () => {
    reset();
    let received = null;
    const handler = (p) => { received = p; };
    EventBus.on('plan_approval:pending', handler);
    try {
        setPendingPlanApproval({ plan: 'X', resolve: () => {} });
        assert.ok(received);
        assert.equal(received.plan, 'X');
    } finally {
        EventBus.off('plan_approval:pending', handler);
        cancelPlanApproval();
    }
});

test('resolvePlanApproval settles the promise with envelope and clears state', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingPlanApproval({ plan: 'done', resolve: _resolveFn });
    assert.ok(getPendingPlanApproval());
    const ok = resolvePlanApproval({ status: 'approved' });
    assert.equal(ok, true);
    assert.equal(getPendingPlanApproval(), null);
    const env = await p;
    assert.equal(env.status, 'approved');
});

test('resolvePlanApproval is no-op when nothing is pending', () => {
    reset();
    const ok = resolvePlanApproval({ status: 'approved' });
    assert.equal(ok, false);
});

test('cancelPlanApproval settles with cancelled envelope', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingPlanApproval({ plan: 'cancel me', resolve: _resolveFn });
    const ok = cancelPlanApproval();
    assert.equal(ok, true);
    const env = await p;
    assert.equal(env.status, 'cancelled');
    assert.equal(env.cancelled, true);
});

test('cancelToolLoop releases pending plan approval', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingPlanApproval({ plan: 'loopy', resolve: _resolveFn });
    cancelToolLoop();
    const env = await p;
    assert.equal(env.status, 'cancelled');
    assert.equal(getPendingPlanApproval(), null);
    resetToolLoopCancel();
});

// ============================================
// Read-only filter
// ============================================

test('ToolRegistry.filterReadOnly drops entries lacking readOnly: true', () => {
    const defs = [
        { function: { name: 'a' }, readOnly: true },
        { function: { name: 'b' }, readOnly: false },
        { function: { name: 'c' } }, // unset
        { function: { name: 'd' }, readOnly: true },
    ];
    const out = ToolRegistry.filterReadOnly(defs);
    assert.deepEqual(out.map(d => d.function.name), ['a', 'd']);
});

test('ToolRegistry.filterReadOnly preserves order', () => {
    const defs = [
        { function: { name: 'r1' }, readOnly: true },
        { function: { name: 'w1' } },
        { function: { name: 'r2' }, readOnly: true },
        { function: { name: 'w2' } },
        { function: { name: 'r3' }, readOnly: true },
    ];
    const out = ToolRegistry.filterReadOnly(defs);
    assert.deepEqual(out.map(d => d.function.name), ['r1', 'r2', 'r3']);
});

// ============================================
// submit_plan_for_approval tool registration
// ============================================

test('registerPlanTools registers submit_plan_for_approval as readOnly', () => {
    // Use a fresh registry-shape stub so this test doesn't disturb the
    // real registry; we just verify the call shape registerPlanTools makes.
    let captured = null;
    const stub = {
        register(name, handler, definition) {
            captured = { name, handler, definition };
        },
    };
    registerPlanTools(stub);
    assert.equal(captured.name, 'submit_plan_for_approval');
    assert.equal(captured.definition.readOnly, true);
    assert.equal(captured.definition.roles, 'all');
    assert.equal(captured.definition.function.name, 'submit_plan_for_approval');
    assert.ok(captured.definition.function.parameters.required.includes('plan'));
});

test('submit_plan_for_approval handler rejects empty / non-string plan', async () => {
    let captured = null;
    const stub = {
        register(name, handler) { captured = handler; },
    };
    registerPlanTools(stub);
    const r1 = await captured(null);
    assert.ok(r1.error);
    const r2 = await captured({});
    assert.ok(r2.error);
    const r3 = await captured({ plan: '   ' });
    assert.ok(r3.error);
    const r4 = await captured({ plan: 42 });
    assert.ok(r4.error);
});

test('submit_plan_for_approval handler returns a Promise that settles via resolvePlanApproval', async () => {
    reset();
    let captured = null;
    const stub = {
        register(name, handler) { captured = handler; },
    };
    registerPlanTools(stub);
    const handlerPromise = captured({ plan: 'a real plan' });
    // Now there's a pending plan approval; resolve it from outside.
    assert.ok(getPendingPlanApproval());
    resolvePlanApproval({ status: 'approved' });
    const result = await handlerPromise;
    assert.equal(result.status, 'approved');
    reset();
});

// ============================================
// Session-local writes admitted in Plan Mode (1.11.1 — github#25 follow-up)
// ============================================
//
// The `readOnly` flag means "no effect outside the current chat session", not
// "no mutation." Session-local working memory (scratchpad, todos) is the
// natural surface for a planning LLM to track files / decisions / open
// questions, and forcing all of that into reasoning-content blows context
// each iteration. So `scratchpad_write` and `todo_write` ride alongside
// their `_read` siblings in Plan Mode. Persistent memory writes
// (`memory_write`) and project mutations (`edit_file`, `commit`, …) stay
// blocked because those leak outside the conversation.
//
// Pattern mirrors the `submit_plan_for_approval` test above: register into
// a stub registry and inspect what the registration declared, so we don't
// disturb the real registry's state.

function _registerWith(stub, registerFn) {
    registerFn(stub);
}

test('registerScratchpadTools flags scratchpad_write as readOnly (Plan Mode admits it)', () => {
    const captured = new Map();
    const stub = {
        register(name, handler, definition) {
            captured.set(name, { handler, definition });
        },
    };
    registerScratchpadTools(stub);

    const write = captured.get('scratchpad_write');
    assert.ok(write, 'scratchpad_write was registered');
    assert.equal(write.definition.readOnly, true,
        'scratchpad_write must be readOnly so Plan Mode admits it (session-local writes)');

    // Sanity: scratchpad_read keeps its existing flag.
    const read = captured.get('scratchpad_read');
    assert.equal(read.definition.readOnly, true);

    // Intentionally NOT readOnly: scratchpad_clear. Even though clearing is
    // session-local in effect, it's a destructive "drop everything" semantic
    // the user might want blocked while planning. If a planning LLM makes a
    // mistake it can overwrite via scratchpad_write (write is keyed). If we
    // ever decide to admit it, flip the flag here and update this comment.
    const clear = captured.get('scratchpad_clear');
    assert.ok(clear, 'scratchpad_clear was registered');
    assert.notEqual(clear.definition.readOnly, true,
        'scratchpad_clear is intentionally filtered under Plan Mode (destructive bulk-drop)');
});

test('registerTodoTools flags todo_write as readOnly (Plan Mode admits it)', () => {
    const captured = new Map();
    const stub = {
        register(name, handler, definition) {
            captured.set(name, { handler, definition });
        },
    };
    registerTodoTools(stub);

    const write = captured.get('todo_write');
    assert.ok(write, 'todo_write was registered');
    assert.equal(write.definition.readOnly, true,
        'todo_write must be readOnly so Plan Mode admits it (conversation-scoped state)');

    // Sanity: todo_read keeps its existing flag.
    const read = captured.get('todo_read');
    assert.equal(read.definition.readOnly, true);
});

test('Plan Mode filter (filterReadOnly) admits scratchpad_write + todo_write but drops memory_write', () => {
    // End-to-end check on the same name-based filter that LLMTools.getToolsForRole
    // uses. We build a representative slice of the OpenAI-shape tool array that
    // would reach the LLM, mark each entry with the registry's readOnly bit,
    // and assert the post-filter set.
    const slice = [
        { type: 'function', function: { name: 'scratchpad_read'  }, readOnly: true },
        { type: 'function', function: { name: 'scratchpad_write' }, readOnly: true },  // 1.11.1 admit
        { type: 'function', function: { name: 'scratchpad_clear' } },                  // intentionally dropped
        { type: 'function', function: { name: 'todo_read'        }, readOnly: true },
        { type: 'function', function: { name: 'todo_write'       }, readOnly: true },  // 1.11.1 admit
        { type: 'function', function: { name: 'memory_recall'    }, readOnly: true },
        { type: 'function', function: { name: 'memory_write'     } },                  // stays blocked
        { type: 'function', function: { name: 'edit_file'        } },                  // stays blocked
    ];
    const out = ToolRegistry.filterReadOnly(slice).map(d => d.function.name);
    assert.deepEqual(out.sort(), [
        'memory_recall',
        'scratchpad_read',
        'scratchpad_write',
        'todo_read',
        'todo_write',
    ].sort());
    assert.ok(!out.includes('scratchpad_clear'));
    assert.ok(!out.includes('memory_write'));
    assert.ok(!out.includes('edit_file'));
});
