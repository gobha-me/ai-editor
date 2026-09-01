// @ts-check
/**
 * Rule 5 — Summarization (adapter).
 *
 * **Trigger:** Compressed history (after Rules 1–4) still exceeds budget.
 *
 * **Decision:** `Summarize` the oldest surviving block of turns.
 *
 * **Cost:** Expensive (LLM inference call).
 *
 * Per `docs/DESIGN-compression.md` §"Rule 5: Summarization", Rule 5 is a
 * budget-driven sweep, not a per-turn decision. The Compactor skips
 * summarizer rules in the per-turn pass (the rule's `evaluate` is never
 * called) and instead invokes the SummarizerFn passed in
 * `CompressionRequest.summarizer` when the budget check fails.
 *
 * The existing summarizer stays under `chat/summarizer.js` and is called as
 * the Rule 5 fallback. Users not hitting eviction patterns see no behavior
 * change.
 *
 * This module provides:
 *   - `SUMMARIZATION_RULE`: the marker registration profiles add to their
 *     `compression.rules` array. `is_summarizer: true` tells the
 *     Compactor to skip it in per-turn evaluation. Carries a no-op
 *     `evaluate` so its presence in the rule list doesn't blow up if
 *     any future code path forgets the `is_summarizer` check.
 *   - `wrapChatSummarizer(ChatSummarizer)`: builds a SummarizerFn that
 *     delegates to the existing `js/chat/summarizer.js` `_buildPrompt` +
 *     `_basicSummary` paths. Returned function is async.
 *
 * @module intelligence/compression/rules/summarization
 */

import { Keep } from '../decisions.js';
import { makeSynthesizedTurn } from '../turn-store.js';

/**
 * @typedef {import('../contracts.js').Turn}            Turn
 * @typedef {import('../contracts.js').CompressionRule} CompressionRule
 * @typedef {import('../contracts.js').SummarizerFn}    SummarizerFn
 */

/**
 * Rule priority — Summarization runs last (highest priority value among
 * the canonical rules). Compactor skips it in per-turn evaluation by
 * checking `is_summarizer === true`.
 */
export const SUMMARIZATION_PRIORITY = 50;

/** @type {CompressionRule} */
export const SUMMARIZATION_RULE = {
    name: 'summarization',
    priority: SUMMARIZATION_PRIORITY,
    is_summarizer: true,
    // No-op evaluator. The Compactor skips summarizer rules in the per-
    // turn pass; if a caller does invoke this it returns Keep harmlessly
    // rather than crashing.
    evaluate: () => Keep(),
};

/**
 * Build a SummarizerFn that wraps the existing `ChatSummarizer` from
 * `js/chat/summarizer.js`. The returned function takes a span of Turn[]
 * and returns a freshly synthesized system-role Turn carrying the
 * summary text.
 *
 * Phase 1 strategy:
 *   1. Reconstruct ChatMessage[] from the span (using Turn.content).
 *   2. Call `ChatSummarizer._buildPrompt(messages)` for the prompt.
 *   3. Call `ChatSummarizer.LLM`-equivalent path via the wrapper-supplied
 *      summarizer function (caller injects the LLM dependency to keep
 *      this module pure and testable).
 *   4. On any failure, fall back to `ChatSummarizer._basicSummary` —
 *      same defensive pattern the existing summarizer already uses.
 *
 * The caller (Commit 5 integration code at js/chat/handlers.js) supplies
 * both the ChatSummarizer reference and the LLM call function.
 *
 * @param {Object} options
 * @param {Object} options.ChatSummarizer  Reference to js/chat/summarizer.js singleton.
 * @param {(prompt: string) => Promise<string>} options.callLLM  Async fn that returns summary text.
 * @returns {SummarizerFn}
 */
export function wrapChatSummarizer({ ChatSummarizer, callLLM }) {
    if (!ChatSummarizer || typeof ChatSummarizer._buildPrompt !== 'function') {
        throw new TypeError('wrapChatSummarizer: ChatSummarizer must expose _buildPrompt');
    }
    if (typeof callLLM !== 'function') {
        throw new TypeError('wrapChatSummarizer: callLLM must be a function');
    }

    return async function summarize(span) {
        // Reconstruct ChatMessage shape from Turn span — _buildPrompt
        // expects {role, content, tool_calls?}. We pass through whatever
        // the Turn carries; the existing _buildPrompt is defensive about
        // missing fields.
        const messages = span.map(t => ({
            role: t && t.role === 'tool_result' ? 'tool'
                : t && t.role === 'tool_call'   ? 'assistant'
                : (t && t.role) || 'system',
            content: t && t.content,
            // Preserve tool_calls if the source Turn was an assistant with them.
            tool_calls: t && t.metadata && t.metadata.has_tool_calls ? [{ noop: true }] : undefined,
            tool_call_id: t && t.metadata ? t.metadata.tool_call_id : undefined,
        }));

        let summaryText;
        try {
            const prompt = ChatSummarizer._buildPrompt(messages);
            summaryText = await callLLM(prompt);
            if (typeof summaryText !== 'string' || !summaryText.trim()) {
                summaryText = ChatSummarizer._basicSummary(messages);
            }
        } catch (err) {
            // Defensive fallback — the Compactor will record the warning.
            summaryText = ChatSummarizer._basicSummary
                ? ChatSummarizer._basicSummary(messages)
                : `[Compactor: ${span.length} turns summarized (summarizer error: ${err.message || err})]`;
        }

        const firstId = span.length > 0 ? span[0].id : 'T?';
        const lastId  = span.length > 0 ? span[span.length - 1].id : 'T?';
        const marker  = `[Compactor summary covering ${span.length} turns ${firstId}..${lastId}]\n\n${summaryText}`;
        const ts      = span.length > 0 && typeof span[span.length - 1].timestamp === 'number'
            ? span[span.length - 1].timestamp
            : Date.now();

        return makeSynthesizedTurn(marker, `summarized:${firstId}..${lastId}`, ts);
    };
}
