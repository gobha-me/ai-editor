/**
 * Anti-regression CI guard for gitea#487 — `search_in_files` truncation
 * must surface as a hard refusal (error envelope) when no matches landed
 * inside the searched slice, not as a successful `results: []` plus a
 * footnote hint that the model skims past.
 *
 * Why this exists — qwen-3-6-plus session against HTML-Games issue #238
 * (ai-editor v2.77.0, 2026-05-21) called `search_in_files` for the game
 * bootstrap code in a 343-file repo. The 50-file cap clipped the scan;
 * the response was `results: []` + `files_truncated: true` + a "narrow
 * scope" hint. The model treated the empty array as authoritative ("no
 * matches") and moved on — the most expensive failure mode possible per
 * the issue: silent + indistinguishable from a real "not found."
 *
 * 2.81.0 fix shape (two pieces, both in `js/tools/search-tools.js`):
 *   1. Raise the hardcoded cap 50 → 500 via module-scope `MAX_FILES`.
 *   2. When the scan truncated AND zero results landed, return a refusal
 *      envelope (`{ error, code: 'search_truncated', ... }`) instead of
 *      `results: []` + hint. Truncated WITH results keeps the current
 *      success+hint shape (model has actionable matches).
 *
 * This file is a source-scan lint — mirrors
 * `tests/test-edit-tracker-read-tool-contract.mjs` (2.79.0) which pins
 * the read-tool→staleness-clock contract the same way. Behavior is not
 * exercised by `node --test` because the handler depends on browser-side
 * `State`/`Git`/`IgnoreManager` modules; the browser suite is the right
 * venue for full E2E, this lint is the structural guarantee.
 *
 * Runs under `node --test`.
 *
 * @since 2.81.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SEARCH_TOOLS = join(REPO_ROOT, 'js', 'tools', 'search-tools.js');

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

test('search-tools.js declares MAX_FILES = 500 at module scope', () => {
    const src = stripComments(readFileSync(SEARCH_TOOLS, 'utf8'));
    assert.match(
        src,
        /const\s+MAX_FILES\s*=\s*500\s*;/,
        `Expected \`const MAX_FILES = 500;\` at module scope in ${SEARCH_TOOLS}. ` +
        `If the cap was renamed or moved, update this lint AND the in-handler ` +
        `references at lines that previously read 50/MAX_FILES. The cap exists ` +
        `because the pre-2.81.0 literal 50 clipped HTML-Games (343 files) and ` +
        `the model treated the resulting empty results as authoritative.`,
    );
});

test('search_in_files handler references MAX_FILES, no remaining bare `50` cap', () => {
    const src = stripComments(readFileSync(SEARCH_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'search_in_files');
    assert.ok(
        body,
        `Could not locate registry.register('search_in_files', async (...) => { ... }) ` +
        `in ${SEARCH_TOOLS}. If the registration shape changed, update extractHandlerBody.`,
    );
    assert.match(
        body,
        /\bMAX_FILES\b/,
        `search_in_files handler must reference MAX_FILES (the module-scope cap). ` +
        `If you replaced the constant with a different name, update this lint.`,
    );
    // Negative check — no bare 50 cap should remain in the handler body. We
    // accept `50` only inside string literals (none today), so a plain digit
    // match is the right guard.
    assert.doesNotMatch(
        body,
        /\bslice\s*\(\s*0\s*,\s*50\s*\)/,
        `search_in_files handler still slices to 50 — replace with MAX_FILES. ` +
        `gitea#487: the 50-cap was the root cause; raising it to 500 is half ` +
        `the fix, removing the literal is the other half (regression guard).`,
    );
    assert.doesNotMatch(
        body,
        /Math\.min\s*\(\s*files\.length\s*,\s*50\s*\)/,
        `search_in_files handler still has \`Math.min(files.length, 50)\` — ` +
        `replace with \`Math.min(files.length, MAX_FILES)\` so files_searched ` +
        `reflects the real cap.`,
    );
});

test('search_in_files handler returns refusal envelope on truncated + zero results', () => {
    const src = stripComments(readFileSync(SEARCH_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'search_in_files');
    assert.ok(body, 'handler body missing');

    // The branch shape we require:
    //   if (files.length > MAX_FILES && results.length === 0) {
    //       return { error: '...', code: 'search_truncated', ... };
    //   }
    // Two regex anchors — guard predicate, then the code field on a return
    // inside the same branch. We don't try to brace-walk; the code field is
    // unique to this branch (search_error is the catch block).
    assert.match(
        body,
        /files\.length\s*>\s*MAX_FILES\s*&&\s*results\.length\s*===\s*0/,
        `search_in_files handler must branch on \`files.length > MAX_FILES && ` +
        `results.length === 0\` to fail loud when truncation hid all matches. ` +
        `gitea#487: returning \`results: []\` + hint in this case is the ` +
        `silent-failure mode the model can't distinguish from a real no-match.`,
    );
    assert.match(
        body,
        /code:\s*['"]search_truncated['"]/,
        `search_in_files handler must return \`code: 'search_truncated'\` on ` +
        `the truncated-and-empty branch. T1 failure-shape contract (2.78.0) ` +
        `requires the error envelope to carry a stable machine-readable code; ` +
        `the loop's next_action_hint registry keys on it.`,
    );
});

test('search_in_files truncated-with-results path still returns success envelope', () => {
    const src = stripComments(readFileSync(SEARCH_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'search_in_files');
    assert.ok(body, 'handler body missing');

    // Inverse guard — the success envelope must still emit `files_truncated`
    // and `hint` when truncated WITH results. The model has actionable
    // matches to follow; the hint is value-add, not value-substitute.
    assert.match(
        body,
        /files_truncated:\s*true/,
        `Truncated-with-results path must still surface \`files_truncated: true\`. ` +
        `The fail-loud shape applies only when results are empty.`,
    );
    assert.match(
        body,
        /files\.length\s*>\s*MAX_FILES\s*\?/,
        `The success-envelope conditional spread must read \`files.length > MAX_FILES\` ` +
        `(not the old bare 50 literal).`,
    );
});
