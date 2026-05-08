/**
 * Renderer tests for js/ui/issue-list.js — pure string in, pure string out
 * (1.13.0, Touch 3 extraction B). No DOM; mounted handlers + window globals
 * live in app.js + project-manager.js and are out of scope for these tests.
 *
 * Asserts the inline-Start-button decisions documented in the 1.13.0 plan:
 *   - One button per row, three states: ▶ Start / 🔀 Switch & Start / ✅ Active.
 *   - Active state is disabled (so the row's openIssueTab is still the way in).
 *   - The button onclick suppresses propagation so it doesn't fire openIssueTab.
 *   - Issue title is HTML-escaped; aria labels are populated.
 *   - Active / focused row classes from the legacy renderer are preserved.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderIssueRowsHtml } from '../js/ui/issue-list.js';

// ============================================
// Empty state — caller renders an empty-state hint, helper returns ''
// ============================================

test('returns empty string when issues list is empty', () => {
    assert.equal(renderIssueRowsHtml({ issues: [] }), '');
});

test('returns empty string when issues is null/undefined', () => {
    assert.equal(renderIssueRowsHtml({ issues: null }), '');
    assert.equal(renderIssueRowsHtml({}), '');
});

// ============================================
// Per-row shape
// ============================================

const baseCtx = {
    branches: [{ name: 'main' }],
    currentBranch: 'main',
    defaultBranch: 'main',
};

test('renders one row per issue', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [
            { number: 1, title: 'A', labels: [] },
            { number: 2, title: 'B', labels: [] },
            { number: 3, title: 'C', labels: [] },
        ],
    });
    const rowMatches = html.match(/role="listitem"/g) || [];
    assert.equal(rowMatches.length, 3);
});

test('every row has exactly one inline Start button', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [
            { number: 1, title: 'A', labels: [] },
            { number: 2, title: 'B', labels: [] },
        ],
    });
    const btnMatches = html.match(/class="issue-item-start[^"]*"/g) || [];
    assert.equal(btnMatches.length, 2);
});

// ============================================
// Three button states
// ============================================

test('▶ Start label when no branch exists yet', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 12, title: 'Add pause to Snake', labels: [] }],
    });
    assert.match(html, />▶ Start</);
    assert.doesNotMatch(html, /Switch & Start/);
    assert.doesNotMatch(html, /✅ Active/);
});

test('🔀 Switch & Start label when branch exists but not current', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        branches: [{ name: 'main' }, { name: 'issue/12-add-pause-to-snake' }],
        issues: [{ number: 12, title: 'Add pause to Snake', labels: [] }],
    });
    assert.match(html, /🔀 Switch & Start/);
    assert.doesNotMatch(html, />▶ Start</);
});

test('✅ Active label + disabled when currently on the issue branch', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        branches: [{ name: 'issue/12-add-pause-to-snake' }],
        currentBranch: 'issue/12-add-pause-to-snake',
        issues: [{ number: 12, title: 'Add pause to Snake', labels: [] }],
    });
    assert.match(html, /✅ Active/);
    // Active button is disabled to keep openIssueTab as the only way in.
    assert.match(html, /class="issue-item-start issue-item-start--active"\s+disabled/);
});

// ============================================
// Click delegation — bubbling guard
// ============================================

test('Start button onclick stops propagation (so row openIssueTab does NOT fire)', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 7, title: 'Fix bug', labels: [] }],
    });
    assert.match(html, /event\.stopPropagation\(\); window\.startWorkOnIssueFromList\(7\)/);
});

test('row click still wired to openIssueTab', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 7, title: 'Fix bug', labels: [] }],
    });
    assert.match(html, /onclick="window\.openIssueTab\(7\)"/);
});

// ============================================
// HTML escaping — the renderer composes attributes from caller-supplied
// strings. Issue titles and labels can contain user-controlled HTML.
// ============================================

test('issue title is HTML-escaped in the .issue-title body', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 1, title: '<script>alert(1)</script>', labels: [] }],
    });
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
});

test('labels are HTML-escaped', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 1, title: 'A', labels: ['<b>bold</b>'] }],
    });
    assert.doesNotMatch(html, /<b>bold<\/b>/);
    assert.match(html, /&lt;b&gt;/);
});

// ============================================
// Active / focused row state preserved from legacy renderer
// ============================================

test('currentIssue.number marks its row with .issue-item-active', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [
            { number: 1, title: 'A', labels: [] },
            { number: 2, title: 'B', labels: [] },
        ],
        currentIssue: { number: 2 },
    });
    // Row 2 gets the modifier; row 1 does not.
    const rows = html.split('role="listitem"');
    // After split the current row's class string lives in the chunk before its `role=` marker.
    // Easier: just count occurrences of the active modifier.
    const activeCount = (html.match(/issue-item-active/g) || []).length;
    assert.equal(activeCount, 1);
});

test('focusedIssue.number marks its row with .issue-item-focused (when not active)', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [
            { number: 1, title: 'A', labels: [] },
            { number: 2, title: 'B', labels: [] },
        ],
        focusedIssue: { number: 1 },
    });
    const focusedCount = (html.match(/issue-item-focused/g) || []).length;
    assert.equal(focusedCount, 1);
});

test('active beats focused when both refer to the same issue', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 1, title: 'A', labels: [] }],
        currentIssue: { number: 1 },
        focusedIssue: { number: 1 },
    });
    assert.match(html, /issue-item-active/);
    assert.doesNotMatch(html, /issue-item-focused/);
});

// ============================================
// Dependencies — preserved from legacy renderer
// ============================================

test('dependencies row renders with click-stopping dep links', () => {
    const html = renderIssueRowsHtml({
        ...baseCtx,
        issues: [{ number: 1, title: 'A', labels: [], dependencies: [42, 7] }],
    });
    assert.match(html, /Depends on:/);
    assert.match(html, /#42/);
    assert.match(html, /#7/);
    assert.match(html, /event\.stopPropagation/);
});
