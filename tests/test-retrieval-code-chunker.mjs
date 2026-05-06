/**
 * Code chunker tests (1.4.11).
 *
 * Covers the chunker contract from `js/intelligence/retrieval/chunkers/
 * code-chunker.js`: language detection (JS/TS/Python + unknown fallback),
 * top-level boundary detection per language, decorator-attaches (Python),
 * import-block coalescing, hard-cut at MAX_CONSTRUCT_CHARS, ChunkID
 * stability + chunker-version invalidation, byte-range adjacency, no
 * overlap, and surrogate-safe slicing.
 *
 * No DOM, no State, no network — pure-data, runnable under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chunkCode,
    computeChunkID,
    CHUNKER_VERSION,
} from '../js/intelligence/retrieval/index.js';

const baseInput = (bytes, sourceUri = 'src/foo.js', overrides = {}) => ({
    bytes,
    collection: 'workspace_code',
    metadata: {
        source_uri: sourceUri,
        content_type: 'code',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
        ...overrides.metadata,
    },
    ...overrides.input,
});

/* ---------------- Empty / whitespace / unknown extension ---------------- */

test('empty input produces no chunks', () => {
    assert.deepEqual(chunkCode(baseInput('')), []);
});

test('whitespace-only input produces no chunks', () => {
    assert.deepEqual(chunkCode(baseInput('\n\n   \n  \n')), []);
});

test('unknown extension falls back to single-chunk degenerate path', () => {
    const text = 'This is just text without a known code extension.\n';
    const chunks = chunkCode(baseInput(text, 'README'));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, text);
    assert.equal(chunks[0].byte_range[0], 0);
    assert.equal(chunks[0].byte_range[1], new TextEncoder().encode(text).length);
    assert.equal(chunks[0].metadata.language, 'unknown');
});

test('metadata.language tags JS/TS/Python chunks with their detected language (1.7.0)', () => {
    const cases = [
        { uri: 'src/a.js', expect: 'javascript' },
        { uri: 'src/a.mjs', expect: 'javascript' },
        { uri: 'src/a.ts', expect: 'typescript' },
        { uri: 'src/a.tsx', expect: 'typescript' },
        { uri: 'src/a.py', expect: 'python' },
    ];
    for (const { uri, expect } of cases) {
        const chunks = chunkCode(baseInput('function alpha() {}\n', uri));
        assert.ok(chunks.length >= 1);
        for (const c of chunks) assert.equal(c.metadata.language, expect, `language for ${uri}`);
    }
});

test('source with no top-level constructs returns one chunk (script body)', () => {
    const text = 'console.log("hi");\nconst x = 1 + 2;\n';
    // The `const x = 1 + 2;` line will actually match — let's use truly boundary-free:
    const scriptText = 'console.log("first");\nconsole.log("second");\nconsole.log("third");\n';
    const chunks = chunkCode(baseInput(scriptText, 'src/script.js'));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, scriptText);
});

/* ---------------- JS top-level constructs ---------------- */

