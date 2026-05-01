/**
 * Browser tests for js/profiles/ — the 1.1.0 scaffolding.
 *
 * Mirrors `tests/test-profiles.mjs` (which uses node:test) using the
 * in-page T mini-framework. The profile modules import nothing
 * side-effecting (no DOM, no Storage, no fetch) — both files exercise
 * the same pure functions.
 */
import {
    createTaskLedger,
    isTaskLedger,
    DEFAULT_LEDGER_CAPACITY,
    isProfile,
    CODER_V1,
} from '../js/profiles/index.js';

const { T } = window;

T.suite('Profiles — createTaskLedger empty-state shape');

const fixedClock = 1700000000000;
const led1 = createTaskLedger({ taskId: 't-1', surface: 'coder.v1', startedAt: fixedClock });
T.eq(led1.task_id, 't-1', 'task_id roundtrips');
T.eq(led1.surface, 'coder.v1', 'surface roundtrips');
T.eq(led1.started_at, fixedClock, 'started_at honors override');
T.deepEq(led1.admissions, [], 'admissions starts empty');
T.deepEq(led1.exclusions, [], 'exclusions starts empty');
T.deepEq(led1.tool_admissions, [], 'tool_admissions starts empty');
T.deepEq(led1.tool_invocations, [], 'tool_invocations starts empty');
T.eq(led1.capacity, DEFAULT_LEDGER_CAPACITY, 'capacity defaults to 500');

const before = Date.now();
const led2 = createTaskLedger({ taskId: 't-2', surface: 'coder.v1' });
const after = Date.now();
T.assert(led2.started_at >= before && led2.started_at <= after, 'started_at falls back to Date.now()');

T.eq(createTaskLedger({ taskId: 't-3', surface: 'coder.v1', capacity: 50 }).capacity, 50, 'custom capacity respected');
T.eq(createTaskLedger({ taskId: 't-4', surface: 'coder.v1', capacity: 0 }).capacity, DEFAULT_LEDGER_CAPACITY, 'zero capacity falls back');
T.eq(createTaskLedger({ taskId: 't-5', surface: 'coder.v1', capacity: -10 }).capacity, DEFAULT_LEDGER_CAPACITY, 'negative capacity falls back');

T.throws(() => createTaskLedger({ surface: 'coder.v1' }), 'missing taskId throws');
T.throws(() => createTaskLedger({ taskId: '', surface: 'coder.v1' }), 'empty taskId throws');
T.throws(() => createTaskLedger({ taskId: 't', surface: '' }), 'empty surface throws');
T.throws(() => createTaskLedger({ taskId: 't' }), 'missing surface throws');

T.suite('Profiles — isTaskLedger type guard');

T.eq(isTaskLedger(led1), true, 'accepts valid ledger');
T.eq(isTaskLedger(null), false, 'rejects null');
T.eq(isTaskLedger(undefined), false, 'rejects undefined');
T.eq(isTaskLedger(0), false, 'rejects number');
T.eq(isTaskLedger('ledger'), false, 'rejects string');
T.eq(isTaskLedger({}), false, 'rejects empty object');
T.eq(isTaskLedger({ ...led1, admissions: undefined }), false, 'rejects shape missing admissions[]');
T.eq(isTaskLedger({ ...led1, started_at: 'now' }), false, 'rejects wrong-type started_at');

T.suite('Profiles — CODER_V1 conformance');

T.eq(isProfile(CODER_V1), true, 'CODER_V1 satisfies isProfile');
T.eq(CODER_V1.name, 'coder.v1', 'name is canonical');
T.eq(CODER_V1.version, '1', 'version is "1"');
T.eq(CODER_V1.base, null, 'no base profile yet (chat.v1 base arrives with 2.0)');

T.suite('Profiles — CODER_V1 budget shape');

