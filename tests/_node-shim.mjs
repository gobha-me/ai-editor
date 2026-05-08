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
//
// `createElement` returns an element-like stub that supports the textContent
// → innerHTML round-trip used by `utils/html.js#escapeHtml` (textContent set
// is stored as escaped innerHTML). Without this, `escapeHtml(x)` would return
// `undefined` under Node and any renderer test that exercises an HTML-encoded
// substring would silently pass for the wrong reason.
if (typeof globalThis.document === 'undefined') {
    const _htmlEscape = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => {
            const el = {
                style: {},
                _innerHTML: '',
                setAttribute: () => {},
                appendChild: () => {},
            };
            Object.defineProperty(el, 'textContent', {
                get() { return this._textContent ?? ''; },
                set(v) {
                    this._textContent = v == null ? '' : String(v);
                    this._innerHTML = _htmlEscape(this._textContent);
                },
            });
            Object.defineProperty(el, 'innerHTML', {
                get() { return this._innerHTML; },
                set(v) { this._innerHTML = v == null ? '' : String(v); },
            });
            return el;
        },
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
