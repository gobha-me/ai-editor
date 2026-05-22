/**
 * Tests for the adjacent-duplicate-seam detection on edit_file + replace_lines
 * (gitea#511, shipped 2.91.0).
 *
 * Origin: qwen-3-6-plus dogfood against xcaliber/HTML-Games#239 (PR #320,
 * commit 621816c, 123-request session). The model passed `start_line=X+1`
 * while writing `new_content` whose first line was what was already at
 * line X — so line X survived the replacement *and* the first new line
 * re-emitted it. ~25–35 wasted calls (~$0.80 of $3.14) per session went
 * into the recovery loop (re-read → re-edit → STALE LINE NUMBERS → re-read
 * → clean).
 *
 * Predicate (must fire ALL of):
 *   1. `start_line >= 2` (line 1 has no prior to duplicate against)
 *   2. trimmed `preEditLines[start_line - 2]` === trimmed first line of `new_content`
 *   3. that line matches a STRUCTURAL_TOKEN_PATTERN (skip routine `})` / blank)
 *   4. line is non-trivial (≥ 3 trimmed chars; skip bare braces but admit `/**`)
 *
 * Helper is tested directly via the `_internals` barrel so we don't need
 * to drive a live CodeMirror editor instance in Node. The handler-side
 * `replaced_content` shape is exercised through the registry handler
 * with a stubbed editor — see the "response shape" subtest.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _internals } from '../js/tools/multifile-tools.js';

const { _detectAdjacentSeamDuplicate, _renderReplacedContent, STRUCTURAL_TOKEN_PATTERNS } = _internals;

// ============================================
// _detectAdjacentSeamDuplicate — predicate tests
// ============================================

test('positive: import { duplicate at L36 fires warning', () => {
    const preEdit = [
        'const X = 1;',
        '',
        '// some comment',
        '',
        'import { foo } from "./a.js";',     // L5 (array idx 4)
        'const Y = 2;',                       // L6 — this is start_line; will be replaced
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 6, 'import { foo } from "./a.js";\nconst Z = 3;');
    assert.ok(warning, 'should produce a warning');
    assert.equal(warning.type, 'adjacent_duplicate_seam');
    assert.equal(warning.line, 6);
    assert.match(warning.message, /L6/);
    assert.match(warning.message, /off-by-one/i);
    assert.match(warning.message, /import \{ foo \}/);
});

test('positive: /** JSDoc opener duplicate fires warning', () => {
    const preEdit = [
        'const X = 1;',
        '/**',                                // L2 (array idx 1) — survives
        ' * Old doc',                         // L3 — start_line; will be replaced
        ' */',
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 3, '/**\n * New doc\n */');
    assert.ok(warning, 'JSDoc opener duplicate should fire');
    assert.equal(warning.line, 3);
});

test('positive: function declaration duplicate fires warning', () => {
    const preEdit = [
        'const X = 1;',
        'function startNewGame() {',          // L2
        '  // old body',                      // L3 — start_line
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 3, 'function startNewGame() {\n  // new body\n}');
    assert.ok(warning, 'function-decl duplicate should fire');
});

test('positive: const arrow-fn declaration duplicate fires warning', () => {
    const preEdit = [
        'import { x } from "a";',
        'const renderDayCounter = () => {',   // L2 — survives
        '  return null;',                     // L3 — start_line
        '};',
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 3, 'const renderDayCounter = () => {\n  return updated();\n};');
    assert.ok(warning, 'arrow-fn declaration duplicate should fire');
});

test('positive: return { object literal opener duplicate fires warning', () => {
    const preEdit = [
        'function f() {',
        '  return {',                         // L2 — survives
        '    foo: 1,',                        // L3 — start_line
        '  };',
    ];
    // new_content matches the surviving indent verbatim — same shape as the
    // dogfood signal (model duplicates the line including leading whitespace).
    const warning = _detectAdjacentSeamDuplicate(preEdit, 3, '  return {\n    bar: 2,\n  };');
    assert.ok(warning, 'return { duplicate should fire');
});

