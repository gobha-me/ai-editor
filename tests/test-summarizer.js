/**
 * Tests for ChatSummarizer — percentage-based scaling, mode differentiation,
 * symbol extraction, tool result handling.
 * Imports the full module graph (core.js → providers → etc.) which is fine in the browser.
 */
import { ChatSummarizer } from '../js/chat/summarizer.js';
import { State } from '../js/core.js';

const { T } = window;

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

// ============================================
// PERCENTAGE-BASED SCALING (Balanced = 50%)
// ============================================

T.suite('ChatSummarizer — Percentage-Based Scaling');

State.settings.summarizerMode = 'balanced';

// 128K model, balanced (50%): capacity = 128000 * 0.50 / 800 = 80
setMockModel(128000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 80, '128K balanced: threshold=80 (capacity=80)');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 28, '128K balanced: recentBase=28 (80*0.35)');
T.eq(ChatSummarizer.RECENT_COUNT_TOOLS, 48, '128K balanced: recentTools=48 (80*0.60)');
T.eq(ChatSummarizer.SUMMARY_INTERVAL, 36, '128K balanced: interval=36 (80*0.45)');

// 1M model, balanced: capacity = 1000000 * 0.50 / 800 = 625 → clamped 250
setMockModel(1000000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 200, '1M balanced: threshold=200 (cap clamps at 250→200)');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 60, '1M balanced: recentBase=60 (max clamp)');
T.eq(ChatSummarizer.RECENT_COUNT_TOOLS, 100, '1M balanced: recentTools=100 (max clamp)');

// 32K model, balanced: capacity = 32000 * 0.50 / 800 = 20
setMockModel(32000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 20, '32K balanced: threshold=20 (capacity=20)');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 8, '32K balanced: recentBase=8 (min clamp)');

// 8K model, balanced: capacity = 8000 * 0.50 / 800 = 5 → clamped 20
setMockModel(8000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 20, '8K balanced: threshold=20 (min clamp)');

// Null context → falls back to defaults
setMockModel(null);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 30, 'null context → default threshold=30');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 10, 'null context → default recentBase=10');

// ============================================
// MODE DIFFERENTIATION
// ============================================

T.suite('ChatSummarizer — Mode Differentiation');

// For a given model, aggressive < balanced < conservative
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

T.assert(aggrThreshold < balThreshold, `Aggressive threshold (${aggrThreshold}) < Balanced (${balThreshold})`);
T.assert(balThreshold < consThreshold, `Balanced threshold (${balThreshold}) < Conservative (${consThreshold})`);
T.assert(aggrRecent < balRecent, `Aggressive recent (${aggrRecent}) < Balanced (${balRecent})`);
T.assert(balRecent < consRecent, `Balanced recent (${balRecent}) < Conservative (${consRecent})`);

// Verify specific fill percentages (128K model)
// Aggressive: 128K * 0.30 / 800 = 48
State.settings.summarizerMode = 'aggressive';
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 48, '128K aggressive: threshold=48 (30% fill)');

// Conservative: 128K * 0.75 / 800 = 120
State.settings.summarizerMode = 'conservative';
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 120, '128K conservative: threshold=120 (75% fill)');

// ============================================
// SMOOTH SCALING (no tier cliffs)
// ============================================

T.suite('ChatSummarizer — Smooth Scaling');

State.settings.summarizerMode = 'balanced';

// Models at different sizes should produce different thresholds (no tier cliffs)
setMockModel(64000);
const t64 = ChatSummarizer.SUMMARY_THRESHOLD;
setMockModel(96000);
const t96 = ChatSummarizer.SUMMARY_THRESHOLD;
setMockModel(128000);
const t128 = ChatSummarizer.SUMMARY_THRESHOLD;

T.assert(t64 < t96, `64K threshold (${t64}) < 96K threshold (${t96})`);
T.assert(t96 < t128, `96K threshold (${t96}) < 128K threshold (${t128})`);

// Verify no duplicates at boundary points (old tier system gave same params for 33K and 127K)
setMockModel(33000);
const t33 = ChatSummarizer.SUMMARY_THRESHOLD;
setMockModel(127000);
const t127 = ChatSummarizer.SUMMARY_THRESHOLD;
T.assert(t33 < t127, `33K threshold (${t33}) < 127K threshold (${t127}) — no tier cliff`);

// ============================================
// getAutoParams API
// ============================================

T.suite('ChatSummarizer — getAutoParams');

State.settings.summarizerMode = 'balanced';
setMockModel(128000);
const info = ChatSummarizer.getAutoParams();

