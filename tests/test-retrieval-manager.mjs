/**
 * RetrievalManager helper tests (1.5.14).
 *
 * Covers `js/intelligence/retrieval/manager-helpers.js` — the pure
 * functions extracted from the production singleton at `manager.js` so
 * `node --test` can exercise them. The singleton itself imports
 * browser-bound `core.js` / `git.js` / `embeddings-client.js` /
 * `llm/api.js` and is verified live in the browser preview (per the
 * 1.5.14 plan's verification step).
 *
 * What's covered here:
 *   - `summaryForChunk` — heading-path → first non-blank line → empty.
 *   - `rollupToFiles` — two-pass per-source aggregation: max-score wins,
 *     first-position breaks ties, top-K cap, summary synthesis from the
 *     winning chunk per source.
 *   - `projectKeyFromString` — `${owner}/${repo}@${branch}` decomposition.
 *
 * Pure data, no DOM / State / network — runs under `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    summaryForChunk,
    rollupToFiles,
    projectKeyFromString,
    resolveLiveBranches,
} from '../js/intelligence/retrieval/manager-helpers.js';

/* ---------------- summaryForChunk ---------------- */

test('summaryForChunk: empty / null / non-object → ""', () => {
    assert.strictEqual(summaryForChunk(null), '');
    assert.strictEqual(summaryForChunk(undefined), '');
    assert.strictEqual(summaryForChunk(/** @type {any} */ ('not-an-object')), '');
    assert.strictEqual(summaryForChunk({}), '');
});

test('summaryForChunk: heading-path wins over bytes (prose with structure)', () => {
    const chunk = {
        bytes: 'this is the body of the section',
        metadata: {
            structural: { heading_path: ['Setup', 'Installation', 'Linux'] },
        },
    };
    assert.strictEqual(summaryForChunk(chunk), 'Setup › Installation › Linux');
});

test('summaryForChunk: empty heading-path falls through to bytes', () => {
    const chunk = {
        bytes: 'export function foo() {\n  return 1;\n}',
        metadata: { structural: { heading_path: [] } },
    };
    assert.strictEqual(summaryForChunk(chunk), 'export function foo() {');
});

test('summaryForChunk: bytes — first non-blank line, trimmed', () => {
    const chunk = {
        bytes: '\n\n   const x = 42;\n   const y = 7;\n',
        metadata: {},
    };
    assert.strictEqual(summaryForChunk(chunk), 'const x = 42;');
});

test('summaryForChunk: bytes capped at ~120 chars', () => {
    const long = 'a'.repeat(200);
    const chunk = { bytes: long, metadata: {} };
    const out = summaryForChunk(chunk);
    assert.strictEqual(out.length, 120);
    assert.strictEqual(out, 'a'.repeat(120));
});

test('summaryForChunk: heading-path also capped at ~120 chars', () => {
    const chunk = {
        bytes: 'irrelevant',
        metadata: {
            structural: { heading_path: Array(50).fill('SECTION') },
        },
    };
    const out = summaryForChunk(chunk);
    assert.ok(out.length <= 120, `expected <= 120 chars, got ${out.length}`);
});

/* ---------------- rollupToFiles ---------------- */

function chunk(id, sourceUri, score, bytes, headingPath) {
    return {
        id,
        bytes: bytes || `chunk ${id}`,
        metadata: {
            source_uri: sourceUri,
            structural: headingPath ? { heading_path: headingPath } : null,
        },
        provenance: { score },
    };
}

function composerResult(blocks, chunksById) {
    return { blocks, chunks_by_id: chunksById };
}

test('rollupToFiles: empty / null / malformed → []', () => {
    assert.deepStrictEqual(rollupToFiles(null, 5), []);
    assert.deepStrictEqual(rollupToFiles({}, 5), []);
    assert.deepStrictEqual(rollupToFiles({ blocks: [] }, 5), []);
    assert.deepStrictEqual(rollupToFiles({ blocks: [], chunks_by_id: {} }, 5), []);
});

test('rollupToFiles: per-source max-score wins (T2 rollup)', () => {
    // Two sources: code.js with one chunk @0.85; docs.md with two chunks @0.7 each.
    // T2 says max-score wins per source — so code.js should rank above docs.md.
    const c1 = chunk('a', 'code.js', 0.85, 'function foo() {}');
    const c2 = chunk('b', 'docs.md', 0.7, '# Heading\nbody');
    const c3 = chunk('c', 'docs.md', 0.7, 'more docs');
    const result = composerResult(
        [{ position: 'retrieved', chunks: ['b', 'c', 'a'] }],
        { a: c1, b: c2, c: c3 },
    );
    const out = rollupToFiles(result, 5);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].path, 'code.js', 'higher max-score wins');
    assert.strictEqual(out[0].similarity, 0.85);
    assert.strictEqual(out[1].path, 'docs.md');
});

