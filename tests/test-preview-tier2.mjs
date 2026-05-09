/**
 * Tests for In-editor preview & verify Tier 2 (2.7.0 — DESIGN-preview.md
 * §Phase 2). Exercises the four new capture readers' registration shape,
 * argument validation, ring-buffer drop-oldest behavior, and the level /
 * lines / search / filter knobs. The Service Worker shim injection and
 * iframe postMessage round-trip are covered in the browser suite
 * (`tests/index.html`) — Node cannot register a real SW or mount a
 * sandboxed iframe.
 *
 * Runs under `node --test`. Co-resident with the Tier 1 tests in
 * `tests/test-preview-tools.mjs` (the registration-count test there is
 * pinned to 7 to enforce parity if a future tier adds more tools).
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerPreviewTools } from '../js/tools/preview-tools.js';
import {
    _resetForTests,
    _pushCaptureForTests,
    getConsoleLogs,
    getErrors,
    getRouteLogs,
    getNetwork,
} from '../js/preview/preview-host.js';

// ============================================
// Tool registration — Tier 2 surface
// ============================================

test('Tier 2 registers four readers (preview_console_logs, preview_errors, preview_logs, preview_network)', () => {
    const captured = [];
    const stub = { register(name, handler, definition) { captured.push({ name, handler, definition }); } };
    registerPreviewTools(stub);
    const t2 = captured.filter(c => [
        'preview_console_logs', 'preview_errors', 'preview_logs', 'preview_network',
    ].includes(c.name));
    assert.equal(t2.length, 4);
    for (const c of t2) {
        assert.equal(c.definition.readOnly, true, `${c.name} is readOnly`);
        assert.equal(c.definition.roles, 'all', `${c.name} roles=all`);
        assert.equal(c.definition.function.name, c.name);
        assert.deepEqual(c.definition.function.parameters.required, ['serverId'],
            `${c.name} requires serverId`);
    }
});

test('Tier 2 tools reject missing / blank serverId', async () => {
    const handlers = {};
    const stub = { register(name, handler) { handlers[name] = handler; } };
    registerPreviewTools(stub);
    for (const name of ['preview_console_logs', 'preview_errors', 'preview_logs', 'preview_network']) {
        const r1 = await handlers[name](null);
        assert.ok(r1.error, `${name} rejects null args`);
        const r2 = await handlers[name]({});
        assert.ok(r2.error, `${name} rejects empty object`);
        const r3 = await handlers[name]({ serverId: '   ' });
        assert.ok(r3.error, `${name} rejects whitespace-only serverId`);
    }
});

// ============================================
// Ring buffer — drop oldest at cap, truncated flag
// ============================================

test('console buffer drops oldest at the 200-entry cap and reports truncated', () => {
    _resetForTests();
    const sid = 'srv_cap';
    for (let i = 0; i < 250; i++) {
        _pushCaptureForTests(sid, { type: 'console', level: 'log', message: 'm' + i, ts: i });
    }
    const r = getConsoleLogs({ serverId: sid, lines: 200 });
    assert.equal(r.logs.length, 200, 'cap holds 200 entries');
    assert.equal(r.logs[0].message, 'm50', 'oldest 50 entries dropped (m0..m49 gone)');
    assert.equal(r.logs[199].message, 'm249', 'newest entry kept');
});

test('lines knob clips and surfaces truncated when buffer has more', () => {
    _resetForTests();
    const sid = 'srv_clip';
    for (let i = 0; i < 60; i++) {
        _pushCaptureForTests(sid, { type: 'console', level: 'log', message: 'x' + i, ts: i });
    }
    const r = getConsoleLogs({ serverId: sid, lines: 10 });
    assert.equal(r.logs.length, 10);
    assert.equal(r.truncated, true);
    assert.equal(r.logs[0].message, 'x50', 'returns the last 10 (most-recent)');
    assert.equal(r.logs[9].message, 'x59');
});

test('preview_console_logs level filter: error returns only error', () => {
    _resetForTests();
    const sid = 'srv_lvl';
    _pushCaptureForTests(sid, { type: 'console', level: 'log', message: 'a' });
    _pushCaptureForTests(sid, { type: 'console', level: 'warn', message: 'b' });
    _pushCaptureForTests(sid, { type: 'console', level: 'error', message: 'c' });
    const r = getConsoleLogs({ serverId: sid, level: 'error', lines: 100 });
    assert.equal(r.logs.length, 1);
    assert.equal(r.logs[0].level, 'error');
    assert.equal(r.logs[0].message, 'c');
});

test('preview_console_logs level=warn returns warn + error', () => {
    _resetForTests();
    const sid = 'srv_lvl_warn';
    _pushCaptureForTests(sid, { type: 'console', level: 'log', message: 'a' });
    _pushCaptureForTests(sid, { type: 'console', level: 'warn', message: 'b' });
    _pushCaptureForTests(sid, { type: 'console', level: 'error', message: 'c' });
    const r = getConsoleLogs({ serverId: sid, level: 'warn', lines: 100 });
    assert.equal(r.logs.length, 2);
    assert.deepEqual(r.logs.map(l => l.level), ['warn', 'error']);
});

test('preview_errors returns errors with full envelope', () => {
    _resetForTests();
    const sid = 'srv_err';
    _pushCaptureForTests(sid, {
        type: 'error',
        message: "Cannot read properties of null (reading 'textContent')",
        source: 'js/game.js',
        line: 42,
        col: 7,
        stack: 'TypeError: Cannot read properties of null...\n    at updateUI (js/game.js:42:7)',
        ts: 1000,
    });
    const r = getErrors({ serverId: sid });
    assert.equal(r.errors.length, 1);
    const err = r.errors[0];
    assert.equal(err.message, "Cannot read properties of null (reading 'textContent')");
    assert.equal(err.source, 'js/game.js');
    assert.equal(err.line, 42);
    assert.equal(err.col, 7);
    assert.match(err.stack, /TypeError/);
});

test('preview_logs search filter matches stage and path', () => {
    _resetForTests();
    const sid = 'srv_routes';
    _pushCaptureForTests(sid, { type: 'route', stage: 'fetch-intercept', path: 'index.html' });
    _pushCaptureForTests(sid, { type: 'route', stage: 'bridge-replied', path: 'js/game.js' });
    _pushCaptureForTests(sid, { type: 'route', stage: 'bridge-error', path: 'css/missing.css' });
    const all = getRouteLogs({ serverId: sid, lines: 100 });
    assert.equal(all.logs.length, 3);
    const onPath = getRouteLogs({ serverId: sid, search: 'css', lines: 100 });
    assert.equal(onPath.logs.length, 1);
    assert.equal(onPath.logs[0].path, 'css/missing.css');
    const onStage = getRouteLogs({ serverId: sid, search: 'error', lines: 100 });
    assert.equal(onStage.logs.length, 1);
    assert.equal(onStage.logs[0].stage, 'bridge-error');
});

test('preview_network filter=failed returns only !ok requests', () => {
    _resetForTests();
    const sid = 'srv_net';
    _pushCaptureForTests(sid, { type: 'network', path: 'index.html', ok: true,  status: 200, stage: 'bridge-replied' });
    _pushCaptureForTests(sid, { type: 'network', path: 'js/game.js', ok: true,  status: 200, stage: 'bridge-replied' });
    _pushCaptureForTests(sid, { type: 'network', path: 'css/missing.css', ok: false, status: 404, stage: 'bridge-error' });
    const all = getNetwork({ serverId: sid });
    assert.equal(all.requests.length, 3);
    const failed = getNetwork({ serverId: sid, filter: 'failed' });
    assert.equal(failed.requests.length, 1);
    assert.equal(failed.requests[0].path, 'css/missing.css');
    assert.equal(failed.requests[0].ok, false);
});

// ============================================
// Buffer cleanup on previewStop — github#39 sibling concern
// ============================================

test('previewStop drops capture buffers for that serverId', async () => {
    _resetForTests();
    const sid = 'srv_drop';
    _pushCaptureForTests(sid, { type: 'console', level: 'log', message: 'before' });
    _pushCaptureForTests(sid, { type: 'error', message: 'before' });
    _pushCaptureForTests(sid, { type: 'route', stage: 'fetch-intercept', path: '/' });
    _pushCaptureForTests(sid, { type: 'network', path: '/', ok: true, status: 200 });
    assert.equal(getConsoleLogs({ serverId: sid }).logs.length, 1);
    assert.equal(getErrors({ serverId: sid }).errors.length, 1);
    assert.equal(getRouteLogs({ serverId: sid }).logs.length, 1);
    assert.equal(getNetwork({ serverId: sid }).requests.length, 1);

    // previewStop reaches into the host's `previewStop` export; importing it
    // here keeps the Tier 1 import surface from this test minimal.
    const { previewStop } = await import('../js/preview/preview-host.js');
    await previewStop({ serverId: sid });

    assert.equal(getConsoleLogs({ serverId: sid }).logs.length, 0, 'console buffer dropped');
    assert.equal(getErrors({ serverId: sid }).errors.length, 0, 'error buffer dropped');
    assert.equal(getRouteLogs({ serverId: sid }).logs.length, 0, 'route buffer dropped');
    assert.equal(getNetwork({ serverId: sid }).requests.length, 0, 'network buffer dropped');
});

test('buffers are isolated by serverId — siblings do not bleed across', () => {
    _resetForTests();
    _pushCaptureForTests('srv_a', { type: 'console', level: 'log', message: 'a-only' });
    _pushCaptureForTests('srv_b', { type: 'console', level: 'log', message: 'b-only' });
    const a = getConsoleLogs({ serverId: 'srv_a' });
    const b = getConsoleLogs({ serverId: 'srv_b' });
    assert.equal(a.logs.length, 1);
    assert.equal(a.logs[0].message, 'a-only');
    assert.equal(b.logs.length, 1);
    assert.equal(b.logs[0].message, 'b-only');
});

// ============================================
// Empty-buffer behavior — return well-formed envelope
// ============================================

test('readers return well-formed empty envelopes for an unknown serverId', () => {
    _resetForTests();
    assert.deepEqual(getConsoleLogs({ serverId: 'srv_nope' }), { logs: [] });
    assert.deepEqual(getErrors({ serverId: 'srv_nope' }), { errors: [] });
    assert.deepEqual(getRouteLogs({ serverId: 'srv_nope' }), { logs: [] });
    assert.deepEqual(getNetwork({ serverId: 'srv_nope' }), { requests: [] });
});
