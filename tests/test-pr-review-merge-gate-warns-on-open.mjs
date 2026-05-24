// @ts-check
/**
 * Tests for gitea#523 — PR Review dock no longer silently drops the
 * Merge button on an open PR.
 *
 * Background: at 2.95.0 the Merge + ⚠️ Resolve-conflicts buttons went
 * missing on an open gitea PR. The `supportsMerge` gate in
 * [`PrReviewDock.js`](../js/pr-review/PrReviewDock.js) requires
 * `capabilities?.merge === true`, but gitea + github both literally
 * declare `merge: true` in their capabilities block. The Submit button
 * still rendered, so `capabilities.reviewSubmission === true` was
 * reaching the gate — i.e. the capabilities object had been mutated
 * between registration and read, or stale assets shipped a pre-2.73.0
 * capabilities shape.
 *
 * Two structural defenses landed in 2.96.0:
 *   1. [`registry.js`](../js/git-providers/registry.js) reinstalls
 *      `capabilities` as a getter on the merged provider that returns
 *      `Object.freeze({ ...base, ...own })` per access. Closes the
 *      shared-object mutation hole — any consumer that tries
 *      `Git.capabilities.merge = false` either throws (strict) or
 *      no-ops, and the next read pulls a fresh frozen clone.
 *   2. [`PrReviewDock.js`](../js/pr-review/PrReviewDock.js) replaces
 *      the silent `supportsMerge` gate with a visible `.pr-dock__notice`
 *      + one-time `console.warn` when the anomalous case fires
 *      (`!prClosed && reviewSubmission === true && merge !== true`).
 *      The conjunctive condition narrows to *exactly* the bug case —
 *      providers that legitimately don't support merge (gitlab today)
 *      also don't claim reviewSubmission, so they won't trip it.
 *
 * Same source-scan idiom as
 * [`test-pr-review-draft-vs-conflict.mjs`](./test-pr-review-draft-vs-conflict.mjs):
 * `PrReviewDock.js` `await`s Preact at module top so isn't directly
 * Node-importable. The structural pins are small enough that source-text
 * matches are the right anti-regression.
 *
 * @since 2.96.0 (gitea#523)
 */

import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { BASE_GIT_PROVIDER } from '../js/git-providers/base.js';
import giteaProvider from '../js/git-providers/gitea.js';
import githubProvider from '../js/git-providers/github.js';

async function readSource(relativePath) {
    return readFile(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        'utf8'
    );
}

// ============================================
// Capability literals — provider getters return the expected shape
// ============================================
//
// These pins fail loudly if a future edit drops `merge: true` from a
// provider that supports merge while keeping `reviewSubmission: true`.
// That is the exact drift that lands the bug from gitea#523 if the
// runtime defenses get lifted.

test('Gitea capabilities getter returns reviewSubmission:true AND merge:true', () => {
    const caps = giteaProvider.capabilities;
    assert.equal(caps.reviewSubmission, true,
        'gitea must claim reviewSubmission so PR Review surface renders Submit');
    assert.equal(caps.merge, true,
        'gitea must claim merge so PrMergeControls renders — paired with reviewSubmission to avoid the gitea#523 anomaly');
    assert.equal(caps.mergeConflictResolution, true,
        'gitea must claim mergeConflictResolution so the ⚠️ Resolve-conflicts CTA renders on conflicted non-draft PRs');
});

test('GitHub capabilities getter returns reviewSubmission:true AND merge:true', () => {
    const caps = githubProvider.capabilities;
    assert.equal(caps.reviewSubmission, true);
    assert.equal(caps.merge, true);
    assert.equal(caps.mergeConflictResolution, true);
});

// ============================================
// registry.js — capabilities is a getter, not a one-shot data prop
// ============================================

