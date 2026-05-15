/**
 * Worked-example inheritance assertions for the Phase 2 profiles
 * (`chat_multi.v1`, `rp.v1`, `kb.v1`) per ROADMAP §"After 2.0.0" line 111
 * — *"Inheritance through one level (base → leaf); per-profile worked-
 * example test fixtures."*
 *
 * Distinct from `test-profiles-inheritance.mjs` (generic `resolveProfile`
 * helper coverage from 1.14.0) and `test-profiles-fixtures.mjs` (byte-
 * exact regression harness from 2.5.0). This file's job is the human-
 * readable inheritance proof for the three new profiles: each leaf
 * inherits its base's fields where it doesn't override, and overrides
 * take precedence where declared. Failures here read as design-spec
 * assertions ("rp.v1 must use the persona memory scope") rather than
 * fixture regen prompts.
 *
 * Runs under `node --test`. Pure logic; no DOM/Storage/fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    Profiles,
    resolveProfile,
} from '../js/profiles/index.js';

const CHAT = resolveProfile(Profiles.get('chat.v1'), Profiles.get);
const CHAT_MULTI = resolveProfile(Profiles.get('chat_multi.v1'), Profiles.get);
const RP = resolveProfile(Profiles.get('rp.v1'), Profiles.get);
const KB = resolveProfile(Profiles.get('kb.v1'), Profiles.get);

test('Phase 2 — three new profiles are registered and resolvable', () => {
    // Lookup via Profiles.has — they're in the registry's BY_NAME map even
    // though excluded from the picker.
    assert.equal(Profiles.has('chat_multi.v1'), true);
    assert.equal(Profiles.has('rp.v1'), true);
    assert.equal(Profiles.has('kb.v1'), true);
});

test('Phase 2 — chat_multi.v1 / rp.v1 stay hidden until they earn systemPrompt addenda; kb.v1 promoted at 2.8.0', () => {
    // Promotion gate: per-profile systemPrompt addenda (mirroring
    // plugin-dev.v1's 1.23.x precedent) need to land before these become
    // user-visible options. `kb.v1` graduated at 2.8.0 carrying its KB-mode
    // addendum (*"answer only from attached docs, cite line ranges, no
    // edits"*). `chat_multi.v1` and `rp.v1` stay in SYNTHETIC_ENTRIES until
    // each earns its own addendum — granular promotion is fine. See
    // SYNTHETIC_ENTRIES rationale in `js/profiles/registry.js` and ROADMAP
    // §"After 2.0.0" → "Profiles Phase 2 picker promotion".
    const names = Profiles.list().map(e => e.name);
    assert.equal(names.includes('chat_multi.v1'), false);
    assert.equal(names.includes('rp.v1'), false);
    assert.equal(names.includes('kb.v1'), true);
    // Picker = chat + coder + kb after 2.8.0.
    assert.deepEqual(names, ['chat.v1', 'coder.v1', 'kb.v1']);
});

test('all three Phase 2 profiles declare base: chat.v1', () => {
    assert.equal(Profiles.get('chat_multi.v1').base, 'chat.v1');
    assert.equal(Profiles.get('rp.v1').base, 'chat.v1');
    assert.equal(Profiles.get('kb.v1').base, 'chat.v1');
});

test('chat_multi.v1 inherits chat.v1 budget block byte-for-byte', () => {
    assert.deepEqual(CHAT_MULTI.budget, CHAT.budget);
});

test('chat_multi.v1 overrides retrieval.collections to add shared_conversation', () => {
    assert.deepEqual(
        CHAT_MULTI.retrieval.collections,
        ['attached_docs', 'shared_conversation'],
    );
});

test('chat_multi.v1 overrides retrieval.memory_collections to add per_speaker', () => {
    assert.deepEqual(
        CHAT_MULTI.retrieval.memory_collections,
        ['user', 'persona', 'per_speaker'],
    );
});

test('chat_multi.v1 inherits chat.v1 strategy_weights (no override)', () => {
    assert.deepEqual(CHAT_MULTI.retrieval.strategy_weights, CHAT.retrieval.strategy_weights);
});

test('chat_multi.v1 inherits chat.v1 compression block (Rule 5 only, preserve_recent: 4)', () => {
    assert.deepEqual(CHAT_MULTI.compression, CHAT.compression);
});

test('rp.v1 inherits chat.v1 budget block byte-for-byte', () => {
    assert.deepEqual(RP.budget, CHAT.budget);
});

test('rp.v1 overrides retrieval.collections to add lore (per-world)', () => {
    assert.deepEqual(RP.retrieval.collections, ['attached_docs', 'lore']);
});

test('rp.v1 overrides retrieval.memory_collections to add per_persona', () => {
    assert.deepEqual(RP.retrieval.memory_collections, ['user', 'persona', 'per_persona']);
});

test('rp.v1 overrides retrieval.strategy_weights (structural: 0.8, thematic: 0.3)', () => {
    assert.deepEqual(RP.retrieval.strategy_weights, { semantic: 1.0, structural: 0.8, thematic: 0.3 });
});

test('rp.v1 overrides memory.default_scope to persona', () => {
    assert.equal(RP.memory.default_scope, 'persona');
    assert.equal(RP.memory.propose_after_n_turns, CHAT.memory.propose_after_n_turns);
    assert.deepEqual(RP.memory.capacity_warnings, CHAT.memory.capacity_warnings);
});

test('rp.v1 overrides compression.preserve_recent to 8 (preserve in-character continuity)', () => {
    assert.equal(RP.compression.preserve_recent, 8);
    // Rule 4 (Resolution) and the voice-preserving Rule 5 prompt are
    // deferred per `js/profiles/rp-v1.js` header — rules array stays
    // inherited from chat.v1 (Rule 5 only) until Rule 4 lands.
    assert.deepEqual(RP.compression.rules, CHAT.compression.rules);
});

test('kb.v1 inherits chat.v1 budget block byte-for-byte', () => {
    assert.deepEqual(KB.budget, CHAT.budget);
});

test('kb.v1 narrows retrieval.collections to kb_documents only', () => {
    assert.deepEqual(KB.retrieval.collections, ['kb_documents']);
});

test('kb.v1 disables memory at the retrieval layer (memory_collections: [])', () => {
    assert.deepEqual(KB.retrieval.memory_collections, []);
});

test('kb.v1 overrides retrieval.strategy_weights (semantic 1.0, structural 0.6, thematic 0.4)', () => {
    assert.deepEqual(KB.retrieval.strategy_weights, { semantic: 1.0, structural: 0.6, thematic: 0.4 });
});

test('kb.v1 disables compression (rules: [])', () => {
    assert.deepEqual(KB.compression.rules, []);
});

test('kb.v1 disables task ledger (enabled: false; capacity inherited)', () => {
    assert.equal(KB.task_ledger.enabled, false);
    assert.equal(KB.task_ledger.capacity, CHAT.task_ledger.capacity);
});

test('kb.v1 narrows tools.admit to drop chat.v1\'s pm/reviewer-tagged additions (gitea#438)', () => {
    // 2.54.0 (gitea#438) — admission inverted from `allowed_groups`
    // (tag-intersection) to `admit` (explicit tool-name list). chat.v1
    // carried `['all', 'pm', 'reviewer']`; kb.v1 narrowed to `['all']`.
    // The post-inversion equivalent: kb.v1.admit must omit every
    // pm-only / reviewer-only tool that chat.v1.admit carries.
    const chatAdmit = new Set(CHAT.tools.admit);
    const kbAdmit = new Set(KB.tools.admit);
    // Every kb-admitted name (except the mcp__* glob, present in both)
    // must also appear in chat.v1.admit — kb is a strict subset modulo
    // the glob and the chat-only pm/reviewer tools.
    for (const name of kbAdmit) {
        assert.ok(chatAdmit.has(name), `kb.v1.admit entry '${name}' must also appear in chat.v1.admit (kb is a chat subset)`);
    }
    // Spot-check the narrowing: pm-only tools chat carries should NOT be in kb.
    for (const pmOnly of ['create_issue', 'update_issue', 'add_pr_review']) {
        assert.ok(chatAdmit.has(pmOnly), `chat.v1.admit must include ${pmOnly} (carries pm/reviewer tools per migration baseline)`);
        assert.ok(!kbAdmit.has(pmOnly), `kb.v1.admit must NOT include ${pmOnly} (narrowed to read-only minimum)`);
    }
    // Other tools fields fall through from chat.v1.
    assert.equal(KB.tools.budget_tokens, CHAT.tools.budget_tokens);
    assert.deepEqual(KB.tools.static, CHAT.tools.static);
});
