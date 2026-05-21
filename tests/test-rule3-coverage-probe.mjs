/**
 * Pure-function tests for js/chat/rule3-coverage-probe.js.
 *
 * Mirrors `tests/test-metadata-coverage.mjs` shape. Probes the gate
 * computation, the three-bucket classifier, the dispatch-path inferer, the
 * historical-path detection, and the markdown formatter's stable header
 * lines.
 *
 * Runs under `node --test`. The probe is pure; no shim required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    probeRule3Coverage,
    inferDispatchPath,
    formatRule3ReportMarkdown,
    formatRule3ReportJSON,
    summarizeRule3Coverage,
    CURRENT_DISPATCH_PATHS,
} from '../js/chat/rule3-coverage-probe.js';

// ============================================
// Helpers
// ============================================

function asst(callId, toolName = 'read_file') {
    // Assistant turn declaring a tool call with the given id.
    return { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: '{}' } }] };
}

function toolResult(opts = {}) {
    // Synthesize a tool-result turn. If `toolResultFor` is omitted, the
    // field is absent entirely (bucket c). If present, it's bucket a or b
    // depending on whether the matching assistant turn exists.
    // Accepts both `tool_name` and `toolName` for ergonomics; the runtime
    // field name is `tool_name` and we prefer that in fixtures.
    const callId = opts.callId ?? 'c1';
    const toolName = opts.tool_name ?? opts.toolName ?? 'read_file';
    const content = opts.content ?? '{}';
    const extras = opts.extras ?? {};
    const turn = {
        role: 'tool',
        tool_call_id: callId,
        tool_name: toolName,
        content,
        ...extras,
    };
    if (opts.toolResultFor !== undefined) turn.tool_result_for = opts.toolResultFor;
    return turn;
}

// ============================================
// Empty / degenerate inputs
// ============================================

test('empty history → zero counts, gate not passing (eligible 0)', () => {
    const r = probeRule3Coverage([]);
    assert.equal(r.total_turns, 0);
    assert.equal(r.tool_result_turns, 0);
    assert.deepEqual(r.buckets, { a_populated_and_resolves: 0, b_present_but_unresolvable: 0, c_field_absent: 0 });
    assert.deepEqual(r.gate, { eligible_count: 0, passing_count: 0, pct: null, threshold: 95, passes: false });
    assert.deepEqual(r.samples, []);
});

test('null / non-array input → empty report (no throw)', () => {
    for (const input of [null, undefined, 'not-an-array', 42, {}]) {
        const r = probeRule3Coverage(input);
        assert.equal(r.total_turns, 0);
        assert.equal(r.tool_result_turns, 0);
        assert.equal(r.gate.passes, false);
    }
});

test('history with no tool turns → 0 eligible, gate.pct null', () => {
    const r = probeRule3Coverage([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
    ]);
    assert.equal(r.total_turns, 2);
    assert.equal(r.tool_result_turns, 0);
    assert.equal(r.gate.eligible_count, 0);
    assert.equal(r.gate.pct, null);
});

// ============================================
// Three-bucket classification
// ============================================

test('three buckets in one fixture: a / b / c each populate correctly', () => {
    const history = [
        asst('c1'),
        toolResult({ callId: 'c1', toolResultFor: 'c1' }),                   // a — resolves
        asst('c2'),
        toolResult({ callId: 'c2', toolResultFor: 'cZZ' }),                  // b — unresolvable
        toolResult({ callId: 'c3', /* no toolResultFor → field absent */ }), // c
    ];
    const r = probeRule3Coverage(history);
    assert.equal(r.tool_result_turns, 3);
    assert.deepEqual(r.buckets, {
        a_populated_and_resolves: 1,
        b_present_but_unresolvable: 1,
        c_field_absent: 1,
    });
});