test('registry.js install path reinstalls capabilities as a getter via defineProperty', async () => {
    const src = await readSource('../js/git-providers/registry.js');
    // Pin the defineProperty call shape so a future "simplify" that
    // collapses back to `merged.capabilities = ...` (one-shot data
    // property) fails CI.
    assert.match(src, /Object\.defineProperty\(merged,\s*['"]capabilities['"]/,
        'capabilities must be installed as a getter on merged (Object.defineProperty), not a data property');
    assert.match(src, /Object\.freeze\(\s*\{\s*\.\.\.\s*base\s*,\s*\.\.\.\s*own\s*\}\s*\)/,
        'getter must return Object.freeze({...base, ...own}) — fresh frozen clone per access kills the shared-object mutation hole');
});

test('registry.js getter survives a mutation attempt (frozen + fresh per read)', async () => {
    // Round-trip a real provider through the registry to assert that
    // `Git.capabilities.merge = false`-style mutations don't stick.
    // We can't import registry.js directly (it touches State); instead
    // we replicate the install logic minimally to assert the contract.
    const { GitProviderRegistry } = await import('../js/git-providers/registry.js');
    GitProviderRegistry.register(giteaProvider);
    const merged = GitProviderRegistry.get('gitea');
    assert.ok(merged, 'gitea provider re-registered');
    const before = merged.capabilities;
    assert.equal(before.merge, true);
    assert.equal(Object.isFrozen(before), true,
        'returned capabilities object must be frozen so mutation attempts fail loud (strict) or no-op (sloppy)');
    // Attempt mutation in sloppy mode (test file isn't a module by
    // default for the property write — wrap in try/catch to cover both).
    try { before.merge = false; } catch { /* strict-mode throw is fine */ }
    const after = merged.capabilities;
    assert.equal(after.merge, true,
        'next read of capabilities returns a fresh clone with merge:true — mutation didn\'t persist');
    assert.notStrictEqual(before, after,
        'each capabilities read returns a NEW frozen object (no shared reference for mutators to corrupt)');
});

// ============================================
// PrReviewDock.js — anomaly gate + visible fallback notice
// ============================================

test('PrReviewDock declares mergeGateAnomaly with the conjunctive condition', async () => {
    const src = await readSource('../js/pr-review/PrReviewDock.js');
    // The declaration is multi-line; match the key operands.
    const m = src.match(/const\s+mergeGateAnomaly\s*=\s*([\s\S]+?);/);
    assert.ok(m, 'mergeGateAnomaly declaration found');
    const body = m[1];
    assert.match(body, /!prClosed/,
        'gate must require !prClosed — anomaly only matters on open, unmerged PRs');
    assert.match(body, /capabilities\?\.reviewSubmission\s*===\s*true/,
        'gate must require reviewSubmission === true — narrows out providers that legitimately drop both (gitlab today)');
    assert.match(body, /capabilities\?\.merge\s*!==\s*true/,
        'gate must require merge !== true — that\'s the anomaly we\'re catching');
});

test('PrReviewDock renders a visible pr-dock__notice when mergeGateAnomaly fires', async () => {
    const src = await readSource('../js/pr-review/PrReviewDock.js');
    // The else-branch of the supportsMerge ternary renders the notice;
    // pin the structural shape (notice class + role=alert + reference
    // to gitea#523 so future readers find the issue).
    assert.match(src, /mergeGateAnomaly\s*&&\s*html`[\s\S]*?pr-dock__notice[\s\S]*?role="alert"[\s\S]*?gitea#523[\s\S]*?`/,
        'gitea#523 fallback notice must render with role="alert" so screen readers + future-us see why the merge button is missing');
});

test('PrReviewDock emits a one-shot console.warn when mergeGateAnomaly fires', async () => {
    const src = await readSource('../js/pr-review/PrReviewDock.js');
    // Pin the warn payload shape — it has to include the diagnostic
    // fields that lets us pick between hypothesis 1 (stale cache) and
    // hypothesis 2 (shared-object mutation) on the next occurrence.
    assert.match(src, /console\.warn\([\s\S]*?gitea#523[\s\S]*?\)/,
        'console.warn must reference gitea#523 so the message is greppable');
    assert.match(src, /capabilityKeys:\s*Object\.keys/,
        'warn payload must include capabilityKeys so we can see what the runtime capabilities object actually carries');
    assert.match(src, /version:\s*VERSION/,
        'warn payload must include the running VERSION so we can correlate with the cache-bust hypothesis');
});

test('PrReviewDock supportsMerge declaration shape unchanged', async () => {
    const src = await readSource('../js/pr-review/PrReviewDock.js');
    // Pin the gate shape so a future "relax" that drops the capability
    // check (e.g. fallback to "if Git.mergePullRequest exists, render")
    // fails CI — that change would mask real capability mismatches,
    // which is exactly what gitea#523's defense exists to prevent.
    assert.match(src, /const\s+supportsMerge\s*=\s*capabilities\?\.merge\s*===\s*true\s*&&\s*pr\?\.state\s*===\s*'open'\s*&&\s*!pr\?\.merged/,
        'supportsMerge gate shape pinned — relaxing this would hide capability mismatches the gitea#523 notice exists to surface');
});

// ============================================
// css/pr-review.css — sticky merge controls (the actual user-visible fix)
// ============================================

test('css: .pr-dock__merge (and the gitea#523 fallback) are position:sticky at bottom:0', async () => {
    const css = await readSource('../css/pr-review.css');
    // The reported gitea#523 symptom — "merge button missing" — was a CSS
    // overflow issue: the dock carries `max-height: 38vh; overflow-y: auto`
    // and on small viewports the merge controls scrolled below the fold
    // with no visible scroll affordance. Pin the sticky declaration so
    // a future CSS refactor that drops it re-lands the bug.
    //
    // Match the shared rule that covers both `.pr-dock__merge` and the
    // anomaly-case `.pr-dock__merge-fallback`. Whitespace-flexible across
    // the declarations.
    const selectorIdx = css.indexOf('.pr-dock__merge,');
    assert.ok(selectorIdx > 0,
        '.pr-dock__merge and .pr-dock__merge-fallback should share the sticky rule via a combined selector');
    const fallbackIdx = css.indexOf('.pr-dock__merge-fallback', selectorIdx);
    assert.ok(fallbackIdx > selectorIdx && fallbackIdx - selectorIdx < 80,
        '.pr-dock__merge-fallback must be in the same selector group as .pr-dock__merge');
    const ruleBody = css.slice(selectorIdx, selectorIdx + 1200);
    assert.match(ruleBody, /position:\s*sticky/,
        'position: sticky must remain on the merge controls so the ✅ Merge button stays in the dock viewport');
    assert.match(ruleBody, /bottom:\s*0/,
        'bottom: 0 pins the sticky element to the dock\'s scroll-container bottom edge');
    assert.match(ruleBody, /background:\s*var\(--bg-secondary/,
        'background must match the dock so scrolled content above doesn\'t bleed through the dashed border');
});
