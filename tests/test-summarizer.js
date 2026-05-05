/**
 * Tests for ChatSummarizer — percentage-based scaling, mode differentiation,
 * symbol extraction, tool result handling.
 * Imports the full module graph (core.js → providers → etc.) which is fine in the browser.
 */
import { ChatSummarizer } from '../js/chat/summarizer.js';
import { State, Storage } from '../js/core.js';

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

// 1M model, balanced: ctx>524K → scale=8 (per getContextScale).
// capacity = clamp(1000000 * 0.50 / 800, 20, 250*8=2000) = 625
// threshold = clamp(625, 20, 200*8=1600) = 625
// recentBase = clamp(round(625*0.35), 8, 60*8=480) = 219
// recentTools = clamp(round(625*0.60), 16, 100*8=800) = 375
setMockModel(1000000);
T.eq(ChatSummarizer.SUMMARY_THRESHOLD, 625, '1M balanced: threshold=625 (capacity, well under scale-8 cap)');
T.eq(ChatSummarizer.RECENT_COUNT_BASE, 219, '1M balanced: recentBase=219 (capacity*0.35, well under scale-8 cap)');
T.eq(ChatSummarizer.RECENT_COUNT_TOOLS, 375, '1M balanced: recentTools=375 (capacity*0.60, well under scale-8 cap)');

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

// ============================================
// TRUNCATION MARKER + PIN FIRST USER TURN (1.6.0 PR 0)
// ============================================

T.suite('ChatSummarizer — truncation marker + pin first user turn (1.6.0 PR 0)');

const originalChatHistory = State.chatHistory;
const originalSummaryInfo = Storage.get('chatSummaryInfo', null);

// Case 1: marker present when history > RECENT_COUNT and no summary exists
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    const recentCount = ChatSummarizer.RECENT_COUNT_BASE; // 28 for 128K balanced
    const n = recentCount + 20;
    State.chatHistory = Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`
    }));

    const ctx = ChatSummarizer.getContextMessages();
    T.eq(ctx[0].role, 'system', 'first ctx msg is system (marker)');
    T.assert(ctx[0].isSummary === true, 'marker carries isSummary: true');
    T.assert(/truncated/i.test(ctx[0].content), 'marker mentions "truncated"');
    T.assert(/\d+ earlier message/i.test(ctx[0].content), 'marker reports a numeric drop count');
}

// Case 2: first user turn is pinned when sliced off
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    const recentCount = ChatSummarizer.RECENT_COUNT_BASE;
    const n = recentCount + 20;
    State.chatHistory = [
        { role: 'user', content: 'ORIGINAL_TASK_FRAMING' },
        ...Array.from({ length: n - 1 }, (_, i) => ({
            role: i % 2 === 0 ? 'assistant' : 'user',
            content: `m${i}`
        }))
    ];

    const ctx = ChatSummarizer.getContextMessages();
    const pinned = ctx.find(m => m.content === 'ORIGINAL_TASK_FRAMING');
    T.assert(!!pinned, 'first user turn was pinned into context');
    T.eq(pinned?.role, 'user', 'pinned message kept user role');
    T.assert(pinned?.isSummary === true, 'pinned message tagged isSummary: true');
}

// Case 3: no marker when history fits within RECENT_COUNT
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    State.chatHistory = Array.from({ length: 5 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`
    }));

    const ctx = ChatSummarizer.getContextMessages();
    T.assert(!ctx.some(m => m.isSummary), 'no marker injected when nothing was sliced');
    T.eq(ctx.length, 5, 'all messages preserved when within window');
}

