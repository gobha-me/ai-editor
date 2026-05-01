/**
 * Ghost-text completion tests (1.4.7).
 *
 * Two layers:
 *   1. Pure helpers in `js/llm/completion.js` — slicing, fence stripping,
 *      prompt construction. No fetch, no DOM.
 *   2. `requestGhostTextCompletion` against a stubbed `fetch` —
 *      happy path, abort propagation, non-ok status, empty response.
 *   3. Pure helpers in `js/editor/ghost-text.js` — settings resolution,
 *      indent-context detection. No CM6, no DOM.
 *
 * The decoration-rendering / keymap-dispatch path is browser-only; covered
 * in `tests/test-ghost-text.js` against a real EditorView.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    sliceContextAroundCursor,
    cleanCompletionResponse,
    buildGhostTextSystemPrompt,
    buildGhostTextUserMessage,
    requestGhostTextCompletion,
} from '../js/llm/completion.js';
import {
    GHOST_TEXT_DEFAULTS,
    getGhostTextSettings,
    isAtIndentContext,
    _resetForTest,
    _getThrottleStateForTest,
} from '../js/editor/ghost-text.js';
import { State } from '../js/core.js';

/* ---------------- sliceContextAroundCursor ---------------- */

test('slice: cursor at end of buffer returns full prefix, empty suffix', () => {
    const text = 'line1\nline2\nline3';
    const { prefix, suffix } = sliceContextAroundCursor(text, text.length, 10);
    assert.equal(prefix, 'line1\nline2\nline3');
    assert.equal(suffix, '');
});

test('slice: cursor at 0 returns empty prefix, full suffix', () => {
    const text = 'line1\nline2\nline3';
    const { prefix, suffix } = sliceContextAroundCursor(text, 0, 10);
    assert.equal(prefix, '');
    assert.equal(suffix, 'line1\nline2\nline3');
});

test('slice: contextLines caps both sides', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    const text = lines.join('\n');
    // Cursor in the middle.
    const cursor = text.indexOf('L50');
    const { prefix, suffix } = sliceContextAroundCursor(text, cursor, 5);
    // 5 lines of prefix, exclusive of the line with cursor having empty content
    const prefixLines = prefix.split('\n');
    const suffixLines = suffix.split('\n');
    assert.equal(prefixLines.length, 5);
    assert.equal(suffixLines.length, 5);
    // Suffix starts at L50
    assert.equal(suffixLines[0].startsWith('L50'), true);
});

test('slice: empty text yields empty halves', () => {
    const { prefix, suffix } = sliceContextAroundCursor('', 0, 5);
    assert.equal(prefix, '');
    assert.equal(suffix, '');
});

test('slice: out-of-bounds cursor is clamped', () => {
    const text = 'abc';
    const { prefix, suffix } = sliceContextAroundCursor(text, 999, 5);
    assert.equal(prefix, 'abc');
    assert.equal(suffix, '');
    const r = sliceContextAroundCursor(text, -10, 5);
    assert.equal(r.prefix, '');
    assert.equal(r.suffix, 'abc');
});

/* ---------------- cleanCompletionResponse ---------------- */

test('clean: strips a leading fenced block', () => {
    assert.equal(cleanCompletionResponse('```js\nconsole.log(1);\n```'), 'console.log(1);');
});

test('clean: strips a single fence even without language', () => {
    assert.equal(cleanCompletionResponse('```\nfoo\n```'), 'foo');
});

test('clean: strips think blocks', () => {
    const raw = '<think>let me think...</think>final answer';
    // stripThinkBlocks should remove the think block; final remains.
    const cleaned = cleanCompletionResponse(raw);
    assert.equal(cleaned.includes('<think>'), false);
    assert.equal(cleaned.includes('final answer'), true);
});

test('clean: empty / non-string returns ""', () => {
    assert.equal(cleanCompletionResponse(''), '');
    assert.equal(cleanCompletionResponse(null), '');
    assert.equal(cleanCompletionResponse(undefined), '');
});

test('clean: passes through plain text', () => {
    assert.equal(cleanCompletionResponse('return x + 1;'), 'return x + 1;');
});

/* ---------------- buildGhostTextSystemPrompt ---------------- */

test('system prompt: includes core instructions', () => {
    const p = buildGhostTextSystemPrompt('javascript', 'app.js');
    assert.equal(p.includes('inline code-completion engine'), true);
    assert.equal(p.includes('<PREFIX>'), true);
    assert.equal(p.includes('<SUFFIX>'), true);
    assert.equal(p.includes('javascript'), true);
    assert.equal(p.includes('app.js'), true);
});

test('system prompt: handles missing language/filename', () => {
    const p = buildGhostTextSystemPrompt('', '');
    assert.equal(p.includes('<PREFIX>'), true);
    assert.equal(typeof p, 'string');
    assert.equal(p.length > 0, true);
});

test('user message: wraps prefix + suffix', () => {
    const m = buildGhostTextUserMessage('foo', 'bar');
    assert.equal(m, '<PREFIX>foo</PREFIX><SUFFIX>bar</SUFFIX>');
});

/* ---------------- requestGhostTextCompletion (fetch stub) ---------------- */

function withStubbedFetch(stub, fn) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve()
        .then(() => fn())
        .finally(() => { globalThis.fetch = realFetch; });
}

function withSettings(settings, fn) {
    const prev = { ...State.settings };
    Object.assign(State.settings, settings);
    return Promise.resolve()
        .then(fn)
        .finally(() => { Object.assign(State.settings, prev); });
}

