/**
 * Renderer tests for js/ui/commit-memory-section.js — pure string in,
 * pure string out (no DOM, no event delegation). Wire-up tests live in
 * the browser suite at tests/test-commit-modal-memory.js.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    renderMemoryUpdatesSection,
    formatPendingDiff,
} from '../js/ui/commit-memory-section.js';

test('returns empty string when no pending paths', () => {
    assert.equal(renderMemoryUpdatesSection({ pendingPaths: [], isProtected: false }), '');
    assert.equal(renderMemoryUpdatesSection({ pendingPaths: [], isProtected: true }), '');
    assert.equal(renderMemoryUpdatesSection({ pendingPaths: undefined }), '');
});

test('Flow 3A — unprotected branch renders auto-stage panel', () => {
    const html = renderMemoryUpdatesSection({
        pendingPaths: ['.aieditor/memory/preferences.md'],
        isProtected: false,
        branch: 'feature/x',
    });
    assert.match(html, /commit-section--mem/);
    assert.match(html, /◆ Memory updates/);
    assert.match(html, /auto-staged · 1 file/);
    assert.match(html, /\.aieditor\/memory\/preferences\.md/);
    assert.match(html, /Show diff/);
    assert.doesNotMatch(html, /commit-section--warn/);
    assert.doesNotMatch(html, /protected/);
});

test('Flow 3A — checkboxes are checked and not disabled', () => {
    const html = renderMemoryUpdatesSection({
        pendingPaths: ['.aieditor/memory/preferences.md'],
        isProtected: false,
    });
    assert.match(html, /<input type="checkbox" checked/);
    assert.doesNotMatch(html, /<input type="checkbox" disabled/);
});

test('Flow 3B — protected branch renders warning panel with three buttons', () => {
    const html = renderMemoryUpdatesSection({
        pendingPaths: ['.aieditor/memory/preferences.md'],
        isProtected: true,
        branch: 'main',
    });
    assert.match(html, /commit-section--warn/);
    assert.match(html, /⚠ Memory writes can't be staged here/);
    assert.match(html, /on protected branch/);
    assert.match(html, /<input type="checkbox" disabled/);
    assert.match(html, /data-mem-action="branchOff"/);
    assert.match(html, /data-mem-action="keepPending"/);
    assert.match(html, /data-mem-action="discard"/);
    // Branch name is escaped into the hint
    assert.match(html, /<code class="branch-row__name">main<\/code>/);
});

test('Flow 3A — file-count pluralization', () => {
    const html = renderMemoryUpdatesSection({
        pendingPaths: ['a.md', 'b.md', 'c.md'],
        isProtected: false,
    });
    assert.match(html, /auto-staged · 3 files/);
});

test('Flow 3B — pluralizes the hint when more than one file pending', () => {
    const html3 = renderMemoryUpdatesSection({
        pendingPaths: ['a.md', 'b.md', 'c.md'],
        isProtected: true,
        branch: 'main',
    });
    assert.match(html3, /3 pending memory updates/);

    const html1 = renderMemoryUpdatesSection({
        pendingPaths: ['a.md'],
        isProtected: true,
        branch: 'main',
    });
    assert.match(html1, /1 pending memory update\b/);
});

test('renderer escapes path-shaped XSS attempts', () => {
    const html = renderMemoryUpdatesSection({
        pendingPaths: ['<script>alert(1)</script>'],
        isProtected: false,
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
});

test('renderer escapes branch-shaped XSS attempts', () => {
    const html = renderMemoryUpdatesSection({
        pendingPaths: ['x.md'],
        isProtected: true,
        branch: '"><img src=x>',
    });
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /&quot;&gt;&lt;img/);
});

test('formatPendingDiff prefixes every line with "+ "', () => {
    assert.equal(
        formatPendingDiff('first\nsecond\nthird'),
        '+ first\n+ second\n+ third',
    );
});

test('formatPendingDiff handles empty + single-line content', () => {
    assert.equal(formatPendingDiff(''), '');
    assert.equal(formatPendingDiff('only'), '+ only');
});
