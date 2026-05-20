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
// Plan-mode-admitted filter (filterReadOnly)
// ============================================
//
// **2.76.0 (gitea#480)** — `filterReadOnly` migrated from the opt-in
// `readOnly: true` flag to `side_effects` classification (sourced from
// `js/intelligence/tools/side-effects.js`). Test names retained — the
// public surface name is unchanged — but the assertions exercise the
// new catalog-driven contract. Synthetic single-letter tool names that
// the pre-2.76.0 tests used now fail-closed (no catalog entry → defaults
// to `'external'`), so this rewrite uses real registered tool names.

test('ToolRegistry.filterReadOnly drops tools whose side_effects ≠ read (and not session-write allowlisted)', () => {
    const defs = [
        { function: { name: 'read_file' } },          // 'read' — admit
        { function: { name: 'edit_file' } },          // 'write' — drop
        { function: { name: 'create_pull_request' } },// 'external' — drop
        { function: { name: 'list_projects' } },      // 'read' — admit
    ];
    const out = ToolRegistry.filterReadOnly(defs);
    assert.deepEqual(out.map(d => d.function.name), ['read_file', 'list_projects']);
});

test('ToolRegistry.filterReadOnly preserves order', () => {
    const defs = [
        { function: { name: 'read_file' } },          // admit
        { function: { name: 'edit_file' } },          // drop
        { function: { name: 'read_lines' } },         // admit
        { function: { name: 'write_file' } },         // drop
        { function: { name: 'get_project_tree' } },   // admit
    ];
    const out = ToolRegistry.filterReadOnly(defs);
    assert.deepEqual(out.map(d => d.function.name), ['read_file', 'read_lines', 'get_project_tree']);
});

test('ToolRegistry.filterReadOnly fails closed: unknown tool names are dropped', () => {
    // A name with no side_effects classification (incl. MCP-bridged tools
    // and any future tool registered without a catalog entry) is treated
    // as 'external' → not admitted. This is the regression test for the
    // gitea#480 root cause: the pre-2.76.0 filter let unclassified tools
    // slip through; the catalog-driven filter blocks them.
    const defs = [
        { function: { name: 'read_file' } },              // admit
        { function: { name: 'mcp__unknown_server__do' } },// unknown → drop
        { function: { name: 'totally_made_up_tool' } },   // unknown → drop
        { function: { name: 'scratchpad_write' } },       // allowlisted → admit
    ];
    const out = ToolRegistry.filterReadOnly(defs);
    assert.deepEqual(out.map(d => d.function.name), ['read_file', 'scratchpad_write']);
});

test('ToolRegistry.filterReadOnly tolerates malformed entries', () => {
    // Defensive: nulls / missing function shape are dropped without throwing.
    const defs = [
        null,
        { /* no function */ },
        { function: {} /* no name */ },
        { function: { name: 'read_file' } },
    ];
    const out = ToolRegistry.filterReadOnly(defs);
    assert.deepEqual(out.map(d => d.function.name), ['read_file']);
});

// ============================================
// submit_plan_for_approval tool registration
// ============================================

// gitea#424 (2.52.0) — registerPlanTools now registers BOTH
// submit_plan_for_approval and read_approved_plan, so test stubs use a
// Map captor keyed by tool name. The submit_plan_for_approval contract
// stays unchanged.
function _capturePlanTools() {
    const captured = new Map();
    const stub = {
        register(name, handler, definition) {
            captured.set(name, { handler, definition });
        },
    };
    registerPlanTools(stub);
    return captured;
}

test('registerPlanTools registers submit_plan_for_approval as readOnly', () => {
    const captured = _capturePlanTools();
    const entry = captured.get('submit_plan_for_approval');
    assert.ok(entry, 'submit_plan_for_approval was registered');
    assert.equal(entry.definition.readOnly, true);
    assert.equal(entry.definition.function.name, 'submit_plan_for_approval');
    assert.ok(entry.definition.function.parameters.required.includes('plan'));
});

test('submit_plan_for_approval handler rejects empty / non-string plan', async () => {
    const captured = _capturePlanTools();
    const handler = captured.get('submit_plan_for_approval').handler;
    const r1 = await handler(null);
    assert.ok(r1.error);
    const r2 = await handler({});
    assert.ok(r2.error);
    const r3 = await handler({ plan: '   ' });
    assert.ok(r3.error);
    const r4 = await handler({ plan: 42 });
    assert.ok(r4.error);
});

