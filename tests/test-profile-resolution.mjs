/**
 * Tests for the trimmed `coder.v1` ↔ `chat.v1` inheritance landed in 1.14.1.
 *
 * The 1.14.1 slice trimmed five fields from `coder.v1` that match `chat.v1`
 * (`budget.total_tokens`, `budget.system_reserve`, `budget.history_reserve`,
 * `retrieval.chunkers`, `retrieval.metadata_extensions`) and pointed
 * `coder.v1.base` at `chat.v1`. This file is the **proof** that subsequent
 * slices (1.16 compression, 1.17 memory, 1.18 tools, 1.19 retrieval) can
 * rely on resolution being sound: `resolveProfile(CODER_V1, lookup)` is
 * field-for-field equivalent to the pre-trim coder.v1 literal, modulo the
 * intentional `base: null` → `'chat.v1'` flip.
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveProfile,
    resolveMemoryConfig,
    CODER_V1,
    CHAT_V1,
    isProfile,
} from '../js/profiles/index.js';

/**
 * Frozen snapshot of `coder.v1` as it stood pre-trim (i.e. the literal in
 * `js/profiles/coder-v1.js` immediately before the 1.14.1 trim). Every
 * field — including the five that now inherit and the `base: null` that
 * now reads `'chat.v1'` — is preserved verbatim. The equivalence test
 * compares the resolved trimmed profile against this snapshot.
 *
 * Sourced from the 1.14.0 commit's `coder-v1.js` (commit `17c8e35`). Do
 * not "fix" drift here without a corresponding update to `coder-v1.js` —
 * the whole point of this snapshot is that it is frozen.
 */
const CODER_V1_PRE_TRIM = {
    name: 'coder.v1',
    version: '1',
    base: null,

    budget: {
        total_tokens: 32000,
        system_reserve: 2000,
        output_reserve: 8000,
        history_reserve: 8000,
        memory_reserve: 1500,
    },

    retrieval: {
        collections: ['workspace_code', 'workspace_docs', 'recent_tool_results'],
        memory_collections: ['session'],
        strategy_weights: {
            semantic: 1.0,
            structural: 0.0,
            thematic: 0.0,
        },
        chunkers: [],
        metadata_extensions: [],
        novelty_threshold: 0.3,
    },

    memory: {
        default_scope: 'session',
        propose_after_n_turns: null,
        capacity_warnings: {
            session: 20,
        },
    },

    compression: {
        rules: [
            { name: 'subsumption',   priority: 10 },
            { name: 'invalidation',  priority: 20 },
            { name: 'summarization', priority: 50 },
        ],
        preserve_recent: 24,
        summarizer: {
            mode: 'balanced',
            promptTemplate: null,
            modelOverride: null,
        },
    },

    tools: {
        catalog: [],
        static: [
            'list_tool_categories',
            'list_tools_by_category',
            'find_tool',
            'scratchpad_write',
            'scratchpad_read',
            'scratchpad_clear',
            'todo_write',
            'todo_read',
            'ask_user',
            'submit_plan_for_approval',
            // 1.16.0 — LLM-authored automation Phase 1 (DESIGN-llm-authored-automation.md).
            'submit_script_for_approval',
            'read_file',
            'read_lines',
            'scan_file',
            'edit_file',
            'commit_files',
            'list_dirty_files',
            'get_ci_status',
            'wait_for_ci',
            'get_ci_logs',
        ],
        discovery_strategies: ['categorical'],
        budget_tokens: 5000,
        expansion_mode: 'short',
    },

    task_ledger: {
        enabled: true,
        capacity: 500,
        novelty_threshold: 0.3,
    },

    // 1.16.0 — LLM-authored automation Phase 1. Coder is the value-case
    // surface (chat.v1 has `enabled: false`). The snapshot mirrors the
    // post-resolution shape: coder's `enabled: true` overrides chat's
    // `enabled: false`; timeout/cap are coder's own (matching defaults).
    scriptAutomation: {
        enabled: true,
        timeout_ms: 30000,
        max_output_bytes: 262144,
    },
};

/**
 * @param {Array<{name: string}>} profiles
 */
function lookupOver(profiles) {
    const map = new Map(profiles.map(p => [p.name, p]));
    return /** @param {string} n */ (n) => map.get(n) || null;
}

// ============================================
// Equivalence — the load-bearing test
// ============================================

test('resolveProfile(CODER_V1, lookup) ≡ pre-trim coder.v1 (modulo base)', () => {
    const resolved = resolveProfile(CODER_V1, lookupOver([CHAT_V1]));

    // The one legitimate diff: trimmed `coder.v1` declares `base: 'chat.v1'`,
    // pre-trim declared `base: null`. Resolution preserves the leaf's `base`
    // (the leaf-wins fold), so the resolved profile carries `'chat.v1'`.
    assert.equal(resolved.base, 'chat.v1');
    assert.equal(CODER_V1_PRE_TRIM.base, null);

    // Every other field — slice by slice — must match the pre-trim snapshot.
    const { base: _resolvedBase, ...resolvedRest } = resolved;
    const { base: _snapshotBase, ...snapshotRest } = CODER_V1_PRE_TRIM;
    assert.deepEqual(resolvedRest, snapshotRest);
});

