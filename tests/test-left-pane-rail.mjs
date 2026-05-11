/**
 * Renderer tests for js/ui/left-pane-rail.js — pure string in, pure string out.
 * Wire-up + click delegation + persistence behavior is covered manually in
 * the browser suite (Tier 3a preview MCP harness against the running editor).
 *
 * Asserts the rail rendering decisions documented in the 2.11.0 plan, now
 * driven by the 2.23.0 `rail-views` SlotManager contract (Decision 1 of
 * docs/DESIGN-git-providers-and-ui-extensions.md):
 *   - 4 built-in buttons (files / issues / prs / branches) registered as
 *     `rail-views` contributions at mount time, in priority order
 *     (10/20/30/40).
 *   - Active button gets `lp__rail-btn--active` and `aria-pressed="true"`.
 *   - Inactive buttons get `aria-pressed="false"` and no active class.
 *   - Issues/PRs badges render only when `view.badge()` > 0; Files/Branches
 *     never (no badge function declared).
 *   - Badge count escapes HTML.
 *   - readStoredActiveView returns the persisted value or null.
 *   - resolveActiveView falls back gracefully when the stored id is no
 *     longer registered.
 *   - projectViewsForButtons computes badgeCount via `view.badge()` with
 *     defensive fallback on throws / non-numeric returns.
 *   - The post-fetch *:render race fix from 2.13.1 still holds.
 */
import './_node-shim.mjs';

// HTMLElement stub before slot-manager loads — its `el instanceof HTMLElement`
// check captures the global at module-eval time.
class StubElement {}
globalThis.HTMLElement = StubElement;

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    renderRailButtonsHtml,
    readStoredActiveView,
    resolveActiveView,
    projectViewsForButtons,
    setActiveView,
    mountLeftPaneRail,
} from '../js/ui/left-pane-rail.js';
import { State, EventBus } from '../js/core.js';
import { SlotManager } from '../js/slot-manager.js';

// ============================================
// Helpers — registry cleanup between tests
// ============================================

function clearRailContributions() {
    const ids = (SlotManager._contributions.get('rail-views') || []).map(c => c.pluginId);
    for (const id of new Set(ids)) {
        SlotManager.removeByPlugin(id);
    }
}

function clearRailListeners() {
    for (const ch of ['issues:refresh', 'prs:refresh', 'issues:render', 'prs:render', 'slot:rail-views:changed']) {
        EventBus._listeners[ch] = [];
    }
}

// ============================================
// renderRailButtonsHtml — pure view → HTML
// ============================================

const FIXTURE_VIEWS = [
    { id: 'files', label: 'Files', icon: '<svg/>', badgeCount: 0 },
    { id: 'issues', label: 'Issues', icon: '<svg/>', badgeCount: 0 },
    { id: 'prs', label: 'Pull Requests', icon: '<svg/>', badgeCount: 0 },
    { id: 'branches', label: 'Branches', icon: '<svg/>', badgeCount: 0 },
];

test('renders one button per view, in passed order', () => {
    const html = renderRailButtonsHtml({ activeView: 'files', views: FIXTURE_VIEWS });
    const matches = html.match(/data-rail-btn="([^"]+)"/g) || [];
    const ids = matches.map(m => m.match(/"([^"]+)"/)[1]);
    assert.deepEqual(ids, ['files', 'issues', 'prs', 'branches']);
});

test('active button gets --active class and aria-pressed=true', () => {
    const html = renderRailButtonsHtml({ activeView: 'issues', views: FIXTURE_VIEWS });
    assert.match(
        html,
        /lp__rail-btn lp__rail-btn--active"\s+data-rail-btn="issues"[^>]*aria-pressed="true"/,
    );
});

test('inactive buttons have no --active class and aria-pressed=false', () => {
    const html = renderRailButtonsHtml({ activeView: 'issues', views: FIXTURE_VIEWS });
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
    const html = renderRailButtonsHtml({ activeView: 'files', views: FIXTURE_VIEWS });
    assert.match(html, /title="Pull Requests"/);
    assert.match(html, /aria-label="Pull Requests"/);
});

test('renders nothing when views is empty / null', () => {
    assert.equal(renderRailButtonsHtml({ activeView: 'files', views: [] }), '');
    assert.equal(renderRailButtonsHtml({ activeView: 'files', views: null }), '');
});

// ============================================
// Badges
// ============================================

test('renders no badge when badgeCount is 0', () => {
    const html = renderRailButtonsHtml({ activeView: 'files', views: FIXTURE_VIEWS });
    assert.doesNotMatch(html, /lp__rail-badge/);
});

