/**
 * Chunker pipeline tests (1.4.19).
 *
 * Covers `js/intelligence/retrieval/pipeline.js` per the 1.4.19 plan:
 * a pure dispatcher that picks the right chunker by `content_type` and
 * runs `extractStructure` as a post-pass, returning structurally-enriched
 * `Chunk[]`.
 *
 * Tests center on the load-bearing invariant — for each Phase 1
 * content_type, `runChunkerPipeline(input)` is deep-equal to
 * `extractStructure(chunkX(input))`. This catches accidental input
 * mutation, a skipped extractor pass, re-ordering, and any future chunker
 * added to the dispatch table without a corresponding extractor wiring.
 *
 * No DOM, no State, no network — pure-data, runnable under `node --test`,
 * mirroring the sibling test files
 * `test-retrieval-{prose,code,conversation,structured}-chunker.mjs` and
 * `test-retrieval-structure-extractor.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chunkProse,
    chunkCode,
    chunkConversation,
    chunkStructured,
    extractStructure,
    runChunkerPipeline,
} from '../js/intelligence/retrieval/index.js';

/* ---------------- Input builders ---------------- */

const proseInput = (bytes, source_uri = 'docs/test.md') => ({
    bytes,
    collection: 'docs',
    metadata: {
        source_uri,
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

const conversationInput = (turns, source_uri = 'chat/session-1.json') => ({
    bytes: JSON.stringify(turns),
    collection: 'chat',
    metadata: {
        source_uri,
        content_type: 'conversation',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
    },
});

const structuredInput = (value, source_uri = 'data/test.json') => ({
    bytes: JSON.stringify(value),
    collection: 'data',
    metadata: {
        source_uri,
        content_type: 'structured',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
    },
});

/* ---------------- Property invariant: pipeline ≡ extractStructure ∘ chunker ---------------- */

test('pipeline(prose) === extractStructure(chunkProse(input))', () => {
    const text = [
        '# Top-level heading',
        '',
        'Body text under the heading.',
        '',
        '## Subsection',
        '',
        'More body.',
    ].join('\n');
    const input = proseInput(text);
    const direct = extractStructure(chunkProse(input));
    const piped = runChunkerPipeline(input);
    assert.deepEqual(piped, direct);
});

test('pipeline(code) === extractStructure(chunkCode(input))', () => {
    const code = [
        'import x from "./x.js";',
        '',
        'export function foo() { return 1; }',
        '',
        'class Bar {}',
        '',
    ].join('\n');
    const input = codeInput(code);
    const direct = extractStructure(chunkCode(input));
    const piped = runChunkerPipeline(input);
    assert.deepEqual(piped, direct);
});

test('pipeline(conversation) === extractStructure(chunkConversation(input))', () => {
    const turns = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'user', content: 'what is 2+2?' },
    ];
    const input = conversationInput(turns);
    const direct = extractStructure(chunkConversation(input));
    const piped = runChunkerPipeline(input);
    assert.deepEqual(piped, direct);
});

test('pipeline(structured) === extractStructure(chunkStructured(input))', () => {
    const records = [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
    ];
    const input = structuredInput(records);
    const direct = extractStructure(chunkStructured(input));
    const piped = runChunkerPipeline(input);
    assert.deepEqual(piped, direct);
});

/* ---------------- Round-trip shape per content_type ---------------- */

test('prose round-trip: chunks carry heading-derived structural metadata', () => {
    const text = '# Heading A\n\nBody under A.';
    const out = runChunkerPipeline(proseInput(text));
    assert.ok(out.length > 0, 'prose should produce at least one chunk');
    const headingChunk = out.find((c) => c.content.includes('# Heading A'));
    assert.ok(headingChunk, 'should have a heading chunk');
    assert.ok(headingChunk.metadata.structural, 'heading chunk should carry structural');
    assert.equal(headingChunk.metadata.structural.node_kind, 'section');
    assert.deepEqual(headingChunk.metadata.structural.heading_path, ['Heading A']);
});

test('code round-trip: chunks carry declaration-kind structural metadata', () => {
    const code = 'export function foo() { return 1; }\n\nclass Bar {}\n';
    const out = runChunkerPipeline(codeInput(code));
    assert.ok(out.length >= 2, 'code should produce per-construct chunks');
    for (const c of out) {
        assert.ok(c.metadata.structural, 'code chunk should carry structural');
        assert.equal(c.metadata.structural.parent_id, null);
        assert.deepEqual(c.metadata.structural.heading_path, []);
    }
    const kinds = out.map((c) => c.metadata.structural.node_kind);
    assert.ok(kinds.includes('function'), `expected function kind in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('class'), `expected class kind in ${JSON.stringify(kinds)}`);
});

test('conversation round-trip: chunks pass through with structural=null', () => {
    const turns = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
    ];
    const out = runChunkerPipeline(conversationInput(turns));
    assert.equal(out.length, 2);
    for (const c of out) {
        assert.equal(c.metadata.structural, null);
    }
});

test('structured round-trip: chunks pass through with structural=null', () => {
    const records = [{ k: 1 }, { k: 2 }];
    const out = runChunkerPipeline(structuredInput(records));
    assert.equal(out.length, 2);
    for (const c of out) {
        assert.equal(c.metadata.structural, null);
    }
});

/* ---------------- Empty-bytes short-circuit ---------------- */

test('empty bytes returns [] without invoking a chunker', () => {
    const out = runChunkerPipeline(proseInput(''));
    assert.deepEqual(out, []);
});

test('empty bytes returns [] for every Phase 1 content_type', () => {
    for (const content_type of ['prose', 'code', 'conversation', 'structured']) {
        const input = {
            bytes: '',
            collection: 'c',
            metadata: {
                source_uri: 'x',
                content_type,
                created_at: 0,
                updated_at: 0,
                custom: {},
            },
        };
        assert.deepEqual(
            runChunkerPipeline(input),
            [],
            `empty bytes for content_type="${content_type}" should return []`,
        );
    }
});

/* ---------------- Rejected inputs ---------------- */

test('null input throws TypeError', () => {
    assert.throws(() => runChunkerPipeline(/** @type {any} */(null)), TypeError);
});

test('non-object input throws TypeError', () => {
    assert.throws(() => runChunkerPipeline(/** @type {any} */('not an input')), TypeError);
    assert.throws(() => runChunkerPipeline(/** @type {any} */(42)), TypeError);
});

test('missing metadata throws TypeError', () => {
    assert.throws(
        () => runChunkerPipeline(/** @type {any} */({ bytes: 'x', collection: 'c' })),
        /input\.metadata/,
    );
});

test('missing content_type throws TypeError', () => {
    const input = {
        bytes: 'x',
        collection: 'c',
        metadata: { source_uri: 'x', created_at: 0, updated_at: 0, custom: {} },
    };
    assert.throws(() => runChunkerPipeline(/** @type {any} */(input)), /content_type/);
});

test('empty content_type throws TypeError', () => {
    const input = proseInput('x');
    input.metadata.content_type = '';
    assert.throws(() => runChunkerPipeline(/** @type {any} */(input)), /content_type/);
});

test('unknown content_type throws TypeError', () => {
    const input = proseInput('x');
    input.metadata.content_type = /** @type {any} */('mystery');
    assert.throws(
        () => runChunkerPipeline(input),
        /no chunker for content_type "mystery"/,
    );
});

test('spec content_type throws TypeError (deferred past Phase 1)', () => {
    const input = proseInput('# Section\n\nBody.');
    input.metadata.content_type = /** @type {any} */('spec');
    assert.throws(
        () => runChunkerPipeline(input),
        /spec chunker is deferred past Phase 1/,
    );
});

/* ---------------- Input not mutated ---------------- */

test('input is not mutated by the pipeline (prose)', () => {
    const input = proseInput('# Heading\n\nBody.');
    const snapshot = JSON.parse(JSON.stringify(input));
    runChunkerPipeline(input);
    assert.deepEqual(input, snapshot);
});

test('input is not mutated by the pipeline (code)', () => {
    const input = codeInput('export function f() {}\n');
    const snapshot = JSON.parse(JSON.stringify(input));
    runChunkerPipeline(input);
    assert.deepEqual(input, snapshot);
});

test('input is not mutated by the pipeline (conversation)', () => {
    const input = conversationInput([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
    ]);
    const snapshot = JSON.parse(JSON.stringify(input));
    runChunkerPipeline(input);
    assert.deepEqual(input, snapshot);
});

test('input is not mutated by the pipeline (structured)', () => {
    const input = structuredInput([{ a: 1 }, { a: 2 }]);
    const snapshot = JSON.parse(JSON.stringify(input));
    runChunkerPipeline(input);
    assert.deepEqual(input, snapshot);
});

/* ---------------- Barrel re-export ---------------- */

test('runChunkerPipeline is exported from the retrieval barrel', () => {
    assert.equal(typeof runChunkerPipeline, 'function');
});