// Case 4: existing summary path still wins (no double-marker)
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.set('chatSummaryInfo', { summary: 'prior summary text', lastIndex: 5 });
    const recentCount = ChatSummarizer.RECENT_COUNT_BASE;
    const n = recentCount + 20;
    State.chatHistory = Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`
    }));

    const ctx = ChatSummarizer.getContextMessages();
    T.assert(/CONVERSATION SUMMARY/.test(ctx[0].content), 'summary path takes precedence over marker');
    T.assert(!/Context note:/.test(ctx[0].content), 'truncation marker is not injected when summary present');
}

// Restore
State.chatHistory = originalChatHistory;
if (originalSummaryInfo) Storage.set('chatSummaryInfo', originalSummaryInfo);
else Storage.remove('chatSummaryInfo');

// ============================================
// BOUNDARY-AWARE PRUNE (1.6.1 PR 1)
// ============================================

T.suite('ChatSummarizer — boundary-aware prune (1.6.1 PR 1)');

const _origChatHistory_161 = State.chatHistory;
const _origSummaryInfo_161 = Storage.get('chatSummaryInfo', null);
const _origPruneStash_161 = Storage.get('chatPruneStash', null);

function _restore_161() {
    State.chatHistory = _origChatHistory_161;
    if (_origSummaryInfo_161) Storage.set('chatSummaryInfo', _origSummaryInfo_161);
    else Storage.remove('chatSummaryInfo');
    if (_origPruneStash_161) Storage.set('chatPruneStash', _origPruneStash_161);
    else Storage.remove('chatPruneStash');
}

// Case 1: cut between assistant(tool_calls) and its tool messages → backward-aligns
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    Storage.remove('chatPruneStash');
    // [user, asst, user, asst(tool_calls), tool, tool, user, asst]
    State.chatHistory = [
        { role: 'user', content: 'u0' },
        { role: 'assistant', content: 'a0' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1a' },
        { role: 'tool', tool_call_id: 't1', content: 'r1b' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' }
    ];
    // Naive prune of 4 would land between asst(tool_calls) at index 3 and tool at index 4 — unsafe.
    const adjusted = ChatSummarizer._alignPruneBoundary(State.chatHistory, 4);
    T.assert(adjusted < 4, `alignment shortened prune (got ${adjusted}, expected < 4)`);
    T.eq(adjusted, 3, 'aligned to k=3 (before the assistant(tool_calls))');

    const before = State.chatHistory.length;
    const ok = ChatSummarizer._pruneHistory(4);
    T.eq(ok, true, '_pruneHistory returns true after successful aligned prune');
    T.assert(State.chatHistory[0]?.role !== 'tool', 'post-prune chatHistory does not start with orphan tool');
    T.eq(State.chatHistory.length, before - 3, 'pruned 3 messages (aligned), not 4');
    T.eq(State.chatHistory[0]?.role, 'assistant', 'post-prune begins on assistant(tool_calls) — kept with its tool replies');
    T.assert(Array.isArray(State.chatHistory[0]?.tool_calls), 'tool_calls preserved on assistant');
}

// Case 2: cut in middle of a 3-tool group — backward walks past all three
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    Storage.remove('chatPruneStash');
    // [user, asst(tool_calls), tool, tool, tool, user, asst]
    State.chatHistory = [
        { role: 'user', content: 'u0' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'scan_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' },
        { role: 'tool', tool_call_id: 't1', content: 'r2' },
        { role: 'tool', tool_call_id: 't1', content: 'r3' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' }
    ];
    // Naive prune of 3 would land mid-tool-group (between tool[1] and tool[2]).
    const adjusted = ChatSummarizer._alignPruneBoundary(State.chatHistory, 3);
    T.eq(adjusted, 1, 'aligned to k=1 (before assistant(tool_calls)) — backward walk traversed three tool rows');

    const ok = ChatSummarizer._pruneHistory(3);
    T.eq(ok, true, 'prune succeeded on aligned boundary');
    T.assert(State.chatHistory[0]?.role !== 'tool', 'post-prune does not begin on tool');
    T.eq(State.chatHistory[0]?.role, 'assistant', 'post-prune begins on assistant(tool_calls)');
}

// Case 3: cut already on a clean boundary → alignment is a no-op
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    Storage.remove('chatPruneStash');
    State.chatHistory = [
        { role: 'user', content: 'u0' },
        { role: 'assistant', content: 'a0' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' }
    ];
    const adjusted = ChatSummarizer._alignPruneBoundary(State.chatHistory, 2);
    T.eq(adjusted, 2, 'clean boundary returns input unchanged');
}

// Case 4: no safe boundary in older slice → decline
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    Storage.remove('chatPruneStash');
    // [asst(tool_calls), tool, tool, user, asst]  pruneCount=2
    // For every k in [1..2]: k=2 starts on a tool (orphan), k=1 splits
    // asst(tool_calls) from its first tool. No safe k > 0 → decline.
    State.chatHistory = [
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' },
        { role: 'tool', tool_call_id: 't1', content: 'r2' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' }
    ];
    const snapshotLen = State.chatHistory.length;
    const adjusted = ChatSummarizer._alignPruneBoundary(State.chatHistory, 2);
    T.eq(adjusted, 0, 'no safe boundary → returns 0 (decline)');

    const ok = ChatSummarizer._pruneHistory(2);
    T.eq(ok, false, '_pruneHistory returns false on decline');
    T.eq(State.chatHistory.length, snapshotLen, 'chatHistory length unchanged on decline');
    T.eq(State.chatHistory[0]?.role, 'assistant', 'chatHistory[0] still asst(tool_calls) on decline');
}

// Case 5: pure user/assistant history (no tool calls) → prune behaves identically to pre-fix
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    Storage.remove('chatPruneStash');
    State.chatHistory = [
        { role: 'user', content: 'u0' },
        { role: 'assistant', content: 'a0' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' }
    ];
    const adjusted = ChatSummarizer._alignPruneBoundary(State.chatHistory, 4);
    T.eq(adjusted, 4, 'no tool calls → alignment is no-op');

    const ok = ChatSummarizer._pruneHistory(4);
    T.eq(ok, true, 'prune succeeded');
    T.eq(State.chatHistory.length, 3, 'pruned 4 messages from front');
    T.eq(State.chatHistory[0]?.content, 'u2', 'recent window starts at index-4 message u2');
}

// Case 6: end-to-end smoke via getContextMessages() — no orphan tool at front of context
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    Storage.remove('chatPruneStash');
    // Synthesize a "poisoned" history where naive prune would orphan tools.
    // Build > RECENT_COUNT_BASE so getContextMessages() actually slices.
    const recentCount = ChatSummarizer.RECENT_COUNT_BASE; // 28 for 128K balanced
    const head = [
        { role: 'user', content: 'TASK_FRAMING' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' },
        { role: 'tool', tool_call_id: 't1', content: 'r2' }
    ];
    const tail = Array.from({ length: recentCount + 5 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`
    }));
    State.chatHistory = [...head, ...tail];

    // Drive a prune that would naively land mid-tool-group
    ChatSummarizer._pruneHistory(3); // index 3 = second tool of t1 group → unsafe → backward-aligns

    // Build the context the LLM would see and assert it has no orphan tool at the front
    const ctx = ChatSummarizer.getContextMessages();
    // First non-system / non-summary message must NOT be a tool with no preceding assistant(tool_calls).
    let sawAsstWithToolCalls = false;
    for (const m of ctx) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            sawAsstWithToolCalls = true;
            continue;
        }
        if (m.role === 'tool') {
            T.assert(sawAsstWithToolCalls, 'tool message has a preceding assistant(tool_calls) in returned context');
        }
    }
}

