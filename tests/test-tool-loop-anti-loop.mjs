/**
 * Regression — same-tool streak guard (gitea#496).
 *
 * Pre-2.86.0 the duplicate-streak guard was keyed by `(toolName, canonicalArgsKey(args))`,
 * so a model that varied one byte of arguments per call (e.g. `read_file({path:'foo.js'})`
 * → `read_file({path:'foo.js', limit:100})` → `read_file({path:'foo.js', limit:200})`)
 * never repeated the exact cacheKey. `isDup` stayed false, the streak reset to 0,
 * and the refusal envelope was never built. Field replay: qwen-3-6-plus on
 * 2.84.0 looped planning → read → re-read indefinitely (gitea#496).
 *
 * 2.86.0 adds a sibling counter — `sameToolStreak` — keyed by tool name alone,
 * tripping at `SAME_TOOL_REFUSE_THRESHOLD = 5`. When that streak fires alone
 * (i.e. exact-args streak did NOT also fire), the loop passes
 * `opts.variedArgs = true` to `buildRefusalPayload` so the envelope prose
 * swaps "identical args" for "varying args" and the second off-ramp from
 * "change at least one argument" to "call a different tool entirely."
 *
 * This module pins:
 *   - the `variedArgs: true` path produces accurate prose (no "identical args" lie)
 *   - the existing `variedArgs` absent / false path is unchanged (back-compat)
 *   - the streak-progression algorithm refuses on the 5th consecutive same-name
 *     call regardless of arg variation, and not earlier
 *   - a different tool name resets the same-tool streak
 *   - the args-exact streak (threshold 3) still trips first on the cleaner
 *     identical-args case
 *
 * Runs under `node --test`. No browser globals; mirrors the pure-Node shape of
 * `test-tool-loop-suggestions.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRefusalPayload } from '../js/chat/refusal-hints.js';

/* -------------------------------------------------------------------------- */
/* Spec 1 — variedArgs:true prose accuracy (no "identical args" lie)           */
/* -------------------------------------------------------------------------- */

test('variedArgs:true at strong threshold: prose says "varying args", off-ramp says "call a different tool"', () => {
    const out = buildRefusalPayload('read_file', 5, { variedArgs: true });
    assert.equal(out._refused, true);
    // Truthful prose — does NOT claim "identical args" when only same-name fired.
    assert.match(out.error, /with varying args/);
    assert.doesNotMatch(out.error, /identical args/,
        'variedArgs:true must NOT include the misleading "identical args" phrase');
    // Imperative STOP framing carries over from the existing path.
    assert.match(out.error, /^STOP\./);
    assert.match(out.error, /5 consecutive times/);
    assert.match(out.error, /read_file/);
    // Off-ramps appropriate for the varied-args trigger:
    assert.match(out.error, /Respond to the user/,
        'first off-ramp (respond) still surfaces');
    assert.match(out.error, /call a different tool entirely/,
        'second off-ramp swaps from "change one argument" to "different tool"');
    assert.doesNotMatch(out.error, /change at least one argument/,
        'the identical-args off-ramp must NOT appear when args already varied');
    // Final do-not-retry line is adjusted too.
    assert.match(out.error, /Do not call read_file again/);
    assert.match(out.error, /varying args has not produced progress/);
    assert.doesNotMatch(out.error, /these arguments/,
        '"these arguments" implies a specific call shape; varied path must not say this');
});

test('variedArgs:true below threshold: soft prefix still uses "varying args"', () => {
    for (const streak of [1, 2]) {
        const out = buildRefusalPayload('read_file', streak, { variedArgs: true });
        assert.equal(out._refused, true);
        assert.match(out.error, /^REFUSED: read_file called/);
        assert.match(out.error, /with varying args/);
        assert.doesNotMatch(out.error, /identical args/);
    }
});

/* -------------------------------------------------------------------------- */
/* Spec 2 — variedArgs:false / undefined preserves legacy text (back-compat)  */
/* -------------------------------------------------------------------------- */

test('variedArgs:false: identical-args prose unchanged (test-tool-loop-suggestions pins this)', () => {
    const a = buildRefusalPayload('list_dirty_files', 3);
    const b = buildRefusalPayload('list_dirty_files', 3, { variedArgs: false });
    assert.match(a.error, /with identical args/);
    assert.match(a.error, /change at least one argument/);
    assert.match(a.error, /Do not call list_dirty_files again with these arguments/);
    // Explicit false matches default.
    assert.equal(a.error, b.error, 'variedArgs:false equals omitting the flag');
});

/* -------------------------------------------------------------------------- */
/* Spec 3 — same-tool streak algorithm (mirrors tool-loop-core.js logic)      */
/* -------------------------------------------------------------------------- */

const SAME_TOOL_REFUSE_THRESHOLD = 5;
const DUP_REFUSE_THRESHOLD = 3;

/**
 * Tiny algorithm fixture mirroring the in-loop state. Drift here would
 * silently un-pin the threshold values; pin them via the constants above.
 */
