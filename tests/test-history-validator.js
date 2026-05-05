/**
 * Tests for the request-shape validator (1.6.2 PR 2 of 1.6.0 chat-stability).
 * Asserts the no-orphan-tool invariant at the LLM boundary.
 */
import { validateAndCleanHistory } from '../js/chat/history-validator.js';

const { T } = window;

T.suite('Request-shape validator (1.6.2 PR 2)');

// Silence the warn output during the suite to keep the console clean.
// Each test that expects a warn captures it via a counter wrapper instead.
const _origWarn = console.warn;
let _warnCount = 0;
let _lastWarn = '';
function captureWarns() {
    _warnCount = 0;
    _lastWarn = '';
    console.warn = (...args) => {
        _warnCount++;
        _lastWarn = args.join(' ');
    };
}
function restoreWarns() {
    console.warn = _origWarn;
}

// ============================================
// Case 1: clean history with no tool messages
// ============================================
{
    captureWarns();
    const input = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 0, 'clean history: droppedCount=0');
    T.assert(out.messages === input, 'clean history: returns same array reference (no copy)');
    T.eq(_warnCount, 0, 'clean history: no warn');
    restoreWarns();
}

// ============================================
// Case 2: matched assistant(tool_calls) + tool
// ============================================
{
    captureWarns();
    const input = [
        { role: 'user', content: 'read file' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 0, 'matched pair: droppedCount=0');
    T.assert(out.messages === input, 'matched pair: returns same reference');
    T.eq(_warnCount, 0, 'matched pair: no warn');
    restoreWarns();
}

// ============================================
// Case 3: orphan tool at start (no preceding assistant)
// ============================================
{
    captureWarns();
    const input = [
        { role: 'tool', tool_call_id: 't0', content: 'orphan' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 1, 'orphan-at-start: droppedCount=1');
    T.deepEq(out.droppedIds, ['t0'], 'orphan-at-start: droppedIds');
    T.eq(out.messages.length, 2, 'orphan-at-start: remainder length');
    T.eq(out.messages[0].role, 'user', 'orphan-at-start: starts on user after drop');
    T.eq(_warnCount, 1, 'orphan-at-start: one warn emitted');
    restoreWarns();
}

// ============================================
// Case 4: tool with stale tool_call_id (no matching preceding assistant id)
// ============================================
{
    captureWarns();
    const input = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'STALE', content: 'oops' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 1, 'stale id: droppedCount=1');
    T.deepEq(out.droppedIds, ['STALE'], 'stale id: droppedIds');
    T.eq(out.messages.length, 2, 'stale id: tool dropped');
    T.eq(_warnCount, 1, 'stale id: warn emitted');
    restoreWarns();
}

// ============================================
// Case 5: 3 tools after assistant(tool_calls=[t1,t2]) — third is stale
// ============================================
{
    captureWarns();
    const input = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [
            { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { id: 't2', type: 'function', function: { name: 'read_file', arguments: '{}' } }
        ] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' },
        { role: 'tool', tool_call_id: 't2', content: 'r2' },
        { role: 'tool', tool_call_id: 't99', content: 'orphan' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 1, 'mixed: droppedCount=1 (only the stale one)');
    T.deepEq(out.droppedIds, ['t99'], 'mixed: only t99 dropped');
    T.eq(out.messages.length, 4, 'mixed: kept the two matched tools');
    T.eq(_warnCount, 1, 'mixed: one warn');
    restoreWarns();
}

// ============================================
// Case 6: multi-turn — second tool(t1) is orphan after asst2 closes the prior set
// ============================================
{
    captureWarns();
    const input = [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'r1' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'echo from prior turn' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 1, 'multi-turn: droppedCount=1');
    T.deepEq(out.droppedIds, ['t1'], 'multi-turn: prior-turn t1 is orphan after asst2');
    T.eq(out.messages.length, 4, 'multi-turn: kept everything except trailing orphan');
    T.eq(out.messages[out.messages.length - 1].role, 'assistant', 'multi-turn: ends on asst2 (its t2 reply was missing too — but only orphan _tool_ messages are dropped, not unanswered tool_calls)');
    restoreWarns();
}

// ============================================
// Case 7: tool message with missing tool_call_id field
// ============================================
{
    captureWarns();
    const input = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', content: 'no id' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 1, 'missing id: droppedCount=1');
    T.deepEq(out.droppedIds, ['<missing>'], 'missing id: droppedIds shows <missing>');
    T.eq(out.messages.length, 2, 'missing id: tool dropped');
    restoreWarns();
}

// ============================================
// Case 8: empty tool_calls: [] — no ids registered, subsequent tool is orphan
// ============================================
{
    captureWarns();
    const input = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'noop', tool_calls: [] },
        { role: 'tool', tool_call_id: 't1', content: 'orphan' }
    ];
    const out = validateAndCleanHistory(input);
    T.eq(out.droppedCount, 1, 'empty tool_calls: subsequent tool is orphan');
    T.deepEq(out.droppedIds, ['t1'], 'empty tool_calls: t1 dropped');
    T.eq(out.messages.length, 2, 'empty tool_calls: tool dropped');
    restoreWarns();
}

// ============================================
// Case 9: degenerate inputs — empty array and non-array
// ============================================
{
    captureWarns();
    const empty = validateAndCleanHistory([]);
    T.eq(empty.droppedCount, 0, 'empty: droppedCount=0');
    T.eq(empty.messages.length, 0, 'empty: empty array returned');

    const notArray = validateAndCleanHistory(null);
    T.eq(notArray.droppedCount, 0, 'null: droppedCount=0');
    T.eq(notArray.messages, null, 'null: passed through');
    T.eq(_warnCount, 0, 'degenerate: no warn');
    restoreWarns();
}
