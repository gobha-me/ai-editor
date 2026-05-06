/**
 * Code chunker — C-family boundary tests (1.7.0).
 *
 * Covers the brace-depth-aware lexer added in
 * `js/intelligence/retrieval/chunkers/code-chunker.js#findCFamilyBoundaries`
 * for `.c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx`. Phase 1 design: emit one chunk
 * per top-level declaration (or class/struct body); transparent
 * `namespace`/`extern "C"` blocks; comment- and string-aware brace
 * tracking; multi-line preprocessor directives stay attached.
 *
 * Integration coverage: the four currently-zero Plinth fixtures from
 * `tests/run-polyglot-benchmark.mjs` — `capability-registry-api`,
 * `rbac-enforcement-filter`, `realtime-pubsub-broker`, `audit-logging-write`
 * — are the reference cases that motivated the lexer. Re-run the
 * benchmark for end-to-end coverage; this file is the unit floor.
 *
 * Pure-data, runnable under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkCode } from '../js/intelligence/retrieval/index.js';

const cppInput = (bytes, sourceUri = 'src/sample.cpp') => ({
    bytes,
    collection: 'workspace_code',
    metadata: {
        source_uri: sourceUri,
        content_type: 'code',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
    },
});

/* ---------------- Extension routing ---------------- */

test('C-family extensions tag chunks with metadata.language=cfamily', () => {
    const exts = ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx'];
    for (const ext of exts) {
        const chunks = chunkCode(cppInput('void foo() {}\n', `src/sample.${ext}`));
        assert.ok(chunks.length >= 1, `expected ≥1 chunk for .${ext}`);
        for (const c of chunks) {
            assert.equal(c.metadata.language, 'cfamily', `.${ext} should map to cfamily`);
            assert.equal(c.metadata.content_type, 'code');
        }
    }
});

/* ---------------- Top-level free functions ---------------- */

