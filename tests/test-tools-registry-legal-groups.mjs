/**
 * Tests for `Profiles.getKnownGroupTags()` + the tool-registry typo
 * validator that consumes it.
 *
 * Pre-2.34.0 `js/tools/registry.js` hardcoded
 *
 *   const LEGAL_GROUP_TAGS = ['all', 'coder', 'pm', 'reviewer', 'plugin-dev', 'full'];
 *
 * shadowing the profile registry — any future profile declaring a new
 * `tools.allowed_groups` entry would silently fail register-time
 * validation for any tool tagged with it. 2.34.0 moves the source of
 * truth to `Profiles.getKnownGroupTags()` which derives the set from
 * profile data plus two carve-outs (`'all'`, `'full'`).
 *
 * Three test classes:
 *
 *   1. **Snapshot guard** — the derived set matches the pre-2.34.0 array
 *      byte-for-byte (sorted). Proves the refactor is byte-equivalent
 *      at boot.
 *   2. **Union property** — every registered profile's `allowed_groups`
 *      (minus the `'*'` wildcard) is subsumed by the result. Proves the
 *      derivation is the union, so a future profile addition extends the
 *      vocabulary automatically.
 *   3. **Rejection still fires** — a typo'd `roles:` declaration still
 *      throws at `ToolRegistry.register()` time with a message that lists
 *      every known tag. Proves the validator's user-facing behavior is
 *      preserved.
 *
 * Pure logic; no DOM/Storage/fetch beyond the `_node-shim.mjs` stubs
 * `js/tools/registry.js` needs for its `EventBus` / `State` imports.
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Profiles } = await import('../js/profiles/registry.js');
const { ToolRegistry } = await import('../js/tools/registry.js');

// ============================================
// 1. Snapshot guard — byte-for-byte equivalence with the pre-2.34.0 set.
// ============================================

test('getKnownGroupTags() returns the pre-2.34.0 LEGAL_GROUP_TAGS set, sorted', () => {
    const PRE_2_34_0 = ['all', 'coder', 'full', 'pm', 'plugin-dev', 'reviewer'].sort();
    assert.deepEqual(Profiles.getKnownGroupTags(), PRE_2_34_0);
});

// ============================================
// 2. Union property — every profile's allowed_groups is subsumed.
// ============================================

test('getKnownGroupTags() unions every profile\'s allowed_groups (excluding \'*\')', () => {
    const known = new Set(Profiles.getKnownGroupTags());
    // Walk every registered profile via the public `get` API. The list
    // of names is the migration table + the picker entries; this is the
    // same set the registry indexes internally.
    const names = [
        'chat.v1', 'coder.v1', 'kb.v1',
        'chat_multi.v1', 'full.v1', 'plugin-dev.v1', 'pm.v1', 'reviewer.v1', 'rp.v1',
    ];
    for (const name of names) {
        const profile = Profiles.get(name);
        assert.ok(profile, `expected profile '${name}' to be registered`);
        const groups = (profile.tools && profile.tools.allowed_groups) || [];
        for (const g of groups) {
            if (g === '*') continue;
            assert.ok(
                known.has(g),
                `profile '${name}' declares allowed_groups entry '${g}' but getKnownGroupTags() did not surface it`
            );
        }
    }
});

test('getKnownGroupTags() includes the \'all\' and \'full\' carve-outs even though no profile declares them', () => {
    const known = new Set(Profiles.getKnownGroupTags());
    assert.ok(known.has('all'), '\'all\' is the universal-default admission tag; must always be legal');
    assert.ok(known.has('full'), '\'full\' is the legacy bypass tag carried by tool registrations; must remain legal');
});

// ============================================
// 3. Rejection still fires — register-time typo validation.
// ============================================

function makeDef(name, roles) {
    return {
        type: 'function',
        function: { name, description: 'test', parameters: { type: 'object', properties: {} } },
        roles,
    };
}

test('ToolRegistry.register() throws for a tool whose roles include a typo\'d tag', () => {
    const noop = async () => ({ ok: true });
    assert.throws(
        () => ToolRegistry.register('__test_typo_tool__', noop, makeDef('__test_typo_tool__', ['cdoer'])),
        (err) => {
            assert.match(err.message, /invalid role\(s\): cdoer/);
            // Error message lists every known tag so the author sees the
            // full vocabulary without needing to grep.
            for (const tag of Profiles.getKnownGroupTags()) {
                assert.ok(
                    err.message.includes(tag),
                    `expected error message to include legal tag '${tag}'; got: ${err.message}`
                );
            }
            return true;
        }
    );
    // Bookkeeping: a throwing register must not leak handler / definition state.
    assert.equal(ToolRegistry.handlers.has('__test_typo_tool__'), false);
    assert.equal(ToolRegistry.definitions.some(d => d.function?.name === '__test_typo_tool__'), false);
});

test('ToolRegistry.register() accepts every tag returned by getKnownGroupTags()', () => {
    const noop = async () => ({ ok: true });
    for (const tag of Profiles.getKnownGroupTags()) {
        const toolName = `__test_legal_tag_${tag}__`;
        assert.doesNotThrow(
            () => ToolRegistry.register(toolName, noop, makeDef(toolName, [tag])),
            `register() unexpectedly rejected the known-legal tag '${tag}'`
        );
        ToolRegistry.unregister(toolName);
    }
});
