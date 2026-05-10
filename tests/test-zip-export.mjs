/**
 * Tests for js/zip-export.js — the Touch 3 Project/Branch zip export module.
 *
 * Covers pure helpers (filterFileLeaves, estimateTotalBytes, defaultZipFilename,
 * shouldWarnBeforeGenerate, buildZipBlob) and the fetchAllFiles I/O driver via
 * an injected mock `getFile`. JSZip is mocked via a tiny in-memory constructor;
 * the real library is loaded in the browser and out-of-scope under node --test.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    filterFileLeaves,
    estimateTotalBytes,
    defaultZipFilename,
    shouldWarnBeforeGenerate,
    buildZipBlob,
    fetchAllFiles
} from '../js/zip-export.js';

// ============================================
// filterFileLeaves
// ============================================

test('filterFileLeaves keeps only file-type entries', () => {
    const tree = [
        { path: 'a.js', type: 'file', size: 10 },
        { path: 'docs', type: 'dir' },
        { path: 'docs/b.md', type: 'file', size: 20 }
    ];
    const leaves = filterFileLeaves(tree);
    assert.equal(leaves.length, 2);
    assert.deepEqual(leaves.map(l => l.path), ['a.js', 'docs/b.md']);
});

test('filterFileLeaves returns [] for non-array input', () => {
    assert.deepEqual(filterFileLeaves(null), []);
    assert.deepEqual(filterFileLeaves(undefined), []);
    assert.deepEqual(filterFileLeaves({}), []);
});

test('filterFileLeaves skips entries with empty or missing path', () => {
    const tree = [
        { path: 'a.js', type: 'file' },
        { path: '', type: 'file' },
        { type: 'file' },
        null
    ];
    assert.equal(filterFileLeaves(tree).length, 1);
});

// ============================================
// estimateTotalBytes
// ============================================

test('estimateTotalBytes sums size fields, treating missing as 0', () => {
    const leaves = [{ size: 100 }, { size: 50 }, {}, { size: 200 }];
    assert.equal(estimateTotalBytes(leaves), 350);
});

test('estimateTotalBytes returns 0 for non-array', () => {
    assert.equal(estimateTotalBytes(null), 0);
});

// ============================================
// defaultZipFilename
// ============================================

test('defaultZipFilename formats repo-branch-YYYY-MM-DD.zip', () => {
    const date = new Date(Date.UTC(2026, 4, 10)); // May = month 4 zero-indexed
    const name = defaultZipFilename({ repo: 'ai-editor', branch: 'main', date });
    assert.equal(name, 'ai-editor-main-2026-05-10.zip');
});

test('defaultZipFilename sanitizes unsafe chars in repo and branch', () => {
    const date = new Date(Date.UTC(2026, 0, 1));
    const name = defaultZipFilename({ repo: 'has/slashes', branch: 'feat/foo bar', date });
    assert.equal(name, 'has-slashes-feat-foo-bar-2026-01-01.zip');
});

test('defaultZipFilename falls back to defaults for empty input', () => {
    const date = new Date(Date.UTC(2026, 4, 10));
    const name = defaultZipFilename({ date });
    assert.equal(name, 'project-main-2026-05-10.zip');
});

// ============================================
// shouldWarnBeforeGenerate
// ============================================

test('shouldWarnBeforeGenerate returns null when under both caps', () => {
    const leaves = Array.from({ length: 10 }, () => ({ size: 1000 }));
    assert.equal(shouldWarnBeforeGenerate(leaves), null);
});

test('shouldWarnBeforeGenerate triggers on file count', () => {
    const leaves = Array.from({ length: 200 }, () => ({ size: 1 }));
    const warn = shouldWarnBeforeGenerate(leaves);
    assert.ok(warn);
    assert.equal(warn.fileCount, 200);
});

test('shouldWarnBeforeGenerate triggers on total bytes', () => {
    const leaves = [{ size: 100 * 1024 * 1024 }]; // 100 MB
    const warn = shouldWarnBeforeGenerate(leaves);
    assert.ok(warn);
    assert.equal(warn.totalBytes, 100 * 1024 * 1024);
});

test('shouldWarnBeforeGenerate honors custom caps', () => {
    const leaves = Array.from({ length: 5 }, () => ({ size: 100 }));
    const warn = shouldWarnBeforeGenerate(leaves, { fileCap: 3, byteCap: 10_000 });
    assert.ok(warn);
    assert.equal(warn.fileCount, 5);
});

// ============================================
// buildZipBlob — using a mock JSZip
// ============================================

function makeMockJSZip() {
    return class MockJSZip {
        constructor() { this.entries = []; }
        file(path, content, options) {
            this.entries.push({ path, content, options: options || null });
        }
        async generateAsync(opts) {
            // Return a plain object pretending to be a blob; tests inspect entries.
            return { __mock: true, type: opts?.type || 'blob', entries: this.entries };
        }
    };
}

test('buildZipBlob throws when JSZip ctor missing', async () => {
    await assert.rejects(() => buildZipBlob([], null), /JSZip constructor is required/);
});

test('buildZipBlob throws when entries is not an array', async () => {
    await assert.rejects(() => buildZipBlob('nope', makeMockJSZip()), /entries must be an array/);
});

test('buildZipBlob writes text entries verbatim', async () => {
    const Ctor = makeMockJSZip();
    const blob = await buildZipBlob([
        { path: 'a.txt', content: 'hello', isBinary: false }
    ], Ctor);
    assert.equal(blob.entries.length, 1);
    assert.equal(blob.entries[0].path, 'a.txt');
    assert.equal(blob.entries[0].content, 'hello');
    assert.equal(blob.entries[0].options, null);
});

test('buildZipBlob marks binary entries with {base64:true}', async () => {
    const Ctor = makeMockJSZip();
    const blob = await buildZipBlob([
        { path: 'logo.png', content: 'aGVsbG8=', isBinary: true }
    ], Ctor);
    assert.equal(blob.entries.length, 1);
    assert.deepEqual(blob.entries[0].options, { base64: true });
});

test('buildZipBlob skips entries with missing path', async () => {
    const Ctor = makeMockJSZip();
    const blob = await buildZipBlob([
        { path: 'a.txt', content: 'ok' },
        { content: 'missing-path' },
        { path: '', content: 'empty-path' },
        null
    ], Ctor);
    assert.equal(blob.entries.length, 1);
});

// ============================================
// fetchAllFiles — using a mock getFile
// ============================================

test('fetchAllFiles invokes getFile for every leaf and preserves order', async () => {
    const leaves = [
        { path: 'a.js' },
        { path: 'b.md' },
        { path: 'c.css' }
    ];
    const calls = [];
    const getFile = async (o, r, path) => {
        calls.push(path);
        return { content: `content-of-${path}`, encoding: 'text' };
    };
    const out = await fetchAllFiles({ owner: 'x', repo: 'y', ref: 'main', leaves, getFile, concurrency: 2 });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(f => f.path), ['a.js', 'b.md', 'c.css']);
    assert.deepEqual(out.map(f => f.content), ['content-of-a.js', 'content-of-b.md', 'content-of-c.css']);
    assert.equal(calls.length, 3);
});

test('fetchAllFiles tags base64-encoded entries as binary', async () => {
    const leaves = [{ path: 'logo.png' }, { path: 'README.md' }];
    const getFile = async (o, r, path) => {
        if (path.endsWith('.png')) return { content: 'aGVsbG8=', encoding: 'base64' };
        return { content: '# hi', encoding: 'text' };
    };
    const out = await fetchAllFiles({ owner: 'x', repo: 'y', ref: 'main', leaves, getFile });
    assert.equal(out.length, 2);
    const png = out.find(f => f.path === 'logo.png');
    const md = out.find(f => f.path === 'README.md');
    assert.equal(png.isBinary, true);
    assert.equal(md.isBinary, false);
});

test('fetchAllFiles drops failures gracefully (warns, does not throw)', async () => {
    const leaves = [{ path: 'a.js' }, { path: 'broken' }, { path: 'b.js' }];
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        const getFile = async (o, r, path) => {
            if (path === 'broken') throw new Error('boom');
            return { content: path, encoding: 'text' };
        };
        const out = await fetchAllFiles({ owner: 'x', repo: 'y', ref: 'main', leaves, getFile });
        assert.equal(out.length, 2);
        assert.deepEqual(out.map(f => f.path), ['a.js', 'b.js']);
    } finally {
        console.warn = origWarn;
    }
});

test('fetchAllFiles reports progress after each file', async () => {
    const leaves = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    const events = [];
    const getFile = async (o, r, path) => ({ content: path, encoding: 'text' });
    await fetchAllFiles({
        owner: 'x', repo: 'y', ref: 'main', leaves, getFile,
        onProgress: (p) => events.push(p)
    });
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(e => e.done), [1, 2, 3]);
    assert.ok(events.every(e => e.total === 3));
});

test('fetchAllFiles respects concurrency cap', async () => {
    const leaves = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}` }));
    let inflight = 0;
    let maxInflight = 0;
    const getFile = async () => {
        inflight++;
        if (inflight > maxInflight) maxInflight = inflight;
        await new Promise(r => setTimeout(r, 5));
        inflight--;
        return { content: '', encoding: 'text' };
    };
    await fetchAllFiles({
        owner: 'x', repo: 'y', ref: 'main', leaves, getFile, concurrency: 3
    });
    assert.ok(maxInflight <= 3, `maxInflight was ${maxInflight}`);
    assert.ok(maxInflight >= 2, 'concurrency should actually parallelize');
});

test('fetchAllFiles requires leaves array', async () => {
    await assert.rejects(() => fetchAllFiles({}), /leaves array required/);
});
