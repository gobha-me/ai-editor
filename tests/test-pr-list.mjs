/**
 * Renderer tests for js/ui/pr-list.js — pure string in, pure string out
 * (no DOM, no event delegation). Wire-up + click-handler tests live in the
 * browser suite.
 *
 * Asserts the row-list rendering and the branch-contextual filtering carved
 * out of project-manager.renderPullRequests() in 2.23.0:
 *   - Empty list returns the empty-state hint.
 *   - On the default branch, all open PRs render; head→base info row appears.
 *   - On a feature branch, only PRs whose head matches the current branch
 *     render; head→base info row is hidden.
 *   - When filtering yields zero, the branch-contextual empty-state copy
 *     names the current branch.
 *   - CI icon resolves from the documented map; unknown / missing falls back
 *     to ⚪ + "No CI status".
 *   - Titles + branch names are HTML-escaped (XSS guard).
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    renderPrRowsHtml,
    filterPullRequests,
    renderPrEmptyHtml,
} from '../js/ui/pr-list.js';

// ============================================
// Empty state
// ============================================

test('renders default-branch empty-state when list is empty', () => {
    const html = renderPrRowsHtml({
        pullRequests: [],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /No open pull requests/);
});

test('renders branch-contextual empty-state on feature branch with no matches', () => {
    const html = renderPrRowsHtml({
        pullRequests: [{ number: 1, title: 'Other', head: 'feat-a', base: 'main' }],
        currentBranch: 'feat-b',
        defaultBranch: 'main',
    });
    assert.match(html, /No PRs for branch "feat-b"/);
});

test('renderPrEmptyHtml escapes the branch name', () => {
    const html = renderPrEmptyHtml(false, 'feat/<script>');
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

// ============================================
// Branch filtering
// ============================================

test('filterPullRequests returns all PRs on the default branch', () => {
    const prs = [
        { number: 1, title: 'A', head: 'feat-a', base: 'main' },
        { number: 2, title: 'B', head: 'feat-b', base: 'main' },
    ];
    const { filtered, onDefault } = filterPullRequests(prs, 'main', 'main');
    assert.equal(onDefault, true);
    assert.equal(filtered.length, 2);
});

test('filterPullRequests narrows to head-matching PRs on a feature branch', () => {
    const prs = [
        { number: 1, title: 'A', head: 'feat-a', base: 'main' },
        { number: 2, title: 'B', head: 'feat-b', base: 'main' },
    ];
    const { filtered, onDefault } = filterPullRequests(prs, 'feat-a', 'main');
    assert.equal(onDefault, false);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].number, 1);
});

// ============================================
// Per-row shape
// ============================================

test('renders one row per PR on default branch', () => {
    const html = renderPrRowsHtml({
        pullRequests: [
            { number: 1, title: 'Add foo', head: 'feat-a', base: 'main', ciState: 'success' },
            { number: 2, title: 'Fix bar', head: 'feat-b', base: 'main', ciState: 'pending' },
        ],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    const rowMatches = html.match(/role="listitem"/g) || [];
    assert.equal(rowMatches.length, 2);
    assert.match(html, /#1/);
    assert.match(html, /#2/);
});

test('default-branch rows show head → base info', () => {
    const html = renderPrRowsHtml({
        pullRequests: [
            { number: 1, title: 'A', head: 'feat-a', base: 'main', ciState: 'success' },
        ],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /feat-a → main/);
});

test('feature-branch rows hide head → base info', () => {
    const html = renderPrRowsHtml({
        pullRequests: [
            { number: 1, title: 'A', head: 'feat-a', base: 'main', ciState: 'success' },
        ],
        currentBranch: 'feat-a',
        defaultBranch: 'main',
    });
    assert.doesNotMatch(html, /feat-a → main/);
});

test('row wires window.openPrReview with the PR number', () => {
    const html = renderPrRowsHtml({
        pullRequests: [
            { number: 42, title: 'A', head: 'feat-a', base: 'main', ciState: 'success' },
        ],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /window\.openPrReview\(42\)/);
});

// ============================================
// CI icon mapping
// ============================================

test('CI icon resolves per documented map', () => {
    const cases = [
        { state: 'success', icon: '✅' },
        { state: 'pending', icon: '🔄' },
        { state: 'failure', icon: '❌' },
        { state: 'error', icon: '❌' },
    ];
    for (const { state, icon } of cases) {
        const html = renderPrRowsHtml({
            pullRequests: [{ number: 1, title: 't', head: 'h', base: 'main', ciState: state }],
            currentBranch: 'main',
            defaultBranch: 'main',
        });
        assert.match(html, new RegExp(icon), `state=${state} should render ${icon}`);
    }
});

test('unknown / missing CI state falls back to ⚪ + "No CI status"', () => {
    const html = renderPrRowsHtml({
        pullRequests: [{ number: 1, title: 't', head: 'h', base: 'main', ciState: 'unknown' }],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /⚪/);
    assert.match(html, /No CI status/);
});

test('missing ciState falls back to unknown shape (no crash, ⚪ icon)', () => {
    const html = renderPrRowsHtml({
        pullRequests: [{ number: 1, title: 't', head: 'h', base: 'main' }],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /⚪/);
});

// ============================================
// XSS guard
// ============================================

test('escapes PR title (XSS guard)', () => {
    const html = renderPrRowsHtml({
        pullRequests: [{
            number: 1,
            title: '<img onerror=alert(1)>',
            head: 'feat-a',
            base: 'main',
            ciState: 'success',
        }],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img onerror/);
});

test('escapes branch names (XSS guard)', () => {
    const html = renderPrRowsHtml({
        pullRequests: [{
            number: 1,
            title: 't',
            head: '<script>',
            base: 'main',
            ciState: 'success',
        }],
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

// ============================================
// Defaults
// ============================================

test('defaults defaultBranch to "main" when omitted', () => {
    // currentBranch === 'main' should hit the onDefault path.
    const html = renderPrRowsHtml({
        pullRequests: [{ number: 1, title: 't', head: 'h', base: 'main', ciState: 'success' }],
        currentBranch: 'main',
    });
    assert.match(html, /#1/);
    assert.match(html, /h → main/);
});

test('handles null pullRequests array gracefully', () => {
    const html = renderPrRowsHtml({
        pullRequests: null,
        currentBranch: 'main',
        defaultBranch: 'main',
    });
    assert.match(html, /No open pull requests/);
});
