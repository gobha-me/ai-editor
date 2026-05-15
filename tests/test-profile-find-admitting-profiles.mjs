/**
 * `Profiles.findAdmittingProfiles(toolName, { overlayNames? })` — registry-
 * side admission probe added at 2.55.0 (gitea#439). Powers the default-OFF
 * dev warning that fires when `ToolRegistry.register` lands a new tool no
 * profile admits.
 *
 * Differs from `Profiles.filterTools` (already pinned at
 * `tests/test-profile-filter-tools.mjs`) in two pinned ways:
 *
 *   1. Queries by `toolName` (string) instead of a defs array. Used at
 *      registration time before the tool is visible to any caller.
 *   2. The `'*'` sentinel in `full.v1.tools.admit` does NOT count as
 *      admission. A tool admitted only via the bypass is invisible to
 *      picker profiles — exactly the silent-vanish case the warning
 *      catches. Picker-side admission must be explicit (literal or glob).
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Profiles } from '../js/profiles/index.js';

// ============================================
// Literal admission — production tool names known to be in picker admit
// lists (see `tests/test-profile-admit-coverage.mjs` for the pinned
// baselines).
// ============================================

test('literal admission — read_file is in chat.v1 / coder.v1 / kb.v1', () => {
    const admitters = Profiles.findAdmittingProfiles('read_file');
    assert.ok(admitters.includes('chat.v1'), `expected chat.v1 in ${JSON.stringify(admitters)}`);
    assert.ok(admitters.includes('coder.v1'), `expected coder.v1 in ${JSON.stringify(admitters)}`);
    assert.ok(admitters.includes('kb.v1'), `expected kb.v1 in ${JSON.stringify(admitters)}`);
});

test('literal admission — commit_files is admitted only by coder.v1 among picker profiles', () => {
    const admitters = Profiles.findAdmittingProfiles('commit_files');
    assert.ok(admitters.includes('coder.v1'), `expected coder.v1 in ${JSON.stringify(admitters)}`);
    assert.ok(!admitters.includes('chat.v1'), `did NOT expect chat.v1 in ${JSON.stringify(admitters)}`);
    assert.ok(!admitters.includes('kb.v1'), `did NOT expect kb.v1 in ${JSON.stringify(admitters)}`);
});

// ============================================
// `mcp__*` glob admission — picker profiles carry the glob, subagent.v1
// deliberately omits it (sub-agent trust boundary requires explicit per-
// tool admission per CHANGELOG 2.54.0).
// ============================================

test('glob admission — mcp__-prefixed names match the mcp__* glob', () => {
    const admitters = Profiles.findAdmittingProfiles('mcp__github__create_issue');
    assert.ok(admitters.includes('chat.v1'), `expected chat.v1 via mcp__* glob`);
    assert.ok(admitters.includes('coder.v1'), `expected coder.v1 via mcp__* glob`);
    assert.ok(admitters.includes('kb.v1'), `expected kb.v1 via mcp__* glob`);
});

test('glob admission — subagent.v1 does NOT match mcp__* (no glob in subagent admit)', () => {
    const admitters = Profiles.findAdmittingProfiles('mcp__github__create_issue');
    assert.ok(!admitters.includes('subagent.v1'),
        `subagent.v1 should NOT admit mcp__-prefixed names (trust boundary); got ${JSON.stringify(admitters)}`);
});

test('glob admission — single-underscore "mcp_" name does NOT match mcp__* glob', () => {
    // The glob prefix is `'mcp__'` (after slicing the trailing `*`); names
    // like `mcp_namespaceless` (one underscore) must not match. Pins the
    // boundary that `filterTools` already enforces.
    const admitters = Profiles.findAdmittingProfiles('mcp_namespaceless');
    assert.equal(admitters.length, 0,
        `expected no admitters for single-underscore name; got ${JSON.stringify(admitters)}`);
});

// ============================================
// `'*'` sentinel skip — full.v1's bypass MUST NOT count as admission.
// ============================================

test("'*' sentinel does not count — tool admitted only via full.v1's [*] returns empty", () => {
    // Pick a name no production profile lists. If `'*'` were honored,
    // full.v1 would admit it and the result would include 'full.v1'.
    const admitters = Profiles.findAdmittingProfiles('zz_synthetic_never_in_any_admit_list');
    assert.equal(admitters.length, 0,
        `expected zero admitters (full.v1's '*' must be skipped); got ${JSON.stringify(admitters)}`);
});

// ============================================
// Defensive — empty / non-string toolName.
// ============================================

test('empty string toolName returns empty array', () => {
    assert.deepEqual(Profiles.findAdmittingProfiles(''), []);
});

test('non-string toolName returns empty array', () => {
    // @ts-expect-error — testing the defensive type check.
    assert.deepEqual(Profiles.findAdmittingProfiles(null), []);
    // @ts-expect-error — testing the defensive type check.
    assert.deepEqual(Profiles.findAdmittingProfiles(undefined), []);
    // @ts-expect-error — testing the defensive type check.
    assert.deepEqual(Profiles.findAdmittingProfiles(42), []);
});

// ============================================
// `overlayNames` forward-compat — gitea#442 PLUGIN_TOOL_NAMES seam.
// ============================================

test('overlayNames hit — name in overlay list adds <overlay> sentinel to admitters', () => {
    const admitters = Profiles.findAdmittingProfiles('zz_overlay_only', {
        overlayNames: ['zz_overlay_only', 'something_else'],
    });
    assert.ok(admitters.includes('<overlay>'),
        `expected <overlay> sentinel; got ${JSON.stringify(admitters)}`);
});

test('overlayNames miss — name absent from overlay list does not add sentinel', () => {
    const admitters = Profiles.findAdmittingProfiles('zz_not_in_overlay', {
        overlayNames: ['something_else'],
    });
    assert.equal(admitters.length, 0,
        `expected zero admitters; got ${JSON.stringify(admitters)}`);
});

test('overlayNames combines with profile admission — both signals contribute', () => {
    const admitters = Profiles.findAdmittingProfiles('read_file', {
        overlayNames: ['read_file'],
    });
    // Profile admission gives picker profiles; overlay adds the sentinel.
    assert.ok(admitters.includes('chat.v1'), `expected chat.v1 from profile admission`);
    assert.ok(admitters.includes('<overlay>'), `expected <overlay> sentinel from overlay match`);
});

test('overlayNames omitted entirely — no exception, no overlay match', () => {
    // No opts arg; no overlay list defaulted to []; behavior matches
    // profile-only admission.
    const a = Profiles.findAdmittingProfiles('read_file');
    const b = Profiles.findAdmittingProfiles('read_file', {});
    const c = Profiles.findAdmittingProfiles('read_file', { overlayNames: [] });
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
});
