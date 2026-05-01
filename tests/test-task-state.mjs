/**
 * Tests for js/chat/task-state.js — per-conversation TaskLedger registry
 * (1.3.17 — PR 4 of the 1.4.0 Tools Phase 1 arc, sticky admission).
 *
 * Asserts:
 *   - `getOrCreateLedger` is idempotent for the same conversation id and
 *     produces a fresh ledger for a different id.
 *   - `getLedger` is lookup-only (no creation side-effect).
 *   - `dropLedger` removes a ledger and is idempotent on missing ids.
 *   - `recordInvocation` always logs successful calls into
 *     `tool_invocations[]`, auto-admits non-static tools into
 *     `tool_admissions[]` with `source: 'discovery'`, and is a no-op for
 *     failed calls (`toolResult.error` truthy) or already-static tools.
 *   - Re-invoking an already-discovered tool updates `last_used_at`
 *     instead of duplicating the admission record.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    getOrCreateLedger,
    getLedger,
    dropLedger,
    recordInvocation,
    _resetForTests,
} from '../js/chat/task-state.js';
import { isTaskLedger } from '../js/profiles/task-ledger.js';

// ============================================
// getOrCreateLedger — idempotence + isolation
// ============================================

test('getOrCreateLedger creates a fresh ledger for an unseen conversation id', () => {
    _resetForTests();
    const ledger = getOrCreateLedger('conv-A', 'coder.v1');
    assert.ok(ledger, 'ledger should be returned');
    assert.ok(isTaskLedger(ledger), 'should match the TaskLedger shape');
    assert.equal(ledger.task_id, 'conv-A');
    assert.equal(ledger.surface, 'coder.v1');
    assert.deepEqual(ledger.tool_admissions, []);
    assert.deepEqual(ledger.tool_invocations, []);
});

test('getOrCreateLedger is idempotent — same id returns the same instance', () => {
    _resetForTests();
    const a = getOrCreateLedger('conv-A', 'coder.v1');
    const b = getOrCreateLedger('conv-A', 'coder.v1');
    assert.equal(a, b, 'should be the same object reference');
});

test('getOrCreateLedger isolates ledgers across conversation ids', () => {
    _resetForTests();
    const a = getOrCreateLedger('conv-A', 'coder.v1');
    const b = getOrCreateLedger('conv-B', 'coder.v1');
    assert.notEqual(a, b);
    a.tool_invocations.push({ tool_id: 'x', invoked_at: 0, turn_id: 't', args_summary: '', succeeded: true });
    assert.equal(b.tool_invocations.length, 0, 'mutating A must not affect B');
});

test('getOrCreateLedger returns null for null/empty conversation id', () => {
    _resetForTests();
    assert.equal(getOrCreateLedger(null, 'coder.v1'), null);
    assert.equal(getOrCreateLedger('', 'coder.v1'), null);
    assert.equal(getOrCreateLedger(undefined, 'coder.v1'), null);
});

// ============================================
// getLedger — lookup-only
// ============================================

test('getLedger returns null when no ledger has been created for the id', () => {
    _resetForTests();
    assert.equal(getLedger('conv-X'), null, 'no implicit creation');
});

test('getLedger returns the existing ledger after creation', () => {
    _resetForTests();
    const created = getOrCreateLedger('conv-A', 'coder.v1');
    const fetched = getLedger('conv-A');
    assert.equal(fetched, created);
});

// ============================================
// dropLedger
// ============================================

test('dropLedger removes a ledger and reports the removal', () => {
    _resetForTests();
    getOrCreateLedger('conv-A', 'coder.v1');
    assert.equal(dropLedger('conv-A'), true);
    assert.equal(getLedger('conv-A'), null);
});

test('dropLedger is a no-op (returns false) for an unknown id', () => {
    _resetForTests();
    assert.equal(dropLedger('conv-Y'), false);
    assert.equal(dropLedger(null), false);
    assert.equal(dropLedger(''), false);
});

// ============================================
// recordInvocation — happy path
// ============================================

test('recordInvocation logs a successful call and auto-admits a non-static tool', () => {
    _resetForTests();
    const r = recordInvocation({
        conversationId: 'conv-A',
        toolName: 'find_xrefs',
        args: { symbol: 'composeAdmission' },
        toolResult: { results: [] },
        turnId: 'call_1',
        surface: 'coder.v1',
        staticNames: ['read_file', 'edit_file'],
        toolCost: 200,
        now: 1700000000000,
    });
    assert.deepEqual(r, { recorded: true, admitted: true });

    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_invocations.length, 1);
    const inv = ledger.tool_invocations[0];
    assert.equal(inv.tool_id, 'find_xrefs');
    assert.equal(inv.turn_id, 'call_1');
    assert.equal(inv.invoked_at, 1700000000000);
    assert.equal(inv.succeeded, true);
    assert.match(inv.args_summary, /composeAdmission/);

    assert.equal(ledger.tool_admissions.length, 1);
    const adm = ledger.tool_admissions[0];
    assert.equal(adm.tool_id, 'find_xrefs');
    assert.equal(adm.source, 'discovery');
    assert.equal(adm.form, 'full');
    assert.equal(adm.cost, 200);
    assert.equal(adm.last_used_at, 1700000000000);
});

test('recordInvocation does NOT admit a static tool — only logs the invocation', () => {
    _resetForTests();
    const r = recordInvocation({
        conversationId: 'conv-A',
        toolName: 'read_file',
        args: { path: 'a.js' },
        toolResult: { content: '...' },
        turnId: 'call_2',
        surface: 'coder.v1',
        staticNames: ['read_file', 'edit_file'],
        toolCost: 150,
    });
    assert.deepEqual(r, { recorded: true, admitted: false });

    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_invocations.length, 1);
    assert.equal(ledger.tool_admissions.length, 0, 'static tools should NOT be added to the ledger admission set');
});

test('recordInvocation re-invocation updates last_used_at without duplicating the admission', () => {
    _resetForTests();
    recordInvocation({
        conversationId: 'conv-A',
        toolName: 'find_xrefs', args: {}, toolResult: { ok: true },
        turnId: 't1', surface: 'coder.v1', staticNames: [], toolCost: 200,
        now: 1700000000000,
    });
    recordInvocation({
        conversationId: 'conv-A',
        toolName: 'find_xrefs', args: {}, toolResult: { ok: true },
        turnId: 't2', surface: 'coder.v1', staticNames: [], toolCost: 200,
        now: 1700000000900,
    });
    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_admissions.length, 1, 'must not duplicate the admission record');
    assert.equal(ledger.tool_admissions[0].last_used_at, 1700000000900, 'last_used_at should advance');
    assert.equal(ledger.tool_invocations.length, 2, 'every invocation is still logged');
});

// ============================================
// recordInvocation — failure / edge cases
// ============================================

test('recordInvocation skips a failed tool call (toolResult.error truthy)', () => {
    _resetForTests();
    const r = recordInvocation({
        conversationId: 'conv-A',
        toolName: 'find_xrefs', args: {}, toolResult: { error: 'boom' },
        turnId: 't1', surface: 'coder.v1', staticNames: [], toolCost: 200,
    });
    assert.deepEqual(r, { recorded: false, admitted: false });
    assert.equal(getLedger('conv-A'), null, 'no ledger should have been created');
});

test('recordInvocation skips when toolName is missing', () => {
    _resetForTests();
    const r = recordInvocation({
        conversationId: 'conv-A', toolName: '', args: {}, toolResult: {},
        turnId: 't1', surface: 'coder.v1', staticNames: [], toolCost: 0,
    });
    assert.deepEqual(r, { recorded: false, admitted: false });
});

test('recordInvocation skips when conversationId is null/empty', () => {
    _resetForTests();
    const r = recordInvocation({
        conversationId: null, toolName: 'find_xrefs', args: {}, toolResult: {},
        turnId: 't1', surface: 'coder.v1', staticNames: [], toolCost: 200,
    });
    assert.deepEqual(r, { recorded: false, admitted: false });
});

test('recordInvocation truncates args_summary to <= 200 chars', () => {
    _resetForTests();
    const big = 'x'.repeat(500);
    recordInvocation({
        conversationId: 'conv-A',
        toolName: 'find_xrefs', args: { blob: big }, toolResult: { ok: true },
        turnId: 't1', surface: 'coder.v1', staticNames: [], toolCost: 200,
    });
    const inv = getLedger('conv-A').tool_invocations[0];
    assert.ok(inv.args_summary.length <= 200, `summary length ${inv.args_summary.length} should be <= 200`);
    assert.ok(inv.args_summary.endsWith('…'), 'should end with ellipsis when truncated');
});
