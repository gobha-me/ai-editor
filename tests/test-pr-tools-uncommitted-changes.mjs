/**
 * Anti-regression CI guard for gitea#493 — `create_pull_request` must refuse
 * loudly when `State.openTabs` carries dirty (uncommitted) file tabs, not
 * silently open the PR against the last-committed head.
 *
 * Why this exists — qwen-3-6-plus session against `xcaliber/HTML-Games` issue
 * #238 (ai-editor v2.79.0–2.82.0 cluster, 2026-05-21): after the model called
 * `commit_files`, some `write_file`-flushed paths were under-reported (the
 * gap closed at 2.80.0). The model then called `create_pull_request` "on
 * faith" — but `pr-tools.js` only checked project-loaded and head≠base. Any
 * still-dirty CodeMirror tab was invisible to the Git provider; the PR
 * opened against a stale head.
 *
 * 2.84.0 fix shape (in `js/tools/pr-tools.js`): insert a precondition right
 * after the no-project guard that filters `State.openTabs` for `dirty` non-
 * issue tabs and returns the T1 failure envelope:
 *   { error: '...', code: 'uncommitted_changes', dirty_paths: [...] }
 *
 * This file is a source-scan lint — mirrors `tests/test-search-in-files-
 * truncation.mjs` (gitea#487 / 2.81.0) which pins the search-truncation
 * fail-loud shape the same way. Behavior is not exercised by `node --test`
 * because the handler depends on browser-side `State` / `Git` modules; the
 * browser smoke test is the right venue for full E2E, this lint is the
 * structural guarantee.
 *
 * Runs under `node --test`.
 *
 * @since 2.84.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PR_TOOLS = join(REPO_ROOT, 'js', 'tools', 'pr-tools.js');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Extract the arrow-function body of `registry.register('NAME', async (...) => { ... })`.
 * Returns the substring between the matching `{` and `}` of the handler body, or null
 * if no such registration is found.
 */
function extractHandlerBody(src, toolName) {
    const registerRe = new RegExp(
        `registry\\.register\\s*\\(\\s*['"]${toolName}['"]\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{`,
    );
    const m = registerRe.exec(src);
    if (!m) return null;
    const bodyStart = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = bodyStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(bodyStart, i);
        }
    }
    return null;
}

test('create_pull_request handler filters State.openTabs for dirty non-issue tabs', () => {
    const src = stripComments(readFileSync(PR_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'create_pull_request');
    assert.ok(
        body,
        `Could not locate registry.register('create_pull_request', async (...) => { ... }) ` +
        `in ${PR_TOOLS}. If the registration shape changed, update extractHandlerBody.`,
    );
    assert.match(
        body,
        /State\.openTabs/,
        `create_pull_request handler must read State.openTabs to detect dirty (uncommitted) ` +
        `files before opening the PR. The Git provider doesn't see CodeMirror-resident edits ` +
        `until commit_files flushes them — gitea#493 root cause.`,
    );
    assert.match(
        body,
        /\.dirty\b/,
        `create_pull_request handler must filter openTabs on the \`dirty\` flag. The openTabs ` +
        `shape (js/core.js) carries \`{ path, content, originalContent, dirty, type, ... }\`.`,
    );
    assert.match(
        body,
        /type\s*!==\s*['"]issue['"]/,
        `create_pull_request handler must exclude issue tabs (\`type === 'issue'\`) from the ` +
        `dirty filter. Issue tabs aren't files and don't carry working-tree state — including ` +
        `them would false-positive the refusal.`,
    );
});

test('create_pull_request handler returns code: \'uncommitted_changes\' on the dirty branch', () => {
    const src = stripComments(readFileSync(PR_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'create_pull_request');
    assert.ok(body, 'handler body missing');
    assert.match(
        body,
        /code:\s*['"]uncommitted_changes['"]/,
        `create_pull_request handler must return \`code: 'uncommitted_changes'\` on the ` +
        `dirty-tab refusal branch. T1 failure-shape contract (2.78.0) requires the error ` +
        `envelope to carry a stable machine-readable code; the loop's next_action_hint ` +
        `registry keys on it. Ensure 'uncommitted_changes' is also in VALID_CODES in ` +
        `tests/test-tool-failure-shapes.mjs.`,
    );
});

test('create_pull_request handler exposes dirty_paths field for model recovery', () => {
    const src = stripComments(readFileSync(PR_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'create_pull_request');
    assert.ok(body, 'handler body missing');
    // Match either ES6 shorthand (`dirty_paths` alone in the return object) or
    // longhand (`dirty_paths: <expr>`). Both forms are valid; the lint only
    // cares that the field exists in the returned envelope.
    assert.match(
        body,
        /dirty_paths\s*(?::|,|\n|\s*})/,
        `create_pull_request handler must return a \`dirty_paths\` field listing the ` +
        `uncommitted file paths. Without it, the model has to re-derive what needs ` +
        `flushing — a recovery step the envelope can serve directly.`,
    );
});

test('dirty-tab refusal precedes the head/base check in create_pull_request', () => {
    const src = stripComments(readFileSync(PR_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'create_pull_request');
    assert.ok(body, 'handler body missing');

    const dirtyMatch = body.match(/code:\s*['"]uncommitted_changes['"]/);
    const headBaseMatch = body.match(/headBranch\s*===\s*baseBranch/);
    assert.ok(dirtyMatch, 'dirty refusal site not found');
    assert.ok(headBaseMatch, 'head/base equality check not found');
    assert.ok(
        dirtyMatch.index < headBaseMatch.index,
        `dirty-tab refusal must appear BEFORE the head/base equality check in the handler ` +
        `body. The bug class is stale-head silence; surfacing the loud dirty refusal before ` +
        `any branch-resolution noise is the loudest possible signal. Reordering these breaks ` +
        `the design intent — if a refactor needs them in the other order, update this lint ` +
        `with the reasoning.`,
    );
});
