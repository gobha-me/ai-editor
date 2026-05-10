/**
 * Tests for `js/mcp/auto-test.js` — Settings-tab post-Save policy.
 *
 * Two pure helpers, two test groups:
 *   - `shouldAutoTest` decides whether to fire `testConnection`.
 *     Shape-of-input matrix: add vs. edit, enabled vs. disabled,
 *     URL/token/transport changed vs. label-only.
 *   - `formatTestResultToast` shapes the result toast. Defensive
 *     against missing `toolCount` / `error`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldAutoTest, formatTestResultToast } from '../js/mcp/auto-test.js';

const baseEnabled = {
    id: 'demo',
    label: 'Demo',
    url: 'https://mcp.example.com/mcp',
    token: '',
    transport: 'streamable-http',
    enabled: true,
};

// ---------- shouldAutoTest — adds ----------

test('shouldAutoTest: add of an enabled server returns true', () => {
    assert.equal(shouldAutoTest({ preSave: null, postSave: baseEnabled }), true);
});

test('shouldAutoTest: add of a disabled server returns false', () => {
    assert.equal(
        shouldAutoTest({ preSave: null, postSave: { ...baseEnabled, enabled: false } }),
        false
    );
});

test('shouldAutoTest: add with empty url returns false', () => {
    assert.equal(
        shouldAutoTest({ preSave: null, postSave: { ...baseEnabled, url: '' } }),
        false
    );
});

test('shouldAutoTest: undefined preSave is treated like null (add path)', () => {
    assert.equal(shouldAutoTest({ preSave: undefined, postSave: baseEnabled }), true);
});

// ---------- shouldAutoTest — edits ----------

test('shouldAutoTest: edit changing only the label returns false', () => {
    const preSave = { ...baseEnabled };
    const postSave = { ...baseEnabled, label: 'Renamed' };
    assert.equal(shouldAutoTest({ preSave, postSave }), false);
});

test('shouldAutoTest: edit changing the URL returns true', () => {
    const preSave = { ...baseEnabled };
    const postSave = { ...baseEnabled, url: 'https://mcp.example.com/v2' };
    assert.equal(shouldAutoTest({ preSave, postSave }), true);
});

test('shouldAutoTest: edit changing the token returns true', () => {
    const preSave = { ...baseEnabled, token: '' };
    const postSave = { ...baseEnabled, token: 'new-token' };
    assert.equal(shouldAutoTest({ preSave, postSave }), true);
});

test('shouldAutoTest: edit changing the transport returns true', () => {
    const preSave = { ...baseEnabled, transport: 'streamable-http' };
    const postSave = { ...baseEnabled, transport: 'sse' };
    assert.equal(shouldAutoTest({ preSave, postSave }), true);
});

test('shouldAutoTest: missing transport on either side defaults to streamable-http (no false positive)', () => {
    const preSave = { ...baseEnabled, transport: undefined };
    const postSave = { ...baseEnabled, transport: 'streamable-http' };
    assert.equal(shouldAutoTest({ preSave, postSave }), false);
});

test('shouldAutoTest: edit toggling disabled→enabled returns true (re-test on re-enable)', () => {
    const preSave = { ...baseEnabled, enabled: false };
    const postSave = { ...baseEnabled, enabled: true };
    assert.equal(shouldAutoTest({ preSave, postSave }), true);
});

test('shouldAutoTest: edit leaving enabled=false returns false', () => {
    const preSave = { ...baseEnabled, enabled: false };
    const postSave = { ...baseEnabled, enabled: false, label: 'Renamed disabled' };
    assert.equal(shouldAutoTest({ preSave, postSave }), false);
});

test('shouldAutoTest: edit toggling enabled→disabled returns false', () => {
    const preSave = { ...baseEnabled, enabled: true };
    const postSave = { ...baseEnabled, enabled: false };
    assert.equal(shouldAutoTest({ preSave, postSave }), false);
});

test('shouldAutoTest: token undefined on one side, "" on the other → no false positive', () => {
    const preSave = { ...baseEnabled, token: undefined };
    const postSave = { ...baseEnabled, token: '' };
    assert.equal(shouldAutoTest({ preSave, postSave }), false);
});

test('shouldAutoTest: malformed postSave returns false', () => {
    assert.equal(shouldAutoTest({ preSave: null, postSave: null }), false);
    assert.equal(shouldAutoTest({ preSave: null, postSave: 'string' }), false);
});

// ---------- formatTestResultToast ----------

test('formatTestResultToast: success with N tools', () => {
    const out = formatTestResultToast({
        label: 'Demo',
        result: { ok: true, toolCount: 7 },
    });
    assert.equal(out.kind, 'success');
    assert.match(out.message, /Demo/);
    assert.match(out.message, /7 tools/);
});

test('formatTestResultToast: success singular (1 tool)', () => {
    const out = formatTestResultToast({
        label: 'Demo',
        result: { ok: true, toolCount: 1 },
    });
    assert.equal(out.kind, 'success');
    assert.match(out.message, /1 tool advertised/);
});

test('formatTestResultToast: success with missing toolCount falls back to 0', () => {
    const out = formatTestResultToast({
        label: 'Demo',
        result: { ok: true },
    });
    assert.equal(out.kind, 'success');
    assert.match(out.message, /0 tools/);
});

test('formatTestResultToast: failure with explicit error string', () => {
    const out = formatTestResultToast({
        label: 'Demo',
        result: { ok: false, error: 'CORS blocked' },
    });
    assert.equal(out.kind, 'warning');
    assert.match(out.message, /Demo/);
    assert.match(out.message, /CORS blocked/);
    assert.match(out.message, /Edit the server to fix/);
});

test('formatTestResultToast: failure with missing error string defaults to "Connection failed"', () => {
    const out = formatTestResultToast({
        label: 'Demo',
        result: { ok: false },
    });
    assert.equal(out.kind, 'warning');
    assert.match(out.message, /Connection failed/);
});

test('formatTestResultToast: missing label defaults to "MCP server"', () => {
    const out = formatTestResultToast({
        label: '',
        result: { ok: true, toolCount: 3 },
    });
    assert.equal(out.kind, 'success');
    assert.match(out.message, /^✅ MCP server: connected/);
});

test('formatTestResultToast: null result envelope falls into warning path', () => {
    const out = formatTestResultToast({
        label: 'Demo',
        result: null,
    });
    assert.equal(out.kind, 'warning');
    assert.match(out.message, /Connection failed/);
});
