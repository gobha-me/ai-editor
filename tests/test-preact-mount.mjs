/**
 * Tests for the Preact mount helper (js/utils/preact-mount.js).
 *
 * Pure-logic checks against the mount/unmount lifecycle using a stubbed
 * loader (so we never actually load Preact in node:test land — node has
 * no real DOM). The integration test (real Preact, real DOM) lives at
 * tests/index.html and runs in a browser.
 *
 * What this suite proves:
 *   - mountPreact resolves the loader exactly once (caching).
 *   - mountPreact calls render(h(component, props), rootEl).
 *   - The returned cleanup fn calls render(null, rootEl) — Preact's unmount.
 *   - Cleanup is idempotent (calling it twice is a no-op).
 *   - Argument validation rejects missing rootEl / non-function componentFn.
 *
 * @since 1.3.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mountPreact,
    getPreact,
    _setLoaderForTests,
    _resetLoaderForTests
} from '../js/utils/preact-mount.js';

// ============================================
// helpers
// ============================================

function makeStubPreact() {
    const calls = { h: [], render: [] };
    const stub = {
        h: (component, props) => {
            const vnode = { __vnode: true, component, props };
            calls.h.push({ component, props, vnode });
            return vnode;
        },
        render: (vnode, root) => {
            calls.render.push({ vnode, root });
        },
        html: (strings, ...values) => ({ __html: true, strings, values }),
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null })
    };
    return { stub, calls };
}

function installStub() {
    const { stub, calls } = makeStubPreact();
    let loaderCalls = 0;
    _setLoaderForTests(async () => {
        loaderCalls += 1;
        return stub;
    });
    return { stub, calls, getLoaderCalls: () => loaderCalls };
}

// ============================================
// getPreact — caching
// ============================================

test('getPreact resolves once and caches the result', async () => {
    const { stub, getLoaderCalls } = installStub();
    const a = await getPreact();
    const b = await getPreact();
    assert.equal(a, stub);
    assert.equal(b, stub);
    assert.equal(getLoaderCalls(), 1, 'loader called once across multiple awaits');
    _resetLoaderForTests();
});

test('getPreact concurrent calls share a single in-flight load', async () => {
    let loaderCalls = 0;
    let resolveLoader;
    const stub = {
        h: () => ({}),
        render: () => {},
        html: () => ({})
    };
    _setLoaderForTests(() => {
        loaderCalls += 1;
        return new Promise((res) => { resolveLoader = res; });
    });

    const p1 = getPreact();
    const p2 = getPreact();
    resolveLoader(stub);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, stub);
    assert.equal(r2, stub);
    assert.equal(loaderCalls, 1, 'concurrent calls coalesce into one load');
    _resetLoaderForTests();
});

// ============================================
// mountPreact — render call shape
// ============================================

test('mountPreact calls render(h(component, props), rootEl)', async () => {
    const { calls } = installStub();
    const root = { __root: 'r1' };
    const Comp = function MyComp() { return null; };
    const props = { x: 1, y: 'two' };

    const cleanup = await mountPreact(root, Comp, props);

    assert.equal(calls.h.length, 1, 'h called once');
    assert.equal(calls.h[0].component, Comp);
    assert.deepEqual(calls.h[0].props, props);

    assert.equal(calls.render.length, 1, 'render called once');
    assert.equal(calls.render[0].root, root);
    assert.equal(calls.render[0].vnode, calls.h[0].vnode, 'render receives the h() vnode');

    assert.equal(typeof cleanup, 'function', 'cleanup is a function');
    _resetLoaderForTests();
});

test('mountPreact defaults props to {} when omitted', async () => {
    const { calls } = installStub();
    const root = { __root: 'r2' };
    await mountPreact(root, () => null);
    assert.deepEqual(calls.h[0].props, {});
    _resetLoaderForTests();
});

// ============================================
// cleanup behavior
// ============================================

test('cleanup calls render(null, rootEl) — Preact unmount', async () => {
    const { calls } = installStub();
    const root = { __root: 'r3' };
    const cleanup = await mountPreact(root, () => null);

    cleanup();

    assert.equal(calls.render.length, 2, 'render called twice (mount + unmount)');
    assert.equal(calls.render[1].vnode, null, 'unmount uses null vnode');
    assert.equal(calls.render[1].root, root, 'unmount uses same root');
    _resetLoaderForTests();
});

test('cleanup is idempotent — calling twice is a no-op', async () => {
    const { calls } = installStub();
    const root = { __root: 'r4' };
    const cleanup = await mountPreact(root, () => null);

    cleanup();
    cleanup();
    cleanup();

    assert.equal(calls.render.length, 2, 'second + third cleanup do nothing');
    _resetLoaderForTests();
});

// ============================================
// argument validation
// ============================================

test('mountPreact rejects missing rootEl', async () => {
    installStub();
    await assert.rejects(
        () => mountPreact(null, () => null),
        /rootEl is required/
    );
    _resetLoaderForTests();
});

test('mountPreact rejects undefined rootEl', async () => {
    installStub();
    await assert.rejects(
        () => mountPreact(undefined, () => null),
        /rootEl is required/
    );
    _resetLoaderForTests();
});

test('mountPreact rejects non-function componentFn', async () => {
    installStub();
    const root = {};
    await assert.rejects(
        () => mountPreact(root, 'not-a-function'),
        /componentFn must be a function/
    );
    await assert.rejects(
        () => mountPreact(root, null),
        /componentFn must be a function/
    );
    await assert.rejects(
        () => mountPreact(root, { not: 'a function' }),
        /componentFn must be a function/
    );
    _resetLoaderForTests();
});

// ============================================
// loader cache reset across tests
// ============================================

test('_resetLoaderForTests clears the cache so the next call reloads', async () => {
    let calls = 0;
    _setLoaderForTests(async () => {
        calls += 1;
        return { h: () => ({}), render: () => {} };
    });
    await getPreact();
    await getPreact();
    assert.equal(calls, 1);

    _resetLoaderForTests();
    // After reset, the default (real) loader is in place — installing a new
    // stub should re-load.
    let calls2 = 0;
    _setLoaderForTests(async () => {
        calls2 += 1;
        return { h: () => ({}), render: () => {} };
    });
    await getPreact();
    assert.equal(calls2, 1, 'cache was cleared between stub swaps');
    _resetLoaderForTests();
});
