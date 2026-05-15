/**
 * Tests for `ToolRegistry.executeWithProfile` — the explicit-profile
 * entry-point added at 2.49.0.0 (slice 1 of github#24 Phase 1) so the
 * sub-agent tool loop (slice 2) can gate against `subagent.v1` instead
 * of the conversation-bound profile.
 *
 * 2.54.0 (gitea#438) — admission inverted from tool-side `roles:` tags
 * to profile-side `tools.admit` name lists. The test now registers fake
 * tools under names that production profile admit lists already contain
 * (or deliberately omit) — the fakes' handlers run when admitted and
 * are blocked when not.
 *
 * Fixture naming map (vs. production profile admit lists):
 *   - `read_file`      → admitted by every picker profile + subagent.v1.
 *   - `commit_files`   → admitted only by coder.v1 (not chat.v1, kb.v1,
 *                        subagent.v1, pm.v1, reviewer.v1, plugin-dev.v1).
 *   - `delegate_task`  → admitted by chat.v1 / coder.v1 / kb.v1 /
 *                        plugin-dev.v1 / pm.v1 / reviewer.v1; NOT by
 *                        subagent.v1 (no recursion in slice 2).
 *
 * Pins:
 *   - Profile-gate cases against the registered fake handlers under each
 *     name above.
 *   - Equivalence with `execute(name, args)`: byte-equal envelope when
 *     `executeWithProfile(name, args, ConversationManager.getEffectiveProfileName())`.
 *   - Error-envelope identity (the per-profile reason string includes
 *     the gated profile name, distinguishing the two paths in logs).
 *   - The new `checkRoleAccessForProfile` mirrors `checkRoleAccess` when
 *     called with the active profile name.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../js/tools/registry.js';
import { ConversationManager } from '../js/chat/conversations.js';

// ============================================
// Fixture — register fake handlers under names production profile admit
// lists already gate. The handlers don't do real work; they return a
// marker so we know the fake (not a leaked production handler) ran.
// ============================================

function makeHandler(returnValue) {
    return async (args) => ({ ok: true, args, _from: returnValue });
}

function registerFakes() {
    ToolRegistry.clear();
    // Admitted by every picker profile + subagent.v1.
    ToolRegistry.register('read_file', makeHandler('all'), {
        function: {
            name: 'read_file',
            description: 'Test fake — production admits everywhere.',
            parameters: { type: 'object', properties: {} },
        },
    });
    // Admitted ONLY by coder.v1.
    ToolRegistry.register('commit_files', makeHandler('coder'), {
        function: {
            name: 'commit_files',
            description: 'Test fake — production admits coder.v1 only.',
            parameters: { type: 'object', properties: {} },
        },
    });
    // Admitted by every picker profile EXCEPT subagent.v1 (trust boundary).
    ToolRegistry.register('delegate_task', makeHandler('not-subagent'), {
        function: {
            name: 'delegate_task',
            description: 'Test fake — production admits everywhere except subagent.v1.',
            parameters: { type: 'object', properties: {} },
        },
    });
}

// ============================================
// Tests
// ============================================

test('executeWithProfile: subagent.v1 admits read_file', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('read_file', { x: 1 }, 'subagent.v1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { x: 1 });
});

test('executeWithProfile: subagent.v1 BLOCKS delegate_task with profile-specific reason', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('delegate_task', {}, 'subagent.v1');
    assert.ok(typeof r.error === 'string');
    assert.match(r.error, /Profile 'subagent\.v1' is not permitted/);
    assert.match(r.error, /delegate_task/);
});

test('executeWithProfile: subagent.v1 BLOCKS commit_files (coder-only)', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('commit_files', {}, 'subagent.v1');
    assert.ok(typeof r.error === 'string');
    assert.match(r.error, /Profile 'subagent\.v1' is not permitted/);
});

test('executeWithProfile: every profile admits read_file', async () => {
    registerFakes();
    for (const profile of [
        'chat.v1', 'coder.v1', 'kb.v1', 'subagent.v1',
        'full.v1', 'plugin-dev.v1', 'pm.v1', 'reviewer.v1',
    ]) {
        const r = await ToolRegistry.executeWithProfile('read_file', {}, profile);
        assert.equal(r.ok, true, `profile=${profile} expected to admit read_file`);
    }
});

test('executeWithProfile: unknown tool returns "Unknown tool" envelope regardless of profile', async () => {
    registerFakes();
    const r = await ToolRegistry.executeWithProfile('does_not_exist', {}, 'subagent.v1');
    assert.match(r.error, /^Unknown tool/);
});

test('executeWithProfile: handler-thrown errors flow through the same error wrapper', async () => {
    ToolRegistry.clear();
    // Use a name in chat.v1.admit so the gate passes and the handler runs.
    ToolRegistry.register('read_file', async () => { throw new Error('boom'); }, {
        function: { name: 'read_file', description: 't', parameters: { type: 'object', properties: {} } },
    });
    const r = await ToolRegistry.executeWithProfile('read_file', {}, 'chat.v1');
    assert.match(r.error, /read_file.*failed.*boom/);
});

test('execute(name,args) ≡ executeWithProfile(name,args, getEffectiveProfileName())', async () => {
    // The equivalence pin: the convenience entry-point must produce
    // byte-identical envelopes when invoked with the active profile.
    // This is the load-bearing guarantee that the slice-1 refactor did
    // not change `execute`'s contract.
    registerFakes();
    const activeProfile = ConversationManager.getEffectiveProfileName();
    for (const tool of ['read_file', 'commit_files', 'delegate_task', 'does_not_exist']) {
        const viaExecute = await ToolRegistry.execute(tool, { p: 42 });
        const viaProfile = await ToolRegistry.executeWithProfile(tool, { p: 42 }, activeProfile);
        assert.deepEqual(viaExecute, viaProfile, `divergence on tool=${tool}, profile=${activeProfile}`);
    }
});

test('checkRoleAccess(name) ≡ checkRoleAccessForProfile(name, getEffectiveProfileName())', () => {
    registerFakes();
    const activeProfile = ConversationManager.getEffectiveProfileName();
    for (const tool of ['read_file', 'commit_files', 'delegate_task', 'does_not_exist']) {
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
