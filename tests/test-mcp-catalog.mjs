/**
 * Tests for `js/mcp/catalog.js` — curated MCP server catalog data validation.
 *
 * Catalog data ships in source and renders directly in the Settings tab — bad
 * entries break the picker. These tests are the gate that keeps a 9th entry
 * from landing with a typo in `transport`, a duplicated id, or a malformed URL.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MCP_CATALOG, getCategories, categoryIcon } from '../js/mcp/catalog.js';

const VALID_TRANSPORTS = new Set(['streamable-http', 'sse']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

test('catalog has at least 6 entries (lower-bound surface check)', () => {
    assert.ok(MCP_CATALOG.length >= 6, `expected >= 6 entries, got ${MCP_CATALOG.length}`);
});

test('catalog is frozen (no in-place mutation by callers)', () => {
    assert.ok(Object.isFrozen(MCP_CATALOG), 'MCP_CATALOG should be Object.freeze()d');
});

test('every entry has required string fields', () => {
    const required = ['id', 'name', 'description', 'category', 'url', 'transport', 'docsUrl'];
    for (const e of MCP_CATALOG) {
        for (const k of required) {
            assert.equal(typeof e[k], 'string', `${e.id || '?'}: missing/non-string field "${k}"`);
            assert.ok(e[k].length > 0, `${e.id || '?'}: empty field "${k}"`);
        }
        assert.equal(typeof e.requiresToken, 'boolean', `${e.id}: requiresToken must be boolean`);
    }
});

test('ids match ^[a-z0-9][a-z0-9-]*$ slug shape', () => {
    for (const e of MCP_CATALOG) {
        assert.ok(SLUG_RE.test(e.id), `bad id slug: ${e.id}`);
    }
});

test('ids are unique across the catalog', () => {
    const ids = MCP_CATALOG.map(e => e.id);
    const set = new Set(ids);
    assert.equal(set.size, ids.length, `duplicate id(s) in catalog: ${ids.join(', ')}`);
});

test('transport is in {streamable-http, sse} (no stdio)', () => {
    for (const e of MCP_CATALOG) {
        assert.ok(VALID_TRANSPORTS.has(e.transport), `${e.id}: invalid transport "${e.transport}"`);
    }
});

test('category is in the enumerated set', () => {
    const valid = new Set(getCategories());
    for (const e of MCP_CATALOG) {
        assert.ok(valid.has(e.category), `${e.id}: invalid category "${e.category}"`);
    }
});

test('url parses as https:// after stripping {placeholder} segments', () => {
    for (const e of MCP_CATALOG) {
        const stripped = e.url.replace(/\{[^}]+\}/g, 'placeholder');
        let parsed;
        assert.doesNotThrow(() => { parsed = new URL(stripped); }, `${e.id}: bad url "${e.url}"`);
        assert.equal(parsed.protocol, 'https:', `${e.id}: non-https url "${e.url}"`);
    }
});

test('docsUrl parses as https://', () => {
    for (const e of MCP_CATALOG) {
        let parsed;
        assert.doesNotThrow(() => { parsed = new URL(e.docsUrl); }, `${e.id}: bad docsUrl "${e.docsUrl}"`);
        assert.equal(parsed.protocol, 'https:', `${e.id}: non-https docsUrl "${e.docsUrl}"`);
    }
});

test('every requiresToken=true entry has a tokenHint', () => {
    for (const e of MCP_CATALOG) {
        if (e.requiresToken) {
            assert.equal(typeof e.tokenHint, 'string', `${e.id}: requiresToken=true must include tokenHint`);
            assert.ok(e.tokenHint.length > 0, `${e.id}: empty tokenHint`);
        }
    }
});

test('categoryIcon returns a non-empty string for every catalog category', () => {
    for (const e of MCP_CATALOG) {
        const icon = categoryIcon(e.category);
        assert.equal(typeof icon, 'string');
        assert.ok(icon.length > 0, `${e.id}: empty icon for category "${e.category}"`);
    }
});

test('categoryIcon falls back gracefully for an unknown category', () => {
    assert.equal(typeof categoryIcon('not-a-category'), 'string');
    assert.ok(categoryIcon('not-a-category').length > 0);
});
