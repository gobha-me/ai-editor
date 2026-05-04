/**
 * Query paraphraser tests (1.5.12).
 *
 * Covers `js/intelligence/retrieval/query-paraphraser.js`:
 *   - `createQueryParaphraser({ chatFn, modelId, rounds?, temperature?, prompt?, cache? })`
 *   - `buildParaphraserFromSettings(settings, { chatFn, cache? })`
 *   - `DEFAULT_PARAPHRASE_PROMPT` / `DEFAULT_PARAPHRASE_ROUNDS` /
 *     `DEFAULT_PARAPHRASE_TEMPERATURE`
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createQueryParaphraser,
    buildParaphraserFromSettings,
    DEFAULT_PARAPHRASE_PROMPT,
    DEFAULT_PARAPHRASE_ROUNDS,
    DEFAULT_PARAPHRASE_TEMPERATURE,
} from '../js/intelligence/retrieval/query-paraphraser.js';

/* ---------------- Spy helpers ---------------- */

/**
 * Build a spy `chatFn` that returns the given string. Captures every
 * `(messages, options)` invocation under `.calls`.
 */
function spyChat(returnValue) {
    /** @type {{messages: any[], options: any}[]} */
    const calls = [];
    const fn = async (messages, options) => {
        calls.push({ messages, options });
        if (typeof returnValue === 'function') return returnValue(messages, options);
        return returnValue;
    };
    fn.calls = calls;
    return fn;
}

const TWO_LINE_RESPONSE = 'first paraphrase\nsecond paraphrase';

/* ---------------- Factory shape + argument validation ---------------- */

test('createQueryParaphraser returns a handle with paraphrase + stats', () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    assert.equal(typeof p.paraphrase, 'function');
    assert.equal(typeof p.stats, 'function');
    assert.deepEqual(p.stats(), { hits: 0, misses: 0, failures: 0 });
});

test('createQueryParaphraser rejects missing options', () => {
    assert.throws(() => createQueryParaphraser(null), TypeError);
    assert.throws(() => createQueryParaphraser(undefined), TypeError);
});

test('createQueryParaphraser rejects non-function chatFn', () => {
    assert.throws(
        () => createQueryParaphraser({ chatFn: 'not-a-fn', modelId: 'm1' }),
        TypeError,
    );
});

test('createQueryParaphraser rejects missing / empty modelId', () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: '' }),
        TypeError,
    );
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 42 }),
        TypeError,
    );
});

test('createQueryParaphraser rejects out-of-range rounds', () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 0 }),
        TypeError,
    );
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 6 }),
        TypeError,
    );
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: NaN }),
        TypeError,
    );
});

test('createQueryParaphraser rejects out-of-range temperature', () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 'm1', temperature: -0.1 }),
        TypeError,
    );
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 'm1', temperature: 2.1 }),
        TypeError,
    );
});

test('createQueryParaphraser rejects malformed cache', () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    assert.throws(
        () => createQueryParaphraser({ chatFn: chat, modelId: 'm1', cache: { get: () => null } }),
        TypeError,
    );
});

/* ---------------- Locked-prompt + defaults ---------------- */

test('DEFAULT_PARAPHRASE_PROMPT is corpus-agnostic (no ai-editor / file-path mentions)', () => {
    const p = DEFAULT_PARAPHRASE_PROMPT.toLowerCase();
    assert.equal(typeof DEFAULT_PARAPHRASE_PROMPT, 'string');
    assert.ok(DEFAULT_PARAPHRASE_PROMPT.length > 0);
    assert.equal(p.includes('ai-editor'), false);
    assert.equal(p.includes('.js'), false);
    assert.equal(p.includes('docs/'), false);
});

test('default rounds = 2, default temperature = 0', () => {
    assert.equal(DEFAULT_PARAPHRASE_ROUNDS, 2);
    assert.equal(DEFAULT_PARAPHRASE_TEMPERATURE, 0);
});

/* ---------------- Empty/whitespace input ---------------- */

test('paraphrase("") returns [] without calling chatFn', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('');
    assert.deepEqual(out, []);
    assert.equal(chat.calls.length, 0);
});

test('paraphrase("   \\n\\t  ") returns [] without calling chatFn', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('   \n\t  ');
    assert.deepEqual(out, []);
    assert.equal(chat.calls.length, 0);
});

test('paraphrase(non-string) returns [] without calling chatFn', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase(/** @type {any} */ (null));
    assert.deepEqual(out, []);
    assert.equal(chat.calls.length, 0);
});

/* ---------------- Happy path + parsing ---------------- */

