/**
 * Tests for ChatSummarizer — tier detection, mode shifting, symbol extraction, tool result handling.
 * Imports the full module graph (core.js → providers → etc.) which is fine in the browser.
 */
import { ChatSummarizer } from '../js/chat/summarizer.js';
import { State } from '../js/core.js';

const { T } = window;

// ============================================
// TIER DETECTION (Balanced mode = no shift)
// ============================================

T.suite('ChatSummarizer — Tier Detection');

// Mock State.models for tier testing
const originalModels = State.models;
const originalMode = State.settings.summarizerMode;

// Helper to set mock model
function setMockModel(contextTokens) {
    State.settings.llmModel = 'test-model';
    State.models = [{ id: 'test-model', meta: { contextTokens } }];
}

function resetMocks() {
    State.models = originalModels;
    State.settings.summarizerMode = originalMode;
}

// Force balanced mode for tier tests (no shift)
State.settings.summarizerMode = 'balanced';

// Small model (<32K)
setMockModel(8000);
T.eq(ChatSummarizer.getAutoParams().label, 'Small (<32K)', '8K model → Small tier');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 30, 'Small tier threshold = 30');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 10, 'Small tier recentBase = 10');

// Medium model (32K+)
setMockModel(32000);
T.eq(ChatSummarizer.getAutoParams().label, 'Medium (32K+)', '32K model → Medium tier');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 50, 'Medium tier threshold = 50');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 16, 'Medium tier recentBase = 16');

// Large model (128K+)
setMockModel(128000);
T.eq(ChatSummarizer.getAutoParams().label, 'Large (128K+)', '128K model → Large tier');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 80, 'Large tier threshold = 80');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 30, 'Large tier recentBase = 30');

// Huge model (500K+)
setMockModel(1000000);
T.eq(ChatSummarizer.getAutoParams().label, 'Huge (500K+)', '1M model → Huge tier');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 200, 'Huge tier threshold = 200');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 60, 'Huge tier recentBase = 60');
T.eq(ChatSummarizer.RECENT_COUNT_TOOLS, 100, 'Huge tier recentTools = 100');

// Edge case: exactly at boundary
setMockModel(500000);
T.eq(ChatSummarizer.getAutoParams().label, 'Huge (500K+)', '500K exactly → Huge tier');

setMockModel(31999);
T.eq(ChatSummarizer.getAutoParams().label, 'Small (<32K)', '31999 → Small tier (just under 32K)');

// No context info → falls back to Small
setMockModel(null);
T.eq(ChatSummarizer.getAutoParams().label, 'Small (<32K)', 'null context → Small tier fallback');

// ============================================
// MODE SHIFTING
// ============================================

T.suite('ChatSummarizer — Mode Shifting');

// Aggressive shifts tier +1 (toward smaller)
setMockModel(128000); // Detected: Large (index 1)
State.settings.summarizerMode = 'aggressive';
T.eq(ChatSummarizer.getAutoParams().label, 'Medium (32K+)', 'Aggressive shifts Large → Medium');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 50, 'Aggressive 128K: threshold from Medium tier');

// Conservative shifts tier -1 (toward larger)
State.settings.summarizerMode = 'conservative';
T.eq(ChatSummarizer.getAutoParams().label, 'Huge (500K+)', 'Conservative shifts Large → Huge');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 200, 'Conservative 128K: threshold from Huge tier');

// Aggressive on Small (already smallest) — clamped, stays Small
setMockModel(8000);
State.settings.summarizerMode = 'aggressive';
T.eq(ChatSummarizer.getAutoParams().label, 'Small (<32K)', 'Aggressive on Small stays Small (clamped)');

// Conservative on Huge (already largest) — clamped, stays Huge
setMockModel(1000000);
State.settings.summarizerMode = 'conservative';
T.eq(ChatSummarizer.getAutoParams().label, 'Huge (500K+)', 'Conservative on Huge stays Huge (clamped)');

// Legacy mode migration
State.settings.summarizerMode = 'auto';
T.eq(ChatSummarizer.mode, 'balanced', 'Legacy "auto" migrates to "balanced"');
State.settings.summarizerMode = 'manual';
T.eq(ChatSummarizer.mode, 'custom', 'Legacy "manual" migrates to "custom"');

T.suite('ChatSummarizer — Custom Mode');

// Custom mode should use State.settings.summarizer values
State.settings.summarizerMode = 'custom';
State.settings.summarizer = { recentCountBase: 20, threshold: 60 };
T.eq(ChatSummarizer.mode, 'custom', 'Mode reads from settings');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 20, 'Custom mode uses settings.summarizer value');
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 60, 'Custom mode threshold from settings');

// Balanced mode should ignore custom settings
State.settings.summarizerMode = 'balanced';
setMockModel(128000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 80, 'Balanced mode ignores custom settings, uses tier');

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
