/**
 * Prose chunker tests (1.4.10).
 *
 * Covers the chunker contract introduced by `js/intelligence/retrieval/
 * chunkers/prose-chunker.js`: empty/short/long input handling, paragraph
 * + heading boundaries, 100-char overlap mechanics, ChunkID stability
 * + chunker-version invalidation, byte-range adjacency, and surrogate-
 * safe slicing.
 *
 * No DOM, no State, no network — pure-data, runnable under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chunkProse,
    computeChunkID,
    CHUNKER_VERSION,
} from '../js/intelligence/retrieval/index.js';

const PROSE_PARAGRAPH = (
    'A paragraph of prose suitable for testing the chunker without ' +
    'tripping any of the chunker\'s split paths. It stays comfortably ' +
    'under the eight-hundred-character target minimum and contains no ' +
    'headings.'
);

/** Build a prose document of approximately `targetChars` characters. */
function buildLongProse(targetChars) {
    const parts = [];
    let total = 0;
    let i = 0;
    while (total < targetChars) {
        const block = `Paragraph ${i}: ${PROSE_PARAGRAPH}`;
        parts.push(block);
        total += block.length + 2; // +2 for the blank-line separator
        i += 1;
    }
    return parts.join('\n\n');
}

const baseInput = (bytes, overrides = {}) => ({
    bytes,
    collection: 'docs',
    metadata: {
        source_uri: 'docs/test-prose.md',
        content_type: 'prose',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
        ...overrides.metadata,
    },
    ...overrides.input,
});

/* ---------------- Empty + short input ---------------- */

test('empty input produces no chunks', () => {
    assert.deepEqual(chunkProse(baseInput('')), []);
});

test('whitespace-only input produces no chunks', () => {
    assert.deepEqual(chunkProse(baseInput('\n\n   \n  \n')), []);
});

test('short prose produces exactly one chunk with no overlap prefix', () => {
    const text = 'A short paragraph.\n\nA second short paragraph.';
    const chunks = chunkProse(baseInput(text));
    assert.equal(chunks.length, 1);
    // First chunk's content is the raw source (stretched to cover the whole
    // document) — no overlap prefix on chunk 0.
    assert.equal(chunks[0].content, text);
    assert.equal(chunks[0].metadata.content_type, 'prose');
    assert.equal(chunks[0].metadata.structural, null);
});

test('chunks expose the contract surface (id, content, tokens, metadata, byte_range)', () => {
    const chunks = chunkProse(baseInput('Hello world.\n'));
    assert.equal(chunks.length, 1);
    const c = chunks[0];
    assert.equal(typeof c.id, 'string');
    assert.match(c.id, /^[0-9a-f]{16}$/);
    assert.equal(c.collection, 'docs');
    assert.equal(typeof c.content, 'string');
    assert.equal(typeof c.tokens, 'number');
    assert.ok(c.tokens > 0);
    assert.equal(typeof c.metadata.content_hash, 'string');
    assert.match(c.metadata.content_hash, /^[0-9a-f]{8}$/);
    assert.equal(Array.isArray(c.byte_range), true);
    assert.equal(c.byte_range.length, 2);
});

/* ---------------- Headings force boundaries ---------------- */

test('a heading forces a chunk boundary even when the current chunk is small', () => {
    const text = [
        'Lead paragraph that introduces the section.',
        '',
        '## A heading',
        '',
        'The paragraph that follows the heading.',
    ].join('\n');
    const chunks = chunkProse(baseInput(text));
    assert.equal(chunks.length, 2, 'heading should produce exactly two chunks');
    // The heading + its following paragraph live in chunk 1.
    assert.ok(chunks[1].content.includes('## A heading'));
    assert.ok(chunks[1].content.includes('The paragraph that follows'));
    // The lead paragraph lives in chunk 0.
    assert.ok(chunks[0].content.includes('Lead paragraph'));
});

