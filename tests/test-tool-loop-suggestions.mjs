/**
 * Regression — buildRefusalPayload (2.9.1).
 *
 * Origin: qwen-3-6-plus on Venice looped on `list_tools_by_category
 * category=code.project` during the 2.9.0 ai-editor dogfood (2026-05-09).
 * The cross-request anti-loop fired correctly at streak=3 / streak=4 but
 * the REFUSED envelope's redirect was text-only ("pick a different tool")
 * with no concrete candidates. The model re-emitted the same call.
 *
 * This module pins the contract so weaker models receive:
 *   - imperative wording ("STOP")
 *   - 5 concrete tool candidates from a *different* category
 *   - deterministic suggestions across retries (so the model sees stable advice)
 *   - optional verbatim echo of the last user message
 *
 * Below the threshold (streak < 3), the legacy soft-message envelope is
 * preserved verbatim — the production path never lands there today, but
 * keeping the function defined across the full streak range guards against
 * accidental regression of the threshold itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRefusalPayload, _testing } from '../js/chat/refusal-hints.js';

/**
 * Fixed catalog spanning multiple dot-categories — mirrors the live
 * shape from `Catalog.listAll().map(td => ({name, category}))`. Keeps
 * the test independent of the live registry.
 */
const FIXTURE_CATALOG = [
    // offending category — the same code.project bucket the dogfood loop hit
    { name: 'list_tools_by_category', category: 'meta' },
    { name: 'list_tool_categories',   category: 'meta' },
    { name: 'find_tool',              category: 'meta' },
    // other categories
    { name: 'read_file',              category: 'code.file.read' },
    { name: 'read_lines',             category: 'code.file.read' },
    { name: 'open_file',              category: 'code.file.navigate' },
    { name: 'write_file',             category: 'code.file.write' },
    { name: 'edit_file',              category: 'code.file.edit' },
    { name: 'search_in_files',        category: 'code.scan' },
    { name: 'get_project_tree',       category: 'code.project' },
    { name: 'list_projects',          category: 'code.project' },
    { name: 'commit_files',           category: 'code.git.commit' },
    { name: 'create_pull_request',    category: 'code.git.pr' },
    { name: 'get_ci_status',          category: 'code.git.ci' },
    { name: 'memory_remember',        category: 'memory' },
    { name: 'scratchpad_write',       category: 'scratchpad' },
    { name: 'ask_user',               category: 'interaction' },
];

const VALID_NAMES = new Set(FIXTURE_CATALOG.map(t => t.name));

function categoryOf(name) {
    const e = FIXTURE_CATALOG.find(t => t.name === name);
    return e ? e.category : null;
}

/* -------------------------------------------------------------------------- */
/* Spec 1 — below threshold returns soft message only                         */
/* -------------------------------------------------------------------------- */

test('streak < 3: legacy soft-message envelope, no `suggestions` field', () => {
    for (const streak of [0, 1, 2]) {
        const out = buildRefusalPayload('list_tools_by_category', streak, {
            catalog: FIXTURE_CATALOG,
        });
        assert.equal(typeof out.error, 'string');
        assert.match(out.error, /^REFUSED: list_tools_by_category called/);
        assert.equal(out._refused, true);
        assert.equal(out.suggestions, undefined,
            `streak=${streak} must NOT carry suggestions`);
        // Soft framing inherited from getRefusalHint's GENERIC fallback.
        assert.match(out.error, /Re-read the prior result/);
    }
});

/* -------------------------------------------------------------------------- */
/* Spec 2 — at threshold suggestions are present, valid, off-category         */
/* -------------------------------------------------------------------------- */

test('streak >= 3: suggestions present, length >= 5, none from offending category, all valid names', () => {
    for (const streak of [3, 4, 7]) {
        const out = buildRefusalPayload('list_tools_by_category', streak, {
            catalog: FIXTURE_CATALOG,
        });
        assert.equal(out._refused, true);
        assert.ok(Array.isArray(out.suggestions), 'suggestions must be an array');
        assert.ok(out.suggestions.length >= 5,
            `expected ≥5 suggestions at streak=${streak}, got ${out.suggestions.length}`);
        for (const s of out.suggestions) {
            assert.equal(typeof s, 'string');
            assert.ok(VALID_NAMES.has(s), `suggestion "${s}" not a registered tool`);
            assert.notEqual(s, 'list_tools_by_category', 'suggestion must not be the offender itself');
            assert.notEqual(categoryOf(s), 'meta',
                `suggestion "${s}" is in the offender's category ("meta")`);
        }
        // Imperative wording — surfaces both the count and the candidates.
        assert.match(out.error, /^STOP\./);
        assert.match(out.error, new RegExp(`${streak} consecutive times`));
        assert.match(out.error, /Try one of:/);
    }
});

/* -------------------------------------------------------------------------- */
/* Spec 3 — same-args dup at streak >= 3 returns the same suggestions         */
/* -------------------------------------------------------------------------- */