test('request: happy path returns cleaned suggestion', async () => {
    await withSettings({
        llmEndpoint: 'https://example.test/v1',
        llmApiKey: 'k',
        llmModel: 'm',
    }, () => withStubbedFetch(
        async (url, init) => {
            assert.equal(url, 'https://example.test/v1/chat/completions');
            const body = JSON.parse(init.body);
            assert.equal(body.stream, false);
            assert.equal(body.tools, undefined);
            return new Response(JSON.stringify({
                choices: [{ message: { content: '```js\nreturn 42;\n```' } }],
            }), { status: 200 });
        },
        async () => {
            const out = await requestGhostTextCompletion({
                prefix: 'function f(){',
                suffix: '}',
                language: 'javascript',
            });
            assert.equal(out, 'return 42;');
        }
    ));
});

test('request: empty response yields empty string (no error)', async () => {
    await withSettings({
        llmEndpoint: 'https://example.test/v1',
        llmApiKey: 'k',
        llmModel: 'm',
    }, () => withStubbedFetch(
        async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
        async () => {
            const out = await requestGhostTextCompletion({ prefix: '', suffix: '' });
            assert.equal(out, '');
        }
    ));
});

test('request: non-2xx throws with status in message', async () => {
    await withSettings({
        llmEndpoint: 'https://example.test/v1',
        llmApiKey: 'k',
        llmModel: 'm',
    }, () => withStubbedFetch(
        async () => new Response('rate limited', { status: 429 }),
        async () => {
            await assert.rejects(
                requestGhostTextCompletion({ prefix: '', suffix: '' }),
                /429/
            );
        }
    ));
});

test('request: missing endpoint throws synchronously-ish', async () => {
    await withSettings({
        llmEndpoint: '',
        llmApiKey: 'k',
        llmModel: 'm',
    }, async () => {
        await assert.rejects(
            requestGhostTextCompletion({ prefix: '', suffix: '' }),
            /no LLM endpoint/i
        );
    });
});

test('request: signal abort propagates as AbortError', async () => {
    await withSettings({
        llmEndpoint: 'https://example.test/v1',
        llmApiKey: 'k',
        llmModel: 'm',
    }, () => withStubbedFetch(
        // Fetch stub that respects the signal and rejects accordingly.
        (url, init) => new Promise((resolve, reject) => {
            if (init.signal.aborted) {
                const e = new Error('aborted');
                e.name = 'AbortError';
                return reject(e);
            }
            init.signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
            });
        }),
        async () => {
            const ac = new AbortController();
            const p = requestGhostTextCompletion({ prefix: '', suffix: '', signal: ac.signal });
            ac.abort();
            await assert.rejects(p, (err) => err && err.name === 'AbortError');
        }
    ));
});

/* ---------------- isAtIndentContext ---------------- */

test('indent context: empty line is indent context', () => {
    assert.equal(isAtIndentContext('', 0), true);
});

test('indent context: cursor at line start with leading whitespace is indent context', () => {
    assert.equal(isAtIndentContext('    ', 4), true);
    assert.equal(isAtIndentContext('\t\t', 2), true);
});

test('indent context: cursor right after non-whitespace is not indent context', () => {
    assert.equal(isAtIndentContext('const x = ', 'const x = '.length), false);
    assert.equal(isAtIndentContext('foo', 3), false);
});

test('indent context: cursor in middle of line is not indent context', () => {
    assert.equal(isAtIndentContext('  console.log()', 12), false);
});

test('indent context: blank middle of multi-line, line-start indent', () => {
    const text = 'a\n    \nb';
    // Cursor inside the middle line, at col 4 (whitespace only before)
    const cursor = text.indexOf('\n') + 1 + 4;
    assert.equal(isAtIndentContext(text, cursor), true);
});

test('indent context: defensive against bad inputs', () => {
    assert.equal(isAtIndentContext(null, 0), true);
    assert.equal(isAtIndentContext(undefined, 0), true);
});

/* ---------------- getGhostTextSettings ---------------- */

test('settings: defaults when subtree missing', () => {
    const prev = State.settings.ghostText;
    delete State.settings.ghostText;
    try {
        const s = getGhostTextSettings();
        assert.equal(s.enabled, false);
        assert.equal(s.hotkey, 'Tab');
        assert.equal(s.maxTokens, 150);
        assert.equal(s.contextLines, 40);
        assert.equal(s.model, '');
    } finally {
        State.settings.ghostText = prev;
    }
});

test('settings: partial subtree fills with defaults', () => {
    const prev = State.settings.ghostText;
    State.settings.ghostText = { enabled: true, hotkey: 'Mod-i' };
    try {
        const s = getGhostTextSettings();
        assert.equal(s.enabled, true);
        assert.equal(s.hotkey, 'Mod-i');
        assert.equal(s.maxTokens, 150);
        assert.equal(s.contextLines, 40);
    } finally {
        State.settings.ghostText = prev;
    }
});

test('settings: rejects bad maxTokens / contextLines', () => {
    const prev = State.settings.ghostText;
    State.settings.ghostText = { maxTokens: -5, contextLines: 'whoops' };
    try {
        const s = getGhostTextSettings();
        assert.equal(s.maxTokens, GHOST_TEXT_DEFAULTS.maxTokens);
        assert.equal(s.contextLines, GHOST_TEXT_DEFAULTS.contextLines);
    } finally {
        State.settings.ghostText = prev;
    }
});

/* ---------------- throttle reset ---------------- */

test('throttle: _resetForTest clears in-flight + sequence', () => {
    _resetForTest();
    const s = _getThrottleStateForTest();
    assert.equal(s.inFlight, false);
    assert.equal(s.requestSeq, 0);
});
