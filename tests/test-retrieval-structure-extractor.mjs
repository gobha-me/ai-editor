/**
 * StructureExtractor tests (1.4.14).
 *
 * Covers `js/intelligence/retrieval/structure-extractor.js` per
 * `docs/DESIGN-retrieval.md` §"StructureExtractor": prose heading
 * hierarchy, code declaration-kind labeling, no-op passthrough for
 * conversation/structured/spec, and mixed-content_type rejection. Inputs
 * are real outputs from the chunkers that ship in 1.4.10–1.4.13 so the
 * extractor's contract is exercised against the chunkers' real shapes.
 *
 * No DOM, no State, no network — pure-data, runnable under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chunkProse,
    chunkCode,
    chunkConversation,
    chunkStructured,
    extractStructure,
} from '../js/intelligence/retrieval/index.js';

const proseInput = (bytes, overrides = {}) => ({
    bytes,
    collection: 'docs',
    metadata: {
        source_uri: overrides.source_uri || 'docs/test.md',
        content_type: 'prose',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
    },
});

const codeInput = (bytes, source_uri = 'src/test.js') => ({
    bytes,
    collection: 'code',
    metadata: {
        source_uri,
        content_type: 'code',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
    },
});

/* ---------------- Empty + non-array inputs ---------------- */

test('empty array returns empty array (identity, not a fresh object)', () => {
    const empty = [];
    const out = extractStructure(empty);
    assert.deepEqual(out, []);
});

test('non-array input throws TypeError', () => {
    assert.throws(() => extractStructure(/** @type {any} */(null)), TypeError);
    assert.throws(() => extractStructure(/** @type {any} */({})), TypeError);
    assert.throws(() => extractStructure(/** @type {any} */('not an array')), TypeError);
});

test('mixed content_type in batch throws TypeError', () => {
    const proseChunks = chunkProse(proseInput('Some prose.'));
    const codeChunks = chunkCode(codeInput('function f() {}\n'));
    assert.throws(
        () => extractStructure([...proseChunks, ...codeChunks]),
        /mixed content_type/,
    );
});

/* ---------------- Prose: no headings ---------------- */

test('prose with no headings passes through unchanged (structural stays null)', () => {
    const chunks = chunkProse(proseInput('Just a paragraph with no heading.'));
    const out = extractStructure(chunks);
    assert.equal(out.length, chunks.length);
    for (const c of out) {
        assert.equal(c.metadata.structural, null);
    }
});

test('prose with no headings preserves chunk identity (same array elements)', () => {
    const chunks = chunkProse(proseInput('Just a paragraph with no heading.'));
    const out = extractStructure(chunks);
    assert.equal(out, chunks, 'no-heading prose should pass through by identity');
});

/* ---------------- Prose: single-level headings ---------------- */

test('single heading produces a section node with empty parent', () => {
    const text = [
        '# Top-level heading',
        '',
        'Body text under the heading.',
    ].join('\n');
    const chunks = chunkProse(proseInput(text));
    const out = extractStructure(chunks);

    const headingChunk = out.find((c) => c.content.includes('# Top-level heading'));
    assert.ok(headingChunk, 'should have a chunk containing the heading');
    assert.ok(headingChunk.metadata.structural, 'heading chunk should carry structural');
    assert.equal(headingChunk.metadata.structural.node_kind, 'section');
    assert.deepEqual(headingChunk.metadata.structural.heading_path, ['Top-level heading']);
    assert.equal(headingChunk.metadata.structural.parent_id, null);
    assert.equal(headingChunk.metadata.structural.sibling_order, 0);
});

test('continuation chunks under a heading inherit its heading_path and parent_id', () => {
    // Build a long-enough document that a heading section spans multiple chunks.
    const body = 'Body sentence. '.repeat(200); // ~3000 chars
    const text = `# Section A\n\n${body}`;
    const chunks = chunkProse(proseInput(text));
    assert.ok(chunks.length >= 2, 'test needs multiple chunks to exercise continuation');

    const out = extractStructure(chunks);
    const headingChunk = out.find((c) => c.content.startsWith('# Section A'));
    assert.ok(headingChunk);

    const continuations = out.filter((c) => c !== headingChunk);
    for (const c of continuations) {
        assert.ok(c.metadata.structural, 'continuation should also carry structural');
        assert.deepEqual(c.metadata.structural.heading_path, ['Section A']);
        assert.equal(c.metadata.structural.parent_id, headingChunk.id);
        assert.equal(c.metadata.structural.node_kind, 'section');
    }
});