test('rollupToFiles: tie on max-score → first-position breaks tie', () => {
    const c1 = chunk('a', 'first.js', 0.5, 'one');
    const c2 = chunk('b', 'second.js', 0.5, 'two');
    const result = composerResult(
        [{ position: 'retrieved', chunks: ['a', 'b'] }],
        { a: c1, b: c2 },
    );
    const out = rollupToFiles(result, 5);
    assert.strictEqual(out[0].path, 'first.js');
    assert.strictEqual(out[1].path, 'second.js');
});

test('rollupToFiles: missing / non-finite score treated as 0', () => {
    const c1 = chunk('a', 'a.js', 0.5, 'body-a');
    const c2 = { id: 'b', bytes: 'body-b', metadata: { source_uri: 'b.js' }, provenance: { score: NaN } };
    const c3 = { id: 'c', bytes: 'body-c', metadata: { source_uri: 'c.js' } /* no provenance */ };
    const result = composerResult(
        [{ position: 'retrieved', chunks: ['c', 'b', 'a'] }],
        { a: c1, b: c2, c: c3 },
    );
    const out = rollupToFiles(result, 5);
    assert.strictEqual(out[0].path, 'a.js', 'real score wins over NaN/missing');
    assert.strictEqual(out[0].similarity, 0.5);
    // c and b both have effective score 0; first-position breaks tie.
    assert.strictEqual(out[1].path, 'c.js');
    assert.strictEqual(out[2].path, 'b.js');
});

test('rollupToFiles: top-K cap', () => {
    const blocks = [];
    const byId = {};
    for (let i = 0; i < 10; i++) {
        const id = `c${i}`;
        byId[id] = chunk(id, `file${i}.js`, 1 - i * 0.05, `body ${i}`);
        if (!blocks[0]) blocks[0] = { position: 'retrieved', chunks: [] };
        blocks[0].chunks.push(id);
    }
    const result = composerResult(blocks, byId);
    const out = rollupToFiles(result, 3);
    assert.strictEqual(out.length, 3);
    assert.deepStrictEqual(out.map(r => r.path), ['file0.js', 'file1.js', 'file2.js']);
});

test('rollupToFiles: summary synthesized from winning chunk per source', () => {
    // The chunk that wins (highest score) gets its summary used.
    const losing = chunk('a', 'foo.md', 0.3, 'low score body', ['Wrong']);
    const winning = chunk('b', 'foo.md', 0.9, 'high score body', ['Right', 'Heading']);
    const result = composerResult(
        [{ position: 'retrieved', chunks: ['a', 'b'] }],
        { a: losing, b: winning },
    );
    const out = rollupToFiles(result, 5);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].path, 'foo.md');
    assert.strictEqual(out[0].similarity, 0.9);
    assert.strictEqual(out[0].summary, 'Right › Heading');
});

test('rollupToFiles: invalid topK falls back to 5', () => {
    const blocks = [{ position: 'retrieved', chunks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }];
    const byId = {};
    for (let i = 0; i < 7; i++) {
        const id = String.fromCharCode(97 + i);
        byId[id] = chunk(id, `f${i}.js`, 1 - i * 0.1);
    }
    const result = composerResult(blocks, byId);
    assert.strictEqual(rollupToFiles(result, /** @type {any} */ (NaN)).length, 5);
    assert.strictEqual(rollupToFiles(result, 0).length, 5);
    assert.strictEqual(rollupToFiles(result, -1).length, 5);
});

test('rollupToFiles: walks all blocks, dedupes by source_uri across them', () => {
    const c1 = chunk('a', 'shared.js', 0.4);
    const c2 = chunk('b', 'shared.js', 0.8);
    const c3 = chunk('c', 'other.js', 0.5);
    const result = composerResult(
        [
            { position: 'head', chunks: ['a'] },
            { position: 'retrieved', chunks: ['b', 'c'] },
        ],
        { a: c1, b: c2, c: c3 },
    );
    const out = rollupToFiles(result, 5);
    assert.strictEqual(out.length, 2, 'shared.js dedupes across blocks');
    assert.strictEqual(out[0].path, 'shared.js', '0.8 wins over 0.4 and 0.5');
    assert.strictEqual(out[0].similarity, 0.8);
    assert.strictEqual(out[1].path, 'other.js');
});