test('paraphrase parses N lines into N paraphrases', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('the original');
    assert.deepEqual(out, ['first paraphrase', 'second paraphrase']);
    assert.equal(p.stats().misses, 1);
});

test('paraphrase strips numbering and bullets', async () => {
    const chat = spyChat('1. one\n2) two\n- three\n* four');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 4 });
    const out = await p.paraphrase('original query');
    assert.deepEqual(out, ['one', 'two', 'three', 'four']);
});

test('paraphrase skips empty/whitespace lines', async () => {
    const chat = spyChat('one\n\n   \ntwo\n');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('original');
    assert.deepEqual(out, ['one', 'two']);
});

test('paraphrase filters out a line that echoes the original query', async () => {
    const chat = spyChat('original\nbetter phrasing');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 2 });
    const out = await p.paraphrase('original');
    assert.deepEqual(out, ['better phrasing']);
});

test('paraphrase truncates to `rounds` when chatFn returns more', async () => {
    const chat = spyChat('a\nb\nc\nd\ne');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 2 });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, ['a', 'b']);
});

test('paraphrase honors rounds=1', async () => {
    const chat = spyChat('only one\nshould not appear');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 1 });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, ['only one']);
});

test('paraphrase honors rounds=3', async () => {
    const chat = spyChat('a\nb\nc\nd');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 3 });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, ['a', 'b', 'c']);
});

/* ---------------- Failure modes ---------------- */

test('paraphrase returns [] when chatFn throws (and counts a failure)', async () => {
    const chat = async () => { throw new Error('network down'); };
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, []);
    assert.equal(p.stats().failures, 1);
});

test('paraphrase returns [] when chatFn returns empty string (counts a failure)', async () => {
    const chat = spyChat('');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, []);
    assert.equal(p.stats().failures, 1);
});

test('paraphrase returns [] when chatFn returns non-string (counts a failure)', async () => {
    const chat = spyChat(/** @type {any} */ (null));
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, []);
    assert.equal(p.stats().failures, 1);
});

test('paraphrase returns [] when response has only the original (counts a failure)', async () => {
    const chat = spyChat('q\n');
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const out = await p.paraphrase('q');
    assert.deepEqual(out, []);
    assert.equal(p.stats().failures, 1);
});

/* ---------------- Cache hit / miss ---------------- */

test('paraphrase caches by query within a paraphraser instance', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const a = await p.paraphrase('hello');
    const b = await p.paraphrase('hello');
    assert.deepEqual(a, b);
    assert.equal(chat.calls.length, 1);
    assert.equal(p.stats().hits, 1);
    assert.equal(p.stats().misses, 1);
});

test('paraphrase cache miss across distinct queries', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    await p.paraphrase('first');
    await p.paraphrase('second');
    assert.equal(chat.calls.length, 2);
    assert.equal(p.stats().misses, 2);
    assert.equal(p.stats().hits, 0);
});

test('paraphrase cache miss across model swap', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const sharedCache = (() => {
        const m = new Map();
        return {
            get: (k) => m.has(k) ? m.get(k) : null,
            set: (k, v) => m.set(k, v),
            size: () => m.size,
        };
    })();
    const p1 = createQueryParaphraser({ chatFn: chat, modelId: 'm1', cache: sharedCache });
    const p2 = createQueryParaphraser({ chatFn: chat, modelId: 'm2', cache: sharedCache });
    await p1.paraphrase('q');
    await p2.paraphrase('q');
    assert.equal(chat.calls.length, 2);
    assert.equal(sharedCache.size(), 2);
});

test('paraphrase cache miss across prompt swap', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const sharedCache = (() => {
        const m = new Map();
        return {
            get: (k) => m.has(k) ? m.get(k) : null,
            set: (k, v) => m.set(k, v),
            size: () => m.size,
        };
    })();
    const p1 = createQueryParaphraser({ chatFn: chat, modelId: 'm1', cache: sharedCache });
    const p2 = createQueryParaphraser({
        chatFn: chat,
        modelId: 'm1',
        prompt: 'A different prompt entirely.',
        cache: sharedCache,
    });
    await p1.paraphrase('q');
    await p2.paraphrase('q');
    assert.equal(chat.calls.length, 2);
    assert.equal(sharedCache.size(), 2);
});

test('paraphrase returns a defensive copy from cache (callers cannot mutate stored value)', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    const a = await p.paraphrase('x');
    a.push('mutation');
    const b = await p.paraphrase('x');
    assert.deepEqual(b, ['first paraphrase', 'second paraphrase']);
});

/* ---------------- chatFn argument threading ---------------- */

