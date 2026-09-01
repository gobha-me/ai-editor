/**
 * Tier 1 synthetic-savings benchmark for Compression Phase 1 (Rules 1+2).
 *
 * Per `docs/ROADMAP.md` §"Cadence and versioning" Decision §8 — measurement
 * before scale: each compression follow-up gates on the previous one
 * delivering measured value. Organic dashboard data on `editor.gobha.ai`
 * accumulates slowly during light usage; this suite runs the SAME
 * Compactor pipeline against deterministic 5-, 10-, 30-, and 50-turn
 * fixtures so the gate's "Rules 1+2 deliver ≥40% reduction on tool-heavy
 * sessions" projection from §1.2.0 can be verified locally, in CI, on
 * every commit — without an API key, without network, without manual
 * stepping through a real chat.
 *
 * Each scenario:
 *   1. Builds a Turn[] with realistic token sizes (read_file ≈ 1.5–7K tok,
 *      edit_file ≈ 50 tok, user/assistant ≈ 50–250 tok).
 *   2. Runs `compress()` with both rules + preserve_recent=2.
 *   3. Asserts `tokens_in`, `tokens_out`, reduction %, eviction count,
 *      and per-rule attribution.
 *   4. `console.log`s the per-scenario savings line so a dev running
 *      `node --test` can read the table.
 *
 * Bounds are tight on both sides — both a regression that *over-evicts*
 * (false-positive cascade) and one that *under-evicts* (rule misses) flag
 * the test. If you change the fixtures or the rules, regenerate the
 * bounds rather than loosening them.
 *
 * Tier 2 (the live `?compression=off` flag + 50-turn deployed-session run)
 * is a separate PR; this suite is the deterministic baseline that Tier 2
 * compares its dashboard numbers against.
 *
 * @since 1.3.0 (kicked in alongside the Memory Phase 1 track to satisfy
 * Decision §8 without waiting on organic usage to accumulate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    compress,
    SUBSUMPTION_RULE,
    INVALIDATION_RULE,
} from '../js/intelligence/compression/index.js';

// ============================================
// Fixture helpers — realistic token sizes
// ============================================

let _seq = 0;
function resetSeq() { _seq = 0; }

/**
 * Build a Turn with explicit token count. Avoids inflating fixture
 * content to thousands of chars; lets us simulate real read_file
 * returns by setting `tokens` directly.
 */
function mkTurn(role, content, metadata, tokens) {
    const id = `T${_seq++}`;
    return {
        id,
        role,
        content: content || '',
        tokens: tokens != null ? tokens : Math.max(1, Math.ceil(((content || '').length) / 3.5)),
        timestamp: _seq,
        metadata: metadata || {},
    };
}

const mkRead  = (path, range, tok) => mkTurn('tool_result', `read ${path}`,  { tool_name: 'read_lines', file_ops: [{ path, op: 'read',  range, content_hash: null }] }, tok);
const mkEdit  = (path, range, tok) => mkTurn('tool_result', `edit ${path}`,  { tool_name: 'edit_file',  file_ops: [{ path, op: 'edit',  range, content_hash: null }] }, tok);
const mkWrite = (path,        tok) => mkTurn('tool_result', `write ${path}`, { tool_name: 'write_file', file_ops: [{ path, op: 'write', range: null, content_hash: null }] }, tok);
const mkUser  = (text, tok) => mkTurn('user',      text, {}, tok);
const mkAsst  = (text, tok) => mkTurn('assistant', text, {}, tok);

/** Realistic byte-size proxy: simulate a `read_file` returning N lines. */
const READ_TOKENS = {
    snippet: 1500,   //  ~50  lines
    medium:  5000,   // ~200 lines
    wide:    7000,   // ~300 lines
    huge:   12000,   // ~500 lines
};

const EDIT_TOK = 50;
const USER_TOK = 50;
const ASST_TOK = 250;

// ============================================
// measure() — run compress + summarize
// ============================================