test('two top-level free functions split into separate chunks', () => {
    const text = [
        '#include <cstddef>',
        '',
        'int alpha(int x) {',
        '    return x + 1;',
        '}',
        '',
        'int beta(int y) {',
        '    return y * 2;',
        '}',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/funcs.cpp'));
    assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
    const containsAlpha = chunks.some((c) => c.content.includes('int alpha'));
    const containsBeta = chunks.some((c) => c.content.includes('int beta'));
    assert.ok(containsAlpha && containsBeta);
    // The chunk that contains beta should NOT contain alpha (separation).
    const betaChunk = chunks.find((c) => c.content.includes('int beta'));
    assert.ok(!betaChunk.content.includes('int alpha'),
        'beta chunk should not contain alpha — proves the lexer split between them');
});

/* ---------------- Class with members → one chunk per class ---------------- */

test('class with three member functions produces one chunk for the class body', () => {
    const text = [
        'class Foo {',
        'public:',
        '    int bar(int x) { return x; }',
        '    int baz(int y) { return y; }',
        '    int qux(int z) { return z; }',
        '};',
        '',
        'int sibling() { return 0; }',
        ''
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/foo.cpp'));
    // Two chunks expected: the class body, then `int sibling()`.
    assert.equal(chunks.length, 2,
        `expected 2 chunks (class + sibling), got ${chunks.length}`);
    const classChunk = chunks.find((c) => c.content.includes('class Foo'));
    assert.ok(classChunk, 'class chunk should exist');
    assert.ok(classChunk.content.includes('bar') && classChunk.content.includes('baz') && classChunk.content.includes('qux'),
        'class chunk groups all three members');
    const siblingChunk = chunks.find((c) => c.content.includes('int sibling'));
    assert.ok(siblingChunk, 'sibling chunk should exist');
    assert.ok(!siblingChunk.content.includes('class Foo'),
        'sibling should not contain class Foo');
});

/* ---------------- Namespace transparency ---------------- */

test('namespace block contents are chunked at top level (transparent)', () => {
    const text = [
        'namespace plinth {',
        '',
        'int alpha(int x) { return x; }',
        '',
        'int beta(int y) { return y; }',
        '',
        '} // namespace plinth',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/ns.cpp'));
    // Namespace transparent: alpha and beta should be separate chunks.
    assert.ok(chunks.length >= 2,
        `expected ≥2 chunks under transparent namespace, got ${chunks.length}`);
    const betaChunk = chunks.find((c) => c.content.includes('int beta'));
    assert.ok(betaChunk && !betaChunk.content.includes('int alpha'),
        'transparent namespace must split sibling decls');
});

test('nested namespaces remain transparent on their own lines', () => {
    const text = [
        'namespace plinth {',
        'namespace auth {',
        '',
        'int alpha() { return 1; }',
        '',
        'int beta() { return 2; }',
        '',
        '} // namespace auth',
        '} // namespace plinth',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/nested-ns.cpp'));
    const betaChunk = chunks.find((c) => c.content.includes('int beta'));
    assert.ok(betaChunk && !betaChunk.content.includes('int alpha'),
        'nested namespaces (each on its own line) must stay transparent');
});

test('extern "C" block contents are chunked at top level', () => {
    const text = [
        '#ifndef FOO_H',
        '#define FOO_H',
        '',
        'extern "C" {',
        '',
        'void c_alpha(int x);',
        'void c_beta(int y);',
        '',
        '}  // extern "C"',
        '',
        '#endif',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/extern_c.h'));
    const hasBeta = chunks.some((c) => c.content.includes('c_beta'));
    assert.ok(hasBeta, 'extern "C" body must produce chunks for its decls');
    // Number of chunks ≥ 2 (alpha + beta separate).
    const betaChunk = chunks.find((c) => c.content.includes('c_beta'));
    assert.ok(!betaChunk.content.includes('c_alpha'),
        'extern "C" must split sibling forward decls');
});

/* ---------------- Templates / attributes ---------------- */

test('template declaration prefix attaches to the templated class', () => {
    const text = [
        'template <typename T>',
        'class Vec {',
        'public:',
        '    void push(T item);',
        '};',
        '',
        'int sibling() { return 0; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/templ.hpp'));
    const classChunk = chunks.find((c) => c.content.includes('class Vec'));
    assert.ok(classChunk, 'class Vec chunk exists');
    // The `template <typename T>` line should ride with the class chunk —
    // it is not itself an ending boundary (no `;`/`}` after it; line ends
    // in `>`). The chunker treats the next code line as continuation of
    // the templated decl.
    assert.ok(classChunk.content.includes('template'),
        'template prefix attaches to the class');
});

test('attribute specifier on its own line attaches to the next decl', () => {
    const text = [
        'int prelude() { return 0; }',
        '',
        '[[nodiscard]]',
        'int annotated(int x) { return x; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/attr.cpp'));
    const annotatedChunk = chunks.find((c) => c.content.includes('int annotated'));
    assert.ok(annotatedChunk, 'annotated chunk exists');
    assert.ok(annotatedChunk.content.includes('[[nodiscard]]'),
        '[[nodiscard]] walks back into the annotated chunk');
});

/* ---------------- Comments / strings / preprocessor ---------------- */

test('doc comment block walks back to attach to the next decl', () => {
    const text = [
        'int prelude() { return 0; }',
        '',
        '/**',
        ' * Computes the answer.',
        ' */',
        'int answered() { return 42; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/doc.cpp'));
    const annotatedChunk = chunks.find((c) => c.content.includes('int answered'));
    assert.ok(annotatedChunk.content.includes('Computes the answer'),
        'doc comment block attaches to its decl');
});

test('string literal containing a brace does not perturb depth', () => {
    const text = [
        'const char* a = "alpha {{ should not bump }}";',
        '',
        'int after_string() { return 0; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/str.cpp'));
    // Both decls produce chunks; the `after_string` chunk should not be
    // swallowed by the string-literal "block".
    const hasAfter = chunks.some((c) => c.content.includes('int after_string'));
    assert.ok(hasAfter, 'string-literal braces must not perturb tracking');
});

test('raw string with embedded braces does not perturb depth', () => {
    const text = [
        'const char* a = R"x({{{ raw {{ braces }} }}}x";',
        '',
        'int after_raw() { return 0; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/raw.cpp'));
    const hasAfter = chunks.some((c) => c.content.includes('int after_raw'));
    assert.ok(hasAfter, 'raw-string braces must not perturb tracking');
});

