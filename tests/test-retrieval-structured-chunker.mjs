/**
 * Structured chunker tests (1.4.13).
 *
 * Covers `js/intelligence/retrieval/chunkers/structured-chunker.js`:
 * empty input, JSON arrays + objects, JSONL, format dispatch via custom
 * override and source_uri extension, byte-range adjacency, ChunkID
 * stability + chunker-version invalidation, surrogate-safe handling of
 * UTF-8 multi-byte content, and input-validation rejection paths.
 *
 * No DOM, no State, no network — pure-data, runnable under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    chunkStructured,
    computeChunkID,
    CHUNKER_VERSION,
} from '../js/intelligence/retrieval/index.js';

const baseInput = (bytes, overrides = {}) => ({
    bytes,
    collection: 'records',
    metadata: {
        source_uri: 'records/test.json',
        content_type: 'structured',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        custom: {},
        ...overrides.metadata,
    },
    ...overrides.input,
});

/* ---------------- Empty / degenerate ---------------- */

test('empty bytes produces no chunks', () => {
    assert.deepEqual(chunkStructured(baseInput('')), []);
});

test('JSON empty array produces no chunks', () => {
    assert.deepEqual(chunkStructured(baseInput('[]')), []);
});

test('JSON empty object produces no chunks', () => {
    assert.deepEqual(chunkStructured(baseInput('{}')), []);
});

test('JSONL with only blank lines produces no chunks', () => {
    const input = baseInput('\n   \n\t\n', { metadata: { source_uri: 'records/test.jsonl' } });
    assert.deepEqual(chunkStructured(input), []);
});

/* ---------------- JSON array — happy path ---------------- */

test('JSON array of mixed types produces one chunk per element with record_index', () => {
    const data = ['hello', 42, true, null, { nested: 'object' }, [1, 2, 3]];
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks.length, data.length);
    for (let i = 0; i < data.length; i++) {
        assert.equal(chunks[i].metadata.custom.record_index, i);
        assert.equal(chunks[i].metadata.custom.record_key, undefined);
        assert.equal(chunks[i].content, JSON.stringify(data[i]));
    }
});

test('chunks expose the contract surface (id, content, tokens, metadata, byte_range)', () => {
    const chunks = chunkStructured(baseInput('[1, 2, 3]'));
    assert.equal(chunks.length, 3);
    for (const c of chunks) {
        assert.equal(typeof c.id, 'string');
        assert.match(c.id, /^[0-9a-f]{16}$/);
        assert.equal(c.collection, 'records');
        assert.equal(typeof c.content, 'string');
        assert.equal(typeof c.tokens, 'number');
        assert.ok(c.tokens > 0);
        assert.equal(c.metadata.content_type, 'structured');
        assert.equal(c.metadata.structural, null);
        assert.equal(typeof c.metadata.content_hash, 'string');
        assert.match(c.metadata.content_hash, /^[0-9a-f]{8}$/);
        assert.equal(Array.isArray(c.byte_range), true);
        assert.equal(c.byte_range.length, 2);
    }
});

/* ---------------- JSON object — happy path ---------------- */

test('JSON object produces one chunk per key in insertion order with record_key', () => {
    const data = { alpha: 1, beta: 'two', gamma: [3, 3, 3] };
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].metadata.custom.record_key, 'alpha');
    assert.equal(chunks[0].metadata.custom.record_index, 0);
    assert.equal(chunks[1].metadata.custom.record_key, 'beta');
    assert.equal(chunks[1].metadata.custom.record_index, 1);
    assert.equal(chunks[2].metadata.custom.record_key, 'gamma');
    assert.equal(chunks[2].metadata.custom.record_index, 2);
});

test('JSON object record content includes the key (canonical {key: value})', () => {
    const data = { foo: 'bar' };
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, '{"foo":"bar"}');
});

test('two object entries with the same value get distinct content_hashes (the key participates)', () => {
    const data = { a: 1, b: 1 };
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks.length, 2);
    assert.notEqual(chunks[0].metadata.content_hash, chunks[1].metadata.content_hash);
});

/* ---------------- JSONL — happy path ---------------- */

test('JSONL emits one chunk per non-blank line, skipping blanks', () => {
    const bytes = [
        '{"id":1,"name":"a"}',
        '',
        '{"id":2,"name":"b"}',
        '   ',
        '{"id":3,"name":"c"}',
        '',
    ].join('\n');
    const chunks = chunkStructured(baseInput(bytes, { metadata: { source_uri: 'records/test.jsonl' } }));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].metadata.custom.record_index, 0);
    assert.equal(chunks[1].metadata.custom.record_index, 1);
    assert.equal(chunks[2].metadata.custom.record_index, 2);
    assert.equal(chunks[0].content, '{"id":1,"name":"a"}');
    assert.equal(chunks[1].content, '{"id":2,"name":"b"}');
    assert.equal(chunks[2].content, '{"id":3,"name":"c"}');
});

test('JSONL handles CRLF line endings', () => {
    const bytes = '{"a":1}\r\n{"b":2}\r\n';
    const chunks = chunkStructured(baseInput(bytes, { metadata: { source_uri: 'records/test.jsonl' } }));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].content, '{"a":1}');
    assert.equal(chunks[1].content, '{"b":2}');
});

