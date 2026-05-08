/**
 * Tests for the wrong-shape directional hint on `edit_file`.
 *
 * Origin: HTML-Games dogfood, qwen-3-6-plus, 2026-05-08. The model invented
 * `operations: '[{"type":"replace",...}]'` (a JSON-encoded batched-ops array)
 * — a field that does not exist on this tool. The destructure dropped it
 * silently and the bare `replace requires start_line, end_line, and new_content`
 * error fired, so the model burned 4 turns guessing `new_text` → `new_content`
 * before falling back to `open_file` + `replace_lines`. Same shape as 1.8.2's
 * `getRefusalHint`: detect a known-bad shape and emit a targeted hint.
 *
 * The pre-check fires *before* any State or path preconditions, so these
 * assertions don't need a project loaded — schema mistakes are a stable,
 * State-free signal.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../js/tools/registry.js';
import { registerMultiFileTools } from '../js/tools/multifile-tools.js';
import { State } from '../js/core.js';

function setup() {
    ToolRegistry.clear();
    registerMultiFileTools(ToolRegistry);
}

function getHandler(name) {
    const handler = ToolRegistry.handlers.get(name);
    assert.ok(handler, `tool ${name} should be registered`);
    return handler;
}

test('edit_file with `operations` returns hint naming the real shape', async () => {
    setup();
    const edit_file = getHandler('edit_file');
    const result = await edit_file({
        path: 'js/app.js',
        operations: '[{"type":"replace","start_line":92,"end_line":92,"new_text":"x"}]',
    });
    assert.ok(result.error, 'should return an error');
    assert.ok(result.hint, 'should return a hint');
    // Hint must name the real shape and explicitly reject the batched-ops shape.
    assert.match(result.hint, /single op at the top level/i);
    assert.match(result.hint, /new_content/);
    assert.match(result.hint, /operations/);
    assert.match(result.hint, /once per change/i);
});

test('edit_file with `ops` returns the same batched-ops hint', async () => {
    setup();
    const edit_file = getHandler('edit_file');
    const result = await edit_file({ path: 'js/app.js', ops: [] });
    assert.match(result.error, /'ops'/);
    assert.match(result.hint, /single op at the top level/i);
});

test('edit_file with `new_text` instead of `new_content` returns hint', async () => {
    setup();
    const edit_file = getHandler('edit_file');
    const result = await edit_file({
        path: 'js/app.js',
        operation: 'replace',
        start_line: 1,
        end_line: 1,
        new_text: 'x',
    });
    assert.ok(result.error, 'should return an error');
    assert.ok(result.hint, 'should return a hint');
    assert.match(result.hint, /new_content/);
    // Should explicitly call out the wrong key by name.
    assert.match(result.hint, /new_text/);
});

test('edit_file with `text` returns hint naming new_content', async () => {
    setup();
    const edit_file = getHandler('edit_file');
    const result = await edit_file({
        path: 'js/app.js',
        operation: 'replace',
        start_line: 1,
        end_line: 1,
        text: 'x',
    });
    assert.match(result.hint, /new_content/);
    assert.match(result.error, /'text'/);
});

test('edit_file with `content` returns hint naming new_content', async () => {
    setup();
    const edit_file = getHandler('edit_file');
    const result = await edit_file({
        path: 'js/app.js',
        operation: 'replace',
        start_line: 1,
        end_line: 1,
        content: 'x',
    });
    assert.match(result.hint, /new_content/);
    assert.match(result.error, /'content'/);
});

test('edit_file with simple omission still gets the bare validation error (no false-positive hint)', async () => {
    setup();
    // Pretend a project is loaded so we get past the State precondition.
    const prevProject = State.currentProject;
    State.currentProject = { owner: 'x', repo: 'y' };
    try {
        const edit_file = getHandler('edit_file');
        // Missing end_line + new_content but no wrong-shape key. We expect
        // the existing validator to fire (after ensureFileActive may fail —
        // either way, no `hint` field should be set by the wrong-shape path).
        const result = await edit_file({
            path: 'does-not-exist.js',
            operation: 'replace',
            start_line: 1,
        });
        assert.ok(result.error, 'should return an error');
        assert.equal(result.hint, undefined,
            'no wrong-shape key present, so no directional hint should be attached');
    } finally {
        State.currentProject = prevProject;
    }
});

test('correct shape passes the wrong-shape gate (no `hint`, fails downstream on missing project)', async () => {
    setup();
    const prevProject = State.currentProject;
    State.currentProject = null; // No project → existing precondition fires.
    try {
        const edit_file = getHandler('edit_file');
        const result = await edit_file({
            path: 'js/app.js',
            operation: 'replace',
            start_line: 1,
            end_line: 1,
            new_content: 'x',
        });
        // The shape is correct, so _detectWrongShape returns null and the
        // request flows through to the real precondition error — proving
        // the gate doesn't false-positive on well-formed calls.
        assert.equal(result.hint, undefined);
        assert.match(result.error, /No project is currently loaded/);
    } finally {
        State.currentProject = prevProject;
    }
});

test('wrong-shape pre-check fires before State.currentProject precondition', async () => {
    setup();
    // No project loaded — the wrong-shape hint should still surface, because
    // the schema mistake is more directional than "no project loaded".
    const prevProject = State.currentProject;
    State.currentProject = null;
    try {
        const edit_file = getHandler('edit_file');
        const result = await edit_file({ path: 'foo', operations: '[]' });
        assert.match(result.hint || '', /single op at the top level/i,
            'shape hint must fire even with no project loaded');
        assert.doesNotMatch(result.error, /No project is currently loaded/);
    } finally {
        State.currentProject = prevProject;
    }
});
