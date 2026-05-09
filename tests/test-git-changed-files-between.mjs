/**
 * Tests for the BASE_GIT_PROVIDER `getChangedFilesBetween` default impl.
 *
 * Pinned semantics:
 *   - Returns the symmetric union of compareRefs(A,B).files and
 *     compareRefs(B,A).files (3-dot diffs, so the union covers files
 *     added/changed/removed on either branch since divergence).
 *   - Returns `null` on any error or unsupported provider — callers treat
 *     null as "fall back to full re-walk", `[]` as "branches differ by
 *     zero files".
 *   - Same-branch input short-circuits to `[]`.
 *
 * Helper has zero browser deps; runs cleanly under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';

/** Build a fake provider that spreads the base impl + stubs compareRefs. */
function makeProvider({ compareRefsImpl }) {
    return Object.assign(Object.create(null), BASE_GIT_PROVIDER, {
        compareRefs: compareRefsImpl,
    });
}

test('same branchA === branchB short-circuits to []', async () => {
    const calls = [];
    const provider = makeProvider({
        compareRefsImpl: async (...args) => { calls.push(args); return { files: [{ filename: 'x' }] }; },
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'main', 'main');
    assert.deepEqual(out, []);
    assert.equal(calls.length, 0, 'compareRefs not called when branches identical');
});

test('missing branchA returns []', async () => {
    const provider = makeProvider({
        compareRefsImpl: async () => { throw new Error('should not call'); },
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', '', 'main');
    assert.deepEqual(out, []);
});

test('union of A→B and B→A files, deduplicated', async () => {
    const provider = makeProvider({
        compareRefsImpl: async (_conn, _o, _r, base, head) => {
            if (base === 'feature' && head === 'main') {
                return { files: [{ filename: 'a.js' }, { filename: 'b.js' }] };
            }
            if (base === 'main' && head === 'feature') {
                return { files: [{ filename: 'b.js' }, { filename: 'c.js' }] };
            }
            throw new Error(`unexpected (${base}, ${head})`);
        },
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'feature', 'main');
    assert.deepEqual(new Set(out), new Set(['a.js', 'b.js', 'c.js']));
});

test('compareRefs throws → returns null (caller falls back to full re-walk)', async () => {
    const provider = makeProvider({
        compareRefsImpl: async () => { throw new Error('not supported'); },
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.equal(out, null);
});

test('one direction throws → whole call returns null (Promise.all short-circuit)', async () => {
    const provider = makeProvider({
        compareRefsImpl: async (_conn, _o, _r, base) => {
            if (base === 'a') return { files: [{ filename: 'x.js' }] };
            throw new Error('partial failure');
        },
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.equal(out, null);
});

test('files entries without filename are dropped', async () => {
    const provider = makeProvider({
        compareRefsImpl: async () => ({
            files: [
                { filename: 'good.js' },
                { filename: '' },        // empty string → drop
                { filename: null },      // null → drop
                {},                      // missing key → drop
                null,                    // null entry → drop
                { filename: 'also.js' },
            ],
        }),
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.deepEqual(new Set(out), new Set(['good.js', 'also.js']));
});

test('null/undefined files arrays from one direction → still returns the other side', async () => {
    const provider = makeProvider({
        compareRefsImpl: async (_conn, _o, _r, base) => {
            if (base === 'a') return { files: [{ filename: 'one.js' }] };
            return { files: null };        // graceful: just no files in the bToA direction
        },
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.deepEqual(out, ['one.js']);
});

test('empty diff (both directions report no files) → []', async () => {
    const provider = makeProvider({
        compareRefsImpl: async () => ({ files: [] }),
    });
    const out = await provider.getChangedFilesBetween({}, 'o', 'r', 'a', 'b');
    assert.deepEqual(out, []);
});

test('issues both compareRefs calls with the right base/head pairs', async () => {
    const calls = [];
    const provider = makeProvider({
        compareRefsImpl: async (_conn, _o, _r, base, head) => {
            calls.push({ base, head });
            return { files: [] };
        },
    });
    await provider.getChangedFilesBetween({}, 'o', 'r', 'feature', 'main');
    assert.equal(calls.length, 2);
    // Order is unspecified due to Promise.all, but both pairings must appear
    const seen = new Set(calls.map(c => `${c.base}→${c.head}`));
    assert.ok(seen.has('feature→main'));
    assert.ok(seen.has('main→feature'));
});
