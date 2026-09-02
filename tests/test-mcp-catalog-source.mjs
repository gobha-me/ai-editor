/**
 * Tests for `js/mcp/catalog-source.js` — the Smithery registry adapter.
 *
 * Pure parsers (`parseSmitheryListResponse`, `parseSmitheryDetailResponse`)
 * are exercised directly. The IO functions (`fetchRemoteList`,
 * `fetchRemoteDetail`) are exercised via injected `fetchImpl` so the
 * tests don't actually hit the network.
 *
 * Key invariants this file gates:
 *   • `remote: false` items in a list response are filtered out (the
 *     `?q=is:remote` query is belt-and-braces; the parser also enforces).
 *   • Unsupported transports can never reach the bridge — every parsed entry
 *     ships `transport === streamable-http`.
 *   • The detail parser tolerates connections without `deploymentUrl`
 *     and returns `null` rather than `{url: ''}` (would silently break
 *     the add-form pre-fill).
 *   • The IO functions never throw on a tester-injected `null` fetchImpl
 *     in surprising ways — they throw a clear error instead.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseSmitheryListResponse,
    parseSmitheryDetailResponse,
    fetchRemoteList,
    fetchRemoteDetail,
    __test_smitheryListItemToCatalogEntry,
    __test_sanitizeId,
} from '../js/mcp/catalog-source.js';

// ============================================
// parseSmitheryListResponse — pure parser
// ============================================

test('parseSmitheryListResponse — happy path with two remote entries', () => {
    const json = {
        servers: [
            {
                qualifiedName: 'exa',
                displayName: 'Exa Search',
                description: 'Fast, intelligent web search.',
                iconUrl: 'https://example.com/exa.svg',
                verified: true,
                useCount: 51944,
                remote: true,
                homepage: 'https://exa.ai',
            },
            {
                qualifiedName: 'gmail',
                displayName: 'Gmail',
                description: 'Manage Gmail end-to-end.',
                verified: true,
                useCount: 28221,
                remote: true,
                homepage: 'https://smithery.ai/servers/gmail',
            },
        ],
    };
    const out = parseSmitheryListResponse(json);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'exa');
    assert.equal(out[0].name, 'Exa Search');
    assert.equal(out[0].source, 'remote');
    assert.equal(out[0].qualifiedName, 'exa');
    assert.equal(out[0].useCount, 51944);
    assert.equal(out[0].verified, true);
    assert.equal(out[1].id, 'gmail');
});

test('parseSmitheryListResponse — filters out remote: false entries', () => {
    const json = {
        servers: [
            { qualifiedName: 'remote-one', displayName: 'Remote One', remote: true },
            { qualifiedName: 'stdio-one', displayName: 'Stdio One', remote: false },
            { qualifiedName: 'no-remote-flag', displayName: 'Missing Remote' }, // remote field absent
        ],
    };
    const out = parseSmitheryListResponse(json);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'remote-one');
});

test('parseSmitheryListResponse — every emitted entry has a supported transport', () => {
    const json = {
        servers: [
            { qualifiedName: 'a', displayName: 'A', remote: true },
            { qualifiedName: 'b', displayName: 'B', remote: true },
        ],
    };
    const out = parseSmitheryListResponse(json);
    for (const e of out) {
        assert.equal(e.transport, 'streamable-http', `${e.id}: invalid transport "${e.transport}"`);
    }
});

test('parseSmitheryListResponse — list URL is empty (deferred to detail fetch)', () => {
    const json = { servers: [{ qualifiedName: 'a', displayName: 'A', remote: true }] };
    const out = parseSmitheryListResponse(json);
    assert.equal(out[0].url, '');
});

test('parseSmitheryListResponse — falls back to qualifiedName when displayName is empty', () => {
    const json = { servers: [{ qualifiedName: 'no-display', displayName: '', remote: true }] };
    const out = parseSmitheryListResponse(json);
    assert.equal(out[0].name, 'no-display');
});

test('parseSmitheryListResponse — synthesizes a docsUrl when homepage is missing', () => {
    const json = { servers: [{ qualifiedName: 'no-home', displayName: 'NH', remote: true }] };
    const out = parseSmitheryListResponse(json);
    assert.ok(out[0].docsUrl.startsWith('https://smithery.ai/server/'));
    assert.ok(out[0].docsUrl.includes('no-home'));
});

test('parseSmitheryListResponse — defensive on null / non-object / missing servers', () => {
    assert.deepEqual(parseSmitheryListResponse(null), []);
    assert.deepEqual(parseSmitheryListResponse(undefined), []);
    assert.deepEqual(parseSmitheryListResponse('not json'), []);
    assert.deepEqual(parseSmitheryListResponse(42), []);
    assert.deepEqual(parseSmitheryListResponse({}), []);
    assert.deepEqual(parseSmitheryListResponse({ servers: 'not-array' }), []);
});

test('parseSmitheryListResponse — skips entries without qualifiedName', () => {
    const json = {
        servers: [
            { qualifiedName: '', displayName: 'Empty', remote: true },
            { displayName: 'No QN', remote: true },
            null,
            'not-an-object',
            { qualifiedName: 'good', displayName: 'Good', remote: true },
        ],
    };
    const out = parseSmitheryListResponse(json);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'good');
});

test('parseSmitheryListResponse — useCount defaults to 0 when missing or non-finite', () => {
    const json = {
        servers: [
            { qualifiedName: 'a', displayName: 'A', remote: true },
            { qualifiedName: 'b', displayName: 'B', remote: true, useCount: NaN },
            { qualifiedName: 'c', displayName: 'C', remote: true, useCount: 'not-a-number' },
        ],
    };
    const out = parseSmitheryListResponse(json);
    assert.equal(out[0].useCount, 0);
    assert.equal(out[1].useCount, 0);
    assert.equal(out[2].useCount, 0);
});

// ============================================
// parseSmitheryDetailResponse — pure parser
// ============================================

test('parseSmitheryDetailResponse — picks the http connection', () => {
    const json = {
        connections: [
            { type: 'http', deploymentUrl: 'https://exa.run.tools', configSchema: {} },
        ],
    };
    const out = parseSmitheryDetailResponse(json);
    assert.deepEqual(out, { url: 'https://exa.run.tools', transport: 'streamable-http' });
});

test('parseSmitheryDetailResponse — rejects an SSE-only connection', () => {
    const json = {
        connections: [{ type: 'sse', deploymentUrl: 'https://example.com/sse' }],
    };
    const out = parseSmitheryDetailResponse(json);
    assert.equal(out, null);
});

test('parseSmitheryDetailResponse — recognizes streamable-http as alias for http', () => {
    const json = {
        connections: [{ type: 'streamable-http', deploymentUrl: 'https://example.com/mcp' }],
    };
    const out = parseSmitheryDetailResponse(json);
    assert.equal(out.transport, 'streamable-http');
});

test('parseSmitheryDetailResponse — skips empty URLs and unsupported SSE', () => {
    const json = {
        connections: [
            { type: 'http', deploymentUrl: '' },
            { type: 'http' }, // missing
            { type: 'sse', deploymentUrl: 'https://fallback/sse' },
        ],
    };
    const out = parseSmitheryDetailResponse(json);
    assert.equal(out, null);
});

test('parseSmitheryDetailResponse — skips SSE and selects a later Streamable HTTP connection', () => {
    const json = {
        connections: [
            { type: 'sse', deploymentUrl: 'https://legacy.example/sse' },
            { type: 'streamable-http', deploymentUrl: 'https://current.example/mcp' },
        ],
    };
    assert.deepEqual(parseSmitheryDetailResponse(json), {
        url: 'https://current.example/mcp',
        transport: 'streamable-http',
    });
});

test('parseSmitheryDetailResponse — skips unknown transport types', () => {
    const json = {
        connections: [
            { type: 'stdio', deploymentUrl: 'https://nope' },
            { type: 'websocket', deploymentUrl: 'wss://nope' },
        ],
    };
    assert.equal(parseSmitheryDetailResponse(json), null);
});

test('parseSmitheryDetailResponse — null on empty/missing connections', () => {
    assert.equal(parseSmitheryDetailResponse(null), null);
    assert.equal(parseSmitheryDetailResponse({}), null);
    assert.equal(parseSmitheryDetailResponse({ connections: [] }), null);
    assert.equal(parseSmitheryDetailResponse({ connections: 'not-array' }), null);
});

// ============================================
// fetchRemoteList — IO with injected fetch
// ============================================

function mockFetch(payload, { status = 200 } = {}) {
    return async () => ({
        ok: status >= 200 && status < 300,
        status,
        async json() { return payload; },
    });
}

test('fetchRemoteList — sorts by useCount desc and caps at maxEntries', async () => {
    const payload = {
        servers: [
            { qualifiedName: 'low', displayName: 'Low', remote: true, useCount: 10 },
            { qualifiedName: 'high', displayName: 'High', remote: true, useCount: 1000 },
            { qualifiedName: 'mid', displayName: 'Mid', remote: true, useCount: 100 },
        ],
    };
    const out = await fetchRemoteList({ fetchImpl: mockFetch(payload), maxEntries: 2 });
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'high');
    assert.equal(out[1].id, 'mid');
});

test('fetchRemoteList — throws on non-2xx', async () => {
    await assert.rejects(
        () => fetchRemoteList({ fetchImpl: mockFetch({}, { status: 503 }) }),
        /smithery list 503/,
    );
});

test('fetchRemoteList — throws clearly when fetchImpl is missing', async () => {
    await assert.rejects(
        () => fetchRemoteList({ fetchImpl: null }),
        /fetch unavailable/,
    );
});

test('fetchRemoteList — issues the is:remote query parameter', async () => {
    let observedUrl = '';
    const fetchImpl = async (url) => {
        observedUrl = url;
        return { ok: true, status: 200, async json() { return { servers: [] }; } };
    };
    await fetchRemoteList({ fetchImpl });
    assert.ok(observedUrl.includes('q=is%3Aremote'), `expected is:remote query, got ${observedUrl}`);
});

// ============================================
// fetchRemoteDetail — IO with injected fetch
// ============================================

test('fetchRemoteDetail — happy path returns url + transport', async () => {
    const payload = { connections: [{ type: 'http', deploymentUrl: 'https://exa.run.tools' }] };
    const out = await fetchRemoteDetail('exa', { fetchImpl: mockFetch(payload) });
    assert.deepEqual(out, { url: 'https://exa.run.tools', transport: 'streamable-http' });
});

test('fetchRemoteDetail — encodes qualifiedName into the URL path', async () => {
    let observedUrl = '';
    const fetchImpl = async (url) => {
        observedUrl = url;
        return { ok: true, status: 200, async json() { return { connections: [] }; } };
    };
    await fetchRemoteDetail('@scope/name with spaces', { fetchImpl });
    assert.ok(observedUrl.endsWith('/' + encodeURIComponent('@scope/name with spaces')));
});

test('fetchRemoteDetail — rejects empty / non-string qualifiedName', async () => {
    await assert.rejects(() => fetchRemoteDetail(''), /qualifiedName required/);
    await assert.rejects(() => fetchRemoteDetail('   '), /qualifiedName required/);
    await assert.rejects(() => fetchRemoteDetail(null), /qualifiedName required/);
});

test('fetchRemoteDetail — throws on non-2xx', async () => {
    await assert.rejects(
        () => fetchRemoteDetail('exa', { fetchImpl: mockFetch({}, { status: 404 }) }),
        /smithery detail 404/,
    );
});

// ============================================
// Internal helpers (test seams)
// ============================================

test('sanitizeId — slashes become dashes; lowercase', () => {
    assert.equal(__test_sanitizeId('@scope/name'), 'scope-name');
    assert.equal(__test_sanitizeId('UPPER'), 'upper');
    assert.equal(__test_sanitizeId('a__b//c'), 'a-b-c');
    assert.equal(__test_sanitizeId('-leading-and-trailing-'), 'leading-and-trailing');
    assert.equal(__test_sanitizeId(''), '');
});

test('smitheryListItemToCatalogEntry — returns null for non-remote items', () => {
    assert.equal(__test_smitheryListItemToCatalogEntry({ qualifiedName: 'a', remote: false }), null);
    assert.equal(__test_smitheryListItemToCatalogEntry({ qualifiedName: 'a' }), null);
});
