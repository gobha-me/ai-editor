/**
 * Workspace-settings serializer tests (1.4.4).
 *
 * Defends two contracts:
 *   - Round-trip stability: parse(serialize(x)) preserves safelisted keys
 *     and stable ordering.
 *   - Strip-on-read: every non-safelisted key encountered at parse time
 *     surfaces as a diagnostic and is dropped from the result.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    serialize,
    parse,
    FILE_PATH,
} from '../js/intelligence/workspace-settings/index.js';

/* ---------------- serialize ---------------- */

test('serialize emits empty object + trailing newline for empty input', () => {
    assert.equal(serialize({}), '{}\n');
});

test('serialize sorts keys lexicographically', () => {
    const out = serialize({ uiScale: 110, theme: 'editorial', editorFontSize: 14 });
    assert.equal(out, '{\n  "editorFontSize": 14,\n  "theme": "editorial",\n  "uiScale": 110\n}\n');
});

test('serialize drops non-safelisted keys silently', () => {
    const out = serialize({ theme: 'editorial', llmApiKey: 'sk-evil', unknown: true });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { theme: 'editorial' });
});

test('serialize preserves nested safelisted values', () => {
    const out = serialize({
        summarizer: { recentCountBase: 8, threshold: 25 },
        summarizerMode: 'custom',
    });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.summarizer, { recentCountBase: 8, threshold: 25 });
    assert.equal(parsed.summarizerMode, 'custom');
});

test('serialize round-trip is stable byte-for-byte', () => {
    const a = serialize({ theme: 'editorial', uiScale: 110 });
    const b = serialize({ uiScale: 110, theme: 'editorial' });
    assert.equal(a, b);
});

/* ---------------- parse ---------------- */

test('parse empty / whitespace string returns no overrides + no warnings', () => {
    assert.deepEqual(parse(''), { overrides: {}, warnings: [] });
    assert.deepEqual(parse('   \n  '), { overrides: {}, warnings: [] });
});

test('parse malformed JSON surfaces a malformed_json warning', () => {
    const { overrides, warnings } = parse('{ this is not json');
    assert.deepEqual(overrides, {});
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].type, 'malformed_json');
});

test('parse non-object root surfaces a not_an_object warning', () => {
    const arrayResult = parse('[1, 2, 3]');
    assert.deepEqual(arrayResult.overrides, {});
    assert.equal(arrayResult.warnings.some((w) => w.type === 'not_an_object'), true);

    const stringResult = parse('"hello"');
    assert.deepEqual(stringResult.overrides, {});
    assert.equal(stringResult.warnings.some((w) => w.type === 'not_an_object'), true);
});

test('parse strips unsafe keys with diagnostic warnings', () => {
    const json = JSON.stringify({
        theme: 'editorial',
        llmApiKey: 'sk-evil',
        connections: [{ token: 'leaked' }],
        mcpServers: [],
    });
    const { overrides, warnings } = parse(json, { sourcePath: FILE_PATH });

    assert.deepEqual(overrides, { theme: 'editorial' });

    const stripped = warnings.filter((w) => w.type === 'unsafe_key_stripped').map((w) => w.key);
    assert.equal(stripped.includes('llmApiKey'), true);
    assert.equal(stripped.includes('connections'), true);
    assert.equal(stripped.includes('mcpServers'), true);

    // Source path threaded onto every warning.
    for (const w of warnings) assert.equal(w.sourcePath, FILE_PATH);
});

test('parse preserves multiple safelisted keys', () => {
    const json = JSON.stringify({
        theme: 'editorial',
        uiScale: 125,
        editorFontSize: 14,
        showLineNumbers: false,
    });
    const { overrides, warnings } = parse(json);
    assert.deepEqual(overrides, {
        theme: 'editorial',
        uiScale: 125,
        editorFontSize: 14,
        showLineNumbers: false,
    });
    assert.equal(warnings.length, 0);
});

test('serialize → parse round trip reconstructs safelisted overrides', () => {
    const input = { theme: 'editorial', uiScale: 110, editorFontSize: 14, showLineNumbers: false };
    const text = serialize(input);
    const { overrides, warnings } = parse(text);
    assert.deepEqual(overrides, input);
    assert.equal(warnings.length, 0);
});

test('1.6.7 — parse strips role with diagnostic warning (denylisted)', () => {
    const json = JSON.stringify({
        theme: 'editorial',
        role: 'coder', // pre-1.6.7 this would have applied; now it's stripped.
    });
    const { overrides, warnings } = parse(json);
    assert.deepEqual(overrides, { theme: 'editorial' });
    const stripped = warnings.filter((w) => w.type === 'unsafe_key_stripped').map((w) => w.key);
    assert.equal(stripped.includes('role'), true, 'role must surface as unsafe_key_stripped');
});

test('FILE_PATH points at .aieditor/settings.json', () => {
    assert.equal(FILE_PATH, '.aieditor/settings.json');
});
