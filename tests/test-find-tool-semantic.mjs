/**
 * Tests for semantic `find_tool` + lazy-expansion plumbing (1.4.1).
 *
 * Covers:
 *   - `findToolsBySemantic` over a stub embedder: ranking, threshold gate,
 *     disabled / unavailable fallbacks, cache hits, cache invalidation.
 *   - `find_tool` handler integration: semantic→categorical fallback,
 *     `mode` field on the response, note copy, K cap.
 *   - `recordDiscoveryAdmissions` cap, dedup, and short-form persistence.
 *
 * Runs under `node --test`. Embedder + EventBus are stubbed; the real
 * `js/embeddings-client.js` is replaced via `_setEmbedderForTests`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog } from '../js/intelligence/tools/catalog.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { registerMetaTools } from '../js/tools/meta-tools.js';
import {
    findToolsBySemantic,
    DEFAULT_THRESHOLD,
    DEFAULT_TOP_K,
    DISCOVERY_ADMISSION_CAP,
    _testing as embeddingsTesting,
} from '../js/intelligence/tools/embeddings.js';
import {
    recordDiscoveryAdmissions,
    recordInvocation,
    getLedger,
    _resetForTests as resetTaskState,
} from '../js/chat/task-state.js';
import { EventBus } from '../js/core.js';

/* -------------------------------------------------------------------------- */
/* Test fixtures                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a stub embedder where each text gets a deterministic vector. The
 * caller passes a `vectors` map keyed by exact text; missing texts fall
 * back to a zero vector (which yields cosine = 0, dropped by threshold).
 */
function makeStubEmbedder({ vectors, enabled = true, throwOnQuery = null } = {}) {
    const embedCalls = [];
    return {
        embedCalls,
        isEnabled: () => enabled,
        embed: async (text) => {
            embedCalls.push(text);
            if (throwOnQuery && text === throwOnQuery) {
                throw new Error('embed boom');
            }
            return vectors[text] || null;
        },
        cosineSimilarity: (a, b) => {
            if (!a || !b || a.length !== b.length) return 0;
            let dot = 0, magA = 0, magB = 0;
            for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                magA += a[i] * a[i];
                magB += b[i] * b[i];
            }
            if (magA === 0 || magB === 0) return 0;
            return dot / (Math.sqrt(magA) * Math.sqrt(magB));
        },
    };
}

function registerFixture() {
    ToolRegistry.clear();
    registerMetaTools(ToolRegistry);
    const reg = (name, description, parameters = { type: 'object', properties: {} }, roles = 'all') =>
        ToolRegistry.register(name, async () => ({}), {
            function: { name, description, parameters }, roles,
        });
    reg('read_file',          'Read the full content of a file.', { type: 'object', properties: { path: { type: 'string' } } });
    reg('create_pull_request', 'Open a pull request from the current branch.',
        { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } }, ['coder']);
    reg('list_pull_requests', 'List open pull requests.', { type: 'object', properties: {} });
    reg('commit_files',       'Commit staged files to the branch.',
        { type: 'object', properties: { message: { type: 'string' } } }, ['coder']);
}

function setupEmbedder(stub) {
    embeddingsTesting._clearCacheForTests();
    embeddingsTesting._setEmbedderForTests(stub);
}

/* -------------------------------------------------------------------------- */
/* findToolsBySemantic — rank/threshold/cache                                 */
/* -------------------------------------------------------------------------- */

test('findToolsBySemantic ranks by cosine and respects threshold', async () => {
    registerFixture();
    const all = Catalog.listAll();
    const prText = `create_pull_request Open a pull request from the current branch. ${all.find(t => t.name === 'create_pull_request').category}`;
    const readText = `read_file Read the full content of a file. ${all.find(t => t.name === 'read_file').category}`;
    const stub = makeStubEmbedder({
        vectors: {
            'open a PR': [1, 0],
            [prText]: [0.95, 0.05],
            [readText]: [0.05, 0.95],
        },
    });
    setupEmbedder(stub);

    const { ranked, mode } = await findToolsBySemantic('open a PR', all, { threshold: 0.4, topK: 8 });
    assert.equal(mode, 'semantic');
    assert.ok(ranked.length >= 1);
    assert.equal(ranked[0].td.name, 'create_pull_request');
    // read_file is below threshold → excluded.
    assert.ok(!ranked.some(r => r.td.name === 'read_file'), 'read_file is below threshold');
});