async function measure(history, opts = {}) {
    const preserve_recent = opts.preserve_recent ?? 2;
    const r = await compress({
        history,
        rules: [SUBSUMPTION_RULE, INVALIDATION_RULE],
        preserve_recent,
        budget_tokens: 1_000_000, // never trip the budget fallback
    });
    const tin  = r.diagnostics.tokens_in;
    const tout = r.diagnostics.tokens_out;
    const reduction_pct = tin > 0 ? 100 * (1 - tout / tin) : 0;
    return {
        result: r,
        tokens_in: tin,
        tokens_out: tout,
        reduction_pct,
        turns_in: history.length,
        turns_out: r.history.length,
        turns_evicted: r.evicted_ids.length,
        by_rule: r.diagnostics.decisions_by_rule,
    };
}

function logSavings(name, m) {
    const arrow = `${m.tokens_in.toLocaleString()} → ${m.tokens_out.toLocaleString()} tok`;
    const turns = `${m.turns_in}→${m.turns_out} turns (${m.turns_evicted} evicted)`;
    console.log(`  [${name}]  ${m.reduction_pct.toFixed(1)}% reduction · ${arrow} · ${turns}`);
}

// ============================================
// Scenario 1 — pure subsumption (Rule 1 only)
// ============================================
//
// User asks the agent to inspect a file; the agent reads progressively
// wider ranges of the same file as it homes in. The widest read covers
// every prior read; Rule 1 should drop the prior 4 reads.

function buildSubsumptionFixture() {
    resetSeq();
    return [
        mkUser('Look at the auth flow', USER_TOK),
        mkAsst('Reading auth.js...', ASST_TOK),
        mkRead('auth.js', [1, 50],   READ_TOKENS.snippet),       // T2
        mkRead('auth.js', [10, 100], READ_TOKENS.snippet + 800), // T3
        mkRead('auth.js', [50, 150], READ_TOKENS.snippet + 800), // T4
        mkRead('auth.js', [1, 200],  READ_TOKENS.medium),        // T5
        mkRead('auth.js', [1, 300],  READ_TOKENS.wide),          // T6 — subsumes T2..T5
        mkAsst('Found it.', ASST_TOK),
        mkUser('thanks', USER_TOK),
    ];
}

test('Scenario 1 — pure subsumption: 4 narrow reads dropped, widest survives', async () => {
    const fx = buildSubsumptionFixture();
    const m = await measure(fx, { preserve_recent: 2 });
    logSavings('S1 pure subsumption', m);

    assert.equal(m.turns_evicted, 4, '4 narrow reads (T2..T5) should evict');
    assert.ok(m.by_rule.subsumption?.drop === 4,
        `subsumption rule should account for 4 drops, got ${JSON.stringify(m.by_rule.subsumption)}`);
    // Observed: 59.4%. Bounds ±3pp around the deterministic value.
    assert.ok(m.reduction_pct >= 56, `reduction ≥56%, got ${m.reduction_pct.toFixed(1)}%`);
    assert.ok(m.reduction_pct <= 63, `reduction ≤63% (regression bound), got ${m.reduction_pct.toFixed(1)}%`);
});

// ============================================
// Scenario 2 — pure invalidation (Rule 2 only)
// ============================================
//
// Agent reads a wide range, edits a small slice inside it, then re-reads
// the whole range. The original wide read is now stale (Rule 2 fires);
// the edit is the truth and the re-read is the latest snapshot.

function buildInvalidationFixture() {
    resetSeq();
    return [
        mkUser('Fix the parseAuth bug', USER_TOK),
        mkAsst('Reading parser.js, then editing.', ASST_TOK),
        mkRead('parser.js', [1, 200], READ_TOKENS.medium),  // T2 — will be invalidated
        mkEdit('parser.js', [50, 80], EDIT_TOK),            // T3 — invalidates T2
        mkRead('parser.js', [1, 200], READ_TOKENS.medium),  // T4 — fresh post-edit
        mkAsst('Fixed.', ASST_TOK),
        mkUser('looks good', USER_TOK),
    ];
}