test('multiple headings each open a fresh chunk', () => {
    const text = [
        'Intro paragraph.',
        '',
        '## Heading One',
        '',
        'First section body.',
        '',
        '## Heading Two',
        '',
        'Second section body.',
    ].join('\n');
    const chunks = chunkProse(baseInput(text));
    assert.equal(chunks.length, 3);
    assert.ok(chunks[1].content.includes('## Heading One'));
    assert.ok(chunks[2].content.includes('## Heading Two'));
});

/* ---------------- Long prose: split + overlap ---------------- */

test('long prose produces multiple chunks', () => {
    const text = buildLongProse(3000);
    const chunks = chunkProse(baseInput(text));
    assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
});

test('chunks 2..N begin with the 100-char overlap from the previous chunk\'s tail', () => {
    const text = buildLongProse(4000);
    const chunks = chunkProse(baseInput(text));
    assert.ok(chunks.length >= 2);
    for (let i = 1; i < chunks.length; i++) {
        const prevTail = chunks[i - 1].content.slice(-100);
        const thisHead = chunks[i].content.slice(0, prevTail.length);
        assert.equal(
            thisHead,
            prevTail,
            `chunk ${i} did not start with chunk ${i - 1}'s 100-char tail`,
        );
    }
});

test('a single paragraph above the 1200-char ceiling splits at sentence boundaries', () => {
    // Build a single paragraph well above TARGET_MAX with explicit sentence
    // boundaries. The chunker should pick a `. ` boundary inside the
    // [800, 1200] window rather than hard-cutting mid-word.
    const sentence = 'This sentence is exactly forty-eight chars. '; // 44 chars
    let p = '';
    while (p.length < 2500) p += sentence;
    const chunks = chunkProse(baseInput(p));
    assert.ok(chunks.length >= 2);
    // Chunk 0 ends right after `. ` (a sentence boundary). The content
    // includes the whole stretched span up through the boundary; the
    // exclusive byte_range[1] sits one char past the period+space.
    const chunk0Tail = chunks[0].content.slice(-2);
    assert.ok(
        chunk0Tail === '. ' || chunks[0].content.endsWith('.'),
        `chunk 0 should end at a sentence boundary, ended with: ${JSON.stringify(chunk0Tail)}`,
    );
});

test('an oversized paragraph with no sentence boundaries hard-cuts at TARGET_MAX', () => {
    // A 2500-char run with no `.`/`!`/`?` should still split (deterministic
    // fallback) — the chunker terminates rather than emitting a chunk
    // larger than TARGET_MAX in its identity range.
    const p = 'a'.repeat(2500);
    const chunks = chunkProse(baseInput(p));
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
        const span = c.byte_range[1] - c.byte_range[0];
        assert.ok(span <= 1200, `chunk byte span ${span} exceeded TARGET_MAX`);
    }
});

/* ---------------- ChunkID stability + invalidation ---------------- */

test('identical input produces identical chunk IDs across runs', () => {
    const text = buildLongProse(3500);
    const a = chunkProse(baseInput(text));
    const b = chunkProse(baseInput(text));
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].id, b[i].id);
    }
});

test('chunk ID matches the canonical computeChunkID call against CHUNKER_VERSION.prose', () => {
    const text = buildLongProse(2000);
    const chunks = chunkProse(baseInput(text));
    for (const c of chunks) {
        const expected = computeChunkID({
            collection: 'docs',
            source_uri: 'docs/test-prose.md',
            byte_range: c.byte_range,
            chunker_version: CHUNKER_VERSION.prose,
        });
        assert.equal(c.id, expected);
    }
});

test('a hypothetical chunker_version bump produces different IDs at the same byte_range', () => {
    // Demonstrates the version-invalidation property without mutating the
    // frozen registry: same byte_range hashed under v2 differs from the
    // chunk's actual ID.
    const chunks = chunkProse(baseInput(buildLongProse(2500)));
    for (const c of chunks) {
        const v2 = computeChunkID({
            collection: 'docs',
            source_uri: 'docs/test-prose.md',
            byte_range: c.byte_range,
            chunker_version: 'v2',
        });
        assert.notEqual(c.id, v2);
    }
});