test('streak >= 3: suggestions are deterministic across retries (same offender → same list)', () => {
    const a = buildRefusalPayload('list_tools_by_category', 3, { catalog: FIXTURE_CATALOG });
    const b = buildRefusalPayload('list_tools_by_category', 4, { catalog: FIXTURE_CATALOG });
    const c = buildRefusalPayload('list_tools_by_category', 9, { catalog: FIXTURE_CATALOG });
    assert.deepEqual(a.suggestions, b.suggestions,
        'suggestions diverged between streak=3 and streak=4 for the same offender');
    assert.deepEqual(b.suggestions, c.suggestions,
        'suggestions diverged at higher streak — must remain stable');
});

test('different offenders yield different suggestion seeds (sanity — not a guarantee, but expected)', () => {
    // Sanity check the determinism doesn't collapse to a constant.
    // With a fixed-shuffle seeded by toolName, two different toolNames
    // should pick at least one different candidate when the pool is rich.
    const a = buildRefusalPayload('list_tools_by_category', 5, { catalog: FIXTURE_CATALOG });
    const b = buildRefusalPayload('get_ci_status',          5, { catalog: FIXTURE_CATALOG });
    assert.notDeepEqual(a.suggestions, b.suggestions,
        'two different offenders should not produce identical suggestion lists');
});

/* -------------------------------------------------------------------------- */
/* Verification — simulated 4 consecutive identical tool calls                */
/* -------------------------------------------------------------------------- */

test('simulated 4 consecutive identical calls: streaks 3 and 4 both surface suggestions', () => {
    // Mirrors the streak progression in handlers.js:
    //   isDup = !!cachedResult || crossRequestDuplicate
    //   streak = isDup ? prev+1 : 0
    //   if (streak >= 3) refuse
    const DUP_REFUSE_THRESHOLD = _testing.STRONG_THRESHOLD;
    assert.equal(DUP_REFUSE_THRESHOLD, 3, 'threshold drift would silently break this test');

    const calls = [];
    let streak = 0;
    for (let i = 0; i < 4; i++) {
        streak += 1; // every call is a dup of the prior — streak grows monotonically
        const isRefused = streak >= DUP_REFUSE_THRESHOLD;
        const payload = buildRefusalPayload('list_tools_by_category', streak, {
            catalog: FIXTURE_CATALOG,
            lastUserMessage: 'Show me the project tree',
        });
        calls.push({ streak, isRefused, payload });
    }

    // Calls 1 and 2 are below threshold — no suggestions.
    assert.equal(calls[0].payload.suggestions, undefined, 'call 1 (streak=1): no suggestions');
    assert.equal(calls[1].payload.suggestions, undefined, 'call 2 (streak=2): no suggestions');

    // Calls 3 and 4 are at/above threshold — suggestions present and identical.
    assert.ok(Array.isArray(calls[2].payload.suggestions), 'call 3 (streak=3): suggestions present');
    assert.ok(Array.isArray(calls[3].payload.suggestions), 'call 4 (streak=4): suggestions present');
    assert.deepEqual(calls[2].payload.suggestions, calls[3].payload.suggestions,
        'calls 3 and 4 must return the same suggestions deterministically');

    // The user's last message is echoed verbatim on the strong-refusal calls.
    assert.equal(calls[2].payload.last_user_message, 'Show me the project tree');
    assert.equal(calls[3].payload.last_user_message, 'Show me the project tree');
    // Soft envelope (call 1, call 2) does NOT carry last_user_message — keeps the
    // legacy shape stable for any callers still inspecting only `error`.
    assert.equal(calls[0].payload.last_user_message, undefined);
});

/* -------------------------------------------------------------------------- */
/* Edge cases                                                                 */
/* -------------------------------------------------------------------------- */

test('empty catalog: no suggestions emitted, error still imperative', () => {
    const out = buildRefusalPayload('list_tools_by_category', 3, { catalog: [] });
    assert.equal(out.suggestions, undefined,
        'empty catalog must not synthesize suggestions');
    assert.match(out.error, /^STOP\./, 'imperative wording independent of suggestion availability');
    assert.match(out.error, /Do not call list_tools_by_category again/);
    assert.doesNotMatch(out.error, /Try one of: \[\]/,
        'empty bracket list would only confuse the model');
});

test('offender absent from catalog: still avoids re-suggesting the offender by name', () => {
    // When the offender's category is unknown, every other tool is a valid
    // suggestion *except* the offender itself.
    const out = buildRefusalPayload('mystery_tool', 3, { catalog: FIXTURE_CATALOG });
    assert.ok(Array.isArray(out.suggestions));
    assert.ok(out.suggestions.length >= 5);
    assert.ok(!out.suggestions.includes('mystery_tool'),
        'offender must never be in its own suggestion list');
});

test('lastUserMessage trimmed/empty: not echoed', () => {
    const a = buildRefusalPayload('list_tools_by_category', 3, {
        catalog: FIXTURE_CATALOG,
        lastUserMessage: '',
    });
    assert.equal(a.last_user_message, undefined,
        'empty user message must not pollute the payload');

    const b = buildRefusalPayload('list_tools_by_category', 3, {
        catalog: FIXTURE_CATALOG,
        // no lastUserMessage at all
    });
    assert.equal(b.last_user_message, undefined);
});