test('findToolsBySemantic returns mode:"disabled" when embedder is disabled', async () => {
    registerFixture();
    setupEmbedder(makeStubEmbedder({ vectors: {}, enabled: false }));

    const { ranked, mode } = await findToolsBySemantic('anything', Catalog.listAll());
    assert.equal(mode, 'disabled');
    assert.deepEqual(ranked, []);
});

test('findToolsBySemantic returns mode:"unavailable" when query embed throws', async () => {
    registerFixture();
    setupEmbedder(makeStubEmbedder({ vectors: {}, throwOnQuery: 'q' }));

    const { ranked, mode } = await findToolsBySemantic('q', Catalog.listAll());
    assert.equal(mode, 'unavailable');
    assert.deepEqual(ranked, []);
});

test('findToolsBySemantic threshold gate drops weak matches', async () => {
    registerFixture();
    const all = Catalog.listAll();
    // All cosines well below 0.4.
    const stub = makeStubEmbedder({
        vectors: Object.fromEntries(
            ['anything'].concat(all.map(t => `${t.name} ${t.description || ''} ${t.category || ''}`.trim()))
                .map((text, i) => [text, [Math.cos(i * 1.7), Math.sin(i * 1.7)]])
        ),
    });
    setupEmbedder(stub);

    const { ranked, mode } = await findToolsBySemantic('anything', all, { threshold: 0.99 });
    assert.equal(mode, 'semantic', 'mode is semantic even when no results pass threshold');
    assert.deepEqual(ranked, []);
});

test('findToolsBySemantic caches tool embeddings across calls', async () => {
    registerFixture();
    const all = Catalog.listAll();
    const queries = ['first', 'second'];
    const vecMap = { first: [1, 0], second: [1, 0] };
    for (const td of all) {
        const text = `${td.name} ${td.description || ''} ${td.category || ''}`.trim();
        vecMap[text] = [1, 0];
    }
    const stub = makeStubEmbedder({ vectors: vecMap });
    setupEmbedder(stub);

    await findToolsBySemantic(queries[0], all, { threshold: 0.5 });
    const afterFirst = stub.embedCalls.length;
    // First call: 1 query embed + N tool embeds.
    assert.equal(afterFirst, 1 + all.length);

    await findToolsBySemantic(queries[1], all, { threshold: 0.5 });
    // Second call: just 1 query embed; tools come from cache.
    assert.equal(stub.embedCalls.length, afterFirst + 1);
});

test('findToolsBySemantic invalidates the cache on embeddings:cacheCleared', async () => {
    registerFixture();
    const all = Catalog.listAll();
    const vecMap = { q: [1, 0] };
    for (const td of all) {
        vecMap[`${td.name} ${td.description || ''} ${td.category || ''}`.trim()] = [1, 0];
    }
    const stub = makeStubEmbedder({ vectors: vecMap });
    setupEmbedder(stub);

    await findToolsBySemantic('q', all, { threshold: 0.5 });
    const afterFirst = stub.embedCalls.length;

    EventBus.emit('embeddings:cacheCleared');
    assert.equal(embeddingsTesting._getCacheSize(), 0, 'cache should be cleared');

    await findToolsBySemantic('q', all, { threshold: 0.5 });
    // Re-embeds query + every tool again.
    assert.equal(stub.embedCalls.length, afterFirst + 1 + all.length);
});

/* -------------------------------------------------------------------------- */
/* find_tool handler — semantic→categorical fallback + response shape         */
/* -------------------------------------------------------------------------- */

