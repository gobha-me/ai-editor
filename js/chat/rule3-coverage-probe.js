/**
 * AI Editor — Rule 3/4 coverage measurement probe
 *
 * Walks a chat history, counts `tool_result` turns, and measures how often
 * `metadata.tool_result_for` is (a) populated AND resolves to a real
 * `tool_call`, (b) present but unresolvable, or (c) absent entirely.
 * Breaks down coverage by inferred dispatch path. Output is the evidence
 * Compression Rule 3 (Consumption) and Rule 4 (Resolution) deferrals are
 * gated on — see `docs/ROADMAP.md` §"Parallel work streams" + §"Deferred /
 * parked" → Compression.
 *
 * Sibling of `js/chat/metadata-probe.js`. The existing probe is a
 * frozen-shape 1.1.0-era presence counter on a boot path; this one is a
 * button-triggered Rule 3-gate measurer with extra axes (resolution,
 * dispatch-path inference, historical-path flagging). They share the
 * `_isToolResultTurn` idiom by inline copy.
 *
 * Pure: no imports from State, Storage, EventBus, or DOM. The browser
 * call site (js/debug-slideout.js) handles I/O.
 */

/**
 * The dispatch paths the probe knows about today. Frozen set; maintainers
 * must remove a name when its emitter retires. Observed paths absent from
 * this set are flagged historical (excluded from the gate roll-up).
 *
 * Browser-resident probes cannot grep `js/` at runtime, so this constant is
 * the cross-revision-tolerant signal — compatible with the project's
 * no-build constraint (no codegen, no manifest). The trade-off is that a
 * retired path won't be flagged until this set is edited; that's a
 * deliberate human checkpoint.
 */
export const CURRENT_DISPATCH_PATHS = Object.freeze(new Set([
    'direct',
    'same-request-cache-hit',
    'cross-request-cache-hit',
    'refused-envelope',
    'partial-envelope',
    'sub-agent',
    'tier0-sandbox',
    'plan-mode-post-approval',
    'mcp-bridged',
]));

/** Maximum lookback when probing plan-mode-post-approval markers. */
const PLAN_MODE_LOOKBACK = 5;

/** Default cap on per-turn samples in the report. */
const DEFAULT_SAMPLE_LIMIT = 30;

const CROSS_REQUEST_NOTE_RE = /cross.{0,20}request|across.{0,20}conversation/i;

/**
 * @typedef {Object} Rule3Report
 * @property {number} total_turns
 * @property {number} tool_result_turns
 * @property {{a_populated_and_resolves: number, b_present_but_unresolvable: number, c_field_absent: number}} buckets
 * @property {{eligible_count: number, passing_count: number, pct: number|null, threshold: number, passes: boolean}} gate
 * @property {Object<string, {a: number, b: number, c: number, total: number, gate_pct: number|null, is_historical: boolean}>} by_path
 * @property {string[]} _dispatch_paths_detected
 * @property {string[]} _historical_paths_flagged
 * @property {Array<{index: number, role: string, tool_call_id: string|null, tool_result_for: string|null, bucket: 'a'|'b'|'c', path: string}>} samples
 */

function _isToolResultTurn(turn) {
    return turn && typeof turn === 'object' && turn.role === 'tool';
}

