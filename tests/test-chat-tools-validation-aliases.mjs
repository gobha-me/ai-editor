/**
 * Tests for tool-param alias rewriting in `js/chat/tools.js` (gitea#422).
 *
 * Origin: AAR of a 2026-05-14 qwen-3-6-plus session against
 * `xcaliber/HTML-Games#215`. The model called `read_lines` with `start`/`end`
 * (slice/grep prior) instead of `start_line`/`end_line`, and `search_in_files`
 * with `pattern` (grep prior) instead of `query`. Each miss cost a round-trip
 * even though the tool was correctly chosen. The fix: a tool-agnostic alias
 * map at the validator that rewrites `start`→`start_line`, `pattern`→`query`,
 * etc. before strict validation fires.
 *
 * Also covers the related contract collapse in `create_file`: the JSON schema
 * declared only `path, content` as required and the description already
 * advertised `message` as optional (defaulting to `"Create <path>"`), but
 * `REQUIRED_TOOL_PARAMS['create_file']` included `message`. Validator was
 * stricter than the tool's own schema. Fixed in the same patch.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    applyAliasesAndDefaults,
    validateToolParameters,
    TOOL_PARAM_ALIASES,
    REQUIRED_TOOL_PARAMS,
} from '../js/chat/tools.js';

// ============================================
// Alias rewriting — read_lines case
// ============================================

test('read_lines: {start, end} rewritten to {start_line, end_line}', () => {
    const input = { path: 'js/app.js', start: 1, end: 10 };
    const { args, aliasesUsed } = applyAliasesAndDefaults(input);
    assert.deepEqual(args, { path: 'js/app.js', start_line: 1, end_line: 10 });
    assert.deepEqual(aliasesUsed.sort(), ['end→end_line', 'start→start_line']);
});

test('read_lines: aliased args pass validation', () => {
    const { args } = applyAliasesAndDefaults({ path: 'js/app.js', start: 1, end: 10 });
    assert.equal(validateToolParameters('read_lines', args), null);
});

test('read_lines: camelCase aliases {startLine, endLine} also rewrite', () => {
    const { args, aliasesUsed } = applyAliasesAndDefaults({ path: 'x', startLine: 5, endLine: 9 });
    assert.deepEqual(args, { path: 'x', start_line: 5, end_line: 9 });
    assert.deepEqual(aliasesUsed.sort(), ['endLine→end_line', 'startLine→start_line']);
});

// ============================================
// Alias rewriting — search_in_files case
// ============================================

test('search_in_files: {pattern} rewritten to {query}', () => {
    const { args, aliasesUsed } = applyAliasesAndDefaults({ pattern: 'foo' });
    assert.deepEqual(args, { query: 'foo' });
    assert.deepEqual(aliasesUsed, ['pattern→query']);
});

test('search_in_files: {text} also rewrites to query', () => {
    const { args, aliasesUsed } = applyAliasesAndDefaults({ text: 'foo' });
    assert.deepEqual(args, { query: 'foo' });
    assert.deepEqual(aliasesUsed, ['text→query']);
});

test('search_in_files: aliased args pass validation', () => {
    const { args } = applyAliasesAndDefaults({ pattern: 'foo' });
    assert.equal(validateToolParameters('search_in_files', args), null);
});

// ============================================
// Alias rewriting — path aliases
// ============================================

test('file_path/filepath rewrite to path', () => {
    assert.deepEqual(
        applyAliasesAndDefaults({ file_path: 'x.js' }).args,
        { path: 'x.js' },
    );
    assert.deepEqual(
        applyAliasesAndDefaults({ filepath: 'y.js' }).args,
        { path: 'y.js' },
    );
});

// ============================================
// Edge cases
// ============================================

test('canonical wins when both alias and canonical are present', () => {
    const { args, aliasesUsed } = applyAliasesAndDefaults({ start: 1, start_line: 5 });
    assert.deepEqual(args, { start_line: 5 });
    assert.deepEqual(aliasesUsed, [], 'no rewrite recorded — canonical was already present');
});

test('no alias keys → input echoed back unchanged', () => {
    const input = { path: 'x', start_line: 1, end_line: 10 };
    const { args, aliasesUsed } = applyAliasesAndDefaults(input);
    assert.deepEqual(args, input);
    assert.deepEqual(aliasesUsed, []);
});

test('null/undefined args are handled defensively', () => {
    assert.deepEqual(applyAliasesAndDefaults(null).args, {});
    assert.deepEqual(applyAliasesAndDefaults(undefined).args, {});
    assert.deepEqual(applyAliasesAndDefaults(null).aliasesUsed, []);
});

test('empty args → empty out', () => {
    const { args, aliasesUsed } = applyAliasesAndDefaults({});
    assert.deepEqual(args, {});
    assert.deepEqual(aliasesUsed, []);
});

// ============================================
// create_file no longer requires `message`
// ============================================

test('create_file: validates clean without `message` (handler defaults to "Create <path>")', () => {
    const result = validateToolParameters('create_file', { path: 'x.md', content: 'hi' });
    assert.equal(result, null);
});

test('create_file: still requires `path` and `content`', () => {
    const r1 = validateToolParameters('create_file', { content: 'hi' });
    assert.ok(r1 && r1.missingParams.includes('path'));

    const r2 = validateToolParameters('create_file', { path: 'x.md' });
    assert.ok(r2 && r2.missingParams.includes('content'));
});

// ============================================
// Alias-map invariants
// ============================================

test('every alias maps to a canonical name that exists somewhere in REQUIRED_TOOL_PARAMS', () => {
    const allCanonical = new Set();
    for (const params of Object.values(REQUIRED_TOOL_PARAMS)) {
        for (const p of params) allCanonical.add(p);
    }
    for (const [alias, canonical] of Object.entries(TOOL_PARAM_ALIASES)) {
        assert.ok(
            allCanonical.has(canonical),
            `alias '${alias}'→'${canonical}' targets a name that is not required by any tool — orphan alias`,
        );
    }
});

test('no alias key is itself a canonical param of any tool (collision safety)', () => {
    // If an alias key (e.g. `start`) appeared as a *canonical* required param
    // of some tool, the flat alias map would silently rewrite calls that
    // tool legitimately receives. None of our current tools require those
    // alias names, so the flat map is safe — pin it so a future schema
    // change can't silently break this.
    for (const [tool, params] of Object.entries(REQUIRED_TOOL_PARAMS)) {
        for (const p of params) {
            assert.ok(
                !(p in TOOL_PARAM_ALIASES),
                `tool '${tool}' requires param '${p}', which is also an alias key — flat alias map would silently rewrite legitimate calls`,
            );
        }
    }
});

test('alias map keys are disjoint from canonical values (no chained rewrites)', () => {
    const canonicals = new Set(Object.values(TOOL_PARAM_ALIASES));
    for (const alias of Object.keys(TOOL_PARAM_ALIASES)) {
        assert.ok(
            !canonicals.has(alias),
            `alias '${alias}' appears as a canonical target elsewhere in the map — chained rewrite risk`,
        );
    }
});

// ============================================
// Composition with edit_file wrong-shape detection (regression guard)
// ============================================

test('edit_file wrong-shape inputs survive alias rewrite untouched', () => {
    // _detectWrongShape (js/tools/multifile-tools.js) catches calls like
    // `{path, edits: [...]}` after validator. Alias rewrite must not
    // pre-rewrite `edits` or `operations` keys, or the wrong-shape detector
    // would never see them.
    const wrongShape = { path: 'x.js', edits: [{ operation: 'replace' }] };
    const { args, aliasesUsed } = applyAliasesAndDefaults(wrongShape);
    assert.deepEqual(args, wrongShape);
    assert.deepEqual(aliasesUsed, []);

    const wrongShape2 = { path: 'x.js', operations: [] };
    assert.deepEqual(applyAliasesAndDefaults(wrongShape2).args, wrongShape2);
});
