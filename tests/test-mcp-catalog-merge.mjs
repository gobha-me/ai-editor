/**
 * Tests for `js/mcp/catalog-merge.js` — pure bundled+remote merge.
 *
 * The bundled-wins-on-collision rule is load-bearing: bundled entries
 * carry curated `tokenHint` / `authNote` strings that took real research
 * to write. A drive-by remote entry with the same id (or human name)
 * shouldn't be allowed to overwrite them.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeCatalogs, __test_isUsableEntry } from '../js/mcp/catalog-merge.js';
import { MCP_CATALOG } from '../js/mcp/catalog.js';

const BUNDLED_LINEAR = {
    id: 'linear',
    name: 'Linear',
    description: 'Curated description.',
    category: 'productivity',
    url: 'https://mcp.linear.app/sse',
    transport: 'sse',
    requiresToken: true,
    tokenHint: 'CURATED hint with real research',
    authNote: 'OAuth caveat we wrote by hand',
    docsUrl: 'https://linear.app/docs/mcp',
};

const REMOTE_LINEAR_BY_ID = {
    id: 'linear',
    name: 'Linear (Remote)',
    description: 'Smithery-fetched description.',
    category: 'integration',
    url: '',
    transport: 'streamable-http',
    requiresToken: true,
    docsUrl: 'https://smithery.ai/server/linear',
    source: 'remote',
    qualifiedName: 'linear',
};

const REMOTE_LINEAR_BY_NAME = {
    id: 'linear-other-slug',
    name: 'linear', // case-insensitive collision against bundled `Linear`
    description: 'Different slug, same name.',
    category: 'integration',
    url: '',
    transport: 'streamable-http',
    requiresToken: true,
    docsUrl: '',
    source: 'remote',
    qualifiedName: 'linear-other-slug',
};

const REMOTE_NEW_ENTRY = {
    id: 'tavily',
    name: 'Tavily',
    description: 'A new server not in bundled.',
    category: 'integration',
    url: '',
    transport: 'streamable-http',
    requiresToken: true,
    docsUrl: 'https://smithery.ai/server/tavily',
    source: 'remote',
    qualifiedName: 'tavily',
};

// ============================================
// Bundled wins
// ============================================

test('bundled `linear` wins on id collision; curated tokenHint preserved', () => {
    const out = mergeCatalogs([BUNDLED_LINEAR], [REMOTE_LINEAR_BY_ID]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'linear');
    assert.equal(out[0].tokenHint, 'CURATED hint with real research');
    assert.equal(out[0].authNote, 'OAuth caveat we wrote by hand');
    assert.equal(out[0].source, 'bundled');
});

test('bundled wins on case-insensitive name collision (different id)', () => {
    const out = mergeCatalogs([BUNDLED_LINEAR], [REMOTE_LINEAR_BY_NAME]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'linear');
    assert.equal(out[0].name, 'Linear');
});

test('bundled and non-overlapping remote both pass through; bundled comes first', () => {
    const out = mergeCatalogs([BUNDLED_LINEAR], [REMOTE_NEW_ENTRY]);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'linear');
    assert.equal(out[1].id, 'tavily');
    assert.equal(out[0].source, 'bundled');
    assert.equal(out[1].source, 'remote');
});

test('preserves the order bundled was passed in', () => {
    const a = { id: 'a', name: 'A' };
    const b = { id: 'b', name: 'B' };
    const c = { id: 'c', name: 'C' };
    const out = mergeCatalogs([a, b, c], []);
    assert.deepEqual(out.map(e => e.id), ['a', 'b', 'c']);
});

test('preserves the order remote was passed in (after the bundled section)', () => {
    const r1 = { id: 'r1', name: 'R1', source: 'remote' };
    const r2 = { id: 'r2', name: 'R2', source: 'remote' };
    const out = mergeCatalogs([], [r1, r2]);
    assert.deepEqual(out.map(e => e.id), ['r1', 'r2']);
});

// ============================================
// Defensive shape checks
// ============================================

test('empty inputs return frozen empty array', () => {
    const out = mergeCatalogs([], []);
    assert.equal(out.length, 0);
    assert.ok(Object.isFrozen(out));
});

test('non-array inputs are tolerated', () => {
    assert.equal(mergeCatalogs(null, null).length, 0);
    assert.equal(mergeCatalogs(undefined, undefined).length, 0);
    assert.equal(mergeCatalogs('not array', 'not array').length, 0);
    assert.equal(mergeCatalogs(42, 42).length, 0);
});

test('result is frozen', () => {
    const out = mergeCatalogs([BUNDLED_LINEAR], [REMOTE_NEW_ENTRY]);
    assert.ok(Object.isFrozen(out));
});

test('drops malformed entries (missing id or name)', () => {
    const malformed = [
        null,
        'not-an-object',
        {},
        { id: 'no-name' },
        { name: 'no-id' },
        { id: '', name: 'empty-id' },
        { id: 'good', name: 'Good' },
    ];
    const out = mergeCatalogs(malformed, []);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'good');
});

test('source: "bundled" is set when entry omits the field', () => {
    const out = mergeCatalogs([{ id: 'x', name: 'X' }], []);
    assert.equal(out[0].source, 'bundled');
});

test('source: "remote" is set on remote entries when the field is missing', () => {
    const out = mergeCatalogs([], [{ id: 'r', name: 'R' }]);
    assert.equal(out[0].source, 'remote');
});

test('preserves an explicit source field if already set on bundled', () => {
    const out = mergeCatalogs([{ id: 'x', name: 'X', source: 'curated-special' }], []);
    assert.equal(out[0].source, 'curated-special');
});

// ============================================
// Round-trip with the real bundled catalog
// ============================================

test('round-trip with real MCP_CATALOG and a couple of fake remote entries', () => {
    const remote = [
        REMOTE_LINEAR_BY_ID,
        REMOTE_LINEAR_BY_NAME,
        REMOTE_NEW_ENTRY,
        { id: 'duplicate-of-deepwiki', name: 'DeepWiki', source: 'remote' }, // soft collision
    ];
    const out = mergeCatalogs(MCP_CATALOG, remote);
    const ids = out.map(e => e.id);

    // All bundled entries present.
    for (const b of MCP_CATALOG) {
        assert.ok(ids.includes(b.id), `bundled ${b.id} missing from merged`);
    }

    // Bundled comes first.
    for (let i = 0; i < MCP_CATALOG.length; i++) {
        assert.equal(out[i].id, MCP_CATALOG[i].id, `bundled order broken at index ${i}`);
    }

    // The remote-tavily landed.
    assert.ok(ids.includes('tavily'));

    // The id-collision and name-collision remote-linears were dropped.
    const linearCount = out.filter(e => e.id === 'linear').length;
    assert.equal(linearCount, 1);
    assert.equal(ids.filter(id => id === 'linear-other-slug').length, 0);

    // The DeepWiki name-collision was dropped.
    assert.equal(ids.filter(id => id === 'duplicate-of-deepwiki').length, 0);
});

// ============================================
// Internal helper
// ============================================

test('isUsableEntry — gates on id + name', () => {
    assert.equal(__test_isUsableEntry({ id: 'a', name: 'A' }), true);
    assert.equal(__test_isUsableEntry({ id: 'a' }), false);
    assert.equal(__test_isUsableEntry({ name: 'A' }), false);
    assert.equal(__test_isUsableEntry(null), false);
    assert.equal(__test_isUsableEntry(undefined), false);
    assert.equal(__test_isUsableEntry({}), false);
    assert.equal(__test_isUsableEntry({ id: 1, name: 'A' }), false);
    assert.equal(__test_isUsableEntry({ id: 'a', name: '' }), false);
});
