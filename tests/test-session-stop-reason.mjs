/**
 * Session stop-reason surfacing — gitea#425, 2.50.0.4.
 *
 * Pins three behaviors so users (and AAR authors) can tell a session
 * stopped because budget hit / model finished / provider erred / user
 * aborted, rather than inferring it from the absence of signal:
 *
 *   1. `runToolLoop` emits exactly one `[Session] Stopped: reason=...`
 *      console.info line per loop completion, on every exit path.
 *
 *   2. `runToolLoop` fires the new `onLoopComplete` hook once, with the
 *      structured outcome (breakReason, finishReason, error, rounds,
 *      toolActions). Sub-agents leave the hook unset; the wrapper in
 *      `handlers.js` wires it to `LLMDebug.tagLoopOutcome`.
 *
 *   3. `LLMDebug.tagLoopOutcome` mutates the last exchange's `result`
 *      with `loopBreakReason` / `loopRounds` / `loopToolActions`, and
 *      `LLMDebug.exportText` includes a `Loop:` line surfacing them so
 *      the debug-modal export carries the reason.
 *
 * Runs under `node --test`. The browser-side stopGeneration() change
 * (the `*Stopped by you.*` placeholder in input.js:416) is verified
 * manually per the dual-track testing convention.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop } from '../js/chat/tool-loop-core.js';
import { LLMDebug } from '../js/llm/debug.js';

// ============================================
// Test helpers (mirrored from test-tool-loop-core.mjs)
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
    return {
        hooks: {
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
            onLoopComplete: record('onLoopComplete'),
        },
        calls,
    };
}

function chatThatReturns(...responses) {
    let i = 0;
    return async (_messages, options) => {
        const r = responses[i++];
        if (!r) throw new Error('no more stubbed responses');
        if (typeof r === 'function') return r(options);
        if (options && typeof options.onToken === 'function' && r.content) {
            options.onToken(r.content, r.content);
        }
        return r;
    };
}

/** Capture console.info calls during `fn()`; restore after. */
async function captureInfo(fn) {
    const captured = [];
    const orig = console.info;
    console.info = (...args) => { captured.push(args.join(' ')); };
    try {
        await fn();
    } finally {
        console.info = orig;
    }
    return captured;
}

// ============================================
// 1. [Session] Stopped log line — emitted on every exit path
// ============================================

test('runToolLoop: emits [Session] Stopped on natural_stop with finish_reason', async () => {
    const ctx = makeContext();
    const { hooks } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'done', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    const lines = await captureInfo(async () => {
        await runToolLoop(ctx, hooks, transport);
    });

    const stopLines = lines.filter(l => l.startsWith('[Session] Stopped:'));
    assert.equal(stopLines.length, 1, 'exactly one [Session] Stopped line per loop');
    assert.match(stopLines[0], /reason=natural_stop/);
    assert.match(stopLines[0], /finish_reason=stop/, 'natural_stop carries provider finish_reason');
    assert.match(stopLines[0], /rounds=1/);
});

test('runToolLoop: emits [Session] Stopped on cancelled (no finish_reason)', async () => {
    const ctx = makeContext({ cancelSignal: () => true });
    const { hooks } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'unreachable', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    const lines = await captureInfo(async () => {
        await runToolLoop(ctx, hooks, transport);
    });

    const stopLines = lines.filter(l => l.startsWith('[Session] Stopped:'));
    assert.equal(stopLines.length, 1);
    assert.match(stopLines[0], /reason=cancelled/);
    // Cancellation short-circuits before any chat call — no provider finish.
    assert.ok(!/finish_reason=/.test(stopLines[0]));
    assert.match(stopLines[0], /rounds=0/);
});

test('runToolLoop: emits [Session] Stopped on transient_failure with error excerpt', async () => {
    // Transient failure with text content recovers via the `if (content)` branch.
    // We need a non-retriable failure on round 0 with no tool actions to land
    // in the transient_failure breakReason branch — the error message must NOT
    // match the transient regex (502/503/504/timeout/zero-length/etc.) AND
    // we need round-0 content captured before the throw.
    const ctx = makeContext();
    const { hooks } = recordingHooks();
    let calls = 0;
    const transport = {
        chat: async (_messages, options) => {
            calls++;
            if (options && typeof options.onToken === 'function') {
                options.onToken('partial output', 'partial output');
            }
            throw new Error('schema validation failed mid-stream');
        },
        stop: () => {},
    };

    const lines = await captureInfo(async () => {
        await runToolLoop(ctx, hooks, transport);
    });

    assert.equal(calls, 1);
    const stopLines = lines.filter(l => l.startsWith('[Session] Stopped:'));
    assert.equal(stopLines.length, 1);
    assert.match(stopLines[0], /reason=transient_failure/);
    assert.match(stopLines[0], /error=schema validation failed/);
});

// ============================================
// 2. onLoopComplete hook — fired once with structured outcome
// ============================================

test('runToolLoop: fires onLoopComplete exactly once on natural_stop', async () => {
    const ctx = makeContext();
    const { hooks, calls } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'done', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    await captureInfo(() => runToolLoop(ctx, hooks, transport));

    const loopCompleteCalls = calls.filter(c => c.name === 'onLoopComplete');
    assert.equal(loopCompleteCalls.length, 1, 'fires once per loop');

    const [outcome] = loopCompleteCalls[0].args;
    assert.equal(outcome.breakReason, 'natural_stop');
    assert.equal(outcome.finishReason, 'stop');
    assert.equal(outcome.error, null);
    assert.equal(outcome.rounds, 1);
    assert.equal(outcome.toolActions, 0);
});