test('find_tool response carries mode:"categorical" when embeddings disabled', async () => {
    registerFixture();
    setupEmbedder(makeStubEmbedder({ vectors: {}, enabled: false }));

    const result = await ToolRegistry.execute('find_tool', { description: 'read' });
    assert.equal(result.mode, 'categorical');
    assert.match(result.note, /disabled/);
    // Categorical scoring still works — read_file should rank.
    const top = result.tools.map(t => t.name);
    assert.ok(top.includes('read_file'));
});

test('find_tool response carries mode:"semantic" when k-NN ranks above threshold', async () => {
    registerFixture();
    const all = Catalog.listAll();
    const prText = `create_pull_request Open a pull request from the current branch. ${all.find(t => t.name === 'create_pull_request').category}`;
    const stub = makeStubEmbedder({
        vectors: {
            'open a PR': [1, 0],
            [prText]: [0.95, 0.05],
        },
    });
    setupEmbedder(stub);

    const result = await ToolRegistry.execute('find_tool', { description: 'open a PR' });
    assert.equal(result.mode, 'semantic');
    assert.equal(result.tools[0].name, 'create_pull_request');
});

test('find_tool response carries mode:"categorical" when semantic returns 0 above threshold', async () => {
    registerFixture();
    const all = Catalog.listAll();
    // Stub returns vectors that yield cosine near 0 for every tool vs "read".
    const vecMap = { read: [1, 0] };
    for (const td of all) {
        vecMap[`${td.name} ${td.description || ''} ${td.category || ''}`.trim()] = [0, 1];
    }
    setupEmbedder(makeStubEmbedder({ vectors: vecMap }));

    const result = await ToolRegistry.execute('find_tool', { description: 'read' });
    assert.equal(result.mode, 'categorical', 'fell through after no above-threshold semantic hits');
    assert.match(result.note, /no semantic matches/);
});

test('find_tool returns {error} on empty description', async () => {
    registerFixture();
    setupEmbedder(makeStubEmbedder({ vectors: {} }));

    const result = await ToolRegistry.execute('find_tool', { description: '' });
    assert.ok(result.error);
});

test('find_tool caps results at K=DEFAULT_TOP_K under categorical fallback', async () => {
    ToolRegistry.clear();
    registerMetaTools(ToolRegistry);
    setupEmbedder(makeStubEmbedder({ vectors: {}, enabled: false }));
    for (let i = 0; i < 12; i++) {
        ToolRegistry.register(`doit_${i}`, async () => ({}), {
            function: { name: `doit_${i}`, description: 'does it', parameters: { type: 'object', properties: {} } },
            roles: 'all',
        });
    }
    const result = await ToolRegistry.execute('find_tool', { description: 'doit' });
    assert.equal(result.tools.length, DEFAULT_TOP_K);
});

/* -------------------------------------------------------------------------- */
/* recordDiscoveryAdmissions — cap + dedup + short-form persistence           */
/* -------------------------------------------------------------------------- */

test('recordDiscoveryAdmissions writes short-form admissions up to the cap', () => {
    resetTaskState();
    const candidates = [
        { toolName: 'a', shortCost: 50 },
        { toolName: 'b', shortCost: 50 },
        { toolName: 'c', shortCost: 50 },
        { toolName: 'd', shortCost: 50 },
        { toolName: 'e', shortCost: 50 },
    ];
    const r = recordDiscoveryAdmissions({
        conversationId: 'conv-A',
        surface: 'coder.v1',
        candidates,
        cap: DISCOVERY_ADMISSION_CAP,
        now: 1700000000000,
    });
    assert.deepEqual(r.added, ['a', 'b', 'c']);
    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_admissions.length, 3);
    for (const adm of ledger.tool_admissions) {
        assert.equal(adm.form, 'short');
        assert.equal(adm.source, 'discovery');
        assert.equal(adm.cost, 50);
    }
});

