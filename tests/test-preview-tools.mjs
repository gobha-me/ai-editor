/**
 * Tests for In-editor preview & verify Tier 1 (1.22.0 — DESIGN-preview.md).
 *
 * Exercises the registration shape of the three preview tools, argument
 * validation in handlers that don't depend on browser globals, and the
 * `resolvePreviewConfig` helper. The Service Worker round-trip and
 * iframe lifecycle are covered in the browser suite (tests/index.html)
 * — Node cannot register a real SW.
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

test('registerPreviewTools registers three tools', () => {
    const captured = [];
    const stub = {
        register(name, handler, definition) {
            captured.push({ name, handler, definition });
        },
    };
    registerPreviewTools(stub);
    assert.equal(captured.length, 3);
    const names = captured.map(c => c.name).sort();
    assert.deepEqual(names, ['preview_list', 'preview_start', 'preview_stop']);
});

test('all three preview tools are readOnly + roles all', () => {
    const captured = [];
    const stub = { register(name, handler, definition) { captured.push({ name, definition }); } };
    registerPreviewTools(stub);
    for (const c of captured) {
        assert.equal(c.definition.readOnly, true, `${c.name} should be readOnly`);
        assert.equal(c.definition.roles, 'all', `${c.name} should have roles 'all'`);
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

test('resolvePreviewConfig returns chat.v1 default (disabled) for non-coder profiles', () => {
    for (const profileName of [null, undefined, '', 'chat.v1', 'reviewer.v1', 'pm.v1', 'plugin-dev.v1', 'full.v1', 'unknown']) {
        const cfg = resolvePreviewConfig(profileName);
        assert.equal(cfg.enabled, false, `profile ${JSON.stringify(profileName)} disabled by default`);
        assert.equal(cfg.profileName, 'chat.v1');
    }
});
