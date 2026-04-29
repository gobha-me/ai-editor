/**
 * Browser tests for LLM._handleStream() idle-timeout behavior (1.1.1).
 * Mirrors `tests/test-llm-idle-timeout.mjs` using the in-page T harness.
 *
 * Uses real timers + AbortController; durations are short (50-200ms) so the
 * suite stays fast. Builds a fake Response whose body emits scripted chunks
 * on the abort signal so we don't need a network or fetch shim.
 */
import { LLM } from '../js/llm/api.js';
import { State } from '../js/core.js';

const { T } = window;

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
                if (!step) return; // wait forever until aborted
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
    return { body: { getReader: () => reader } };
}

T.suite('LLM idle timeout — chunks within window');

await (async () => {
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
    T.eq(result.content, 'hello world', 'stream completes when chunks arrive in time');
    LLM.abortController = null;
})();

T.suite('LLM idle timeout — silence triggers abort');

await (async () => {
    State.settings.llmIdleTimeout = 80;
    LLM.abortController = new AbortController();
    const response = makeFakeResponse([], LLM.abortController.signal);
    let caught = null;
    try {
        await LLM._handleStream(response, null, false);
    } catch (err) {
        caught = err;
    }
    T.assert(caught !== null, 'rejected when no chunks arrive');
    T.assert(/Idle timeout/.test(caught.message), 'error message names idle timeout');
    T.assert(/no tokens received/.test(caught.message), 'error message explains why');
    LLM.abortController = null;
})();

T.suite('LLM idle timeout — timer resets per chunk');

await (async () => {
    State.settings.llmIdleTimeout = 100;
    LLM.abortController = new AbortController();
    // Each step <100ms but cumulative duration > 100ms — naive wall-clock
    // would have aborted; idle resets keep it alive.
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
    T.eq(result.content, 'abcd', 'cumulative >window stream survives via per-chunk reset');
    LLM.abortController = null;
})();

// Restore the documented default for any subsequent suites.
State.settings.llmIdleTimeout = 90000;