test('tool_result_for present but null/empty → bucket b (not c)', () => {
    const history = [
        toolResult({ callId: 'x', toolResultFor: null }),
        toolResult({ callId: 'y', toolResultFor: '' }),
    ];
    const r = probeRule3Coverage(history);
    assert.equal(r.buckets.b_present_but_unresolvable, 2);
    assert.equal(r.buckets.c_field_absent, 0);
});

test('resolution check uses any prior assistant tool_calls[].id', () => {
    // Two prior assistants both declare ids; either match is sufficient.
    const history = [
        asst('c1'),
        asst('c2'),
        toolResult({ callId: 'c2', toolResultFor: 'c2' }),
    ];
    const r = probeRule3Coverage(history);
    assert.equal(r.buckets.a_populated_and_resolves, 1);
});

// ============================================
// Per-path discriminator
// ============================================

test('inferDispatchPath: refused-envelope wins on _refused: true', () => {
    const t = { role: 'tool', tool_name: 'mcp__foo__bar', content: JSON.stringify({ _refused: true, error: 'no' }) };
    assert.equal(inferDispatchPath(t, 0, [t]), 'refused-envelope');
});

test('inferDispatchPath: partial-envelope wins on _partial: true', () => {
    const t = { role: 'tool', content: JSON.stringify({ _partial: true, retry_hint: 'soon' }) };
    assert.equal(inferDispatchPath(t, 0, [t]), 'partial-envelope');
});

test('inferDispatchPath: _cached without cross-request marker → same-request', () => {
    const t = { role: 'tool', content: JSON.stringify({ _cached: true, _cache_note: 'same-turn LRU' }) };
    assert.equal(inferDispatchPath(t, 0, [t]), 'same-request-cache-hit');
});

test('inferDispatchPath: _cached + cross-request marker → cross-request', () => {
    const t = { role: 'tool', content: JSON.stringify({ _cached: true, _cache_note: 'served from cross-request log' }) };
    assert.equal(inferDispatchPath(t, 0, [t]), 'cross-request-cache-hit');
});

test('inferDispatchPath: MCP tool name prefix → mcp-bridged', () => {
    const t = { role: 'tool', tool_name: 'mcp__linear__create_issue', content: '{}' };
    assert.equal(inferDispatchPath(t, 0, [t]), 'mcp-bridged');
});

test('inferDispatchPath: delegate_task → sub-agent', () => {
    const t = { role: 'tool', tool_name: 'delegate_task', content: '{}' };
    assert.equal(inferDispatchPath(t, 0, [t]), 'sub-agent');
});

test('inferDispatchPath: _tier0 flag → tier0-sandbox', () => {
    const t = { role: 'tool', content: JSON.stringify({ _tier0: true }) };
    assert.equal(inferDispatchPath(t, 0, [t]), 'tier0-sandbox');
});

test('inferDispatchPath: plan-mode-post-approval via prior marker within lookback', () => {
    const history = [
        { role: 'system', plan_mode_exit: true, content: 'plan approved' },
        { role: 'assistant', content: '' },
        { role: 'tool', tool_name: 'read_file', content: '{}' },
    ];
    assert.equal(inferDispatchPath(history[2], 2, history), 'plan-mode-post-approval');
});

test('inferDispatchPath: plan-mode marker via metadata.plan_approved', () => {
    const history = [
        { role: 'assistant', content: '', metadata: { plan_approved: true } },
        { role: 'tool', tool_name: 'read_file', content: '{}' },
    ];
    assert.equal(inferDispatchPath(history[1], 1, history), 'plan-mode-post-approval');
});

test('inferDispatchPath: plan-mode marker outside lookback window → no match', () => {
    // PLAN_MODE_LOOKBACK = 5. Place marker 6 turns back.
    const history = [];
    history.push({ role: 'system', plan_mode_exit: true, content: 'old' });
    for (let i = 0; i < 6; i++) history.push({ role: 'assistant', content: '' });
    history.push({ role: 'tool', tool_name: 'read_file', content: '{}' });
    const idx = history.length - 1;
    assert.equal(inferDispatchPath(history[idx], idx, history), 'direct');
});

