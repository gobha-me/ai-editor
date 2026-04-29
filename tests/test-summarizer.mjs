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
