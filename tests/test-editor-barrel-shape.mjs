// @ts-check
/**
 * Anti-regression tests for the public-export shape of the editor barrel
 * (`js/editor.js`).
 *
 * Origin: `RE-EVAL following 2.64.0` ICD #9 code-aware finding #4 + open
 * invariant #7 — `refreshGhostText` was defined in `js/editor/instance.js`
 * but never re-exported from the barrel. The 2.65.0-era settings-persistence
 * callsite at `js/settings/persistence.js:92` calls
 * `m.refreshGhostText && m.refreshGhostText()` against the barrel module;
 * the `&&` short-circuit silently masked the missing export, so toggling
 * ghost-text settings never actually reconfigured the live editor. Adding
 * the barrel export activates that dormant call site.
 *
 * Idiom mirrors `tests/test-profile-registry-shape.mjs` (2.67.0) and
 * `tests/test-mcp-public-surface-shape.mjs` (2.63.0): `Object.keys(module).sort()`
 * deepEqual against an expected frozen list. Catches accidental future
 * addition / removal of any barrel export — a renamed editor operation
 * silently dropping from the barrel would otherwise surface only at
 * production call sites.
 *
 * Zero production-file edits in the test direction — `js/editor.js` stays
 * the source of truth for its own shape.
 *
 * @since 2.72.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as editorBarrel from '../js/editor.js';
import * as instanceModule from '../js/editor/instance.js';

// ----- headline pin: refreshGhostText reachable via barrel ----------------

test('editor barrel: refreshGhostText is exported and is a function', () => {
    assert.equal(
        typeof editorBarrel.refreshGhostText,
        'function',
        'js/editor.js must re-export refreshGhostText from ./editor/instance.js. ' +
        'The js/settings/persistence.js callsite guards on `m.refreshGhostText && ...` ' +
        'and the && silently masks the missing export — without this barrel entry, ' +
        'ghost-text settings changes never reconfigure the live editor.',
    );
});

test('editor barrel: refreshGhostText resolves to the same function as the source module', () => {
    assert.equal(
        editorBarrel.refreshGhostText,
        instanceModule.refreshGhostText,
        'Barrel re-export must be reference-equal to the source declaration; ' +
        'a wrapping or shadow would defeat the "barrel is the public surface" contract.',
    );
});

// ----- full barrel shape pin ----------------------------------------------

test('editor barrel: module-level export surface matches the expected sorted key list', () => {
    const keys = Object.keys(editorBarrel).sort();
    assert.deepEqual(keys, [
        'applyEdit',
        'computeSimpleDiff',
        'createEditor',
        'deleteRange',
        'editorInstance',
        'focus',
        'formatDiffForDisplay',
        'getContent',
        'getCursorContext',
        'getFileIcon',
        'getLineInfo',
        'getLineRange',
        'getSelection',
        'goToLine',
        'highlightRange',
        'insertAtCursor',
        'insertAtLine',
        'isBinaryFile',
        'isTextFile',
        'loadCodeMirror',
        'looksLikeText',
        'refreshGhostText',
        'replaceRange',
        'replaceSelection',
        'replaceText',
        'selectRange',
        'setContent',
        'setInvisibleUnicodeEnabled',
        'setKeybindingMode',
        'setLineNumbersVisible',
    ]);
});

// ----- per-instance-export reference equality (re-export integrity) -------
//
// Probe a representative subset (one per concern) — full coverage would
// re-list every export, which the shape pin above already does in name.
// This pin catches the inverse drift: a barrel that exports the right
// NAMES but accidentally rebinds them to a stale or wrapped value.

test('editor barrel: each instance.js re-export is reference-equal to the source', () => {
    for (const name of [
        'createEditor',
        'editorInstance',
        'applyEdit',
        'refreshGhostText',
        'setKeybindingMode',
        'setInvisibleUnicodeEnabled',
    ]) {
        assert.equal(
            editorBarrel[name],
            instanceModule[name],
            `editorBarrel.${name} must reference instance.js's ${name} directly`,
        );
    }
});
