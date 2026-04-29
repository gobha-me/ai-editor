/**
 * AI Editor — Metadata coverage probe
 *
 * Read-only consistency check that counts how many history turns are missing
 * each enrichment field added in PR #170 (`tool_name`, `tool_args`,
 * `tool_result_for`, `file_ops`).
 *
 * Per docs/ROADMAP.md §1.1.0: surfaces in dev mode (?debug=metadata). Tells
 * 1.2.0 what its baseline coverage is *before* compression rules consult the
 * data, so when a rule underperforms its target we can distinguish "no rule
 * applied" from "rule skipped because metadata absent."
 *
 * Pure: no imports from State, Storage, EventBus, or DOM. The pipeline that
 * decides whether to log is at the call site (js/chat/index.js); this module
 * computes only.
 */

/**
 * @typedef {Object} CoverageReport
 * @property {number} total_turns
 * @property {number} tool_result_turns
 * @property {{tool_name: number, tool_args: number, tool_result_for: number, file_ops: number}} present
 *   — count of tool-result turns that have each field present
 * @property {{tool_name: number, tool_args: number, tool_result_for: number, file_ops: number}} missing
 *   — count of tool-result turns missing each field
 * @property {{user: number, assistant: number, tool: number, system: number, other: number}} by_role
 * @property {{tool_name: number, tool_args: number, tool_result_for: number, file_ops: number}} coverage_pct
 *   — `present / tool_result_turns * 100`, rounded to 1 decimal; 0 when no tool-result turns
 * @property {Array<{index: number, tool_call_id: string|null, has_tool_name: boolean, has_tool_args: boolean, has_tool_result_for: boolean, has_file_ops: boolean}>} samples
 *   — one row per tool-result turn (capped by `sampleLimit`) for `console.table` display
 */

const FIELDS = ['tool_name', 'tool_args', 'tool_result_for', 'file_ops'];

function _hasField(turn, field) {
    if (!turn || typeof turn !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(turn, field)) return false;
    const v = turn[field];
    if (v === undefined || v === null) return false;
    // tool_args is an object (may be {}); file_ops is an array (may be []).
    // Both empty values are valid presence indicators per turn-enrich.js.
    return true;
}

/**
 * Compute a metadata-coverage report for a chat history.
 *
 * @param {Array<object>} history - chat-history turn array (read-only)
 * @param {{sampleLimit?: number}} [opts]
 * @returns {CoverageReport}
 */
export function probeMetadataCoverage(history, opts = {}) {
    const sampleLimit = typeof opts.sampleLimit === 'number' ? opts.sampleLimit : 20;
    const turns = Array.isArray(history) ? history : [];

    const by_role = { user: 0, assistant: 0, tool: 0, system: 0, other: 0 };
    const present = { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 };
    const samples = [];

    let tool_result_turns = 0;

    for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        const role = t && typeof t === 'object' ? t.role : null;

        if (role === 'user') by_role.user++;
        else if (role === 'assistant') by_role.assistant++;
        else if (role === 'tool') by_role.tool++;
        else if (role === 'system') by_role.system++;
        else by_role.other++;

        if (role !== 'tool') continue;

        tool_result_turns++;
        const flags = {};
        for (const f of FIELDS) {
            const has = _hasField(t, f);
            flags['has_' + f] = has;
            if (has) present[f]++;
        }

        if (samples.length < sampleLimit) {
            samples.push({
                index: i,
                tool_call_id: (t && t.tool_call_id) || null,
                ...flags,
            });
        }
    }

    const missing = {};
    const coverage_pct = {};
    for (const f of FIELDS) {
        missing[f] = tool_result_turns - present[f];
        coverage_pct[f] = tool_result_turns === 0
            ? 0
            : Math.round((present[f] / tool_result_turns) * 1000) / 10;
    }

    return {
        total_turns: turns.length,
        tool_result_turns,
        present,
        missing,
        by_role,
        coverage_pct,
        samples,
    };
}

/**
 * One-line human summary suitable for `console.info`.
 * @param {CoverageReport} report
 * @returns {string}
 */
export function summarizeCoverage(report) {
    if (!report || report.tool_result_turns === 0) {
        return `[metadata-probe] ${report?.total_turns ?? 0} turns, 0 tool-result turns — nothing to measure`;
    }
    const pcts = FIELDS.map(f => `${f}=${report.coverage_pct[f]}%`).join(' · ');
    return `[metadata-probe] ${report.total_turns} turns, ${report.tool_result_turns} tool-result · ${pcts}`;
}