function simulateLoop(calls) {
    let lastInvokedToolName = null;
    let sameToolStreak = 0;
    const exactArgsStreak = new Map();
    const cacheByKey = new Map();
    const out = [];

    for (const { tool, args } of calls) {
        const cacheKey = `${tool}|${JSON.stringify(args)}`;
        const isDup = cacheByKey.has(cacheKey);
        const argsStreak = isDup ? (exactArgsStreak.get(cacheKey) || 0) + 1 : 0;
        exactArgsStreak.set(cacheKey, argsStreak);

        if (tool === lastInvokedToolName) {
            sameToolStreak++;
        } else {
            sameToolStreak = 1;
        }
        lastInvokedToolName = tool;

        const exactArgsRefuse = isDup && argsStreak >= DUP_REFUSE_THRESHOLD;
        const sameToolRefuse = sameToolStreak >= SAME_TOOL_REFUSE_THRESHOLD;
        const refused = exactArgsRefuse || sameToolRefuse;
        const variedArgs = sameToolRefuse && !exactArgsRefuse;

        if (!refused) {
            // Treat as successful execution; populate the cache so subsequent
            // identical calls trip the args-exact streak path.
            cacheByKey.set(cacheKey, { ok: true });
        }
        out.push({
            tool, args, refused, exactArgsRefuse, sameToolRefuse,
            variedArgs, sameToolStreak, argsStreak,
        });
    }
    return out;
}

test('gitea#496: 5 read_file calls with varying args → 5th call refused via same-tool streak', () => {
    const trace = simulateLoop([
        { tool: 'read_file', args: { path: 'a.js' } },
        { tool: 'read_file', args: { path: 'a.js', limit: 100 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 200 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 300 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 400 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 500 } },
    ]);
    // Calls 1-4: not refused (streak 1, 2, 3, 4).
    for (let i = 0; i < 4; i++) {
        assert.equal(trace[i].refused, false,
            `call ${i + 1} (sameToolStreak=${trace[i].sameToolStreak}) must NOT refuse`);
    }
    // Call 5: refused — sameToolStreak hits threshold 5.
    assert.equal(trace[4].refused, true, 'call 5 must refuse');
    assert.equal(trace[4].sameToolRefuse, true, 'call 5 refusal source = same-tool');
    assert.equal(trace[4].exactArgsRefuse, false, 'call 5 was NOT exact-args (args varied)');
    assert.equal(trace[4].variedArgs, true,
        'call 5 sets variedArgs:true → envelope says "varying args"');
    // Call 6: still refused; streak keeps climbing.
    assert.equal(trace[5].refused, true);
    assert.equal(trace[5].sameToolStreak, 6);
});

test('threshold boundary: 4 same-name calls do NOT refuse, 5 do', () => {
    const four = simulateLoop(Array.from({ length: 4 }, (_, i) => ({
        tool: 'search_in_files',
        args: { query: `term${i}` },
    })));
    assert.equal(four[3].refused, false, '4 consecutive must NOT refuse');
    assert.equal(four[3].sameToolStreak, 4);

    const five = simulateLoop(Array.from({ length: 5 }, (_, i) => ({
        tool: 'search_in_files',
        args: { query: `term${i}` },
    })));
    assert.equal(five[4].refused, true, '5 consecutive MUST refuse');
    assert.equal(five[4].variedArgs, true);
});

test('different tool name resets the same-tool streak', () => {
    const trace = simulateLoop([
        { tool: 'read_file', args: { path: 'a.js' } },
        { tool: 'read_file', args: { path: 'a.js', limit: 100 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 200 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 300 } },
        // Reset:
        { tool: 'list_files', args: { dir: '.' } },
        // Streak restarts:
        { tool: 'read_file', args: { path: 'a.js', limit: 400 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 500 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 600 } },
        { tool: 'read_file', args: { path: 'a.js', limit: 700 } },
    ]);
    // After the list_files reset, read_file streak restarts at 1 and grows
    // to 4 — should NOT refuse (4 < 5).
    assert.equal(trace[4].sameToolStreak, 1, 'list_files resets the streak');
    assert.equal(trace[8].sameToolStreak, 4,
        'read_file streak after reset reaches only 4');
    for (const row of trace) {
        assert.equal(row.refused, false, `${row.tool} must not refuse in this trace`);
    }
});

test('args-exact streak (threshold 3) still trips before same-tool (threshold 5)', () => {
    const trace = simulateLoop([
        { tool: 'read_file', args: { path: 'a.js' } },
        { tool: 'read_file', args: { path: 'a.js' } },  // exact dup, streak=1
        { tool: 'read_file', args: { path: 'a.js' } },  // exact dup, streak=2
        { tool: 'read_file', args: { path: 'a.js' } },  // exact dup, streak=3 → REFUSE
    ]);
    // Call 1: no cache → no dup; not refused.
    assert.equal(trace[0].refused, false);
    // Calls 2-3: exact-args streak grows but threshold = 3 only at the 3rd dup.
    assert.equal(trace[3].refused, true, 'exact-args refusal at args-streak=3');
    assert.equal(trace[3].exactArgsRefuse, true);
    assert.equal(trace[3].sameToolRefuse, false,
        'sameToolStreak=4 also tripped — both gates fire on this exact call');
    // Wait — both fire here, but variedArgs is set only when ONLY same-tool fired.
    // Confirm the gate priority: exactArgsRefuse wins for variedArgs assignment.
    assert.equal(trace[3].variedArgs, false,
        'when both gates fire, variedArgs=false (existing prose is accurate)');
});

test('same-tool refuses BEFORE exact-args when args genuinely vary', () => {
    // 5 same-name calls, all with different args — same-tool fires; exact-args never does.
    const trace = simulateLoop(Array.from({ length: 5 }, (_, i) => ({
        tool: 'read_file',
        args: { path: 'a.js', limit: i * 100 },
    })));
    assert.equal(trace[4].refused, true);
    assert.equal(trace[4].sameToolRefuse, true);
    assert.equal(trace[4].exactArgsRefuse, false);
    assert.equal(trace[4].variedArgs, true,
        'when ONLY same-tool fires, variedArgs:true → envelope says "varying args"');
});
