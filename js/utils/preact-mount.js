/**
 * AI Editor — Preact mount helper
 *
 * Loads Preact + htm lazily (vendor bundle first, CDN fallback) and
 * mounts a component into a DOM node. Returns a cleanup function that
 * unmounts cleanly. The loader caches its result so multiple mounts
 * share one Preact instance.
 *
 * State-heavy surfaces may use Preact through this single shared runtime.
 * Existing tabs, sidebar, file tree, editor frame, and chat stay vanilla.
 *
 * Components written against this helper import from the resolved
 * module returned by `getPreact()`:
 *
 *   import { mountPreact, getPreact } from '../utils/preact-mount.js';
 *   const { html, useState } = await getPreact();
 *   function MyTab() {
 *     const [n, setN] = useState(0);
 *     return html`<button onClick=${() => setN(n + 1)}>${n}</button>`;
 *   }
 *   const cleanup = await mountPreact(rootEl, MyTab, { initial: 0 });
 *   // …later, when the tab is destroyed:
 *   cleanup();
 *
 * @since 1.3.0
 */

// Internal: the active loader. Tests can swap it via _setLoaderForTests.
// Default loader tries the local vendor bundle first, falls back to esm.sh.
async function _defaultLoader() {
    // Local vendor bundle — populated at Docker build time (Dockerfile Stage 1).
    try {
        const bundleUrl = new URL('vendor/preact-htm-bundle.js', document.baseURI).href;
        return await import(bundleUrl);
    } catch (e) {
        console.warn('[preact-mount] Local vendor bundle unavailable, falling back to CDN:', e.message);
    }

    // CDN fallback for dev mode (no Docker build). Mirrors editor/setup.js's
    // CodeMirror fallback pattern. esm.sh provides ESM with auto sub-path resolution.
    const [preact, hooks, htmPreact] = await Promise.all([
        import('https://esm.sh/preact@10'),
        import('https://esm.sh/preact@10/hooks'),
        import('https://esm.sh/htm@3/preact')
    ]);
    return {
        h: preact.h,
        render: preact.render,
        hydrate: preact.hydrate,
        Fragment: preact.Fragment,
        cloneElement: preact.cloneElement,
        createContext: preact.createContext,
        createRef: preact.createRef,
        Component: preact.Component,
        useState: hooks.useState,
        useReducer: hooks.useReducer,
        useEffect: hooks.useEffect,
        useLayoutEffect: hooks.useLayoutEffect,
        useRef: hooks.useRef,
        useMemo: hooks.useMemo,
        useCallback: hooks.useCallback,
        useContext: hooks.useContext,
        useId: hooks.useId,
        html: htmPreact.html
    };
}

let _loader = _defaultLoader;
let _cached = null;
let _loadingPromise = null;

/**
 * Resolve the Preact + htm module surface (cached).
 * @returns {Promise<object>} { h, render, html, useState, useEffect, ... }
 */
export async function getPreact() {
    if (_cached) return _cached;
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
        _cached = await _loader();
        _loadingPromise = null;
        return _cached;
    })();
    return _loadingPromise;
}

/**
 * Mount a Preact component into a DOM node. Returns a cleanup function
 * that unmounts the component (Preact's `render(null, root)`).
 *
 * @param {HTMLElement} rootEl  Slot to mount into.
 * @param {Function}    componentFn  Functional component (or any vnode-producer).
 * @param {object}      [props={}]  Initial props passed to the component.
 * @returns {Promise<() => void>}  Cleanup function. Idempotent — calling it twice is a no-op.
 */
export async function mountPreact(rootEl, componentFn, props = {}) {
    if (!rootEl) throw new Error('mountPreact: rootEl is required');
    if (typeof componentFn !== 'function') throw new Error('mountPreact: componentFn must be a function');
    const { h, render } = await getPreact();
    const vnode = h(componentFn, props);
    render(vnode, rootEl);
    let cleaned = false;
    return function cleanup() {
        if (cleaned) return;
        cleaned = true;
        render(null, rootEl);
    };
}

// ============================================
// Test seam
// ============================================

/**
 * Replace the default loader with a stub. Used by tests/test-preact-mount.mjs
 * to exercise mount/unmount logic without loading Preact in node:test land.
 * Resets the cache so the next `getPreact()` re-runs the loader.
 *
 * @param {() => Promise<object>} fn
 */
export function _setLoaderForTests(fn) {
    _loader = fn;
    _cached = null;
    _loadingPromise = null;
}

/** Restore the default loader (vendor bundle → CDN fallback). */
export function _resetLoaderForTests() {
    _loader = _defaultLoader;
    _cached = null;
    _loadingPromise = null;
}