test('two same-level headings get sibling_order 0 and 1', () => {
    const text = [
        '# First section',
        '',
        'Body of first.',
        '',
        '# Second section',
        '',
        'Body of second.',
    ].join('\n');
    const chunks = chunkProse(proseInput(text));
    const out = extractStructure(chunks);

    // Identify chunks by structural metadata rather than content substring —
    // the prose chunker's 100-char overlap can pull a previous section's
    // heading into a later chunk's content, but the extractor's structural
    // metadata reflects the chunk's actual section identity.
    const first = out.find((c) =>
        c.metadata.structural?.heading_path[0] === 'First section'
        && c.metadata.structural?.heading_path.length === 1);
    const second = out.find((c) =>
        c.metadata.structural?.heading_path[0] === 'Second section'
        && c.metadata.structural?.heading_path.length === 1);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.metadata.structural.sibling_order, 0);
    assert.equal(second.metadata.structural.sibling_order, 1);
    assert.equal(first.metadata.structural.parent_id, null);
    assert.equal(second.metadata.structural.parent_id, null);
});

/* ---------------- Prose: nested heading hierarchy ---------------- */

test('nested headings build heading_path and parent_id chain', () => {
    const text = [
        '# Top',
        '',
        'Top body.',
        '',
        '## Middle A',
        '',
        'Middle A body.',
        '',
        '### Leaf A1',
        '',
        'Leaf A1 body.',
        '',
        '### Leaf A2',
        '',
        'Leaf A2 body.',
        '',
        '## Middle B',
        '',
        'Middle B body.',
    ].join('\n');
    const chunks = chunkProse(proseInput(text));
    const out = extractStructure(chunks);

    // Identify chunks by structural metadata — overlap pollution makes
    // content substring tests unreliable for short documents.
    const findByPath = (...path) => out.find((c) => {
        const hp = c.metadata.structural?.heading_path;
        if (!hp || hp.length !== path.length) return false;
        return hp.every((seg, i) => seg === path[i]);
    });
    const top = findByPath('Top');
    const midA = findByPath('Top', 'Middle A');
    const midB = findByPath('Top', 'Middle B');
    const leafA1 = findByPath('Top', 'Middle A', 'Leaf A1');
    const leafA2 = findByPath('Top', 'Middle A', 'Leaf A2');

    assert.ok(top && midA && midB && leafA1 && leafA2);

    // Heading paths reflect the full chain.
    assert.deepEqual(top.metadata.structural.heading_path, ['Top']);
    assert.deepEqual(midA.metadata.structural.heading_path, ['Top', 'Middle A']);
    assert.deepEqual(midB.metadata.structural.heading_path, ['Top', 'Middle B']);
    assert.deepEqual(leafA1.metadata.structural.heading_path, ['Top', 'Middle A', 'Leaf A1']);
    assert.deepEqual(leafA2.metadata.structural.heading_path, ['Top', 'Middle A', 'Leaf A2']);

    // Parent chain.
    assert.equal(top.metadata.structural.parent_id, null);
    assert.equal(midA.metadata.structural.parent_id, top.id);
    assert.equal(midB.metadata.structural.parent_id, top.id);
    assert.equal(leafA1.metadata.structural.parent_id, midA.id);
    assert.equal(leafA2.metadata.structural.parent_id, midA.id);

    // Sibling order: midA / midB are siblings under top; leafA1 / leafA2 under midA.
    assert.equal(midA.metadata.structural.sibling_order, 0);
    assert.equal(midB.metadata.structural.sibling_order, 1);
    assert.equal(leafA1.metadata.structural.sibling_order, 0);
    assert.equal(leafA2.metadata.structural.sibling_order, 1);
});