test('Scenario 2 — pure invalidation: pre-edit read dropped, post-edit kept', async () => {
    const fx = buildInvalidationFixture();
    const m = await measure(fx, { preserve_recent: 2 });
    logSavings('S2 pure invalidation', m);

    assert.equal(m.turns_evicted, 1, 'only the pre-edit read should evict');
    assert.equal(m.by_rule.invalidation?.drop, 1, 'invalidation rule should account for the drop');
    // Observed: 46.9%. Bounds ±2pp around the deterministic value.
    assert.ok(m.reduction_pct >= 44, `reduction ≥44%, got ${m.reduction_pct.toFixed(1)}%`);
    assert.ok(m.reduction_pct <= 50, `reduction ≤50% (regression bound), got ${m.reduction_pct.toFixed(1)}%`);
});

// ============================================
// Scenario 3 — hybrid 10-turn explore + edit
// ============================================
//
// Mirrors a small focused-fix session: explore a file, narrow in on a
// region, edit, re-read, edit, re-read. Both rules should fire.

function buildHybridFixture() {
    resetSeq();
    return [
        mkUser('Find and fix the issue in handler.go', USER_TOK),
        mkAsst('Exploring...', ASST_TOK),

        mkRead('handler.go', [1, 150],  READ_TOKENS.snippet + 1500), // T2 — broad
        mkRead('handler.go', [40, 70],  READ_TOKENS.snippet),        // T3 — narrow, subsumed by T2 (later wider read coming)
        mkRead('handler.go', [1, 250],  READ_TOKENS.medium),         // T4 — wider, subsumes T2 + T3

        mkAsst('Editing line 60.', ASST_TOK),
        mkEdit('handler.go', [60, 70], EDIT_TOK),                    // T6 — invalidates T4

        mkRead('handler.go', [1, 250],  READ_TOKENS.medium),         // T7 — post-edit
        mkAsst('Refining.', ASST_TOK),
        mkEdit('handler.go', [55, 75], EDIT_TOK),                    // T9 — invalidates T7

        mkRead('handler.go', [1, 250],  READ_TOKENS.medium),         // T10 — final state

        mkAsst('Done.', ASST_TOK),
        mkUser('thanks', USER_TOK),
    ];
}

test('Scenario 3 — hybrid: subsumption + invalidation cascade', async () => {
    const fx = buildHybridFixture();
    const m = await measure(fx, { preserve_recent: 2 });
    logSavings('S3 hybrid 10-turn', m);

    // Expected evictions: T2 + T3 (subsumed by T4), T4 (invalidated by T6), T7 (invalidated by T9).
    // T10 is preserve_recent-protected (last 2 turns); even if it weren't, no later edit invalidates it.
    assert.ok(m.turns_evicted >= 3, `expected ≥3 evictions, got ${m.turns_evicted}`);
    assert.ok(m.turns_evicted <= 5, `expected ≤5 evictions (regression bound), got ${m.turns_evicted}`);
    assert.ok(m.by_rule.subsumption?.drop >= 1, 'subsumption fires at least once');
    assert.ok(m.by_rule.invalidation?.drop >= 1, 'invalidation fires at least once');
    // Observed: 70.0%. Bounds ±3pp around the deterministic value.
    assert.ok(m.reduction_pct >= 67, `reduction ≥67%, got ${m.reduction_pct.toFixed(1)}%`);
    assert.ok(m.reduction_pct <= 73, `reduction ≤73% (regression bound), got ${m.reduction_pct.toFixed(1)}%`);
});

