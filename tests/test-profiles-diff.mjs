/**
 * Tests for js/profiles/diff.js — `diffProfiles(a, b, options)` structured
 * object differ + `formatProfileDiff(diff)` markdown renderer (2.5.0).
 *
 * Runs under `node --test`. Pure logic; no DOM/Storage/fetch. The differ
 * mirrors `mergeDeep` semantics in `js/profiles/inheritance.js` so its
 * output is faithful to what `resolveProfile` would produce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    diffProfiles,
    formatProfileDiff,
    CHAT_V1,
    CODER_V1,
    Profiles,
} from '../js/profiles/index.js';

// ============================================
// Identity / equality
// ============================================

test('identical profiles produce equal=true and no entries', () => {
    const out = diffProfiles(CHAT_V1, CHAT_V1, { mode: 'raw' });
    assert.equal(out.equal, true);
    assert.equal(out.entries.length, 0);
    assert.equal(out.nameA, 'chat.v1');
    assert.equal(out.nameB, 'chat.v1');
    assert.equal(out.mode, 'raw');
});

test('distinct objects with identical contents are equal', () => {
    const a = { name: 'p', version: '1', base: null, x: { y: [1, 2, 3] } };
    const b = { name: 'p', version: '1', base: null, x: { y: [1, 2, 3] } };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.equal, true);
});

// ============================================
// added / removed / changed
// ============================================

test("added: key present on B only emits 'added' with after value", () => {
    const a = { name: 'p', x: 1 };
    const b = { name: 'p', x: 1, y: 2 };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.entries.length, 1);
    assert.deepEqual(out.entries[0], { path: ['y'], kind: 'added', after: 2 });
});

test("removed: key present on A only emits 'removed' with before value", () => {
    const a = { name: 'p', x: 1, y: 2 };
    const b = { name: 'p', x: 1 };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.entries.length, 1);
    assert.deepEqual(out.entries[0], { path: ['y'], kind: 'removed', before: 2 });
});

test("changed: scalar mismatch emits 'changed' with before+after", () => {
    const a = { name: 'p', x: 1 };
    const b = { name: 'p', x: 2 };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.entries.length, 1);
    assert.deepEqual(out.entries[0], { path: ['x'], kind: 'changed', before: 1, after: 2 });
});

test('null is a primitive: null↔value emits changed, not removed', () => {
    const a = { name: 'p', x: null };
    const b = { name: 'p', x: 5 };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].kind, 'changed');
    assert.equal(out.entries[0].before, null);
    assert.equal(out.entries[0].after, 5);
});

test('undefined override does not emit (mirrors mergeDeep skip)', () => {
    const a = { name: 'p', x: 1 };
    const b = { name: 'p', x: 1, y: undefined };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.equal, true);
});

// ============================================
// array_replaced semantics
// ============================================

test("array_replaced: arrays differing in content emit single 'array_replaced' entry", () => {
    const a = { name: 'p', tools: { static: ['x', 'y'] } };
    const b = { name: 'p', tools: { static: ['x', 'z'] } };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].kind, 'array_replaced');
    assert.deepEqual(out.entries[0].path, ['tools', 'static']);
    assert.deepEqual(out.entries[0].before, ['x', 'y']);
    assert.deepEqual(out.entries[0].after, ['x', 'z']);
});

test('array_replaced: equal arrays emit nothing', () => {
    const a = { name: 'p', tools: { static: ['x', 'y'] } };
    const b = { name: 'p', tools: { static: ['x', 'y'] } };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.equal, true);
});

test('object↔array shape mismatch is array_replaced', () => {
    const a = { name: 'p', x: { foo: 1 } };
    const b = { name: 'p', x: [1, 2] };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].kind, 'array_replaced');
});

// ============================================
// Path determinism
// ============================================

test('multiple diffs are emitted in lexicographic key order', () => {
    const a = { name: 'p', zeta: 1, alpha: 1, mu: 1 };
    const b = { name: 'p', zeta: 2, alpha: 2, mu: 2 };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    const paths = out.entries.map(e => e.path[0]);
    assert.deepEqual(paths, ['alpha', 'mu', 'name', 'zeta'].filter(k => k !== 'name'));
});

// ============================================
// resolved mode
// ============================================

test("mode 'resolved' requires lookup", () => {
    assert.throws(
        () => diffProfiles(CHAT_V1, CODER_V1, { mode: 'resolved' }),
        /lookup is required/,
    );
});

test('resolved mode merges base chain before diffing', () => {
    // CODER_V1 has base: 'chat.v1'. Resolving merges chat.v1 underneath so
    // the resolved coder profile contains chat.v1's defaults wherever coder
    // doesn't override. Diffing chat.v1 (no base) against resolved coder
    // surfaces only what coder actually changes — not the base contents.
    const out = diffProfiles(CHAT_V1, CODER_V1, {
        mode: 'resolved',
        lookup: Profiles.get,
        ignorePaths: ['name', 'version', 'base'],
    });
    // We don't pin every entry — just that the diff is non-empty (coder DOES
    // override) and that core overridden surfaces appear.
    assert.equal(out.equal, false);
    const paths = out.entries.map(e => e.path.join('.'));
    assert.ok(paths.some(p => p.startsWith('compression')), 'expected compression delta');
    assert.ok(paths.some(p => p.startsWith('retrieval')), 'expected retrieval delta');
    assert.ok(paths.some(p => p.startsWith('tools')), 'expected tools delta');
});

// ============================================
// ignorePaths
// ============================================

test('ignorePaths suppresses entries at exact dot-path matches', () => {
    const a = { name: 'a', version: '1', x: 1 };
    const b = { name: 'b', version: '2', x: 2 };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), {
        mode: 'raw',
        ignorePaths: ['name', 'version'],
    });
    assert.equal(out.entries.length, 1);
    assert.deepEqual(out.entries[0].path, ['x']);
});

// ============================================
// formatProfileDiff
// ============================================

test('formatProfileDiff: equal diff renders "_No differences._"', () => {
    const out = diffProfiles(CHAT_V1, CHAT_V1, { mode: 'raw' });
    const md = formatProfileDiff(out);
    assert.match(md, /No differences/);
});

test('formatProfileDiff: groups entries by kind', () => {
    const a = { name: 'p', x: 1, y: 2, z: ['a'] };
    const b = { name: 'p', x: 1, y: 3, w: 4, z: ['b'] };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    const md = formatProfileDiff(out);
    assert.match(md, /## added/);
    assert.match(md, /## changed/);
    assert.match(md, /## array_replaced/);
    // Header carries the profile names + mode.
    assert.match(md, /Profile diff: p → p \(mode: raw\)/);
});

test('formatProfileDiff: short arrays inline as JSON, long arrays show length only', () => {
    const a = { name: 'p', short: [1, 2], long: Array.from({ length: 20 }, (_, i) => i) };
    const b = { name: 'p', short: [3, 4], long: Array.from({ length: 21 }, (_, i) => i) };
    const out = diffProfiles(/** @type {any} */ (a), /** @type {any} */ (b), { mode: 'raw' });
    const md = formatProfileDiff(out);
    assert.match(md, /short.*\[1,2\].*\[3,4\]/);
    assert.match(md, /long.*len=20.*len=21/);
});