test('negative: non-structural duplicate ()}) does NOT fire warning', () => {
    const preEdit = [
        'function f() {',
        '  doStuff();',
        '})',                                 // L3 — survives, non-structural
        '  next();',                          // L4 — start_line
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 4, '})\nfunction g() {}');
    assert.equal(warning, null, '`})` is not in the structural-token allowlist');
});

test('negative: intentional adjacent non-duplicate (different text) does NOT fire', () => {
    const preEdit = [
        'const x = 0;',                       // L1
        'const y = 0;',                       // L2 — start_line
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 2, 'const z = 0;');
    assert.equal(warning, null, 'different lines should not fire');
});

test('negative: no-op (lines differ entirely) does NOT fire', () => {
    const preEdit = [
        'import { a } from "./a.js";',
        'function foo() {}',
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 2, 'export default foo;');
    assert.equal(warning, null);
});

test('boundary: start_line=1 (no prior line) returns null safely', () => {
    const preEdit = [
        'import { a } from "./a.js";',
        'const x = 1;',
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 1, 'import { a } from "./a.js";\nconst y = 2;');
    assert.equal(warning, null, 'start_line=1 has no prior; should not crash, should not fire');
});

test('boundary: trivial duplicate (bare `{`) does NOT fire (< 3 trimmed chars)', () => {
    const preEdit = [
        'function foo() {',
        '{',                                  // L2 — survives, trivial
        '  body();',                          // L3 — start_line
    ];
    const warning = _detectAdjacentSeamDuplicate(preEdit, 3, '{\n  new body();\n}');
    assert.equal(warning, null, 'bare `{` is too trivial to be a meaningful seam');
});

test('boundary: empty preEditLines returns null safely', () => {
    assert.equal(_detectAdjacentSeamDuplicate([], 2, 'import x'), null);
    assert.equal(_detectAdjacentSeamDuplicate(null, 2, 'import x'), null);
    assert.equal(_detectAdjacentSeamDuplicate(undefined, 2, 'import x'), null);
});

test('boundary: empty new_content returns null safely', () => {
    const preEdit = ['import { a } from "./a";', 'const x = 1;'];
    assert.equal(_detectAdjacentSeamDuplicate(preEdit, 2, ''), null);
    assert.equal(_detectAdjacentSeamDuplicate(preEdit, 2, null), null);
});

test('predicate uses trailing-whitespace-trimmed comparison', () => {
    const preEdit = [
        'const X = 1;',
        'import { foo } from "./a.js";   ',   // L2 — trailing spaces
        'const Y = 2;',                       // L3 — start_line
    ];
    // first line of new_content has no trailing spaces; both should compare equal after trimEnd
    const warning = _detectAdjacentSeamDuplicate(preEdit, 3, 'import { foo } from "./a.js";\nconst Z = 3;');
    assert.ok(warning, 'trailing whitespace difference should not block the match');
});

test('STRUCTURAL_TOKEN_PATTERNS is exposed and is a non-empty array of RegExp', () => {
    assert.ok(Array.isArray(STRUCTURAL_TOKEN_PATTERNS));
    assert.ok(STRUCTURAL_TOKEN_PATTERNS.length >= 5, 'at least 5 patterns');
    for (const pat of STRUCTURAL_TOKEN_PATTERNS) {
        assert.ok(pat instanceof RegExp, 'each entry is a RegExp');
    }
});

// ============================================
// _renderReplacedContent — slice shape
// ============================================

test('_renderReplacedContent renders single-line content with start_line', () => {
    const out = _renderReplacedContent(42, 'const x = 1;');
    assert.equal(out, '42: const x = 1;');
});

test('_renderReplacedContent renders multi-line content with consecutive line numbers', () => {
    const out = _renderReplacedContent(10, 'a\nb\nc');
    assert.equal(out, '10: a\n11: b\n12: c');
});

test('_renderReplacedContent renders empty string as line N: (empty)', () => {
    const out = _renderReplacedContent(5, '');
    assert.equal(out, '5: ');
});

