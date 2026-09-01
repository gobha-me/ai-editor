/**
 * Regression — commit-flow cohort (github#45 + github#46 + github#47, 2.94.0).
 *
 * All three issues surfaced inside the same qwen-3-6-plus session that
 * produced gitea PR #515 (github#41 fix). They broke or misrouted the
 * commit/PR loop in three independent places:
 *
 *   - github#45: detectIntent routes "commit message" / "generate commit"
 *     to handleCommitRequest, which dead-ended with "⚠️ No changes to
 *     commit." when no editor-dirty file was open — even when the user
 *     was asking ABOUT a commit, not requesting one. Fix mirrors the
 *     handleEditRequest fallback at handlers.js:219-224 — route the
 *     no-precondition branch through handleGeneralRequest(input).
 *
 *   - github#46: commit_files already accepts an optional `message` arg
 *     (commit-tools.js:19 + schema at L140-143). The dogfood failure was
 *     the model OMITTING the arg because the description led with
 *     "Optional: ... If omitted, an AI-generated ... is used" — reads as
 *     "skip it, the tool handles it." Fix tightens the tool description
 *     + parameter description + commitMessagePrompt fallback rules.
 *
 *   - github#47: create_pull_request passes the body verbatim to
 *     Git.createMergeRequest. The model wrote `Fixes #41` in a gitea PR
 *     body for github#41 — bare `#N` parses to the gitea repo and would
 *     close an unrelated gitea#41 (different content) on merge. Fix
 *     extends the `body:` parameter description + adds a "Cross-host
 *     close keywords" subsection to CONTRIBUTING.md.
 *
 * The handlers + tools import browser-bound code via core.js / git.js,
 * so this module follows the source-scan idiom (test-find-relevant-files-
 * bootstrap.mjs, 2.93.0) — read the production files and pin the shape
 * without executing the handlers. Behavior verification lives in the
 * manual browser smoke step.
 *
 * Runs under `node --test`. No browser globals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const readSrc = (relPath) =>
    readFile(resolve(__dirname, '..', relPath), 'utf8');

/* -------------------------------------------------------------------------- */
/* github#45 — handleCommitRequest fallback shape                             */
/* -------------------------------------------------------------------------- */

test('github#45: handleCommitRequest accepts input parameter', async () => {
    const src = await readSrc('js/chat/handlers.js');
    assert.match(src, /async function handleCommitRequest\(input\)/,
        'signature must accept `input` so the fallback can forward it');
});

test('github#45: no-dirty-file branch routes to handleGeneralRequest(input)', async () => {
    const src = await readSrc('js/chat/handlers.js');
    // Pin the fallback shape — must mirror handleEditRequest at L219-224.
    assert.match(src,
        /if \(!State\.currentFile \|\| !State\.editorDirty\) \{[\s\S]{0,400}?await handleGeneralRequest\(input\);\s*return;\s*\}/,
        'no-dirty-file branch must call handleGeneralRequest(input) and return');
});

test('github#45: dead-end "No changes to commit" message removed', async () => {
    const src = await readSrc('js/chat/handlers.js');
    // The old dead-end is the bug — guard against its accidental return.
    assert.doesNotMatch(src, /addMessage\('system',\s*'⚠️ No changes to commit\.'\)/,
        'the dead-end "No changes to commit" addMessage must be gone');
});

test('github#45: switch dispatch passes input to handleCommitRequest', async () => {
    const src = await readSrc('js/chat/handlers.js');
    assert.match(src,
        /case 'commit':\s*await handleCommitRequest\(input\);/,
        'the switch case must forward `input` so the fallback gets the user message');
});

/* -------------------------------------------------------------------------- */
/* github#46 — commit_files description imperative                            */
/* -------------------------------------------------------------------------- */

test('github#46: commit_files top-level description nudges explicit message', async () => {
    const src = await readSrc('js/tools/commit-tools.js');
    // Match the imperative phrasing. Don't pin exact prose — match the
    // semantic anchors: "Provide `message` explicitly" + the misclassification
    // warning that explains WHY.
    assert.match(src, /Provide `message` explicitly/,
        'tool description must contain the imperative "Provide `message` explicitly"');
    assert.match(src, /labeling a one-line behavior fix as a refactor/,
        'tool description must warn about the specific misclassification shape (the actual github#46 repro)');
});

