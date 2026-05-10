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
    mountLeftPaneRail,
} from '../js/ui/left-pane-rail.js';
import { State, EventBus } from '../js/core.js';

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

// ============================================
// Mount: badge re-paints on post-fetch render channels (race regression)
// ============================================
//
// 2.13.1 — `PrMergeControls` emits `prs:refresh`. Two listeners:
//   (a) the rail (sync) — reads State synchronously
//   (b) `refreshPullRequests` (async) — fetches, mutates State, then renders
// (a) ran first against stale State, so the badge stayed at the pre-merge
// count until reload. The fix: rail also subscribes to `prs:render` /
// `issues:render` (the post-fetch broadcast). These tests pin that wiring
// so the regression cannot return silently.

/**
 * Build a fake DOM (`document.getElementById` / `querySelectorAll`) just
 * for `mountLeftPaneRail`. Returns the fake rail-host element so tests
 * can read its `innerHTML` after each emit. Restores the original document
 * via the returned `restore()`.
 */
function _withFakeRailDom() {
    const railHost = {
        innerHTML: '',
        contains: () => false,
        addEventListener: () => {},
    };
    // Patch only the two members `mountLeftPaneRail` reaches for; keep the
    // shim's `createElement` (escapeHtml uses it via textContent escape).
    const origGetById = globalThis.document.getElementById;
    const origQSA = globalThis.document.querySelectorAll;
    globalThis.document.getElementById = (id) =>
        (id === 'leftPaneRailButtons' ? railHost : null);
    globalThis.document.querySelectorAll = () => [];
    return {
        railHost,
        restore: () => {
            globalThis.document.getElementById = origGetById;
            globalThis.document.querySelectorAll = origQSA;
        },
    };
}

/** Drop any listeners the previous mount registered. */
function _clearRailListeners() {
    for (const ch of ['issues:refresh', 'prs:refresh', 'issues:render', 'prs:render']) {
        EventBus._listeners[ch] = [];
    }
}

test('rail badge updates on prs:render (post-fetch fresh State)', () => {
    _clearRailListeners();
    State.issues = [];
    State.pullRequests = [{ number: 1 }, { number: 2 }];
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        // Initial render reflects State at mount time: 2 PRs.
        assert.match(railHost.innerHTML, /data-rail-btn="prs"[^>]*>[\s\S]*?<span class="lp__rail-badge">2<\/span>/);

        // Simulate the post-merge async path: a network refresh has just
        // landed, State is fresh (one PR removed), and the project-manager
        // fires `prs:render`. The rail must re-paint with the new count.
        State.pullRequests = [{ number: 1 }];
        EventBus.emit('prs:render');
        assert.match(railHost.innerHTML, /data-rail-btn="prs"[^>]*>[\s\S]*?<span class="lp__rail-badge">1<\/span>/);
    } finally {
        restore();
    }
});

test('rail badge updates on issues:render (same race shape)', () => {
    _clearRailListeners();
    State.issues = [{ number: 1 }, { number: 2 }, { number: 3 }];
    State.pullRequests = [];
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        assert.match(railHost.innerHTML, /data-rail-btn="issues"[^>]*>[\s\S]*?<span class="lp__rail-badge">3<\/span>/);

        State.issues = [{ number: 1 }];
        EventBus.emit('issues:render');
        assert.match(railHost.innerHTML, /data-rail-btn="issues"[^>]*>[\s\S]*?<span class="lp__rail-badge">1<\/span>/);
    } finally {
        restore();
    }
});

test('prs:refresh still re-paints (covers paths that mutate State synchronously)', () => {
    _clearRailListeners();
    State.issues = [];
    State.pullRequests = [{ number: 1 }, { number: 2 }, { number: 3 }];
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        assert.match(railHost.innerHTML, /<span class="lp__rail-badge">3<\/span>/);

        // A caller that already mutated State before emitting `prs:refresh`
        // (e.g. a future hot-update path) must still see the badge update.
        State.pullRequests = [{ number: 1 }];
        EventBus.emit('prs:refresh');
        assert.match(railHost.innerHTML, /<span class="lp__rail-badge">1<\/span>/);
    } finally {
        restore();
    }
});