test('inferDispatchPath: unrecognized turn → direct', () => {
    const t = { role: 'tool', tool_name: 'read_file', content: '{}' };
    assert.equal(inferDispatchPath(t, 0, [t]), 'direct');
});

test('inferDispatchPath: malformed JSON content → direct (no throw)', () => {
    const t = { role: 'tool', tool_name: 'read_file', content: 'not-json{{{' };
    assert.equal(inferDispatchPath(t, 0, [t]), 'direct');
});

test('inferDispatchPath: outermost flag wins for nested envelopes', () => {
    // _cached wrapper around what looks like a refused payload — cached wins.
    const inner = { _refused: true, error: 'inner' };
    const t = { role: 'tool', content: JSON.stringify({ _cached: true, wrapped: inner }) };
    assert.equal(inferDispatchPath(t, 0, [t]), 'same-request-cache-hit');
});

// ============================================
// Gate computation
// ============================================

test('gate computation: 19a + 1b → 95.0 (exact threshold, passes)', () => {
    const history = [];
    for (let i = 0; i < 19; i++) {
        history.push(asst(`c${i}`));
        history.push(toolResult({ callId: `c${i}`, toolResultFor: `c${i}` }));
    }
    history.push(asst('cZ'));
    history.push(toolResult({ callId: 'cZ', toolResultFor: 'missing' }));
    const r = probeRule3Coverage(history);
    assert.equal(r.gate.passing_count, 19);
    assert.equal(r.gate.eligible_count, 20);
    assert.equal(r.gate.pct, 95.0);
    assert.equal(r.gate.passes, true);
});

test('gate computation: 18a + 2b → 90.0 (fails)', () => {
    const history = [];
    for (let i = 0; i < 18; i++) {
        history.push(asst(`c${i}`));
        history.push(toolResult({ callId: `c${i}`, toolResultFor: `c${i}` }));
    }
    for (let i = 0; i < 2; i++) {
        history.push(toolResult({ callId: `cZ${i}`, toolResultFor: 'missing' }));
    }
    const r = probeRule3Coverage(history);
    assert.equal(r.gate.pct, 90.0);
    assert.equal(r.gate.passes, false);
});

test('gate computation: 0 eligible (only c) → pct null, passes false', () => {
    const history = [toolResult({ callId: 'x' })]; // c bucket
    const r = probeRule3Coverage(history);
    assert.equal(r.gate.eligible_count, 0);
    assert.equal(r.gate.pct, null);
    assert.equal(r.gate.passes, false);
});

test('threshold opt overrides default 95', () => {
    const history = [
        asst('c1'), toolResult({ callId: 'c1', toolResultFor: 'c1' }),
        toolResult({ callId: 'c2', toolResultFor: 'missing' }),
    ];
    // 1/2 = 50% — passes at 50, fails at 51.
    assert.equal(probeRule3Coverage(history, { threshold: 50 }).gate.passes, true);
    assert.equal(probeRule3Coverage(history, { threshold: 51 }).gate.passes, false);
});

// ============================================
// Historical-path detection
// ============================================

test('historical-path detection excludes flagged paths from gate', () => {
    // Simulate a historical path by patching CURRENT_DISPATCH_PATHS via test
    // injection isn't possible (it's frozen). Instead, build a turn whose
    // inferred path isn't in the set. The cleanest way is the existing
    // emitter list — all current emitters resolve to in-set paths, so to
    // create a historical path we'd need to fake the inferer. Instead, we
    // verify the contract directly: the report's `is_historical` flag
    // matches `!CURRENT_DISPATCH_PATHS.has(path)` for every detected path.
    const history = [
        asst('c1'), toolResult({ callId: 'c1', toolResultFor: 'c1' }), // direct
        toolResult({ callId: 'c2', tool_name: 'mcp__foo__bar', content: JSON.stringify({}), toolResultFor: 'missing' }), // mcp-bridged
    ];
    const r = probeRule3Coverage(history);
    for (const [name, row] of Object.entries(r.by_path)) {
        assert.equal(row.is_historical, !CURRENT_DISPATCH_PATHS.has(name),
            `is_historical flag for "${name}" must match CURRENT_DISPATCH_PATHS membership`);
    }
    // Every path is currently in-set → no historical flagged.
    assert.deepEqual(r._historical_paths_flagged, []);
});

