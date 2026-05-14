/**
 * Regression test for the `mountIssueList` `onStartWork` wiring in
 * [`js/app.js`](../js/app.js).
 *
 * **Bug class.** Pre-2.47.0 the wiring read
 *     onStartWork: (issueNumber) => window.startWorkOnIssueFromList(issueNumber),
 * but `window.startWorkOnIssueFromList` had been removed (see CHANGELOG:5098
 * for the original exposure). Clicking the inline Start button in the issue
 * list threw `Uncaught TypeError: window.startWorkOnIssueFromList is not a
 * function` and the row never entered a working session.
 *
 * The fix inlines the `State.issues` lookup and calls the imported
 * `startWorkOnIssue(issue)` directly — same shape as the lookup at
 * [`js/chat/handlers.js:343`](../js/chat/handlers.js#L343).
 *
 * This test pins the call site at the source level rather than mounting
 * the full module (app.js wires the entire app at import time). If a
 * future refactor needs to move the lookup elsewhere, update the regex
 * but keep the negative assertion that no stale `window.*` global is
 * referenced for the Start action.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, '../js/app.js'), 'utf8');

test('app.js no longer references removed window.startWorkOnIssueFromList global', () => {
    assert.equal(
        appSrc.includes('window.startWorkOnIssueFromList'),
        false,
        'window.startWorkOnIssueFromList was removed pre-2.47.0; do not restore the broken reference',
    );
});

test('app.js onStartWork callback resolves State.issues and calls startWorkOnIssue(issue)', () => {
    assert.match(
        appSrc,
        /onStartWork:\s*\(issueNumber\)\s*=>\s*\{[\s\S]*?State\.issues[\s\S]*?startWorkOnIssue\(issue\)/,
        'onStartWork must look up State.issues by number and call startWorkOnIssue(issue)',
    );
});
