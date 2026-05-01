/**
 * Virtual CI log cache tests (1.4.6).
 *
 * Two layers:
 *   1. Unit tests for `js/intelligence/test-loop/log-cache.js` — pathFor /
 *      isCachePath / write / read / LRU / evictAll.
 *   2. Integration tests asserting the existing file/scan tools resolve a
 *      cached virtual path through `Git.getFile()` without modification —
 *      proving the chokepoint hook is transparent.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { Git } from '../js/git.js';
import * as Cache from '../js/intelligence/test-loop/log-cache.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { registerFileTools } from '../js/tools/file-tools.js';
import { registerScanTools } from '../js/tools/scan-tools.js';

const CAP = Cache.__test__.PER_ENTRY_CAP_BYTES;
const MAX_ENTRIES = Cache.__test__.MAX_ENTRIES;

function withProject(fn) {
    const prev = State.currentProject;
    State.currentProject = { connectionId: 'c1', owner: 'me', repo: 'app' };
    State.currentBranch = 'main';
    try { return fn(); } finally { State.currentProject = prev; }
}

/* ---------------- Unit: pathFor / isCachePath ---------------- */

test('pathFor: builds namespaced path with sanitized slug', () => {
    assert.equal(Cache.pathFor(100, 201, 'test'), '.aieditor/ci-cache/100-201-test.log');
    assert.equal(Cache.pathFor(100, 201, 'Lint & Format'), '.aieditor/ci-cache/100-201-lint-format.log');
    assert.equal(Cache.pathFor(100, 201, '!!!'), '.aieditor/ci-cache/100-201-job.log');
    assert.equal(Cache.pathFor(100, 201, ''), '.aieditor/ci-cache/100-201-job.log');
});

test('isCachePath: matches namespace prefix', () => {
    assert.equal(Cache.isCachePath('.aieditor/ci-cache/x.log'), true);
    assert.equal(Cache.isCachePath('.aieditor/ci-cache/'), true);
    assert.equal(Cache.isCachePath('js/foo.js'), false);
    assert.equal(Cache.isCachePath(''), false);
    assert.equal(Cache.isCachePath(null), false);
    assert.equal(Cache.isCachePath(undefined), false);
});

/* ---------------- Unit: write / read ---------------- */

test('write+read: round-trips small content as Git.getFile-shaped object', () => {
    Cache.evictAll();
    const path = Cache.pathFor(1, 10, 'unit');
    const meta = Cache.write(path, 'hello world\nsecond line');
    assert.equal(meta.path, path);
    assert.equal(meta.totalBytes, 23);
    assert.equal(meta.truncatedAtCap, false);
    const file = Cache.read(path);
    assert.equal(file.path, path);
    assert.equal(file.content, 'hello world\nsecond line');
    assert.equal(file.sha, 'virtual');
    assert.equal(file.size, 23);
    assert.equal(file.encoding, 'utf-8');
    Cache.evictAll();
});

test('read: missing path returns null', () => {
    Cache.evictAll();
    assert.equal(Cache.read('.aieditor/ci-cache/never.log'), null);
});

test('write: truncates at PER_ENTRY_CAP_BYTES preserving tail', () => {
    Cache.evictAll();
    const path = Cache.pathFor(1, 10, 'big');
    const oversize = 'x'.repeat(CAP + 500) + 'TAIL_SENTINEL';
    const meta = Cache.write(path, oversize);
    assert.equal(meta.totalBytes, oversize.length);
    assert.equal(meta.truncatedAtCap, true);
    const file = Cache.read(path);
    assert.equal(file.size, CAP);
    assert.ok(file.content.endsWith('TAIL_SENTINEL'), 'tail preserved');
    Cache.evictAll();
});

test('write: empty / non-string coerces to empty content', () => {
    Cache.evictAll();
    const meta = Cache.write('.aieditor/ci-cache/empty.log', null);
    assert.equal(meta.totalBytes, 0);
    assert.equal(meta.truncatedAtCap, false);
    const file = Cache.read('.aieditor/ci-cache/empty.log');
    assert.equal(file.content, '');
    Cache.evictAll();
});

/* ---------------- Unit: LRU eviction ---------------- */

test('LRU: evicts oldest when MAX_ENTRIES exceeded', () => {
    Cache.evictAll();
    for (let i = 0; i < MAX_ENTRIES; i++) {
        Cache.write(`.aieditor/ci-cache/run-${i}.log`, `entry ${i}`);
    }
    assert.equal(Cache.has('.aieditor/ci-cache/run-0.log'), true, 'oldest still present at cap');
    Cache.write('.aieditor/ci-cache/run-overflow.log', 'kicks oldest');
    assert.equal(Cache.has('.aieditor/ci-cache/run-0.log'), false, 'oldest evicted on overflow');
    assert.equal(Cache.has('.aieditor/ci-cache/run-overflow.log'), true);
    Cache.evictAll();
});