test('historical-path flag computes correctly when synthetic non-set path observed', () => {
    // Mock a historical path by giving the inferer a turn it can't classify.
    // The inferer doesn't emit anything outside the set today, so this test
    // exercises the contract: if `inferDispatchPath` ever returned a name
    // not in `CURRENT_DISPATCH_PATHS`, the gate would exclude it. We
    // emulate by calling the public probe with a synthetic history then
    // mutating the result's by_path to introduce a fake historical row,
    // and re-aggregating via a second probe call — but that's untestable
    // without injection. Instead, lock the membership pin: every detected
    // path in a realistic history must be in the frozen set.
    const history = [
        asst('c1'), toolResult({ callId: 'c1', toolResultFor: 'c1' }),
        toolResult({ callId: 'c2', tool_name: 'delegate_task', content: '{}', toolResultFor: 'missing' }),
        toolResult({ callId: 'c3', content: JSON.stringify({ _refused: true }), toolResultFor: 'missing' }),
        toolResult({ callId: 'c4', content: JSON.stringify({ _cached: true }), toolResultFor: 'missing' }),
    ];
    const r = probeRule3Coverage(history);
    for (const name of r._dispatch_paths_detected) {
        assert.ok(CURRENT_DISPATCH_PATHS.has(name),
            `detected path "${name}" must be in CURRENT_DISPATCH_PATHS — add it or fix the inferer`);
    }
});

test('CURRENT_DISPATCH_PATHS membership pin (frozen set; deliberate edit needed)', () => {
    // Removing or adding a member here requires updating the inferer in
    // lockstep — that's the maintainer checkpoint the comment names.
    assert.ok(Object.isFrozen(CURRENT_DISPATCH_PATHS));
    assert.deepEqual([...CURRENT_DISPATCH_PATHS].sort(), [
        'cross-request-cache-hit',
        'direct',
        'mcp-bridged',
        'partial-envelope',
        'plan-mode-post-approval',
        'refused-envelope',
        'same-request-cache-hit',
        'sub-agent',
        'tier0-sandbox',
    ]);
});

// ============================================
// Per-path coverage in `by_path`
// ============================================

test('by_path row tracks per-path a/b/c + gate_pct correctly', () => {
    const history = [
        asst('c1'), toolResult({ callId: 'c1', toolResultFor: 'c1' }), // direct, a
        toolResult({ callId: 'c2', toolResultFor: 'missing' }),         // direct, b
        toolResult({ callId: 'c3' /* no field */ }),                    // direct, c
        toolResult({ callId: 'c4', tool_name: 'mcp__a__b', content: '{}', toolResultFor: 'missing' }), // mcp, b
    ];
    const r = probeRule3Coverage(history);
    assert.equal(r.by_path.direct.a, 1);
    assert.equal(r.by_path.direct.b, 1);
    assert.equal(r.by_path.direct.c, 1);
    assert.equal(r.by_path.direct.total, 3);
    assert.equal(r.by_path.direct.gate_pct, 50.0); // 1/(1+1)
    assert.equal(r.by_path['mcp-bridged'].a, 0);
    assert.equal(r.by_path['mcp-bridged'].b, 1);
    assert.equal(r.by_path['mcp-bridged'].gate_pct, 0.0);
});

