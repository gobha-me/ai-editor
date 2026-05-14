/**
 * Tests for `ToolRegistry.executeWithProfile` — the explicit-profile
 * entry-point added at 2.49.0.0 (slice 1 of github#24 Phase 1) so the
 * sub-agent tool loop (slice 2) can gate against `subagent.v1` instead
 * of the conversation-bound profile.
 *
 * Pins:
 *   - Profile-gate cases against a registered fake tool tagged
 *     `'subagent'` / `'coder'` / `'all'`.
 *   - Equivalence with `execute(name, args)`: byte-equal envelope when
 *     `executeWithProfile(name, args, ConversationManager.getEffectiveProfileName())`.
 *   - Error-envelope identity (the per-profile reason string includes
 *     the gated profile name, distinguishing the two paths in logs).
 *   - The new `checkRoleAccessForProfile` mirrors `checkRoleAccess` when
 *     called with the active profile name.
 *
 * Verifies the pinning surface called out in the 2.49.0.0 plan: this is
 * a *new* pinning slot because `checkRoleAccess` was previously tested
 * only indirectly via `tests/test-profile-filter-tools.mjs` (which pins
 * the filter, not the execute gate).
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../js/tools/registry.js';
import { ConversationManager } from '../js/chat/conversations.js';

// ============================================
// Fixture — register three fake tools with distinct admission tags.
// ============================================

function makeHandler(returnValue) {
    return async (args) => ({ ok: true, args, _from: returnValue });
}

function registerFakes() {
    ToolRegistry.clear();
    ToolRegistry.register('fake_all_tool', makeHandler('all'), {
        function: {
            name: 'fake_all_tool',
            description: 'Test tool admitted by every profile.',
            parameters: { type: 'object', properties: {} },
        },
        roles: 'all',
    });
    ToolRegistry.register('fake_coder_tool', makeHandler('coder'), {
        function: {
            name: 'fake_coder_tool',
            description: 'Test tool admitted only by coder-shaped profiles.',
            parameters: { type: 'object', properties: {} },
        },
        // 'reviewer' is a known group tag from the SYNTHETIC_ENTRIES set —
        // we use coder's allowed_groups indirectly by tagging the tool
        // with a tag coder declares. Coder admits via 'all' + 'coder'
        // and pm/reviewer specifics; easiest is to tag with 'pm' which
        // is in pm.v1.tools.allowed_groups, then verify chat.v1 (which
        // declares 'all' / 'pm' / 'reviewer') admits it too. To get a
        // tool that ONLY admits to coder, we can use a tag coder
        // uniquely declares — but coder doesn't have a unique tag.
        // Workaround: use 'coder' itself — it's a legal tag inherited
        // through profile.tools.allowed_groups; coder.v1 declares it
        // and chat.v1 does NOT.
        //
        // (Verified by reading js/profiles/{chat,coder}-v1.js — chat
        // has ['all','pm','reviewer'], coder has the coder-specific
        // tags. The exact tags vary; we accept whatever profile-side
        // configuration the actual chat/coder profiles produce, and
        // assert based on observed admission.)
        roles: ['coder'],
    });
    ToolRegistry.register('fake_subagent_tool', makeHandler('subagent'), {
        function: {
            name: 'fake_subagent_tool',
            description: 'Test tool admitted only by sub-agent profiles.',
            parameters: { type: 'object', properties: {} },
        },
        // 2.49.0.0 — `'subagent'` is the new admission tag declared by
        // subagent.v1.tools.allowed_groups. No other registered
        // profile declares it.
        roles: ['subagent'],
    });
}

// ============================================
// Tests
// ============================================

test('executeWithProfile: subagent.v1 admits fake_subagent_tool', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('fake_subagent_tool', { x: 1 }, 'subagent.v1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { x: 1 });
});

test('executeWithProfile: chat.v1 BLOCKS fake_subagent_tool with profile-specific reason', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('fake_subagent_tool', {}, 'chat.v1');
    assert.ok(typeof r.error === 'string');
    assert.match(r.error, /Profile 'chat\.v1' is not permitted/);
    assert.match(r.error, /fake_subagent_tool/);
});

test('executeWithProfile: subagent.v1 BLOCKS fake_coder_tool (coder-tagged)', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('fake_coder_tool', {}, 'subagent.v1');
    assert.ok(typeof r.error === 'string');
    assert.match(r.error, /Profile 'subagent\.v1' is not permitted/);
});

test('executeWithProfile: every profile admits fake_all_tool (roles: "all")', async () => {
    registerFakes();
    for (const profile of [
        'chat.v1', 'coder.v1', 'kb.v1', 'subagent.v1',
        'full.v1', 'plugin-dev.v1', 'pm.v1', 'reviewer.v1',
    ]) {
        const r = await ToolRegistry.executeWithProfile('fake_all_tool', {}, profile);
        assert.equal(r.ok, true, `profile=${profile} expected to admit fake_all_tool`);
    }
});

test('executeWithProfile: unknown tool returns "Unknown tool" envelope regardless of profile', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('does_not_exist', {}, 'subagent.v1');
    assert.match(r.error, /^Unknown tool/);
});

test('executeWithProfile: handler-thrown errors flow through the same error wrapper', async () => {
    ToolRegistry.clear();
    ToolRegistry.register('fake_throws', async () => { throw new Error('boom'); }, {
        function: { name: 'fake_throws', description: 't', parameters: { type: 'object', properties: {} } },
        roles: 'all',
    });
    const r = await ToolRegistry.executeWithProfile('fake_throws', {}, 'chat.v1');
    assert.match(r.error, /fake_throws.*failed.*boom/);
});

test('execute(name,args) ≡ executeWithProfile(name,args, getEffectiveProfileName())', async () => {
    // The equivalence pin: the convenience entry-point must produce
    // byte-identical envelopes when invoked with the active profile.
    // This is the load-bearing guarantee that the slice-1 refactor did
    // not change `execute`'s contract.
    registerFakes();
    const activeProfile = ConversationManager.getEffectiveProfileName();
    for (const tool of ['fake_all_tool', 'fake_coder_tool', 'fake_subagent_tool', 'does_not_exist']) {
        const viaExecute = await ToolRegistry.execute(tool, { p: 42 });
        const viaProfile = await ToolRegistry.executeWithProfile(tool, { p: 42 }, activeProfile);
        assert.deepEqual(viaExecute, viaProfile, `divergence on tool=${tool}, profile=${activeProfile}`);
    }
});

test('checkRoleAccess(name) ≡ checkRoleAccessForProfile(name, getEffectiveProfileName())', () => {
    registerFakes();
    const activeProfile = ConversationManager.getEffectiveProfileName();
    for (const tool of ['fake_all_tool', 'fake_coder_tool', 'fake_subagent_tool', 'does_not_exist']) {
        const viaActive = ToolRegistry.checkRoleAccess(tool);
        const viaProfile = ToolRegistry.checkRoleAccessForProfile(tool, activeProfile);
        assert.deepEqual(viaActive, viaProfile, `divergence on tool=${tool}, profile=${activeProfile}`);
    }
});

test('checkRoleAccessForProfile: unknown tool returns { allowed: true } (defers to execute for not-found)', () => {
    registerFakes();
    const r = ToolRegistry.checkRoleAccessForProfile('does_not_exist', 'subagent.v1');
    assert.deepEqual(r, { allowed: true });
});
