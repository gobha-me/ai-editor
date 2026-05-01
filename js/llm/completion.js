// @ts-check
/**
 * Lean ghost-text completion path. Sits next to the chat client (`LLM.chat`)
 * but doesn't share its AbortController or `State.isGenerating` flag — chat
 * and ghost text can be in flight at once without trampling each other.
 *
 * The shape is deliberately tight:
 *   - tools always null (ghost text is non-tool-using by contract)
 *   - stream always false (single short return; no token-by-token UX)
 *   - max_tokens small (default 150)
 *   - temperature low (default 0.2 — completion, not creativity)
 *   - caller-owned signal for abort
 *
 * Cost-control framing: every byte sent here is paid for on every Tab press.
 * Keep prefix/suffix bounded; keep the system prompt one paragraph.
 *
 * @since 1.4.7
 * @module llm/completion
 */

import { State, ProviderRegistry } from '../core.js';
import { buildRequestBody } from './api.js';
import { stripThinkBlocks } from './utils.js';

/**
 * @typedef {Object} GhostTextRequest
 * @property {string} prefix      - Text before the cursor (already sliced to context window).
 * @property {string} suffix      - Text after the cursor (already sliced to context window).
 * @property {string} [language]  - Language hint, e.g. 'javascript', 'python'. Empty/unknown is fine.
 * @property {string} [filename]  - Filename for additional grounding. Empty is fine.
 * @property {AbortSignal} [signal] - Caller-owned abort signal.
 * @property {string} [model]     - Override model id; falls back to `State.settings.llmModel`.
 * @property {number} [maxTokens] - Output cap; default 150.
 * @property {number} [temperature] - Default 0.2.
 */

/**
 * Build the system prompt for ghost-text completions. Single paragraph by
 * design — every extra sentence is paid on every keypress.
 *
 * @param {string} [language]
 * @param {string} [filename]
 * @returns {string}
 */
export function buildGhostTextSystemPrompt(language, filename) {
    const langHint = language ? ` The code is ${language}.` : '';
    const fileHint = filename ? ` Filename: ${filename}.` : '';
    return (
        'You are an inline code-completion engine. ' +
        'The user is editing a file; their cursor sits between <PREFIX> and <SUFFIX>. ' +
        'Output ONLY the text that should appear at the cursor — no explanations, no fences, no commentary, no leading or trailing prose. ' +
        'Continue the code naturally. Stop at a sensible boundary (end of expression / line / small block).' +
        langHint +
        fileHint
    );
}

/**
 * Build the user message body that frames prefix + suffix for the model.
 *
 * @param {string} prefix
 * @param {string} suffix
 * @returns {string}
 */
export function buildGhostTextUserMessage(prefix, suffix) {
    return `<PREFIX>${prefix}</PREFIX><SUFFIX>${suffix}</SUFFIX>`;
}

/**
 * Strip a leading/trailing markdown fence and any leading <think> block from
 * a model response. Some models still wrap inline-completion output even
 * when told not to; defending here keeps the decoration clean.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanCompletionResponse(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return '';
    let s = stripThinkBlocks(raw);
    // Strip a single leading fence + optional language tag, e.g. ```js\n
    s = s.replace(/^\s*```[\w-]*\n?/, '');
    // Strip a single trailing fence
    s = s.replace(/\n?```\s*$/, '');
    return s;
}

/**
 * Request a single non-tool, non-streamed completion at the cursor.
 * Honors the caller's AbortSignal — aborting terminates the in-flight
 * fetch rather than just discarding the resolved value.
 *
 * @param {GhostTextRequest} req
 * @returns {Promise<string>} The cleaned completion text. May be empty.
 * @throws Will rethrow on abort (DOMException name 'AbortError') and on
 *   non-2xx HTTP responses.
 */
export async function requestGhostTextCompletion(req) {
    const {
        prefix = '',
        suffix = '',
        language = '',
        filename = '',
        signal,
        model: modelOverride,
        maxTokens = 150,
        temperature = 0.2,
    } = req || {};

    const model = modelOverride || State.settings.llmModel;
    const endpoint = (State.settings.llmEndpoint || '').replace(/\/$/, '');
    const apiKey = State.settings.llmApiKey || '';

    if (!endpoint) {
        throw new Error('Ghost text: no LLM endpoint configured');
    }

    const messages = [
        { role: 'system', content: buildGhostTextSystemPrompt(language, filename) },
        { role: 'user', content: buildGhostTextUserMessage(prefix, suffix) },
    ];

    const requestBody = buildRequestBody(model, messages, {
        stream: false,
        maxTokens,
        temperature,
        tools: null,
    });

    const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...ProviderRegistry.getHeaders(State.settings),
        },
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ghost text: ${response.status} — ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content || '';
    return cleanCompletionResponse(rawContent);
}

/**
 * Slice a buffer around a cursor offset into prefix + suffix, capped at
 * `contextLines` lines either side. Pure function — testable without a DOM.
 *
 * @param {string} text
 * @param {number} cursorOffset - 0-based char offset into `text`.
 * @param {number} [contextLines=40]
 * @returns {{prefix: string, suffix: string}}
 */
export function sliceContextAroundCursor(text, cursorOffset, contextLines = 40) {
    if (typeof text !== 'string') return { prefix: '', suffix: '' };
    const safeOffset = Math.max(0, Math.min(cursorOffset | 0, text.length));
    const before = text.slice(0, safeOffset);
    const after = text.slice(safeOffset);

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');

    const lines = Math.max(1, contextLines | 0);
    const prefix = beforeLines.slice(Math.max(0, beforeLines.length - lines)).join('\n');
    const suffix = afterLines.slice(0, lines).join('\n');

    return { prefix, suffix };
}
