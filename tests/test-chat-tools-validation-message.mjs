/**
 * Tests for the validation-error message shape in `js/chat/tools.js`.
 *
 * Origin: gitea#415 — qwen-3-6-plus called `read_lines` without `path` and
 * got back `"This usually happens when the AI response was truncated. Please
 * provide all required parameters."` even though the response was not
 * truncated; the schema is simply inconsistent (`replace_lines` doesn't take
 * `path`, `read_lines` does). The truncation hint sent the model into a
 * retry loop. The error now plainly states what's missing and what's
 * required, letting the caller act on `missingParams` / `providedArgs`
 * directly.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateToolParameters } from '../js/chat/tools.js';

test('read_lines missing `path` returns plain error (no truncation blame)', () => {
    const result = validateToolParameters('read_lines', { start_line: 1, end_line: 10 });
    assert.ok(result, 'should return a validation error object');
    assert.match(result.error, /missing required parameter/i);
    assert.match(result.error, /path/, 'error must name the missing parameter');
    assert.doesNotMatch(result.error, /truncated/i,
        'the misleading "AI response was truncated" hypothesis must not appear');
    assert.deepEqual(result.missingParams, ['path']);
    assert.deepEqual(result.providedArgs, { start_line: 1, end_line: 10 });
});

test('error names the full required-set so the caller can re-shape', () => {
    const result = validateToolParameters('read_lines', {});
    assert.match(result.error, /path/);
    assert.match(result.error, /start_line/);
    assert.match(result.error, /end_line/);
});

test('create_file missing `content` produces same shape (sanity for non-read_lines path)', () => {
    const result = validateToolParameters('create_file', { path: 'x.js', message: 'create x' });
    assert.match(result.error, /missing required parameter/i);
    assert.match(result.error, /content/);
    assert.doesNotMatch(result.error, /truncated/i);
    assert.deepEqual(result.missingParams, ['content']);
});

test('valid args return null (no false-positive validation error)', () => {
    const result = validateToolParameters('read_lines', {
        path: 'js/app.js',
        start_line: 1,
        end_line: 10,
    });
    assert.equal(result, null);
});

test('unknown tool passes through (null)', () => {
    const result = validateToolParameters('nonexistent_tool', { foo: 'bar' });
    assert.equal(result, null);
});