test('LRU: re-writing an existing path moves it to end (most recently written)', () => {
    Cache.evictAll();
    Cache.write('.aieditor/ci-cache/a.log', 'A1');
    for (let i = 1; i < MAX_ENTRIES; i++) {
        Cache.write(`.aieditor/ci-cache/x-${i}.log`, `X${i}`);
    }
    // Re-write 'a.log' so it becomes most-recent.
    Cache.write('.aieditor/ci-cache/a.log', 'A2');
    // Push another new entry — the oldest should now be x-1, not a.
    Cache.write('.aieditor/ci-cache/y.log', 'Y');
    assert.equal(Cache.has('.aieditor/ci-cache/a.log'), true, 'a survives because re-written');
    assert.equal(Cache.has('.aieditor/ci-cache/x-1.log'), false, 'x-1 was evicted instead');
    Cache.evictAll();
});

test('evictAll: clears the store', () => {
    Cache.write('.aieditor/ci-cache/a.log', 'A');
    Cache.write('.aieditor/ci-cache/b.log', 'B');
    assert.equal(Cache.has('.aieditor/ci-cache/a.log'), true);
    Cache.evictAll();
    assert.equal(Cache.has('.aieditor/ci-cache/a.log'), false);
    assert.equal(Cache.has('.aieditor/ci-cache/b.log'), false);
});

/* ---------------- Integration: Git.getFile chokepoint ---------------- */

test('Git.getFile: short-circuits to cache for namespaced paths', async () => {
    await withProject(async () => {
        Cache.evictAll();
        Cache.write('.aieditor/ci-cache/100-200-test.log', 'line1\nline2\nline3');
        // Even with no provider stubbed, Git.getFile resolves from cache.
        const file = await Git.getFile('me', 'app', '.aieditor/ci-cache/100-200-test.log', 'main');
        assert.equal(file.content, 'line1\nline2\nline3');
        assert.equal(file.path, '.aieditor/ci-cache/100-200-test.log');
        assert.equal(file.sha, 'virtual');
        Cache.evictAll();
    });
});

test('Git.getFile: cache miss in namespace falls through to provider', async () => {
    await withProject(async () => {
        Cache.evictAll();
        // No cache entry — should hit the provider, which throws because
        // there's no real connection. The error coming from provider
        // resolution is the proof we fell through.
        await assert.rejects(
            () => Git.getFile('me', 'app', '.aieditor/ci-cache/missing.log', 'main'),
            (err) => /Connection|project|connectionId|provider/i.test(err.message),
        );
    });
});

/* ---------------- Integration: file/scan tools over cached path ---------------- */

test('read_lines: reads a range from a cached log', async () => {
    await withProject(async () => {
        Cache.evictAll();
        // Build a 5K-line log with a unique marker mid-file.
        const lines = Array.from({ length: 5000 }, (_, i) =>
            i === 2500 ? `Error: undefined is not a function (line ${i + 1})` : `log line ${i + 1}`
        );
        const path = Cache.pathFor(100, 201, 'test');
        Cache.write(path, lines.join('\n'));

        const reg = ToolRegistry;
        registerFileTools(reg);
        registerScanTools(reg);

        const r = await reg.execute('read_lines', { path, start_line: 2499, end_line: 2503 });
        assert.equal(r.error, undefined, `read_lines errored: ${JSON.stringify(r)}`);
        assert.match(r.content || JSON.stringify(r), /undefined is not a function/);
        Cache.evictAll();
    });
});

test('scan_file: returns line_count + size_bytes for a cached log', async () => {
    await withProject(async () => {
        Cache.evictAll();
        const lines = Array.from({ length: 5000 }, (_, i) => `log line ${i + 1}`);
        const path = Cache.pathFor(100, 201, 'lint');
        const content = lines.join('\n');
        Cache.write(path, content);

        registerScanTools(ToolRegistry);
        const r = await ToolRegistry.execute('scan_file', { path });
        assert.equal(r.error, undefined, `scan_file errored: ${JSON.stringify(r)}`);
        assert.equal(r.line_count, 5000);
        assert.equal(r.size_bytes, content.length);
        assert.equal(r.language, 'log');
        // Outline is empty for non-source-code logs — that's fine, the
        // metadata is the value.
        assert.deepEqual(r.outline, []);
        Cache.evictAll();
    });
});

test('read_file: returns head+tail summary for a large cached log', async () => {
    await withProject(async () => {
        Cache.evictAll();
        const lines = Array.from({ length: 5000 }, (_, i) =>
            i === 0 ? 'HEAD_MARKER'
                : i === 4999 ? 'TAIL_MARKER'
                : `line ${i + 1}`
        );
        const path = Cache.pathFor(100, 201, 'tail');
        Cache.write(path, lines.join('\n'));

        registerFileTools(ToolRegistry);
        const r = await ToolRegistry.execute('read_file', { path });
        assert.equal(r.error, undefined, `read_file errored: ${JSON.stringify(r)}`);
        assert.equal(r.line_count, 5000);
        assert.equal(r.truncated, true);
        assert.match(r.content, /HEAD_MARKER/);
        assert.match(r.content, /TAIL_MARKER/);
        Cache.evictAll();
    });
});