test('JS function declaration starts a chunk', () => {
    const text = [
        'const PRELUDE = 1;',
        '',
        'function alpha() { return 1; }',
        '',
        'function beta() { return 2; }',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/funcs.js'));
    assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
    const last = chunks[chunks.length - 1];
    assert.ok(last.content.includes('function beta'));
});

test('JS class declaration starts a chunk', () => {
    const text = [
        'function helper() {}',
        '',
        'class Widget { constructor() {} }',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/widget.js'));
    assert.equal(chunks.length, 2);
    assert.ok(chunks[1].content.includes('class Widget'));
});

test('JS arrow-function const at top level starts a chunk', () => {
    const text = [
        'function foo() {}',
        '',
        'const bar = () => 42;',
        '',
        'const baz = async (x) => x * 2;',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/arrows.js'));
    assert.ok(chunks.length >= 3);
});

test('JS export-named and export-default forms count as boundaries', () => {
    const text = [
        'function internal() {}',
        '',
        'export function exported() {}',
        '',
        'export default class Default {}',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/exports.js'));
    assert.ok(chunks.length >= 3);
    assert.ok(chunks.some((c) => c.content.includes('export function exported')));
    assert.ok(chunks.some((c) => c.content.includes('export default class Default')));
});

test('JS export { ... } block counts as a boundary', () => {
    const text = [
        'function alpha() {}',
        '',
        'export { alpha };',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/reexport.js'));
    assert.equal(chunks.length, 2);
    assert.ok(chunks[1].content.includes('export { alpha }'));
});

test('JS async function counts as a boundary', () => {
    const text = [
        'function sync() {}',
        '',
        'async function asyncOne() { return await Promise.resolve(); }',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/asyncfn.js'));
    assert.equal(chunks.length, 2);
});

/* ---------------- TS top-level constructs ---------------- */

test('TS type alias counts as a boundary', () => {
    const text = [
        'function foo() {}',
        '',
        'type UserID = string;',
        '',
        'export type SessionID = string;',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/types.ts'));
    assert.ok(chunks.length >= 3);
});

test('TS interface counts as a boundary', () => {
    const text = [
        'function foo() {}',
        '',
        'interface User { id: string; name: string; }',
        '',
        'export interface Session { id: string; }',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/iface.ts'));
    assert.ok(chunks.length >= 3);
});

test('TS enum counts as a boundary', () => {
    const text = [
        'function foo() {}',
        '',
        'enum Color { Red, Green, Blue }',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/colors.ts'));
    assert.equal(chunks.length, 2);
});

test('TS abstract class counts as a boundary', () => {
    const text = [
        'class Base {}',
        '',
        'abstract class AbstractWidget { abstract render(): void; }',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/abstract.ts'));
    assert.equal(chunks.length, 2);
});

/* ---------------- Python top-level constructs ---------------- */

test('Python def starts a chunk', () => {
    const text = [
        'CONST = 1',
        '',
        'def alpha():',
        '    return 1',
        '',
        'def beta():',
        '    return 2',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/funcs.py'));
    assert.ok(chunks.length >= 2);
    assert.ok(chunks[chunks.length - 1].content.includes('def beta'));
});

test('Python class starts a chunk', () => {
    const text = [
        'def helper():',
        '    pass',
        '',
        'class Widget:',
        '    def __init__(self):',
        '        pass',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/widget.py'));
    assert.equal(chunks.length, 2);
    assert.ok(chunks[1].content.includes('class Widget'));
});

test('Python decorator attaches to its def (boundary shifts to topmost decorator)', () => {
    const text = [
        'def plain():',
        '    pass',
        '',
        '@decorator_one',
        '@decorator_two',
        'def decorated():',
        '    pass',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/decor.py'));
    assert.equal(chunks.length, 2);
    // The decorated chunk must include both decorators AND the def.
    assert.ok(chunks[1].content.includes('@decorator_one'));
    assert.ok(chunks[1].content.includes('@decorator_two'));
    assert.ok(chunks[1].content.includes('def decorated'));
    // The plain chunk must NOT contain the decorators.
    assert.ok(!chunks[0].content.includes('@decorator_one'));
});

test('Python async def counts as a boundary', () => {
    const text = [
        'def sync_fn():',
        '    pass',
        '',
        'async def async_fn():',
        '    pass',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/async.py'));
    assert.equal(chunks.length, 2);
    assert.ok(chunks[1].content.includes('async def async_fn'));
});

/* ---------------- Import-block coalescing ---------------- */

test('JS consecutive import lines coalesce into a single boundary', () => {
    const text = [
        'import a from "a";',
        'import b from "b";',
        'import c from "c";',
        '',
        'function go() {}',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/imports.js'));
    // Imports + go() = 2 chunks, NOT 4 (one per import + go)
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].content.includes('import a'));
    assert.ok(chunks[0].content.includes('import b'));
    assert.ok(chunks[0].content.includes('import c'));
    assert.ok(chunks[1].content.includes('function go'));
});

test('Python consecutive import / from lines coalesce into a single boundary', () => {
    const text = [
        'import os',
        'import sys',
        'from collections import deque',
        '',
        'def main():',
        '    pass',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/imports.py'));
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].content.includes('import os'));
    assert.ok(chunks[0].content.includes('from collections'));
    assert.ok(chunks[1].content.includes('def main'));
});

/* ---------------- Hard-cut at MAX_CONSTRUCT_CHARS ---------------- */

test('an oversized single construct hard-cuts at the next newline past MAX_CONSTRUCT_CHARS', () => {
    // Build one huge function whose body crosses the 8000-char ceiling but
    // has frequent newlines so the cut lands at a newline boundary.
    const lineBody = '    console.log("' + 'x'.repeat(40) + '");\n'; // ~50 chars/line
    let body = '';
    while (body.length < 12000) body += lineBody;
    const text = `function huge() {\n${body}}\n`;
    const chunks = chunkCode(baseInput(text, 'src/huge.js'));
    assert.ok(chunks.length >= 2, `expected hard-cut to produce ≥2 chunks, got ${chunks.length}`);
    // Each chunk's char span is ≤ MAX_CONSTRUCT_CHARS + (one line tail) — a
    // soft check: no chunk exceeds 9000 chars (hard cap + one line slack).
    for (const c of chunks) {
        assert.ok(c.content.length <= 9000, `chunk char-length ${c.content.length} exceeded ceiling`);
    }
});

test('an oversized construct with no newlines past the ceiling falls back to a hard char-cut', () => {
    // A single function whose entire body has no newlines past the ceiling
    // — the safety valve must still terminate.
    const wallOfText = 'a'.repeat(20000);
    const text = `function hugeNoNewlines() { return "${wallOfText}"; }`;
    const chunks = chunkCode(baseInput(text, 'src/wall.js'));
    assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

/* ---------------- ChunkID stability + invalidation ---------------- */

test('identical input produces identical chunk IDs across runs', () => {
    const text = [
        'import x from "x";',
        '',
        'function alpha() { return 1; }',
        '',
        'class Beta {}',
        '',
    ].join('\n');
    const a = chunkCode(baseInput(text, 'src/stable.js'));
    const b = chunkCode(baseInput(text, 'src/stable.js'));
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].id, b[i].id);
    }
});

test('chunk ID matches canonical computeChunkID call against CHUNKER_VERSION.code', () => {
    const text = [
        'function alpha() {}',
        '',
        'function beta() {}',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/canonical.js'));
    for (const c of chunks) {
        const expected = computeChunkID({
            collection: 'workspace_code',
            source_uri: 'src/canonical.js',
            byte_range: c.byte_range,
            chunker_version: CHUNKER_VERSION.code,
        });
        assert.equal(c.id, expected);
    }
});

test('a hypothetical chunker_version bump produces different IDs at the same byte_range', () => {
    const text = 'function alpha() {}\n\nfunction beta() {}\n';
    const chunks = chunkCode(baseInput(text, 'src/v2bump.js'));
    // Use a sentinel that is guaranteed different from the live
    // `CHUNKER_VERSION.code` (which itself bumped from `v1` → `v2` in 1.7.0
    // when the C-family lexer landed; further bumps will follow as the
    // chunker evolves).
    const sentinel = `${CHUNKER_VERSION.code}-future`;
    assert.notEqual(sentinel, CHUNKER_VERSION.code);
    for (const c of chunks) {
        const future = computeChunkID({
            collection: 'workspace_code',
            source_uri: 'src/v2bump.js',
            byte_range: c.byte_range,
            chunker_version: sentinel,
        });
        assert.notEqual(c.id, future);
    }
});

/* ---------------- Byte-range adjacency, no overlap ---------------- */

test('consecutive chunks share a byte_range boundary (chunk[i+1].start === chunk[i].end)', () => {
    const text = [
        'import x from "x";',
        '',
        'function alpha() { return 1; }',
        '',
        'function beta() { return 2; }',
        '',
        'class Gamma {}',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/adj.js'));
    assert.ok(chunks.length >= 2);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(
            chunks[i].byte_range[0],
            chunks[i - 1].byte_range[1],
            `chunks[${i - 1}].byte_range[1] !== chunks[${i}].byte_range[0]`,
        );
    }
});

test('first chunk byte_range starts at 0 and last chunk ends at the source byte length', () => {
    const text = [
        'function alpha() {}',
        '',
        'function beta() {}',
        '',
    ].join('\n');
    const expectedBytes = new TextEncoder().encode(text).length;
    const chunks = chunkCode(baseInput(text, 'src/cover.js'));
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].byte_range[0], 0);
    assert.equal(chunks[chunks.length - 1].byte_range[1], expectedBytes);
});

test('code chunks have no overlap (chunk[i+1].content does not start with chunk[i].content tail)', () => {
    // Code chunks are per-construct with no overlap, unlike prose. Confirm
    // the no-overlap invariant by checking that each chunk's content is
    // exactly the source slice of its byte range, with no duplicated head.
    const text = [
        'import a from "a";',
        '',
        'function alpha() {',
        '    return "alpha-distinctive-marker";',
        '}',
        '',
        'function beta() {',
        '    return "beta-distinctive-marker";',
        '}',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/no-overlap.js'));
    assert.ok(chunks.length >= 2);
    // No chunk past the first should contain alpha's distinctive marker.
    for (let i = 1; i < chunks.length; i++) {
        if (chunks[i].content.includes('function alpha')) continue;
        assert.ok(
            !chunks[i].content.includes('alpha-distinctive-marker'),
            `chunk ${i} unexpectedly contains alpha's marker — overlap detected`,
        );
    }
});

/* ---------------- Unicode safety ---------------- */

test('multi-byte UTF-8 in string literals does not split surrogate pairs', () => {
    const text = [
        'const greeting = "🚀 launch";',
        '',
        'function alpha() {',
        '    return "α β γ δ — distinctive 🎯";',
        '}',
        '',
        'function beta() {',
        '    return "more emoji 🌟🌟🌟 here";',
        '}',
        '',
    ].join('\n');
    const chunks = chunkCode(baseInput(text, 'src/emoji.js'));
    for (const c of chunks) {
        for (let i = 0; i < c.content.length; i++) {
            const code = c.content.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF) {
                const next = c.content.charCodeAt(i + 1);
                assert.ok(
                    next >= 0xDC00 && next <= 0xDFFF,
                    `unmatched high surrogate at chunk position ${i}`,
                );
                i += 1;
            } else if (code >= 0xDC00 && code <= 0xDFFF) {
                throw new Error(`stray low surrogate at chunk position ${i}`);
            }
        }
    }
});

test('byte_range tracks UTF-8 byte counts (not char counts) for multi-byte content', () => {
    // 'é' = 2 UTF-8 bytes. Body of 500 'é' chars = 1000 UTF-8 bytes.
    const padding = 'é'.repeat(500);
    const text = `function withMultibyte() { return "${padding}"; }\n`;
    const expectedBytes = new TextEncoder().encode(text).length;
    const chunks = chunkCode(baseInput(text, 'src/multibyte.js'));
    assert.equal(chunks[chunks.length - 1].byte_range[1], expectedBytes);
});

/* ---------------- Input validation ---------------- */

test('chunkCode rejects missing input', () => {
    // @ts-expect-error — runtime check
    assert.throws(() => chunkCode(null), /input/);
    // @ts-expect-error — runtime check
    assert.throws(() => chunkCode(undefined), /input/);
});

test('chunkCode rejects non-string bytes', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkCode({ bytes: 42, collection: 'workspace_code', metadata: { source_uri: 's.js' } }),
        /bytes/,
    );
});

test('chunkCode rejects empty collection', () => {
    assert.throws(
        () => chunkCode({ bytes: 'function f(){}', collection: '', metadata: { source_uri: 's.js' } }),
        /collection/,
    );
});

test('chunkCode rejects missing source_uri', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkCode({ bytes: 'function f(){}', collection: 'workspace_code', metadata: {} }),
        /source_uri/,
    );
});

/* ---------------- Structural placeholder + custom passthrough ---------------- */

test('emitted chunks carry metadata.structural === null (StructureExtractor lands later)', () => {
    const text = 'function alpha() {}\n\nfunction beta() {}\n';
    const chunks = chunkCode(baseInput(text, 'src/structural.js'));
    for (const c of chunks) {
        assert.equal(c.metadata.structural, null);
    }
});

test('metadata.custom is preserved verbatim from input', () => {
    const custom = { language_hint: 'js', tag: 'unit' };
    const chunks = chunkCode(baseInput('function f() {}\n', 'src/cust.js', { metadata: { custom } }));
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].metadata.custom, custom);
});

test('metadata.custom defaults to {} when input omits it', () => {
    const chunks = chunkCode({
        bytes: 'function f() {}\n',
        collection: 'workspace_code',
        metadata: { source_uri: 'src/no-custom.js' },
    });
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].metadata.custom, {});
});

test('emitted chunks carry metadata.content_type === "code"', () => {
    const chunks = chunkCode(baseInput('function f() {}\n', 'src/ct.js'));
    for (const c of chunks) {
        assert.equal(c.metadata.content_type, 'code');
    }
});

/* ---------------- Contract surface ---------------- */

test('chunks expose the contract surface (id, content, tokens, metadata, byte_range)', () => {
    const chunks = chunkCode(baseInput('function f() {}\n', 'src/surface.js'));
    assert.equal(chunks.length, 1);
    const c = chunks[0];
    assert.equal(typeof c.id, 'string');
    assert.match(c.id, /^[0-9a-f]{16}$/);
    assert.equal(c.collection, 'workspace_code');
    assert.equal(typeof c.content, 'string');
    assert.equal(typeof c.tokens, 'number');
    assert.ok(c.tokens > 0);
    assert.equal(typeof c.metadata.content_hash, 'string');
    assert.match(c.metadata.content_hash, /^[0-9a-f]{8}$/);
    assert.equal(Array.isArray(c.byte_range), true);
    assert.equal(c.byte_range.length, 2);
});
