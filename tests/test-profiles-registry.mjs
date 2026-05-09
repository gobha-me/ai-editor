/**
 * 1.21.0 — Profile registry: extracted from `js/profiles/resolve.js`.
 *
 * The picker UI in `js/settings/roles-tab.js` populates its `<select>`
 * from `Profiles.list()`; `resolve.js` and `getActiveProfileName` use
 * `Profiles.get` / `Profiles.has` for lookup + validation. These tests
 * pin the registry's contract so a future regression that drops a
 * profile or reshapes the list-entry shape lands here loudly rather
 * than as a silent picker-renders-empty bug.
 *
 * Pure logic; no DOM/IDB/fetch. Runs under `node --test`.
 *
 * @module tests/test-profiles-registry
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Profiles, get, has, list } from '../js/profiles/registry.js';
import { CHAT_V1 } from '../js/profiles/chat-v1.js';
import { CODER_V1 } from '../js/profiles/coder-v1.js';
import { KB_V1 } from '../js/profiles/kb-v1.js';

// ============================================
// get / has — exact-name lookup
// ============================================

test("Profiles.get('chat.v1') returns CHAT_V1", () => {
    assert.equal(Profiles.get('chat.v1'), CHAT_V1);
});

test("Profiles.get('coder.v1') returns CODER_V1", () => {
    assert.equal(Profiles.get('coder.v1'), CODER_V1);
});

test("Profiles.get('kb.v1') returns KB_V1", () => {
    assert.equal(Profiles.get('kb.v1'), KB_V1);
});

test("Profiles.get('unknown.profile') returns null (no throw)", () => {
    assert.equal(Profiles.get('unknown.profile'), null);
});

test("Profiles.has('chat.v1') === true", () => {
    assert.equal(Profiles.has('chat.v1'), true);
});

test("Profiles.has('coder.v1') === true", () => {
    assert.equal(Profiles.has('coder.v1'), true);
});

test("Profiles.has('kb.v1') === true", () => {
    assert.equal(Profiles.has('kb.v1'), true);
});

test("Profiles.has('unknown.profile') === false", () => {
    assert.equal(Profiles.has('unknown.profile'), false);
});

// `has` must be inherited-property-safe — Object.create(null)-style
// lookup, not just a plain `in`-check. A profile named `__proto__` or
// `constructor` must NOT be reported as registered.
test("Profiles.has('__proto__') === false (prototype-pollution safety)", () => {
    assert.equal(Profiles.has('__proto__'), false);
});

test("Profiles.has('constructor') === false (prototype-pollution safety)", () => {
    assert.equal(Profiles.has('constructor'), false);
});

// ============================================
// list — picker-shape
// ============================================

test("Profiles.list() returns chat.v1 + coder.v1 + kb.v1 (kb.v1 promoted at 2.8.0; chat_multi.v1 / rp.v1 still lookup-only)", () => {
    // 2.6.0 — chat_multi.v1, rp.v1, kb.v1 landed as lookup-only synthetics.
    // 2.8.0 — kb.v1 graduates to ENTRIES carrying its systemPrompt addendum
    // (the cheapest first lever per ROADMAP §"After 2.0.0" → "Profiles
    // Phase 2 picker promotion"); chat_multi.v1 / rp.v1 stay in
    // SYNTHETIC_ENTRIES until each earns its own addendum.
    const entries = Profiles.list();
    assert.equal(entries.length, 3);
    const names = entries.map(e => e.name);
    assert.ok(names.includes('chat.v1'));
    assert.ok(names.includes('coder.v1'));
    assert.ok(names.includes('kb.v1'));
});

test("Profiles.list() returns chat.v1 first (the inheritance base)", () => {
    // The picker UI renders options in the order list() returns. Chat
    // first matches the inheritance hierarchy (every other profile has
    // `base: 'chat.v1'`).
    const entries = Profiles.list();
    assert.equal(entries[0].name, 'chat.v1');
    assert.equal(entries[1].name, 'coder.v1');
    assert.equal(entries[2].name, 'kb.v1');
});

test("kb.v1 carries the KB-mode systemPrompt addendum (the 2.8.0 promotion gate)", () => {
    // The picker promotion is gated specifically on kb.v1 carrying a
    // systemPrompt that produces user-observable behavior change. Mirror of
    // the plugin-dev.v1 systemPrompt assertion in test-profile-filter-tools.
    const profile = Profiles.get('kb.v1');
    assert.ok(profile, 'kb.v1 must resolve');
    assert.equal(typeof profile.systemPrompt, 'string');
    assert.ok(profile.systemPrompt.includes('KB MODE'));
    assert.ok(profile.systemPrompt.includes('attached doc'));
    assert.ok(profile.systemPrompt.toLowerCase().includes('cite'));
});

test("Profiles.list() entries have { name, label, description } shape", () => {
    for (const entry of Profiles.list()) {
        assert.equal(typeof entry.name, 'string');
        assert.equal(typeof entry.label, 'string');
        assert.equal(typeof entry.description, 'string');
        assert.ok(entry.name.length > 0);
        assert.ok(entry.label.length > 0);
        assert.ok(entry.description.length > 0);
    }
});

// ============================================
// Named-export parity
// ============================================

test("named exports `get` / `has` / `list` match `Profiles.*`", () => {
    // The module exposes both shapes — named (`import { get } from ...`)
    // and the namespace (`import { Profiles } from ...`). Pin that they
    // refer to the same callables so callers don't accidentally branch.
    assert.equal(get, Profiles.get);
    assert.equal(has, Profiles.has);
    assert.equal(list, Profiles.list);
});
