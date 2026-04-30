/**
 * Pure-data tests for js/profiles/ — the 1.1.0 scaffolding.
 *
 * Runs under `node --test`. The profile modules import nothing
 * side-effecting (no DOM, no Storage, no fetch), so this file does not
 * need a browser shim. Mirrored by `tests/test-profiles.js` for the
 * in-page browser suite via the `window.T` mini-framework.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createTaskLedger,
    isTaskLedger,
    DEFAULT_LEDGER_CAPACITY,
    isProfile,
    CODER_V1,
} from '../js/profiles/index.js';

// ============================================
// createTaskLedger — happy path
// ============================================

test('createTaskLedger returns the canonical empty-state shape', () => {
    const t = 1700000000000; // fixed clock for deterministic test
    const led = createTaskLedger({ taskId: 't-1', surface: 'coder.v1', startedAt: t });
    assert.equal(led.task_id, 't-1');
    assert.equal(led.surface, 'coder.v1');
    assert.equal(led.started_at, t);
    assert.deepEqual(led.admissions, []);
    assert.deepEqual(led.exclusions, []);
    assert.deepEqual(led.tool_admissions, []);
    assert.deepEqual(led.tool_invocations, []);
    assert.equal(led.capacity, DEFAULT_LEDGER_CAPACITY);
});

test('createTaskLedger uses Date.now() when startedAt omitted', () => {
    const before = Date.now();
    const led = createTaskLedger({ taskId: 't-2', surface: 'coder.v1' });
    const after = Date.now();
    assert.ok(led.started_at >= before && led.started_at <= after,
        `started_at ${led.started_at} not between ${before} and ${after}`);
});

test('createTaskLedger respects custom capacity', () => {
    const led = createTaskLedger({ taskId: 't-3', surface: 'coder.v1', capacity: 50 });
    assert.equal(led.capacity, 50);
});

test('createTaskLedger ignores invalid capacity (zero, negative, non-number)', () => {
    const led1 = createTaskLedger({ taskId: 't-4', surface: 'coder.v1', capacity: 0 });
    const led2 = createTaskLedger({ taskId: 't-4', surface: 'coder.v1', capacity: -10 });
    // @ts-expect-error — testing runtime fallback for non-number capacity
    const led3 = createTaskLedger({ taskId: 't-4', surface: 'coder.v1', capacity: 'big' });
    assert.equal(led1.capacity, DEFAULT_LEDGER_CAPACITY);
    assert.equal(led2.capacity, DEFAULT_LEDGER_CAPACITY);
    assert.equal(led3.capacity, DEFAULT_LEDGER_CAPACITY);
});

test('createTaskLedger throws on missing or empty taskId', () => {
    // @ts-expect-error — runtime-only validation
    assert.throws(() => createTaskLedger({ surface: 'coder.v1' }), TypeError);
    assert.throws(() => createTaskLedger({ taskId: '', surface: 'coder.v1' }), TypeError);
    // @ts-expect-error — runtime-only validation
    assert.throws(() => createTaskLedger({ taskId: 42, surface: 'coder.v1' }), TypeError);
});

test('createTaskLedger throws on missing or empty surface', () => {
    // @ts-expect-error — runtime-only validation
    assert.throws(() => createTaskLedger({ taskId: 't-1' }), TypeError);
    assert.throws(() => createTaskLedger({ taskId: 't-1', surface: '' }), TypeError);
});

// ============================================
// isTaskLedger — type guard
// ============================================

test('isTaskLedger accepts a freshly created ledger', () => {
    assert.equal(isTaskLedger(createTaskLedger({ taskId: 't', surface: 's' })), true);
});

test('isTaskLedger rejects null / undefined / primitives', () => {
    assert.equal(isTaskLedger(null), false);
    assert.equal(isTaskLedger(undefined), false);
    assert.equal(isTaskLedger(0), false);
    assert.equal(isTaskLedger('ledger'), false);
    assert.equal(isTaskLedger({}), false);
});

test('isTaskLedger rejects partial shapes', () => {
    const led = createTaskLedger({ taskId: 't', surface: 's' });
    // Mutate to break the shape — test each missing piece.
    const missing_admissions = { ...led, admissions: undefined };
    const wrong_type_started = { ...led, started_at: 'not-a-number' };
    const missing_capacity = { ...led, capacity: undefined };
    assert.equal(isTaskLedger(missing_admissions), false);
    assert.equal(isTaskLedger(wrong_type_started), false);
    assert.equal(isTaskLedger(missing_capacity), false);
});

// ============================================
// CODER_V1 profile — shape conformance
// ============================================

test('CODER_V1 satisfies isProfile', () => {
    assert.equal(isProfile(CODER_V1), true);
});

test('CODER_V1 declares the canonical name and version', () => {
    assert.equal(CODER_V1.name, 'coder.v1');
    assert.equal(CODER_V1.version, '1');
    assert.equal(CODER_V1.base, null); // 1.1.0 ships only coder.v1; no base.
});

test('CODER_V1 budget shape matches DESIGN-profiles.md coder overrides', () => {
    // Coder inherits chat.v1's 32K total + system_reserve 2K + history_reserve 8K,
    // overrides output_reserve to 8000 and memory_reserve to 1500.
    // Residual retrieval_budget = 32000 - 19500 = 12500.
    const b = CODER_V1.budget;
    assert.equal(b.total_tokens, 32000);
    assert.equal(b.system_reserve, 2000);
    assert.equal(b.output_reserve, 8000);
    assert.equal(b.history_reserve, 8000);
    assert.equal(b.memory_reserve, 1500);
    const residual = b.total_tokens - (b.system_reserve + b.output_reserve + b.history_reserve + b.memory_reserve);
    assert.equal(residual, 12500, `expected retrieval residual 12500, got ${residual}`);
});

test('CODER_V1 retrieval mirrors current single-strategy semantic behavior', () => {
    const r = CODER_V1.retrieval;
    assert.equal(r.strategy_weights.semantic, 1.0);
    assert.equal(r.strategy_weights.structural, 0.0);
    assert.equal(r.strategy_weights.thematic, 0.0);
    assert.deepEqual(r.chunkers, []);            // 1.5.0 fills these in.
    assert.deepEqual(r.metadata_extensions, []); // 1.5.0 fills these in.
    assert.ok(r.novelty_threshold >= 0 && r.novelty_threshold <= 1);
});

test('CODER_V1 memory mirrors current scratchpad-only state', () => {
    assert.equal(CODER_V1.memory.default_scope, 'session');
    assert.equal(CODER_V1.memory.propose_after_n_turns, null);
});

test('CODER_V1 compression registers Rules 1, 2, and 5 (1.2.0)', () => {
    const c = CODER_V1.compression;
    assert.equal(c.rules.length, 3);
    const names = c.rules.map(r => r.name);
    assert.deepEqual(names, ['subsumption', 'invalidation', 'summarization']);
    // Priorities are sorted ascending; lower runs first.
    const priorities = c.rules.map(r => r.priority);
    assert.deepEqual(priorities, [10, 20, 50]);
    // preserve_recent kept at 24 — see coder-v1.js for the
    // reconciliation note vs DESIGN's "start at 4" suggestion.
    assert.equal(c.preserve_recent, 24);
    assert.ok(c.summarizer);
    assert.equal(c.summarizer.mode, 'balanced');
});

test('CODER_V1 tools.budget_tokens matches ROADMAP §Decisions 5 default', () => {
    assert.equal(CODER_V1.tools.budget_tokens, 5000);
    // catalog stays empty — source of truth is js/tools/registry.js via the Catalog adapter (1.3.4).
    assert.deepEqual(CODER_V1.tools.catalog, []);
    // static was populated in 1.3.4 (PR 1 of 1.4.0 Tools Phase 1) with the
    // ROADMAP §1.4.0 set: meta-tools + read_file/read_lines/scan_file +
    // edit_file + commit_files + list_dirty_files. Names that do not yet
    // exist in the registry (the meta-tools, until 1.4.0 PR 3) are
    // silently skipped by the admission consumer.
    assert.deepEqual(CODER_V1.tools.static, [
        'list_tool_categories',
        'list_tools_by_category',
        'find_tool',
        'read_file',
        'read_lines',
        'scan_file',
        'edit_file',
        'commit_files',
        'list_dirty_files',
    ]);
    assert.equal(CODER_V1.tools.expansion_mode, 'short');
});

test('CODER_V1 task_ledger config matches DESIGN-profiles.md "coder.v1"', () => {
    const tl = CODER_V1.task_ledger;
    assert.equal(tl.enabled, true);
    assert.equal(tl.capacity, 500);
    assert.ok(tl.novelty_threshold >= 0 && tl.novelty_threshold <= 1);
});

// ============================================
// Cross-module consistency
// ============================================

test('createTaskLedger respects CODER_V1.task_ledger.capacity when forwarded', () => {
    const led = createTaskLedger({
        taskId: 't',
        surface: CODER_V1.name,
        capacity: CODER_V1.task_ledger.capacity,
    });
    assert.equal(led.capacity, 500);
    assert.equal(led.surface, 'coder.v1');
});

test('isProfile rejects a partial CODER_V1 (sanity — guard actually checks)', () => {
    const broken = { ...CODER_V1, retrieval: undefined };
    assert.equal(isProfile(broken), false);
});
