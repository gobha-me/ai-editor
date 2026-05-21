/**
 * Regression — buildRefusalPayload (consecutive-identical-args refusal).
 *
 * Pre-2.82.0, the strong refusal (streak ≥ 3) included a `suggestions` array
 * picked deterministically by FNV-1a-seeded shuffle over off-category tools.
 * Field replay on qwen-3-6-plus against `xcaliber/HTML-Games` #238
 * (2026-05-21) showed the picker steering models toward functionally
 * unrelated tools (gitea#488). The picker had no semantic awareness, so any
 * tool-name suggestion was a guess — and a wrong guess was worse than no
 * guess at all. 2.82.0 removed the `suggestions` array entirely; the strong
 * prose now names two off-ramps the guard actually admits — respond, or
 * change at least one arg before retrying.
 *
 * This module pins:
 *   - strong-threshold value (3) — drift here changes refusal cadence silently
 *   - imperative wording ("STOP")
 *   - the two off-ramps surface in the strong-refusal prose
 *   - no `suggestions` field is ever attached (gitea#488 regression guard)
 *   - optional verbatim echo of the last user message
 *   - legacy soft-message envelope below threshold (streak < 3)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRefusalPayload, _testing } from '../js/chat/refusal-hints.js';

/* -------------------------------------------------------------------------- */
/* Spec 1 — below threshold returns soft message only, no suggestions field   */
/* -------------------------------------------------------------------------- */

test('streak < 3: legacy soft-message envelope, no `suggestions` field', () => {
    for (const streak of [0, 1, 2]) {
        const out = buildRefusalPayload('list_tools_by_category', streak);
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
/* Spec 2 — at threshold, strong wording with no suggestions (gitea#488)      */
/* -------------------------------------------------------------------------- */

test('streak >= 3: strong wording, no `suggestions` field (gitea#488 regression)', () => {
    for (const streak of [3, 4, 7]) {
        const out = buildRefusalPayload('list_dirty_files', streak);
        assert.equal(out._refused, true);
        assert.equal(out.suggestions, undefined,
            `streak=${streak} must NOT carry suggestions — gitea#488 removal`);
        // Imperative wording and the offender + streak surface in the prose.
        assert.match(out.error, /^STOP\./);
        assert.match(out.error, new RegExp(`${streak} consecutive times`));
        assert.match(out.error, /list_dirty_files/);
        // Both off-ramps surface in prose. Pinning the literal "change at
        // least one argument" guards against regression to a more passive
        // message that omits the second exit (the guard only blocks
        // *identical*-arg retries; a varied call is still admissible).
        assert.match(out.error, /Respond to the user/);
        assert.match(out.error, /change at least one argument/);
        assert.match(out.error, /Do not call list_dirty_files again/);
        // Misleading-suggestion phrasing must not have regressed.
        assert.doesNotMatch(out.error, /Try one of/,
            `streak=${streak} must not include a "Try one of" segment`);
    }
});

/* -------------------------------------------------------------------------- */
/* Spec 3 — simulated 4 consecutive identical calls match the dispatch path   */
/* -------------------------------------------------------------------------- */

test('simulated 4 consecutive identical calls: streaks 3 and 4 surface strong wording', () => {
    // Mirrors the streak progression in tool-loop-core.js:
    //   isDup = !!cachedResult || crossRequestDuplicate
    //   streak = isDup ? prev+1 : 0
    //   if (streak >= 3) refuse
    const DUP_REFUSE_THRESHOLD = _testing.STRONG_THRESHOLD;
    assert.equal(DUP_REFUSE_THRESHOLD, 3, 'threshold drift would silently break this test');

    const calls = [];
    let streak = 0;
    for (let i = 0; i < 4; i++) {
        streak += 1; // every call is a dup of the prior — streak grows monotonically
        const payload = buildRefusalPayload('list_dirty_files', streak, {
            lastUserMessage: 'Open a PR with what we have',
        });
        calls.push({ streak, payload });
    }

    // Calls 1 and 2 are below threshold — soft envelope.
    assert.match(calls[0].payload.error, /^REFUSED/, 'call 1 (streak=1): soft REFUSED prefix');
    assert.match(calls[1].payload.error, /^REFUSED/, 'call 2 (streak=2): soft REFUSED prefix');
    // Calls 3 and 4 are at/above threshold — strong wording.
    assert.match(calls[2].payload.error, /^STOP\./, 'call 3 (streak=3): strong STOP prefix');
    assert.match(calls[3].payload.error, /^STOP\./, 'call 4 (streak=4): strong STOP prefix');

    // No call should ever carry a suggestions field.
    for (const c of calls) {
        assert.equal(c.payload.suggestions, undefined,
            `streak=${c.streak} must NOT carry suggestions (gitea#488)`);
    }

    // The user's last message is echoed verbatim on the strong-refusal calls.
    assert.equal(calls[2].payload.last_user_message, 'Open a PR with what we have');
    assert.equal(calls[3].payload.last_user_message, 'Open a PR with what we have');
    // Soft envelope (call 1, call 2) does NOT carry last_user_message — keeps the
    // legacy shape stable for any callers still inspecting only `error`.
    assert.equal(calls[0].payload.last_user_message, undefined);
    assert.equal(calls[1].payload.last_user_message, undefined);
});

/* -------------------------------------------------------------------------- */
/* Edge cases                                                                 */
/* -------------------------------------------------------------------------- */

test('lastUserMessage trimmed/empty: not echoed', () => {
    const a = buildRefusalPayload('list_dirty_files', 3, { lastUserMessage: '' });
    assert.equal(a.last_user_message, undefined,
        'empty user message must not pollute the payload');

    const b = buildRefusalPayload('list_dirty_files', 3, {
        // no lastUserMessage at all
    });
    assert.equal(b.last_user_message, undefined);
});

test('opts absent entirely: still produces a valid envelope', () => {
    // The dispatch path always supplies opts, but the function is documented
    // to accept a missing opts bag for testability and future call sites.
    const out = buildRefusalPayload('list_dirty_files', 3);
    assert.equal(out._refused, true);
    assert.match(out.error, /^STOP\./);
    assert.equal(out.suggestions, undefined);
    assert.equal(out.last_user_message, undefined);
});
