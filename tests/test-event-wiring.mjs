/**
 * Event-wiring tests for the 2.24.1 audit fixes:
 *   - `tabs:render` orphan-emit deletion (line 88-92 of audit inventory)
 *   - `tab:contentChanged` producer-gap fill (line 94-98)
 *
 * The audit-track concern is whether the right channels carry the right
 * signal at the right time — these are *event-flow* assertions, not
 * UI-rendering ones. Now-strip's render path is covered separately in
 * test-now-strip.mjs; this file asserts the emit shape and subscriber
 * routing at the EventBus level.
 *
 * Test isolation: each test installs a one-shot EventBus listener and
 * removes it at end. `EventBus._listeners` is poked directly in a small
 * helper for the orphan-emit assertion.
 */
import './_node-shim.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { EventBus } from '../js/core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const JS_ROOT = resolve(REPO_ROOT, 'js');

async function jsFiles() {
    const out = [];
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
    }
    await walk(JS_ROOT);
    return out;
}

async function findMatches(pattern) {
    const hits = [];
    for (const file of await jsFiles()) {
        const text = await readFile(file, 'utf-8');
        if (pattern.test(text)) hits.push(file);
    }
    return hits;
}

function collectOne(channel) {
    const seen = [];
    const off = EventBus.on(channel, (payload) => seen.push(payload));
    return {
        seen,
        stop: () => off(),
    };
}

// ============================================
// `tab:contentChanged` payload shape
// ============================================

test('tab:contentChanged emit carries the path field', () => {
    const c = collectOne('tab:contentChanged');
    try {
        EventBus.emit('tab:contentChanged', { path: 'src/foo.js' });
        assert.equal(c.seen.length, 1);
        assert.equal(c.seen[0].path, 'src/foo.js');
    } finally {
        c.stop();
    }
});

test('tab:contentChanged emit with missing path payload does not throw', () => {
    const c = collectOne('tab:contentChanged');
    try {
        assert.doesNotThrow(() => EventBus.emit('tab:contentChanged', undefined));
        assert.doesNotThrow(() => EventBus.emit('tab:contentChanged', {}));
        assert.equal(c.seen.length, 2);
    } finally {
        c.stop();
    }
});

test('tab:contentChanged subscriber receives one event per emit (no batching)', () => {
    const c = collectOne('tab:contentChanged');
    try {
        EventBus.emit('tab:contentChanged', { path: 'a' });
        EventBus.emit('tab:contentChanged', { path: 'b' });
        EventBus.emit('tab:contentChanged', { path: 'c' });
        assert.deepEqual(c.seen.map(p => p.path), ['a', 'b', 'c']);
    } finally {
        c.stop();
    }
});

// ============================================
// `tabs:render` orphan-emit retirement
// ============================================