test('submit_plan_for_approval handler returns a Promise that settles via resolvePlanApproval', async () => {
    reset();
    const captured = _capturePlanTools();
    const handler = captured.get('submit_plan_for_approval').handler;
    const handlerPromise = handler({ plan: 'a real plan' });
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

test('registerPlanTools registers read_approved_plan as readOnly (gitea#424 — admitted in Plan Mode and after)', () => {
    // The read tool must stay admitted during Plan Mode so the model
    // could in principle read a plan from a prior conversation cycle,
    // and admitted after approval so the executor can re-ground each
    // implementation step. `readOnly: true` is the single knob.
    const captured = _capturePlanTools();
    const entry = captured.get('read_approved_plan');
    assert.ok(entry, 'read_approved_plan was registered');
    assert.equal(entry.definition.readOnly, true);
    assert.equal(entry.definition.function.name, 'read_approved_plan');
    assert.deepEqual(entry.definition.function.parameters.required, []);
});

test('Plan Mode filter (filterReadOnly) admits scratchpad_write + todo_write but drops scratchpad_clear / edit_file / write_file', () => {
    // End-to-end check on the same filter that LLMTools.getToolsForRole
    // uses to build the LLM's tool catalog under plan mode. As of 2.76.0
    // (gitea#480) the filter no longer consults the per-tool `readOnly`
    // flag; it consults `side_effects` from the catalog plus the
    // session-write allowlist in `js/tools/registry.js`. The expected
    // admission set is unchanged from the pre-2.76.0 baseline — only the
    // source of truth moved — so we keep the same expected output and
    // strip the now-irrelevant `readOnly: true` markers from the slice.
    //
    // The slice also includes `write_file` + `create_pull_request` to pin
    // the gitea#480 regression: pre-fix they passed the list filter (they
    // never declared `readOnly: true`, so the old `filter(d => d.readOnly === true)`
    // semantic correctly dropped them at the list layer — the bug was on
    // the *dispatch* side); under the new catalog-driven semantic they
    // still drop here, which is the conservative-correct outcome.
    const slice = [
        { type: 'function', function: { name: 'scratchpad_read'  } },                  // 'read' → admit
        { type: 'function', function: { name: 'scratchpad_write' } },                  // allowlist → admit
        { type: 'function', function: { name: 'scratchpad_clear' } },                  // 'write' not allowlisted → drop
        { type: 'function', function: { name: 'todo_read'        } },                  // 'read' (added 2.76.0) → admit
        { type: 'function', function: { name: 'todo_write'       } },                  // allowlist → admit
        { type: 'function', function: { name: 'memory_recall'    } },                  // 'read' → admit
        { type: 'function', function: { name: 'memory_remember'  } },                  // 'write' not allowlisted → drop
        { type: 'function', function: { name: 'edit_file'        } },                  // 'write' not allowlisted → drop
        { type: 'function', function: { name: 'write_file'       } },                  // 'external' (gitea#480) → drop
        { type: 'function', function: { name: 'create_pull_request' } },               // 'external' (gitea#480) → drop
        { type: 'function', function: { name: 'submit_plan_for_approval' } },          // 'read' → admit
        { type: 'function', function: { name: 'read_approved_plan' } },                // 'read' → admit
    ];
    const out = ToolRegistry.filterReadOnly(slice).map(d => d.function.name);
    assert.deepEqual(out.sort(), [
        'memory_recall',
        'read_approved_plan',
        'scratchpad_read',
        'scratchpad_write',
        'submit_plan_for_approval',
        'todo_read',
        'todo_write',
    ].sort());
    assert.ok(!out.includes('scratchpad_clear'));
    assert.ok(!out.includes('memory_remember'));
    assert.ok(!out.includes('edit_file'));
    assert.ok(!out.includes('write_file'), 'write_file must NOT slip through plan mode (gitea#480)');
    assert.ok(!out.includes('create_pull_request'), 'create_pull_request must NOT slip through plan mode (gitea#480)');
});

// ============================================
// Dispatch-side plan-mode gate (gitea#480 — 2.76.0)
// ============================================
//
// The list-side filter (filterReadOnly above) is the first gate. The
// authoritative second gate is in `ToolRegistry.executeWithProfile`,
// which calls `checkPlanModeAccess(name)` before dispatching to the
// handler. This catches calls that reach dispatch by paths bypassing
// the list filter (cached tool messages, sub-agent paths, MCP shims).
//
// We exercise `checkPlanModeAccess` directly rather than going through
// `execute` to keep the unit pure (no real handler registration, no
// State/IDB side effects). The `executeWithProfile` integration is
// covered by `tests/test-tool-registry-execute-with-profile.mjs`.

test('checkPlanModeAccess: plan mode OFF → always allowed', () => {
    reset();
    assert.equal(getPlanMode(), false);
    for (const name of ['read_file', 'write_file', 'create_pull_request', 'mcp__x__do']) {
        const r = ToolRegistry.checkPlanModeAccess(name);
        assert.equal(r.allowed, true, `${name} should be allowed when plan mode is off`);
    }
});

test('checkPlanModeAccess: plan mode ON → blocks write_file (gitea#480 regression)', () => {
    reset();
    setPlanMode(true);
    try {
        const r = ToolRegistry.checkPlanModeAccess('write_file');
        assert.equal(r.allowed, false);
        assert.equal(r.sideEffect, 'external');
        assert.match(r.reason, /plan mode/i);
        assert.match(r.reason, /write_file/);
        assert.match(r.reason, /submit_plan_for_approval/);
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → blocks create_pull_request (gitea#480 regression)', () => {
    reset();
    setPlanMode(true);
    try {
        const r = ToolRegistry.checkPlanModeAccess('create_pull_request');
        assert.equal(r.allowed, false);
        assert.equal(r.sideEffect, 'external');
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → blocks edit_file (write classification)', () => {
    reset();
    setPlanMode(true);
    try {
        const r = ToolRegistry.checkPlanModeAccess('edit_file');
        assert.equal(r.allowed, false);
        assert.equal(r.sideEffect, 'write');
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → admits read tools', () => {
    reset();
    setPlanMode(true);
    try {
        for (const name of ['read_file', 'read_lines', 'get_project_tree', 'list_projects', 'read_docs', 'list_user_plugins']) {
            const r = ToolRegistry.checkPlanModeAccess(name);
            assert.equal(r.allowed, true, `${name} should be admitted in plan mode (side_effects=read)`);
        }
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → admits session-write allowlist (scratchpad_write, todo_write)', () => {
    reset();
    setPlanMode(true);
    try {
        for (const name of ['scratchpad_write', 'todo_write']) {
            const r = ToolRegistry.checkPlanModeAccess(name);
            assert.equal(r.allowed, true, `${name} should be admitted in plan mode (session-write allowlist)`);
        }
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → admits submit_plan_for_approval (workflow entry)', () => {
    reset();
    setPlanMode(true);
    try {
        const r = ToolRegistry.checkPlanModeAccess('submit_plan_for_approval');
        assert.equal(r.allowed, true);
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → fail-closed on unknown tool (MCP-style name)', () => {
    // The dispatch-side gate must fail closed on names without a
    // side_effects classification so a future tool registered without
    // a catalog entry can't bypass the gate. MCP-bridged tools also fall
    // into this bucket — the registry can't introspect their semantics.
    reset();
    setPlanMode(true);
    try {
        const r = ToolRegistry.checkPlanModeAccess('mcp__some_server__do_thing');
        assert.equal(r.allowed, false);
        assert.equal(r.sideEffect, 'external');
    } finally {
        reset();
    }
});

test('checkPlanModeAccess: plan mode ON → blocks scratchpad_clear (intentional)', () => {
    // scratchpad_clear is session-local but destructive bulk-drop; the
    // pre-2.76.0 baseline excluded it from the readOnly flag, and the
    // new gate preserves that exclusion by leaving it off the allowlist.
    reset();
    setPlanMode(true);
    try {
        const r = ToolRegistry.checkPlanModeAccess('scratchpad_clear');
        assert.equal(r.allowed, false);
        assert.equal(r.sideEffect, 'write');
    } finally {
        reset();
    }
});
