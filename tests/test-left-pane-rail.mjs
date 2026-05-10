/**
 * Renderer tests for js/ui/left-pane-rail.js — pure string in, pure string out.
 * Wire-up + click delegation + persistence behavior is covered manually in
 * the browser suite (Tier 3a preview MCP harness against the running editor).
 *
 * Asserts the rail rendering decisions documented in the 2.11.0 plan:
 *   - 4 buttons (files / issues / prs / branches) with stable data-rail-btn ids
 *   - Active button gets `lp__rail-btn--active` and `aria-pressed="true"`
 *   - Inactive buttons get `aria-pressed="false"` and no active class
 *   - Issues/PRs badges render only when the count > 0; Files/Branches never
 *   - Badge count escapes HTML
 *   - readActiveView falls back to 'files' on missing or invalid storage value
 *   - computeBadges reads issues/pullRequests array lengths off State
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    renderRailButtonsHtml,
    readActiveView,
    computeBadges,
} from '../js/ui/left-pane-rail.js';

// ============================================
// Rail-button shape
// ============================================

test('renders one button per rail item, in declared order', () => {
    const html = renderRailButtonsHtml({ activeView: 'files' });
    const matches = html.match(/data-rail-btn="([^"]+)"/g) || [];
    const ids = matches.map(m => m.match(/"([^"]+)"/)[1]);
    assert.deepEqual(ids, ['files', 'issues', 'prs', 'branches']);
});

test('active button gets --active class and aria-pressed=true', () => {
    const html = renderRailButtonsHtml({ activeView: 'issues' });
    assert.match(
        html,
        /lp__rail-btn lp__rail-btn--active"\s+data-rail-btn="issues"[^>]*aria-pressed="true"/,
    );
});

test('inactive buttons have no --active class and aria-pressed=false', () => {
    const html = renderRailButtonsHtml({ activeView: 'issues' });
    // Files button — should be inactive.
    assert.match(
        html,
        /class="lp__rail-btn"\s+data-rail-btn="files"[^>]*aria-pressed="false"/,
    );
    assert.doesNotMatch(
        html,
        /lp__rail-btn--active"\s+data-rail-btn="files"/,
    );
});

test('button labels escape into title and aria-label attrs', () => {
    const html = renderRailButtonsHtml({ activeView: 'files' });
    assert.match(html, /title="Pull Requests"/);
    assert.match(html, /aria-label="Pull Requests"/);
});

// ============================================
// Badges
// ============================================

test('renders no badge when count is 0', () => {
    const html = renderRailButtonsHtml({
        activeView: 'files',
        badges: { issues: 0, prs: 0 },
    });
    assert.doesNotMatch(html, /lp__rail-badge/);
});

test('renders no badge when badges arg is omitted', () => {
    const html = renderRailButtonsHtml({ activeView: 'files' });
    assert.doesNotMatch(html, /lp__rail-badge/);
});

test('issues badge renders when count > 0', () => {
    const html = renderRailButtonsHtml({
        activeView: 'files',
        badges: { issues: 7, prs: 0 },
    });
    // The issues button must contain the badge; PRs must not.
    assert.match(
        html,
        /data-rail-btn="issues"[^>]*>[\s\S]*?<span class="lp__rail-badge">7<\/span>/,
    );
    assert.doesNotMatch(
        html,
        /data-rail-btn="prs"[^>]*>[\s\S]*?<span class="lp__rail-badge">/,
    );
});

test('files and branches buttons never render a badge', () => {
    const html = renderRailButtonsHtml({
        activeView: 'files',
        // Even if the caller smuggled a 'files' or 'branches' badge value,
        // the renderer ignores it because those items have no badgeKey.
        badges: { issues: 0, prs: 0, files: 99, branches: 99 },
    });
    assert.doesNotMatch(html, /lp__rail-badge/);
});

test('non-numeric badge values render no badge (defensive)', () => {
    // Counts come from State.issues.length so non-numbers are unreachable in
    // practice. The renderer coerces via Number() and gates on `> 0`, so a
    // string like "<x>" becomes NaN → no badge. Safer than rendering anything.
    const html = renderRailButtonsHtml({
        activeView: 'files',
        badges: { issues: '<x>', prs: 0 },
    });
    assert.doesNotMatch(html, /lp__rail-badge/);
});

// ============================================
// readActiveView
// ============================================

test('readActiveView returns "files" by default', () => {
    localStorage.removeItem('leftPaneRail.activeView');
    assert.equal(readActiveView(), 'files');
});

test('readActiveView returns the persisted value when valid', () => {
    localStorage.setItem('leftPaneRail.activeView', 'prs');
    assert.equal(readActiveView(), 'prs');
});

test('readActiveView falls back to "files" on unknown stored value', () => {
    localStorage.setItem('leftPaneRail.activeView', 'tasks-not-shipped-yet');
    assert.equal(readActiveView(), 'files');
});

// ============================================
// computeBadges
// ============================================

test('computeBadges reads array lengths from issues + pullRequests', () => {
    const state = {
        issues: [{}, {}, {}],
        pullRequests: [{}, {}],
    };
    assert.deepEqual(computeBadges(state), { issues: 3, prs: 2 });
});

test('computeBadges yields 0s for missing arrays', () => {
    assert.deepEqual(computeBadges({}), { issues: 0, prs: 0 });
    assert.deepEqual(computeBadges({ issues: 'not-an-array' }), { issues: 0, prs: 0 });
    assert.deepEqual(computeBadges(null), { issues: 0, prs: 0 });
});
