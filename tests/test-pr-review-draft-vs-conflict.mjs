// @ts-check
/**
 * Tests for gitea#466 — distinguish draft PRs from merge conflicts.
 *
 * Background: Gitea (and GitHub + GitLab) return `mergeable: false` /
 * `merge_status: 'cannot_be_merged'` for both (a) draft PRs
 * (intentionally merge-blocked by `draft: true`) and (b) genuine merge
 * conflicts. Pre-2.73.0, the PR review surface conflated the two and
 * rendered every draft PR as `⚠️ Resolve conflicts`. The fix passes
 * `draft: boolean` through every provider and gates the resolve-conflicts
 * CTA on `!isDraft`. The GitLab translator normalizes both modern
 * (`draft`) and pre-deprecation (`work_in_progress`) MR fields at the
 * provider boundary so consumers stay provider-agnostic.
 *
 * Two layers tested:
 *   1. Provider passthrough — gitea + github + gitlab `getPullRequest()`
 *      return `draft` on the PR object. Uses the per-test
 *      merged-provider-clone stub from
 *      [`tests/test-pr-review-provider-shape.mjs`](./test-pr-review-provider-shape.mjs).
 *   2. PrMergeControls gate — source-scan idiom (mirrors
 *      [`tests/test-plugin-editor-auto-switch-retired.mjs`](./test-plugin-editor-auto-switch-retired.mjs)
 *      + [`tests/test-editor-compartment-ordering.mjs`](./test-editor-compartment-ordering.mjs))
 *      since `PrMergeControls.js` `await`s Preact at module top and is
 *      not directly Node-importable. The gate logic is small enough
 *      that a pin on the source string is the right anti-regression.
 *
 * @since 2.73.0 (gitea#466 — Gitea + GitHub); 2.74.0 (GitLab cohort closure)
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';
import giteaProvider from '../js/git-providers/gitea.js';
import githubProvider from '../js/git-providers/github.js';
import gitlabProvider from '../js/git-providers/gitlab.js';

function mergedClone(provider) {
    return { ...BASE_GIT_PROVIDER, ...provider };
}

const FAKE_CONN = { id: 'c1', url: 'https://example.com', token: 'x' };

/**
 * Minimal Gitea-shape PR payload (matches the fields that
 * `getPullRequest` destructures). `draft` is overridable per-test.
 */
function giteaPrPayload({ draft, mergeable = true } = {}) {
    return {
        number: 465,
        title: 'WIP: refactor compositor',
        body: 'body',
        state: 'open',
        head: { ref: 'feature/x', sha: 'abc123' },
        base: { ref: 'main' },
        mergeable,
        draft,
        merged: false,
        user: { login: 'someone' },
        additions: 1,
        deletions: 0,
        changed_files: 1,
        created_at: '2026-05-19T00:00:00Z',
        updated_at: '2026-05-19T00:00:00Z',
        html_url: 'https://example.com/pulls/465',
    };
}

/**
 * Minimal GitLab-shape MR payload. GitLab uses different field names
 * (`iid` / `source_branch` / `target_branch` / `merge_status` /
 * `author.username` / `web_url`) and carries `draft` on modern versions
 * + `work_in_progress` on older versions — both overridable per-test.
 */
function gitlabMrPayload({ draft, work_in_progress, merge_status = 'can_be_merged' } = {}) {
    return {
        iid: 465,
        title: 'WIP: refactor compositor',
        description: 'body',
        state: 'opened',
        source_branch: 'feature/x',
        target_branch: 'main',
        sha: 'abc123',
        diff_refs: { head_sha: 'abc123' },
        merge_status,
        draft,
        work_in_progress,
        author: { username: 'someone' },
        changes_count: '1',
        created_at: '2026-05-20T00:00:00Z',
        updated_at: '2026-05-20T00:00:00Z',
        web_url: 'https://example.com/mr/465',
    };
}

// ============================================
// Gitea — draft passthrough
// ============================================

test('Gitea: getPullRequest returns draft: true when API payload has draft: true', async () => {
    const merged = mergedClone(giteaProvider);
    merged.request = async () => giteaPrPayload({ draft: true, mergeable: false });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, true);
    assert.equal(result.mergeable, false,
        'mergeable stays false — Gitea returns this for both draft + conflict; the disambiguator is the draft field');
});

test('Gitea: getPullRequest returns draft: false when API payload has draft: false', async () => {
    const merged = mergedClone(giteaProvider);
    merged.request = async () => giteaPrPayload({ draft: false, mergeable: true });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, false);
});

test('Gitea: getPullRequest returns draft: false when API omits draft field (back-compat)', async () => {
    const merged = mergedClone(giteaProvider);
    merged.request = async () => giteaPrPayload({ draft: undefined });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, false,
        'undefined → false coercion via `pr.draft === true` lets consumers treat the field as always-boolean');
});

// ============================================
// GitHub — draft passthrough (mirror of Gitea)
// ============================================

test('GitHub: getPullRequest returns draft: true when API payload has draft: true', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async () => giteaPrPayload({ draft: true, mergeable: false });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, true);
});

test('GitHub: getPullRequest returns draft: false when API payload has draft: false', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async () => giteaPrPayload({ draft: false, mergeable: true });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, false);
});

