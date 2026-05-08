/**
 * Tests for js/profiles/inheritance.js — `resolveProfile(profile, lookup)`
 * deep-merge helper (1.14.0).
 *
 * Runs under `node --test`. Pure logic; no DOM/Storage/fetch. The helper
 * accepts a caller-supplied `lookup` so tests use an in-test map instead
 * of a real registry (no registry exists yet).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProfile, CHAT_V1 } from '../js/profiles/index.js';

/**
 * Build a lookup over a list of profiles keyed by name.
 * @param {Array<{name: string}>} profiles
 */
function lookupOver(profiles) {
    const map = new Map(profiles.map(p => [p.name, p]));
    return /** @param {string} n */ (n) => map.get(n) || null;
}

// ============================================
// Happy path
// ============================================

test('null base returns the input unchanged (structurally equal)', () => {
    const out = resolveProfile(CHAT_V1, lookupOver([]));
    assert.deepEqual(out, CHAT_V1);
});

test('null base returns a fresh object (input not mutated)', () => {
    const out = resolveProfile(CHAT_V1, lookupOver([]));
    assert.notEqual(out, CHAT_V1, 'expected a new object reference');
    out.name = 'mutated';
    assert.equal(CHAT_V1.name, 'chat.v1', 'input must be untouched');
});

test('happy path: leaf override wins, base fills in gaps', () => {
    const leaf = {
        name: 'custom.v1',
        version: '1',
        base: 'chat.v1',
        compression: { preserve_recent: 24 }, // override only this one field
    };
    const out = resolveProfile(/** @type {any} */ (leaf), lookupOver([CHAT_V1]));
    // Override wins:
    assert.equal(out.compression.preserve_recent, 24);
    // Un-overridden compression fields come from chat.v1:
    assert.equal(out.compression.rules.length, 1);
    assert.equal(out.compression.rules[0].name, 'summarization');
    assert.equal(out.compression.summarizer.mode, 'balanced');
    // Top-level identity is the leaf's:
    assert.equal(out.name, 'custom.v1');
    assert.equal(out.base, 'chat.v1');
    // Untouched slices come whole-cloth from the base:
    assert.deepEqual(out.retrieval.collections, ['attached_docs']);
    assert.equal(out.memory.default_scope, 'user');
    assert.equal(out.task_ledger.capacity, 100);
});

test('object deep-merge: budget overrides only the named keys', () => {
    const leaf = {
        name: 'budget-tweak.v1',
        version: '1',
        base: 'chat.v1',
        budget: { output_reserve: 8000 }, // override one field; rest from chat
    };
    const out = resolveProfile(/** @type {any} */ (leaf), lookupOver([CHAT_V1]));
    assert.equal(out.budget.output_reserve, 8000);
    // Others from base:
    assert.equal(out.budget.total_tokens, 32000);
    assert.equal(out.budget.system_reserve, 2000);
    assert.equal(out.budget.history_reserve, 8000);
    assert.equal(out.budget.memory_reserve, 2000);
});

test('arrays in override fully replace base arrays (no concatenation)', () => {
    const leaf = {
        name: 'tools-override.v1',
        version: '1',
        base: 'chat.v1',
        tools: { static: ['read_file', 'edit_file'] }, // replaces ['ask_user']
    };
    const out = resolveProfile(/** @type {any} */ (leaf), lookupOver([CHAT_V1]));
    assert.deepEqual(out.tools.static, ['read_file', 'edit_file']);
    // Sibling keys still come from base:
    assert.deepEqual(out.tools.catalog, []);
    assert.equal(out.tools.budget_tokens, 5000);
});

test('null override values replace base values (treated as primitive)', () => {
    const leaf = {
        name: 'no-summarizer.v1',
        version: '1',
        base: 'chat.v1',
        compression: { summarizer: null }, // explicit null disables summarizer
    };
    const out = resolveProfile(/** @type {any} */ (leaf), lookupOver([CHAT_V1]));
    assert.equal(out.compression.summarizer, null);
    // Other compression fields still merged from base:
    assert.equal(out.compression.preserve_recent, 4);
});

