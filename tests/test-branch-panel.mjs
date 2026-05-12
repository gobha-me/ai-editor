/**
 * Renderer tests for js/ui/branch-panel.js — pure string in, pure string out
 * (no DOM, no event delegation). Wire-up + click-handler tests live in the
 * browser suite.
 *
 * Asserts the row-list switcher rendering decisions documented in the 1.12.0
 * Touch 3 extraction A plan:
 *   - One row per branch.
 *   - Current row exposes "Cut release"; non-current rows expose "Switch".
 *   - Protected branches hide the Delete button; non-current non-protected
 *     branches expose Delete.
 *   - Counts hidden when metadata.ahead AND metadata.behind are null.
 *   - Counts hidden on the current branch when both counts are 0 (visual noise).
 *   - Branch names are HTML-escaped in name + tooltips.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderBranchPanelHtml, renderBranchPanel } from '../js/ui/branch-panel.js';
import { State } from '../js/core.js';

// ============================================
// Empty state
// ============================================

test('renders an empty-state hint when branches list is empty', () => {
    const html = renderBranchPanelHtml({ branches: [], currentBranch: 'main' });
    assert.match(html, /branch-panel__empty/);
    assert.match(html, /No branches yet/);
});

test('renders empty-state when branches is null', () => {
    const html = renderBranchPanelHtml({ branches: null, currentBranch: 'main' });
    assert.match(html, /branch-panel__empty/);
});

// ============================================
// Per-row shape
// ============================================

test('renders one row per branch', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }, { name: 'feature-x' }, { name: 'fix/foo' }],
        currentBranch: 'main',
    });
    // Outer rows have role="listitem"; inner __row-main / __row-* divs do not.
    const rowMatches = html.match(/role="listitem"/g) || [];
    assert.equal(rowMatches.length, 3);
});

test('current branch row has --current modifier; others do not', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }, { name: 'feature-x' }],
        currentBranch: 'main',
    });
    assert.match(html, /branch-panel__row branch-panel__row--current[^"]*"[^>]*data-branch-name="main"/);
    assert.doesNotMatch(html, /branch-panel__row branch-panel__row--current[^"]*"[^>]*data-branch-name="feature-x"/);
});

// ============================================
// Action affordances
// ============================================

test('current branch shows Cut release button; non-current shows Switch', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }, { name: 'feature-x' }],
        currentBranch: 'main',
    });
    // Current row → Cut release (action="cutRelease")
    assert.match(html, /data-branch-action="cutRelease"/);
    // Non-current row → Switch
    assert.match(html, /data-branch-action="switch"[^>]*data-branch-name="feature-x"/);
    // Current row should NOT have Switch
    assert.doesNotMatch(html, /data-branch-action="switch"[^>]*data-branch-name="main"/);
});

test('non-current non-protected branch shows Delete', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main', protected: true }, { name: 'feature-x' }],
        currentBranch: 'main',
    });
    assert.match(html, /data-branch-action="delete"[^>]*data-branch-name="feature-x"/);
});

test('protected non-current branch hides Delete', () => {
    const html = renderBranchPanelHtml({
        branches: [
            { name: 'main' },
            { name: 'release', protected: true },
        ],
        currentBranch: 'main',
    });
    assert.doesNotMatch(html, /data-branch-action="delete"[^>]*data-branch-name="release"/);
});

test('current branch hides Delete (you cannot delete the branch you are on)', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'feature-x' }, { name: 'main' }],
        currentBranch: 'feature-x',
    });
    assert.doesNotMatch(html, /data-branch-action="delete"[^>]*data-branch-name="feature-x"/);
});

test('protected branch renders the protected tag', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main', protected: true }],
        currentBranch: 'main',
    });
    assert.match(html, /branch-panel__tag--protected/);
    assert.match(html, />protected</);
});

// ============================================
// Export-zip action (Touch 3 zip-flow, 2.20.0)
// ============================================

test('Export action is hidden by default (showExport unset)', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }, { name: 'feature-x' }],
        currentBranch: 'main',
    });
    assert.doesNotMatch(html, /data-branch-action="exportZip"/);
    assert.doesNotMatch(html, /branch-panel__btn--export/);
});

test('Export action renders on every row when showExport is true', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }, { name: 'feature-x' }, { name: 'fix/foo' }],
        currentBranch: 'main',
        showExport: true,
    });
    const matches = html.match(/data-branch-action="exportZip"/g) || [];
    assert.equal(matches.length, 3);
});

test('Export action carries data-branch-name attribute for delegation', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'feature-x' }],
        currentBranch: 'main',
        showExport: true,
    });
    assert.match(html, /data-branch-action="exportZip"[^>]*data-branch-name="feature-x"/);
});

// ============================================
// Ahead/behind counts
// ============================================

test('renders ↑N ↓M chip when both counts are known', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }, { name: 'feature-x' }],
        currentBranch: 'main',
        metadata: { 'feature-x': { ahead: 7, behind: 2 } },
    });
    assert.match(html, /↑7/);
    assert.match(html, /↓2/);
    assert.match(html, /branch-panel__count--ahead/);
    assert.match(html, /branch-panel__count--behind/);
});

test('hides counts when both ahead and behind are null', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'feature-x' }],
        currentBranch: 'main',
        metadata: { 'feature-x': { ahead: null, behind: null } },
    });
    assert.doesNotMatch(html, /branch-panel__counts/);
    assert.doesNotMatch(html, /↑/);
    assert.doesNotMatch(html, /↓/);
});

test('hides counts when no metadata entry exists for the branch', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'feature-x' }],
        currentBranch: 'main',
        metadata: {},
    });
    assert.doesNotMatch(html, /branch-panel__counts/);
});

test('hides counts on current branch when both are 0 (visual noise)', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'main' }],
        currentBranch: 'main',
        metadata: { main: { ahead: 0, behind: 0 } },
    });
    assert.doesNotMatch(html, /branch-panel__counts/);
});

test('renders single-direction chip when only one count is known', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'feature-x' }],
        currentBranch: 'main',
        metadata: { 'feature-x': { ahead: 5, behind: null } },
    });
    assert.match(html, /↑5/);
    assert.doesNotMatch(html, /↓/);
});

// ============================================
// XSS / escaping
// ============================================

test('escapes HTML-shaped branch names in row body', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: '<script>alert(1)</script>' }],
        currentBranch: 'main',
    });
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
});

test('escapes branch names inside data-* attributes (attribute-context)', () => {
    const html = renderBranchPanelHtml({
        branches: [{ name: 'feature-x' }, { name: '"><img src=x>' }],
        currentBranch: 'feature-x',
    });
    // The malicious quote-break must not produce a raw <img> tag
    assert.doesNotMatch(html, /<img src=x>/);
});

// ============================================
// gitea#392 — container arg tolerates EventBus payloads (2.38.2)
// ============================================

/**
 * Regression: `renderBranchPanel` is wired as both a direct DOM caller (rail
 * body render passes a real element) AND as an EventBus listener for several
 * channels (`branch:switch`, `branches:refresh`, `branches:metadataChanged`,
 * etc.) where the first arg is the event payload object, not a DOM element.
 *
 * Pre-2.38.2 the `container || getElementById(PANEL_ID)` fallback would
 * short-circuit on a truthy payload and silently set `.innerHTML` on the
 * plain object, leaving the real `#branchPanel` un-rendered. The visible
 * symptom (gitea#392) was the branch-switcher active-highlight class
 * staying on the previously-active row after a successful branch switch:
 * `branch:switch` payload `{ branch, previousBranch }` reached
 * `renderBranchPanel` first-arg, hit the truthy short-circuit, mutated the
 * payload object, and never reached the real DOM.
 *
 * The fix: `container.nodeType === 1` guard. Tests both shapes — a real
 * Element-like (nodeType 1) container wins; a payload object falls through
 * to the `getElementById` lookup.
 */
