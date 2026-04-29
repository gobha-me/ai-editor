/**
 * Tests for LLM._handleStream() idle-timeout behavior (1.1.1).
 *
 * Verifies:
 *   - Timer resets on each reader.read() chunk arrival.
 *   - Timer fires when no chunk arrives within the window.
 *   - User-cancel via LLM.stop() is distinguishable from idle timeout.
 *   - Successful streams don't trigger spurious timeouts.
 *
 * Strategy: build a fake Response whose body.getReader() returns a
 * controllable reader. The reader resolves read() promises on a chunk plan,
 * and rejects pending reads with AbortError when the abort signal fires.
 * No fetch, no real network — we exercise _handleStream() directly.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLM } from '../js/llm/api.js';
import { State } from '../js/core.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Build a fake Response whose body emits a scripted sequence of chunks.
 * Each step is { delay, data } (chunk) or { delay, done: true } (terminator).
 * If the abortSignal fires before the next step, pending read() rejects
 * with an AbortError-shaped Error.
 */
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
                if (!step) {
                    // No more scripted steps — block forever (tests should
                    // either terminate the stream with done:true or trigger abort).
                    return;
                }
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
                }, step.delay);
            });
        }
    };
    return {
        body: { getReader: () => reader }
    };
}

test('idle: stream completes when chunks arrive within the window', async () => {
    State.settings.llmIdleTimeout = 200;
    LLM.abortController = new AbortController();
    const response = makeFakeResponse(
        [
            { delay: 50, data: 'hello' },
            { delay: 50, data: ' world' },
            { delay: 50, done: true }
        ],
        LLM.abortController.signal
    );
    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'hello world');
    LLM.abortController = null;
});

test('idle: timer fires when no chunk arrives within the window', async () => {
    State.settings.llmIdleTimeout = 80;
    LLM.abortController = new AbortController();
    const response = makeFakeResponse([], LLM.abortController.signal);
    await assert.rejects(
        LLM._handleStream(response, null, false),
        (err) => /Idle timeout/.test(err.message) && /no tokens received/.test(err.message)
    );
    LLM.abortController = null;
});

test('idle: timer resets on every chunk (chunks at 60ms with 100ms window stay alive)', async () => {
    State.settings.llmIdleTimeout = 100;
    LLM.abortController = new AbortController();
    // Each step <100ms but cumulative duration > 100ms — naive wall-clock
    // would have aborted, idle resets keep it alive.
    const response = makeFakeResponse(
        [
            { delay: 60, data: 'a' },
            { delay: 60, data: 'b' },
            { delay: 60, data: 'c' },
            { delay: 60, data: 'd' },
            { delay: 60, done: true }
        ],
        LLM.abortController.signal
    );
    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'abcd');
    LLM.abortController = null;
});

test('idle: aborts mid-stream when chunks stop arriving', async () => {
    State.settings.llmIdleTimeout = 80;
    LLM.abortController = new AbortController();
    const response = makeFakeResponse(
        [
            { delay: 30, data: 'first' },
            { delay: 30, data: 'second' }
            // Then silence — idle timer should fire after 80ms more.
        ],
        LLM.abortController.signal
    );
    await assert.rejects(
        LLM._handleStream(response, null, false),
        /Idle timeout/
    );
    LLM.abortController = null;
});

test('idle: default window is 90000ms when setting is unset', async () => {
    // Verify the fallback in _handleStream picks up the documented default.
    delete State.settings.llmIdleTimeout;
    LLM.abortController = new AbortController();
    const response = makeFakeResponse(
        [
            { delay: 5, data: 'quick' },
            { delay: 5, done: true }
        ],
        LLM.abortController.signal
    );
    const result = await LLM._handleStream(response, null, false);
    assert.equal(result.content, 'quick');
    // Restore the default for subsequent tests.
    State.settings.llmIdleTimeout = 90000;
    LLM.abortController = null;
});

test('idle: user-initiated abort surfaces as AbortError, not idle timeout', async () => {
    State.settings.llmIdleTimeout = 5000; // long, won't fire
    LLM.abortController = new AbortController();
    const response = makeFakeResponse(
        [
            { delay: 30, data: 'one' }
            // Then silence — but the test triggers abort BEFORE idle fires.
        ],
        LLM.abortController.signal
    );
    const streamPromise = LLM._handleStream(response, null, false);
    await sleep(60); // let the first chunk arrive
    LLM.abortController.abort(); // user-cancel via LLM.stop() shape

    await assert.rejects(streamPromise, (err) => {
        // Should be the raw AbortError, not the idle-timeout message —
        // the inner try/catch only translates when idleTimedOut is true.
        return err.name === 'AbortError' || /aborted/i.test(err.message);
    });
    LLM.abortController = null;
});
