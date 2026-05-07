/**
 * Cross-file query expander tests (1.8.1).
 *
 * Covers `js/intelligence/retrieval/query-expander.js`:
 *   - `createQueryExpander({ chatFn, modelId, rounds?, temperature?, prompt?, cache? })`
 *   - `buildExpanderFromSettings(settings, { chatFn, cache? })`
 *   - `DEFAULT_EXPAND_PROMPT` / `DEFAULT_EXPAND_ROUNDS` /
 *     `DEFAULT_EXPAND_TEMPERATURE`
 *
 * Mirrors `test-retrieval-query-paraphraser.mjs` end-to-end. The two
 * suites stay parallel because the expander shares the paraphraser's
 * DI shape — divergence would mean a behavior split that the Composer
 * wiring relies on being absent.
 *
 * Pure-data, no DOM / State / network — runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createQueryExpander,
    buildExpanderFromSettings,
    DEFAULT_EXPAND_PROMPT,
    DEFAULT_EXPAND_ROUNDS,
    DEFAULT_EXPAND_TEMPERATURE,
} from '../js/intelligence/retrieval/query-expander.js';

/* ---------------- Spy helpers ---------------- */

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

const THREE_LINE_RESPONSE = 'register_capability\nRegisterResult\nCapabilityError';

/* ---------------- Factory shape + argument validation ---------------- */

test('createQueryExpander returns a handle with expand + stats', () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    assert.equal(typeof e.expand, 'function');
    assert.equal(typeof e.stats, 'function');
    assert.deepEqual(e.stats(), { hits: 0, misses: 0, failures: 0 });
});

test('createQueryExpander rejects missing options', () => {
    assert.throws(() => createQueryExpander(null), TypeError);
    assert.throws(() => createQueryExpander(undefined), TypeError);
});

test('createQueryExpander rejects non-function chatFn', () => {
    assert.throws(
        () => createQueryExpander({ chatFn: 'not-a-fn', modelId: 'm1' }),
        TypeError,
    );
});

test('createQueryExpander rejects missing / empty modelId', () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: '' }),
        TypeError,
    );
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 42 }),
        TypeError,
    );
});

test('createQueryExpander rejects out-of-range rounds', () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 0 }),
        TypeError,
    );
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 6 }),
        TypeError,
    );
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: NaN }),
        TypeError,
    );
});

test('createQueryExpander rejects out-of-range temperature', () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 'm1', temperature: -0.1 }),
        TypeError,
    );
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 'm1', temperature: 2.1 }),
        TypeError,
    );
});

test('createQueryExpander rejects malformed cache', () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    assert.throws(
        () => createQueryExpander({ chatFn: chat, modelId: 'm1', cache: { get: () => null } }),
        TypeError,
    );
});

/* ---------------- Locked-prompt + defaults ---------------- */

test('DEFAULT_EXPAND_PROMPT is corpus-agnostic (no ai-editor / file-path mentions)', () => {
    const p = DEFAULT_EXPAND_PROMPT.toLowerCase();
    assert.equal(typeof DEFAULT_EXPAND_PROMPT, 'string');
    assert.ok(DEFAULT_EXPAND_PROMPT.length > 0);
    assert.equal(p.includes('ai-editor'), false);
    assert.equal(p.includes('.js'), false);
    assert.equal(p.includes('docs/'), false);
    assert.equal(p.includes('plinth'), false);
    assert.equal(p.includes('armature'), false);
});

test('DEFAULT_EXPAND_PROMPT asks for identifier vocabulary, not paraphrase', () => {
    // Keeps the divergence from the paraphraser visible — the lever's
    // hypothesis (validated by the 2026-05-07 probe) is that the model
    // emits *identifier alts* an engineer would type, not natural-
    // language paraphrases.
    assert.match(DEFAULT_EXPAND_PROMPT, /identifier/i);
});

test('default rounds = 3, default temperature = 0', () => {
    assert.equal(DEFAULT_EXPAND_ROUNDS, 3);
    assert.equal(DEFAULT_EXPAND_TEMPERATURE, 0);
});

/* ---------------- Empty/whitespace input ---------------- */

test('expand("") returns [] without calling chatFn', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('');
    assert.deepEqual(out, []);
    assert.equal(chat.calls.length, 0);
});

test('expand("   \\n\\t  ") returns [] without calling chatFn', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('   \n\t  ');
    assert.deepEqual(out, []);
    assert.equal(chat.calls.length, 0);
});

test('expand(non-string) returns [] without calling chatFn', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand(/** @type {any} */ (null));
    assert.deepEqual(out, []);
    assert.equal(chat.calls.length, 0);
});

/* ---------------- Happy path + parsing ---------------- */