test('recordDiscoveryAdmissions dedupes against existing admissions', () => {
    resetTaskState();
    recordDiscoveryAdmissions({
        conversationId: 'conv-A', surface: 'coder.v1',
        candidates: [{ toolName: 'a', shortCost: 50 }],
        cap: 3, now: 1700000000000,
    });
    const r = recordDiscoveryAdmissions({
        conversationId: 'conv-A', surface: 'coder.v1',
        candidates: [
            { toolName: 'a', shortCost: 50 },     // dup
            { toolName: 'b', shortCost: 50 },
            { toolName: 'c', shortCost: 50 },
        ],
        cap: 3, now: 1700000000900,
    });
    assert.deepEqual(r.added, ['b', 'c']);
    assert.deepEqual(r.skipped, ['a']);
    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_admissions.length, 3, 'cap of 3 still respected across calls');
});

test('recordDiscoveryAdmissions returns {added: [], skipped: []} for empty candidates', () => {
    resetTaskState();
    const r = recordDiscoveryAdmissions({
        conversationId: 'conv-A', surface: 'coder.v1',
        candidates: [], cap: 3,
    });
    assert.deepEqual(r, { added: [], skipped: [] });
});

test('recordDiscoveryAdmissions no-ops when conversationId is null', () => {
    resetTaskState();
    const r = recordDiscoveryAdmissions({
        conversationId: null, surface: 'coder.v1',
        candidates: [{ toolName: 'a', shortCost: 50 }], cap: 3,
    });
    assert.deepEqual(r, { added: [], skipped: [] });
});

/* -------------------------------------------------------------------------- */
/* Lazy-expansion lifecycle — short → full promotion                          */
/* -------------------------------------------------------------------------- */

test('recordInvocation promotes short→full on first successful call', () => {
    resetTaskState();
    recordDiscoveryAdmissions({
        conversationId: 'conv-A', surface: 'coder.v1',
        candidates: [{ toolName: 'create_pull_request', shortCost: 60 }],
        cap: 3, now: 1700000000000,
    });

    const r = recordInvocation({
        conversationId: 'conv-A',
        toolName: 'create_pull_request',
        args: { title: 't' },
        toolResult: { ok: true },
        turnId: 'call_1',
        surface: 'coder.v1',
        staticNames: [],
        toolCost: 350,
        now: 1700000001000,
    });
    // Promotion path → existing entry; admitted=false (no new record added).
    assert.equal(r.recorded, true);
    assert.equal(r.admitted, false);

    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_admissions.length, 1, 'no duplicate row');
    const adm = ledger.tool_admissions[0];
    assert.equal(adm.form, 'full', 'promoted to full');
    assert.equal(adm.cost, 350, 'cost upgraded to full estimate');
    assert.equal(adm.last_used_at, 1700000001000);
});

test('recordInvocation against existing form:"full" admission is a pure last_used_at bump', () => {
    resetTaskState();
    recordInvocation({
        conversationId: 'conv-A', toolName: 'find_xrefs',
        args: {}, toolResult: { ok: true }, turnId: 't1',
        surface: 'coder.v1', staticNames: [], toolCost: 200,
        now: 1700000000000,
    });
    recordInvocation({
        conversationId: 'conv-A', toolName: 'find_xrefs',
        args: {}, toolResult: { ok: true }, turnId: 't2',
        surface: 'coder.v1', staticNames: [], toolCost: 999,    // would be wrong to overwrite
        now: 1700000000900,
    });
    const ledger = getLedger('conv-A');
    assert.equal(ledger.tool_admissions.length, 1);
    const adm = ledger.tool_admissions[0];
    assert.equal(adm.form, 'full');
    assert.equal(adm.cost, 200, 'cost on full entries is preserved, not overwritten');
    assert.equal(adm.last_used_at, 1700000000900);
});

/* -------------------------------------------------------------------------- */
/* Threshold default sanity                                                   */
/* -------------------------------------------------------------------------- */

test('DEFAULT_THRESHOLD is 0.4 (the sized-for-MiniLM/bge-small default)', () => {
    assert.equal(DEFAULT_THRESHOLD, 0.4);
});