test('deeper heading after a shallower one reopens the chain rather than nesting wrong', () => {
    // # → ### should treat ### as a child of #, even though ## is skipped.
    const text = [
        '# Top',
        '',
        'Top body.',
        '',
        '### Deep child',
        '',
        'Deep body.',
    ].join('\n');
    const chunks = chunkProse(proseInput(text));
    const out = extractStructure(chunks);
    const deep = out.find((c) => c.content.includes('### Deep child'));
    assert.ok(deep);
    assert.deepEqual(deep.metadata.structural.heading_path, ['Top', 'Deep child']);
});

test('returning to a higher level pops the stack (heading does not become a sibling of a deeper node)', () => {
    const text = [
        '# A',
        '',
        '## A.1',
        '',
        '# B',
        '',
        'B body.',
    ].join('\n');
    const chunks = chunkProse(proseInput(text));
    const out = extractStructure(chunks);
    // Identify B by its structural metadata: top-level heading "B".
    const b = out.find((c) =>
        c.metadata.structural?.heading_path[0] === 'B'
        && c.metadata.structural?.heading_path.length === 1);
    assert.ok(b);
    assert.deepEqual(b.metadata.structural.heading_path, ['B']);
    assert.equal(b.metadata.structural.parent_id, null);
});

/* ---------------- Prose: non-mutation + freshness ---------------- */

test('extractStructure returns fresh chunks; original input is untouched', () => {
    const chunks = chunkProse(proseInput('# Heading\n\nBody.'));
    const before = JSON.parse(JSON.stringify(chunks));
    extractStructure(chunks);
    assert.deepEqual(chunks, before, 'input chunks must not be mutated');
});

/* ---------------- Code: declaration kind labeling ---------------- */

test('JS function declaration → node_kind "function"', () => {
    const src = 'function helper(a, b) {\n  return a + b;\n}\n';
    const chunks = chunkCode(codeInput(src));
    const out = extractStructure(chunks);
    assert.equal(out.length, 1);
    assert.ok(out[0].metadata.structural);
    assert.equal(out[0].metadata.structural.node_kind, 'function');
    assert.equal(out[0].metadata.structural.parent_id, null);
    assert.deepEqual(out[0].metadata.structural.heading_path, []);
    assert.equal(out[0].metadata.structural.sibling_order, 0);
});

test('JS class declaration → node_kind "class"', () => {
    const src = 'class Foo {\n  bar() {}\n}\n';
    const out = extractStructure(chunkCode(codeInput(src)));
    assert.equal(out[0].metadata.structural.node_kind, 'class');
});

test('JS const → node_kind "variable"', () => {
    const src = 'const X = 42;\n';
    const out = extractStructure(chunkCode(codeInput(src)));
    assert.equal(out[0].metadata.structural.node_kind, 'variable');
});

test('TypeScript type/interface/enum collapse to "type"', () => {
    const cases = [
        ['type Alias = string;\n', 'type'],
        ['interface Iface { x: number }\n', 'type'],
        ['enum E { A, B }\n', 'type'],
    ];
    for (const [src, expected] of cases) {
        const out = extractStructure(chunkCode(codeInput(src, 'src/test.ts')));
        assert.equal(
            out[0].metadata.structural.node_kind,
            expected,
            `expected ${expected} for ${src.split('\n')[0]}`,
        );
    }
});

test('JS export {…} / export * → node_kind "export"', () => {
    const cases = [
        'export { helper };\n',
        'export * from "./mod.js";\n',
    ];
    for (const src of cases) {
        const out = extractStructure(chunkCode(codeInput(src)));
        assert.equal(out[0].metadata.structural.node_kind, 'export');
    }
});

test('JS import → node_kind "import"', () => {
    const src = 'import { x } from "./mod.js";\n';
    const out = extractStructure(chunkCode(codeInput(src)));
    assert.equal(out[0].metadata.structural.node_kind, 'import');
});

test('JS exported function still labels as "function" (not "export")', () => {
    const src = 'export function helper() {}\n';
    const out = extractStructure(chunkCode(codeInput(src)));
    assert.equal(out[0].metadata.structural.node_kind, 'function');
});

test('Python def → "function", class → "class", import → "import"', () => {
    const cases = [
        ['def f():\n    pass\n', 'function'],
        ['async def g():\n    pass\n', 'function'],
        ['class C:\n    pass\n', 'class'],
        ['import os\n', 'import'],
        ['from os import path\n', 'import'],
    ];
    for (const [src, expected] of cases) {
        const out = extractStructure(chunkCode(codeInput(src, 'src/test.py')));
        assert.equal(
            out[0].metadata.structural.node_kind,
            expected,
            `expected ${expected} for ${src.split('\n')[0]}`,
        );
    }
});

