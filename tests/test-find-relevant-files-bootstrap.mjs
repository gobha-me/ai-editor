/**
 * Regression — find_relevant_files auto-bootstrap on cold sessions (gitea#516).
 *
 * Pre-2.93.0 the cold-path return body just told the model to "Run index_project,
 * then retry." On a cold session that's a wasted tool call — the model has no
 * way to know the indexer wasn't already running, and the hint forces a fallback
 * to `search_in_files` / `read_lines` which then trips the same-tool streak
 * guard (see gitea#517 + test-tool-loop-anti-loop.mjs).
 *
 * 2.93.0 adds a fire-and-forget `RetrievalManager.indexProject()` call when the
 * indexer is idle, plus pivots the hint text between two states:
 *   - wasIdle = true  → "Indexing started in background — retry in a moment."
 *   - wasIdle = false → "Indexing already in progress — retry in a moment."
 *
 * The handler in `js/tools/context-tools.js` imports browser-bound code via
 * `js/intelligence/retrieval/manager.js` (which pulls `core.js` / `git.js`),
 * so this module follows the source-scan idiom (`test-pr-review-draft-vs-conflict.mjs`
 * spec 4, `test-editor-compartment-ordering.mjs`) — reading the production
 * file and pinning the bootstrap structure without executing the handler.
 *
 * Behavior verification lives in the manual browser smoke step.
 *
 * Runs under `node --test`. No browser globals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readContextTools() {
    return readFile(
        resolve(__dirname, '../js/tools/context-tools.js'),
        'utf8'
    );
}

/* -------------------------------------------------------------------------- */
/* Spec 1 — bootstrap structure                                                */
/* -------------------------------------------------------------------------- */

test('cold path reads RetrievalManager.isIndexing() to decide wasIdle', async () => {
    const src = await readContextTools();
    assert.match(src, /const wasIdle = !RetrievalManager\.isIndexing\(\);/,
        'wasIdle must be derived from RetrievalManager.isIndexing()');
});

test('cold path fires RetrievalManager.indexProject() only when wasIdle', async () => {
    const src = await readContextTools();
    // The `if (wasIdle)` block guards the side-effect call. We pin both the
    // guard and the .catch handler so an accidental refactor to await-without-
    // catch doesn't make the cold path block on indexing.
    assert.match(src,
        /if \(wasIdle\) \{\s*RetrievalManager\.indexProject\(\)\.catch\(/,
        'indexProject is gated by `if (wasIdle)` and is fire-and-forget (.catch, not await)');
});

test('cold path hint pivots between "started in background" and "already in progress"', async () => {
    const src = await readContextTools();
    assert.match(src, /Indexing started in background — retry find_relevant_files in a moment/,
        'wasIdle:true hint must say "Indexing started in background"');
    assert.match(src, /Indexing already in progress — retry find_relevant_files in a moment/,
        'wasIdle:false hint must say "Indexing already in progress"');
    // The off-ramp suggesting get_project_tree + read_file is preserved in both
    // branches so the model has a useful action even before indexing completes.
    const offRamp = /Meanwhile use get_project_tree \+ read_file/g;
    const matches = src.match(offRamp);
    assert.ok(matches && matches.length >= 2,
        'both wasIdle branches must keep the get_project_tree + read_file off-ramp');
});

/* -------------------------------------------------------------------------- */
/* Spec 2 — back-compat envelope shape                                         */
/* -------------------------------------------------------------------------- */

test('cold-path envelope preserves the structured fields from pre-2.93.0', async () => {
    const src = await readContextTools();
    // The envelope shape is the model's contract — adding fields is fine but
    // these existing fields must survive any refactor or downstream consumers
    // (loop refusal-hint logic) break silently.
    assert.match(src, /error: 'indexer_not_ready',/);
    assert.match(src, /indexed,\s*estimated_total: eligible,\s*coverage,/);
    assert.match(src, /Index not ready: \$\{indexed\} of \$\{eligible\} eligible files indexed/);
    assert.match(src, /files: \[\]/);
});

test('READINESS_THRESHOLD constant still pinned at 0.30', async () => {
    const src = await readContextTools();
    assert.match(src, /const READINESS_THRESHOLD = 0\.30;/,
        'threshold value is part of the contract — bump intentionally with a paired CHANGELOG note');
});

/* -------------------------------------------------------------------------- */
/* Spec 3 — bootstrap side-effect failure must not break the envelope         */
/* -------------------------------------------------------------------------- */

test('indexProject .catch handler logs to console.warn, does not rethrow', async () => {
    const src = await readContextTools();
    // The fire-and-forget pattern is load-bearing: a thrown reject in
    // indexProject must not surface as a tool error. The .catch handler
    // exists to swallow + log, not to re-rethrow.
    assert.match(src,
        /RetrievalManager\.indexProject\(\)\.catch\(err => \{\s*console\.warn\(/,
        '.catch handler exists and uses console.warn');
    assert.doesNotMatch(src,
        /RetrievalManager\.indexProject\(\)\.catch\(err => \{[^}]*throw/,
        '.catch handler must not rethrow — would surface as a tool error');
});
