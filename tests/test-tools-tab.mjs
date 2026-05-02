/**
 * Settings → Tools tab tests (1.4.8).
 *
 * Pure-data assertions: defaults, persistence shape, workspace-settings
 * safelist coverage, and that the embedding-side tuning readers honor the
 * persisted subtree. The tab's HTML rendering is browser-only and not
 * exercised here.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State, EventBus } from '../js/core.js';
import { __test__ as tab } from '../js/settings/tools-tab.js';
import { isSafelisted } from '../js/intelligence/workspace-settings/safelist.js';
import {
    DEFAULT_THRESHOLD,
    DEFAULT_TOP_K,
    DISCOVERY_ADMISSION_CAP,
    _readTopK,
    _readDiscoveryCap,
} from '../js/intelligence/tools/embeddings.js';

const { _read, _persist, TOOLS_DEFAULTS } = tab;

/* ---------------- Defaults ---------------- */

test('TOOLS_DEFAULTS is frozen', () => {
    assert.equal(Object.isFrozen(TOOLS_DEFAULTS), true);
});

test('TOOLS_DEFAULTS mirrors embeddings.js constants', () => {
    assert.deepEqual(TOOLS_DEFAULTS, {
        findToolThreshold: DEFAULT_THRESHOLD,
        findToolTopK: DEFAULT_TOP_K,
        discoveryAdmissionCap: DISCOVERY_ADMISSION_CAP,
    });
});

test('_read returns defaults when settings.tools missing', () => {
    const prev = State.settings.tools;
    State.settings.tools = undefined;
    try {
        const r = _read();
        assert.deepEqual(r, TOOLS_DEFAULTS);
    } finally { State.settings.tools = prev; }
});

test('_read merges configured values over defaults', () => {
    const prev = State.settings.tools;
    State.settings.tools = { findToolThreshold: 0.6, findToolTopK: 12 };
    try {
        const r = _read();
        assert.equal(r.findToolThreshold, 0.6);
        assert.equal(r.findToolTopK, 12);
        assert.equal(r.discoveryAdmissionCap, TOOLS_DEFAULTS.discoveryAdmissionCap);
    } finally { State.settings.tools = prev; }
});

test('_read clamps out-of-range threshold back to default', () => {
    const prev = State.settings.tools;
    State.settings.tools = { findToolThreshold: 1.5 };       // > 1
    try { assert.equal(_read().findToolThreshold, TOOLS_DEFAULTS.findToolThreshold); }
    finally { State.settings.tools = prev; }
});

test('_read clamps non-integer topK / cap back to default', () => {
    const prev = State.settings.tools;
    State.settings.tools = { findToolTopK: 0, discoveryAdmissionCap: 99 };
    try {
        const r = _read();
        assert.equal(r.findToolTopK, TOOLS_DEFAULTS.findToolTopK);
        assert.equal(r.discoveryAdmissionCap, TOOLS_DEFAULTS.discoveryAdmissionCap);
    } finally { State.settings.tools = prev; }
});

/* ---------------- Persistence ---------------- */

test('_persist creates settings.tools if absent + emits settings:changed', () => {
    const prev = State.settings.tools;
    State.settings.tools = undefined;
    let emitted = null;
    const off = EventBus.on('settings:changed', (e) => { emitted = e; });
    try {
        _persist({ findToolThreshold: 0.55 });
        assert.deepEqual(State.settings.tools, { findToolThreshold: 0.55 });
        assert.ok(emitted);
        assert.equal(emitted.section, 'tools');
    } finally {
        State.settings.tools = prev;
        if (typeof off === 'function') off();
    }
});

test('_persist preserves untouched keys', () => {
    const prev = State.settings.tools;
    State.settings.tools = { findToolThreshold: 0.6, findToolTopK: 12 };
    try {
        _persist({ findToolTopK: 4 });
        assert.equal(State.settings.tools.findToolThreshold, 0.6);
        assert.equal(State.settings.tools.findToolTopK, 4);
    } finally { State.settings.tools = prev; }
});

/* ---------------- Embeddings-side readers honor the same subtree ---------------- */

test('_readTopK reads State.settings.tools.findToolTopK', () => {
    const prev = State.settings.tools;
    State.settings.tools = { findToolTopK: 11 };
    try { assert.equal(_readTopK(), 11); }
    finally { State.settings.tools = prev; }
});

test('_readTopK falls back to DEFAULT_TOP_K when missing', () => {
    const prev = State.settings.tools;
    State.settings.tools = undefined;
    try { assert.equal(_readTopK(), DEFAULT_TOP_K); }
    finally { State.settings.tools = prev; }
});

test('_readTopK rejects out-of-range and falls back to default', () => {
    const prev = State.settings.tools;
    State.settings.tools = { findToolTopK: 100 };       // > 25
    try { assert.equal(_readTopK(), DEFAULT_TOP_K); }
    finally { State.settings.tools = prev; }
});

test('_readDiscoveryCap reads State.settings.tools.discoveryAdmissionCap', () => {
    const prev = State.settings.tools;
    State.settings.tools = { discoveryAdmissionCap: 5 };
    try { assert.equal(_readDiscoveryCap(), 5); }
    finally { State.settings.tools = prev; }
});

test('_readDiscoveryCap falls back to DISCOVERY_ADMISSION_CAP when missing', () => {
    const prev = State.settings.tools;
    State.settings.tools = undefined;
    try { assert.equal(_readDiscoveryCap(), DISCOVERY_ADMISSION_CAP); }
    finally { State.settings.tools = prev; }
});

/* ---------------- Workspace-settings safelist coverage ---------------- */

test('tools key is on the workspace-settings safelist', () => {
    assert.equal(isSafelisted('tools'), true);
});
