/**
 * Tests for js/utils/compression-flag.js — URL-flag reader for the
 * Tier 2 dual-session A/B (Decision §8 measurement-before-scale gate).
 *
 * Stubs `window.location.search` to exercise URL fixtures; the real
 * browser-side console.log is checked by visual inspection during the
 * deployed-instance dual-session run.
 *
 * @since 1.3.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isCompressionDisabled,
    _resetCacheForTests,
} from '../js/utils/compression-flag.js';

// ============================================
// helpers
// ============================================

let _origLocation;

function setSearch(search) {
    if (_origLocation === undefined) {
        _origLocation = globalThis.window.location;
    }
    globalThis.window.location = { search };
    _resetCacheForTests();
}

function clearSearch() {
    if (_origLocation === undefined) {
        _origLocation = globalThis.window.location;
    }
    globalThis.window.location = undefined;
    _resetCacheForTests();
}

function restore() {
    if (_origLocation !== undefined) {
        globalThis.window.location = _origLocation;
    }
    _resetCacheForTests();
}

// Silence the boot console.log so the test reporter stays readable.
// Restored after each fixture.
const _origLog = console.log;
function muteLog() { console.log = () => {}; }
function unmuteLog() { console.log = _origLog; }

// ============================================
// no flag → false
// ============================================

test('no search string → not disabled', () => {
    setSearch('');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }
});

test('unrelated query params → not disabled', () => {
    setSearch('?theme=dark&debug=1');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }
});

test('compression set but value not a disable token → not disabled', () => {
    setSearch('?compression=on');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }

    setSearch('?compression=true');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }

    setSearch('?compression=1');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }
});

// ============================================
// flag set → true
// ============================================

test('?compression=off → disabled', () => {
    setSearch('?compression=off');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

test('?compression=false → disabled', () => {
    setSearch('?compression=false');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

test('?compression=0 → disabled', () => {
    setSearch('?compression=0');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

test('?compression=disabled → disabled', () => {
    setSearch('?compression=disabled');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

test('case-insensitive match — ?compression=OFF → disabled', () => {
    setSearch('?compression=OFF');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

test('whitespace tolerated — ?compression=%20off%20 → disabled', () => {
    setSearch('?compression=%20off%20');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

test('flag set alongside other params — ?theme=dark&compression=off&debug=1 → disabled', () => {
    setSearch('?theme=dark&compression=off&debug=1');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
    } finally {
        unmuteLog();
        restore();
    }
});

// ============================================
// caching — read once per session
// ============================================

test('cached on first call — subsequent calls return the same value even if URL changes', () => {
    setSearch('?compression=off');
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), true);
        // Mutate URL after first call — flag should NOT update.
        globalThis.window.location = { search: '?compression=on' };
        assert.equal(isCompressionDisabled(), true, 'cached value sticks even after URL change');
    } finally {
        unmuteLog();
        restore();
    }
});

test('boot console.log fires exactly once on first detection', () => {
    setSearch('?compression=off');
    let calls = 0;
    const origLog = console.log;
    console.log = () => { calls += 1; };
    try {
        isCompressionDisabled();
        isCompressionDisabled();
        isCompressionDisabled();
        assert.equal(calls, 1, 'console.log fires exactly once across multiple calls');
    } finally {
        console.log = origLog;
        restore();
    }
});

test('boot console.log does NOT fire when flag is absent', () => {
    setSearch('?theme=dark');
    let calls = 0;
    const origLog = console.log;
    console.log = () => { calls += 1; };
    try {
        isCompressionDisabled();
        isCompressionDisabled();
        assert.equal(calls, 0, 'no log when flag is absent');
    } finally {
        console.log = origLog;
        restore();
    }
});

// ============================================
// SSR / no-window safety
// ============================================

test('window.location undefined → not disabled (no throw)', () => {
    clearSearch();
    muteLog();
    try {
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }
});

test('malformed search string does not throw', () => {
    setSearch('garbage that is not a query string');
    muteLog();
    try {
        // Should not throw; should default to false.
        assert.doesNotThrow(() => isCompressionDisabled());
        assert.equal(isCompressionDisabled(), false);
    } finally {
        unmuteLog();
        restore();
    }
});
