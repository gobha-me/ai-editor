/**
 * Pure-data tests for js/profiles/chat-v1.js — the chat.v1 profile object
 * that lands in 1.14.0 alongside the resolveProfile inheritance helper.
 *
 * Mirrors the structure of tests/test-profiles.mjs (CODER_V1 conformance).
 * No DOM, no Storage, no fetch — runs under `node --test`.
 *
 * Source of values: docs/DESIGN-profiles.md §"Canonical Profiles" → chat.v1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_V1, isProfile } from '../js/profiles/index.js';

// ============================================
// CHAT_V1 — shape conformance
// ============================================

test('CHAT_V1 satisfies isProfile', () => {
    assert.equal(isProfile(CHAT_V1), true);
});

test('CHAT_V1 declares the canonical name and version', () => {
    assert.equal(CHAT_V1.name, 'chat.v1');
    assert.equal(CHAT_V1.version, '1');
    // chat.v1 IS the base — DESIGN-profiles.md line 237.
    assert.equal(CHAT_V1.base, null);
});

test('CHAT_V1 budget shape matches DESIGN-profiles.md 32K reference window', () => {
    // chat.v1 row: 32000 / 2000 / 4000 / 8000 / 2000 → retrieval = 16000.
    const b = CHAT_V1.budget;
    assert.equal(b.total_tokens, 32000);
    assert.equal(b.system_reserve, 2000);
    assert.equal(b.output_reserve, 4000);
    assert.equal(b.history_reserve, 8000);
    assert.equal(b.memory_reserve, 2000);
    const residual = b.total_tokens - (b.system_reserve + b.output_reserve + b.history_reserve + b.memory_reserve);
    assert.equal(residual, 16000, `expected retrieval residual 16000, got ${residual}`);
});

test('CHAT_V1 retrieval mirrors design row (attached_docs only, semantic+structural)', () => {
    const r = CHAT_V1.retrieval;
    assert.deepEqual(r.collections, ['attached_docs']);
    assert.deepEqual(r.memory_collections, ['user', 'persona']);
    assert.equal(r.strategy_weights.semantic, 1.0);
    assert.equal(r.strategy_weights.structural, 0.5);
    assert.equal(r.strategy_weights.thematic, 0.0);
    assert.deepEqual(r.chunkers, []);
    assert.deepEqual(r.metadata_extensions, []);
    assert.ok(r.novelty_threshold >= 0 && r.novelty_threshold <= 1);
});

test('CHAT_V1 memory default scope is "user" (chat baseline)', () => {
    assert.equal(CHAT_V1.memory.default_scope, 'user');
    assert.equal(CHAT_V1.memory.propose_after_n_turns, null);
    assert.deepEqual(CHAT_V1.memory.capacity_warnings, {});
});

test('CHAT_V1 compression registers Rule 5 only with preserve_recent=4', () => {
    const c = CHAT_V1.compression;
    assert.equal(c.rules.length, 1);
    assert.equal(c.rules[0].name, 'summarization');
    assert.equal(c.rules[0].priority, 50);
    // DESIGN-profiles.md §chat.v1 row: preserve_recent: 4. (Note this is
    // the design target; the existing rule5_only_shim in resolve.js still
    // returns 24 for non-coder roles and is not changed by this slice.)
    assert.equal(c.preserve_recent, 4);
    assert.ok(c.summarizer);
    assert.equal(c.summarizer.mode, 'balanced');
    assert.equal(c.summarizer.promptTemplate, null);
    assert.equal(c.summarizer.modelOverride, null);
});

test('CHAT_V1 tools.static is the minimal chat baseline (ask_user only)', () => {
    // Coder.v1 layers all the file/CI/scratchpad/todo/plan-mode tools on
    // top via override. Chat.v1 keeps only ask_user since cheap-tier
    // models won't reliably discover an interaction tool through the
    // categorical meta-tools (same load-bearing case as the 1.9.0 promotion
    // in coder-v1.js).
    assert.deepEqual(CHAT_V1.tools.static, ['ask_user']);
    assert.deepEqual(CHAT_V1.tools.catalog, []);
    assert.deepEqual(CHAT_V1.tools.discovery_strategies, ['categorical']);
    assert.equal(CHAT_V1.tools.budget_tokens, 5000);
    assert.equal(CHAT_V1.tools.expansion_mode, 'short');
});

test('CHAT_V1 task_ledger config matches DESIGN-profiles.md "chat.v1" row', () => {
    const tl = CHAT_V1.task_ledger;
    assert.equal(tl.enabled, true);
    assert.equal(tl.capacity, 100); // DESIGN: "Task ledger enabled, 100-record cap".
    assert.ok(tl.novelty_threshold >= 0 && tl.novelty_threshold <= 1);
});

// ============================================
// Cross-profile sanity
// ============================================

test('CHAT_V1 and CODER_V1 are distinct profile objects with distinct names', async () => {
    const { CODER_V1 } = await import('../js/profiles/index.js');
    assert.notEqual(CHAT_V1.name, CODER_V1.name);
    assert.notEqual(CHAT_V1, CODER_V1);
    // Coder is more aggressive (higher retrieval-budget output, lower preserve_recent... actually higher 24)
    // — sanity-check the obvious overrides are different on the two:
    assert.notEqual(CHAT_V1.budget.output_reserve, CODER_V1.budget.output_reserve);
    assert.notEqual(CHAT_V1.compression.preserve_recent, CODER_V1.compression.preserve_recent);
    assert.notEqual(CHAT_V1.memory.default_scope, CODER_V1.memory.default_scope);
});
