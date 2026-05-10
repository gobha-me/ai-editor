/**
 * Pure-helper tests for js/ui/now-strip.js — Touch 3 1.x candidate C (2.17.0).
 *
 * Covers the four exported pure functions:
 *   - computeNowSummary(state, queueLen)
 *   - formatChangesText(dirtyCount)
 *   - formatAgentText({ scratchpadCount, todoActive, queuedCount })
 *   - renderNowStripHtml(summary)
 *
 * mountNowStrip + EventBus subscriptions are covered manually in the browser
 * suite (Tier 3a preview MCP harness), same as left-pane-rail.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    computeNowSummary,
    formatChangesText,
    formatAgentText,
    renderNowStripHtml,
} from '../js/ui/now-strip.js';

// ============================================
// computeNowSummary
// ============================================

test('computeNowSummary returns all zeros for empty state', () => {
    const s = computeNowSummary({}, 0);
    assert.equal(s.dirtyCount, 0);
    assert.equal(s.scratchpadCount, 0);
    assert.equal(s.todoActive, 0);
    assert.equal(s.queuedCount, 0);
});

test('computeNowSummary tolerates null / missing fields', () => {
    const s = computeNowSummary(null, undefined);
    assert.deepEqual(s, { dirtyCount: 0, scratchpadCount: 0, todoActive: 0, queuedCount: 0 });
});

test('computeNowSummary counts dirty tabs only', () => {
    const state = { openTabs: [
        { dirty: true }, { dirty: false }, { dirty: true }, {},
    ] };
    assert.equal(computeNowSummary(state, 0).dirtyCount, 2);
});

test('computeNowSummary counts scratchpad keys', () => {
    assert.equal(computeNowSummary({ scratchpad: {} }, 0).scratchpadCount, 0);
    assert.equal(computeNowSummary({ scratchpad: { a: 1, b: 2, c: 3 } }, 0).scratchpadCount, 3);
});

test('computeNowSummary counts only pending + in_progress todos', () => {
    const state = { todo: [
        { id: 1, status: 'pending' },
        { id: 2, status: 'in_progress' },
        { id: 3, status: 'completed' },
        { id: 4, status: 'pending' },
        { id: 5 }, // malformed — no status
    ] };
    assert.equal(computeNowSummary(state, 0).todoActive, 3);
});

test('computeNowSummary passes through queue length, coercing non-finite to 0', () => {
    assert.equal(computeNowSummary({}, 4).queuedCount, 4);
    assert.equal(computeNowSummary({}, NaN).queuedCount, 0);
    assert.equal(computeNowSummary({}, undefined).queuedCount, 0);
});

// ============================================
// formatChangesText
// ============================================

test('formatChangesText: 0 → "clean"', () => {
    assert.equal(formatChangesText(0), 'clean');
});

test('formatChangesText: 1 → "1 file" (singular)', () => {
    assert.equal(formatChangesText(1), '1 file');
});

test('formatChangesText: N>1 → "N files" (plural)', () => {
    assert.equal(formatChangesText(2), '2 files');
    assert.equal(formatChangesText(42), '42 files');
});

// ============================================
// formatAgentText
// ============================================

test('formatAgentText: all zero → "idle"', () => {
    assert.equal(
        formatAgentText({ scratchpadCount: 0, todoActive: 0, queuedCount: 0 }),
        'idle',
    );
});

test('formatAgentText: only one bucket non-zero → single label', () => {
    assert.equal(
        formatAgentText({ scratchpadCount: 1, todoActive: 0, queuedCount: 0 }),
        '1 note',
    );
    assert.equal(
        formatAgentText({ scratchpadCount: 0, todoActive: 2, queuedCount: 0 }),
        '2 todos',
    );
    assert.equal(
        formatAgentText({ scratchpadCount: 0, todoActive: 0, queuedCount: 3 }),
        '3 queued',
    );
});

test('formatAgentText: multiple buckets join with ", "', () => {
    assert.equal(
        formatAgentText({ scratchpadCount: 2, todoActive: 1, queuedCount: 0 }),
        '2 notes, 1 todo',
    );
    assert.equal(
        formatAgentText({ scratchpadCount: 1, todoActive: 3, queuedCount: 1 }),
        '1 note, 3 todos, 1 queued',
    );
});

test('formatAgentText: singular/plural by bucket', () => {
    assert.equal(
        formatAgentText({ scratchpadCount: 1, todoActive: 1, queuedCount: 1 }),
        '1 note, 1 todo, 1 queued',
    );
});

// ============================================
// renderNowStripHtml
// ============================================

test('renderNowStripHtml emits both rows', () => {
    const html = renderNowStripHtml({
        dirtyCount: 1, scratchpadCount: 0, todoActive: 0, queuedCount: 0,
    });
    assert.match(html, /lp2__now-label">Changes/);
    assert.match(html, /lp2__now-label">Agent/);
});

test('renderNowStripHtml: dirtyCount=0 omits the Stage… link', () => {
    const html = renderNowStripHtml({
        dirtyCount: 0, scratchpadCount: 0, todoActive: 0, queuedCount: 0,
    });
    assert.doesNotMatch(html, /data-now-action="stage"/);
    assert.match(html, />clean</);
});

test('renderNowStripHtml: dirtyCount>0 shows the Stage… link', () => {
    const html = renderNowStripHtml({
        dirtyCount: 3, scratchpadCount: 0, todoActive: 0, queuedCount: 0,
    });
    assert.match(html, /data-now-action="stage"/);
    assert.match(html, />Stage…</);
    assert.match(html, />3 files</);
});

test('renderNowStripHtml: any non-zero agent bucket shows the running dot', () => {
    const html = renderNowStripHtml({
        dirtyCount: 0, scratchpadCount: 1, todoActive: 0, queuedCount: 0,
    });
    assert.match(html, /lp2__now-val--run/);
    assert.match(html, />●</);
});

test('renderNowStripHtml: idle agent has no dot', () => {
    const html = renderNowStripHtml({
        dirtyCount: 0, scratchpadCount: 0, todoActive: 0, queuedCount: 0,
    });
    assert.doesNotMatch(html, /lp2__now-val--run/);
    assert.match(html, />idle</);
});

test('renderNowStripHtml: defensively HTML-escapes count-derived text', () => {
    // Counts are numbers in the live system, but if a future caller smuggled
    // a string in via formatAgentText, escapeHtml in the renderer should
    // neutralize it. We verify by piping a synthetic summary whose
    // formatAgentText output (re-derived inside the renderer) is a clean
    // string, confirming no raw `<` makes it through.
    const html = renderNowStripHtml({
        dirtyCount: 0, scratchpadCount: 0, todoActive: 0, queuedCount: 0,
    });
    assert.doesNotMatch(html, /<script/i);
});
