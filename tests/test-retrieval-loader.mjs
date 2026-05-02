/**
 * Loader tests (1.4.21).
 *
 * Covers `js/intelligence/retrieval/loader.js` — the source-fetching seam
 * per DESIGN-retrieval lines 273-275. Three exports under test:
 *
 *   - `detectContentType(source_uri)` — pure extension-dispatch helper.
 *   - `computeSourceHash(bytes)` — change-detection fingerprint
 *     (FNV-1a-twice, 16-char hex).
 *   - `createLoader({ fetchBytes, contentTypeOverride? })` — factory
 *     returning a Loader handle that produces the four-tuple
 *     `(bytes, source_uri, content_hash, content_type_hint)`.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`. Mirrors
 * the sibling test files (`test-retrieval-store.mjs`,
 * `test-retrieval-pipeline.mjs`, …): each `test()` block is focused on a
 * single invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createLoader,
    detectContentType,
    computeSourceHash,
} from '../js/intelligence/retrieval/loader.js';

/* ---------------- detectContentType: extension table ---------------- */

test('detectContentType: code extensions (JS/TS family)', () => {
    for (const uri of [
        'src/main.js',
        'src/main.mjs',
        'src/main.cjs',
        'src/component.jsx',
        'src/main.ts',
        'src/component.tsx',
    ]) {
        assert.equal(detectContentType(uri), 'code', uri);
    }
});

test('detectContentType: code extensions (Python family)', () => {
    for (const uri of ['module.py', 'script.pyw', 'stubs.pyi']) {
        assert.equal(detectContentType(uri), 'code', uri);
    }
});

test('detectContentType: prose extensions', () => {
    for (const uri of ['README.md', 'notes.markdown', 'plain.txt', 'doc.rst']) {
        assert.equal(detectContentType(uri), 'prose', uri);
    }
});

test('detectContentType: structured extensions', () => {
    for (const uri of ['data.json', 'log.jsonl', 'log.ndjson']) {
        assert.equal(detectContentType(uri), 'structured', uri);
    }
});

test('detectContentType: case-insensitive on extension', () => {
    assert.equal(detectContentType('FOO.JS'), 'code');
    assert.equal(detectContentType('Notes.MD'), 'prose');
    assert.equal(detectContentType('data.JSON'), 'structured');
});

test('detectContentType: unknown extension returns null', () => {
    assert.equal(detectContentType('archive.zip'), null);
    assert.equal(detectContentType('image.png'), null);
    assert.equal(detectContentType('binary.bin'), null);
});

test('detectContentType: no extension returns null', () => {
    assert.equal(detectContentType('Makefile'), null);
    assert.equal(detectContentType('LICENSE'), null);
    assert.equal(detectContentType('README'), null);
});

test('detectContentType: dotfiles (no extension) return null', () => {
    assert.equal(detectContentType('.gitignore'), null);
    assert.equal(detectContentType('src/.eslintrc'), null);
});

test('detectContentType: trailing dot returns null', () => {
    assert.equal(detectContentType('weird.'), null);
});

test('detectContentType: multi-dot path uses last extension', () => {
    assert.equal(detectContentType('foo.test.js'), 'code');
    assert.equal(detectContentType('archive.tar.json'), 'structured');
});

test('detectContentType: query string and fragment are stripped before lookup', () => {
    assert.equal(detectContentType('memory://x.json?v=1'), 'structured');
    assert.equal(detectContentType('memory://x.json#frag'), 'structured');
    assert.equal(detectContentType('memory://x.json?v=1#frag'), 'structured');
});

test('detectContentType: invalid input returns null', () => {
    // @ts-expect-error -- intentional bad input
    assert.equal(detectContentType(null), null);
    // @ts-expect-error -- intentional bad input
    assert.equal(detectContentType(undefined), null);
    // @ts-expect-error -- intentional bad input
    assert.equal(detectContentType(42), null);
    assert.equal(detectContentType(''), null);
});

test('detectContentType: URI scheme without extension returns null', () => {
    assert.equal(detectContentType('memory://session-123/conversation'), null);
    assert.equal(detectContentType('git://owner/repo/blob/main/Makefile'), null);
});

/* ---------------- computeSourceHash ---------------- */

test('computeSourceHash: returns 16-character lowercase hex string', () => {
    const h = computeSourceHash('hello world');
    assert.equal(typeof h, 'string');
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]{16}$/);
});