/* ---------------- Byte-range adjacency ---------------- */

test('consecutive chunks share a byte_range boundary (chunk[i+1].start === chunk[i].end)', () => {
    const chunks = chunkProse(baseInput(buildLongProse(4500)));
    assert.ok(chunks.length >= 2);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(
            chunks[i].byte_range[0],
            chunks[i - 1].byte_range[1],
            `chunks[${i - 1}].byte_range[1] !== chunks[${i}].byte_range[0]`,
        );
    }
});

test('first chunk byte_range starts at 0 and last chunk byte_range ends at the source byte length', () => {
    const text = buildLongProse(3000);
    const expectedBytes = new TextEncoder().encode(text).length;
    const chunks = chunkProse(baseInput(text));
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].byte_range[0], 0);
    assert.equal(chunks[chunks.length - 1].byte_range[1], expectedBytes);
});

/* ---------------- Unicode safety ---------------- */

test('multi-byte UTF-8 characters near boundaries do not split surrogate pairs', () => {
    // Insert a 4-byte emoji (surrogate pair in UTF-16) every 50 chars in a
    // long prose document. Every chunk's content must be a valid UTF-16
    // string with no unmatched surrogates.
    const segment = '🚀 launch '.repeat(10) + '\n\n';   // ≈ 100 chars per segment
    let text = '';
    while (text.length < 4000) text += segment;
    const chunks = chunkProse(baseInput(text));
    for (const c of chunks) {
        for (let i = 0; i < c.content.length; i++) {
            const code = c.content.charCodeAt(i);
            if (code >= 0xD800 && code <= 0xDBFF) {
                // High surrogate: must be followed by a low surrogate.
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
    // 'é' = 2 UTF-8 bytes; 1 JS string char.
    const text = 'é'.repeat(500); // 500 chars, 1000 UTF-8 bytes
    const expectedBytes = new TextEncoder().encode(text).length;
    assert.equal(expectedBytes, 1000);
    const chunks = chunkProse(baseInput(text));
    assert.equal(chunks[chunks.length - 1].byte_range[1], 1000);
});

/* ---------------- Input validation ---------------- */

test('chunkProse rejects missing input', () => {
    // @ts-expect-error — runtime check
    assert.throws(() => chunkProse(null), /input/);
    // @ts-expect-error — runtime check
    assert.throws(() => chunkProse(undefined), /input/);
});

test('chunkProse rejects non-string bytes', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkProse({ bytes: 42, collection: 'docs', metadata: { source_uri: 's' } }),
        /bytes/,
    );
});

test('chunkProse rejects empty collection', () => {
    assert.throws(
        () => chunkProse({ bytes: 'hi', collection: '', metadata: { source_uri: 's' } }),
        /collection/,
    );
});

test('chunkProse rejects missing source_uri', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkProse({ bytes: 'hi', collection: 'docs', metadata: {} }),
        /source_uri/,
    );
});

/* ---------------- Structural placeholder + custom passthrough ---------------- */

test('emitted chunks carry metadata.structural === null (StructureExtractor lands later)', () => {
    const chunks = chunkProse(baseInput(buildLongProse(2500)));
    for (const c of chunks) {
        assert.equal(c.metadata.structural, null);
    }
});

test('metadata.custom is preserved verbatim from input', () => {
    const custom = { speaker_id: 'tester', tag: 'unit' };
    const chunks = chunkProse(baseInput('Some prose.', { metadata: { custom } }));
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].metadata.custom, custom);
});

test('metadata.custom defaults to {} when input omits it', () => {
    const chunks = chunkProse({
        bytes: 'Some prose.',
        collection: 'docs',
        metadata: { source_uri: 's' },
    });
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].metadata.custom, {});
});
