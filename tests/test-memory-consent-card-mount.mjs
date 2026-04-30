/**
 * Tests for js/chat/consent-card.js — the Preact mount wrapper for the
 * inline consent card (Memory PR #6). Stubs Preact via the same
 * `_setLoaderForTests` pattern used by tests/test-preact-mount.mjs and
 * tests/test-memory-tab-mount.mjs (the PR #5 precedent), so we never
 * actually load the bundle in node:test land. The real-DOM integration
 * test lives in the browser suite at tests/index.html.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    _setLoaderForTests,
    _resetLoaderForTests,
} from '../js/utils/preact-mount.js';

import {
    mountConsentCard,
    unmountConsentCard,
    unmountAll,
    _isMounted,
    _resetForTests,
} from '../js/chat/consent-card.js';

/* -------------------------------------------------------------------------- */
/* Stubs                                                                      */
/* -------------------------------------------------------------------------- */

function makeStubPreact() {
    const calls = { h: [], render: [], html: 0 };
    const stub = {
        h: (component, props) => {
            const vnode = { __vnode: true, component, props };
            calls.h.push({ component, props });
            return vnode;
        },
        render: (vnode, root) => {
            calls.render.push({ vnode, root });
        },
        html: (strings, ...values) => { calls.html += 1; return { __html: true }; },
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useMemo: (fn) => fn(),
    };
    return { stub, calls };
}

function makeRoot() {
    // Minimal DOM-ish object: messages.js mountConsentCard takes a real
    // HTMLElement, but consent-card.js's contract only uses identity (key
    // for the WeakMap) and an `innerHTML` setter for the error fallback.
    return /** @type {any} */ ({ innerHTML: '' });
}

beforeEach(() => {
    _resetForTests();
    _resetLoaderForTests();
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

test('mountConsentCard renders into the supplied root and tracks the mount', async () => {
    const { stub, calls } = makeStubPreact();
    _setLoaderForTests(async () => stub);

    const root = makeRoot();
    await mountConsentCard(root, 'cand-1');
    assert.equal(_isMounted(root), true);
    // Render fired with the supplied root.
    const lastRender = calls.render[calls.render.length - 1];
    assert.equal(lastRender.root, root);
});

test('mountConsentCard is idempotent per root (second call is a no-op while mounted)', async () => {
    const { stub, calls } = makeStubPreact();
    _setLoaderForTests(async () => stub);

    const root = makeRoot();
    await mountConsentCard(root, 'cand-1');
    await mountConsentCard(root, 'cand-1');
    // The second call returns immediately without rendering again.
    assert.equal(calls.render.length, 1);
});

test('unmountConsentCard runs Preact cleanup and clears tracking', async () => {
    const { stub, calls } = makeStubPreact();
    _setLoaderForTests(async () => stub);

    const root = makeRoot();
    await mountConsentCard(root, 'cand-1');
    assert.equal(_isMounted(root), true);

    unmountConsentCard(root);
    assert.equal(_isMounted(root), false);
    // Cleanup fn from mountPreact calls render(null, root).
    const lastRender = calls.render[calls.render.length - 1];
    assert.equal(lastRender.vnode, null);
    assert.equal(lastRender.root, root);
});

test('unmountAll drains every active mount in one pass', async () => {
    const { stub, calls } = makeStubPreact();
    _setLoaderForTests(async () => stub);

    const r1 = makeRoot();
    const r2 = makeRoot();
    const r3 = makeRoot();
    await mountConsentCard(r1, 'a');
    await mountConsentCard(r2, 'b');
    await mountConsentCard(r3, 'c');

    unmountAll();
    assert.equal(_isMounted(r1), false);
    assert.equal(_isMounted(r2), false);
    assert.equal(_isMounted(r3), false);
    // 3 mounts (render(vnode)) + 3 unmounts (render(null)) = 6 total.
    assert.equal(calls.render.length, 6);
});

test('mountConsentCard with null root warns and skips (no Preact call)', async () => {
    const { stub, calls } = makeStubPreact();
    _setLoaderForTests(async () => stub);

    // No throw, no render.
    await mountConsentCard(null, 'cand-1');
    assert.equal(calls.render.length, 0);
});

test('mountConsentCard with empty candidateId warns and skips', async () => {
    const { stub, calls } = makeStubPreact();
    _setLoaderForTests(async () => stub);

    const root = makeRoot();
    await mountConsentCard(root, '');
    assert.equal(_isMounted(root), false);
    assert.equal(calls.render.length, 0);
});

test('mountConsentCard catches dynamic-import failure and falls back to vanilla error', async () => {
    // Stub a Preact module that the dynamic import path can't resolve.
    // The async loader fails — mountPreact rejects. mountConsentCard
    // catches and writes the error string into rootEl.innerHTML.
    _setLoaderForTests(async () => { throw new Error('bundle missing'); });

    const root = makeRoot();
    await mountConsentCard(root, 'cand-1');
    assert.match(root.innerHTML, /Memory consent card failed to load/);
    assert.equal(_isMounted(root), false);
});