test('issues badge renders when badgeCount > 0', () => {
    const views = FIXTURE_VIEWS.map(v => (v.id === 'issues' ? { ...v, badgeCount: 7 } : v));
    const html = renderRailButtonsHtml({ activeView: 'files', views });
    assert.match(
        html,
        /data-rail-btn="issues"[^>]*>[\s\S]*?<span class="lp__rail-badge">7<\/span>/,
    );
    assert.doesNotMatch(
        html,
        /data-rail-btn="prs"[^>]*>[\s\S]*?<span class="lp__rail-badge">/,
    );
});

test('non-numeric badgeCount renders no badge (defensive)', () => {
    const views = FIXTURE_VIEWS.map(v => (v.id === 'issues' ? { ...v, badgeCount: '<x>' } : v));
    const html = renderRailButtonsHtml({ activeView: 'files', views });
    assert.doesNotMatch(html, /lp__rail-badge/);
});

// ============================================
// readStoredActiveView
// ============================================

test('readStoredActiveView returns null when no value persisted', () => {
    localStorage.removeItem('leftPaneRail.activeView');
    assert.equal(readStoredActiveView(), null);
});

test('readStoredActiveView returns the persisted value when present', () => {
    localStorage.setItem('leftPaneRail.activeView', 'prs');
    assert.equal(readStoredActiveView(), 'prs');
});

// ============================================
// resolveActiveView
// ============================================

test('resolveActiveView prefers the stored id when contribution still exists', () => {
    const contribs = [
        { view: { id: 'files' } },
        { view: { id: 'issues' } },
    ];
    assert.equal(resolveActiveView(contribs, 'issues'), 'issues');
});

test('resolveActiveView falls back to first contribution when stored id is unknown', () => {
    const contribs = [
        { view: { id: 'files' } },
        { view: { id: 'issues' } },
    ];
    assert.equal(resolveActiveView(contribs, 'tasks-not-shipped-yet'), 'files');
});

test('resolveActiveView returns null when no contributions are registered', () => {
    assert.equal(resolveActiveView([], 'files'), null);
    assert.equal(resolveActiveView(null, 'files'), null);
});

// ============================================
// projectViewsForButtons
// ============================================

test('projectViewsForButtons projects view metadata + invokes badge()', () => {
    const contribs = [
        {
            view: { id: 'a', label: 'A', icon: '<svg-a/>', badge: () => 3 },
        },
        {
            view: { id: 'b', label: 'B', icon: '<svg-b/>' },  // no badge
        },
    ];
    const projected = projectViewsForButtons(contribs);
    assert.equal(projected.length, 2);
    assert.equal(projected[0].badgeCount, 3);
    assert.equal(projected[1].badgeCount, 0);
});

test('projectViewsForButtons falls back to 0 on throwing badge()', () => {
    const contribs = [{
        view: { id: 'a', label: 'A', icon: '<svg/>', badge: () => { throw new Error('boom'); } },
    }];
    assert.equal(projectViewsForButtons(contribs)[0].badgeCount, 0);
});

test('projectViewsForButtons coerces non-numeric badge return to 0', () => {
    const contribs = [{
        view: { id: 'a', label: 'A', icon: '<svg/>', badge: () => 'oops' },
    }];
    assert.equal(projectViewsForButtons(contribs)[0].badgeCount, 0);
});

// ============================================
// Mount: built-in registration + rail rendering
// ============================================

function _withFakeRailDom() {
    const railHost = {
        innerHTML: '',
        contains: () => false,
        addEventListener: () => {},
    };
    const origGetById = globalThis.document.getElementById;
    const origQSA = globalThis.document.querySelectorAll;
    const origQS = globalThis.document.querySelector;
    globalThis.document.getElementById = (id) =>
        (id === 'leftPaneRailButtons' ? railHost : null);
    globalThis.document.querySelectorAll = () => [];
    // Patch querySelector so .lp__rail-content returns null (no body wiring)
    // and any other selector behaves as before.
    globalThis.document.querySelector = (sel) => {
        if (sel === '.lp__rail-content') return null;
        return origQS ? origQS.call(globalThis.document, sel) : null;
    };
    return {
        railHost,
        restore: () => {
            globalThis.document.getElementById = origGetById;
            globalThis.document.querySelectorAll = origQSA;
            globalThis.document.querySelector = origQS;
        },
    };
}

