/**
 * Regression test for the `Providers` facade exposed by
 * [`js/core.js`](../js/core.js).
 *
 * **Bug class.** Pre-2.47.0 the facade proxied `register / get / list /
 * parseModels` to `ProviderRegistry` but missed `enrichModels` (added to
 * the registry at [`js/providers/registry.js:320`](../js/providers/registry.js#L320)
 * after the facade was authored). Consumers that import `Providers` from
 * core (like [`js/llm/api.js:262`](../js/llm/api.js#L262)) saw
 *     [LLM] Model enrichment failed (using defaults): Providers.enrichModels is not a function
 * at app init on every load. Models still populated via the try/catch
 * fallback, but Ollama models lost their `/api/show` capability
 * enrichment.
 *
 * The fix adds an `enrichModels` delegation to the facade. This test
 * pins facade ↔ ProviderRegistry parity for that method so a future
 * refactor of either side surfaces a failing assertion rather than a
 * silent runtime warn.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Providers, State } = await import('../js/core.js');

test('Providers facade exposes enrichModels (2.47.0 regression fix)', () => {
    assert.equal(
        typeof Providers.enrichModels,
        'function',
        'Providers.enrichModels must be callable from the core.js facade — added 2.47.0 to close facade ↔ ProviderRegistry parity gap',
    );
});

test('Providers.enrichModels returns models unchanged for a provider without enrichModels impl', async () => {
    const models = [{ id: 'gpt-4', name: 'GPT-4' }, { id: 'gpt-3.5', name: 'GPT-3.5' }];
    const settings = { ...State.settings, apiProvider: 'openai' };
    const result = await Providers.enrichModels(models, settings);
    assert.deepEqual(result, models, 'no-op fallback must preserve the input array');
});
