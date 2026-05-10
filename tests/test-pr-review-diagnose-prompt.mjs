// @ts-check
/**
 * Tests for the PR Review "Diagnose & fix" LLM messages builder.
 *
 * Pins:
 *   - Output is a well-formed [{role:'system'},{role:'user'}] array.
 *   - System prompt locks the "exactly one file" + JSON schema contract.
 *   - User prompt includes the file path, log byte count (when truncated),
 *     and the project tree.
 *   - No connection token / sensitive context leaks in.
 *
 * @since 2.14.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnoseFixMessages } from '../js/pr-review/diagnose-prompt.js';

function ctx(over = {}) {
    return {
        logs: 'AssertionError: expected 1 to equal 2\n',
        fileContent: 'export const x = 1;\n',
        filePath: 'src/x.js',
        projectTree: 'src/\n  x.js\n',
        prTitle: 'fix: bump x',
        ...over,
    };
}

test('returns a 2-message array with system + user roles in order', () => {
    const msgs = buildDiagnoseFixMessages(ctx());
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
});

test('system prompt mentions "exactly one file" constraint', () => {
    const msgs = buildDiagnoseFixMessages(ctx());
    assert.match(msgs[0].content, /exactly one file/i);
});

test('system prompt pins the JSON schema (path/newContent/rationale)', () => {
    const msgs = buildDiagnoseFixMessages(ctx());
    assert.match(msgs[0].content, /"path"/);
    assert.match(msgs[0].content, /"newContent"/);
    assert.match(msgs[0].content, /"rationale"/);
});

test('system prompt forbids code fences + extra prose', () => {
    const msgs = buildDiagnoseFixMessages(ctx());
    assert.match(msgs[0].content, /Do not include code fences/i);
    assert.match(msgs[0].content, /Do not include commentary outside/i);
});

test('user prompt includes the file path', () => {
    const msgs = buildDiagnoseFixMessages(ctx({ filePath: 'lib/util/foo.js' }));
    assert.match(msgs[1].content, /lib\/util\/foo\.js/);
});

test('user prompt includes the project tree text', () => {
    const msgs = buildDiagnoseFixMessages(ctx({ projectTree: 'README.md\nsrc/main.js\n' }));
    assert.match(msgs[1].content, /README\.md/);
    assert.match(msgs[1].content, /src\/main\.js/);
});

test('user prompt notes truncation when log was capped', () => {
    const msgs = buildDiagnoseFixMessages(ctx({
        logTruncatedAtCap: true,
        logTotalBytes: 1234567,
    }));
    assert.match(msgs[1].content, /Tail-truncated/);
    assert.match(msgs[1].content, /1234567 bytes/);
});

test('user prompt omits truncation note when no truncation', () => {
    const msgs = buildDiagnoseFixMessages(ctx({ logTruncatedAtCap: false }));
    assert.doesNotMatch(msgs[1].content, /Tail-truncated/);
});

test('user prompt handles missing PR title (no leading "Pull request:" line)', () => {
    const msgs = buildDiagnoseFixMessages(ctx({ prTitle: '' }));
    assert.doesNotMatch(msgs[1].content, /^Pull request:/);
});

test('user prompt falls back gracefully when no target file pre-identified', () => {
    const msgs = buildDiagnoseFixMessages(ctx({ filePath: null, fileContent: null }));
    assert.match(msgs[1].content, /No specific file pre-identified/);
});

test('no connection token / api key leaks (sanity)', () => {
    const msgs = buildDiagnoseFixMessages(ctx());
    const joined = msgs.map(m => m.content).join('\n');
    assert.doesNotMatch(joined, /token/i);
    assert.doesNotMatch(joined, /api[-_ ]?key/i);
});

test('defensive — empty/null context yields a system message and a user shell', () => {
    const msgs = buildDiagnoseFixMessages(/** @type any */({}));
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(typeof msgs[1].content, 'string');
});