_restore_161();

// ============================================
// 1.6.4 — Token-based summarization trigger
// ============================================

T.suite('ChatSummarizer — token-based trigger (1.6.4)');

const _origLastTokens_164 = State.lastExchangeTokens;
const _origSummaryInfo_164 = Storage.get('chatSummaryInfo', null);
const _origChatHistory_164 = State.chatHistory;
function _restore_164() {
    State.lastExchangeTokens = _origLastTokens_164;
    State.chatHistory = _origChatHistory_164;
    if (_origSummaryInfo_164) Storage.set('chatSummaryInfo', _origSummaryInfo_164);
    else Storage.remove('chatSummaryInfo');
}

// Case 1: token gate fires when last prompt_tokens crosses ctx × fillPct
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';   // 50% → gate at 64K
    Storage.remove('chatSummaryInfo');
    State.chatHistory = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = { prompt: 70000, cached: 0, ts: Date.now() };
    T.eq(ChatSummarizer.shouldSummarize(), true,
        'token-gate fires when last prompt_tokens ≥ ctx × fillPct');
}

// Case 2: token gate suppresses even when message-count would say yes
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    State.chatHistory = Array.from({ length: 250 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = { prompt: 25000, cached: 0, ts: Date.now() };
    T.eq(ChatSummarizer.shouldSummarize(), false,
        'token-aware path dominates when populated (suppresses message-count fallback)');
}

// Case 3: lastExchangeTokens=null → fall back to message-count gate
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    Storage.remove('chatSummaryInfo');
    State.chatHistory = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = null;
    T.eq(ChatSummarizer.shouldSummarize(), true,
        'message-count fallback preserves pre-1.6.4 behaviour');
}

