// @ts-check
/**
 * Chat ↔ Compactor integration seam (1.2.0).
 *
 * Sits between `js/chat/handlers.js` and the existing
 * `ChatSummarizer.getContextMessages()` — the Compactor's per-turn pass
 * runs over the FULL `State.chatHistory` first, then ChatSummarizer's
 * existing windowing / tool-pair safety / summary-prefix logic runs on
 * the compressed result.
 *
 * Pipeline:
 *
 *   State.chatHistory
 *      ↓ chatHistoryToTurns
 *   Turn[]
 *      ↓ Compactor.compress({rules: subsumption, invalidation, …, preserve_recent: 24})
 *   Compressed Turn[]
 *      ↓ turnsToChatMessages
 *   Compressed ChatMessage[]
 *      ↓ ChatSummarizer.getContextMessages(compressed)
 *   Final messages array (LLM input)
 *
 * The Compactor receives no `summarizer` in 1.2.0 — Rule 5 stays in
 * `chat/summarizer.js` as before. With no summarizer, the Compactor's pipeline is
 * Rules 1+2 (eviction) + the tool-pair coherence pass.
 *
 * Diagnostics emitted by the Compactor are recorded onto the active
 * `LLMDebug` exchange via `LLMDebug.attachCompressionDiagnostics(diag)`
 * so the LLM debug modal can render the per-exchange "Compression
 * decisions" section.
 *
 * @module chat/compactor-integration
 */

import { State } from '../core.js';
import { resolveCompressionConfig } from '../profiles/resolve.js';
import { ConversationManager } from './conversations.js';
import {
    Compactor,
    chatHistoryToTurns,
    turnsToChatMessages,
} from '../intelligence/compression/index.js';
import { ChatSummarizer } from './summarizer.js';
import { LLMDebug } from '../llm.js';
import { isCompressionDisabled } from '../utils/compression-flag.js';

/**
 * @typedef {import('../intelligence/compression/contracts.js').Diagnostics} Diagnostics
 */

/** Per-call cache of the most recent diagnostics, exposed for tests / debug. */
let _lastDiagnostics = null;

/** @returns {Diagnostics|null} */
export function getLastCompressionDiagnostics() {
    return _lastDiagnostics;
}

/**
 * Build the LLM-ready context messages with compression applied.
 *
 * Defensive: any error inside the Compactor falls back to the existing
 * `ChatSummarizer.getContextMessages()` path so a compression bug never
 * breaks a chat round-trip.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getCompressedContextMessages() {
    let compressedMessages;
    let diagnostics = null;

    // Tier 2 dual-session control: when `?compression=off` is in the URL,
    // skip the Compactor entirely and route chat history straight into
    // ChatSummarizer — exactly the pre-1.2.0 path. Diagnostics record the
    // bypass so the LLM debug modal makes the mode obvious.
    if (isCompressionDisabled()) {
        diagnostics = {
            rules_run: [],
            rules_skipped: [],
            decisions_by_rule: {},
            evicted_ids: [],
            replaced_ids: [],
            summarized_spans: [],
            tokens_in: 0,
            tokens_out: 0,
            compression_ratio: 1,
            warnings: ['disabled_via:url_flag(?compression=off)'],
            rule_errors: [],
            latency_per_rule_ms: {},
            summarizer_latency_ms: 0,
        };
        _lastDiagnostics = diagnostics;
        if (LLMDebug && typeof LLMDebug.attachCompressionDiagnostics === 'function') {
            LLMDebug.attachCompressionDiagnostics(diagnostics);
        }
        return ChatSummarizer.getContextMessages(State.chatHistory);
    }

    try {
        // 1.21.0 — picker-aware: read active profile name through
        // settings so a user-set picker wins over the role selector.
        //
        // 2.8.0 — `getEffectiveProfileName()` consults the active
        // conversation's per-chat profile binding first, then falls
        // back to settings. This keeps compression rules consistent
        // with the systemPrompt + tool admission for the same
        // conversation (chat picks KB → compression rules become
        // empty for that chat, even if global settings is coder.v1).
        const config = resolveCompressionConfig(ConversationManager.getEffectiveProfileName());

        const turns = chatHistoryToTurns(State.chatHistory);
        const result = await Compactor.compress({
            history: turns,
            rules: config.rules,
            preserve_recent: config.preserve_recent,
            // No summarizer in 1.2.0 — let ChatSummarizer's existing
            // path handle Rule 5. Tighter integration is 1.2.4.
            summarizer: null,
            // Effectively disable Rule-5 budget triggering inside the
            // Compactor — we don't want it to drop oldest as fallback;
            // ChatSummarizer's RECENT_COUNT window does that job.
            budget_tokens: Number.POSITIVE_INFINITY,
        });

        diagnostics = result.diagnostics;
        compressedMessages = turnsToChatMessages(result.history, State.chatHistory);
    } catch (err) {
        // Defensive fallback. If Compactor crashes, log + bypass it
        // entirely so the user never sees a broken send button.
        console.warn('[Compactor] failed; falling back to summarizer-only:', err);
        diagnostics = {
            rules_run: [],
            rules_skipped: [],
            decisions_by_rule: {},
            evicted_ids: [],
            replaced_ids: [],
            summarized_spans: [],
            tokens_in: 0,
            tokens_out: 0,
            compression_ratio: 1,
            warnings: [`compactor_crash:${err && err.message ? err.message : String(err)}`],
            rule_errors: [],
            latency_per_rule_ms: {},
            summarizer_latency_ms: 0,
        };
        compressedMessages = State.chatHistory;
    }

    _lastDiagnostics = diagnostics;
    if (LLMDebug && typeof LLMDebug.attachCompressionDiagnostics === 'function') {
        LLMDebug.attachCompressionDiagnostics(diagnostics);
    }

    // Hand off to the existing summarizer windowing + summary-prefix
    // logic, but on the compressed history. ChatSummarizer was extended
    // in 1.2.0 to accept an optional history override.
    return ChatSummarizer.getContextMessages(compressedMessages);
}
