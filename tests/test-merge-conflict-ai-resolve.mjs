/**
 * Pure-helper tests for the slice-3 AI resolve modules:
 *   - js/merge-conflict/ai-resolve-prompt.js
 *   - js/merge-conflict/ai-resolve-parse.js
 *   - js/merge-conflict/resolve.js (the new {choice:'ai', content} branch)
 *
 * Browser-free — no _node-shim.mjs needed. The LLM call itself is not
 * exercised here; the surface owns that and dogfood validates it.
 *
 * @since 2.21.0 (Touch 3 Merge Conflict Resolver — slice 3)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractHunks } from '../js/merge-conflict/hunks.js';
import { applyResolutions } from '../js/merge-conflict/resolve.js';
import { buildAiResolveMessages } from '../js/merge-conflict/ai-resolve-prompt.js';
import { parseAiResolveResponse } from '../js/merge-conflict/ai-resolve-parse.js';

// ============================================
// applyResolutions — AI choice branch
// ============================================

test('applyResolutions accepts {choice:"ai", content} per hunk and emits content lines verbatim', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    const ai = { choice: 'ai', content: ['MERGED'] };
    assert.equal(applyResolutions(base, head, { 0: ai }), 'a\nMERGED\nc');
});

test('applyResolutions throws on {choice:"ai", content:<non-array>}', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    assert.throws(
        () => applyResolutions(base, head, { 0: { choice: 'ai', content: 'oops' } }),
        /Unknown resolution choice/,
    );
});

test('applyResolutions throws on object choice with unknown choice key', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    assert.throws(
        () => applyResolutions(base, head, { 0: { choice: 'foo', content: ['x'] } }),
        /Unknown resolution choice/,
    );
});

test('applyResolutions throws when AI content array contains a non-string', () => {
    const base = 'a\nb\nc';
    const head = 'a\nB\nc';
    assert.throws(
        () => applyResolutions(base, head, { 0: { choice: 'ai', content: ['ok', 42] } }),
        /Unknown resolution choice/,
    );
});

test('applyResolutions: mixed theirs / ai / both across three hunks', () => {
    // Three independent hunks separated by equal-line runs.
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni';
    const head = 'a\nB\nc\nD\ne\nf\nG\nh\ni';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 3);
    const aiContent = ['MERGED-D'];
    const resolutions = {
        0: 'theirs',                            // keep b
        1: { choice: 'ai', content: aiContent }, // override d/D
        2: 'both',                              // g + G
    };
    assert.equal(
        applyResolutions(base, head, resolutions),
        'a\nb\nc\nMERGED-D\ne\nf\ng\nG\nh\ni',
    );
});

test('applyResolutions preserves CRLF when emitting AI content', () => {
    const base = 'a\r\nb\r\nc';
    const head = 'a\r\nB\r\nc';
    const hunks = extractHunks(base, head);
    assert.equal(hunks.length, 1);
    const resolutions = { 0: { choice: 'ai', content: ['M1', 'M2'] } };
    // splitLines/joinLines preserves CRLF on equal-line runs; the AI
    // branch pushes content verbatim. We verify the CRLF on the unchanged
    // lines round-trips and the AI lines land on plain \r\n boundaries.
    assert.equal(
        applyResolutions(base, head, resolutions),
        'a\r\nM1\r\nM2\r\nc',
    );
});

// ============================================
// buildAiResolveMessages — shape + edge markers
// ============================================

test('buildAiResolveMessages: returns [system, user] with all four sections rendered', () => {
    const out = buildAiResolveMessages({
        filePath: 'src/foo.js',
        theirs: ['return a;'],
        ours: ['return b;'],
        contextBefore: ['function f() {'],
        contextAfter: ['}'],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'system');
    assert.equal(out[1].role, 'user');
    // System prompt locks the JSON schema.
    assert.match(out[0].content, /"resolvedLines"/);
    assert.match(out[0].content, /"rationale"/);
    assert.match(out[0].content, /JSON object/);
    // User block carries every required section.
    assert.match(out[1].content, /## File\nsrc\/foo\.js/);
    assert.match(out[1].content, /## Context before/);
    assert.match(out[1].content, /## Incoming/);
    assert.match(out[1].content, /## Current/);
    assert.match(out[1].content, /## Context after/);
    assert.match(out[1].content, /return a;/);
    assert.match(out[1].content, /return b;/);
    assert.match(out[1].content, /function f\(\) \{/);
});

test('buildAiResolveMessages: substitutes edge markers when context arrays are empty', () => {
    const out = buildAiResolveMessages({
        filePath: 'src/foo.js',
        theirs: ['x'],
        ours: ['y'],
        contextBefore: [],
        contextAfter: [],
    });
    assert.match(out[1].content, /\(top of file\)/);
    assert.match(out[1].content, /\(end of file\)/);
});

test('buildAiResolveMessages: handles pure-insert / pure-delete with explicit empty markers', () => {
    const inserted = buildAiResolveMessages({
        filePath: 'a.js',
        theirs: [],
        ours: ['NEW'],
        contextBefore: ['x'],
        contextAfter: ['y'],
    });
    assert.match(inserted[1].content, /\(empty — pure insert on the head side\)/);
    const deleted = buildAiResolveMessages({
        filePath: 'a.js',
        theirs: ['OLD'],
        ours: [],
        contextBefore: ['x'],
        contextAfter: ['y'],
    });
    assert.match(deleted[1].content, /\(empty — pure delete on the head side\)/);
});

// ============================================
// parseAiResolveResponse — happy path + error cases
// ============================================

test('parseAiResolveResponse: happy path round-trips resolvedLines and rationale', () => {
    const raw = JSON.stringify({
        resolvedLines: ['line 1', 'line 2'],
        rationale: 'Combined both intents.',
    });
    const r = parseAiResolveResponse(raw);
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.deepEqual(r.resolvedLines, ['line 1', 'line 2']);
        assert.equal(r.rationale, 'Combined both intents.');
    }
});

test('parseAiResolveResponse: rejects missing or non-array resolvedLines', () => {
    const r1 = parseAiResolveResponse(JSON.stringify({ rationale: 'x' }));
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.error, /resolvedLines/);

    const r2 = parseAiResolveResponse(JSON.stringify({ resolvedLines: 'not an array' }));
    assert.equal(r2.ok, false);
});

test('parseAiResolveResponse: rejects non-string elements inside resolvedLines', () => {
    const r = parseAiResolveResponse(JSON.stringify({
        resolvedLines: ['ok', 42, 'still-bad'],
    }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /resolvedLines\[1\]/);
});

test('parseAiResolveResponse: tolerates ```json fences and leading/trailing prose', () => {
    const raw = 'Here is the resolution:\n```json\n' +
        JSON.stringify({ resolvedLines: ['x'], rationale: 'y' }) +
        '\n```\nLet me know if you want changes.';
    const r = parseAiResolveResponse(raw);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.resolvedLines, ['x']);
});

test('parseAiResolveResponse: returns ok:false on empty / null / non-string input', () => {
    assert.equal(parseAiResolveResponse('').ok, false);
    assert.equal(parseAiResolveResponse(null).ok, false);
    assert.equal(parseAiResolveResponse(undefined).ok, false);
    assert.equal(parseAiResolveResponse(42).ok, false);
});

test('parseAiResolveResponse: rationale defaults to empty string when missing', () => {
    const r = parseAiResolveResponse(JSON.stringify({ resolvedLines: ['x'] }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.rationale, '');
});