test('no `tabs:render` emit remains in production source (2.24.1 retirement)', async () => {
    const files = [
        'js/tools/commit-tools.js',
        // The audit grep was wider — assert no emit anywhere under js/
        // by reading the whole tree once. Cheap enough for an [S] PR.
    ];
    for (const rel of files) {
        const text = await readFile(resolve(REPO_ROOT, rel), 'utf-8');
        assert.doesNotMatch(
            text,
            /EventBus\.emit\(\s*['"]tabs:render['"]/,
            `${rel} must not contain EventBus.emit('tabs:render') — orphan retired at 2.24.1`,
        );
    }
});

test('no `tabs:render` subscriber exists either (channel fully retired)', async () => {
    const text = await Promise.all([
        'js/tab-manager.js',
        'js/app.js',
        'js/tools/commit-tools.js',
    ].map(rel => readFile(resolve(REPO_ROOT, rel), 'utf-8')));
    for (const t of text) {
        assert.doesNotMatch(
            t,
            /EventBus\.on\(\s*['"]tabs:render['"]/,
            "no EventBus.on('tabs:render', …) — channel retired entirely at 2.24.1",
        );
    }
});

// ============================================
// Producer coverage — each known emit site reachable from grep
// ============================================

test('js/editor/instance.js carries 5 tab:contentChanged emit sites alongside editor:lines* events', async () => {
    const text = await readFile(resolve(REPO_ROOT, 'js/editor/instance.js'), 'utf-8');
    const emits = text.match(/EventBus\.emit\(\s*['"]tab:contentChanged['"]/g) || [];
    assert.ok(emits.length >= 5, `expected >= 5 emit sites in editor/instance.js, found ${emits.length}`);
});

test('js/git.js#batchSaveFiles emits tab:contentChanged keyed on result.path', async () => {
    const text = await readFile(resolve(REPO_ROOT, 'js/git.js'), 'utf-8');
    // The for-loop body is non-trivial (nested `if`s); rather than regex
    // the loop region, assert (a) the for header exists and (b) the emit
    // uses result.path — which only makes sense inside that loop.
    assert.match(text, /for \(const result of results\)/, 'batchSaveFiles for-loop present');
    assert.match(
        text,
        /EventBus\.emit\(\s*['"]tab:contentChanged['"],\s*\{\s*path:\s*result\.path\s*\}/,
        'per-result tab:contentChanged emit with { path: result.path }',
    );
});

test('js/ui-helpers.js git:saved listener emits tab:contentChanged after dirty flip', async () => {
    const text = await readFile(resolve(REPO_ROOT, 'js/ui-helpers.js'), 'utf-8');
    const handlerMatch = text.match(/EventBus\.on\(\s*['"]git:saved['"][\s\S]+?\}\);/);
    assert.ok(handlerMatch, "EventBus.on('git:saved', ...) handler present");
    assert.match(
        handlerMatch[0],
        /EventBus\.emit\(\s*['"]tab:contentChanged['"]/,
        'tab:contentChanged emit inside git:saved handler',
    );
});

test('js/ui/revert.js revertAllFiles loop emits tab:contentChanged per reverted tab', async () => {
    const text = await readFile(resolve(REPO_ROOT, 'js/ui/revert.js'), 'utf-8');
    const loopMatch = text.match(/for \(const tab of dirtyTabs\)[\s\S]+?revertedCount\+\+;/);
    assert.ok(loopMatch, 'revertAllFiles for-loop present');
    assert.match(
        loopMatch[0],
        /EventBus\.emit\(\s*['"]tab:contentChanged['"],\s*\{\s*path:\s*tab\.path\s*\}/,
        'per-tab tab:contentChanged emit inside revertAllFiles loop',
    );
});

// ============================================
// 2.39.0.2 orphan-emit cleanup (sweep wave slice 3)
// Inventory entries #113 (toast) and #198 (error / settings:loaded).
// ============================================

test("no EventBus.emit('toast') anywhere in js/ — orphan emit retired at 2.39.0.2", async () => {
    const hits = await findMatches(/EventBus\.emit\(\s*['"]toast['"]/);
    assert.deepEqual(hits, [], `unexpected toast emit sites: ${hits.join(', ')}`);
});

test("no EventBus.on('error') subscriber in js/ — orphan subscriber retired at 2.39.0.2", async () => {
    const hits = await findMatches(/EventBus\.on\(\s*['"]error['"]/);
    assert.deepEqual(hits, [], `unexpected error subscribers: ${hits.join(', ')}`);
});

test("no EventBus.on('settings:loaded') subscriber in js/ — orphan subscriber retired at 2.39.0.2", async () => {
    const hits = await findMatches(/EventBus\.on\(\s*['"]settings:loaded['"]/);
    assert.deepEqual(hits, [], `unexpected settings:loaded subscribers: ${hits.join(', ')}`);
});

test("favicon-manager.js still subscribes to llm:generating (regression guard on the sibling subscriber)", async () => {
    const text = await readFile(resolve(REPO_ROOT, 'js/favicon-manager.js'), 'utf-8');
    assert.match(
        text,
        /EventBus\.on\(\s*['"]llm:generating['"]/,
        "favicon's llm:generating subscriber must survive the error-subscriber deletion",
    );
});
