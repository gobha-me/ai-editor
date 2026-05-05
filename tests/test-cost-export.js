/**
 * Tests for the Cost-tab export builder (1.6.6).
 *
 * `buildCostExport()` is the pure data path — no DOM, no Blob — so we can
 * assert the JSON-export shape directly. The actual click handler wraps
 * this with the standard Blob/URL/<a download> dance (mirrors Memory tab).
 */
import { Storage } from '../js/core.js';
import { recordTurn, setBudget } from '../js/intelligence/cost/cost-store.js';
import { ConversationManager } from '../js/chat/conversations.js';
import { buildCostExport } from '../js/settings/cost-tab.js';

const { T } = window;

await Storage.init();

T.suite('Cost — Export (regression for 1.6.6)');

// -- Seed deterministic state -----------------------------------------------

// Two synthetic conversations with cost records.
const convA = `__test_conv_export_a_${Date.now()}`;
const convB = `__test_conv_export_b_${Date.now() + 1}`;

// Stash and replace the conversation index so the test is hermetic.
const savedIndex = Storage.get('conversations', null);
Storage.set('conversations', [
    { id: convA, title: 'Conversation A', createdAt: 1000, updatedAt: 2000, messageCount: 4 },
    { id: convB, title: 'Conversation B', createdAt: 1100, updatedAt: 2100, messageCount: 2 },
]);

// Stash any pre-existing budget so we can restore.
const savedBudget = Storage.get('cost-budget', null);
setBudget({ daily: 5, monthly: 50 });

// Record a couple of turns to populate per-conv + daily map.
recordTurn({
    conversationId: convA,
    provider: 'venice',
    modelId: 'qwen-3-6-plus',
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    cost: 0.12,
    cacheSavings: 0,
});
recordTurn({
    conversationId: convB,
    provider: 'openrouter',
    modelId: 'gpt-4o',
    inputTokens: 800,
    outputTokens: 200,
    cachedInputTokens: 100,
    reasoningTokens: 0,
    cost: 0.07,
    cacheSavings: 0.01,
});

// -- Build + assert ---------------------------------------------------------

const out = buildCostExport();

T.assert(typeof out === 'object' && out !== null, 'returns an object');

// Top-level shape
T.eq(typeof out.version, 'string', 'has version (string)');
T.assert(/^\d+\.\d+\.\d+/.test(out.version), `version looks semver-ish (got ${out.version})`);
T.eq(typeof out.exportedAt, 'string', 'has exportedAt (string)');
T.assert(!isNaN(Date.parse(out.exportedAt)), 'exportedAt is parseable ISO');

// Summary
T.assert(out.summary && typeof out.summary === 'object', 'has summary object');
T.eq(typeof out.summary.todaySpend, 'number', 'summary.todaySpend is number');
T.eq(typeof out.summary.monthSpend, 'number', 'summary.monthSpend is number');
T.assert(out.summary.budget && typeof out.summary.budget === 'object', 'summary.budget is object');
T.eq(out.summary.budget.daily, 5, 'budget.daily passes through from store');
T.eq(out.summary.budget.monthly, 50, 'budget.monthly passes through from store');

// Daily map: today's date should be present and have a non-zero cost
T.assert(out.dailyMap && typeof out.dailyMap === 'object', 'has dailyMap object');
const todayKey = new Date().toISOString().slice(0, 10); // matches localDateKey() at midnight UTC days
const localToday = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
})();
const dayEntry = out.dailyMap[localToday] || out.dailyMap[todayKey];
T.assert(dayEntry, `dailyMap has an entry for today (looked for ${localToday})`);
T.assert(dayEntry.cost >= 0.18, `today's recorded cost present (got ${dayEntry?.cost})`);

// Conversations
T.assert(Array.isArray(out.conversations), 'conversations is array');
T.assert(out.conversations.length >= 2, `includes seeded conversations (got ${out.conversations.length})`);
const aRow = out.conversations.find((c) => c.id === convA);
const bRow = out.conversations.find((c) => c.id === convB);
T.assert(aRow, 'conversation A row exported');
T.assert(bRow, 'conversation B row exported');
T.eq(aRow.title, 'Conversation A', 'conversation A title preserved');
T.assert(aRow.cost && typeof aRow.cost === 'object', 'conversation A has cost object');
T.assert(aRow.cost.cost >= 0.12, `conversation A cost recorded (got ${aRow.cost?.cost})`);
T.assert(bRow.cost && bRow.cost.cost >= 0.07, `conversation B cost recorded (got ${bRow.cost?.cost})`);

// JSON-serializable round-trip — no Date objects, no functions, no cycles.
let serialized;
try {
    serialized = JSON.stringify(out);
} catch (e) {
    T.assert(false, `payload not JSON-serializable: ${e.message}`);
}
T.assert(typeof serialized === 'string' && serialized.length > 50, 'payload serializes to JSON');
const reparsed = JSON.parse(serialized);
T.eq(reparsed.version, out.version, 'JSON round-trip preserves version');
T.eq(reparsed.conversations.length, out.conversations.length, 'JSON round-trip preserves conversations length');

// -- Cleanup ----------------------------------------------------------------

Storage.remove(`cost-by-conv-${convA}`);
Storage.remove(`cost-by-conv-${convB}`);
if (savedIndex === null) Storage.remove('conversations');
else Storage.set('conversations', savedIndex);
if (savedBudget === null) Storage.remove('cost-budget');
else Storage.set('cost-budget', savedBudget);
