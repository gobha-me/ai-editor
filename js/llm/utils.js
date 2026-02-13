/**
 * LLM Utilities
 * Pure functions for message sanitization and think-block stripping.
 * Extracted from llm.js in 0.9.13 — no external dependencies.
 * Tested by tests/test-llm-pure.js.
 */

// ============================================
// THINK-BLOCK STRIPPING
// ============================================

/**
 * Strip <think> / <thinking> blocks from text content.
 * Handles multiple blocks, nested whitespace, partial/unclosed tags,
 * and both tag variants used by different model families.
 * Used for non-streaming responses where think blocks arrive intact.
 */
export function stripThinkBlocks(text) {
    if (!text) return text;
    // Closed blocks: <think>...</think> and <thinking>...</thinking>
    let result = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    // Unclosed trailing blocks (model hit token limit mid-thought)
    result = result.replace(/<think(?:ing)?>[\s\S]*$/gi, '');
    return result.trim();
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