test('resolved coder profile satisfies isProfile', () => {
    const resolved = resolveProfile(CODER_V1, lookupOver([CHAT_V1]));
    assert.equal(isProfile(resolved), true);
});

// ============================================
// Trimmed-shape sanity — guards against regression
// ============================================

test('CODER_V1 declares base: "chat.v1" (post-trim)', () => {
    assert.equal(CODER_V1.base, 'chat.v1');
});

test('CODER_V1.budget no longer carries fields inherited from chat.v1', () => {
    // These five keys are exactly what 1.14.1 trimmed. If any reappears
    // here, a future change is silently re-duplicating a base value.
    assert.equal(CODER_V1.budget.total_tokens, undefined);
    assert.equal(CODER_V1.budget.system_reserve, undefined);
    assert.equal(CODER_V1.budget.history_reserve, undefined);
    // Overrides stay:
    assert.equal(CODER_V1.budget.output_reserve, 8000);
    assert.equal(CODER_V1.budget.memory_reserve, 1500);
});

test('CODER_V1.retrieval no longer carries chunkers / metadata_extensions', () => {
    assert.equal(CODER_V1.retrieval.chunkers, undefined);
    assert.equal(CODER_V1.retrieval.metadata_extensions, undefined);
    // Overrides stay:
    assert.equal(CODER_V1.retrieval.novelty_threshold, 0.3);
    assert.deepEqual(CODER_V1.retrieval.memory_collections, ['session']);
});

// ============================================
// Resolved values land where consumers expect them
// ============================================

test('resolved budget reconstructs the chat.v1-derived defaults', () => {
    const resolved = resolveProfile(CODER_V1, lookupOver([CHAT_V1]));
    const b = resolved.budget;
    assert.equal(b.total_tokens, 32000);
    assert.equal(b.system_reserve, 2000);
    assert.equal(b.output_reserve, 8000);   // coder override
    assert.equal(b.history_reserve, 8000);
    assert.equal(b.memory_reserve, 1500);   // coder override
    const residual = b.total_tokens - (b.system_reserve + b.output_reserve + b.history_reserve + b.memory_reserve);
    assert.equal(residual, 12500);
});

test('resolved retrieval keeps coder collections + inherited empty chunker arrays', () => {
    const resolved = resolveProfile(CODER_V1, lookupOver([CHAT_V1]));
    const r = resolved.retrieval;
    // Coder overrides — full array replacement:
    assert.deepEqual(r.collections, ['workspace_code', 'workspace_docs', 'recent_tool_results']);
    assert.deepEqual(r.memory_collections, ['session']);
    // Inherited from chat.v1 (still empty until 1.5.0 ingest pipeline):
    assert.deepEqual(r.chunkers, []);
    assert.deepEqual(r.metadata_extensions, []);
});

// ============================================
// 1.18.0 — resolveMemoryConfig
// ============================================

test('resolveMemoryConfig(coder.v1) returns coder profile data verbatim', () => {
    const cfg = resolveMemoryConfig('coder.v1');
    // Coder's `default_scope: 'session'` is intentionally outside MEMORY_SCOPES
    // (it describes scratchpad, not the memory store). Tool-side defaulting
    // handles the clamp; the resolver must not mutate the data.
    assert.equal(cfg.default_scope, 'session');
    assert.equal(cfg.propose_after_n_turns, null);
    assert.deepEqual(cfg.capacity_warnings, { session: 20 });
    assert.equal(cfg.profileName, 'coder.v1');
});

test('resolveMemoryConfig(chat.v1) returns chat-baseline values', () => {
    const cfg = resolveMemoryConfig('chat.v1');
    // chat.v1 is the design-intended memory-store consumer: `'user'` scope.
    assert.equal(cfg.default_scope, 'user');
    assert.equal(cfg.propose_after_n_turns, null);
    assert.deepEqual(cfg.capacity_warnings, {});
    assert.equal(cfg.profileName, 'chat.v1');
});

test('resolveMemoryConfig falls back to chat.v1 on unknown profile name', () => {
    const cfg = resolveMemoryConfig('nonexistent.v9');
    assert.equal(cfg.profileName, 'chat.v1');
    assert.equal(cfg.default_scope, 'user');
});

test('resolveMemoryConfig falls back to chat.v1 on null/undefined', () => {
    assert.equal(resolveMemoryConfig(null).profileName, 'chat.v1');
    assert.equal(resolveMemoryConfig(undefined).profileName, 'chat.v1');
});