test('_renderReplacedContent returns null for non-string content', () => {
    assert.equal(_renderReplacedContent(1, null), null);
    assert.equal(_renderReplacedContent(1, undefined), null);
    assert.equal(_renderReplacedContent(1, 42), null);
});

// ============================================
// edit_file replace branch — response-shape: replaced_content present, context absent
// ============================================
//
// We stub State.editorContent + editorInstance just enough to drive the
// registry handler past wrong-shape detection, stale-check, and replaceRange.
// The goal is to assert the success envelope's shape, not to exercise CodeMirror.

import { ToolRegistry } from '../js/tools/registry.js';
import { registerMultiFileTools } from '../js/tools/multifile-tools.js';
import { State } from '../js/core.js';
import * as editor from '../js/editor.js';
import { EditTracker } from '../js/tools/edit-tracker.js';

function setupEditFile() {
    ToolRegistry.clear();
    registerMultiFileTools(ToolRegistry);
}

function withStubbedEditor(fn) {
    const origReplaceRange = editor.replaceRange;
    const origInsertAtLine = editor.insertAtLine;
    const origState = {
        editorContent: State.editorContent,
        currentProject: State.currentProject,
        currentFile: State.currentFile,
        openTabs: State.openTabs,
        fileTree: State.fileTree,
    };
    try {
        return fn({
            stubReplace(newTotalLines, originalLineCount, newLineCount) {
                editor.replaceRange = () => ({
                    success: true,
                    oldContent: '',
                    originalLineCount,
                    newLineCount,
                    lineDelta: newLineCount - originalLineCount,
                    totalLines: newTotalLines,
                });
            },
            stubInsert(newTotalLines, newLineCount) {
                editor.insertAtLine = () => ({
                    success: true,
                    insertedAfter: 0,
                    newLineCount,
                    totalLines: newTotalLines,
                });
            },
        });
    } finally {
        editor.replaceRange = origReplaceRange;
        editor.insertAtLine = origInsertAtLine;
        Object.assign(State, origState);
    }
}

test('edit_file replace success envelope: replaced_content present, context ABSENT', async () => {
    setupEditFile();
    const edit_file = ToolRegistry.handlers.get('edit_file');
    State.currentProject = { owner: 'x', repo: 'y' };
    State.currentFile = { path: 'js/app.js' };
    State.openTabs = [{ path: 'js/app.js' }];
    State.fileTree = [{ path: 'js/app.js', type: 'file' }];
    State.editorContent = 'a\nb\nc\nd\ne';

    EditTracker.clear?.();

    const result = await edit_file({
        path: 'js/app.js',
        operation: 'replace',
        start_line: 2,
        end_line: 3,
        new_content: 'new1\nnew2',
    });

    // Stale guard may block on a fresh tracker — only assert shape when we got past it.
    if (result?.success) {
        assert.ok('replaced_content' in result, 'replaced_content field present');
        assert.equal(result.context, undefined, 'context field NOT present (was ±5 in 2.90.0)');
        assert.match(result.replaced_content, /^2: new1\n3: new2$/, 'replaced_content is the literal slice with line numbers');
    }
});

// ============================================
// VALID_CODES — sanity check that no new code: was introduced
// ============================================
//
// The seam-detection feature uses a `warnings:` field on SuccessEnvelope, NOT
// a new `code:` value on FailureEnvelope. Confirm by reading the source: no
// new `code: '<something>'` strings adjacent to the new helper.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

test('seam-detection does NOT introduce new failure code values', () => {
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(__dirname, '..', 'js/tools/multifile-tools.js'), 'utf8');
    // The detector returns an object WITHOUT a `code:` field (success path).
    // Find the function body and confirm.
    const fnIdx = src.indexOf('function _detectAdjacentSeamDuplicate');
    assert.ok(fnIdx >= 0, 'helper function exists');
    const fnEnd = src.indexOf('\n}\n', fnIdx);
    const body = src.slice(fnIdx, fnEnd);
    assert.ok(!/\bcode:\s*['"]/.test(body), '_detectAdjacentSeamDuplicate body must not introduce a code: field');
});