// ============================================
// Scenario 4 — realistic 30-turn debugging session
// ============================================
//
// Phase A (turns 0-9):   exploration. 4 files touched; 3 same-file
//                        re-reads at narrow ranges later subsumed by a
//                        wider read.
// Phase B (turns 10-19): focused fix. 4 edits + 4 re-reads of the
//                        target file, each read invalidated by the
//                        next edit except the last.
// Phase C (turns 20-29): verify. 2 broader re-reads of related files,
//                        a write, a few user/assistant turns.
//
// This shape is our "tool-heavy session" —
// expected reduction ≥40%.

function build30TurnDebugSession() {
    resetSeq();
    const turns = [];

    // Phase A — exploration
    turns.push(mkUser('Auth flow is broken when refresh-token is expired. Find it.', USER_TOK));
    turns.push(mkAsst('Looking at auth.js, jwt.js, refresh.js, handler.go.', ASST_TOK));

    turns.push(mkRead('auth.js',     [1, 200], READ_TOKENS.medium));   // A0
    turns.push(mkRead('jwt.js',      [1, 100], READ_TOKENS.snippet));  // A1
    turns.push(mkRead('refresh.js',  [1, 150], READ_TOKENS.snippet + 1000));  // A2
    turns.push(mkRead('handler.go',  [1, 250], READ_TOKENS.medium + 1000));   // A3

    // Two narrow re-reads on auth.js, both subsumed by a later wider read
    turns.push(mkRead('auth.js',     [50, 100], READ_TOKENS.snippet));        // A4 — subsumed by A6
    turns.push(mkRead('auth.js',     [120, 180], READ_TOKENS.snippet));       // A5 — subsumed by A6

    turns.push(mkRead('auth.js',     [1, 300], READ_TOKENS.wide));            // A6 — subsumes A0/A4/A5

    turns.push(mkAsst('Found the path: auth.js handle path triggers expired-refresh.', ASST_TOK));

    // Phase B — focused fix on auth.js (edits + re-reads)
    turns.push(mkEdit('auth.js', [40, 60], EDIT_TOK));                        // B0 — invalidates A6
    turns.push(mkRead('auth.js', [1, 300], READ_TOKENS.wide));                // B1 — post-B0
    turns.push(mkAsst('Verifying.', ASST_TOK));

    turns.push(mkEdit('auth.js', [70, 90], EDIT_TOK));                        // B3 — invalidates B1
    turns.push(mkRead('auth.js', [1, 300], READ_TOKENS.wide));                // B4 — post-B3
    turns.push(mkAsst('One more.', ASST_TOK));

    turns.push(mkEdit('auth.js', [100, 110], EDIT_TOK));                      // B6 — invalidates B4
    turns.push(mkRead('auth.js', [1, 300], READ_TOKENS.wide));                // B7 — post-B6
    turns.push(mkAsst('Last edit.', ASST_TOK));

    turns.push(mkEdit('auth.js', [130, 140], EDIT_TOK));                      // B9 — invalidates B7
    turns.push(mkRead('auth.js', [1, 300], READ_TOKENS.wide));                // B10 — final state

    // Phase C — verify
    turns.push(mkAsst('Re-checking related files.', ASST_TOK));
    turns.push(mkRead('jwt.js',     [1, 100], READ_TOKENS.snippet));   // C1 — subsumes A1 (no edit on jwt.js)
    turns.push(mkRead('refresh.js', [1, 150], READ_TOKENS.snippet + 1000)); // C2 — equal to A2 (subsumes)
    turns.push(mkAsst('All good.', ASST_TOK));
    turns.push(mkWrite('auth.js', 100));                                      // C4
    turns.push(mkUser('Run tests.', USER_TOK));
    turns.push(mkAsst('Tests pass.', ASST_TOK));
    turns.push(mkUser('Commit.', USER_TOK));
    turns.push(mkAsst('Committed.', ASST_TOK));

    return turns;
}