test('undefined override values do NOT erase base values', () => {
    const leaf = {
        name: 'noop.v1',
        version: '1',
        base: 'chat.v1',
        compression: { summarizer: undefined },
    };
    const out = resolveProfile(/** @type {any} */ (leaf), lookupOver([CHAT_V1]));
    assert.ok(out.compression.summarizer);
    assert.equal(out.compression.summarizer.mode, 'balanced');
});

// ============================================
// Failure modes (DESIGN-profiles.md §"Failure Modes")
// ============================================

test('throws on cycle in the base chain', () => {
    const a = { name: 'a.v1', version: '1', base: 'b.v1' };
    const b = { name: 'b.v1', version: '1', base: 'a.v1' };
    const lookup = lookupOver([/** @type {any} */ (a), /** @type {any} */ (b)]);
    assert.throws(
        () => resolveProfile(/** @type {any} */ (a), lookup),
        /cycle detected/,
    );
});

test('throws on self-cycle (profile names itself as base)', () => {
    const a = { name: 'self.v1', version: '1', base: 'self.v1' };
    const lookup = lookupOver([/** @type {any} */ (a)]);
    assert.throws(
        () => resolveProfile(/** @type {any} */ (a), lookup),
        /cycle detected/,
    );
});

test('throws on unknown base name', () => {
    const leaf = { name: 'orphan.v1', version: '1', base: 'nonexistent.v1' };
    assert.throws(
        () => resolveProfile(/** @type {any} */ (leaf), lookupOver([])),
        /unknown base profile 'nonexistent\.v1'/,
    );
});

test('throws on non-string base value', () => {
    const leaf = { name: 'bad.v1', version: '1', base: 42 };
    assert.throws(
        () => resolveProfile(/** @type {any} */ (leaf), lookupOver([])),
        /non-string base/,
    );
});

test('throws on missing/empty profile name in chain', () => {
    const leaf = { name: '', version: '1', base: null };
    assert.throws(
        () => resolveProfile(/** @type {any} */ (leaf), lookupOver([])),
        /must declare a string `name`/,
    );
});

test('throws on non-object profile input', () => {
    assert.throws(() => resolveProfile(/** @type {any} */ (null), lookupOver([])), TypeError);
    assert.throws(() => resolveProfile(/** @type {any} */ ('chat.v1'), lookupOver([])), TypeError);
});

test('throws when lookup is not a function', () => {
    assert.throws(
        () => resolveProfile(CHAT_V1, /** @type {any} */ (null)),
        TypeError,
    );
});

// ============================================
// Multi-level chain
// ============================================

test('resolves a three-level chain (leaf -> mid -> root)', () => {
    const root = {
        name: 'root.v1',
        version: '1',
        base: null,
        budget: { total_tokens: 32000, system_reserve: 1000, output_reserve: 1000, history_reserve: 1000, memory_reserve: 1000 },
        compression: { rules: [{ name: 'summarization', priority: 50 }], preserve_recent: 4, summarizer: { mode: 'balanced', promptTemplate: null, modelOverride: null } },
    };
    const mid = {
        name: 'mid.v1',
        version: '1',
        base: 'root.v1',
        compression: { preserve_recent: 8 }, // override at mid level
    };
    const leaf = {
        name: 'leaf.v1',
        version: '1',
        base: 'mid.v1',
        budget: { output_reserve: 4000 }, // override at leaf level
    };
    const out = resolveProfile(
        /** @type {any} */ (leaf),
        lookupOver([/** @type {any} */ (root), /** @type {any} */ (mid)]),
    );
    // Leaf wins for budget.output_reserve:
    assert.equal(out.budget.output_reserve, 4000);
    // Root fills in the rest of budget:
    assert.equal(out.budget.total_tokens, 32000);
    assert.equal(out.budget.system_reserve, 1000);
    // Mid wins for preserve_recent:
    assert.equal(out.compression.preserve_recent, 8);
    // Root's rules array survives (mid doesn't override it):
    assert.equal(out.compression.rules.length, 1);
    // Top-level identity is the leaf's:
    assert.equal(out.name, 'leaf.v1');
    assert.equal(out.base, 'mid.v1');
});
