/**
 * Regression — dogfood bugs cohort (github#42 + github#43, 2.95.0).
 *
 *   - github#42: Cost dashboard's Save Budget action accepted any number
 *     including 0 and negatives. The success toast fired unconditionally
 *     while cost-store.js setBudget silently coerced <=0 to null. Fix
 *     adds a front-end guard in cost-tab.js _onSaveBudget that toasts
 *     "Budget must be greater than 0" and returns without storing.
 *
 *   - github#43: The Plugins tab's "Install Plugin from URL" input had a
 *     visual title in a sibling div but no programmatic association —
 *     screen readers heard it as unlabeled. Fix adds aria-label="Plugin
 *     URL to install" to the #pluginInstallUrl input.
 *
 * cost-tab.js and plugins-tab.js are browser-bound (DOM handlers), so this
 * module follows the source-scan idiom (see test-commit-flow-cohort.mjs,
 * 2.94.0) — read the production files and pin the shape without executing
 * the handlers. Behavior verification lives in the manual browser smoke.
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
/* github#42 — cost budget validation                                         */
/* -------------------------------------------------------------------------- */

test('github#42: _onSaveBudget rejects non-null values that are not > 0', async () => {
    const src = await readSrc('js/settings/cost-tab.js');
    // Pin the guard shape: both daily and monthly checked against `> 0` when
    // not null, with an early return that skips setBudget.
    assert.match(src,
        /function _onSaveBudget\(\)[\s\S]*?if \(\(daily !== null && !\(daily > 0\)\) \|\| \(monthly !== null && !\(monthly > 0\)\)\) \{[\s\S]{0,300}?return;\s*\}[\s\S]*?setBudget\(\{ daily, monthly \}\);/,
        '_onSaveBudget must guard <=0 values before calling setBudget');
});

test('github#42: error toast text is "Budget must be greater than 0"', async () => {
    const src = await readSrc('js/settings/cost-tab.js');
    assert.match(src,
        /window\.showToast\('Budget must be greater than 0', 'error'\)/,
        'the validation failure must surface as an error toast with the expected wording');
});

test('github#42: cost-store setBudget keeps the > 0 defensive filter', async () => {
    const src = await readSrc('js/intelligence/cost/cost-store.js');
    // Last line of defense — pin so a refactor doesn't drop it.
    assert.match(src,
        /daily:\s*typeof budget\.daily === 'number' && budget\.daily > 0 \? budget\.daily : null/,
        'cost-store setBudget must retain the > 0 defensive filter for daily');
    assert.match(src,
        /monthly:\s*typeof budget\.monthly === 'number' && budget\.monthly > 0 \? budget\.monthly : null/,
        'cost-store setBudget must retain the > 0 defensive filter for monthly');
});

/* -------------------------------------------------------------------------- */
/* github#43 — plugin URL input a11y                                          */
/* -------------------------------------------------------------------------- */

test('github#43: #pluginInstallUrl input has aria-label', async () => {
    const src = await readSrc('js/settings/plugins-tab.js');
    assert.match(src,
        /<input type="text" id="pluginInstallUrl"[\s\S]{0,200}?aria-label="Plugin URL to install"/,
        'the install URL input must carry aria-label="Plugin URL to install"');
});

test('github#43: visual "Install Plugin from URL" title text is preserved', async () => {
    const src = await readSrc('js/settings/plugins-tab.js');
    // Regression guard — adding aria-label shouldn't drop the visible title.
    assert.match(src,
        /<div class="plugin-install-title">Install Plugin from URL<\/div>/,
        'the visible plugin-install-title div must still render');
});
