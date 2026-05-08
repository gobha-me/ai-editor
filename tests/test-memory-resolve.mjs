/**
 * 1.18.0 — Memory subsystem resolver: Removability proof.
 *
 * The slice replaces a hardcoded literal in `js/tools/memory-tools.js`
 * (`a.scope || 'workspace'`) with a profile-keyed lookup
 * (`a.scope || resolveDefaultRememberScope(role)`). Per ROADMAP
 * §Decisions 7 "Removability check," the rewire's exit criterion is
 * **zero behavior diff** against the pre-slice literal for the role
 * that actually exercises memory tools (coder).
 *
 * That's exactly what this file proves.
 * `resolveDefaultRememberScope('coder')` must return `'workspace'` —
 * identical to the literal — because
 * `coder.v1.memory.default_scope === 'session'` falls outside
 * `MEMORY_SCOPES` and the helper clamps invalid scopes back to
 * `'workspace'`. For chat surfaces (which don't have memory tools
 * exposed today), the helper returns `'user'` as `chat.v1` declares —
 * forward-looking when chat surfaces gain memory tools in a later
 * slice.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`. Helper
 * lives in `js/profiles/resolve.js` (not `memory-tools.js`) so
 * imports stay Node-safe — `memory-tools.js` transitively pulls
 * `core.js`'s browser-only `window.addEventListener`.
 *
 * @module tests/test-memory-resolve
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveMemoryConfig,
    resolveDefaultRememberScope,
} from '../js/profiles/resolve.js';
import { MEMORY_SCOPES } from '../js/intelligence/memory/contracts.js';

// ============================================
// Removability check — the load-bearing test
// ============================================

test("resolveDefaultRememberScope('coder') === 'workspace' (zero diff vs pre-1.18.0 literal)", () => {
    // The whole point of the §Decisions 7 check: replacing the
    // pre-slice literal `'workspace'` with this call must yield zero
    // behavior diff for coder, the role that actually exercises
    // memory_remember today. coder.v1.memory.default_scope is
    // 'session' (intentional — describes scratchpad, see
    // js/profiles/coder-v1.js), which falls outside MEMORY_SCOPES,
    // so the clamp inside resolveDefaultRememberScope returns 'workspace'.
    assert.equal(resolveDefaultRememberScope('coder'), 'workspace');
});

test("resolveDefaultRememberScope('chat') === 'user' (forward-looking; chat surfaces gain memory tools later)", () => {
    // chat.v1.memory.default_scope === 'user', and 'user' is in
    // MEMORY_SCOPES, so no clamp. No user-visible effect today
    // (chat surfaces don't expose memory tools), but the resolver
    // shape is correct for when 1.19.0+ surfaces the picker.
    assert.equal(resolveDefaultRememberScope('chat'), 'user');
});

test('roles outside coder fall through roleToProfileName to chat.v1', () => {
    // `pm`, `full`, plugin-dev, null, undefined, unknown strings —
    // all map to chat.v1 in roleToProfileName, hence 'user' here.
    assert.equal(resolveDefaultRememberScope('pm'), 'user');
    assert.equal(resolveDefaultRememberScope('full'), 'user');
    assert.equal(resolveDefaultRememberScope('plugin-dev'), 'user');
    assert.equal(resolveDefaultRememberScope(null), 'user');
    assert.equal(resolveDefaultRememberScope(undefined), 'user');
    assert.equal(resolveDefaultRememberScope('unknown.role.string'), 'user');
});

// ============================================
// Sanity — the clamp's premise stays valid
// ============================================

test("coder.v1's raw memory.default_scope is intentionally outside MEMORY_SCOPES", () => {
    // The clamp inside resolveDefaultRememberScope is only correct if this
    // mismatch keeps holding. If a future change adds 'session' to
    // MEMORY_SCOPES, this test fires — and the clamp becomes a bug.
    const cfg = resolveMemoryConfig('coder.v1');
    assert.equal(cfg.default_scope, 'session');
    assert.equal(MEMORY_SCOPES.includes('session'), false);
});

test("chat.v1's raw memory.default_scope is in MEMORY_SCOPES (no clamp needed)", () => {
    const cfg = resolveMemoryConfig('chat.v1');
    assert.equal(cfg.default_scope, 'user');
    assert.equal(MEMORY_SCOPES.includes('user'), true);
});