test('JSONL canonicalizes per line (whitespace inside a line is normalized away)', () => {
    const bytes = '{"a": 1, "b":   2}\n{"c": 3}';
    const chunks = chunkStructured(baseInput(bytes, { metadata: { source_uri: 'records/test.jsonl' } }));
    assert.equal(chunks[0].content, '{"a":1,"b":2}');
    assert.equal(chunks[1].content, '{"c":3}');
});

/* ---------------- Format dispatch ---------------- */

test('explicit metadata.custom.format = "json" wins over .jsonl extension', () => {
    const bytes = JSON.stringify([{ x: 1 }, { y: 2 }]);
    const chunks = chunkStructured(baseInput(bytes, {
        metadata: { source_uri: 'records/test.jsonl', custom: { format: 'json' } },
    }));
    assert.equal(chunks.length, 2);
});

test('explicit metadata.custom.format = "jsonl" wins over .json extension', () => {
    const bytes = '{"a":1}\n{"b":2}';
    const chunks = chunkStructured(baseInput(bytes, {
        metadata: { source_uri: 'records/test.json', custom: { format: 'jsonl' } },
    }));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].content, '{"a":1}');
});

test('.json extension routes to JSON parser', () => {
    const chunks = chunkStructured(baseInput('[1,2,3]', {
        metadata: { source_uri: 'data/things.json' },
    }));
    assert.equal(chunks.length, 3);
});

test('.jsonl extension routes to JSONL parser', () => {
    const chunks = chunkStructured(baseInput('{"a":1}\n{"b":2}', {
        metadata: { source_uri: 'data/things.jsonl' },
    }));
    assert.equal(chunks.length, 2);
});

test('.ndjson extension routes to JSONL parser', () => {
    const chunks = chunkStructured(baseInput('{"a":1}\n{"b":2}', {
        metadata: { source_uri: 'data/things.ndjson' },
    }));
    assert.equal(chunks.length, 2);
});

test('no extension + no format hint throws with a guidance message', () => {
    assert.throws(
        () => chunkStructured(baseInput('[1,2,3]', {
            metadata: { source_uri: 'data/things' },
        })),
        /cannot resolve format/,
    );
});

test('unknown format value throws', () => {
    assert.throws(
        () => chunkStructured(baseInput('[1,2,3]', {
            metadata: { source_uri: 'data/things.json', custom: { format: 'yaml' } },
        })),
        /must be 'json' or 'jsonl'/,
    );
});

/* ---------------- Byte-range invariants ---------------- */

test('JSON array: chunks share byte_range boundaries (chunk[i+1].start === chunk[i].end)', () => {
    const data = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks[0].byte_range[0], 0);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i].byte_range[0], chunks[i - 1].byte_range[1]);
    }
});

test('JSON object: chunks share byte_range boundaries (canonical {k:v} sequence)', () => {
    const data = { a: 1, b: 2, c: 3 };
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks[0].byte_range[0], 0);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i].byte_range[0], chunks[i - 1].byte_range[1]);
    }
});

test('JSONL: chunks share byte_range boundaries over the canonical concat', () => {
    const bytes = '{"a":1}\n\n{"b":2}\n{"c":3}';
    const chunks = chunkStructured(baseInput(bytes, { metadata: { source_uri: 'records/test.jsonl' } }));
    assert.equal(chunks[0].byte_range[0], 0);
    for (let i = 1; i < chunks.length; i++) {
        assert.equal(chunks[i].byte_range[0], chunks[i - 1].byte_range[1]);
    }
});

test('byte_range span of each chunk equals UTF-8 byte length of its canonical record', () => {
    const data = ['plain', 'multi-byte: é', '🚀'];
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    for (let i = 0; i < data.length; i++) {
        const expectedLen = new TextEncoder().encode(JSON.stringify(data[i])).length;
        const span = chunks[i].byte_range[1] - chunks[i].byte_range[0];
        assert.equal(span, expectedLen, `record ${i} byte span mismatch`);
    }
});

/* ---------------- ChunkID stability ---------------- */

test('identical input produces identical chunk IDs across runs', () => {
    const bytes = JSON.stringify([{ x: 1 }, { y: 2 }]);
    const a = chunkStructured(baseInput(bytes));
    const b = chunkStructured(baseInput(bytes));
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].id, b[i].id);
    }
});

test('chunk ID matches canonical computeChunkID under CHUNKER_VERSION.structured', () => {
    const chunks = chunkStructured(baseInput('[1,2]'));
    for (const c of chunks) {
        const expected = computeChunkID({
            collection: 'records',
            source_uri: 'records/test.json',
            byte_range: c.byte_range,
            chunker_version: CHUNKER_VERSION.structured,
        });
        assert.equal(c.id, expected);
    }
});

test('a hypothetical chunker_version bump produces different IDs at the same byte_range', () => {
    const chunks = chunkStructured(baseInput('[1,2,3]'));
    for (const c of chunks) {
        const v2 = computeChunkID({
            collection: 'records',
            source_uri: 'records/test.json',
            byte_range: c.byte_range,
            chunker_version: 'v2',
        });
        assert.notEqual(c.id, v2);
    }
});