test('mountLeftPaneRail registers the 4 built-in views at boot', () => {
    clearRailContributions();
    clearRailListeners();
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        const ids = SlotManager.getContributions('rail-views').map(c => c.view.id);
        assert.deepEqual(ids, ['files', 'issues', 'prs', 'branches'],
            'built-ins registered in priority order');
        // And the rail rendered with all four buttons.
        const matches = railHost.innerHTML.match(/data-rail-btn="([^"]+)"/g) || [];
        assert.equal(matches.length, 4);
    } finally {
        restore();
        clearRailContributions();
        clearRailListeners();
    }
});

test('built-in registration opts out when a provider has already claimed view.id', () => {
    clearRailContributions();
    clearRailListeners();
    // Pretend a provider contributed `issues` first.
    SlotManager.contribute('rail-views', {
        pluginId: 'fake-provider',
        view: { id: 'issues', label: 'Provider Issues', icon: '<svg/>', priority: 5 },
        render: () => {},
    });
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        const issuesContribs = SlotManager.getContributions('rail-views')
            .filter(c => c.view.id === 'issues');
        assert.equal(issuesContribs.length, 1, 'no collision; built-in skipped');
        assert.equal(issuesContribs[0].pluginId, 'fake-provider', 'provider wins');
    } finally {
        restore();
        clearRailContributions();
        clearRailListeners();
    }
});

test('rail badge updates on prs:render (post-fetch fresh State)', () => {
    clearRailContributions();
    clearRailListeners();
    State.issues = [];
    State.pullRequests = [{ number: 1 }, { number: 2 }];
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        assert.match(railHost.innerHTML, /data-rail-btn="prs"[^>]*>[\s\S]*?<span class="lp__rail-badge">2<\/span>/);

        State.pullRequests = [{ number: 1 }];
        EventBus.emit('prs:render');
        assert.match(railHost.innerHTML, /data-rail-btn="prs"[^>]*>[\s\S]*?<span class="lp__rail-badge">1<\/span>/);
    } finally {
        restore();
        clearRailContributions();
        clearRailListeners();
    }
});

test('rail badge updates on issues:render (same race shape)', () => {
    clearRailContributions();
    clearRailListeners();
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
        clearRailContributions();
        clearRailListeners();
    }
});

test('prs:refresh still re-paints (covers paths that mutate State synchronously)', () => {
    clearRailContributions();
    clearRailListeners();
    State.issues = [];
    State.pullRequests = [{ number: 1 }, { number: 2 }, { number: 3 }];
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        assert.match(railHost.innerHTML, /<span class="lp__rail-badge">3<\/span>/);

        State.pullRequests = [{ number: 1 }];
        EventBus.emit('prs:refresh');
        assert.match(railHost.innerHTML, /<span class="lp__rail-badge">1<\/span>/);
    } finally {
        restore();
        clearRailContributions();
        clearRailListeners();
    }
});

test('slot:rail-views:changed re-renders the rail after a contribution arrives', () => {
    clearRailContributions();
    clearRailListeners();
    State.issues = [];
    State.pullRequests = [];
    const { railHost, restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        const initialButtons = (railHost.innerHTML.match(/data-rail-btn="([^"]+)"/g) || []).length;
        assert.equal(initialButtons, 4);

        // A provider contributes a new rail view post-boot. Note that
        // contribute() invokes renderSlot() which emits slot:rail-views:changed,
        // which our rebuild() handler picks up.
        SlotManager.contribute('rail-views', {
            pluginId: 'late-provider',
            view: { id: 'workflows', label: 'Workflows', icon: '<svg/>', priority: 35 },
            render: () => {},
        });

        const afterButtons = (railHost.innerHTML.match(/data-rail-btn="([^"]+)"/g) || []).length;
        assert.equal(afterButtons, 5, 'a fifth button materialized after the late contribution');
        assert.match(railHost.innerHTML, /data-rail-btn="workflows"/);
    } finally {
        restore();
        clearRailContributions();
        clearRailListeners();
    }
});

test('setActiveView ignores unknown view ids', () => {
    clearRailContributions();
    clearRailListeners();
    const { restore } = _withFakeRailDom();
    try {
        mountLeftPaneRail();
        const before = localStorage.getItem('leftPaneRail.activeView');
        setActiveView('not-a-view');
        const after = localStorage.getItem('leftPaneRail.activeView');
        assert.equal(after, before, 'localStorage unchanged for unknown id');
    } finally {
        restore();
        clearRailContributions();
        clearRailListeners();
    }
});
