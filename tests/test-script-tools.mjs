/**
 * Tests for LLM-authored automation Phase 1 (1.16.0 — DESIGN-llm-authored-
 * automation.md).
 *
 * Exercises the pure-state surface in `js/chat/state.js`
 * (pendingScriptApproval slot, resolve/cancel envelopes, EventBus
 * emission), the `submit_script_for_approval` tool registration, and the
 * `resolveScriptAutomationConfig` helper. The Worker round-trip + the
 * curated-globals helper are covered in `test-script-runner.mjs`. Card
 * mount/unmount is exercised in the browser suite.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EventBus } from '../js/core.js';
import {
    getPendingScriptApproval,
    setPendingScriptApproval,
    resolveScriptApproval,
    cancelScriptApproval,
    cancelToolLoop,
    resetToolLoopCancel,
} from '../js/chat/state.js';
import { registerScriptTools } from '../js/tools/script-tools.js';
import { resolveScriptAutomationConfig } from '../js/profiles/resolve.js';

function reset() {
    if (getPendingScriptApproval()) {
        cancelScriptApproval();
    }
    resetToolLoopCancel();
}

// ============================================
// Pending script-approval slot
// ============================================

test('setPendingScriptApproval stores fields and resolve fn; getter returns same object', () => {
    reset();
    let _resolveFn = null;
    const promise = new Promise(r => { _resolveFn = r; });
    setPendingScriptApproval({
        source: 'console.log("hi")',
        description: 'prints hi',
        expected_output: 'a single hi line',
        resolve: _resolveFn,
    });
    const pending = getPendingScriptApproval();
    assert.equal(pending.source, 'console.log("hi")');
    assert.equal(pending.description, 'prints hi');
    assert.equal(pending.expected_output, 'a single hi line');
    assert.equal(typeof pending.resolve, 'function');
    cancelScriptApproval();
    return promise.then(env => {
        assert.equal(env.status, 'cancelled');
        assert.equal(env.cancelled, true);
    });
});

test('setPendingScriptApproval emits script_approval:pending', () => {
    reset();
    let received = null;
    const handler = (p) => { received = p; };
    EventBus.on('script_approval:pending', handler);
    try {
        setPendingScriptApproval({
            source: 's',
            description: 'd',
            expected_output: 'e',
            resolve: () => {},
        });
        assert.ok(received);
        assert.equal(received.source, 's');
    } finally {
        EventBus.off('script_approval:pending', handler);
        cancelScriptApproval();
    }
});

test('resolveScriptApproval settles with envelope and clears state', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingScriptApproval({
        source: 's',
        description: 'd',
        expected_output: 'e',
        resolve: _resolveFn,
    });
    assert.ok(getPendingScriptApproval());
    const ok = resolveScriptApproval({
        status: 'approved',
        stdout: 'hi\n',
        stderr: '',
        runtime_ms: 12,
        truncated: false,
    });
    assert.equal(ok, true);
    assert.equal(getPendingScriptApproval(), null);
    const env = await p;
    assert.equal(env.status, 'approved');
    assert.equal(env.stdout, 'hi\n');
    assert.equal(env.runtime_ms, 12);
});

test('resolveScriptApproval is no-op when nothing is pending', () => {
    reset();
    const ok = resolveScriptApproval({ status: 'approved' });
    assert.equal(ok, false);
});

test('cancelScriptApproval surfaces partial output', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingScriptApproval({
        source: 'while(1){}',
        description: 'infinite',
        expected_output: 'never',
        resolve: _resolveFn,
    });
    const ok = cancelScriptApproval({
        partial_stdout: 'started\n',
        partial_stderr: 'oops\n',
    });
    assert.equal(ok, true);
    const env = await p;
    assert.equal(env.status, 'cancelled');
    assert.equal(env.cancelled, true);
    assert.equal(env.partial_stdout, 'started\n');
    assert.equal(env.partial_stderr, 'oops\n');
});

test('cancelScriptApproval defaults partial_stdout/stderr to empty strings', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingScriptApproval({
        source: 's',
        description: 'd',
        expected_output: 'e',
        resolve: _resolveFn,
    });
    cancelScriptApproval();
    const env = await p;
    assert.equal(env.partial_stdout, '');
    assert.equal(env.partial_stderr, '');
});

test('cancelToolLoop releases pending script approval', async () => {
    reset();
    let _resolveFn;
    const p = new Promise(r => { _resolveFn = r; });
    setPendingScriptApproval({
        source: 's',
        description: 'd',
        expected_output: 'e',
        resolve: _resolveFn,
    });
    cancelToolLoop();
    const env = await p;
    assert.equal(env.status, 'cancelled');
    assert.equal(getPendingScriptApproval(), null);
    resetToolLoopCancel();
});

// ============================================
// submit_script_for_approval tool registration
// ============================================

test('registerScriptTools registers submit_script_for_approval as readOnly + roles all', () => {
    let captured = null;
    const stub = {
        register(name, handler, definition) {
            captured = { name, handler, definition };
        },
    };
    registerScriptTools(stub);
    assert.ok(captured, 'tool was registered');
    assert.equal(captured.name, 'submit_script_for_approval');
    assert.equal(captured.definition.readOnly, true);
    assert.equal(captured.definition.function.name, 'submit_script_for_approval');
    const params = captured.definition.function.parameters;
    assert.deepEqual(params.required.sort(), ['description', 'expected_output', 'source'].sort());
});

test('submit_script_for_approval handler rejects malformed args', async () => {
    let captured = null;
    const stub = {
        register(name, handler) { captured = handler; },
    };
    registerScriptTools(stub);

    const r1 = await captured(null);
    assert.ok(r1.error, 'null args rejected');
    const r2 = await captured({});
    assert.ok(r2.error, 'empty object rejected');
    const r3 = await captured({ source: '   ', description: 'd', expected_output: 'e' });
    assert.ok(r3.error, 'whitespace-only source rejected');
    const r4 = await captured({ source: 'x', description: '', expected_output: 'e' });
    assert.ok(r4.error, 'empty description rejected');
    const r5 = await captured({ source: 'x', description: 'd', expected_output: '' });
    assert.ok(r5.error, 'empty expected_output rejected');
    const r6 = await captured({ source: 42, description: 'd', expected_output: 'e' });
    assert.ok(r6.error, 'non-string source rejected');
});

test('submit_script_for_approval handler returns Promise that settles via resolveScriptApproval', async () => {
    reset();
    let captured = null;
    const stub = {
        register(name, handler) { captured = handler; },
    };
    registerScriptTools(stub);

    const handlerPromise = captured({
        source: 'console.log(1);',
        description: 'prints 1',
        expected_output: 'a single 1',
    });
    assert.ok(getPendingScriptApproval(), 'pending state set synchronously');
    resolveScriptApproval({
        status: 'approved',
        stdout: '1\n',
        stderr: '',
        runtime_ms: 5,
        truncated: false,
    });
    const result = await handlerPromise;
    assert.equal(result.status, 'approved');
    assert.equal(result.stdout, '1\n');
    reset();
});

// ============================================
// resolveScriptAutomationConfig
// ============================================

test('resolveScriptAutomationConfig returns coder.v1 defaults for coder.v1', () => {
    // 2.0.0 — slice 3: takes profile name, not role.
    const cfg = resolveScriptAutomationConfig('coder.v1');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.timeout_ms, 30000);
    assert.equal(cfg.max_output_bytes, 262144);
    assert.equal(cfg.profileName, 'coder.v1');
});

test('resolveScriptAutomationConfig returns chat.v1 defaults for non-coder profiles', () => {
    for (const profileName of [null, undefined, '', 'chat.v1', 'reviewer.v1', 'pm.v1', 'plugin-dev.v1', 'full.v1', 'unknown']) {
        const cfg = resolveScriptAutomationConfig(profileName);
        assert.equal(cfg.enabled, false, `profile ${JSON.stringify(profileName)} is disabled by default`);
        assert.equal(cfg.timeout_ms, 30000);
        assert.equal(cfg.max_output_bytes, 262144);
        assert.equal(cfg.profileName, 'chat.v1');
    }
});