test('expand parses N lines into N alts (default rounds = 3)', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('where do extensions register new capabilities?');
    assert.deepEqual(out, ['register_capability', 'RegisterResult', 'CapabilityError']);
    assert.equal(e.stats().misses, 1);
});

test('expand strips numbering and bullets', async () => {
    const chat = spyChat('1. one\n2) two\n- three\n* four');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 4 });
    const out = await e.expand('original query');
    assert.deepEqual(out, ['one', 'two', 'three', 'four']);
});

test('expand skips empty/whitespace lines', async () => {
    const chat = spyChat('one\n\n   \ntwo\n');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('original');
    assert.deepEqual(out, ['one', 'two']);
});

test('expand filters out a line that echoes the original query', async () => {
    const chat = spyChat('original\nidentifier_alt');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 2 });
    const out = await e.expand('original');
    assert.deepEqual(out, ['identifier_alt']);
});

test('expand truncates to `rounds` when chatFn returns more', async () => {
    const chat = spyChat('a\nb\nc\nd\ne');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 2 });
    const out = await e.expand('q');
    assert.deepEqual(out, ['a', 'b']);
});

test('expand honors rounds=1', async () => {
    const chat = spyChat('only one\nshould not appear');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 1 });
    const out = await e.expand('q');
    assert.deepEqual(out, ['only one']);
});

test('expand honors rounds=5 (the upper bound)', async () => {
    const chat = spyChat('a\nb\nc\nd\ne\nf');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 5 });
    const out = await e.expand('q');
    assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e']);
});

/* ---------------- Failure modes ---------------- */

test('expand returns [] when chatFn throws (and counts a failure)', async () => {
    const chat = async () => { throw new Error('network down'); };
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('q');
    assert.deepEqual(out, []);
    assert.equal(e.stats().failures, 1);
});

test('expand returns [] when chatFn returns empty string (counts a failure)', async () => {
    const chat = spyChat('');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('q');
    assert.deepEqual(out, []);
    assert.equal(e.stats().failures, 1);
});

test('expand returns [] when chatFn returns non-string (counts a failure)', async () => {
    const chat = spyChat(/** @type {any} */ (null));
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('q');
    assert.deepEqual(out, []);
    assert.equal(e.stats().failures, 1);
});

test('expand returns [] when response has only the original (counts a failure)', async () => {
    const chat = spyChat('q\n');
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const out = await e.expand('q');
    assert.deepEqual(out, []);
    assert.equal(e.stats().failures, 1);
});

/* ---------------- Cache hit / miss ---------------- */

test('expand caches by query within an expander instance', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const a = await e.expand('hello');
    const b = await e.expand('hello');
    assert.deepEqual(a, b);
    assert.equal(chat.calls.length, 1);
    assert.equal(e.stats().hits, 1);
    assert.equal(e.stats().misses, 1);
});

test('expand cache miss across distinct queries', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    await e.expand('first');
    await e.expand('second');
    assert.equal(chat.calls.length, 2);
    assert.equal(e.stats().misses, 2);
    assert.equal(e.stats().hits, 0);
});

test('expand cache miss across model swap', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const sharedCache = (() => {
        const m = new Map();
        return {
            get: (k) => m.has(k) ? m.get(k) : null,
            set: (k, v) => m.set(k, v),
            size: () => m.size,
        };
    })();
    const e1 = createQueryExpander({ chatFn: chat, modelId: 'm1', cache: sharedCache });
    const e2 = createQueryExpander({ chatFn: chat, modelId: 'm2', cache: sharedCache });
    await e1.expand('q');
    await e2.expand('q');
    assert.equal(chat.calls.length, 2);
    assert.equal(sharedCache.size(), 2);
});

test('expand cache miss across prompt swap', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const sharedCache = (() => {
        const m = new Map();
        return {
            get: (k) => m.has(k) ? m.get(k) : null,
            set: (k, v) => m.set(k, v),
            size: () => m.size,
        };
    })();
    const e1 = createQueryExpander({ chatFn: chat, modelId: 'm1', cache: sharedCache });
    const e2 = createQueryExpander({
        chatFn: chat,
        modelId: 'm1',
        prompt: 'A different prompt entirely.',
        cache: sharedCache,
    });
    await e1.expand('q');
    await e2.expand('q');
    assert.equal(chat.calls.length, 2);
    assert.equal(sharedCache.size(), 2);
});

test('expand returns a defensive copy from cache (callers cannot mutate stored value)', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    const a = await e.expand('x');
    a.push('mutation');
    const b = await e.expand('x');
    assert.deepEqual(b, ['register_capability', 'RegisterResult', 'CapabilityError']);
});

/* ---------------- chatFn argument threading ---------------- */