test('GitHub: getPullRequest returns draft: false when API omits draft field (back-compat)', async () => {
    const merged = mergedClone(githubProvider);
    merged.request = async () => giteaPrPayload({ draft: undefined });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, false);
});

// ============================================
// GitLab — draft passthrough with version normalization
// ============================================

test('GitLab: getPullRequest returns draft: true when MR payload has draft: true', async () => {
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => gitlabMrPayload({
        draft: true,
        work_in_progress: false,
        merge_status: 'cannot_be_merged',
    });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, true);
    assert.equal(result.mergeable, false,
        'GitLab also collapses draft + conflict into cannot_be_merged; draft is the disambiguator');
});

test('GitLab: getPullRequest returns draft: true when MR payload has work_in_progress: true (older GitLab)', async () => {
    // Older GitLab versions expose `work_in_progress: boolean` rather
    // than `draft: boolean`. The translator normalizes both fields so
    // consumers stay version-agnostic.
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => gitlabMrPayload({
        draft: undefined,
        work_in_progress: true,
    });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, true);
});

test('GitLab: getPullRequest returns draft: false when both flags are explicitly false', async () => {
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => gitlabMrPayload({
        draft: false,
        work_in_progress: false,
    });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, false);
});

test('GitLab: getPullRequest returns draft: false when both flags absent (back-compat)', async () => {
    const merged = mergedClone(gitlabProvider);
    merged.request = async () => gitlabMrPayload({
        draft: undefined,
        work_in_progress: undefined,
    });
    const result = await merged.getPullRequest(FAKE_CONN, 'o', 'r', 465);
    assert.equal(result.draft, false,
        'undefined → false coercion via `=== true` on both fields lets consumers treat the field as always-boolean');
});

// ============================================
// Base — typedef pin (gives consumers a documented contract)
// ============================================

test('Base: PullRequestData typedef declares optional draft boolean', async () => {
    const base = await readFile(
        fileURLToPath(new URL('../js/git-providers/base.js', import.meta.url)),
        'utf8'
    );
    const idx = base.indexOf('@typedef {Object} PullRequestData');
    assert.ok(idx > 0, 'PullRequestData typedef found in base.js');
    const window = base.slice(idx, idx + 2000);
    assert.match(window, /@property\s+\{boolean\}\s+\[draft\]/,
        '@property {boolean} [draft] row must be present so cross-provider consumers can read draft state from a documented contract');
});

// ============================================
// PrMergeControls — source-scan pin on the gate logic
// ============================================
//
// PrMergeControls.js awaits Preact at module top, so importing it in
// Node would either pull the vendor bundle or fail outright. Mirror
// the source-scan idiom from `test-plugin-editor-auto-switch-retired.mjs`
// + `test-editor-compartment-ordering.mjs`: pin the gate text + the
// notice element so a future edit that drops either fails CI.

async function readMergeControls() {
    return readFile(
        fileURLToPath(new URL('../js/pr-review/PrMergeControls.js', import.meta.url)),
        'utf8'
    );
}

test('PrMergeControls: isDraft is computed from pr.draft === true', async () => {
    const src = await readMergeControls();
    assert.match(src, /const\s+isDraft\s*=\s*pr\?\.draft\s*===\s*true\s*;/,
        '`const isDraft = pr?.draft === true;` must remain the disambiguator — undefined coerces to false, matching the provider back-compat path');
});

test('PrMergeControls: showResolve gate includes !isDraft', async () => {
    const src = await readMergeControls();
    // Match the `showResolve = ...` declaration with the !isDraft guard
    // included. Whitespace-flexible. Order-flexible across the four
    // && operands except for the `!isDraft` operand which must be
    // present.
    const m = src.match(/const\s+showResolve\s*=\s*([^;]+);/);
    assert.ok(m, 'showResolve declaration found');
    const body = m[1];
    assert.match(body, /pr\.mergeable\s*===\s*false/);
    assert.match(body, /!isDraft/,
        '`!isDraft` must gate showResolve — without it draft PRs render the `⚠️ Resolve conflicts` button (gitea#466)');
    assert.match(body, /capabilities\?\.mergeConflictResolution\s*===\s*true/);
});

test('PrMergeControls: renders pr-dock__notice element when isDraft', async () => {
    const src = await readMergeControls();
    // Find the conditional render for the draft notice. Mirrors the
    // existing `${showResolve && html`...`}` shape but on `isDraft`.
    assert.match(src, /\$\{isDraft\s*&&\s*html`[\s\S]*?pr-dock__notice[\s\S]*?Draft[\s\S]*?`\}/,
        'Draft notice element must render when isDraft so the user sees a non-conflict indicator');
});

test('PrMergeControls: merge button is disabled when isDraft', async () => {
    const src = await readMergeControls();
    // The merge action button carries `disabled=${merging || isDraft}` after
    // 2.73.0; without the isDraft guard the user can click a button that
    // the remote will reject anyway.
    assert.match(src, /disabled=\$\{merging\s*\|\|\s*isDraft\}/,
        'merge controls disabled while isDraft — clicking through would error from the remote');
});