test('paraphrase threads model + temperature into chatFn options', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({
        chatFn: chat, modelId: 'm-utility', temperature: 0.5,
    });
    await p.paraphrase('q');
    assert.equal(chat.calls.length, 1);
    assert.equal(chat.calls[0].options.model, 'm-utility');
    assert.equal(chat.calls[0].options.temperature, 0.5);
});

test('paraphrase substitutes the requested rounds into the prompt content', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1', rounds: 3 });
    await p.paraphrase('q');
    const prompt = chat.calls[0].messages[0].content;
    // The prompt resolution replaces the literal ` N ` placeholder with `3`.
    assert.match(prompt, / 3 alternative phrasings/);
});

test('paraphrase passes a single user message; prompt + query both present', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({ chatFn: chat, modelId: 'm1' });
    await p.paraphrase('the user query');
    const messages = chat.calls[0].messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content, /the user query/);
    assert.match(messages[0].content, /search-query reformulator/);
});

test('paraphrase honors a custom prompt override', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const p = createQueryParaphraser({
        chatFn: chat, modelId: 'm1', prompt: 'CUSTOM_PROMPT_PINNED',
    });
    await p.paraphrase('q');
    assert.match(chat.calls[0].messages[0].content, /CUSTOM_PROMPT_PINNED/);
});

/* ---------------- buildParaphraserFromSettings ---------------- */

test('buildParaphraserFromSettings: mode "off" returns null', () => {
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            paraphraseMode: 'off',
            paraphraseModelId: '',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    const result = buildParaphraserFromSettings(settings, { chatFn: spyChat('') });
    assert.equal(result, null);
});

test('buildParaphraserFromSettings: mode "primary" wires llmModel', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            paraphraseMode: 'primary',
            paraphraseModelId: '',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    const p = buildParaphraserFromSettings(settings, { chatFn: chat });
    assert.notEqual(p, null);
    await p.paraphrase('q');
    assert.equal(chat.calls[0].options.model, 'primary-m');
});

test('buildParaphraserFromSettings: mode "utility" wires paraphraseModelId', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            paraphraseMode: 'utility',
            paraphraseModelId: 'utility-m',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    const p = buildParaphraserFromSettings(settings, { chatFn: chat });
    assert.notEqual(p, null);
    await p.paraphrase('q');
    assert.equal(chat.calls[0].options.model, 'utility-m');
});

test('buildParaphraserFromSettings: mode "utility" with empty modelId returns null', () => {
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            paraphraseMode: 'utility',
            paraphraseModelId: '',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    const p = buildParaphraserFromSettings(settings, { chatFn: spyChat('') });
    assert.equal(p, null);
});

test('buildParaphraserFromSettings: mode "primary" with missing llmModel returns null', () => {
    const settings = {
        llmModel: '',
        retrieval: {
            paraphraseMode: 'primary',
            paraphraseModelId: '',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    const p = buildParaphraserFromSettings(settings, { chatFn: spyChat('') });
    assert.equal(p, null);
});

test('buildParaphraserFromSettings: missing settings → null', () => {
    assert.equal(buildParaphraserFromSettings(null, { chatFn: spyChat('') }), null);
    assert.equal(buildParaphraserFromSettings(undefined, { chatFn: spyChat('') }), null);
});

test('buildParaphraserFromSettings: missing chatFn → null', () => {
    const settings = {
        llmModel: 'm1',
        retrieval: {
            paraphraseMode: 'primary',
            paraphraseModelId: '',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    assert.equal(buildParaphraserFromSettings(settings, /** @type {any} */ (null)), null);
    assert.equal(buildParaphraserFromSettings(settings, /** @type {any} */ ({})), null);
});

test('buildParaphraserFromSettings: unknown mode value → null', () => {
    const settings = {
        llmModel: 'm1',
        retrieval: {
            paraphraseMode: 'aggressive',
            paraphraseModelId: 'm1',
            paraphraseRounds: 2,
            paraphraseTemperature: 0,
        },
    };
    assert.equal(buildParaphraserFromSettings(settings, { chatFn: spyChat('') }), null);
});

test('buildParaphraserFromSettings: rounds + temperature threaded through', async () => {
    const chat = spyChat(TWO_LINE_RESPONSE);
    const settings = {
        llmModel: 'm1',
        retrieval: {
            paraphraseMode: 'primary',
            paraphraseModelId: '',
            paraphraseRounds: 3,
            paraphraseTemperature: 0.7,
        },
    };
    const p = buildParaphraserFromSettings(settings, { chatFn: chat });
    await p.paraphrase('q');
    assert.equal(chat.calls[0].options.temperature, 0.7);
    // Prompt N substitution proves rounds=3 was threaded.
    assert.match(chat.calls[0].messages[0].content, / 3 alternative phrasings/);
});
