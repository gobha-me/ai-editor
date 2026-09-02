/**
 * Tests for `catalogEntryToStarter` in `js/mcp/catalog.js` — the pure helper
 * that converts a catalog entry into the starter shape consumed by
 * `showServerEditor(null, starter)` in `js/settings/mcp-servers-tab.js`.
 *
 * Pure-function tests; no DOM. The invariants here are load-bearing — most
 * notably "token is always empty" so we never pre-fill secrets — and the test
 * is the place that catches a regression if the helper drifts.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogEntryToStarter, MCP_CATALOG } from '../js/mcp/catalog.js';

test('starter contains label, url, transport, token, enabled, roles', () => {
    const starter = catalogEntryToStarter({
        id: 'foo',
        name: 'Foo',
        url: 'https://mcp.foo/mcp',
        transport: 'streamable-http',
    });
    assert.ok(starter);
    for (const k of ['label', 'url', 'transport', 'token', 'enabled', 'roles']) {
        assert.ok(k in starter, `starter missing key "${k}"`);
    }
});

test('starter.token is always "" (never pre-fill secrets)', () => {
    for (const e of MCP_CATALOG) {
        const starter = catalogEntryToStarter(e);
        assert.equal(starter.token, '', `${e.id}: token must be empty, got "${starter.token}"`);
    }
});

test('starter.label mirrors entry.name (drives the editor Label field)', () => {
    const starter = catalogEntryToStarter({ id: 'x', name: 'My Server', url: 'https://x/mcp', transport: 'streamable-http' });
    assert.equal(starter.label, 'My Server');
});

test('starter.url preserves {placeholder} segments verbatim', () => {
    const starter = catalogEntryToStarter({
        id: 'fc',
        name: 'FC',
        url: 'https://mcp.foo/{API_KEY}/v2/mcp',
        transport: 'streamable-http',
    });
    assert.equal(starter.url, 'https://mcp.foo/{API_KEY}/v2/mcp');
});

test('unsupported or missing transports are rejected instead of coerced', () => {
    assert.equal(catalogEntryToStarter({ id: 'x', name: 'X', url: 'https://x/mcp', transport: 'mystery' }), null);
    assert.equal(catalogEntryToStarter({ id: 'x', name: 'X', url: 'https://x/sse', transport: 'sse' }), null);
    assert.equal(catalogEntryToStarter({ id: 'x', name: 'X', url: 'https://x/mcp' }), null);
});

test('starter.enabled defaults to true', () => {
    const starter = catalogEntryToStarter({ id: 'x', name: 'X', url: 'https://x/mcp', transport: 'streamable-http' });
    assert.equal(starter.enabled, true);
});

test('starter.roles defaults to "all"', () => {
    const starter = catalogEntryToStarter({ id: 'x', name: 'X', url: 'https://x/mcp', transport: 'streamable-http' });
    assert.equal(starter.roles, 'all');
});

test('null / undefined / non-object input returns null', () => {
    assert.equal(catalogEntryToStarter(null), null);
    assert.equal(catalogEntryToStarter(undefined), null);
    assert.equal(catalogEntryToStarter('not an object'), null);
    assert.equal(catalogEntryToStarter(42), null);
});

test('every shipped catalog entry produces a valid starter (round-trip smoke)', () => {
    for (const e of MCP_CATALOG) {
        const starter = catalogEntryToStarter(e);
        assert.ok(starter, `${e.id}: catalogEntryToStarter returned null`);
        assert.equal(typeof starter.label, 'string');
        assert.equal(typeof starter.url, 'string');
        assert.equal(starter.token, '');
        assert.equal(starter.transport, 'streamable-http');
        assert.equal(starter.enabled, true);
        assert.equal(starter.roles, 'all');
    }
});