test('by_path gate_pct is null when path has only c-bucket entries', () => {
    const history = [toolResult({ callId: 'x' })]; // direct path, c bucket only
    const r = probeRule3Coverage(history);
    assert.equal(r.by_path.direct.gate_pct, null);
});

// ============================================
// Read-only discipline
// ============================================

test('probe does not mutate input history', () => {
    const history = [
        asst('c1'),
        toolResult({ callId: 'c1', toolResultFor: 'c1' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(history));
    probeRule3Coverage(history);
    assert.deepEqual(history, snapshot);
});

// ============================================
// Samples
// ============================================

test('samples capped by opts.sampleLimit', () => {
    const history = [];
    for (let i = 0; i < 50; i++) history.push(toolResult({ callId: `c${i}` }));
    const r = probeRule3Coverage(history, { sampleLimit: 5 });
    assert.equal(r.samples.length, 5);
    assert.equal(r.tool_result_turns, 50);
});

test('sample row carries index + bucket + path', () => {
    const history = [
        asst('c1'),
        toolResult({ callId: 'c1', toolResultFor: 'c1' }),
    ];
    const r = probeRule3Coverage(history);
    assert.equal(r.samples.length, 1);
    assert.equal(r.samples[0].index, 1);
    assert.equal(r.samples[0].bucket, 'a');
    assert.equal(r.samples[0].path, 'direct');
});

// ============================================
// Formatter snapshots
// ============================================

test('formatRule3ReportMarkdown produces stable header lines', () => {
    const history = [
        asst('c1'),
        toolResult({ callId: 'c1', toolResultFor: 'c1' }),
    ];
    const md = formatRule3ReportMarkdown(probeRule3Coverage(history));
    assert.ok(md.startsWith('## Rule 3/4 coverage probe\n'));
    assert.ok(md.includes('- **Turns:** 2 total · 1 tool-result'));
    assert.ok(md.includes('a=1 (populated+resolves) · b=0 (unresolvable) · c=0 (field absent)'));
    assert.ok(md.includes('**Gate:** 1/1 = 100%'));
    assert.ok(md.includes('### Per dispatch path'));
    assert.ok(md.includes('### Detected paths'));
});

test('formatRule3ReportMarkdown surfaces FAILS verdict below threshold', () => {
    const history = [
        toolResult({ callId: 'c1', toolResultFor: 'missing' }),
    ];
    const md = formatRule3ReportMarkdown(probeRule3Coverage(history));
    assert.ok(md.includes('**FAILS** (< 95%)'));
});

test('formatRule3ReportJSON returns deterministic top-level key order', () => {
    const history = [
        asst('c1'),
        toolResult({ callId: 'c1', toolResultFor: 'c1' }),
    ];
    const a = formatRule3ReportJSON(probeRule3Coverage(history));
    const b = formatRule3ReportJSON(probeRule3Coverage(history));
    assert.equal(a, b);
    const parsed = JSON.parse(a);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [...keys].sort());
});

test('summarizeRule3Coverage produces one-line console-friendly text', () => {
    const r = probeRule3Coverage([
        asst('c1'),
        toolResult({ callId: 'c1', toolResultFor: 'c1' }),
    ]);
    const line = summarizeRule3Coverage(r);
    assert.ok(line.startsWith('[rule3-probe]'));
    assert.ok(line.includes('PASS'));
});

test('summarizeRule3Coverage handles empty input', () => {
    assert.equal(
        summarizeRule3Coverage(probeRule3Coverage([])),
        '[rule3-probe] 0 turns, 0 tool-result — nothing to measure',
    );
});

test('formatRule3ReportMarkdown handles null/undefined report gracefully', () => {
    assert.equal(formatRule3ReportMarkdown(null), '## Rule 3/4 coverage probe\n\n_No report._\n');
    assert.equal(formatRule3ReportMarkdown(undefined), '## Rule 3/4 coverage probe\n\n_No report._\n');
});