test('JSON ChunkIDs are stable across compact-vs-pretty envelope formatting', () => {
    const data = [{ x: 1 }, { y: 2 }];
    const compact = chunkStructured(baseInput(JSON.stringify(data)));
    const pretty = chunkStructured(baseInput(JSON.stringify(data, null, 2)));
    assert.equal(compact.length, pretty.length);
    for (let i = 0; i < compact.length; i++) {
        assert.equal(compact[i].id, pretty[i].id);
        assert.deepEqual(compact[i].byte_range, pretty[i].byte_range);
    }
});

test('JSONL ChunkIDs are stable when callers reformat per-line whitespace', () => {
    const compact = chunkStructured(baseInput(
        '{"a":1}\n{"b":2}',
        { metadata: { source_uri: 'records/test.jsonl' } },
    ));
    const padded = chunkStructured(baseInput(
        '{"a": 1}\n{"b":   2}\n',
        { metadata: { source_uri: 'records/test.jsonl' } },
    ));
    assert.equal(compact.length, padded.length);
    for (let i = 0; i < compact.length; i++) {
        assert.equal(compact[i].id, padded[i].id);
    }
});

/* ---------------- Unicode safety ---------------- */

test('multi-byte UTF-8 content survives chunking with intact strings', () => {
    const data = ['🚀 launch sequence', 'café — ready', '日本語'];
    const chunks = chunkStructured(baseInput(JSON.stringify(data)));
    assert.equal(chunks[0].content, '"🚀 launch sequence"');
    assert.equal(chunks[1].content, '"café — ready"');
    assert.equal(chunks[2].content, '"日本語"');
});

/* ---------------- Custom-metadata pass-through ---------------- */

test('caller-supplied metadata.custom keys flow through to every chunk', () => {
    const chunks = chunkStructured(baseInput('[1,2]', {
        metadata: { custom: { source_format: 'jsonl-export', batch_id: 'b-42' } },
    }));
    for (const c of chunks) {
        assert.equal(c.metadata.custom.source_format, 'jsonl-export');
        assert.equal(c.metadata.custom.batch_id, 'b-42');
    }
});

test('caller-supplied record_index in metadata.custom overrides the per-record value', () => {
    const chunks = chunkStructured(baseInput('[1,2]', {
        metadata: { custom: { record_index: 999 } },
    }));
    for (const c of chunks) {
        assert.equal(c.metadata.custom.record_index, 999);
    }
});

test('format dispatch hint is filtered out of metadata.custom on emitted chunks', () => {
    const chunks = chunkStructured(baseInput('[1,2]', {
        metadata: { source_uri: 'records/test.json', custom: { format: 'json' } },
    }));
    for (const c of chunks) {
        assert.equal(Object.prototype.hasOwnProperty.call(c.metadata.custom, 'format'), false);
    }
});

/* ---------------- Structural placeholder ---------------- */

test('emitted chunks carry metadata.structural === null (StructureExtractor lands later)', () => {
    const chunks = chunkStructured(baseInput('[1]'));
    assert.equal(chunks[0].metadata.structural, null);
});

/* ---------------- Input validation ---------------- */

test('chunkStructured rejects missing input', () => {
    // @ts-expect-error — runtime check
    assert.throws(() => chunkStructured(null), /input/);
    // @ts-expect-error — runtime check
    assert.throws(() => chunkStructured(undefined), /input/);
});

test('chunkStructured rejects non-string bytes', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkStructured({ bytes: 42, collection: 'r', metadata: { source_uri: 's.json' } }),
        /bytes/,
    );
});

test('chunkStructured rejects empty collection', () => {
    assert.throws(
        () => chunkStructured({ bytes: '[]', collection: '', metadata: { source_uri: 's.json' } }),
        /collection/,
    );
});

test('chunkStructured rejects missing source_uri', () => {
    assert.throws(
        // @ts-expect-error — runtime check
        () => chunkStructured({ bytes: '[]', collection: 'r', metadata: {} }),
        /source_uri/,
    );
});

test('chunkStructured rejects malformed JSON', () => {
    assert.throws(
        () => chunkStructured(baseInput('{not valid json')),
        /valid JSON/,
    );
});

test('chunkStructured rejects top-level scalar JSON', () => {
    assert.throws(
        () => chunkStructured(baseInput('"just a string"')),
        /array or object/,
    );
});

test('chunkStructured rejects top-level number', () => {
    assert.throws(
        () => chunkStructured(baseInput('42')),
        /array or object/,
    );
});

test('chunkStructured rejects top-level null', () => {
    assert.throws(
        () => chunkStructured(baseInput('null')),
        /array or object/,
    );
});

test('chunkStructured JSONL rejects the whole input on one bad line (no partial success)', () => {
    assert.throws(
        () => chunkStructured(baseInput(
            '{"a":1}\n{not valid}\n{"c":3}',
            { metadata: { source_uri: 'records/test.jsonl' } },
        )),
        /JSONL line 2/,
    );
});
