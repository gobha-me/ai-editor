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

import { renderBranchPanelHtml } from '../js/ui/branch-panel.js';

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
