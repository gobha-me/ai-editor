/**
 * Tests for tool parameter validation and text-format tool call parsing.
 * Covers validateToolParameters and parseTextToolCalls from chat/tools.js.
 */
import { validateToolParameters, parseTextToolCalls } from '../js/chat/tools.js';

const { T } = window;

// ============================================
// validateToolParameters — Valid Calls
// ============================================

T.suite('validateToolParameters — Valid');

T.eq(
    validateToolParameters('read_file', { path: 'src/app.js' }),
    null,
    'read_file with path → passes'
);
T.eq(
    validateToolParameters('create_file', { path: 'new.js', content: 'code' }),
    null,
    'create_file with all required params → passes'
);
T.eq(
    validateToolParameters('search_in_files', { query: 'TODO', extra: 'ignored' }),
    null,
    'Extra params are fine'
);
T.eq(
    validateToolParameters('unknown_tool', { anything: true }),
    null,
    'Unknown tool name → null (pass through)'
);

// ============================================
// validateToolParameters — Missing Params
// ============================================

T.suite('validateToolParameters — Missing Params');

const missingPath = validateToolParameters('read_file', {});
T.assert(missingPath !== null, 'read_file without path → error');
T.assert(missingPath.missingParams.includes('path'), 'Error identifies missing "path"');
T.assert(missingPath.error.includes('read_file'), 'Error message includes tool name');

const missingContent = validateToolParameters('create_file', { path: 'file.js' });
T.assert(missingContent !== null, 'create_file missing content → error');
T.deepEq(missingContent.missingParams, ['content'], 'Only content is required after path');

// Empty string counts as missing
const emptyParam = validateToolParameters('read_file', { path: '' });
T.assert(emptyParam !== null, 'Empty string path → error');

// null counts as missing
const nullParam = validateToolParameters('read_file', { path: null });
T.assert(nullParam !== null, 'null path → error');

// 0 is a valid value (e.g., start_line: 0)
const zeroParam = validateToolParameters('read_lines', { path: 'file.js', start_line: 0, end_line: 10 });
T.eq(zeroParam, null, 'Zero is a valid parameter value');

// ============================================
// parseTextToolCalls — JSON in Tags
// ============================================

T.suite('parseTextToolCalls — JSON Tags');

const jsonTag = parseTextToolCalls(
    'Some text <tool_call>{"name":"read_file","arguments":{"path":"app.js"}}</tool_call> more text'
);
T.eq(jsonTag.toolCalls.length, 1, 'One tool call parsed');
T.eq(jsonTag.toolCalls[0].function.name, 'read_file', 'Tool name extracted');
T.eq(jsonTag.cleanContent, 'Some text  more text', 'Tool call tag removed from content');

// function_call variant
const fnTag = parseTextToolCalls(
    '<function_call>{"name":"search_in_files","arguments":{"query":"TODO"}}</function_call>'
);
T.eq(fnTag.toolCalls.length, 1, 'function_call tag parsed');
T.eq(fnTag.toolCalls[0].function.name, 'search_in_files', 'Name from function_call tag');

// Multiple tool calls
const multi = parseTextToolCalls(
    '<tool_call>{"name":"read_file","arguments":{"path":"a.js"}}</tool_call>' +
    'between' +
    '<tool_call>{"name":"read_file","arguments":{"path":"b.js"}}</tool_call>'
);
T.eq(multi.toolCalls.length, 2, 'Two tool calls parsed');
T.eq(multi.cleanContent, 'between', 'Content between calls preserved');

// ============================================
// parseTextToolCalls — Edge Cases
// ============================================

T.suite('parseTextToolCalls — Edge Cases');

const empty = parseTextToolCalls('');
T.eq(empty.toolCalls.length, 0, 'Empty string → no tool calls');
T.eq(empty.cleanContent, '', 'Empty content preserved');

const noTools = parseTextToolCalls('Just regular text with no tags');
T.eq(noTools.toolCalls.length, 0, 'No tags → no tool calls');
T.eq(noTools.cleanContent, 'Just regular text with no tags', 'Content unchanged');

const nullInput = parseTextToolCalls(null);
T.eq(nullInput.toolCalls.length, 0, 'null → no tool calls');

const invalidJson = parseTextToolCalls('<tool_call>{not valid json}</tool_call>rest');
T.eq(invalidJson.toolCalls.length, 0, 'Invalid JSON → no tool calls (graceful)');
T.assert(invalidJson.cleanContent.includes('rest'), 'Content after invalid tag preserved');

// ============================================
// parseTextToolCalls — Argument Formats
// ============================================

T.suite('parseTextToolCalls — Argument Formats');

// Arguments as string
const strArgs = parseTextToolCalls(
    '<tool_call>{"name":"test","arguments":"{\\"key\\": \\"val\\"}"}</tool_call>'
);
T.eq(strArgs.toolCalls.length, 1, 'String arguments parsed');
T.eq(typeof strArgs.toolCalls[0].function.arguments, 'string', 'String arguments stay as string');

// Arguments as object → gets JSON.stringified
const objArgs = parseTextToolCalls(
    '<tool_call>{"name":"test","arguments":{"key":"val"}}</tool_call>'
);
T.eq(objArgs.toolCalls.length, 1, 'Object arguments parsed');
T.eq(typeof objArgs.toolCalls[0].function.arguments, 'string', 'Object arguments stringified');
const parsed = JSON.parse(objArgs.toolCalls[0].function.arguments);
T.eq(parsed.key, 'val', 'Stringified arguments roundtrip');

// "parameters" field (some models use this instead of "arguments")
const paramArgs = parseTextToolCalls(
    '<tool_call>{"name":"test","parameters":{"key":"val"}}</tool_call>'
);
T.eq(paramArgs.toolCalls.length, 1, 'Parameters field accepted');
const parsedParams = JSON.parse(paramArgs.toolCalls[0].function.arguments);
T.eq(parsedParams.key, 'val', 'Parameters → arguments roundtrip');
