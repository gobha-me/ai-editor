/**
 * Tests for the shared CI status visual + textual metadata registry.
 *
 * **2.38.0 (2026-Q2 audit sweep)** — pre-2.38.0 the same 5-key axis
 * (`success / pending / failure / error / unknown`) lived as two
 * independent maps: `CI_ICONS` (emoji-only) in `js/ui/pr-list.js` and
 * `CI_STATE_LABEL` (`{label, cls}`) in `js/pr-review/PrReviewSurface.js`.
 * Adding a new status had to land in both places; the audit flagged the
 * drift hazard.
 *
 * `CI_STATUS_META` + `getCiStatusMeta` now sit at `js/ui/icons.js` as a
 * single source. The byte-equivalence guards below pin the composed
 * `'${emoji} ${text}'` against the pre-2.38.0 label strings and the
 * `emoji` against the pre-2.38.0 icon glyphs so the migration cannot
 * silently change what the user sees in either surface.
 *
 * Pure-logic — runs under `node --test` via `_node-shim.mjs`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CI_STATUS_META, getCiStatusMeta } from '../js/ui/icons.js';

// Pre-2.38.0 snapshots — pinned here to detect drift.
const LEGACY_CI_ICONS = {
    success: '✅',
    pending: '🔄',
    failure: '❌',
    error: '❌',
    unknown: '⚪',
};

const LEGACY_CI_STATE_LABELS = {
    success: '✅ passing',
    pending: '🔄 running',
    failure: '❌ failing',
    error: '❌ error',
    unknown: '⚪ no checks',
};

const LEGACY_CI_STATE_CLASSES = {
    success: 'pr__ci-badge--ok',
    pending: 'pr__ci-badge--pending',
    failure: 'pr__ci-badge--fail',
    error: 'pr__ci-badge--fail',
    unknown: 'pr__ci-badge--unknown',
};

// ============================================
// Shape
// ============================================

test('CI_STATUS_META — frozen', () => {
    assert.equal(Object.isFrozen(CI_STATUS_META), true);
});

test('CI_STATUS_META — exactly the 5 expected keys', () => {
    assert.deepEqual(
        Object.keys(CI_STATUS_META).sort(),
        ['error', 'failure', 'pending', 'success', 'unknown']
    );
});

test('CI_STATUS_META — every entry has non-empty {emoji, text, cls}', () => {
    for (const [key, meta] of Object.entries(CI_STATUS_META)) {
        assert.equal(typeof meta.emoji, 'string', `${key}.emoji should be string`);
        assert.ok(meta.emoji.length > 0, `${key}.emoji should be non-empty`);
        assert.equal(typeof meta.text, 'string', `${key}.text should be string`);
        assert.ok(meta.text.length > 0, `${key}.text should be non-empty`);
        assert.equal(typeof meta.cls, 'string', `${key}.cls should be string`);
        assert.ok(meta.cls.length > 0, `${key}.cls should be non-empty`);
    }
});

// ============================================
// getCiStatusMeta — lookup + fallback
// ============================================

test('getCiStatusMeta — known state returns its own entry', () => {
    assert.equal(getCiStatusMeta('success'), CI_STATUS_META.success);
    assert.equal(getCiStatusMeta('pending'), CI_STATUS_META.pending);
    assert.equal(getCiStatusMeta('failure'), CI_STATUS_META.failure);
    assert.equal(getCiStatusMeta('error'),   CI_STATUS_META.error);
    assert.equal(getCiStatusMeta('unknown'), CI_STATUS_META.unknown);
});

test('getCiStatusMeta — unknown / missing / null / undefined fall back to unknown', () => {
    assert.equal(getCiStatusMeta('garbage'),  CI_STATUS_META.unknown);
    assert.equal(getCiStatusMeta(''),         CI_STATUS_META.unknown);
    assert.equal(getCiStatusMeta(null),       CI_STATUS_META.unknown);
    assert.equal(getCiStatusMeta(undefined),  CI_STATUS_META.unknown);
});

// ============================================
// Byte-equivalence guards — pre-2.38.0 strings
// ============================================

test('byte-equivalence — emoji matches pre-2.38.0 CI_ICONS for every state', () => {
    for (const [state, legacyEmoji] of Object.entries(LEGACY_CI_ICONS)) {
        assert.equal(
            getCiStatusMeta(state).emoji,
            legacyEmoji,
            `emoji drift for state="${state}"`
        );
    }
});

test('byte-equivalence — `${emoji} ${text}` matches pre-2.38.0 CI_STATE_LABEL.label for every state', () => {
    for (const [state, legacyLabel] of Object.entries(LEGACY_CI_STATE_LABELS)) {
        const m = getCiStatusMeta(state);
        assert.equal(
            `${m.emoji} ${m.text}`,
            legacyLabel,
            `composed label drift for state="${state}"`
        );
    }
});

test('byte-equivalence — cls matches pre-2.38.0 CI_STATE_LABEL.cls for every state', () => {
    for (const [state, legacyCls] of Object.entries(LEGACY_CI_STATE_CLASSES)) {
        assert.equal(
            getCiStatusMeta(state).cls,
            legacyCls,
            `cls drift for state="${state}"`
        );
    }
});
