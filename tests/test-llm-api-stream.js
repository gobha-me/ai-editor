/**
 * Tests for the SSE tool-call-delta accumulation in js/llm/api.js
 * (1.6.3 PR 3 of 1.6.0 chat-stability — closes Hypothesis #2 latently).
 *
 * The production accumulator at js/llm/api.js:782-794 is internal to the
 * fetch+SSE loop and not exported. We mirror the inner per-chunk body here
 * so we can drive it with synthesized `delta.tool_calls` chunks. Keep this
 * helper byte-aligned with the production block — if api.js diverges, the
 * suite name in the changelog tells you where to look.
 */

const { T } = window;

T.suite('function.name overwrite-if-empty (1.6.3 PR 3)');

// Mirrors js/llm/api.js:782-794 — the inner `for (const tc of delta.tool_calls)`.
// Mutates `toolCalls` in place; returns it for fluent assertion.
function applyDelta(toolCalls, delta) {
    if (!delta.tool_calls) return toolCalls;
    for (const tc of delta.tool_calls) {
        if (tc.index !== undefined) {
            if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[tc.index].id = tc.id;
            if (tc.function?.name && !toolCalls[tc.index].function.name) toolCalls[tc.index].function.name = tc.function.name;
            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
        }
    }
    return toolCalls;
}

// ============================================
// Case 1: single chunk with full name
// ============================================
{
    const tc = [];
    applyDelta(tc, { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_file', arguments: '{}' } }] });
    T.eq(tc[0].id, 't1', 'single-chunk: id');
    T.eq(tc[0].function.name, 'read_file', 'single-chunk: name set verbatim');
    T.eq(tc[0].function.arguments, '{}', 'single-chunk: arguments set');
}

// ============================================
// Case 2: two chunks with repeated name for same index — THE BUG FIXTURE
// Pre-fix this would yield 'read_fileread_file'.
// ============================================
{
    const tc = [];
    applyDelta(tc, { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_file' } }] });
    applyDelta(tc, { tool_calls: [{ index: 0, function: { name: 'read_file' } }] });
    T.eq(tc[0].function.name, 'read_file', 'repeated name: stays single, not concatenated');
}

// ============================================
// Case 3: name on first chunk, args streamed across later chunks
// Proves the args `+=` was NOT regressed.
// ============================================
{
    const tc = [];
    applyDelta(tc, { tool_calls: [{ index: 0, id: 't1', function: { name: 'read_lines', arguments: '{"p' } }] });
    applyDelta(tc, { tool_calls: [{ index: 0, function: { arguments: 'ath": "/x/y' } }] });
    applyDelta(tc, { tool_calls: [{ index: 0, function: { arguments: '.js"}' } }] });
    T.eq(tc[0].function.name, 'read_lines', 'streamed args: name unchanged');
    T.eq(tc[0].function.arguments, '{"path": "/x/y.js"}', 'streamed args: concatenated correctly');
}

// ============================================
// Case 4: parallel tool calls — repeated name on index=0 doesn't bleed to index=1
// ============================================
{
    const tc = [];
    applyDelta(tc, { tool_calls: [
        { index: 0, id: 't1', function: { name: 'read_file', arguments: '{"p":"a"}' } },
        { index: 1, id: 't2', function: { name: 'list_files', arguments: '{}' } }
    ] });
    applyDelta(tc, { tool_calls: [{ index: 0, function: { name: 'read_file' } }] });
    T.eq(tc[0].function.name, 'read_file', 'parallel: index=0 name still single');
    T.eq(tc[1].function.name, 'list_files', 'parallel: index=1 name unaffected');
    T.eq(tc[0].id, 't1', 'parallel: index=0 id');
    T.eq(tc[1].id, 't2', 'parallel: index=1 id');
}

// ============================================
// Case 5: empty/missing function field on a chunk → no-op, no throw
// ============================================
{
    const tc = [];
    applyDelta(tc, { tool_calls: [{ index: 0, id: 't1', function: { name: 'foo' } }] });
    let threw = false;
    try {
        applyDelta(tc, { tool_calls: [{ index: 0 }] });               // no function field
        applyDelta(tc, { tool_calls: [{ index: 0, function: {} }] }); // empty function
    } catch (e) {
        threw = true;
    }
    T.assert(!threw, 'missing function field: no throw');
    T.eq(tc[0].function.name, 'foo', 'missing function field: name unchanged');
}