test('Scenario 4 — realistic 30-turn debug session ≥40% (the 40% target)', async () => {
    const fx = build30TurnDebugSession();
    const m = await measure(fx, { preserve_recent: 2 });
    logSavings('S4 30-turn debug', m);

    assert.ok(m.turns_in >= 28 && m.turns_in <= 32,
        `fixture should be ~30 turns, got ${m.turns_in}`);

    // Compression regression threshold: ≥40% reduction on tool-heavy sessions.
    // Observed: 78.7%. Far above the §1.2.0 floor — Decision §8 gate met.
    // Bounds ±3pp around the deterministic value.
    assert.ok(m.reduction_pct >= 75,
        `S4 lower regression bound: reduction ≥75%, got ${m.reduction_pct.toFixed(1)}% (the floor is 40%)`);
    assert.ok(m.reduction_pct <= 82,
        `S4 upper regression bound: reduction ≤82%, got ${m.reduction_pct.toFixed(1)}%`);

    // Both rules should contribute.
    assert.ok((m.by_rule.subsumption?.drop || 0) >= 2, 'subsumption fires multiple times');
    assert.ok((m.by_rule.invalidation?.drop || 0) >= 3, 'invalidation fires multiple times');
});

// ============================================
// Scenario 5 — 50-turn long agentic session
// ============================================
//
// This fixture mirrors the manual checklist Jeff would run on
// editor.gobha.ai/dev under Tier 2 (`?compression=off` flag): a 50-turn
// agentic loop with deliberate Rule 1 + Rule 2 patterns. The numbers
// from this synthetic run are the *floor* the deployed-instance
// dashboard should hit — anything materially below is worth digging
// into.

function build50TurnAgenticSession() {
    resetSeq();
    const turns = [];

    // Phase A — wide exploration (turns 0-15)
    turns.push(mkUser('Refactor the auth module. Map the surface first.', USER_TOK));
    turns.push(mkAsst('Reading the module top-to-bottom.', ASST_TOK));

    const FILES = ['auth.js', 'jwt.js', 'session.js', 'refresh.js', 'middleware.js'];
    // First pass — small reads of each file
    for (const f of FILES) {
        turns.push(mkRead(f, [1, 80], READ_TOKENS.snippet));
    }
    // Second pass — narrow re-reads of two files (will be subsumed)
    turns.push(mkRead('auth.js',    [10, 50],  READ_TOKENS.snippet));
    turns.push(mkRead('auth.js',    [40, 90],  READ_TOKENS.snippet));
    turns.push(mkRead('session.js', [1, 60],   READ_TOKENS.snippet)); // subsumed by FILES pass
    // Third pass — wide reads (subsume everything above on those files)
    turns.push(mkRead('auth.js',    [1, 300],  READ_TOKENS.wide));
    turns.push(mkRead('session.js', [1, 200],  READ_TOKENS.medium));
    turns.push(mkAsst('Mapped. Starting refactor on auth.js.', ASST_TOK));

    // Phase B — edit cascade on auth.js (turns 16-35)
    for (let i = 0; i < 6; i++) {
        const editStart = 30 + i * 30;
        turns.push(mkEdit('auth.js', [editStart, editStart + 15], EDIT_TOK));
        turns.push(mkRead('auth.js', [1, 300], READ_TOKENS.wide)); // each but the last is invalidated
        if (i % 2 === 0) turns.push(mkAsst(`After edit ${i + 1} of 6.`, ASST_TOK));
    }
    // A handful of cross-file edits (invalidate session.js wide read, then re-read)
    turns.push(mkEdit('session.js', [80, 120], EDIT_TOK));
    turns.push(mkRead('session.js', [1, 200], READ_TOKENS.medium));
    turns.push(mkEdit('session.js', [10, 30], EDIT_TOK));
    turns.push(mkRead('session.js', [1, 200], READ_TOKENS.medium));

    // Phase C — verify + commit (turns ~36-50)
    turns.push(mkAsst('Re-checking related files for fallout.', ASST_TOK));
    turns.push(mkRead('jwt.js',        [1, 100], READ_TOKENS.snippet));      // subsumes Phase-A jwt read
    turns.push(mkRead('refresh.js',    [1, 80],  READ_TOKENS.snippet));      // equal — subsumes
    turns.push(mkRead('middleware.js', [1, 80],  READ_TOKENS.snippet));      // equal — subsumes
    turns.push(mkAsst('Looks consistent.', ASST_TOK));

    turns.push(mkUser('Run tests.', USER_TOK));
    turns.push(mkAsst('Running.', ASST_TOK));
    turns.push(mkRead('package.json', [1, 50], 200));
    turns.push(mkAsst('All tests pass.', ASST_TOK));
    turns.push(mkUser('Commit.', USER_TOK));
    turns.push(mkAsst('Committing across the touched files.', ASST_TOK));
    turns.push(mkWrite('auth.js', 100));
    turns.push(mkWrite('session.js', 100));
    turns.push(mkAsst('Done.', ASST_TOK));

    return turns;
}

