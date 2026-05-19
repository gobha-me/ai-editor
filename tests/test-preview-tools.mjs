/**
 * Tests for In-editor preview & verify Tier 1 (1.22.0 — DESIGN-preview.md).
 *
 * Tier 1 tool registrations (`preview_start`, `preview_stop`, `preview_list`),
 * argument validation in handlers that don't depend on browser globals, and
 * the `resolvePreviewConfig` helper. Tier 2 capture readers (2.7.0 —
 * `preview_console_logs` / `preview_errors` / `preview_logs` /
 * `preview_network`) live in `tests/test-preview-tier2.mjs`. Service
 * Worker round-trip and iframe lifecycle are covered in the browser suite
 * (`tests/index.html`) — Node cannot register a real SW.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerPreviewTools } from '../js/tools/preview-tools.js';
import { resolvePreviewConfig } from '../js/profiles/resolve.js';
import { previewList, _resetForTests } from '../js/preview/preview-host.js';

// ============================================
// Tool registration shape
// ============================================

test('registerPreviewTools registers twelve tools (Tier 1 + Tier 2 + Tier 3a)', () => {
    const captured = [];
    const stub = {
        register(name, handler, definition) {
            captured.push({ name, handler, definition });
        },
    };
    registerPreviewTools(stub);
    assert.equal(captured.length, 12);
    const names = captured.map(c => c.name).sort();
    assert.deepEqual(names, [
        // Tier 1 (1.22.0)
        'preview_list', 'preview_start', 'preview_stop',
        // Tier 2 (2.7.0)
        'preview_console_logs', 'preview_errors', 'preview_logs', 'preview_network',
        // Tier 3a (2.10.0)
        'preview_snapshot', 'preview_click', 'preview_fill', 'preview_inspect', 'preview_resize',
    ].sort());
});

test('all twelve preview tools are readOnly + roles all', () => {
    const captured = [];
    const stub = { register(name, handler, definition) { captured.push({ name, definition }); } };
    registerPreviewTools(stub);
    for (const c of captured) {
        assert.equal(c.definition.readOnly, true, `${c.name} should be readOnly`);
        assert.equal(c.definition.type, 'function');
        assert.equal(c.definition.function.name, c.name);
        assert.ok(c.definition.function.description, `${c.name} has a description`);
        assert.ok(c.definition.function.parameters, `${c.name} has parameters`);
    }
});

test('preview_start parameters: optional path', () => {
    let captured;
    const stub = { register(name, handler, definition) {
        if (name === 'preview_start') captured = definition;
    } };
    registerPreviewTools(stub);
    const params = captured.function.parameters;
    assert.equal(params.type, 'object');
    assert.deepEqual(params.required, []);
    assert.equal(params.properties.path.type, 'string');
});

test('preview_stop parameters: required serverId', () => {
    let captured;
    const stub = { register(name, handler, definition) {
        if (name === 'preview_stop') captured = definition;
    } };
    registerPreviewTools(stub);
    const params = captured.function.parameters;
    assert.deepEqual(params.required, ['serverId']);
    assert.equal(params.properties.serverId.type, 'string');
});

test('preview_list parameters: no required args', () => {
    let captured;
    const stub = { register(name, handler, definition) {
        if (name === 'preview_list') captured = definition;
    } };
    registerPreviewTools(stub);
    const params = captured.function.parameters;
    assert.deepEqual(params.required, []);
    assert.deepEqual(params.properties, {});
});

// ============================================
// Argument validation (handler invocation that doesn't require DOM)
// ============================================

test('preview_stop handler rejects missing serverId', async () => {
    let stopHandler;
    const stub = { register(name, handler) {
        if (name === 'preview_stop') stopHandler = handler;
    } };
    registerPreviewTools(stub);
    const r1 = await stopHandler(null);
    assert.ok(r1.error, 'null args rejected');
    const r2 = await stopHandler({});
    assert.ok(r2.error, 'empty object rejected');
    const r3 = await stopHandler({ serverId: '   ' });
    assert.ok(r3.error, 'whitespace-only serverId rejected');
    const r4 = await stopHandler({ serverId: 42 });
    assert.ok(r4.error, 'non-string serverId rejected');
});

test('preview_list handler returns empty registry when nothing started', async () => {
    let listHandler;
    const stub = { register(name, handler) {
        if (name === 'preview_list') listHandler = handler;
    } };
    registerPreviewTools(stub);
    _resetForTests();
    const result = await listHandler({});
    assert.ok(Array.isArray(result.servers));
    assert.equal(result.servers.length, 0);
});

test('preview_stop on unknown serverId is idempotent (returns stopped:true, no error)', async () => {
    let stopHandler;
    const stub = { register(name, handler) {
        if (name === 'preview_stop') stopHandler = handler;
    } };
    registerPreviewTools(stub);
    _resetForTests();
    const r = await stopHandler({ serverId: 'srv_doesnotexist' });
    assert.equal(r.stopped, true);
    assert.equal(r.error, undefined);
});

// ============================================
// Direct previewList shape
// ============================================

test('previewList returns {servers: []} when registry is empty', () => {
    _resetForTests();
    const out = previewList();
    assert.ok(out && typeof out === 'object');
    assert.ok(Array.isArray(out.servers));
    assert.equal(out.servers.length, 0);
});

// ============================================
// resolvePreviewConfig — coder enables, others disable
// ============================================

test('resolvePreviewConfig returns coder.v1 default (enabled) for coder.v1', () => {
    // 2.0.0 — slice 3: takes profile name, not role.
    const cfg = resolvePreviewConfig('coder.v1');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.profileName, 'coder.v1');
});

test('resolvePreviewConfig returns disabled with leaf profileName for registered non-coder profiles', () => {
    // 2.68.0 (ICD #8 finding #1) — resolver no longer short-circuits;
    // the inheritance walk preserves the leaf name. Pre-2.68.0 every
    // non-coder branch returned `profileName: 'chat.v1'` (the short-
    // circuit's `: CHAT_V1` mislabel).
    for (const profileName of ['chat.v1', 'reviewer.v1', 'pm.v1', 'plugin-dev.v1', 'full.v1']) {
        const cfg = resolvePreviewConfig(profileName);
        assert.equal(cfg.enabled, false, `profile ${JSON.stringify(profileName)} disabled by default`);
        assert.equal(cfg.profileName, profileName, `${profileName} preserves leaf name`);
    }
});

test('resolvePreviewConfig falls back to chat.v1 for null/undefined/empty/unregistered', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        for (const profileName of [null, undefined, '', 'unknown']) {
            const cfg = resolvePreviewConfig(profileName);
            assert.equal(cfg.enabled, false, `arg ${JSON.stringify(profileName)} disabled`);
            assert.equal(cfg.profileName, 'chat.v1');
        }
    } finally {
        console.warn = origWarn;
    }
});