test('renderBranchPanel ignores non-Element first arg, falls back to getElementById (gitea#392)', () => {
    const panelEl = {
        nodeType: 1,
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = String(v); },
    };
    const origGetById = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) =>
        (id === 'branchPanel' ? panelEl : null);

    const origProject = State.currentProject;
    const origBranches = State.branches;
    const origCurrent = State.currentBranch;
    State.currentProject = { connectionId: '__local__', owner: 'a', repo: 'b' };
    State.branches = [{ name: 'main' }, { name: 'feature-x' }];
    State.currentBranch = 'feature-x';

    try {
        // Simulate the EventBus passing a `branch:switch` payload as the first arg.
        const payload = { branch: 'feature-x', previousBranch: 'main' };
        renderBranchPanel(payload);

        // The payload object must NOT have been mutated.
        assert.equal(
            payload.innerHTML,
            undefined,
            'renderBranchPanel must not write innerHTML to a non-Element first arg',
        );
        // The real #branchPanel MUST have been rendered via getElementById fallback.
        assert.match(
            panelEl._innerHTML,
            /branch-panel__row/,
            'real #branchPanel element should receive the rendered rows',
        );
        // And the active-highlight class should be on the current branch row,
        // not the previous one (which was gitea#392's visible symptom).
        assert.match(
            panelEl._innerHTML,
            /branch-panel__row branch-panel__row--current[^"]*"[^>]*data-branch-name="feature-x"/,
            'current-branch row should carry the --current modifier after re-render',
        );
    } finally {
        globalThis.document.getElementById = origGetById;
        State.currentProject = origProject;
        State.branches = origBranches;
        State.currentBranch = origCurrent;
    }
});

test('renderBranchPanel still honors an explicit Element-shaped container override', () => {
    const explicit = {
        nodeType: 1,
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = String(v); },
    };
    const wrongPanel = {
        nodeType: 1,
        _innerHTML: '',
        get innerHTML() { return this._innerHTML; },
        set innerHTML(v) { this._innerHTML = String(v); },
    };
    const origGetById = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) =>
        (id === 'branchPanel' ? wrongPanel : null);

    const origProject = State.currentProject;
    const origBranches = State.branches;
    const origCurrent = State.currentBranch;
    State.currentProject = { connectionId: '__local__' };
    State.branches = [{ name: 'main' }];
    State.currentBranch = 'main';

    try {
        renderBranchPanel(explicit);
        assert.match(explicit._innerHTML, /branch-panel__row/,
            'explicit container should receive the render');
        assert.equal(wrongPanel._innerHTML, '',
            'getElementById fallback should NOT fire when an Element is passed');
    } finally {
        globalThis.document.getElementById = origGetById;
        State.currentProject = origProject;
        State.branches = origBranches;
        State.currentBranch = origCurrent;
    }
});
