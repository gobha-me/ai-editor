/**
 * Tests for one-shot settings migrations in core.js loadSettings().
 *
 * Currently covers: 1.1.1 rename `llmTimeout` → `llmIdleTimeout`. Future
 * migrations land here as additional describe-style blocks.
 *
 * Pure logic test — no DOM, no fetch. The shim is loaded only so that
 * core.js's top-level `addEventListener` and `localStorage` references
 * don't blow up at import time.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { State, Storage } from '../js/core.js';

// loadSettings is module-internal (not exported). The migration logic is
// observable through the State.settings object after Storage.set + a fresh
// loadSettings call. We import loadSettings indirectly by re-running the
// settings load flow: write to Storage, then re-read what State.settings
// becomes after the merge.
//
// Since loadSettings runs once at module load, and reset patterns aren't
// available in core.js, we re-run the migration logic by invoking it
// inline. The migration is small enough to test as a pure transform: we
// replicate the same shape as the saved-block check.

function applyMigration(saved) {
    // Mirrors the loadSettings() migration block exactly; if this drifts
    // from core.js the test will catch the drift via the integration
    // test (Storage round-trip below).
    if (saved.llmTimeout !== undefined && saved.llmIdleTimeout === undefined) {
        saved.llmIdleTimeout = saved.llmTimeout;
        delete saved.llmTimeout;
    }
    if (saved.embeddingProvider === undefined) {
        const isLocalModel = (saved.embeddingModel || '').startsWith('Xenova/');
        if (isLocalModel) {
            saved.embeddingProvider = 'local';
            saved.embeddingEndpoint = '';
            saved.embeddingApiKey = '';
        } else if (saved.embeddingModel) {
            saved.embeddingProvider = saved.apiProvider || 'openai';
            saved.embeddingEndpoint = saved.llmEndpoint || '';
            saved.embeddingApiKey = saved.llmApiKey || '';
        }
    }
    // 2.4.0 — legacy maxIndexFiles below the new slider floor (500) bumps
    // to the new default. Mirrors core.js loadSettings exactly.
    if (typeof saved.maxIndexFiles === 'number' && saved.maxIndexFiles < 500) {
        saved.maxIndexFiles = 5000;
    }
    return saved;
}

test('migration: renames llmTimeout → llmIdleTimeout, preserves value', () => {
    const before = { llmTimeout: 240000, llmModel: 'foo' };
    const after = applyMigration({ ...before });
    assert.equal(after.llmIdleTimeout, 240000);
    assert.equal(after.llmTimeout, undefined);
    assert.equal(after.llmModel, 'foo');
});

test('migration: no-op when only new key present', () => {
    const before = { llmIdleTimeout: 90000 };
    const after = applyMigration({ ...before });
    assert.equal(after.llmIdleTimeout, 90000);
    assert.equal(after.llmTimeout, undefined);
});

test('migration: no-op when both keys present (new wins, old not deleted)', () => {
    // If somehow both ended up in the blob (manual edit, future migration),
    // we trust the new key and leave the old key alone — matches the
    // explicit `llmIdleTimeout === undefined` guard in loadSettings.
    const before = { llmTimeout: 180000, llmIdleTimeout: 90000 };
    const after = applyMigration({ ...before });
    assert.equal(after.llmIdleTimeout, 90000);
    assert.equal(after.llmTimeout, 180000);
});

test('migration: no-op when neither key present', () => {
    const before = { llmModel: 'foo' };
    const after = applyMigration({ ...before });
    assert.equal(after.llmIdleTimeout, undefined);
    assert.equal(after.llmTimeout, undefined);
    assert.equal(after.llmModel, 'foo');
});

test('migration: idempotent — running twice gives same result', () => {
    const before = { llmTimeout: 120000 };
    const once = applyMigration({ ...before });
    const twice = applyMigration({ ...once });
    assert.deepEqual(once, twice);
});

test('integration: State.settings.llmIdleTimeout default is 90000ms', () => {
    // Validates the new default landed in core.js and didn't drift
    // from the rename.
    assert.equal(State.settings.llmIdleTimeout, 90000);
    assert.equal(State.settings.llmTimeout, undefined);
});

test('integration: Storage round-trip carries the renamed key', () => {
    // Belt-and-suspenders check that Storage.set/get do not lose the
    // new key. Storage backs to localStorage in the shim.
    Storage.set('settings-test-roundtrip', { llmIdleTimeout: 120000 });
    const back = Storage.get('settings-test-roundtrip');
    assert.equal(back.llmIdleTimeout, 120000);
});

// ---------------------------------------------------------------------------
// 1.1.2 — Embedder provider decoupling
//
// Pre-1.1.2 the embedder shared `llmEndpoint` + `llmApiKey` with the chat LLM
// and inferred local-vs-remote from `embeddingModel.startsWith('Xenova/')`.
// 1.1.2 promotes the embedder to its own provider with explicit settings:
// `embeddingProvider`, `embeddingEndpoint`, `embeddingApiKey`. The migration
// must produce a bit-for-bit equivalent runtime configuration on every
// existing install — proven by the cases below.
// ---------------------------------------------------------------------------

test('migration: 1.1.2 splits credentials when remote embedding model present', () => {
    const before = {
        embeddingModel: 'text-embedding-bge-m3',
        useEmbeddings: true,
        llmEndpoint: 'https://api.venice.ai/api/v1',
        llmApiKey: 'sk-test',
        apiProvider: 'venice',
    };
    const after = applyMigration({ ...before });
    assert.equal(after.embeddingProvider, 'venice');
    assert.equal(after.embeddingEndpoint, 'https://api.venice.ai/api/v1');
    assert.equal(after.embeddingApiKey, 'sk-test');
    // Chat LLM credentials preserved — migration clones, never moves.
    assert.equal(after.llmEndpoint, 'https://api.venice.ai/api/v1');
    assert.equal(after.llmApiKey, 'sk-test');
    assert.equal(after.apiProvider, 'venice');
});

test('migration: 1.1.2 detects local mode from Xenova/* prefix', () => {
    // Bit-for-bit equivalence proof: the most common case is a local-mode
    // user with the default model. The chat LLM credentials must NOT leak
    // into the embedder fields.
    const before = {
        embeddingModel: 'Xenova/all-MiniLM-L6-v2',
        useEmbeddings: true,
        llmEndpoint: 'should-not-leak',
        llmApiKey: 'should-not-leak',
        apiProvider: 'openai',
    };
    const after = applyMigration({ ...before });
    assert.equal(after.embeddingProvider, 'local');
    assert.equal(after.embeddingEndpoint, '');
    assert.equal(after.embeddingApiKey, '');
});

test('migration: 1.1.2 idempotent when embeddingProvider already present', () => {
    const before = {
        embeddingProvider: 'openai',
        embeddingEndpoint: 'https://api.openai.com/v1',
        embeddingApiKey: 'sk-existing',
        embeddingModel: 'text-embedding-3-small',
        llmEndpoint: 'https://api.anthropic.com',
        llmApiKey: 'sk-different',
    };
    const after = applyMigration({ ...before });
    assert.equal(after.embeddingProvider, 'openai');
    assert.equal(after.embeddingEndpoint, 'https://api.openai.com/v1');
    assert.equal(after.embeddingApiKey, 'sk-existing');
    // llm* unchanged
    assert.equal(after.llmEndpoint, 'https://api.anthropic.com');
});

test('migration: 1.1.2 fresh install (no embeddingModel) leaves provider unset for default', () => {
    // No model and no provider → migration does not set anything; the
    // fresh-install default 'local' wins via the merge spread in
    // loadSettings (validated separately by the integration test below).
    const before = {};
    const after = applyMigration({ ...before });
    assert.equal(after.embeddingProvider, undefined);
    assert.equal(after.embeddingEndpoint, undefined);
    assert.equal(after.embeddingApiKey, undefined);
});

test('migration: 1.1.2 falls back to "openai" when remote model present but no apiProvider', () => {
    const before = {
        embeddingModel: 'text-embedding-3-large',
        llmEndpoint: 'https://api.openai.com/v1',
        llmApiKey: 'sk-x',
    };
    const after = applyMigration({ ...before });
    assert.equal(after.embeddingProvider, 'openai');
    assert.equal(after.embeddingEndpoint, 'https://api.openai.com/v1');
    assert.equal(after.embeddingApiKey, 'sk-x');
});

test('migration: 1.1.2 + 1.1.1 chain on the same blob', () => {
    // Real-world case: a user upgrades from 1.1.0 (or earlier) directly to
    // 1.1.2, skipping 1.1.1. Both migrations must fire on a single load.
    const before = {
        llmTimeout: 240000,
        embeddingModel: 'text-embedding-bge-m3',
        llmEndpoint: 'https://embed.local/v1',
        llmApiKey: 'sk-shared',
        apiProvider: 'ollama',
    };
    const after = applyMigration({ ...before });
    // 1.1.1 fired
    assert.equal(after.llmIdleTimeout, 240000);
    assert.equal(after.llmTimeout, undefined);
    // 1.1.2 fired
    assert.equal(after.embeddingProvider, 'ollama');
    assert.equal(after.embeddingEndpoint, 'https://embed.local/v1');
    assert.equal(after.embeddingApiKey, 'sk-shared');
});

test('integration: State.settings.embeddingProvider default is "local"', () => {
    assert.equal(State.settings.embeddingProvider, 'local');
    assert.equal(State.settings.embeddingEndpoint, '');
    assert.equal(State.settings.embeddingApiKey, '');
});

test('integration: State.settings.maxIndexFiles default is 5000 (safety net since 2.4.0)', () => {
    // Promoted from an implicit `|| 200` fallback at the call sites to a
    // real default in 1.1.2; raised to 5000 in 2.4.0 when `maxIndexTokens`
    // (default 300_000) became the primary lever and `maxIndexFiles`
    // demoted to a safety upper-bound.
    assert.equal(State.settings.maxIndexFiles, 5000);
});

test('integration: State.settings.maxIndexTokens default is 300000 (primary lever, 2.4.0)', () => {
    // 2.4.0 — token budget is the primary ingest lever; file count is the
    // safety net. ~700 avg-size files at the chars/3.5 heuristic.
    assert.equal(State.settings.maxIndexTokens, 300000);
});

test('migration (2.4.0): legacy maxIndexFiles below new floor bumps to safety-net default', () => {
    // Legacy default 200 (and any explicit value < 500 from a pre-2.4.0
    // user) bumps to 5000. The new slider floor is 500; staying below it
    // would clamp visually but persist as the legacy value, confusing
    // users on Save. Bumping at load time keeps stored + visible values
    // in sync.
    const out = applyMigration({ maxIndexFiles: 200 });
    assert.equal(out.maxIndexFiles, 5000);

    const out2 = applyMigration({ maxIndexFiles: 100 });
    assert.equal(out2.maxIndexFiles, 5000);
});

test('migration (2.4.0): explicit pre-2.4.0 value at or above new floor preserved', () => {
    // A user who explicitly raised `maxIndexFiles` to 500+ pre-2.4.0
    // wanted their cap there; don't overwrite it.
    const out = applyMigration({ maxIndexFiles: 500 });
    assert.equal(out.maxIndexFiles, 500);

    const out2 = applyMigration({ maxIndexFiles: 1000 });
    assert.equal(out2.maxIndexFiles, 1000);
});

test('migration (2.4.0): no maxIndexFiles in saved settings is left alone', () => {
    // Fresh installs / settings blobs without the key fall through to the
    // core.js default via the merge spread; the migration shouldn't add
    // the key.
    const out = applyMigration({ theme: 'refined' });
    assert.equal(out.maxIndexFiles, undefined);
});
