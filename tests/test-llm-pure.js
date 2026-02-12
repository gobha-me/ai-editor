/**
 * Tests for LLM pure functions — stripThinkBlocks, sanitizeMessages, getLanguageFromPath.
 * These are critical for message integrity and API compatibility.
 */
import { stripThinkBlocks, sanitizeMessages, getLanguageFromPath } from '../js/llm.js';

const { T } = window;

// ============================================
// stripThinkBlocks
// ============================================

T.suite('stripThinkBlocks — Basic');

T.eq(stripThinkBlocks('hello world'), 'hello world', 'Plain text unchanged');
T.eq(stripThinkBlocks('<think>reasoning</think>answer'), 'answer', 'Single think block stripped');
T.eq(stripThinkBlocks('<think>a</think>mid<think>b</think>end'), 'midend', 'Multiple think blocks stripped');
T.eq(stripThinkBlocks('<THINK>case</THINK>result'), 'result', 'Case-insensitive matching');

T.suite('stripThinkBlocks — Edge Cases');

T.eq(stripThinkBlocks('<think>unclosed content'), '', 'Unclosed think block stripped (model cut off)');
T.eq(stripThinkBlocks('prefix<think>middle'), 'prefix', 'Unclosed think block preserves prefix');
T.eq(stripThinkBlocks(null), null, 'null input returns null');
T.eq(stripThinkBlocks(''), '', 'Empty string returns empty');
T.eq(stripThinkBlocks(undefined), undefined, 'undefined input returns undefined');

T.suite('stripThinkBlocks — Whitespace');

T.eq(
    stripThinkBlocks('<think>\n  reasoning\n  more\n</think>\nanswer'),
    'answer',
    'Think block with newlines stripped'
);
T.eq(
    stripThinkBlocks('  <think>pad</think>  result  '),
    'result',
    'Result is trimmed'
);

// ============================================
// sanitizeMessages
// ============================================

T.suite('sanitizeMessages — Valid Messages');

const basic = sanitizeMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' }
]);
T.eq(basic.length, 2, 'Two valid messages pass through');
T.eq(basic[0].role, 'user', 'User role preserved');
T.eq(basic[0].content, 'hello', 'User content preserved');
T.eq(basic[1].role, 'assistant', 'Assistant role preserved');

T.suite('sanitizeMessages — Internal Field Stripping');

const withInternal = sanitizeMessages([
    { role: 'user', content: 'hi', timestamp: 123456, isSummary: true, customField: 'garbage' }
]);
T.eq(withInternal[0].content, 'hi', 'Content preserved');
T.eq(withInternal[0].timestamp, undefined, 'timestamp stripped');
T.eq(withInternal[0].isSummary, undefined, 'isSummary stripped');
T.eq(withInternal[0].customField, undefined, 'Custom field stripped');
T.eq(Object.keys(withInternal[0]).sort().join(','), 'content,role', 'Only role,content remain');

T.suite('sanitizeMessages — Invalid Roles');

// Suppress console.warn during this test
const origWarn = console.warn;
console.warn = () => {};

const withInvalid = sanitizeMessages([
    { role: 'user', content: 'keep' },
    { role: 'function', content: 'drop me' },
    { role: 'bogus', content: 'drop me too' },
    { role: 'assistant', content: 'keep' }
]);
T.eq(withInvalid.length, 2, 'Invalid roles filtered out');
T.eq(withInvalid[0].role, 'user', 'First valid message kept');
T.eq(withInvalid[1].role, 'assistant', 'Second valid message kept');

T.suite('sanitizeMessages — Empty Assistant Messages');

const withEmpty = sanitizeMessages([
    { role: 'assistant', content: '' },
    { role: 'assistant', content: null },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'assistant' }
]);
console.warn = origWarn;

// Empty string content is falsy → treated as "no content" → dropped
// null content + no tool_calls is dropped
// null content + tool_calls is KEPT (valid tool call message)
// No content at all + no tool_calls is dropped
T.eq(withEmpty.length, 1, 'Only assistant with tool_calls survives');
T.eq(withEmpty[0].content, null, 'Null content with tool_calls → content:null preserved');
T.assert(withEmpty[0].tool_calls.length === 1, 'Tool calls preserved');

T.suite('sanitizeMessages — Tool Messages');

const toolMsg = sanitizeMessages([
    { role: 'tool', content: '{"result": "ok"}', tool_call_id: 'tc_123' }
]);
T.eq(toolMsg[0].role, 'tool', 'Tool role preserved');
T.eq(toolMsg[0].content, '{"result": "ok"}', 'Tool content preserved');
T.eq(toolMsg[0].tool_call_id, 'tc_123', 'tool_call_id preserved');

T.suite('sanitizeMessages — Tool Call Filtering');

const sparseToolCalls = sanitizeMessages([
    {
        role: 'assistant',
        content: null,
        tool_calls: [
            null,
            { id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            undefined,
            { id: 'tc2', type: 'function', function: {} },  // Missing name
            { id: 'tc3', type: 'function', function: { name: 'write_file', arguments: '{}' } }
        ]
    }
]);
T.eq(sparseToolCalls[0].tool_calls.length, 2, 'Sparse gaps and nameless tool calls filtered');
T.eq(sparseToolCalls[0].tool_calls[0].function.name, 'read_file', 'First valid tool call kept');
T.eq(sparseToolCalls[0].tool_calls[1].function.name, 'write_file', 'Second valid tool call kept');

T.suite('sanitizeMessages — System & Name');

const withSystem = sanitizeMessages([
    { role: 'system', content: 'You are helpful', name: 'system_prompt' }
]);
T.eq(withSystem[0].role, 'system', 'System role preserved');
T.eq(withSystem[0].name, 'system_prompt', 'Name field preserved');

// ============================================
// getLanguageFromPath
// ============================================

T.suite('getLanguageFromPath — Common Extensions');

T.eq(getLanguageFromPath('app.js'), 'javascript', 'js → javascript');
T.eq(getLanguageFromPath('main.ts'), 'typescript', 'ts → typescript');
T.eq(getLanguageFromPath('script.py'), 'python', 'py → python');
T.eq(getLanguageFromPath('main.go'), 'go', 'go → go');
T.eq(getLanguageFromPath('lib.rs'), 'rust', 'rs → rust');
T.eq(getLanguageFromPath('style.css'), 'css', 'css → css');
T.eq(getLanguageFromPath('page.html'), 'html', 'html → html');
T.eq(getLanguageFromPath('data.json'), 'json', 'json → json');
T.eq(getLanguageFromPath('README.md'), 'markdown', 'md → markdown');
T.eq(getLanguageFromPath('config.yaml'), 'yaml', 'yaml → yaml');
T.eq(getLanguageFromPath('config.yml'), 'yaml', 'yml → yaml');
T.eq(getLanguageFromPath('query.sql'), 'sql', 'sql → sql');

T.suite('getLanguageFromPath — Edge Cases');

T.eq(getLanguageFromPath('src/deep/path/file.cpp'), 'cpp', 'Deep path extracts extension');
T.eq(getLanguageFromPath('header.h'), 'c', 'h → c');
T.eq(getLanguageFromPath('header.hpp'), 'cpp', 'hpp → cpp');
T.eq(getLanguageFromPath('deploy.sh'), 'bash', 'sh → bash');
T.eq(getLanguageFromPath('script.zsh'), 'bash', 'zsh → bash');
T.eq(getLanguageFromPath('file.unknownext'), 'unknownext', 'Unknown ext returns ext as-is');