// Case 4: token gate respects SUMMARY_INTERVAL backstop
{
    setMockModel(128000);
    State.settings.summarizerMode = 'balanced';
    State.chatHistory = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`
    }));
    State.lastExchangeTokens = { prompt: 80000, cached: 0, ts: Date.now() };
    Storage.set('chatSummaryInfo', { summary: 'prior', coveredCount: 95 });
    T.eq(ChatSummarizer.shouldSummarize(), false,
        'interval backstop suppresses second summary');
}

_restore_164();

// ============================================
// 1.6.4 — Map-reduce / multi-pass summarization
// ============================================

T.suite('ChatSummarizer — map-reduce summarization (1.6.4)');

const _origCallSummaryLLM = ChatSummarizer._callSummaryLLM;
function _restoreLeafMock() { ChatSummarizer._callSummaryLLM = _origCallSummaryLLM; }

function _msgs(n, sizePerMsg) {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(sizePerMsg) + ' m' + i,
    }));
}

await (async () => {
    // Case 1: small input + large budget → exactly one LLM call
    {
        let calls = 0;
        ChatSummarizer._callSummaryLLM = async () => { calls++; return 'leaf'; };
        const out = await ChatSummarizer._summarizeRecursive(_msgs(8, 20), 'm', 1_000_000, 0);
        T.eq(calls, 1, 'multi-pass: small input + huge budget → 1 leaf call');
        T.eq(out, 'leaf', 'multi-pass: returns leaf string in base case');
        _restoreLeafMock();
    }

    // Case 2: small budget → fan-out leaves + reduce
    {
        const calls = [];
        ChatSummarizer._callSummaryLLM = async (prompt) => {
            calls.push(prompt.length);
            return 'summary-' + calls.length;
        };
        await ChatSummarizer._summarizeRecursive(_msgs(40, 120), 'm', 800, 0);
        T.assert(calls.length >= 3,
            `multi-pass: small budget yields ≥3 calls (≥2 leaves + 1 reduce), got ${calls.length}`);
        _restoreLeafMock();
    }

    // Case 3: very small budget → recursion goes ≥2 levels deep
    {
        const depthsSeen = [];
        const _origRecursive = ChatSummarizer._summarizeRecursive;
        ChatSummarizer._summarizeRecursive = async function(msgs, model, budget, depth) {
            depthsSeen.push(depth);
            return _origRecursive.call(this, msgs, model, budget, depth);
        };
        ChatSummarizer._callSummaryLLM = async () => 'leaf';
        await ChatSummarizer._summarizeRecursive(_msgs(60, 200), 'm', 400, 0);
        T.assert(Math.max(...depthsSeen) >= 2,
            `multi-pass: recursion reached depth ≥2 (saw ${depthsSeen.join(',')})`);
        ChatSummarizer._summarizeRecursive = _origRecursive;
        _restoreLeafMock();
    }

    // Case 4: pathological depth cap → falls back to _basicSummary
    {
        let basicCalled = 0;
        const _origBasic = ChatSummarizer._basicSummary;
        ChatSummarizer._basicSummary = function(messages) {
            basicCalled++;
            return _origBasic.call(this, messages);
        };
        ChatSummarizer._callSummaryLLM = async () => 'leaf';
        const out = await ChatSummarizer._summarizeRecursive(_msgs(50, 200), 'm', 10, 0);
        T.assert(basicCalled > 0, 'multi-pass: depth cap fell back to _basicSummary');
        T.assert(typeof out === 'string' && out.length > 0,
            'multi-pass: returned a non-empty string from basicSummary');
        ChatSummarizer._basicSummary = _origBasic;
        _restoreLeafMock();
    }

    // Case 5b: heavy-tool session — token gate fires, recent scales to half-history
    // Regression for the 1.6.4 dogfood symptom (2026-05-05): minimax-m27 (196K),
    // 37 messages of mostly large tool results pushed prompt_tokens to 105K (over
    // the 98K balanced gate). shouldSummarize() returned true, but generateAndStore()
    // silently bailed at `older.length < 5` because RECENT_COUNT_TOOLS was ~73.
    {
        setMockModel(196000);
        State.settings.summarizerMode = 'balanced';
        Storage.remove('chatSummaryInfo');
        State.settings.commitModel = undefined;
        State.chatHistory = Array.from({ length: 30 }, (_, i) => {
            if (i % 2 === 0) {
                return {
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: 'call_' + i,
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"big.js"}' },
                    }],
                };
            }
            return {
                role: 'tool',
                tool_call_id: 'call_' + (i - 1),
                content: 'x'.repeat(7000),
            };
        });
        State.lastExchangeTokens = { prompt: 105808, cached: 7936, ts: Date.now() };

        let recursiveCalled = false;
        const _origRecursive = ChatSummarizer._summarizeRecursive;
        ChatSummarizer._summarizeRecursive = async () => { recursiveCalled = true; return 'mocked-summary'; };
        const _origPrune = ChatSummarizer._pruneHistory;
        ChatSummarizer._pruneHistory = () => true;

        const result = await ChatSummarizer.generateAndStore();

        T.eq(recursiveCalled, true,
            'heavy-tool: generateAndStore reached _summarizeRecursive (no silent bail)');
        T.assert(result && typeof result === 'object',
            'heavy-tool: returned a SummaryInfo, not null');
        T.assert(result && result.compressedMessages >= 5,
            'heavy-tool: compressed at least 5 messages');
        T.assert(result && result.keptMessages <= Math.floor(30 / 2) + 1,
            'heavy-tool: keptMessages reflects the half-history cap');

        ChatSummarizer._summarizeRecursive = _origRecursive;
        ChatSummarizer._pruneHistory = _origPrune;
        _restore_164();
    }

    // Case 6: utility model window (commitModel) drives perPassBudget, not main model window
    {
        State.settings.llmModel = 'big-prod';
        State.settings.commitModel = 'tiny-utility';
        State.models = [
            { id: 'big-prod',     meta: { contextTokens: 1_000_000 } },
            { id: 'tiny-utility', meta: { contextTokens: 8_000     } },
        ];
        State.settings.summarizerMode = 'balanced';
        Storage.remove('chatSummaryInfo');

        // Bumped to 400 so `older = history.slice(0, -RECENT_COUNT)` is non-empty
        // (RECENT_COUNT for a 1M model in balanced mode is ~219).
        State.chatHistory = Array.from({ length: 400 }, (_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: 'y'.repeat(400) + ' h' + i,
        }));
        State.lastExchangeTokens = { prompt: 700000, cached: 0, ts: Date.now() };

        let observedBudget = null;
        const _origRecursive = ChatSummarizer._summarizeRecursive;
        ChatSummarizer._summarizeRecursive = async function(msgs, model, budget, depth) {
            if (depth === 0) observedBudget = budget;
            return 'mocked';
        };
        await ChatSummarizer.generateAndStore();

        // utilityCtx=8000, fillPct=0.5, budget = max(1500, floor(8000*0.5*0.7)=2800) = 2800
        T.eq(observedBudget, 2800,
            'multi-pass: perPassBudget derived from utility model window');
        ChatSummarizer._summarizeRecursive = _origRecursive;
        State.settings.commitModel = undefined;
        _restore_164();
    }
})();

// Restore
resetMocks();