T.eq(info.mode, 'balanced', 'getAutoParams returns mode');
T.eq(info.contextTokens, 128000, 'getAutoParams returns contextTokens');
T.eq(info.fillPct, 0.50, 'getAutoParams returns fillPct');
T.assert(info.label.includes('50%'), `Label includes fill%: "${info.label}"`);
T.assert(info.label.includes('128K'), `Label includes context size: "${info.label}"`);
T.eq(info.params.threshold, 80, 'getAutoParams.params matches _cfg()');

// ============================================
// LEGACY MODE MIGRATION
// ============================================

T.suite('ChatSummarizer — Legacy Migration');

State.settings.summarizerMode = 'auto';
T.eq(ChatSummarizer.mode, 'balanced', 'Legacy "auto" migrates to "balanced"');
State.settings.summarizerMode = 'manual';
T.eq(ChatSummarizer.mode, 'custom', 'Legacy "manual" migrates to "custom"');

// ============================================
// CUSTOM MODE
// ============================================

T.suite('ChatSummarizer — Custom Mode');

State.settings.summarizerMode = 'custom';
State.settings.summarizer = { recentCountBase: 20, threshold: 60 };
T.eq(ChatSummarizer.mode, 'custom', 'Mode reads from settings');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 20, 'Custom mode uses settings.summarizer value');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 60, 'Custom mode threshold from settings');

// Balanced mode should ignore custom settings
State.settings.summarizerMode = 'balanced';
setMockModel(128000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 80, 'Balanced mode ignores custom settings, uses computed');

// ============================================
// SYMBOL EXTRACTION
// ============================================

T.suite('ChatSummarizer — _extractSymbols');

// JavaScript
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
T.assert(jsSymbols.includes('fetchModels'), 'Extracts JS function');
T.assert(jsSymbols.includes('ToolRegistry'), 'Extracts JS const');
T.assert(jsSymbols.includes('EventBus'), 'Extracts JS class');
T.assert(jsSymbols.includes('handleUserInput'), 'Extracts async function');

// Python
const pySource = `
def process_data(items):
    pass

class DataPipeline:
    def run(self):
        pass
`;
const pySymbols = ChatSummarizer._extractSymbols(pySource);
T.assert(pySymbols.includes('process_data'), 'Extracts Python def');
T.assert(pySymbols.includes('DataPipeline'), 'Extracts Python class');

// Rust
const rsSource = `
fn calculate_hash(data: &[u8]) -> u64 {
    0
}
pub fn main() {}
`;
const rsSymbols = ChatSummarizer._extractSymbols(rsSource);
T.assert(rsSymbols.includes('calculate_hash'), 'Extracts Rust fn');
T.assert(rsSymbols.includes('main'), 'Extracts Rust pub fn');

// Empty / noise
T.deepEq(ChatSummarizer._extractSymbols(''), [], 'Empty source → empty symbols');
T.deepEq(ChatSummarizer._extractSymbols(null), [], 'null source → empty symbols');
T.assert(ChatSummarizer._extractSymbols('let x = 5; var y = 10;').length <= 15, 'Caps at 15 symbols');

// ============================================
// TOOL RESULT SUMMARIZATION
// ============================================

T.suite('ChatSummarizer — _summarizeToolResult');

// File read result
const fileResult = {
    role: 'tool',
    content: JSON.stringify({
        path: 'js/app.js',
        content: 'export function init() {}\nfunction render() {}\nconst VERSION = "1.0";'
    })
};
const fileSummary = ChatSummarizer._summarizeToolResult(fileResult);
T.assert(fileSummary.includes('js/app.js'), 'File summary includes path');
T.assert(fileSummary.includes('init'), 'File summary includes extracted symbol');

// Error result
const errResult = { role: 'tool', content: JSON.stringify({ error: 'File not found' }) };
T.assert(ChatSummarizer._summarizeToolResult(errResult).includes('File not found'), 'Error result preserved');

// File tree result
const treeResult = {
    role: 'tool',
    content: JSON.stringify({ files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] })
};
const treeSummary = ChatSummarizer._summarizeToolResult(treeResult);
T.assert(treeSummary.includes('3 files'), 'Tree summary includes count');

// Search result
const searchResult = {
    role: 'tool',
    content: JSON.stringify({ matches: [
        { path: 'foo.js', line: 10 },
        { path: 'foo.js', line: 20 },
        { path: 'bar.js', line: 5 }
    ]})
};
const searchSummary = ChatSummarizer._summarizeToolResult(searchResult);
T.assert(searchSummary.includes('3 matches'), 'Search summary includes match count');
T.assert(searchSummary.includes('2 files'), 'Search summary includes file count');

// Null content
const nullResult = { role: 'tool', content: null };
T.eq(ChatSummarizer._summarizeToolResult(nullResult), null, 'Null content returns null');

// Restore
resetMocks();
