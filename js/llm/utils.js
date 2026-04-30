/**
 * LLM Utilities
 * Pure functions for message sanitization and think-block stripping.
 * Extracted from llm.js in 0.9.13 — no external dependencies.
 * Tested by tests/test-llm-pure.js.
 */

// ============================================
// THINK-BLOCK SPLITTING
// ============================================

/**
 * Split <think> / <thinking> blocks out of text content.
 * Returns { content, reasoning } where reasoning concatenates every
 * captured block (joined by "\n\n" when multiple), or null if none.
 *
 * Handles multiple blocks, nested whitespace, partial/unclosed tags,
 * and both tag variants used by different model families.
 * Used for non-streaming responses where think blocks arrive intact;
 * the streaming path in js/llm/api.js does its own incremental capture.
 *
 * @param {string|null|undefined} text
 * @returns {{ content: string|null|undefined, reasoning: string|null }}
 */
export function splitThinkBlocks(text) {
    if (text === null || text === undefined || text === '') {
        return { content: text, reasoning: null };
    }
    const parts = [];
    let result = text.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_, inner) => {
        parts.push(inner);
        return '';
    });
    // Unclosed trailing block (model hit token limit mid-thought)
    result = result.replace(/<think(?:ing)?>([\s\S]*)$/gi, (_, inner) => {
        parts.push(inner);
        return '';
    });
    const reasoning = parts.length > 0 ? parts.join('\n\n').trim() : null;
    return {
        content: result.trim(),
        reasoning: reasoning && reasoning.length > 0 ? reasoning : null,
    };
}

/**
 * Legacy wrapper — strips think blocks and returns content only.
 * Plugins and renderers that don't yet consume reasoning continue to call this.
 * New code should prefer splitThinkBlocks() so reasoning is preserved.
 */
export function stripThinkBlocks(text) {
    if (!text) return text;
    return splitThinkBlocks(text).content;
}

// ============================================
// MESSAGE SANITIZATION
// ============================================

/**
 * Strip internal tracking fields from messages before API submission.
 * OpenAI API spec only allows: role, content, name, tool_calls, tool_call_id
 * Internal fields like timestamp, isSummary can cause API errors if included.
 * 
 * CRITICAL: This function MUST properly handle all message types:
 * - user/assistant messages with content
 * - assistant messages with tool_calls (content may be null)
 * - tool messages with tool_call_id and content (JSON string)
 * 
 * Uses explicit field copying instead of destructuring to avoid corruption.
 */
export function sanitizeMessages(messages) {
    const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
    
    return messages
        .filter(msg => {
            if (!VALID_ROLES.has(msg.role)) {
                console.warn(`[sanitizeMessages] Dropping invalid role: "${msg.role}"`);
                return false;
            }
            if (msg.role === 'assistant' && !msg.content && !msg.tool_calls) {
                console.warn('[sanitizeMessages] Dropping empty assistant message');
                return false;
            }
            return true;
        })
        .map(msg => {
            const clean = { role: msg.role };
            
            if (msg.content !== undefined && msg.content !== null) {
                clean.content = msg.content;
            } else if (msg.role === 'assistant' && msg.tool_calls) {
                clean.content = null;
            } else if (msg.content !== undefined) {
                clean.content = msg.content;
            }
            
            if (msg.name !== undefined) clean.name = msg.name;
            
            if (msg.tool_calls !== undefined) {
                clean.tool_calls = Array.isArray(msg.tool_calls)
                    ? msg.tool_calls.filter(tc => tc && tc.function?.name)
                    : msg.tool_calls;
            }
            
            if (msg.tool_call_id !== undefined) clean.tool_call_id = msg.tool_call_id;
            
            return clean;
        });
}
