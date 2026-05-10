/**
 * Tests for the 2.15.1 numeric-coercion guard on `read_lines`.
 *
 * Origin: HTML-Games dogfood, Sonnet 4.6, 2026-05-10. The model passed
 * `start_line` / `end_line` as JSON-string-encoded integers ("85" not 85).
 * The validator's `end_line < start_line` then did lexicographic
 * comparison ("105" < "85" → true because '1' < '8'), trapping the model
 * in a shrinking-range loop that no value could escape — burned ~9 min /
 * 2.3M tokens / $1.84 before the session ran out. The fix coerces all
 * three line-number args to numbers at the boundary with a NaN guard.
 *
 * Test seam: stubs `Git.getFile` (mirrors `tests/test-tools-file-content.mjs`)
 * so the registered handler resolves through the buffer-aware reader without
 * needing IDB or a real network.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { Git } from '../js/git.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { registerScanTools } from '../js/tools/scan-tools.js';

const FIXTURE_LINES = 342;
const FIXTURE_CONTENT = Array.from({ length: FIXTURE_LINES }, (_, i) => `line${i + 1}`).join('\n');

let _origGetFile;

function getHandler(name) {
    const handler = ToolRegistry.handlers.get(name);
    assert.ok(handler, `tool ${name} should be registered`);
    return handler;
}

beforeEach(() => {
    ToolRegistry.clear();
    registerScanTools(ToolRegistry);
    State.currentFile = null;
    State.editorContent = '';
    State.openTabs = [];
    State.currentProject = { owner: 'owner', repo: 'repo' };
    State.currentBranch = 'main';
    if (!_origGetFile) _origGetFile = Git.getFile;
    Git.getFile = async (_o, _r, p) => ({ path: p, content: FIXTURE_CONTENT });
});

test('string-encoded start_line/end_line return the lines, not the false-rejection error', async () => {
    const read_lines = getHandler('read_lines');
    const result = await read_lines({ path: 'test.txt', start_line: '85', end_line: '105' });
    assert.equal(result.error, undefined,
        '"105" lex-compares less than "85", so without coercion this returned the spurious end < start error');
    assert.equal(result.start_line, 85);
    assert.equal(result.end_line, 105);
    assert.equal(result.line_count, FIXTURE_LINES);
    const extracted = result.content.split('\n');
    assert.equal(extracted.length, 21);
    assert.equal(extracted[0], 'line85');
    assert.equal(extracted[20], 'line105');
});

test('numeric start_line/end_line return the same result (regression guard)', async () => {
    const read_lines = getHandler('read_lines');
    const result = await read_lines({ path: 'test.txt', start_line: 85, end_line: 105 });
    assert.equal(result.error, undefined);
    assert.equal(result.start_line, 85);
    assert.equal(result.end_line, 105);
    const extracted = result.content.split('\n');
    assert.equal(extracted[0], 'line85');
    assert.equal(extracted[20], 'line105');
});

test('non-numeric start_line surfaces the new "must be numbers" error', async () => {
    const read_lines = getHandler('read_lines');
    const result = await read_lines({ path: 'test.txt', start_line: 'abc', end_line: 10 });
    assert.match(result.error, /must be numbers/);
    assert.match(result.error, /start="abc"/);
});

test('genuine end < start still surfaces the real "Invalid end_line" error', async () => {
    const read_lines = getHandler('read_lines');
    const result = await read_lines({ path: 'test.txt', start_line: 200, end_line: 100 });
    assert.match(result.error, /Invalid end_line: 100/);
    assert.match(result.error, /must be between 200 and 342/);
});

test('genuine end < start with string-encoded args also surfaces the real error (not the false-positive)', async () => {
    const read_lines = getHandler('read_lines');
    const result = await read_lines({ path: 'test.txt', start_line: '200', end_line: '100' });
    assert.match(result.error, /Invalid end_line: 100/,
        'after coercion the comparison is numeric, so the error reflects the parsed values');
});

test('string-encoded context_lines expands by N, not by string-concatenation', async () => {
    const read_lines = getHandler('read_lines');
    // Without coercion, end_num + ctx_num was end_line + context_lines:
    //   "100" + "3" → "1003" (string concat), then Math.min(342, "1003") → 342.
    // With coercion: 100 + 3 → 103, exactly the requested 3-line tail expansion.
    const result = await read_lines({
        path: 'test.txt',
        start_line: '50',
        end_line: '100',
        context_lines: '3',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.start_line, 47);
    assert.equal(result.end_line, 103);
    assert.equal(result.context_lines, 3);
});
