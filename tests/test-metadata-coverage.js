/**
 * Browser tests for js/chat/metadata-probe.js.
 *
 * Mirrors tests/test-metadata-coverage.mjs (which uses node:test) using the
 * in-page T mini-framework. The probe has no DOM/Storage imports — both files
 * exercise the same pure functions.
 */
import { probeMetadataCoverage, summarizeCoverage } from '../js/chat/metadata-probe.js';

const { T } = window;

T.suite('Metadata probe — empty / degenerate inputs');

const empty = probeMetadataCoverage([]);
T.eq(empty.total_turns, 0, 'empty: total_turns is 0');
T.eq(empty.tool_result_turns, 0, 'empty: tool_result_turns is 0');
T.deepEq(empty.coverage_pct, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 }, 'empty: coverage_pct all zero');
T.deepEq(empty.samples, [], 'empty: no samples');

T.eq(probeMetadataCoverage(null).total_turns, 0, 'null input → total_turns 0');
T.eq(probeMetadataCoverage(undefined).total_turns, 0, 'undefined input → total_turns 0');
T.eq(probeMetadataCoverage('not-an-array').total_turns, 0, 'string input → total_turns 0');

const noTools = probeMetadataCoverage([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'system', content: 'sys' },
]);
T.eq(noTools.total_turns, 3, 'no-tools: total_turns counts all roles');
T.eq(noTools.tool_result_turns, 0, 'no-tools: tool_result_turns is 0');
T.deepEq(noTools.by_role, { user: 1, assistant: 1, tool: 0, system: 1, other: 0 }, 'no-tools: by_role correct');

T.suite('Metadata probe — fully enriched (post-#170)');

const enriched = probeMetadataCoverage([
    { role: 'user', content: 'read foo.js' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
    {
        role: 'tool', tool_call_id: 'c1', content: '{}',
        tool_name: 'read_file', tool_args: { path: 'foo.js' },
        tool_result_for: 'c1', file_ops: [{ path: 'foo.js', op: 'read', range: null, content_hash: null }],
    },
]);
T.eq(enriched.tool_result_turns, 1, 'enriched: tool_result_turns is 1');
T.deepEq(enriched.coverage_pct, { tool_name: 100, tool_args: 100, tool_result_for: 100, file_ops: 100 }, 'enriched: 100% across all fields');
T.deepEq(enriched.missing, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 }, 'enriched: nothing missing');

const emptyArgs = probeMetadataCoverage([
    {
        role: 'tool', tool_call_id: 'c1', content: '{}',
        tool_name: 'list_open_tabs', tool_args: {}, tool_result_for: 'c1', file_ops: [],
    },
]);
T.deepEq(emptyArgs.coverage_pct, { tool_name: 100, tool_args: 100, tool_result_for: 100, file_ops: 100 }, 'empty {} args and [] file_ops count as present');

T.suite('Metadata probe — legacy / partial enrichment');

const legacy = probeMetadataCoverage([
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
    { role: 'tool', tool_call_id: 'c2', content: '{}' },
]);
T.deepEq(legacy.coverage_pct, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 }, 'all-legacy: 0% coverage');
T.deepEq(legacy.missing, { tool_name: 2, tool_args: 2, tool_result_for: 2, file_ops: 2 }, 'all-legacy: every field counted as missing');

const mixed = probeMetadataCoverage([
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
    {
        role: 'tool', tool_call_id: 'c2', content: '{}',
        tool_name: 'read_file', tool_args: { path: 'a.js' },
        tool_result_for: 'c2', file_ops: [],
    },
]);
T.deepEq(mixed.coverage_pct, { tool_name: 50, tool_args: 50, tool_result_for: 50, file_ops: 50 }, 'mixed: 50% coverage on every field');

const partial = probeMetadataCoverage([
    {
        role: 'tool', tool_call_id: 'c1', content: '{}',
        tool_name: 'read_file', tool_result_for: 'c1',
        // tool_args + file_ops missing
    },
]);
T.deepEq(partial.present, { tool_name: 1, tool_args: 0, tool_result_for: 1, file_ops: 0 }, 'partial: per-field accounting');

const nullsAreMissing = probeMetadataCoverage([
    {
        role: 'tool', tool_call_id: 'c1', content: '{}',
        tool_name: null, tool_args: null, tool_result_for: null, file_ops: null,
    },
]);
T.deepEq(nullsAreMissing.present, { tool_name: 0, tool_args: 0, tool_result_for: 0, file_ops: 0 }, 'null fields counted as missing');

T.suite('Metadata probe — by_role + samples');

const byRole = probeMetadataCoverage([
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
    { role: 'system', content: 's' },
    { role: 'function', content: 'legacy' },
    { content: 'no role' },
]);
T.deepEq(byRole.by_role, { user: 2, assistant: 1, tool: 1, system: 1, other: 2 }, 'unknown roles → "other"');

const big = (() => {
    const turns = [];
    for (let i = 0; i < 5; i++) turns.push({ role: 'user', content: String(i) });
    for (let i = 0; i < 25; i++) {
        turns.push({
            role: 'tool', tool_call_id: 'c' + i, content: '{}',
            tool_name: 'read_file', tool_args: {}, tool_result_for: 'c' + i, file_ops: [],
        });
    }
    return probeMetadataCoverage(turns);
})();
T.eq(big.tool_result_turns, 25, 'samples cap: tool_result_turns counts all 25');
T.eq(big.samples.length, 20, 'samples cap: only 20 captured');
T.eq(big.samples[0].index, 5, 'samples cap: first sample index is 5 (user prefix)');
T.eq(big.samples[19].index, 24, 'samples cap: last sample index is 24');

const customLimit = probeMetadataCoverage(
    Array.from({ length: 10 }, (_, i) => ({ role: 'tool', tool_call_id: 'c' + i, content: '{}' })),
    { sampleLimit: 3 }
);
T.eq(customLimit.samples.length, 3, 'sampleLimit override respected');

T.deepEq(
    probeMetadataCoverage([{ role: 'tool', tool_call_id: 'c1', content: '{}', tool_name: 'x' }]).samples[0],
    {
        index: 0, tool_call_id: 'c1',
        has_tool_name: true, has_tool_args: false, has_tool_result_for: false, has_file_ops: false,
    },
    'sample row has boolean flags per field'
);

T.suite('Metadata probe — summarizeCoverage');

T.assert(/nothing to measure/.test(summarizeCoverage(probeMetadataCoverage([]))), 'empty report → "nothing to measure"');

const sumAll = summarizeCoverage(probeMetadataCoverage([
    {
        role: 'tool', tool_call_id: 'c1', content: '{}',
        tool_name: 'read_file', tool_args: {}, tool_result_for: 'c1', file_ops: [],
    },
]));
T.assert(/tool_name=100%/.test(sumAll), 'summary includes tool_name=100%');
T.assert(/file_ops=100%/.test(sumAll), 'summary includes file_ops=100%');

T.assert(/nothing to measure/.test(summarizeCoverage(null)), 'null report defensive');
T.assert(/nothing to measure/.test(summarizeCoverage(undefined)), 'undefined report defensive');

T.suite('Metadata probe — read-only discipline');

const original = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
];
const snapshot = JSON.parse(JSON.stringify(original));
probeMetadataCoverage(original);
T.deepEq(original, snapshot, 'probe does not mutate input history');