test('Scenario 5 — realistic 50-turn agentic session ≥40% (Tier 2 floor)', async () => {
    const fx = build50TurnAgenticSession();
    const m = await measure(fx, { preserve_recent: 2 });
    logSavings('S5 50-turn agentic', m);

    assert.ok(m.turns_in >= 45 && m.turns_in <= 55,
        `fixture should be ~50 turns, got ${m.turns_in}`);

    // The deployed-instance dual-session run (`?compression=off` vs
    // default) should land at or above this number. If it lands below,
    // either the deployed Compactor is mis-wired or organic input
    // doesn't match the synthetic shape — either is worth a follow-up.
    // Observed: 90.3%. the floor is 40% — synthetic far above it.
    // Bounds ±3pp around the deterministic value.
    assert.ok(m.reduction_pct >= 87,
        `S5 lower regression bound: reduction ≥87%, got ${m.reduction_pct.toFixed(1)}% (Tier 2 deployed floor is 40%)`);
    assert.ok(m.reduction_pct <= 93,
        `S5 upper regression bound: reduction ≤93%, got ${m.reduction_pct.toFixed(1)}%`);

    assert.ok((m.by_rule.subsumption?.drop || 0) >= 4, 'subsumption fires repeatedly');
    assert.ok((m.by_rule.invalidation?.drop || 0) >= 4, 'invalidation fires repeatedly');
});

// ============================================
// Aggregate snapshot — print a single summary line at the end
// ============================================

test('Aggregate — all scenarios collectively beat the 40% target', async () => {
    const scenarios = [
        ['S1 subsumption', buildSubsumptionFixture()],
        ['S2 invalidation', buildInvalidationFixture()],
        ['S3 hybrid 10-turn', buildHybridFixture()],
        ['S4 30-turn debug', build30TurnDebugSession()],
        ['S5 50-turn agentic', build50TurnAgenticSession()],
    ];

    let total_in = 0;
    let total_out = 0;
    let total_evicted = 0;
    let total_turns = 0;

    for (const [name, fx] of scenarios) {
        const m = await measure(fx, { preserve_recent: 2 });
        total_in += m.tokens_in;
        total_out += m.tokens_out;
        total_evicted += m.turns_evicted;
        total_turns += m.turns_in;
    }

    const agg_pct = 100 * (1 - total_out / total_in);
    console.log(`  [AGGREGATE] ${agg_pct.toFixed(1)}% reduction across all 5 scenarios — ${total_in.toLocaleString()} → ${total_out.toLocaleString()} tok · ${total_turns} turns, ${total_evicted} evicted`);

    // Observed: 79.2%. the floor is 40%; the aggregate is the
    // headline number quoted in the CHANGELOG entry for this PR.
    // Bounds ±3pp around the deterministic value.
    assert.ok(agg_pct >= 76,
        `aggregate lower regression bound: ≥76%, got ${agg_pct.toFixed(1)}% (the floor is 40%)`);
    assert.ok(agg_pct <= 82,
        `aggregate upper regression bound: ≤82%, got ${agg_pct.toFixed(1)}%`);
});
