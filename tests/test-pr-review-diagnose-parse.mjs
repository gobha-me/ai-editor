// @ts-check
/**
 * Tests for the PR Review "Diagnose & fix" response parser.
 *
 * Pins the tolerant-parser contract:
 *   - happy JSON,
 *   - JSON inside ```json fences,
 *   - JSON with leading prose (model preamble),
 *   - missing required fields → {ok:false},
 *   - non-string newContent → {ok:false},
 *   - defensive on null / "" / non-string raw.
 *
 * @since 2.14.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePatchResponse } from '../js/pr-review/diagnose-parse.js';

test('happy JSON', () => {
    const r = parsePatchResponse(JSON.stringify({
        path: 'src/x.js',
        newContent: 'export const x = 2;\n',
        rationale: 'matches the test expectation',
    }));
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.path, 'src/x.js');
        assert.equal(r.newContent, 'export const x = 2;\n');
        assert.equal(r.rationale, 'matches the test expectation');
    }
});

test('JSON inside ```json fence', () => {
    const wrapped = '```json\n' + JSON.stringify({
        path: 'a.js', newContent: 'a', rationale: 'r',
    }) + '\n```';
    const r = parsePatchResponse(wrapped);
    assert.equal(r.ok, true);
});

test('JSON inside bare ``` fence', () => {
    const wrapped = '```\n' + JSON.stringify({
        path: 'a.js', newContent: 'a', rationale: 'r',
    }) + '\n```';
    const r = parsePatchResponse(wrapped);
    assert.equal(r.ok, true);
});

test('JSON with leading prose (model preamble)', () => {
    const raw = `Here's my proposed fix:\n\n${JSON.stringify({
        path: 'a.js', newContent: 'a', rationale: 'r',
    })}`;
    const r = parsePatchResponse(raw);
    assert.equal(r.ok, true);
});

test('JSON with trailing prose', () => {
    const raw = `${JSON.stringify({
        path: 'a.js', newContent: 'a', rationale: 'r',
    })}\n\nHope this helps!`;
    const r = parsePatchResponse(raw);
    assert.equal(r.ok, true);
});

test('JSON with nested braces in newContent string', () => {
    const newContent = 'function f() { return { nested: { deep: 1 } }; }\n';
    const r = parsePatchResponse(JSON.stringify({
        path: 'a.js', newContent, rationale: 'r',
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.newContent, newContent);
});

test('missing path → {ok:false}', () => {
    const r = parsePatchResponse(JSON.stringify({ newContent: 'a', rationale: 'r' }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /path/);
});

test('empty path → {ok:false}', () => {
    const r = parsePatchResponse(JSON.stringify({ path: '', newContent: 'a', rationale: 'r' }));
    assert.equal(r.ok, false);
});

test('missing newContent → {ok:false}', () => {
    const r = parsePatchResponse(JSON.stringify({ path: 'a.js', rationale: 'r' }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /newContent/);
});

test('non-string newContent → {ok:false}', () => {
    const r = parsePatchResponse('{"path":"a.js","newContent":123,"rationale":"r"}');
    assert.equal(r.ok, false);
});

test('rationale missing → defaults to empty string (not a hard fail)', () => {
    const r = parsePatchResponse(JSON.stringify({ path: 'a.js', newContent: 'a' }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.rationale, '');
});

test('defensive — null raw', () => {
    const r = parsePatchResponse(null);
    assert.equal(r.ok, false);
});

test('defensive — empty string raw', () => {
    const r = parsePatchResponse('');
    assert.equal(r.ok, false);
});

test('defensive — non-string raw (number)', () => {
    // @ts-expect-error — defensive call
    const r = parsePatchResponse(42);
    assert.equal(r.ok, false);
});

test('defensive — no JSON object in response', () => {
    const r = parsePatchResponse('just some prose, no JSON here');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /No JSON object/);
});

test('defensive — malformed JSON', () => {
    const r = parsePatchResponse('{this is: not valid json}');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /JSON parse failed|No JSON object/);
});

test('defensive — JSON but a top-level array', () => {
    const r = parsePatchResponse('[{"path":"a.js","newContent":"a","rationale":"r"}]');
    // The extractor skips to the first { which is inside the array,
    // so it pulls out the inner object successfully — that's fine.
    assert.equal(r.ok, true);
});

test('defensive — top-level non-object JSON (string with braces)', () => {
    // No `{` to start an object → no match → ok:false.
    const r = parsePatchResponse('"a string"');
    assert.equal(r.ok, false);
});

test('defensive — escaped quotes in newContent string', () => {
    const newContent = 'console.log("with \\"quotes\\" inside");\n';
    const obj = { path: 'a.js', newContent, rationale: 'r' };
    const raw = JSON.stringify(obj);
    const r = parsePatchResponse(raw);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.newContent, newContent);
});
