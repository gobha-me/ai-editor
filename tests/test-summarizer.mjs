/**
 * Tests for ChatSummarizer — percentage-based scaling, mode differentiation,
 * symbol extraction, tool result handling.
 *
 * Imports the full module graph (core.js → providers → etc.). Under Node
 * the shim provides minimal browser globals; the .js sibling
 * (tests/test-summarizer.js) covers the browser suite.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSummarizer } from '../js/chat/summarizer.js';
import { State } from '../js/core.js';

// ============================================
// SETUP
// ============================================

const originalModels = State.models;
const originalMode = State.settings.summarizerMode;

function setMockModel(contextTokens) {
    State.settings.llmModel = 'test-model';
    State.models = [{ id: 'test-model', meta: { contextTokens } }];
}

function resetMocks() {
    State.models = originalModels;
    State.settings.summarizerMode = originalMode;
}

test.after(() => resetMocks());

// ============================================
// Percentage-based scaling (balanced = 50%)
// ============================================

State.settings.summarizerMode = 'balanced';

// 128K model, balanced (50%): capacity = 128000 * 0.50 / 800 = 80
test('128K balanced: threshold=80 (capacity=80)', () => {
    setMockModel(128000);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 80);
});
test('128K balanced: recentBase=28 (80*0.35)', () => {
    setMockModel(128000);
    assert.equal(ChatSummarizer.RECENT_COUNT_BASE, 28);
});
test('128K balanced: recentTools=48 (80*0.60)', () => {
    setMockModel(128000);
    assert.equal(ChatSummarizer.RECENT_COUNT_TOOLS, 48);
});
test('128K balanced: interval=36 (80*0.45)', () => {
    setMockModel(128000);
    assert.equal(ChatSummarizer.SUMMARY_INTERVAL, 36);
});

// 1M model, balanced: ctx>524K → scale=8 (per getContextScale).
// capacity = clamp(1000000 * 0.50 / 800, 20, 250*8=2000) = 625
test('1M balanced: threshold=625 (capacity, well under scale-8 cap)', () => {
    setMockModel(1000000);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 625);
});
test('1M balanced: recentBase=219 (capacity*0.35, well under scale-8 cap)', () => {
    setMockModel(1000000);
    assert.equal(ChatSummarizer.RECENT_COUNT_BASE, 219);
});
test('1M balanced: recentTools=375 (capacity*0.60, well under scale-8 cap)', () => {
    setMockModel(1000000);
    assert.equal(ChatSummarizer.RECENT_COUNT_TOOLS, 375);
});

// 32K model, balanced: capacity = 32000 * 0.50 / 800 = 20
test('32K balanced: threshold=20 (capacity=20)', () => {
    setMockModel(32000);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 20);
});
test('32K balanced: recentBase=8 (min clamp)', () => {
    setMockModel(32000);
    assert.equal(ChatSummarizer.RECENT_COUNT_BASE, 8);
});

// 8K model, balanced: capacity = 8000 * 0.50 / 800 = 5 → clamped 20
test('8K balanced: threshold=20 (min clamp)', () => {
    setMockModel(8000);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 20);
});

// Null context → falls back to defaults
test('null context → default threshold=30', () => {
    setMockModel(null);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 30);
});
test('null context → default recentBase=10', () => {
    setMockModel(null);
    assert.equal(ChatSummarizer.RECENT_COUNT_BASE, 10);
});

// ============================================
// Mode differentiation
// ============================================

test('Aggressive < Balanced < Conservative for threshold and recentBase', () => {
    setMockModel(128000);

    State.settings.summarizerMode = 'aggressive';
    const aggrThreshold = ChatSummarizer.SUMMARY_THRESHOLD;
    const aggrRecent = ChatSummarizer.RECENT_COUNT_BASE;

    State.settings.summarizerMode = 'balanced';
    const balThreshold = ChatSummarizer.SUMMARY_THRESHOLD;
    const balRecent = ChatSummarizer.RECENT_COUNT_BASE;

    State.settings.summarizerMode = 'conservative';
    const consThreshold = ChatSummarizer.SUMMARY_THRESHOLD;
    const consRecent = ChatSummarizer.RECENT_COUNT_BASE;

    assert.ok(aggrThreshold < balThreshold, `aggr ${aggrThreshold} < bal ${balThreshold}`);
    assert.ok(balThreshold < consThreshold, `bal ${balThreshold} < cons ${consThreshold}`);
    assert.ok(aggrRecent < balRecent, `aggr ${aggrRecent} < bal ${balRecent}`);
    assert.ok(balRecent < consRecent, `bal ${balRecent} < cons ${consRecent}`);
});

// Aggressive: 128K * 0.30 / 800 = 48
test('128K aggressive: threshold=48 (30% fill)', () => {
    setMockModel(128000);
    State.settings.summarizerMode = 'aggressive';
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 48);
});

// Conservative: 128K * 0.75 / 800 = 120
test('128K conservative: threshold=120 (75% fill)', () => {
    setMockModel(128000);
    State.settings.summarizerMode = 'conservative';
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 120);
});

// ============================================
// Smooth scaling (no tier cliffs)
// ============================================

test('Smooth scaling: 64K < 96K < 128K thresholds', () => {
    State.settings.summarizerMode = 'balanced';
    setMockModel(64000);
    const t64 = ChatSummarizer.SUMMARY_THRESHOLD;
    setMockModel(96000);
    const t96 = ChatSummarizer.SUMMARY_THRESHOLD;
    setMockModel(128000);
    const t128 = ChatSummarizer.SUMMARY_THRESHOLD;

    assert.ok(t64 < t96, `t64 ${t64} < t96 ${t96}`);
    assert.ok(t96 < t128, `t96 ${t96} < t128 ${t128}`);
});

test('No tier cliff between 33K and 127K', () => {
    State.settings.summarizerMode = 'balanced';
    setMockModel(33000);
    const t33 = ChatSummarizer.SUMMARY_THRESHOLD;
    setMockModel(127000);
    const t127 = ChatSummarizer.SUMMARY_THRESHOLD;
    assert.ok(t33 < t127, `t33 ${t33} < t127 ${t127}`);
});

// ============================================
// getAutoParams API
// ============================================

test('getAutoParams returns mode, contextTokens, fillPct, label, params', () => {
    State.settings.summarizerMode = 'balanced';
    setMockModel(128000);
    const info = ChatSummarizer.getAutoParams();

    assert.equal(info.mode, 'balanced');
    assert.equal(info.contextTokens, 128000);
    assert.equal(info.fillPct, 0.50);
    assert.ok(info.label.includes('50%'), `Label includes fill%: "${info.label}"`);
    assert.ok(info.label.includes('128K'), `Label includes context size: "${info.label}"`);
    assert.equal(info.params.threshold, 80);
});

// ============================================
// Legacy mode migration
// ============================================

test('Legacy "auto" migrates to "balanced"', () => {
    State.settings.summarizerMode = 'auto';
    assert.equal(ChatSummarizer.mode, 'balanced');
});
test('Legacy "manual" migrates to "custom"', () => {
    State.settings.summarizerMode = 'manual';
    assert.equal(ChatSummarizer.mode, 'custom');
});

// ============================================
// Custom mode
// ============================================

test('Custom mode reads from settings.summarizer', () => {
    State.settings.summarizerMode = 'custom';
    State.settings.summarizer = { recentCountBase: 20, threshold: 60 };
    assert.equal(ChatSummarizer.mode, 'custom');
    assert.equal(ChatSummarizer.RECENT_COUNT_BASE, 20);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 60);
});

test('Balanced mode ignores custom settings, uses computed', () => {
    State.settings.summarizerMode = 'balanced';
    setMockModel(128000);
    assert.equal(ChatSummarizer.SUMMARY_THRESHOLD, 80);
});

// ============================================
// _extractSymbols
// ============================================

test('Extracts JS function, const, class, async function', () => {
    const jsSource = `
export function fetchModels() {
    const models = await LLM.listModels();
}
export const ToolRegistry = { handlers: new Map() };
class EventBus {
    on(event, callback) {}
}
async function handleUserInput(input) {}
`;
    const jsSymbols = ChatSummarizer._extractSymbols(jsSource);
    assert.ok(jsSymbols.includes('fetchModels'), 'fetchModels');
    assert.ok(jsSymbols.includes('ToolRegistry'), 'ToolRegistry');
    assert.ok(jsSymbols.includes('EventBus'), 'EventBus');
    assert.ok(jsSymbols.includes('handleUserInput'), 'handleUserInput');
});

test('Extracts Python def and class', () => {
    const pySource = `
def process_data(items):
    pass

class DataPipeline:
    def run(self):
        pass
`;
    const pySymbols = ChatSummarizer._extractSymbols(pySource);
    assert.ok(pySymbols.includes('process_data'));
    assert.ok(pySymbols.includes('DataPipeline'));
});

test('Extracts Rust fn and pub fn', () => {
    const rsSource = `
fn calculate_hash(data: &[u8]) -> u64 {
    0
}
pub fn main() {}
`;
    const rsSymbols = ChatSummarizer._extractSymbols(rsSource);
    assert.ok(rsSymbols.includes('calculate_hash'));
    assert.ok(rsSymbols.includes('main'));
});

test('Empty source → empty symbols', () => {
    assert.deepEqual(ChatSummarizer._extractSymbols(''), []);
});
test('null source → empty symbols', () => {
    assert.deepEqual(ChatSummarizer._extractSymbols(null), []);
});
test('Caps at 15 symbols', () => {
    assert.ok(ChatSummarizer._extractSymbols('let x = 5; var y = 10;').length <= 15);
});

// ============================================
// _summarizeToolResult
// ============================================

test('File summary includes path and extracted symbol', () => {
    const fileResult = {
        role: 'tool',
        content: JSON.stringify({
            path: 'js/app.js',
            content: 'export function init() {}\nfunction render() {}\nconst VERSION = "1.0";'
        })
    };
    const fileSummary = ChatSummarizer._summarizeToolResult(fileResult);
    assert.ok(fileSummary.includes('js/app.js'));
    assert.ok(fileSummary.includes('init'));
});

test('Error result preserved', () => {
    const errResult = { role: 'tool', content: JSON.stringify({ error: 'File not found' }) };
    assert.ok(ChatSummarizer._summarizeToolResult(errResult).includes('File not found'));
});

test('Tree summary includes file count', () => {
    const treeResult = {
        role: 'tool',
        content: JSON.stringify({ files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] })
    };
    const treeSummary = ChatSummarizer._summarizeToolResult(treeResult);
    assert.ok(treeSummary.includes('3 files'));
});

test('Search summary includes match count and file count', () => {
    const searchResult = {
        role: 'tool',
        content: JSON.stringify({ matches: [
            { path: 'foo.js', line: 10 },
            { path: 'foo.js', line: 20 },
            { path: 'bar.js', line: 5 }
        ]})
    };
    const searchSummary = ChatSummarizer._summarizeToolResult(searchResult);
    assert.ok(searchSummary.includes('3 matches'));
    assert.ok(searchSummary.includes('2 files'));
});

test('Null content returns null', () => {
    const nullResult = { role: 'tool', content: null };
    assert.equal(ChatSummarizer._summarizeToolResult(nullResult), null);
});

// ============================================
// 1.6.4 — Token-based summarization trigger
// ============================================

import { Storage } from '../js/core.js';

const _origLastTokens = State.lastExchangeTokens;
const _origSummaryInfo_164 = Storage.get('chatSummaryInfo', null);
const _origChatHistory_164 = State.chatHistory;
function _restore_164() {
    State.lastExchangeTokens = _origLastTokens;
    State.chatHistory = _origChatHistory_164;
    if (_origSummaryInfo_164) Storage.set('chatSummaryInfo', _origSummaryInfo_164);
    else Storage.remove('chatSummaryInfo');
}

test('token-gate fires when last prompt_tokens ≥ ctx × fillPct', () => {
    setMockModel(128_000);
    State.settings.summarizerMode = 'balanced';   // 50% → gate at 64K
    Storage.remove('chatSummaryInfo');
    State.chatHistory = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = { prompt: 70_000, cached: 0, ts: Date.now() };
    assert.equal(ChatSummarizer.shouldSummarize(), true);
    _restore_164();
});

test('token-gate suppresses even when message count exceeds SUMMARY_THRESHOLD', () => {
    setMockModel(128_000);
    State.settings.summarizerMode = 'balanced';   // SUMMARY_THRESHOLD = 80
    Storage.remove('chatSummaryInfo');
    // 250 messages → message-count fallback would say true
    State.chatHistory = Array.from({ length: 250 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    // But real prompt size is well under the gate (e.g., heavy cache compaction)
    State.lastExchangeTokens = { prompt: 25_000, cached: 0, ts: Date.now() };
    assert.equal(ChatSummarizer.shouldSummarize(), false,
        'token-aware path dominates when populated');
    _restore_164();
});

test('token-gate falls back to message-count when lastExchangeTokens is null', () => {
    setMockModel(128_000);
    State.settings.summarizerMode = 'balanced';   // SUMMARY_THRESHOLD = 80
    Storage.remove('chatSummaryInfo');
    State.chatHistory = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = null;              // first exchange of session
    assert.equal(ChatSummarizer.shouldSummarize(), true,
        'message-count fallback preserves pre-1.6.4 behaviour');
    _restore_164();
});

test('token-gate respects SUMMARY_INTERVAL backstop after a recent summary', () => {
    setMockModel(128_000);
    State.settings.summarizerMode = 'balanced';   // SUMMARY_INTERVAL = 36
    State.chatHistory = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = { prompt: 80_000, cached: 0, ts: Date.now() };
    // Summary covers up through index 95 → only 5 new messages → under interval (36)
    Storage.set('chatSummaryInfo', { summary: 'prior', coveredCount: 95 });
    assert.equal(ChatSummarizer.shouldSummarize(), false,
        'interval backstop suppresses second summary');
    _restore_164();
});

// ============================================
// 1.6.4 — Map-reduce / multi-pass summarization
// ============================================
//
// We unit-test _summarizeRecursive directly, mocking _callSummaryLLM (the
// leaf that calls LLM.chat). This lets us count recursion behaviour without
// coordinating with the LLM.chat Promise.race/timeout.

const _origCallSummaryLLM = ChatSummarizer._callSummaryLLM;
function _restoreLeafMock() { ChatSummarizer._callSummaryLLM = _origCallSummaryLLM; }

function _msgs(n, sizePerMsg = 50) {
    // sizePerMsg ≈ chars; _buildPrompt prepends labels & joins with "\n\n"
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(sizePerMsg) + ` m${i}`,
    }));
}

test('multi-pass: small input + large budget → exactly one LLM call', async () => {
    let calls = 0;
    ChatSummarizer._callSummaryLLM = async () => { calls++; return 'leaf'; };
    const out = await ChatSummarizer._summarizeRecursive(_msgs(8, 20), 'm', 1_000_000, 0);
    assert.equal(calls, 1, 'single base-case call');
    assert.equal(out, 'leaf');
    _restoreLeafMock();
});

test('multi-pass: small budget → fans out and reduces (leaves + 1 reduce)', async () => {
    const calls = [];
    ChatSummarizer._callSummaryLLM = async (prompt) => {
        calls.push(prompt.length);
        return `summary-${calls.length}`;
    };
    // 40 messages × ~120 chars each + labels ≈ ~6K chars; budget 800 tokens (~2800 chars)
    // → estTokens > budget → fan-out 3-ish, reduce step fits.
    await ChatSummarizer._summarizeRecursive(_msgs(40, 120), 'm', 800, 0);
    assert.ok(calls.length >= 3, `expected ≥3 calls (≥2 leaves + 1 reduce), got ${calls.length}`);
    _restoreLeafMock();
});

test('multi-pass: very small budget → recursion goes ≥2 levels deep', async () => {
    const depthsSeen = [];
    const _origRecursive = ChatSummarizer._summarizeRecursive;
    ChatSummarizer._summarizeRecursive = async function(msgs, model, budget, depth) {
        depthsSeen.push(depth);
        return _origRecursive.call(this, msgs, model, budget, depth);
    };
    ChatSummarizer._callSummaryLLM = async () => 'leaf';
    await ChatSummarizer._summarizeRecursive(_msgs(60, 200), 'm', 400, 0);
    assert.ok(Math.max(...depthsSeen) >= 2, `recursion reached depth ≥2 (saw depths ${depthsSeen.join(',')})`);
    ChatSummarizer._summarizeRecursive = _origRecursive;
    _restoreLeafMock();
});

test('multi-pass: depth cap → falls back to _basicSummary at MAX_DEPTH', async () => {
    let basicCalled = 0;
    const _origBasic = ChatSummarizer._basicSummary;
    ChatSummarizer._basicSummary = function(messages) {
        basicCalled++;
        return _origBasic.call(this, messages);
    };
    // Leaf returns a string so the reduce step at the top can still finish;
    // we only assert that _basicSummary was hit at least once during the
    // depth-cap descent. Budget so tiny that single messages overflow → every
    // leaf eventually recurses through MAX_DEPTH and bails out via basic.
    ChatSummarizer._callSummaryLLM = async () => 'leaf';
    const out = await ChatSummarizer._summarizeRecursive(_msgs(50, 200), 'm', 10, 0);
    assert.ok(basicCalled > 0, 'fell back to _basicSummary at depth cap');
    assert.ok(typeof out === 'string' && out.length > 0, 'returned a non-empty string');
    ChatSummarizer._basicSummary = _origBasic;
    _restoreLeafMock();
});

test('heavy-tool session: token gate fires, recent scales to half-history (regression for silent no-op)', async () => {
    // Symptom captured in 1.6.4 dogfood (2026-05-05): minimax-m27 (196K),
    // 37 messages of mostly large tool results pushed prompt_tokens to
    // 105K (over the 98K balanced gate). shouldSummarize() returned true,
    // but generateAndStore() silently bailed at `older.length < 5` because
    // RECENT_COUNT_TOOLS for 196K balanced is ~73 — larger than total.
    setMockModel(196_000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    State.settings.commitModel = undefined;
    // 30 tool-heavy messages mimicking the dogfood shape (assistant + tool
    // pairs). RECENT_COUNT_TOOLS for this model is ~75; without the fix,
    // older = slice(0, -75) on a length-30 history is empty → silent bail.
    State.chatHistory = Array.from({ length: 30 }, (_, i) => {
        if (i % 2 === 0) {
            return {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: `call_${i}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"big.js"}' },
                }],
            };
        }
        return {
            role: 'tool',
            tool_call_id: `call_${i - 1}`,
            content: 'x'.repeat(7000),  // ~2K tokens of tool result
        };
    });
    State.lastExchangeTokens = { prompt: 105_808, cached: 7936, ts: Date.now() };

    let recursiveCalled = false;
    const _origRecursive = ChatSummarizer._summarizeRecursive;
    ChatSummarizer._summarizeRecursive = async () => { recursiveCalled = true; return 'mocked-summary'; };
    const _origPrune = ChatSummarizer._pruneHistory;
    ChatSummarizer._pruneHistory = () => true;  // skip the splice for this test

    const result = await ChatSummarizer.generateAndStore();

    assert.equal(recursiveCalled, true,
        'generateAndStore() reached _summarizeRecursive (did not silently bail)');
    assert.ok(result && typeof result === 'object',
        'generateAndStore() returned a SummaryInfo, not null');
    assert.ok(result.compressedMessages >= 5,
        `compressed at least 5 messages (got ${result.compressedMessages})`);
    assert.ok(result.keptMessages <= Math.floor(30 / 2) + 1,
        `keptMessages reflects the half-history cap (got ${result.keptMessages})`);

    ChatSummarizer._summarizeRecursive = _origRecursive;
    ChatSummarizer._pruneHistory = _origPrune;
    _restore_164();
});

test('multi-pass: uses utility model window, not the main model window', async () => {
    // Main = 1M context, utility = 8K. perPassBudget should derive from utility.
    State.settings.llmModel = 'big-prod';
    State.settings.commitModel = 'tiny-utility';
    State.models = [
        { id: 'big-prod',     meta: { contextTokens: 1_000_000 } },
        { id: 'tiny-utility', meta: { contextTokens: 8_000     } },
    ];
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');

    // Set up a hist where shouldSummarize() returns true via token gate AND
    // the older slice (after subtracting RECENT_COUNT for the 1M main model,
    // which can be ~219) is large enough that generateAndStore() doesn't
    // early-return on `older.length < 5`.
    State.chatHistory = Array.from({ length: 400 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'y'.repeat(400) + ` h${i}`,
    }));
    State.lastExchangeTokens = { prompt: 700_000, cached: 0, ts: Date.now() };

    let observedBudget = null;
    const _origRecursive = ChatSummarizer._summarizeRecursive;
    ChatSummarizer._summarizeRecursive = async function(msgs, model, budget, depth) {
        if (depth === 0) observedBudget = budget;
        return 'mocked';
    };
    await ChatSummarizer.generateAndStore();

    // utilityCtx=8000, fillPct=0.5, budget = max(1500, floor(8000*0.5*0.7)=2800) = 2800
    assert.equal(observedBudget, 2800,
        `perPassBudget derived from utility window (got ${observedBudget})`);
    ChatSummarizer._summarizeRecursive = _origRecursive;
    State.settings.commitModel = undefined;
    _restore_164();
});
