/**
 * Tool Execution and Validation
 * Handles tool parameter validation, execution, and text-format parsing
 */

import { ToolRegistry } from '../tools/registry.js';

/**
 * Validate that required parameters are present and non-empty.
 * Prevents bugs where AI hits token limits and sends incomplete tool calls.
 */
export function validateToolParameters(toolName, args) {
    // Define required parameters for each tool
    const requiredParams = {
        'create_file': ['path', 'content', 'message'],
        'delete_file': ['path'],
        'replace_lines': ['start_line', 'end_line', 'new_content'],
        'insert_lines': ['after_line', 'content'],
        'delete_lines': ['start_line', 'end_line'],
        'read_file': ['path'],
        'open_file': ['path'],
        'read_lines': ['path', 'start_line', 'end_line'],
        'search_in_files': ['query'],
        'create_issue': ['title'],
        'update_issue': ['number'],
        'add_issue_comment': ['number', 'body'],
        'read_issue': ['number'],
        'scan_file': ['path'],
        'read_function': ['name', 'path'],
        'find_references': ['symbol']
    };

    const required = requiredParams[toolName];
    if (!required) return null; // Unknown tool, let it through

    const missing = required.filter(param => {
        const value = args[param];
        // Check for undefined, null, or empty string
        return value === undefined || value === null || value === '';
    });

    if (missing.length > 0) {
        return {
            error: `Tool call validation failed for ${toolName}: Missing required parameters: ${missing.join(', ')}. ` +
                   `This usually happens when the AI response was truncated. Please provide all required parameters.`,
            missingParams: missing,
            providedArgs: args
        };
    }

    return null; // Validation passed
}

/**
 * Execute a tool call using the registry
 */
export async function executeToolCall(toolCall) {
    try {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        
        // VALIDATE PARAMETERS BEFORE EXECUTION
        const validationError = validateToolParameters(toolCall.function.name, args);
        if (validationError) {
            console.error(`[Tool Validation] ${toolCall.function.name} failed:`, validationError);
            return validationError;
        }
        
        const result = await ToolRegistry.execute(toolCall.function.name, args);
        return result;
    } catch (error) {
        return { error: `Tool execution failed: ${error.message}` };
    }
}

/**
 * Parse tool calls embedded as text in LLM content.
 * 
 * IMPORTANT: This is a FALLBACK for APIs that don't return structured tool_calls
 * (e.g. Venice.ai + Kimi K2). Only called when result.toolCalls is empty.
 * Content MUST have think blocks stripped before calling this function.
 * 
 * Returns { toolCalls: [], cleanContent: string }
 */
export function parseTextToolCalls(text) {
    if (!text) return { toolCalls: [], cleanContent: text };

    const toolCalls = [];
    let cleanContent = text;
    let match;

    // Kimi K2: <|tool_calls_section_begin|>...<|tool_calls_section_end|>
    const kimiSectionPattern = /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/gi;
    while ((match = kimiSectionPattern.exec(text)) !== null) {
        const sectionBlock = match[1];
        const kimiCallPattern = /<\|tool_call_begin\|>\s*(?:functions\.)?(\S+?)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/gi;
        let kimiMatch;
        while ((kimiMatch = kimiCallPattern.exec(sectionBlock)) !== null) {
            const fnName = kimiMatch[1].trim();
            const argsStr = kimiMatch[2].trim();
            let args = {};
            try { args = JSON.parse(argsStr); } catch (e) { args = { _raw: argsStr }; }
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: { name: fnName, arguments: JSON.stringify(args) }
            });
        }
        cleanContent = cleanContent.replace(match[0], '');
    }

    // JSON in tags: <tool_call>{"name":"fn","arguments":{...}}</tool_call> or <function_call>
    const jsonToolPattern = /<(?:tool_call|function_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tool_call|function_call)>/gi;
    while ((match = jsonToolPattern.exec(text)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: {
                    name: parsed.name || parsed.function?.name || '',
                    arguments: typeof parsed.arguments === 'string'
                        ? parsed.arguments
                        : JSON.stringify(parsed.arguments || parsed.parameters || {})
                }
            });
            cleanContent = cleanContent.replace(match[0], '');
        } catch (e) { /* invalid JSON, skip */ }
    }

    // MiniMax XML: <minimax:tool_call><invoke name="fn"><parameter name="k">v</parameter></invoke></minimax:tool_call>
    const minimaxPattern = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/gi;
    while ((match = minimaxPattern.exec(text)) !== null) {
        const invokeBlock = match[1];
        const invokePattern = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/gi;
        let invokeMatch;
        while ((invokeMatch = invokePattern.exec(invokeBlock)) !== null) {
            const args = {};
            const paramPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/gi;
            let paramMatch;
            while ((paramMatch = paramPattern.exec(invokeMatch[2])) !== null) {
                args[paramMatch[1]] = paramMatch[2].trim();
            }
            toolCalls.push({
                id: `text_call_${toolCalls.length}`,
                type: 'function',
                function: { name: invokeMatch[1], arguments: JSON.stringify(args) }
            });
        }
        cleanContent = cleanContent.replace(match[0], '');
    }

    // Generic XML: <tool_call><name>fn</name><arguments>{...}</arguments></tool_call>
    const genericPattern = /<tool_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/gi;
    while ((match = genericPattern.exec(text)) !== null) {
        toolCalls.push({
            id: `text_call_${toolCalls.length}`,
            type: 'function',
            function: { name: match[1].trim(), arguments: match[2].trim() }
        });
        cleanContent = cleanContent.replace(match[0], '');
    }

    return { toolCalls, cleanContent: cleanContent.trim() };
}
