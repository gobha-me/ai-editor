/**
 * Behavior + source-scan tests for the session auto-commit tracker
 * (`js/tools/_session-auto-commits.js`) and its `commit_files` call site.
 *
 * Why this exists — gitea#486 root cause. `write_file` for new files
 * calls `Git.createFile()`, which is a one-file commit. The file enters
 * the repo tree, NOT as a dirty tab. When `commit_files` later runs, it
 * filters `State.openTabs` by `t.dirty` and only sees the *modifications*
 * (write_file-on-existing + edit_file paths leave a dirty tab). The
 * response then reports only the dirty paths.
 *
 * In the dogfood incident (qwen-3-6-plus, HTML-Games issue #238), this
 * shape caused the model to assume 2 of 4 freshly-written files were
 * uncommitted, costing 5+ turns of re-reading and `list_dirty_files`
 * looping (which itself triggered the consecutive-identical anti-loop
 * refusal — gitea#488).
 *
 * The fix (2.80.0):
 *   1. `write_file` new-file branch calls `recordAutoCommit(path)`.
 *   2. `commit_files` drains the tracker into `response.created`.
 *   3. `js/chat/conversations.js` clears the tracker on conversation
 *      switch / new chat / conversation delete (alongside
 *      `clearApprovedPlan()`).
 *
 * Subtests below pin the contract: record/get drains, idempotent record,
 * clear empties unconditionally, and `commit_files` handler actually calls
 * the drain function (source-scan — same precedent shape as 2.79.0's
 * `tests/test-edit-tracker-read-tool-contract.mjs`).
 *
 * Runs under `node --test`.
 *
 * @since 2.80.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    recordAutoCommit,
    getAutoCommittedSinceLastReport,
    clearAutoCommitted,
} from '../js/tools/_session-auto-commits.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const COMMIT_TOOLS = join(REPO_ROOT, 'js', 'tools', 'commit-tools.js');

test('recordAutoCommit + getAutoCommittedSinceLastReport drains the set', () => {
    clearAutoCommitted();
    recordAutoCommit('a/b.css');
    recordAutoCommit('c/d.js');
    const first = getAutoCommittedSinceLastReport();
    assert.deepEqual(first.sort(), ['a/b.css', 'c/d.js']);
    const second = getAutoCommittedSinceLastReport();
    assert.deepEqual(second, [], 'second get must return [] — first call drained the set');
});

test('recordAutoCommit is idempotent within a session', () => {
    clearAutoCommitted();
    recordAutoCommit('x.js');
    recordAutoCommit('x.js');
    recordAutoCommit('x.js');
    assert.deepEqual(getAutoCommittedSinceLastReport(), ['x.js']);
});

test('clearAutoCommitted empties the set unconditionally', () => {
    clearAutoCommitted();
    recordAutoCommit('one.js');
    recordAutoCommit('two.js');
    clearAutoCommitted();
    assert.deepEqual(getAutoCommittedSinceLastReport(), [], 'clear must drop entries that were not yet reported');
});

test('commit_files handler in commit-tools.js calls getAutoCommittedSinceLastReport', () => {
    const src = stripComments(readFileSync(COMMIT_TOOLS, 'utf8'));
    const body = findFunctionBody(src, 'commitFiles');
    assert.ok(
        body,
        'Could not locate `async function commitFiles(...)` in js/tools/commit-tools.js. ' +
        'If the handler shape changed (renamed, inlined into the register call, switched ' +
        'to a different signature), update findFunctionBody usage in this test.',
    );
    assert.match(
        body,
        /getAutoCommittedSinceLastReport\s*\(/,
        'commit_files handler body must call getAutoCommittedSinceLastReport(...) so ' +
        'paths auto-committed by write_file (new-file branch) surface in the response as ' +
        '`created: [...]`. Missing this call reproduces gitea#486 (model assumes write_file ' +
        'new files are uncommitted; spends 5+ turns chasing phantoms).',
    );
});

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Extract the brace-balanced body of `[async] function NAME(...) { ... }`.
 * Returns the substring INCLUDING the surrounding braces, or null. Honors
 * string and template literals so braces inside `"{"` / `` `${x}` `` don't
 * break depth tracking (same precedent as 2.78.0's
 * `tests/test-tool-failure-shapes.mjs` `extractBracedBlock`).
 */
function findFunctionBody(src, fnName) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
    const m = re.exec(src);
    if (!m) return null;
    let i = m.index + m[0].length;
    let parenDepth = 1;
    while (i < src.length && parenDepth > 0) {
        if (src[i] === '(') parenDepth++;
        else if (src[i] === ')') parenDepth--;
        i++;
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return null;
    return extractBracedBlock(src, i);
}

function extractBracedBlock(src, openBraceIdx) {
    if (src[openBraceIdx] !== '{') return null;
    let depth = 0;
    let i = openBraceIdx;
    let inString = null;
    let inTemplate = 0;
    const templateBraceDepth = [];
    while (i < src.length) {
        const ch = src[i];
        if (inString) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === inString) inString = null;
        } else if (inTemplate) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === '`') { inTemplate = 0; }
            else if (ch === '$' && src[i + 1] === '{') {
                templateBraceDepth.push(depth);
                depth++;
                i += 2;
                continue;
            } else if (ch === '}' && templateBraceDepth.length && depth - 1 === templateBraceDepth[templateBraceDepth.length - 1]) {
                templateBraceDepth.pop();
                depth--;
            }
        } else {
            if (ch === '"' || ch === "'") { inString = ch; }
            else if (ch === '`') { inTemplate = 1; }
            else if (ch === '{') { depth++; }
            else if (ch === '}') {
                depth--;
                if (depth === 0) return src.slice(openBraceIdx, i + 1);
            }
        }
        i++;
    }
    return null;
}
