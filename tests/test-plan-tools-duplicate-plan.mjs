/**
 * Anti-regression CI guard for gitea#499 — `submit_plan_for_approval` must
 * refuse loudly when the same plan body has already been approved in this
 * conversation AND `State.openTabs` still carries uncommitted edits, not
 * silently mount a second approval card and restart the executor from step 1.
 *
 * Why this exists — qwen-3-6-plus session against `xcaliber/HTML-Games` issue
 * #288 (ai-editor 2.85.0-dev, 2026-05-21): the model called
 * `submit_plan_for_approval` a second time with a byte-identical plan body
 * mid-execution. The user re-approved; the executor re-read four files it
 * had already edited and "discovered" its own prior edits as fresh work.
 * Burned an estimated 2-3M tokens of re-execution before user interrupt.
 *
 * 2.87.0 fix shape (in `js/tools/plan-tools.js`): after the arg-validation
 * returns, before `setPendingPlanApproval`, read `getApprovedPlan()`; if the
 * stored plan equals the incoming trimmed plan AND `State.openTabs` has any
 * dirty non-issue tab, return the T1 failure envelope:
 *   { error: '...', code: 'already_approved', dirty_paths: [...], approved_at }
 *
 * This file is a source-scan lint — mirrors `tests/test-pr-tools-uncommitted-
 * changes.mjs` (gitea#493 / 2.84.0) which pins the analogous dirty-tab fail-
 * loud shape on `create_pull_request`. Behavior is not exercised by `node
 * --test` because the handler depends on browser-side `State` / approval-
 * card flow; the browser smoke test is the right venue for full E2E, this
 * lint is the structural guarantee.
 *
 * Runs under `node --test`.
 *
 * @since 2.87.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PLAN_TOOLS = join(REPO_ROOT, 'js', 'tools', 'plan-tools.js');

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

test('submit_plan_for_approval handler filters State.openTabs for dirty non-issue tabs', () => {
    const src = stripComments(readFileSync(PLAN_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'submit_plan_for_approval');
    assert.ok(
        body,
        `Could not locate registry.register('submit_plan_for_approval', async (...) => { ... }) ` +
        `in ${PLAN_TOOLS}. If the registration shape changed, update extractHandlerBody.`,
    );
    assert.match(
        body,
        /State\.openTabs/,
        `submit_plan_for_approval handler must read State.openTabs to detect in-flight ` +
        `uncommitted edits before re-approving the same plan. CodeMirror-resident edits ` +
        `aren't visible to the plan store otherwise — gitea#499 root cause.`,
    );
    assert.match(
        body,
        /\.dirty\b/,
        `submit_plan_for_approval handler must filter openTabs on the \`dirty\` flag. The ` +
        `openTabs shape (js/core.js) carries \`{ path, content, originalContent, dirty, type, ... }\`.`,
    );
    assert.match(
        body,
        /type\s*!==\s*['"]issue['"]/,
        `submit_plan_for_approval handler must exclude issue tabs (\`type === 'issue'\`) from ` +
        `the dirty filter. Issue tabs aren't files and don't carry working-tree state — ` +
        `including them would false-positive the refusal. Mirrors pr-tools.js / gitea#493.`,
    );
});

test('submit_plan_for_approval handler returns code: \'already_approved\' on the duplicate branch', () => {
    const src = stripComments(readFileSync(PLAN_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'submit_plan_for_approval');
    assert.ok(body, 'handler body missing');
    assert.match(
        body,
        /code:\s*['"]already_approved['"]/,
        `submit_plan_for_approval handler must return \`code: 'already_approved'\` on the ` +
        `duplicate-plan + dirty-tabs branch. T1 failure-shape contract (2.78.0) requires the ` +
        `error envelope to carry a stable machine-readable code; the loop's next_action_hint ` +
        `registry keys on it. Ensure 'already_approved' is also in VALID_CODES in ` +
        `tests/test-tool-failure-shapes.mjs.`,
    );
});

test('submit_plan_for_approval handler exposes dirty_paths field for model recovery', () => {
    const src = stripComments(readFileSync(PLAN_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'submit_plan_for_approval');
    assert.ok(body, 'handler body missing');
    // Match either ES6 shorthand or longhand — same idiom as pr-tools.js lint.
    assert.match(
        body,
        /dirty_paths\s*(?::|,|\n|\s*})/,
        `submit_plan_for_approval handler must return a \`dirty_paths\` field listing the ` +
        `uncommitted file paths. Without it, the model has to re-derive what needs flushing — ` +
        `a recovery step the envelope can serve directly. Mirrors create_pull_request's ` +
        `dirty_paths field (gitea#493 / 2.84.0).`,
    );
});

test('submit_plan_for_approval handler compares incoming plan against getApprovedPlan()', () => {
    const src = stripComments(readFileSync(PLAN_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'submit_plan_for_approval');
    assert.ok(body, 'handler body missing');
    assert.match(
        body,
        /getApprovedPlan\s*\(/,
        `submit_plan_for_approval handler must call getApprovedPlan() to read the ` +
        `previously-approved plan slot. Without this read the duplicate-plan check has ` +
        `no left-hand side. The helper is exported from js/chat/state.js (gitea#424 / 2.52.0).`,
    );
});

test('idempotency guard precedes the setPendingPlanApproval call', () => {
    const src = stripComments(readFileSync(PLAN_TOOLS, 'utf8'));
    const body = extractHandlerBody(src, 'submit_plan_for_approval');
    assert.ok(body, 'handler body missing');

    const guardMatch = body.match(/code:\s*['"]already_approved['"]/);
    const cardMatch = body.match(/setPendingPlanApproval\s*\(/);
    assert.ok(guardMatch, 'already_approved refusal site not found');
    assert.ok(cardMatch, 'setPendingPlanApproval call not found');
    assert.ok(
        guardMatch.index < cardMatch.index,
        `The 'already_approved' refusal must appear BEFORE the setPendingPlanApproval call ` +
        `in the handler body. The bug class is silent re-approval; the loud refusal needs to ` +
        `short-circuit BEFORE any user-pause card is mounted. Reordering breaks the design ` +
        `intent — if a refactor needs them in the other order, update this lint with the ` +
        `reasoning.`,
    );
});
