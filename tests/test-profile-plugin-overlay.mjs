/**
 * `resolvePluginConfig` + `PLUGIN_TOOL_NAMES` — the `plugin.enabled`
 * capability-overlay flag wired at 2.58.0 (gitea#442).
 *
 * Decision recorded at `docs/discussion/plugin-dev-mode-vs-profile.md`:
 * plugin-dev is a *capability* anyone can engage as needed (flag), not a
 * *role* someone takes on for a session (profile). The flag defaults OFF
 * everywhere — opt-in only. When ON, the resolved profile + settings
 * overlay admits `PLUGIN_TOOL_NAMES` onto whatever profile is active.
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePluginConfig, PLUGIN_TOOL_NAMES, Profiles } from '../js/profiles/index.js';

// ============================================
// `PLUGIN_TOOL_NAMES` membership — frozen, the 4 plugin tools +
// `read_docs`. Pins the membership so a casual `push` doesn't widen
// admission without anyone noticing.
// ============================================

test('PLUGIN_TOOL_NAMES — frozen', () => {
    assert.ok(Object.isFrozen(PLUGIN_TOOL_NAMES),
        `PLUGIN_TOOL_NAMES must be frozen; got mutable array`);
});

test('PLUGIN_TOOL_NAMES — pinned 5-name membership (gitea#442)', () => {
    // Add to this list ONLY with a paired roadmap row + ROADMAP §"Now"
    // entry — admission widening must be deliberate per
    // `docs/discussion/plugin-dev-mode-vs-profile.md` §"What 'done' looks
    // like".
    assert.deepEqual([...PLUGIN_TOOL_NAMES].sort(), [
        'list_user_plugins',
        'read_docs',
        'read_plugin_source',
        'run_plugin',
        'write_plugin_source',
    ]);
});

// ============================================
// `resolvePluginConfig` — default OFF everywhere. The flag is opt-in;
// no profile flips it on by default.
// ============================================

test('resolvePluginConfig — chat.v1 default is OFF', () => {
    const cfg = resolvePluginConfig('chat.v1');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.profileName, 'chat.v1');
});

test('resolvePluginConfig — coder.v1 default is OFF (opt-in only, no profile flip)', () => {
    const cfg = resolvePluginConfig('coder.v1');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.profileName, 'coder.v1');
});

test('resolvePluginConfig — unknown profile falls back to chat.v1 (no throw)', () => {
    const cfg = resolvePluginConfig('nonexistent.v1');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.profileName, 'chat.v1');
});

test('resolvePluginConfig — null / undefined profileName falls back to chat.v1', () => {
    assert.equal(resolvePluginConfig(null).profileName, 'chat.v1');
    assert.equal(resolvePluginConfig(undefined).profileName, 'chat.v1');
});

// ============================================
// Overlay integration — each `PLUGIN_TOOL_NAMES` entry adds the
// `<overlay>` sentinel when passed as the overlay list, and picker
// profiles do NOT admit any of these names by default (the whole point —
// they're admitted via the flag, not via per-profile `tools.admit`).
// ============================================

test('overlay integration — every PLUGIN_TOOL_NAMES entry gets <overlay> sentinel', () => {
    for (const name of PLUGIN_TOOL_NAMES) {
        const admitters = Profiles.findAdmittingProfiles(name, { overlayNames: PLUGIN_TOOL_NAMES });
        assert.ok(admitters.includes('<overlay>'),
            `expected <overlay> sentinel for '${name}'; got ${JSON.stringify(admitters)}`);
    }
});

test('picker profiles do NOT admit any PLUGIN_TOOL_NAMES entry directly (chat.v1 / coder.v1 / kb.v1)', () => {
    // The whole point of the flag: picker profiles stay clean and admit
    // these names only via the overlay. Direct admission would defeat
    // the opt-in invariant.
    for (const name of PLUGIN_TOOL_NAMES) {
        const admitters = Profiles.findAdmittingProfiles(name);
        assert.ok(!admitters.includes('chat.v1'), `chat.v1 must NOT admit '${name}' directly; got ${JSON.stringify(admitters)}`);
        assert.ok(!admitters.includes('coder.v1'), `coder.v1 must NOT admit '${name}' directly; got ${JSON.stringify(admitters)}`);
        assert.ok(!admitters.includes('kb.v1'), `kb.v1 must NOT admit '${name}' directly; got ${JSON.stringify(admitters)}`);
    }
});

test('synthetic plugin-dev.v1 profile admits every PLUGIN_TOOL_NAMES entry directly', () => {
    // The migration target for legacy `settings.role === 'plugin-dev'`
    // users; carries the full admit list directly so the flag isn't
    // required for that surface.
    for (const name of PLUGIN_TOOL_NAMES) {
        const admitters = Profiles.findAdmittingProfiles(name);
        assert.ok(admitters.includes('plugin-dev.v1'),
            `plugin-dev.v1 must admit '${name}' directly; got ${JSON.stringify(admitters)}`);
    }
});