function _parseContentFlags(turn) {
    if (!turn || turn.content == null) return null;
    if (typeof turn.content === 'object') return turn.content;
    if (typeof turn.content !== 'string') return null;
    try {
        const parsed = JSON.parse(turn.content);
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Infer which of the named dispatch paths produced this tool-result turn.
 * First match wins; unrecognized shapes fall through to `'direct'`. Nested
 * envelopes resolve by outermost flag (a `_cached` wrapper around a
 * `_refused` payload reads as cached, not refused — the wrapper records the
 * actual dispatch path that delivered the bytes).
 *
 * @param {object} turn - a `role: 'tool'` history entry
 * @param {number} idx - position of `turn` in `history`
 * @param {Array<object>} history - the full history (for lookback)
 * @returns {string} one of CURRENT_DISPATCH_PATHS or a historical name
 */
export function inferDispatchPath(turn, idx, history) {
    if (!_isToolResultTurn(turn)) return 'direct';
    const flags = _parseContentFlags(turn) || {};

    if (flags._refused === true) return 'refused-envelope';
    if (flags._partial === true) return 'partial-envelope';
    if (flags._cached === true) {
        const note = typeof flags._cache_note === 'string' ? flags._cache_note : '';
        return CROSS_REQUEST_NOTE_RE.test(note)
            ? 'cross-request-cache-hit'
            : 'same-request-cache-hit';
    }
    if (flags._tier0 === true) return 'tier0-sandbox';

    const toolName = turn.tool_name || flags.tool_name || null;
    if (typeof toolName === 'string') {
        if (toolName.startsWith('mcp__')) return 'mcp-bridged';
        if (toolName === 'delegate_task') return 'sub-agent';
    }

    if (Array.isArray(history) && idx > 0) {
        const start = Math.max(0, idx - PLAN_MODE_LOOKBACK);
        for (let j = idx - 1; j >= start; j--) {
            const prev = history[j];
            if (!prev || typeof prev !== 'object') continue;
            if (prev.plan_mode_exit === true) return 'plan-mode-post-approval';
            const meta = prev.metadata;
            if (meta && typeof meta === 'object' && meta.plan_approved === true) {
                return 'plan-mode-post-approval';
            }
        }
    }

    return 'direct';
}

function _collectToolCallIds(history) {
    const map = new Map();
    if (!Array.isArray(history)) return map;
    for (let i = 0; i < history.length; i++) {
        const turn = history[i];
        if (!turn || turn.role !== 'assistant' || !Array.isArray(turn.tool_calls)) continue;
        for (const call of turn.tool_calls) {
            if (call && typeof call === 'object' && typeof call.id === 'string') {
                if (!map.has(call.id)) map.set(call.id, i);
            }
        }
    }
    return map;
}

function _classifyBucket(turn, toolCallIdMap) {
    const hasField = turn && typeof turn === 'object'
        && Object.prototype.hasOwnProperty.call(turn, 'tool_result_for');
    if (!hasField) return 'c';
    const ref = turn.tool_result_for;
    if (typeof ref !== 'string' || ref.length === 0) return 'b';
    return toolCallIdMap.has(ref) ? 'a' : 'b';
}

function _emptyPathRow() {
    return { a: 0, b: 0, c: 0, total: 0, gate_pct: null, is_historical: false };
}

function _round1(n) {
    return Math.round(n * 10) / 10;
}

/**
 * Compute a Rule 3/4 coverage report against a chat history.
 *
 * @param {Array<object>} history - chat-history turn array (read-only)
 * @param {{sampleLimit?: number, threshold?: number}} [opts]
 * @returns {Rule3Report}
 */
export function probeRule3Coverage(history, opts = {}) {
    const sampleLimit = typeof opts.sampleLimit === 'number'
        ? opts.sampleLimit
        : DEFAULT_SAMPLE_LIMIT;
    const threshold = typeof opts.threshold === 'number' ? opts.threshold : 95;
    const turns = Array.isArray(history) ? history : [];

    const toolCallIdMap = _collectToolCallIds(turns);
    const buckets = { a_populated_and_resolves: 0, b_present_but_unresolvable: 0, c_field_absent: 0 };
    /** @type {Object<string, ReturnType<typeof _emptyPathRow>>} */
    const by_path = {};
    /** @type {Rule3Report['samples']} */
    const samples = [];
    let tool_result_turns = 0;

    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        if (!_isToolResultTurn(turn)) continue;
        tool_result_turns++;

        const bucket = _classifyBucket(turn, toolCallIdMap);
        if (bucket === 'a') buckets.a_populated_and_resolves++;
        else if (bucket === 'b') buckets.b_present_but_unresolvable++;
        else buckets.c_field_absent++;

        const path = inferDispatchPath(turn, i, turns);
        if (!by_path[path]) {
            by_path[path] = _emptyPathRow();
            by_path[path].is_historical = !CURRENT_DISPATCH_PATHS.has(path);
        }
        by_path[path][bucket]++;
        by_path[path].total++;

        if (samples.length < sampleLimit) {
            samples.push({
                index: i,
                role: turn.role,
                tool_call_id: typeof turn.tool_call_id === 'string' ? turn.tool_call_id : null,
                tool_result_for: Object.prototype.hasOwnProperty.call(turn, 'tool_result_for')
                    ? (typeof turn.tool_result_for === 'string' ? turn.tool_result_for : null)
                    : null,
                bucket,
                path,
            });
        }
    }

    // Per-path gate percentages.
    for (const row of Object.values(by_path)) {
        const eligible = row.a + row.b;
        row.gate_pct = eligible === 0 ? null : _round1((row.a / eligible) * 100);
    }

    // Aggregate gate excludes historical paths from numerator + denominator.
    let agg_a = 0;
    let agg_b = 0;
    const _historical_paths_flagged = [];
    for (const [name, row] of Object.entries(by_path)) {
        if (row.is_historical) {
            _historical_paths_flagged.push(name);
            continue;
        }
        agg_a += row.a;
        agg_b += row.b;
    }
    const eligible_count = agg_a + agg_b;
    const pct = eligible_count === 0 ? null : _round1((agg_a / eligible_count) * 100);
    const passes = pct !== null && pct >= threshold;

    return {
        total_turns: turns.length,
        tool_result_turns,
        buckets,
        gate: {
            eligible_count,
            passing_count: agg_a,
            pct,
            threshold,
            passes,
        },
        by_path,
        _dispatch_paths_detected: Object.keys(by_path).sort(),
        _historical_paths_flagged: _historical_paths_flagged.sort(),
        samples,
    };
}

/**
 * Stable JSON serialization (sorted top-level keys for snapshot-friendly
 * diffs). The probe's report shape is stable, but `JSON.stringify` walks
 * insertion order — this wrapper sorts at the top level so a report run
 * twice on the same history produces byte-identical output.
 *
 * @param {Rule3Report} report
 * @returns {string}
 */
export function formatRule3ReportJSON(report) {
    if (!report || typeof report !== 'object') return JSON.stringify(report ?? null);
    const ordered = {};
    for (const key of Object.keys(report).sort()) {
        ordered[key] = report[key];
    }
    return JSON.stringify(ordered, null, 2);
}

/**
 * Markdown report suitable for inline rendering in the debug pane and for
 * paste-into-issue flows. Header lines are stable so test snapshots can pin
 * them via string match.
 *
 * @param {Rule3Report} report
 * @returns {string}
 */
export function formatRule3ReportMarkdown(report) {
    if (!report || typeof report !== 'object') return '## Rule 3/4 coverage probe\n\n_No report._\n';

    const lines = [];
    lines.push('## Rule 3/4 coverage probe');
    lines.push('');
    lines.push(`- **Turns:** ${report.total_turns} total · ${report.tool_result_turns} tool-result`);
    const a = report.buckets.a_populated_and_resolves;
    const b = report.buckets.b_present_but_unresolvable;
    const c = report.buckets.c_field_absent;
    lines.push(`- **Buckets:** a=${a} (populated+resolves) · b=${b} (unresolvable) · c=${c} (field absent)`);
    const g = report.gate;
    const pctStr = g.pct === null ? 'n/a' : `${g.pct}%`;
    const verdict = g.eligible_count === 0
        ? '_no eligible turns_'
        : (g.passes ? `**PASSES** (≥ ${g.threshold}%)` : `**FAILS** (< ${g.threshold}%)`);
    lines.push(`- **Gate:** ${g.passing_count}/${g.eligible_count} = ${pctStr} — ${verdict}`);
    lines.push('');

    lines.push('### Per dispatch path');
    lines.push('');
    lines.push('| Path | a | b | c | total | gate % | historical? |');
    lines.push('|---|---:|---:|---:|---:|---:|:---:|');
    const pathNames = Object.keys(report.by_path).sort();
    if (pathNames.length === 0) {
        lines.push('| _none_ | 0 | 0 | 0 | 0 | n/a |  |');
    } else {
        for (const name of pathNames) {
            const row = report.by_path[name];
            const gp = row.gate_pct === null ? 'n/a' : `${row.gate_pct}%`;
            const hist = row.is_historical ? '⚠ yes' : '';
            lines.push(`| ${name} | ${row.a} | ${row.b} | ${row.c} | ${row.total} | ${gp} | ${hist} |`);
        }
    }
    lines.push('');

    lines.push('### Detected paths');
    lines.push('');
    if (report._dispatch_paths_detected.length === 0) {
        lines.push('_none_');
    } else {
        for (const name of report._dispatch_paths_detected) {
            lines.push(`- \`${name}\``);
        }
    }
    lines.push('');

    if (report._historical_paths_flagged.length > 0) {
        lines.push('### ⚠ Historical paths (excluded from gate)');
        lines.push('');
        for (const name of report._historical_paths_flagged) {
            lines.push(`- \`${name}\``);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * One-line human summary suitable for `console.info`.
 * @param {Rule3Report} report
 * @returns {string}
 */
export function summarizeRule3Coverage(report) {
    if (!report || report.tool_result_turns === 0) {
        return `[rule3-probe] ${report?.total_turns ?? 0} turns, 0 tool-result — nothing to measure`;
    }
    const g = report.gate;
    const pctStr = g.pct === null ? 'n/a' : `${g.pct}%`;
    const verdict = g.eligible_count === 0 ? '(no eligible)' : (g.passes ? 'PASS' : 'FAIL');
    return `[rule3-probe] ${report.total_turns} turns, ${report.tool_result_turns} tool-result · gate ${g.passing_count}/${g.eligible_count}=${pctStr} ${verdict}`;
}