test('github#46: message parameter description prefers explicit over auto-gen', async () => {
    const src = await readSrc('js/tools/commit-tools.js');
    assert.match(src, /Prefer providing this explicitly/,
        'message param description must lead with the "Prefer providing this explicitly" framing');
    // Guard against the pre-2.94.0 lead that made the model skip the arg.
    assert.doesNotMatch(src,
        /description:\s*'Optional: custom commit message\. If omitted, an AI-generated/,
        'old "Optional: ... If omitted, ..." lead must be gone — it made the model skip the arg');
});

test('github#46: commit_files schema still declares message as not required', async () => {
    const src = await readSrc('js/tools/commit-tools.js');
    // Back-compat: the param stays optional. The nudge is in the description,
    // not the schema. Existing callers that omit `message` still work.
    assert.match(src, /required:\s*\[\]/,
        'commit_files required array stays empty — message remains optional');
});

/* -------------------------------------------------------------------------- */
/* github#46 — commitMessagePrompt fallback type-rules                        */
/* -------------------------------------------------------------------------- */

test('github#46: commitMessagePrompt enumerates conventional-commit types', async () => {
    const src = await readSrc('js/prompts.js');
    // Pin the closed-set enumeration so the fallback path knows the allowed types.
    // The prompts.js source uses backslash-escaped backticks inside its outer
    // template literal (`\`feat\``), so the regex matches the literal source bytes.
    assert.match(src, /feat\\` \(new functionality\)/);
    assert.match(src, /fix\\` \(behavior bug fix\)/);
    assert.match(src, /refactor\\` \(no behavior change\)/);
});

test('github#46: commitMessagePrompt teaches diff-shape over file-position', async () => {
    const src = await readSrc('js/prompts.js');
    // The original repro: a one-line fix inside a function body got labeled
    // "refactor: clean up imports" because the auto-gen pattern-matched on
    // the file path, not the actual diff content. Pin the corrective rule —
    // match the unique sentence stem, not the backtick formatting.
    assert.match(src,
        /a one-line addition inside a function body that fixes a bug is/,
        'prompt must contain the diff-shape vs file-position rule sentence');
});

/* -------------------------------------------------------------------------- */
/* github#47 — create_pull_request body cross-host guidance                   */
/* -------------------------------------------------------------------------- */

test('github#47: create_pull_request body description teaches the cross-host shape', async () => {
    const src = await readSrc('js/tools/pr-tools.js');
    // The model sees this description at call-time, before writing the body.
    // Pin the load-bearing guidance: bare `#N` for same-tracker only;
    // prose `Refs github#N` for cross-host.
    assert.match(src, /Close-keyword convention/,
        'body description must explicitly call out the close-keyword convention');
    assert.match(src, /Refs github#N \(closes manually after merge\)/,
        'body description must surface the prose form `Refs github#N`');
});

test('github#47: body description warns about wrong-issue close on bare #N', async () => {
    const src = await readSrc('js/tools/pr-tools.js');
    // The specific failure mode — bare `#N` parses to the gitea repo and
    // closes an unrelated gitea issue. The warning must be there.
    assert.match(src,
        /bare `#N` parses to the gitea repo and would close an unrelated issue/,
        'description must warn about the bare-#N → wrong-gitea-issue failure mode');
});

test('github#47: body description references CONTRIBUTING.md', async () => {
    const src = await readSrc('js/tools/pr-tools.js');
    // Cross-reference so a model that wants the full convention knows where
    // to find it (the model can read repo files; the system prompt has limited budget).
    assert.match(src, /CONTRIBUTING\.md/,
        'body description must point at CONTRIBUTING.md for the full convention');
});

/* -------------------------------------------------------------------------- */
/* GitHub code-authority transition — CONTRIBUTING.md                         */
/* -------------------------------------------------------------------------- */

test('CONTRIBUTING.md names GitHub as the sole normal code authority', async () => {
    const src = await readSrc('CONTRIBUTING.md');
    assert.match(src, /GitHub.*is the sole\s+normal code authority/s,
        'CONTRIBUTING.md must make GitHub code authority explicit');
    assert.match(src, /New work uses GitHub issues and pull requests/,
        'new contribution references must use GitHub');
});

test('CONTRIBUTING.md preserves historical Gitea provenance without restoring its authority', async () => {
    const src = await readSrc('CONTRIBUTING.md');
    assert.match(src, /Historical `gitea#N` references/,
        'historical issue identifiers must remain stable provenance');
    assert.match(src, /Do not\s+bulk-import old Gitea issues/s,
        'the transition must not imply an uncurated metadata import');
});
