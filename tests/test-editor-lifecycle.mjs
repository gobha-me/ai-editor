/**
 * Anti-regression CI guard: in `createEditor` (`js/editor/instance.js`), the
 * destroy-then-replace contract must hold across every editor recreation:
 *
 *   1. `editorInstance.destroy()` is called BEFORE
 *      `editorInstance = new CM.EditorView(...)` so the prior CM6 EditorView
 *      releases its DOM + EventBus subscriptions before its module-scope
 *      binding is rebound.
 *   2. `lineNumberCompartment` is reassigned to a fresh `new CM.Compartment()`
 *      inside `createEditor` so the prior Compartment becomes GC-eligible.
 *   3. `keymapCompartment` is reassigned to a fresh `new CM.Compartment()`
 *      inside `createEditor` (same shape as #2).
 *   4. Forward-evolution guard — `lineNumberCompartment` + `keymapCompartment`
 *      are declared as **module-scope `let`**. Promoting to `const` (breaks
 *      reassignment) or moving inside `createEditor` (changes the GC mechanism
 *      from "rebind module-scope let" to "function-local out-of-scope")
 *      both demand updating this test contract — they're not silent refactors.
 *
 * Why this exists — `RE-EVAL following 2.64.0` ICD #9 code-aware finding #1
 * (the destroy-then-replace contract). The singleton `editorInstance` +
 * module-scope Compartment refs are the editor module's most easily-broken
 * invariant: a future contributor refactoring the destroy path could silently
 * persist a prior CM6 view (memory leak + listener double-binding) or hold
 * stale Compartment refs across recreations (decoration state survives a
 * recreation that was meant to reset it).
 *
 * The ICD's "Fix shape" originally described the Compartments as
 * function-local; the actual code declares them as module-scope `let`s
 * reassigned inside `createEditor`. The test pins the **actual** mechanism;
 * the ICD wording was corrected in the same slice as this test was authored.
 *
 * The slice's investigation chose a source-scan over a runtime assertion
 * (`createEditor` requires CM6 + DOM, browser-only) — same idiom as
 * `tests/test-editor-compartment-ordering.mjs` (2.72.0),
 * `tests/test-chat-tool-name-literals.mjs` (2.44.0), and
 * `tests/test-plugin-editor-auto-switch-retired.mjs` (2.66.0). The modules
 * under test stay the source of truth for their own shape.
 *
 * Closes ICD #9 §"Code-aware findings #1" + §"Open invariants" bullets 1 + 4.
 *
 * @since 2.75.0
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const INSTANCE_PATH = join(__dirname, '..', 'js', 'editor', 'instance.js');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function extractCreateEditorBody(src) {
    const fnStart = src.indexOf('export async function createEditor');
    if (fnStart < 0) return null;
    const bodyStart = src.indexOf('{', fnStart);
    if (bodyStart < 0) return null;
    let depth = 0;
    for (let i = bodyStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(bodyStart, i);
        }
    }
    return null;
}

function findSingleMatch(body, label, pattern) {
    let match = null;
    let count = 0;
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let m;
    while ((m = re.exec(body)) !== null) {
        count++;
        match = m;
    }
    assert.equal(
        count,
        1,
        `Expected exactly one '${label}' match in createEditor body; found ${count}. ` +
        `If a refactor moved or duplicated the call, update this test and re-verify ` +
        `that the destroy-then-replace contract still holds.`,
    );
    return match.index;
}

test('createEditor: editorInstance.destroy() precedes editorInstance = new CM.EditorView(...)', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));
    const body = extractCreateEditorBody(src);
    assert.ok(body, 'Could not locate createEditor function body in js/editor/instance.js');

    const destroyIdx = findSingleMatch(
        body,
        'editorInstance.destroy()',
        /editorInstance\.destroy\(\)/,
    );
    const rebindIdx = findSingleMatch(
        body,
        'editorInstance = new CM.EditorView(',
        /editorInstance\s*=\s*new\s+CM\.EditorView\b/,
    );

    assert.ok(
        destroyIdx < rebindIdx,
        `INVARIANT VIOLATED: editorInstance.destroy() must be called BEFORE ` +
        `editorInstance = new CM.EditorView(...). The destroy-then-replace contract ` +
        `requires the prior CM6 EditorView to release its DOM + EventBus subscriptions ` +
        `before its module-scope binding is rebound; otherwise the prior view leaks ` +
        `(its lifetime now exceeds its identity) and any listeners it owned double-fire ` +
        `when subsequent transactions hit the new view.`,
    );
});

test('createEditor: lineNumberCompartment is reassigned to a fresh new CM.Compartment() inside the function body', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));
    const body = extractCreateEditorBody(src);
    assert.ok(body, 'Could not locate createEditor function body in js/editor/instance.js');

    findSingleMatch(
        body,
        'lineNumberCompartment = new CM.Compartment()',
        /lineNumberCompartment\s*=\s*CM\.Compartment\s*\?\s*new\s+CM\.Compartment\(\)/,
    );
    // findSingleMatch's count assertion is the load-bearing check; reaching
    // this line means the reassignment exists exactly once in the body.
    // If a future PR drops the CM.Compartment guard or splits the reassignment
    // across branches, update the regex + this comment.
});

test('createEditor: keymapCompartment is reassigned to a fresh new CM.Compartment() inside the function body', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));
    const body = extractCreateEditorBody(src);
    assert.ok(body, 'Could not locate createEditor function body in js/editor/instance.js');

    findSingleMatch(
        body,
        'keymapCompartment = new CM.Compartment()',
        /keymapCompartment\s*=\s*CM\.Compartment\s*\?\s*new\s+CM\.Compartment\(\)/,
    );
});

test('module-scope: lineNumberCompartment + keymapCompartment are declared as `let` initialized to null (forward-evolution guard)', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));

    const lineNumberDecl = /^let lineNumberCompartment\s*=\s*null;/m;
    const keymapDecl = /^let keymapCompartment\s*=\s*null;/m;

    assert.ok(
        lineNumberDecl.test(src),
        `INVARIANT VIOLATED: js/editor/instance.js must declare \`let lineNumberCompartment = null;\` ` +
        `at module scope (left-anchored). The destroy-then-replace contract relies on ` +
        `\`createEditor\` reassigning this module-scope binding so the prior Compartment becomes ` +
        `GC-eligible. Promoting to \`const\` breaks the reassignment. Moving inside \`createEditor\` ` +
        `changes the GC mechanism from "module-scope rebind" to "function-local out-of-scope" — ` +
        `also valid, but the test contract + ICD #9 finding #1 wording need a paired update.`,
    );
    assert.ok(
        keymapDecl.test(src),
        `INVARIANT VIOLATED: js/editor/instance.js must declare \`let keymapCompartment = null;\` ` +
        `at module scope (left-anchored). Same rationale as the lineNumberCompartment guard above.`,
    );
});
