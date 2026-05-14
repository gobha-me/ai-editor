/**
 * Tool-loop core extraction parity (github#24 Phase 0, 2.48.0).
 *
 * The chat-side `handleGeneralRequest` loop body was extracted into
 * `js/chat/tool-loop-core.js#runToolLoop` so Phase 1 sub-agents can reuse
 * the same loop with a different context + hooks bag. This test pins:
 *
 *   1. The extracted helpers `summarizeToolResult` / `summarizeArgs` —
 *      identical behavior to the pre-2.48.0 `_summarizeToolResult` /
 *      `_summarizeArgs` (these were copied verbatim, but if they ever
 *      drift between handlers and core, the persistent action-log
 *      summary shape changes and the cross-request dedupe regresses).
 *
 *   2. The `runToolLoop` return shape across the load-bearing exit paths
 *      the loop can take WITHOUT calling `executeToolCall`:
 *        - text-only LLM response → natural-stop break, finalContent set
 *        - cancellation signal before round 0 → cancelled break reason
 *        - empty response with no tool actions → fallback content synthesis
 *
 * Tool-execution paths (multi-round, duplicate detection, ledger record,
 * cache invalidation) are exercised in the browser via the manual chat
 * session battery in CHANGELOG `### Verification`. Mocking the registry
 * + tool result shapes under Node would re-implement half of `js/tools/`;
 * the cost-to-coverage isn't there for Phase 0. Phase 1 (`delegate_task`)
 * will add a sub-agent integration test that covers the same paths from
 * the other side.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop, summarizeToolResult, summarizeArgs } from '../js/chat/tool-loop-core.js';

// ============================================
// summarizeToolResult — branches
// ============================================

test('summarizeToolResult: null result returns sentinel', () => {
    assert.equal(summarizeToolResult('read_file', null), 'no result');
    assert.equal(summarizeToolResult('read_file', undefined), 'no result');
});

test('summarizeToolResult: error branch prefixes "Error:"', () => {
    assert.equal(summarizeToolResult('edit_file', { error: 'file not found' }), 'Error: file not found');
});

test('summarizeToolResult: message branch returns message verbatim', () => {
    assert.equal(summarizeToolResult('commit_files', { message: 'committed 3 files' }), 'committed 3 files');
});

test('summarizeToolResult: status branch prefixes "Status:"', () => {
    assert.equal(summarizeToolResult('submit_plan_for_approval', { status: 'approved' }), 'Status: approved');
});

test('summarizeToolResult: string content truncated at 200 chars', () => {
    const long = 'x'.repeat(250);
    const out = summarizeToolResult('read_file', { content: long });
    assert.equal(out.length, 201);
    assert.ok(out.endsWith('…'));
});

test('summarizeToolResult: short string content returned as-is', () => {
    assert.equal(summarizeToolResult('read_file', { content: 'short' }), 'short');
});

test('summarizeToolResult: non-string content stringified + truncated', () => {
    const out = summarizeToolResult('scan_file', { content: { foo: 'x'.repeat(250) } });
    assert.ok(out.length <= 200);
});

test('summarizeToolResult: files array reports count', () => {
    assert.equal(summarizeToolResult('list_files', { files: [1, 2, 3] }), '3 file(s)');
});

test('summarizeToolResult: matches array reports count', () => {
    assert.equal(summarizeToolResult('search_in_files', { matches: [{}, {}] }), '2 match(es)');
});

test('summarizeToolResult: fallback JSON-stringifies and truncates', () => {
    const out = summarizeToolResult('unknown_tool', { foo: 'bar', baz: 'qux' });
    assert.ok(out.includes('foo'));
    assert.ok(out.length <= 201);
});

// ============================================
// summarizeArgs — branches
// ============================================

test('summarizeArgs: null/undefined returns empty object', () => {
    assert.deepEqual(summarizeArgs(null), {});
    assert.deepEqual(summarizeArgs(undefined), {});
});

test('summarizeArgs: passthrough for short args', () => {
    assert.deepEqual(summarizeArgs({ path: 'a.js', start_line: 1 }), { path: 'a.js', start_line: 1 });
});

test('summarizeArgs: truncates long content field at 100 chars', () => {
    const out = summarizeArgs({ path: 'a.js', content: 'y'.repeat(150) });
    assert.equal(out.path, 'a.js');
    assert.equal(out.content.length, 101);
    assert.ok(out.content.endsWith('…'));
});

test('summarizeArgs: truncates long body field at 100 chars', () => {
    const out = summarizeArgs({ body: 'z'.repeat(200) });
    assert.equal(out.body.length, 101);
});

test('summarizeArgs: truncates long text field at 100 chars', () => {
    const out = summarizeArgs({ text: 'w'.repeat(200) });
    assert.equal(out.text.length, 101);
});

test('summarizeArgs: short content/body/text passthrough', () => {
    const out = summarizeArgs({ content: 'short', body: 'b', text: 't' });
    assert.equal(out.content, 'short');
    assert.equal(out.body, 'b');
    assert.equal(out.text, 't');
});

// ============================================
// runToolLoop — exit paths reachable without `executeToolCall`
// ============================================

function makeContext(overrides = {}) {
    return {
        messages: [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'do thing' },
        ],
        historySnapshot: 0,
        roleTools: [],
        toolActionLog: [],
        settings: {
            toolTimeout: 30000,
            longRunningToolTimeout: 300000,
            userPauseTimeout: 86400000,
        },
        currentFilePath: null,
        profileNameForLedger: null,
        conversationId: null,
        cancelSignal: () => false,
        setHistoryLength: () => {},
        ...overrides,
    };
}

function recordingHooks() {
    const calls = [];
    const record = (name) => (...args) => {
        calls.push({ name, args });
        if (name === 'onUserInputDrain') return { drained: [], anyDrained: false };
        if (name === 'onRoundCommit') {
            const [{ content, hasNewText }] = args;
            return { lastRoundContent: hasNewText ? '' : content, textCommittedMidLoop: hasNewText };
        }
        return undefined;
    };
    const hooks = {
        onStreamStart: record('onStreamStart'),
        onStreamToken: record('onStreamToken'),
        onRoundCommit: record('onRoundCommit'),
        onStreamFinalize: record('onStreamFinalize'),
        onToolCall: record('onToolCall'),
        onConsentCard: record('onConsentCard'),
        onSystemMessage: record('onSystemMessage'),
        onAssistantTurn: record('onAssistantTurn'),
        onToolResultTurn: record('onToolResultTurn'),
        onUserInputDrain: record('onUserInputDrain'),
        onLedgerRecord: record('onLedgerRecord'),
        onDiscoveryAdmissions: record('onDiscoveryAdmissions'),
        onPlanModeApproved: record('onPlanModeApproved'),
        onChatComplete: record('onChatComplete'),
    };
    return { hooks, calls };
}

function chatThatReturns(...responses) {
    let i = 0;
    return async (_messages, options) => {
        const r = responses[i++];
        if (!r) throw new Error('no more stubbed responses');
        if (typeof r === 'function') return r(options);
        // If the response is shaped like a streaming text response, push
        // the content through onToken to match LLM.chat's contract.
        if (options && typeof options.onToken === 'function' && r.content) {
            options.onToken(r.content, r.content);
        }
        return r;
    };
}

test('runToolLoop: text-only response breaks naturally, returns finalContent', async () => {
    const ctx = makeContext();
    const { hooks, calls } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'The answer is 42.', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    const result = await runToolLoop(ctx, hooks, transport);

    assert.equal(result.breakReason, 'natural_stop');
    assert.equal(result.finalContent, 'The answer is 42.');
    assert.equal(result.lastRoundContent, 'The answer is 42.');
    assert.equal(result.textCommittedMidLoop, false);
    assert.equal(result.fallbackContent, null);
    assert.deepEqual(result.toolActions, []);

    // Hook trace: onStreamToken fires from the stubbed chat callback,
    // then onChatComplete fires once on success. No tool calls means no
    // onToolCall / onAssistantTurn / onRoundCommit. The loop breaks
    // before the per-round commit hook fires.
    const names = calls.map(c => c.name);
    assert.ok(names.includes('onStreamToken'));
    assert.ok(names.includes('onChatComplete'));
    assert.ok(!names.includes('onToolCall'));
    assert.ok(!names.includes('onRoundCommit'));
    assert.ok(!names.includes('onAssistantTurn'));
});

test('runToolLoop: cancellation before round 0 breaks with cancelled reason', async () => {
    const ctx = makeContext({ cancelSignal: () => true });
    const { hooks, calls } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'unreachable', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    const result = await runToolLoop(ctx, hooks, transport);

    assert.equal(result.breakReason, 'cancelled');
    assert.equal(result.finalContent, '*The model returned an empty response. Try rephrasing or switching models.*');
    assert.equal(result.fallbackContent, '*The model returned an empty response. Try rephrasing or switching models.*');

    // No chat call should have happened — cancellation short-circuits.
    const names = calls.map(c => c.name);
    assert.ok(!names.includes('onChatComplete'));
    assert.ok(!names.includes('onStreamToken'));
});

test('runToolLoop: empty response with no tool actions falls back to "empty response" sentinel', async () => {
    const ctx = makeContext();
    const { hooks } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: '', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    const result = await runToolLoop(ctx, hooks, transport);

    assert.equal(result.breakReason, 'natural_stop');
    assert.equal(result.fallbackContent, '*The model returned an empty response. Try rephrasing or switching models.*');
    assert.equal(result.finalContent, result.fallbackContent);
});

test('runToolLoop: transient error on round 0 retries once, then succeeds', async () => {
    const ctx = makeContext();
    const { hooks, calls } = recordingHooks();
    let attempt = 0;
    const transport = {
        chat: async (_messages, options) => {
            attempt++;
            if (attempt === 1) throw new Error('502 Bad Gateway: transient');
            if (options && typeof options.onToken === 'function') {
                options.onToken('recovered', 'recovered');
            }
            return { content: 'recovered', toolCalls: [], finishReason: 'stop' };
        },
        stop: () => {},
    };

    const result = await runToolLoop(ctx, hooks, transport);

    assert.equal(attempt, 2, 'transport.chat should be called twice (initial + retry)');
    assert.equal(result.breakReason, 'natural_stop');
    assert.equal(result.finalContent, 'recovered');

    // The retry path emits a "retrying…" placeholder via onStreamToken.
    const tokens = calls.filter(c => c.name === 'onStreamToken').map(c => c.args[0]);
    assert.ok(tokens.some(t => typeof t === 'string' && t.includes('retrying')));
});

test('runToolLoop: catastrophic error with no tool actions rethrows + calls setHistoryLength', async () => {
    let rolledBackTo = null;
    const ctx = makeContext({
        historySnapshot: 7,
        setHistoryLength: (n) => { rolledBackTo = n; },
    });
    const { hooks } = recordingHooks();
    const transport = {
        chat: async () => { throw new Error('unrecoverable network failure'); },
        stop: () => {},
    };

    await assert.rejects(
        () => runToolLoop(ctx, hooks, transport),
        /unrecoverable network failure/
    );
    assert.equal(rolledBackTo, 7, 'should call setHistoryLength with the snapshot');
});

test('runToolLoop: finishReason "length" adds guidance via onSystemMessage, resets streak, continues', async () => {
    const ctx = makeContext();
    const { hooks, calls } = recordingHooks();
    let chatCount = 0;
    const transport = {
        chat: async (_messages, options) => {
            chatCount++;
            if (chatCount === 1) {
                if (options.onToken) options.onToken('truncated...', 'truncated...');
                return { content: 'truncated...', toolCalls: [], finishReason: 'length' };
            }
            if (options.onToken) options.onToken('full reply', 'full reply');
            return { content: 'full reply', toolCalls: [], finishReason: 'stop' };
        },
        stop: () => {},
    };

    const result = await runToolLoop(ctx, hooks, transport);

    assert.equal(chatCount, 2, 'should call chat twice (truncated then full)');
    assert.equal(result.breakReason, 'natural_stop');
    assert.equal(result.finalContent, 'full reply');

    // onSystemMessage fires once with the truncation-recovery guidance.
    const sysCalls = calls.filter(c => c.name === 'onSystemMessage');
    assert.equal(sysCalls.length, 1);
    assert.ok(sysCalls[0].args[0].includes('truncated due to token limit'));
});