test('rollupToFiles: skips chunks with missing source_uri / metadata', () => {
    const c1 = chunk('a', 'good.js', 0.5);
    const c2 = { id: 'b', bytes: 'orphan', metadata: null, provenance: { score: 0.9 } };
    const c3 = { id: 'c', bytes: 'no-uri', metadata: {}, provenance: { score: 0.9 } };
    const result = composerResult(
        [{ position: 'retrieved', chunks: ['a', 'b', 'c'] }],
        { a: c1, b: c2, c: c3 },
    );
    const out = rollupToFiles(result, 5);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].path, 'good.js');
});

/* ---------------- projectKeyFromString ---------------- */

test('projectKeyFromString: standard "owner/repo@branch"', () => {
    assert.deepStrictEqual(
        projectKeyFromString('xcaliber/ai-editor@main'),
        { owner: 'xcaliber', repo: 'ai-editor', ref: 'main' },
    );
});

test('projectKeyFromString: branch with slashes', () => {
    assert.deepStrictEqual(
        projectKeyFromString('xcaliber/ai-editor@feat/1.5.14'),
        { owner: 'xcaliber', repo: 'ai-editor', ref: 'feat/1.5.14' },
    );
});

test('projectKeyFromString: empty / non-string → empty triple', () => {
    assert.deepStrictEqual(
        projectKeyFromString(''),
        { owner: '', repo: '', ref: '' },
    );
    assert.deepStrictEqual(
        projectKeyFromString(/** @type {any} */ (null)),
        { owner: '', repo: '', ref: '' },
    );
});

test('projectKeyFromString: missing branch (no @)', () => {
    assert.deepStrictEqual(
        projectKeyFromString('xcaliber/ai-editor'),
        { owner: '', repo: 'xcaliber/ai-editor', ref: '' },
    );
});

test('projectKeyFromString: repo without owner', () => {
    assert.deepStrictEqual(
        projectKeyFromString('ai-editor@main'),
        { owner: '', repo: 'ai-editor', ref: 'main' },
    );
});

/* ---------------- resolveLiveBranches (1.6.4 bundled fix) ---------------- */

test('resolveLiveBranches: missing payload + empty State.branches → null (skip cleanup)', () => {
    // The crash repro: btnRefreshFiles emits with no payload and the user
    // hasn't loaded a project yet. Returning null lets the handler skip
    // cleanup instead of throwing on destructure or wiping all indexes.
    assert.strictEqual(resolveLiveBranches(undefined, undefined), null);
    assert.strictEqual(resolveLiveBranches(undefined, null), null);
    assert.strictEqual(resolveLiveBranches(undefined, []), null);
    assert.strictEqual(resolveLiveBranches(null, []), null);
    assert.strictEqual(resolveLiveBranches({}, []), null);
});

test('resolveLiveBranches: missing payload → falls back to State.branches names', () => {
    // The common case: btnRefreshFiles / pr-tools emit with no payload,
    // project-manager re-runs refreshBranches() to populate State.branches,
    // and we read from there 500ms later.
    const stateBranches = [
        { name: 'main', protected: true, sha: 'abc' },
        { name: 'feat/x', protected: false, sha: 'def' },
    ];
    assert.deepStrictEqual(resolveLiveBranches(undefined, stateBranches), ['main', 'feat/x']);
    assert.deepStrictEqual(resolveLiveBranches({}, stateBranches), ['main', 'feat/x']);
});

test('resolveLiveBranches: explicit payload.liveBranches wins over State', () => {
    const stateBranches = [{ name: 'main', sha: 'abc' }];
    assert.deepStrictEqual(
        resolveLiveBranches({ liveBranches: ['feat/y', 'feat/z'] }, stateBranches),
        ['feat/y', 'feat/z'],
    );
});

test('resolveLiveBranches: filters non-string / empty entries', () => {
    const stateBranches = [
        { name: 'main' },
        { name: '' },
        { /* no name */ },
        { name: 42 },
        { name: 'feat/ok' },
    ];
    assert.deepStrictEqual(resolveLiveBranches(undefined, stateBranches), ['main', 'feat/ok']);
    assert.deepStrictEqual(
        resolveLiveBranches({ liveBranches: ['a', '', null, 7, 'b'] }, undefined),
        ['a', 'b'],
    );
});

test('resolveLiveBranches: empty payload.liveBranches falls through to State', () => {
    const stateBranches = [{ name: 'main' }];
    assert.deepStrictEqual(resolveLiveBranches({ liveBranches: [] }, stateBranches), ['main']);
});