test('expand threads model + temperature into chatFn options', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({
        chatFn: chat, modelId: 'm-utility', temperature: 0.5,
    });
    await e.expand('q');
    assert.equal(chat.calls.length, 1);
    assert.equal(chat.calls[0].options.model, 'm-utility');
    assert.equal(chat.calls[0].options.temperature, 0.5);
});

test('expand substitutes the requested rounds into the prompt content', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1', rounds: 4 });
    await e.expand('q');
    const prompt = chat.calls[0].messages[0].content;
    // The prompt resolution replaces the literal ` N ` placeholder with `4`.
    assert.match(prompt, / 4 alternative search queries/);
});

test('expand passes a single user message; prompt + query both present', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({ chatFn: chat, modelId: 'm1' });
    await e.expand('the user query');
    const messages = chat.calls[0].messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content, /the user query/);
    assert.match(messages[0].content, /code-search assistant/);
});

test('expand honors a custom prompt override', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const e = createQueryExpander({
        chatFn: chat, modelId: 'm1', prompt: 'CUSTOM_EXPAND_PROMPT_PINNED',
    });
    await e.expand('q');
    assert.match(chat.calls[0].messages[0].content, /CUSTOM_EXPAND_PROMPT_PINNED/);
});

/* ---------------- buildExpanderFromSettings ---------------- */

test('buildExpanderFromSettings: mode "off" returns null', () => {
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            crossFileExpansionMode: 'off',
            crossFileExpanderModelId: '',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    const result = buildExpanderFromSettings(settings, { chatFn: spyChat('') });
    assert.equal(result, null);
});

test('buildExpanderFromSettings: mode "primary" wires llmModel', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            crossFileExpansionMode: 'primary',
            crossFileExpanderModelId: '',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    const e = buildExpanderFromSettings(settings, { chatFn: chat });
    assert.notEqual(e, null);
    await e.expand('q');
    assert.equal(chat.calls[0].options.model, 'primary-m');
});

test('buildExpanderFromSettings: mode "utility" wires crossFileExpanderModelId', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            crossFileExpansionMode: 'utility',
            crossFileExpanderModelId: 'utility-m',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    const e = buildExpanderFromSettings(settings, { chatFn: chat });
    assert.notEqual(e, null);
    await e.expand('q');
    assert.equal(chat.calls[0].options.model, 'utility-m');
});

test('buildExpanderFromSettings: mode "utility" with empty modelId returns null', () => {
    const settings = {
        llmModel: 'primary-m',
        retrieval: {
            crossFileExpansionMode: 'utility',
            crossFileExpanderModelId: '',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    const e = buildExpanderFromSettings(settings, { chatFn: spyChat('') });
    assert.equal(e, null);
});

test('buildExpanderFromSettings: mode "primary" with missing llmModel returns null', () => {
    const settings = {
        llmModel: '',
        retrieval: {
            crossFileExpansionMode: 'primary',
            crossFileExpanderModelId: '',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    const e = buildExpanderFromSettings(settings, { chatFn: spyChat('') });
    assert.equal(e, null);
});

test('buildExpanderFromSettings: missing settings → null', () => {
    assert.equal(buildExpanderFromSettings(null, { chatFn: spyChat('') }), null);
    assert.equal(buildExpanderFromSettings(undefined, { chatFn: spyChat('') }), null);
});

test('buildExpanderFromSettings: missing chatFn → null', () => {
    const settings = {
        llmModel: 'm1',
        retrieval: {
            crossFileExpansionMode: 'primary',
            crossFileExpanderModelId: '',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    assert.equal(buildExpanderFromSettings(settings, /** @type {any} */ (null)), null);
    assert.equal(buildExpanderFromSettings(settings, /** @type {any} */ ({})), null);
});

test('buildExpanderFromSettings: unknown mode value → null', () => {
    const settings = {
        llmModel: 'm1',
        retrieval: {
            crossFileExpansionMode: 'aggressive',
            crossFileExpanderModelId: 'm1',
            crossFileExpanderRounds: 3,
            crossFileExpanderTemperature: 0,
        },
    };
    assert.equal(buildExpanderFromSettings(settings, { chatFn: spyChat('') }), null);
});

test('buildExpanderFromSettings: rounds + temperature threaded through', async () => {
    const chat = spyChat(THREE_LINE_RESPONSE);
    const settings = {
        llmModel: 'm1',
        retrieval: {
            crossFileExpansionMode: 'primary',
            crossFileExpanderModelId: '',
            crossFileExpanderRounds: 4,
            crossFileExpanderTemperature: 0.7,
        },
    };
    const e = buildExpanderFromSettings(settings, { chatFn: chat });
    await e.expand('q');
    assert.equal(chat.calls[0].options.temperature, 0.7);
    // Prompt N substitution proves rounds=4 was threaded.
    assert.match(chat.calls[0].messages[0].content, / 4 alternative search queries/);
});
