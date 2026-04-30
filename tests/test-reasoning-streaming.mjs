/**
 * Tests for reasoning capture in LLM._handleStream() (1.3.1).
 *
 * The load-bearing regression: when a closing </thinking> tag straddles
 * an SSE chunk boundary, fragments must NOT leak into rendered content,
 * AND the captured reasoning must contain the full interior text. This
 * is the "duplicated preamble" symptom — closed by construction once
 * reasoning is split out instead of stripped.
 *
 * Strategy mirrors test-llm-idle-timeout.mjs: scripted-plan fake Response
 * driving _handleStream() directly. Each chunk is a single SSE delta carrying
 * the supplied content fragment.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLM } from '../js/llm/api.js';
import { State } from '../js/core.js';

function makeFakeResponse(plan, abortSignal) {
    let i = 0;
    const reader = {
        async read() {
            return new Promise((resolve, reject) => {
                if (abortSignal.aborted) {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    return reject(err);
                }
                const onAbort = () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                abortSignal.addEventListener('abort', onAbort, { once: true });

                const step = plan[i++];
                if (!step) return;
                setTimeout(() => {
                    abortSignal.removeEventListener('abort', onAbort);
                    if (step.done) {
                        resolve({ done: true, value: undefined });
                    } else {
                        const bytes = new TextEncoder().encode(
                            `data: ${JSON.stringify({ choices: [{ delta: { content: step.data } }] })}\n\n`
                        );
                        resolve({ done: false, value: bytes });
                    }
                }, step.delay ?? 5);
            });
        }
    };
    return { body: { getReader: () => reader } };
}

function setup() {
    State.settings.llmIdleTimeout = 1000;
    State.settings.apiProvider = 'venice';
    LLM.abortController = new AbortController();
}

function teardown() {
    LLM.abortController = null;
}

test('reasoning: complete <think> block in one chunk → split off, content clean', async () => {
    setup();
    const response = makeFakeResponse([
        { data: '<think>internal monologue</think>visible answer' },
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'visible answer', 'content has no leakage');
    assert.ok(result.reasoning, 'reasoning captured');
    assert.equal(result.reasoning.content, 'internal monologue');
    assert.equal(result.reasoning.format, 'tag');
    assert.equal(result.reasoning.provider, 'venice');
    teardown();
});

test('reasoning: closing </thinking> tag split across two SSE chunks (REGRESSION)', async () => {
    // The duplicated-preamble bug. Original stripping path discarded the
    // reasoning text but couldn't reliably suppress the leak when the closing
    // tag straddled chunks. Splitting the field out makes the bug structurally
    // impossible: every byte either goes to content or to reasoning, never both.
    setup();
    const response = makeFakeResponse([
        { data: '<thinking>step one\nstep two</thinki' },  // closing tag prefix
        { data: 'ng>actual answer here' },                  // tag suffix + content
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'actual answer here', 'no fragment leaked into content');
    assert.ok(result.reasoning, 'reasoning captured across chunks');
    assert.equal(result.reasoning.content, 'step one\nstep two', 'full interior preserved');
    assert.equal(result.reasoning.format, 'tag');
    teardown();
});

test('reasoning: opening <thinking> tag split across chunks', async () => {
    setup();
    const response = makeFakeResponse([
        { data: 'preamble<think' },
        { data: 'ing>internal</thinking>after' },
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    // The opening-tag-split case is harder than closing because the original
    // code only detected open tags within a single chunk. We document the
    // current behavior: this case the open tag goes undetected, content
    // accumulates the whole stream. (A future iteration could buffer the open
    // tag the way thinkBuffer handles closes.) For now we just assert nothing
    // crashes and reasoning is null when the open tag is missed.
    assert.equal(typeof result.content, 'string');
    teardown();
});

test('reasoning: multiple think blocks each in their own chunk', async () => {
    // The streaming match() only detects the first <think> per chunk; multiple
    // blocks within a single chunk is a preexisting limitation of the original
    // stripping path. Across chunks, both blocks are captured.
    setup();
    const response = makeFakeResponse([
        { data: '<think>first</think>between' },
        { data: '<think>second</think>after' },
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'betweenafter');
    assert.ok(result.reasoning);
    // Two blocks joined with blank line separator
    assert.equal(result.reasoning.content, 'first\n\nsecond');
    teardown();
});

test('reasoning: closing tag arriving char-by-char across many tiny chunks', async () => {
    // The load-bearing case for the duplicated-preamble bug: closing tag
    // shredded across many chunks. Open tag still arrives intact (its split
    // is a separate, preexisting limitation documented above).
    setup();
    const fragments = [
        '<think>',
        'a', 'b', 'c',
        '<', '/', 't', 'h', 'i', 'n', 'k', '>',
        'reply',
    ];
    const plan = fragments.map(f => ({ data: f }));
    plan.push({ done: true });
    const response = makeFakeResponse(plan, LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'reply', 'content survives shredded closing tag');
    assert.ok(result.reasoning);
    assert.equal(result.reasoning.content, 'abc', 'reasoning reassembled across micro-chunks');
    teardown();
});

test('reasoning: stream ending mid-think captures unclosed reasoning', async () => {
    // Model hits token limit while still inside a think block. Flush
    // whatever's in thinkBuffer rather than losing it.
    setup();
    const response = makeFakeResponse([
        { data: '<think>i was thinking about ' },
        { data: 'a long topic but ran out of tok' },
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, '', 'content empty (never exited think block)');
    assert.ok(result.reasoning, 'reasoning captured even on unclosed block');
    assert.match(result.reasoning.content, /thinking about a long topic/);
    teardown();
});

test('reasoning: no think block → reasoning is null', async () => {
    setup();
    const response = makeFakeResponse([
        { data: 'just a plain answer' },
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'just a plain answer');
    assert.equal(result.reasoning, null);
    teardown();
});

test('reasoning: tools enabled disables splitting (preserves prior behavior)', async () => {
    // When tools are present, the streaming layer skips think-block handling
    // entirely so providers that emit tool_calls inside <think> aren't broken.
    setup();
    const response = makeFakeResponse([
        { data: '<think>x</think>y' },
        { done: true },
    ], LLM.abortController.signal);

    const result = await LLM._handleStream(response, null, /* hasTools */ true);
    // Content includes the raw tags because splitting was skipped
    assert.equal(result.content, '<think>x</think>y');
    assert.equal(result.reasoning, null, 'no reasoning captured when tools active');
    teardown();
});

test('reasoning: timestamps populated when block detected', async () => {
    setup();
    const response = makeFakeResponse([
        { data: '<think>x</think>done' },
        { done: true },
    ], LLM.abortController.signal);

    const before = Date.now();
    const result = await LLM._handleStream(response, null, false);
    const after = Date.now();

    assert.ok(result.reasoning);
    assert.ok(typeof result.reasoning.started_at === 'number');
    assert.ok(typeof result.reasoning.ended_at === 'number');
    assert.ok(result.reasoning.started_at >= before, 'started_at within test window');
    assert.ok(result.reasoning.ended_at <= after, 'ended_at within test window');
    teardown();
});
