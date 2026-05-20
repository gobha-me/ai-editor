/**
 * Anti-regression CI guard: in `createEditor` (`js/editor/instance.js`), the
 * three load-bearing Compartment / basicSetup `extensions.push(...)` calls
 * must appear in a specific order:
 *
 *   1. `extensions.push(keymapCompartment.of(...))`
 *   2. `extensions.push(ghostTextCompartment.of(...))`
 *   3. `extensions.push(...CM.basicSetup)`
 *
 * Why this exists — `RE-EVAL following 2.64.0` ICD #9 code-aware finding #2
 * (the highest-anti-regression-value finding in the cohort). CM6 evaluates
 * extensions in registration order and the first registration of a key binding
 * wins. If basicSetup ran before the keymap compartment, `defaultKeymap` would
 * claim Esc / i / h / j / k / l before Vim mode could bind them — Vim mode
 * would silently no-op. If basicSetup ran before the ghost-text compartment,
 * `indentWithTab` would claim Tab before the ghost-text Tab/Esc handlers —
 * ghost-text accept/dismiss would silently no-op. Both failure modes are
 * silent: no console error, no test failure in any other suite, the user
 * just notices keys "don't work."
 *
 * The slice's investigation chose a source-scan over a runtime assertion
 * (`createEditor` requires CM6 + DOM, browser-only) — same idiom as
 * `tests/test-chat-tool-name-literals.mjs` (2.44.0) and
 * `tests/test-plugin-editor-auto-switch-retired.mjs` (2.66.0). The modules
 * under test stay the source of truth for their own shape.
 *
 * Closes ICD #9 §"Code-aware findings #2" + §"Open invariants" bullet 2.
 *
 * @since 2.72.0
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

function findSinglePushLine(body, label, pattern) {
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
        `Expected exactly one '${label}' push in createEditor body; found ${count}. ` +
        `If a refactor moved or duplicated the call, update this test and re-verify ` +
        `that the keymap < ghost-text < basicSetup ordering invariant still holds.`,
    );
    return match.index;
}

test('createEditor: extensions.push(keymapCompartment.of) precedes extensions.push(...CM.basicSetup)', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));
    const body = extractCreateEditorBody(src);
    assert.ok(body, 'Could not locate createEditor function body in js/editor/instance.js');

    const keymapIdx = findSinglePushLine(
        body,
        'keymapCompartment',
        /extensions\.push\(\s*keymapCompartment\.of\b/,
    );
    const basicSetupIdx = findSinglePushLine(
        body,
        '...CM.basicSetup',
        /extensions\.push\(\s*\.\.\.\s*CM\.basicSetup\b/,
    );

    assert.ok(
        keymapIdx < basicSetupIdx,
        `INVARIANT VIOLATED: keymapCompartment must be pushed BEFORE CM.basicSetup. ` +
        `CM6 evaluates extensions in registration order; if basicSetup wins first, ` +
        `defaultKeymap claims Esc/i/h/j/k/l and Vim mode silently no-ops. ` +
        `(See @replit/codemirror-vim README + js/editor/instance.js comments at the ` +
        `keymapCompartment push site.)`,
    );
});

test('createEditor: extensions.push(ghostTextCompartment.of) precedes extensions.push(...CM.basicSetup)', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));
    const body = extractCreateEditorBody(src);
    assert.ok(body, 'Could not locate createEditor function body in js/editor/instance.js');

    const ghostTextIdx = findSinglePushLine(
        body,
        'ghostTextCompartment',
        /extensions\.push\(\s*ghostTextCompartment\.of\b/,
    );
    const basicSetupIdx = findSinglePushLine(
        body,
        '...CM.basicSetup',
        /extensions\.push\(\s*\.\.\.\s*CM\.basicSetup\b/,
    );

    assert.ok(
        ghostTextIdx < basicSetupIdx,
        `INVARIANT VIOLATED: ghostTextCompartment must be pushed BEFORE CM.basicSetup. ` +
        `CM6 evaluates extensions in registration order; if basicSetup wins first, ` +
        `indentWithTab claims Tab and ghost-text accept/dismiss silently no-op.`,
    );
});

test('createEditor: keymapCompartment.of pushed before ghostTextCompartment.of', () => {
    const src = stripComments(readFileSync(INSTANCE_PATH, 'utf8'));
    const body = extractCreateEditorBody(src);
    assert.ok(body, 'Could not locate createEditor function body in js/editor/instance.js');

    const keymapIdx = findSinglePushLine(
        body,
        'keymapCompartment',
        /extensions\.push\(\s*keymapCompartment\.of\b/,
    );
    const ghostTextIdx = findSinglePushLine(
        body,
        'ghostTextCompartment',
        /extensions\.push\(\s*ghostTextCompartment\.of\b/,
    );

    assert.ok(
        keymapIdx < ghostTextIdx,
        `INVARIANT VIOLATED: keymapCompartment must be pushed BEFORE ghostTextCompartment. ` +
        `Vim mode's keymap must be the earliest entry so it claims its bindings first; ` +
        `ghost-text's Tab/Esc are layered on top of the editing keymap, not under it.`,
    );
});