test('runToolLoop: fires onLoopComplete on cancelled with rounds=0', async () => {
    const ctx = makeContext({ cancelSignal: () => true });
    const { hooks, calls } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'x', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    await captureInfo(() => runToolLoop(ctx, hooks, transport));

    const loopCompleteCalls = calls.filter(c => c.name === 'onLoopComplete');
    assert.equal(loopCompleteCalls.length, 1);

    const [outcome] = loopCompleteCalls[0].args;
    assert.equal(outcome.breakReason, 'cancelled');
    assert.equal(outcome.finishReason, null);
    assert.equal(outcome.rounds, 0);
});

test('runToolLoop: onLoopComplete fires AFTER the loop body, before the return', async () => {
    // Ensures the hook sees the final breakReason / outcome, not an intermediate
    // value. Fire-order: every onChatComplete must precede the single onLoopComplete.
    const ctx = makeContext();
    const { hooks, calls } = recordingHooks();
    const transport = {
        chat: chatThatReturns({ content: 'done', toolCalls: [], finishReason: 'stop' }),
        stop: () => {},
    };

    await captureInfo(() => runToolLoop(ctx, hooks, transport));

    const names = calls.map(c => c.name);
    const lastChatComplete = names.lastIndexOf('onChatComplete');
    const loopCompleteIdx = names.indexOf('onLoopComplete');
    assert.ok(loopCompleteIdx > lastChatComplete,
        'onLoopComplete must fire after the final onChatComplete');
});

// ============================================
// 3. LLMDebug.tagLoopOutcome — last exchange + exportText
// ============================================

test('LLMDebug.tagLoopOutcome: tags the most recent exchange with loop fields', () => {
    LLMDebug.exchanges = [];
    LLMDebug.startExchange({ model: 'qwen-3-6-plus', stream: true, messages: [], tools: [] });
    LLMDebug.endExchange({ content: 'hello', toolCalls: null, finishReason: 'stop', usage: { in: 10, out: 5 } });

    LLMDebug.tagLoopOutcome({
        breakReason: 'natural_stop',
        finishReason: 'stop',
        error: null,
        rounds: 1,
        toolActions: 0,
    });

    const last = LLMDebug.exchanges[LLMDebug.exchanges.length - 1];
    assert.equal(last.result.loopBreakReason, 'natural_stop');
    assert.equal(last.result.loopRounds, 1);
    assert.equal(last.result.loopToolActions, 0);
    assert.equal(last.result.finishReason, 'stop', 'pre-existing finishReason preserved');
});

test('LLMDebug.tagLoopOutcome: error gets stringified onto loopError', () => {
    LLMDebug.exchanges = [];
    LLMDebug.startExchange({ model: 'qwen-3-6-plus', stream: true, messages: [], tools: [] });
    LLMDebug.endExchange({ content: '', toolCalls: null, finishReason: null, usage: null });

    LLMDebug.tagLoopOutcome({
        breakReason: 'transient_failure',
        finishReason: null,
        error: '503 Service Unavailable',
        rounds: 1,
        toolActions: 0,
    });

    const last = LLMDebug.exchanges[LLMDebug.exchanges.length - 1];
    assert.equal(last.result.loopBreakReason, 'transient_failure');
    assert.equal(last.result.loopError, '503 Service Unavailable');
});

test('LLMDebug.tagLoopOutcome: no-op when there are no exchanges', () => {
    LLMDebug.exchanges = [];
    // Should not throw.
    LLMDebug.tagLoopOutcome({ breakReason: 'natural_stop', rounds: 1, toolActions: 0 });
    assert.equal(LLMDebug.exchanges.length, 0);
});

test('LLMDebug.tagLoopOutcome: null/undefined outcome is a no-op', () => {
    LLMDebug.exchanges = [];
    LLMDebug.startExchange({ model: 'qwen-3-6-plus', stream: true, messages: [], tools: [] });
    LLMDebug.endExchange({ content: 'x', toolCalls: null, finishReason: 'stop', usage: null });

    LLMDebug.tagLoopOutcome(null);
    LLMDebug.tagLoopOutcome(undefined);

    const last = LLMDebug.exchanges[LLMDebug.exchanges.length - 1];
    assert.equal(last.result.loopBreakReason, undefined, 'no fields added on null outcome');
});

test('LLMDebug.exportText: includes Loop: line when loopBreakReason is set', () => {
    LLMDebug.exchanges = [];
    LLMDebug.startExchange({ model: 'qwen-3-6-plus', stream: true, messages: [], tools: [] });
    LLMDebug.endExchange({ content: 'done', toolCalls: null, finishReason: 'stop', usage: { in: 10, out: 5 } });
    LLMDebug.tagLoopOutcome({
        breakReason: 'no_progress',
        finishReason: null,
        error: null,
        rounds: 5,
        toolActions: 3,
    });

    const text = LLMDebug.exportText();
    assert.match(text, /Loop: reason=no_progress/);
    assert.match(text, /rounds=5/);
    assert.match(text, /tool_actions=3/);
});

test('LLMDebug.exportText: omits Loop: line when no outcome was tagged', () => {
    LLMDebug.exchanges = [];
    LLMDebug.startExchange({ model: 'qwen-3-6-plus', stream: true, messages: [], tools: [] });
    LLMDebug.endExchange({ content: 'done', toolCalls: null, finishReason: 'stop', usage: null });

    const text = LLMDebug.exportText();
    assert.ok(!/^Loop:/m.test(text), 'no Loop: line when tagLoopOutcome was not called');
});