test('block comment containing braces does not perturb depth', () => {
    const text = [
        '/* a comment with { and } inside */',
        '',
        'int alpha() { return 1; }',
        '',
        '/* another { with } */ int beta() { return 2; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/cmt.cpp'));
    const hasAlpha = chunks.some((c) => c.content.includes('int alpha'));
    const hasBeta = chunks.some((c) => c.content.includes('int beta'));
    assert.ok(hasAlpha && hasBeta);
});

test('multi-line preprocessor directive stays a single non-boundary block', () => {
    const text = [
        '#define FOO(x) \\',
        '    do { (x) + 1; } while (0)',
        '',
        'int after_macro() { return 0; }',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/macro.cpp'));
    // The macro's `\\\n`-continued body contains `do { ... }`. The lexer
    // must not let those braces affect depth, and must not split between
    // the two physical lines of the macro.
    const hasAfter = chunks.some((c) => c.content.includes('int after_macro'));
    assert.ok(hasAfter, 'preprocessor continuation must not derail the lexer');
});

/* ---------------- Header / impl symmetry ---------------- */

test('header file with forward decls + class produces multiple chunks', () => {
    // Mirrors the shape of `src/kernel/realtime/broker.hpp` —
    // one of the four Plinth fixtures the gate cited.
    const text = [
        '#pragma once',
        '',
        '#include <memory>',
        '',
        'namespace plinth::realtime {',
        '',
        'class Broker;',
        '',
        'struct Event {',
        '    int code;',
        '};',
        '',
        'class Listener {',
        'public:',
        '    void on_event(const Event&);',
        '};',
        '',
        '} // namespace plinth::realtime',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/kernel/realtime/broker.hpp'));
    // Forward decl + Event struct + Listener class = at least 2 distinct
    // chunks under the transparent namespace.
    assert.ok(chunks.length >= 2,
        `expected ≥2 chunks for header with multiple decls, got ${chunks.length}`);
    const eventChunk = chunks.find((c) => c.content.includes('struct Event'));
    const listenerChunk = chunks.find((c) => c.content.includes('class Listener'));
    assert.ok(eventChunk && listenerChunk,
        'Event struct and Listener class should each have a chunk');
});

/* ---------------- byte_range invariants ---------------- */

test('chunks have non-overlapping ascending byte ranges', () => {
    const text = [
        'namespace foo {',
        'int alpha() { return 1; }',
        'int beta() { return 2; }',
        'int gamma() { return 3; }',
        '} // namespace',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/multi.cpp'));
    let prevEnd = 0;
    for (const c of chunks) {
        assert.ok(c.byte_range[0] >= prevEnd,
            `chunk byte_range[0]=${c.byte_range[0]} must be ≥ prev end ${prevEnd}`);
        assert.ok(c.byte_range[1] > c.byte_range[0], 'byte_range must be non-empty');
        prevEnd = c.byte_range[1];
    }
});

test('concatenating chunks reconstructs the source byte-for-byte', () => {
    const text = [
        '#include <foo.h>',
        '',
        'int alpha(int x) {',
        '    return x;',
        '}',
        '',
        '/// doc',
        'int beta(int y) {',
        '    return y * 2;',
        '}',
        '',
    ].join('\n');
    const chunks = chunkCode(cppInput(text, 'src/concat.cpp'));
    const reconstructed = chunks.map((c) => c.content).join('');
    assert.equal(reconstructed, text, 'chunk contents must reconstitute the source');
});

/* ---------------- Empty / pathological ---------------- */

test('empty C++ file produces no chunks', () => {
    assert.deepEqual(chunkCode(cppInput('', 'src/empty.cpp')), []);
});

test('comment-only file produces a single chunk', () => {
    const text = '// just a comment\n// and another\n';
    const chunks = chunkCode(cppInput(text, 'src/cmts.cpp'));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, text);
});

test('single function with no top-level prelude produces one chunk', () => {
    const text = 'void only() {\n    return;\n}\n';
    const chunks = chunkCode(cppInput(text, 'src/only.cpp'));
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].content.includes('void only'));
});