test('Python decorator skipped — labels by the following def/class', () => {
    const src = '@decorator\ndef target():\n    pass\n';
    const out = extractStructure(chunkCode(codeInput(src, 'src/test.py')));
    assert.equal(out[0].metadata.structural.node_kind, 'function');
});

test('multiple top-level constructs each get sibling_order in document order', () => {
    const src = [
        'import { a } from "./a.js";',
        'function one() {}',
        'function two() {}',
        'class Three {}',
    ].join('\n') + '\n';
    const out = extractStructure(chunkCode(codeInput(src)));
    assert.ok(out.length >= 2);
    out.forEach((chunk, i) => {
        assert.equal(chunk.metadata.structural.sibling_order, i);
        assert.equal(chunk.metadata.structural.parent_id, null);
        assert.deepEqual(chunk.metadata.structural.heading_path, []);
    });
});

test('unknown extension code chunks degrade to node_kind "code"', () => {
    const src = 'PROGRAM hello\n  PRINT *, "hi"\nEND PROGRAM\n';
    const out = extractStructure(chunkCode(codeInput(src, 'src/test.f90')));
    assert.equal(out[0].metadata.structural.node_kind, 'code');
});

test('code chunks with only comments / blank lines (no construct match) → "code"', () => {
    // Construct with leading shebang + comment that doesn't start with a known
    // declaration. The chunker still emits a single chunk for the file; the
    // extractor labels it generically.
    const src = '#!/usr/bin/env node\n// just a comment\n';
    const out = extractStructure(chunkCode(codeInput(src)));
    assert.ok(out.length >= 1);
    assert.equal(out[0].metadata.structural.node_kind, 'code');
});

/* ---------------- Conversation / structured: passthrough ---------------- */

test('conversation chunks pass through unchanged', () => {
    const turns = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
    ];
    const chunks = chunkConversation({
        bytes: JSON.stringify(turns),
        collection: 'history',
        metadata: {
            source_uri: 'history/session-1',
            content_type: 'conversation',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            custom: {},
        },
    });
    const out = extractStructure(chunks);
    assert.equal(out, chunks, 'conversation should pass through by identity');
    for (const c of out) {
        assert.equal(c.metadata.structural, null);
    }
});

test('structured chunks pass through unchanged', () => {
    const chunks = chunkStructured({
        bytes: JSON.stringify([{ a: 1 }, { b: 2 }]),
        collection: 'data',
        metadata: {
            source_uri: 'data/items.json',
            content_type: 'structured',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            custom: {},
        },
    });
    const out = extractStructure(chunks);
    assert.equal(out, chunks, 'structured should pass through by identity');
    for (const c of out) {
        assert.equal(c.metadata.structural, null);
    }
});

test('spec content_type passes through unchanged', () => {
    // No spec chunker yet (deferred past Phase 1), but the extractor must
    // handle the content_type gracefully — i.e. when a future spec chunker
    // arrives, it can opt into structural metadata via a separate code path.
    const fakeSpec = [{
        id: 'spec-fake-id',
        collection: 'specs',
        content: '# Spec heading\n\nBody.',
        tokens: 10,
        metadata: {
            source_uri: 'specs/x.md',
            content_type: 'spec',
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            content_hash: 'abcdef01',
            structural: null,
            custom: {},
        },
        byte_range: [0, 25],
    }];
    const out = extractStructure(fakeSpec);
    assert.equal(out, fakeSpec);
});

/* ---------------- Determinism ---------------- */

test('extractStructure is deterministic across runs', () => {
    const text = [
        '# A',
        '',
        '## B',
        '',
        'Body.',
    ].join('\n');
    const chunks1 = chunkProse(proseInput(text));
    const chunks2 = chunkProse(proseInput(text));
    const out1 = extractStructure(chunks1);
    const out2 = extractStructure(chunks2);
    assert.deepEqual(
        out1.map((c) => c.metadata.structural),
        out2.map((c) => c.metadata.structural),
    );
});