test('computeSourceHash: deterministic — same bytes → same hash', () => {
    const a = computeSourceHash('the quick brown fox');
    const b = computeSourceHash('the quick brown fox');
    assert.equal(a, b);
});

test('computeSourceHash: detects single-character mutation', () => {
    const a = computeSourceHash('the quick brown fox');
    const b = computeSourceHash('the quick brown box');
    assert.notEqual(a, b);
});

test('computeSourceHash: empty string maps to fixed sentinel', () => {
    assert.equal(computeSourceHash(''), '0000000000000000');
});

test('computeSourceHash: rejects non-string input', () => {
    // @ts-expect-error -- intentional bad input
    assert.throws(() => computeSourceHash(null), /computeSourceHash: bytes must be a string/);
    // @ts-expect-error -- intentional bad input
    assert.throws(() => computeSourceHash(123), /computeSourceHash: bytes must be a string/);
    // @ts-expect-error -- intentional bad input
    assert.throws(
        () => computeSourceHash(Buffer.from('x')),
        /computeSourceHash: bytes must be a string/,
    );
});

test('computeSourceHash: handles multi-byte UTF-8 input deterministically', () => {
    const a = computeSourceHash('héllo wörld 🌍');
    const b = computeSourceHash('héllo wörld 🌍');
    assert.equal(a, b);
    assert.equal(a.length, 16);
});

/* ---------------- createLoader: factory validation ---------------- */

test('createLoader: returns a handle with a single async load method', () => {
    const loader = createLoader({ fetchBytes: async () => 'x' });
    assert.equal(typeof loader.load, 'function');
});

test('createLoader: missing options throws', () => {
    // @ts-expect-error -- intentional bad input
    assert.throws(() => createLoader(), /createLoader: options must be an object/);
    // @ts-expect-error -- intentional bad input
    assert.throws(() => createLoader(null), /createLoader: options must be an object/);
});

test('createLoader: missing fetchBytes throws', () => {
    // @ts-expect-error -- intentional bad input
    assert.throws(() => createLoader({}), /createLoader: fetchBytes must be a function/);
});

test('createLoader: non-function fetchBytes throws', () => {
    assert.throws(
        // @ts-expect-error -- intentional bad input
        () => createLoader({ fetchBytes: 'not-a-function' }),
        /createLoader: fetchBytes must be a function/,
    );
});

test('createLoader: non-function contentTypeOverride throws', () => {
    assert.throws(
        () =>
            createLoader({
                fetchBytes: async () => 'x',
                // @ts-expect-error -- intentional bad input
                contentTypeOverride: 'not-a-function',
            }),
        /createLoader: contentTypeOverride must be a function when provided/,
    );
});

/* ---------------- createLoader: load() shape and behavior ---------------- */

test('load: returns the documented four-tuple shape', async () => {
    const loader = createLoader({ fetchBytes: async () => 'console.log("hi");' });
    const result = await loader.load('src/main.js');
    assert.deepEqual(Object.keys(result).sort(), [
        'bytes',
        'content_hash',
        'content_type_hint',
        'source_uri',
    ]);
});

test('load: bytes equals what fetchBytes returned', async () => {
    const payload = '# Heading\n\nbody text';
    const loader = createLoader({ fetchBytes: async () => payload });
    const result = await loader.load('docs/note.md');
    assert.equal(result.bytes, payload);
});

test('load: source_uri echoes the input verbatim', async () => {
    const loader = createLoader({ fetchBytes: async () => 'x' });
    const result = await loader.load('git://owner/repo/blob/main/src/main.js');
    assert.equal(result.source_uri, 'git://owner/repo/blob/main/src/main.js');
});

test('load: content_hash matches computeSourceHash(bytes)', async () => {
    const payload = 'function add(a, b) { return a + b; }';
    const loader = createLoader({ fetchBytes: async () => payload });
    const result = await loader.load('src/util.js');
    assert.equal(result.content_hash, computeSourceHash(payload));
});

test('load: content_type_hint derived from extension when no override', async () => {
    const loader = createLoader({ fetchBytes: async () => '{}' });
    const result = await loader.load('config.json');
    assert.equal(result.content_type_hint, 'structured');
});

test('load: contentTypeOverride wins over extension detection', async () => {
    const loader = createLoader({
        fetchBytes: async () => '[{"role":"user","content":"hi"}]',
        contentTypeOverride: () => 'conversation',
    });
    const result = await loader.load('history.json');
    assert.equal(result.content_type_hint, 'conversation');
});