const b = CODER_V1.budget;
T.eq(b.total_tokens, 32000, 'total_tokens 32000 (chat.v1 baseline)');
T.eq(b.system_reserve, 2000, 'system_reserve 2000');
T.eq(b.output_reserve, 8000, 'output_reserve 8000 (coder override)');
T.eq(b.history_reserve, 8000, 'history_reserve 8000');
T.eq(b.memory_reserve, 1500, 'memory_reserve 1500 (coder override)');
const residual = b.total_tokens - (b.system_reserve + b.output_reserve + b.history_reserve + b.memory_reserve);
T.eq(residual, 12500, 'retrieval residual is 12500');

T.suite('Profiles — CODER_V1 retrieval mirrors current behavior');

const r = CODER_V1.retrieval;
T.eq(r.strategy_weights.semantic, 1.0, 'semantic weight 1.0 (current single strategy)');
T.eq(r.strategy_weights.structural, 0.0, 'structural weight 0.0 until 1.5.0');
T.eq(r.strategy_weights.thematic, 0.0, 'thematic weight 0.0 until 1.5.0');
T.deepEq(r.chunkers, [], 'chunkers empty until 1.5.0');
T.deepEq(r.metadata_extensions, [], 'metadata_extensions empty until 1.5.0');
T.assert(r.novelty_threshold >= 0 && r.novelty_threshold <= 1, 'novelty_threshold in [0,1]');

T.suite('Profiles — CODER_V1 memory + compression + tools');

T.eq(CODER_V1.memory.default_scope, 'session', 'memory default_scope is session (current scratchpad)');
T.eq(CODER_V1.memory.propose_after_n_turns, null, 'no automatic proposals until 1.3.0 consent UI');

const c = CODER_V1.compression;
T.eq(c.rules.length, 3, 'Rules 1, 2, 5 registered (1.2.0)');
T.deepEq(c.rules.map(r => r.name), ['subsumption', 'invalidation', 'summarization'], 'rule names in priority order');
T.deepEq(c.rules.map(r => r.priority), [10, 20, 50], 'priorities lowest-first');
T.eq(c.preserve_recent, 24, 'preserve_recent kept at 24 — see coder-v1.js for reconciliation note vs DESIGN start-at-4');
T.assert(!!c.summarizer, 'summarizer present');
T.eq(c.summarizer.mode, 'balanced', 'summarizer mode matches default');

T.eq(CODER_V1.tools.budget_tokens, 5000, 'tool budget 5000 per ROADMAP §Decisions 5');
T.deepEq(CODER_V1.tools.catalog, [], 'tools.catalog scaffold (Phase 1 doesn\'t populate yet)');
T.deepEq(CODER_V1.tools.static, [
    'list_tool_categories',
    'list_tools_by_category',
    'find_tool',
    'read_file',
    'read_lines',
    'scan_file',
    'edit_file',
    'commit_files',
    'list_dirty_files',
    'get_ci_status',
    'wait_for_ci',
    'get_ci_logs',
], 'tools.static populated by 1.3.4 / 1.4.0 / 1.4.5');
T.eq(CODER_V1.tools.expansion_mode, 'short', 'lazy schema short by default');

T.suite('Profiles — CODER_V1 task ledger config');

const tl = CODER_V1.task_ledger;
T.eq(tl.enabled, true, 'task ledger enabled for coder');
T.eq(tl.capacity, 500, 'capacity 500 per design');
T.assert(tl.novelty_threshold >= 0 && tl.novelty_threshold <= 1, 'novelty_threshold in [0,1]');

T.suite('Profiles — cross-module consistency');

const ledFromProfile = createTaskLedger({
    taskId: 'task-from-coder',
    surface: CODER_V1.name,
    capacity: CODER_V1.task_ledger.capacity,
});
T.eq(ledFromProfile.capacity, 500, 'createTaskLedger forwards CODER_V1.task_ledger.capacity');
T.eq(ledFromProfile.surface, 'coder.v1', 'createTaskLedger forwards CODER_V1.name');

T.eq(isProfile({ ...CODER_V1, retrieval: undefined }), false, 'isProfile rejects partial CODER_V1 (guard sanity)');