test('DISCOVERY_ADMISSION_CAP is 3 (per ROADMAP §1.4.1)', () => {
    assert.equal(DISCOVERY_ADMISSION_CAP, 3);
});

/* -------------------------------------------------------------------------- */
/* 1.4.8 — settings-driven tuning knobs                                       */
/* -------------------------------------------------------------------------- */
//
// `_readThreshold` (private to embeddings.js) is invoked when the caller
// omits `opts.threshold` on `findToolsBySemantic`. Settings precedence:
// nested `State.settings.tools.findToolThreshold` > legacy flat
// `State.settings.findToolThreshold` > `DEFAULT_THRESHOLD` (0.4). Each
// test stages two vectors — a 1.0 cosine match and a 0.5 cosine match
// (≈1/√2 vector pair). At threshold 0.95 only the 1.0 match seats; at
// 0.4 both seat.

function _vectorsForTwoSeats(query, all, primaryName) {
    const vecMap = { [query]: [1, 0] };
    for (const td of all) {
        const text = `${td.name} ${td.description || ''} ${td.category || ''}`.trim();
        if (td.name === primaryName) {
            vecMap[text] = [1, 0];                  // cosine 1.0
        } else if (td.name === 'list_pull_requests') {
            vecMap[text] = [1 / Math.sqrt(2), 1 / Math.sqrt(2)];  // cosine ≈0.707
        } else {
            vecMap[text] = [0, 1];                  // cosine 0.0
        }
    }
    return vecMap;
}

test('1.4.8: State.settings.tools.findToolThreshold overrides the default', async () => {
    registerFixture();
    const all = Catalog.listAll();
    setupEmbedder(makeStubEmbedder({
        vectors: _vectorsForTwoSeats('open a pr', all, 'create_pull_request'),
    }));
    const { State } = await import('../js/core.js');
    const prev = State.settings;
    State.settings = { ...(prev || {}), tools: { findToolThreshold: 0.95 } };
    try {
        const result = await findToolsBySemantic('open a pr', all);
        assert.equal(result.mode, 'semantic');
        assert.equal(result.ranked.length, 1);
        assert.equal(result.ranked[0].td.name, 'create_pull_request');
    } finally {
        State.settings = prev;
    }
});

test('1.4.8: legacy flat State.settings.findToolThreshold still honored when nested absent', async () => {
    registerFixture();
    const all = Catalog.listAll();
    setupEmbedder(makeStubEmbedder({
        vectors: _vectorsForTwoSeats('open a pr', all, 'create_pull_request'),
    }));
    const { State } = await import('../js/core.js');
    const prev = State.settings;
    State.settings = { ...(prev || {}), findToolThreshold: 0.95 };
    try {
        const result = await findToolsBySemantic('open a pr', all);
        assert.equal(result.mode, 'semantic');
        assert.equal(result.ranked.length, 1);
        assert.equal(result.ranked[0].td.name, 'create_pull_request');
    } finally {
        State.settings = prev;
    }
});

test('1.4.8: nested findToolThreshold beats legacy flat key when both present', async () => {
    registerFixture();
    const all = Catalog.listAll();
    setupEmbedder(makeStubEmbedder({
        vectors: _vectorsForTwoSeats('open a pr', all, 'create_pull_request'),
    }));
    const { State } = await import('../js/core.js');
    const prev = State.settings;
    // Flat key would gate at 0.95 (only 1.0 seats); nested at 0.4 (1.0
    // + 0.707 seat). Nested must win → ≥2 candidates surface.
    State.settings = {
        ...(prev || {}),
        findToolThreshold: 0.95,
        tools: { findToolThreshold: 0.4 },
    };
    try {
        const result = await findToolsBySemantic('open a pr', all);
        assert.equal(result.mode, 'semantic');
        assert.ok(result.ranked.length >= 2,
            `nested threshold (0.4) should admit ≥2 candidates; got ${result.ranked.length}`);
    } finally {
        State.settings = prev;
    }
});