test('load: contentTypeOverride returning null falls back to extension detection', async () => {
    const loader = createLoader({
        fetchBytes: async () => '{}',
        contentTypeOverride: () => null,
    });
    const result = await loader.load('config.json');
    assert.equal(result.content_type_hint, 'structured');
});

test('load: contentTypeOverride enables extension-less URIs (e.g. memory://)', async () => {
    const loader = createLoader({
        fetchBytes: async () => '[]',
        contentTypeOverride: (uri) => (uri.startsWith('memory://') ? 'conversation' : null),
    });
    const result = await loader.load('memory://session-abc/turns');
    assert.equal(result.content_type_hint, 'conversation');
});

test('load: unknown extension and no override throws', async () => {
    const loader = createLoader({ fetchBytes: async () => 'binary-ish' });
    await assert.rejects(
        () => loader.load('archive.zip'),
        /createLoader\.load: unknown content_type for source_uri "archive\.zip"/,
    );
});

test('load: empty source_uri throws TypeError', async () => {
    const loader = createLoader({ fetchBytes: async () => 'x' });
    await assert.rejects(
        () => loader.load(''),
        /createLoader\.load: source_uri must be a non-empty string/,
    );
});

test('load: non-string source_uri throws TypeError', async () => {
    const loader = createLoader({ fetchBytes: async () => 'x' });
    await assert.rejects(
        // @ts-expect-error -- intentional bad input
        () => loader.load(null),
        /createLoader\.load: source_uri must be a non-empty string/,
    );
    await assert.rejects(
        // @ts-expect-error -- intentional bad input
        () => loader.load(123),
        /createLoader\.load: source_uri must be a non-empty string/,
    );
});

test('load: fetchBytes rejection propagates uncaught', async () => {
    const failure = new Error('network down');
    const loader = createLoader({
        fetchBytes: async () => {
            throw failure;
        },
    });
    await assert.rejects(() => loader.load('src/main.js'), (err) => err === failure);
});

test('load: fetchBytes returning non-string rejects with TypeError', async () => {
    // @ts-expect-error -- intentional bad return
    const loader = createLoader({ fetchBytes: async () => 12345 });
    await assert.rejects(
        () => loader.load('src/main.js'),
        /createLoader\.load: fetchBytes must resolve to a string \(got number\)/,
    );
});

test('load: fetchBytes returning a Buffer rejects with TypeError', async () => {
    const loader = createLoader({
        // @ts-expect-error -- intentional bad return
        fetchBytes: async () => Buffer.from('hello', 'utf8'),
    });
    await assert.rejects(
        () => loader.load('src/main.js'),
        /createLoader\.load: fetchBytes must resolve to a string \(got object\)/,
    );
});

test('load: empty bytes still produces a valid four-tuple', async () => {
    const loader = createLoader({ fetchBytes: async () => '' });
    const result = await loader.load('empty.md');
    assert.equal(result.bytes, '');
    assert.equal(result.content_hash, '0000000000000000');
    assert.equal(result.content_type_hint, 'prose');
    assert.equal(result.source_uri, 'empty.md');
});

test('load: contentTypeOverride is invoked with the source_uri', async () => {
    const calls = [];
    const loader = createLoader({
        fetchBytes: async () => 'x',
        contentTypeOverride: (uri) => {
            calls.push(uri);
            return 'prose';
        },
    });
    await loader.load('whatever');
    assert.deepEqual(calls, ['whatever']);
});

test('load: fetchBytes is invoked with the source_uri', async () => {
    const calls = [];
    const loader = createLoader({
        fetchBytes: async (uri) => {
            calls.push(uri);
            return '';
        },
    });
    await loader.load('docs/x.md');
    assert.deepEqual(calls, ['docs/x.md']);
});

/* ---------------- createLoader: stateless across calls ---------------- */

test('load: two loads on the same URI produce identical four-tuples', async () => {
    let n = 0;
    const loader = createLoader({
        fetchBytes: async () => {
            n += 1;
            return 'stable bytes';
        },
    });
    const a = await loader.load('docs/x.md');
    const b = await loader.load('docs/x.md');
    assert.equal(n, 2, 'fetchBytes is invoked per call (no internal cache)');
    assert.deepEqual(a, b);
});
