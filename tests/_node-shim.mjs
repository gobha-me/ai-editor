/**
 * Minimal browser-globals shim for `node --test`.
 *
 * Imported by .mjs tests whose transitive imports touch js/core.js or js/git.js,
 * which reference `window`, `localStorage`, `indexedDB`, or `document` at
 * module-eval or method-invocation time. The .js sibling tests run in a real
 * browser via tests/index.html; under Node they need these stubs first.
 *
 * Side-effect-only module — `import './_node-shim.mjs';` once at the top of
 * the consumer file, before any `import { ... } from '../js/...'`.
 *
 * Keep this file SMALL and DUMB. We are not pretending to be jsdom. If a test
 * needs more than this shim provides, that test belongs in the browser suite
 * (tests/index.html) — skip it under Node with `test.skip()` and a comment.
 */

// `window` — used by core.js at top level for addEventListener('beforeunload')
// and to expose window.AIEditor for external plugins.
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
if (typeof globalThis.window.addEventListener !== 'function') {
    globalThis.window.addEventListener = () => {};
}
if (typeof globalThis.window.removeEventListener !== 'function') {
    globalThis.window.removeEventListener = () => {};
}

// `localStorage` — Map-backed in-memory Storage stub. Survives gets/sets
// within a single test process; not persisted.
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

// `indexedDB` — never-resolving open() stub. Tests that exercise IDB code
// paths should be browser-only; this is just enough to keep imports alive.
if (typeof globalThis.indexedDB === 'undefined') {
    globalThis.indexedDB = {
        open: () => ({
            onsuccess: null,
            onerror: null,
            onupgradeneeded: null,
            onblocked: null,
            result: null,
        }),
        deleteDatabase: () => ({ onsuccess: null, onerror: null }),
    };
}

// `document` — empty stub. getElementById returns null so DOM-poking tests
// either no-op or hit the null branch.
if (typeof globalThis.document === 'undefined') {
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
        body: null,
        head: null,
    };
}

// `navigator` — read by some provider modules.
if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = { userAgent: 'node', language: 'en-US' };
}
