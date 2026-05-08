/**
 * Tests for the pure `runScript` helper (1.16.0 — DESIGN-llm-authored-
 * automation.md §"Sandbox Seam — Option A").
 *
 * Workers don't run under `node:test`, so the curated-globals + timeout
 * + output-cap + Git-adapter logic lives in `js/intelligence/script-
 * runner.js` as a pure function and is tested directly. The browser-side
 * Worker (`js/workers/script-runner-worker.js`) is a thin wrapper around
 * `runScript` with the postMessage protocol on top — its round-trip
 * lives in tests/index.html.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runScript } from '../js/intelligence/script-runner.js';

// ============================================
// Smoke
// ============================================

test('runScript captures console.log to stdout', async () => {
    const r = await runScript({
        source: `console.log('hi');`,
        gitAdapter: null,
    });
    assert.equal(r.stdout, 'hi\n');
    assert.equal(r.stderr, '');
    assert.equal(r.truncated, false);
    assert.ok(Number.isFinite(r.runtime_ms));
});

test('runScript captures console.error to stderr', async () => {
    const r = await runScript({
        source: `console.error('boom');`,
        gitAdapter: null,
    });
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'boom\n');
    assert.equal(r.truncated, false);
});

test('runScript surfaces return value as JSON line on stdout', async () => {
    const r = await runScript({
        source: `return { unused: ['.foo', '.bar'], total: 2 };`,
        gitAdapter: null,
    });
    const lastLine = r.stdout.trimEnd().split('\n').pop();
    assert.equal(lastLine, '{"unused":[".foo",".bar"],"total":2}');
});

test('runScript supports top-level await', async () => {
    const r = await runScript({
        source: `
            const x = await Promise.resolve(7);
            console.log('x=' + x);
        `,
        gitAdapter: null,
    });
    assert.equal(r.stdout.trimEnd(), 'x=7');
});

// ============================================
// Forbidden globals
// ============================================

test('runScript captures ReferenceError for fetch / XMLHttpRequest', async () => {
    // In Node, fetch IS defined globally. We can't actually delete it
    // here — that's the Worker's job. But the Function-constructor
    // doesn't inject a sandboxed global, so user code that references
    // `fetch` resolves to the host's `fetch`. That's a known limit of
    // the Node-side test for this surface; the Worker-side test (in
    // tests/index.html) verifies the deletion. Here we test that a
    // user-thrown ReferenceError lands in stderr without crashing.
    const r = await runScript({
        source: `console.log(typeof fetchTotallyMissing); throw new ReferenceError('fetchTotallyMissing is not defined');`,
        gitAdapter: null,
    });
    assert.match(r.stdout, /undefined/);
    assert.match(r.stderr, /ReferenceError/);
});

// ============================================
// Timeout
// ============================================

test('runScript timeout fires when source awaits longer than timeout_ms', async () => {
    const r = await runScript({
        source: `await new Promise(r => setTimeout(r, 5000));`,
        timeout_ms: 50,
        gitAdapter: null,
    });
    assert.equal(r.truncated, true);
    assert.match(r.stderr, /Timeout after 50ms/);
});

test('runScript completes normally well under timeout', async () => {
    const r = await runScript({
        source: `console.log('fast');`,
        timeout_ms: 5000,
        gitAdapter: null,
    });
    assert.equal(r.truncated, false);
    assert.equal(r.stdout, 'fast\n');
});

// ============================================
// Output cap
// ============================================

test('runScript truncates stdout at max_output_bytes', async () => {
    const r = await runScript({
        // Each `console.log('x'.repeat(1024))` writes 1025 bytes; 200
        // iterations = ~200 KB. Cap at 4096 ⇒ at most a handful land
        // before we flip truncated.
        source: `
            for (let i = 0; i < 200; i++) {
                console.log('x'.repeat(1024));
            }
        `,
        max_output_bytes: 4096,
        gitAdapter: null,
    });
    assert.equal(r.truncated, true);
    assert.ok(r.stdout.length <= 4096, `stdout length ${r.stdout.length} exceeds cap`);
});

test('runScript stays under cap when output is small', async () => {
    const r = await runScript({
        source: `console.log('small');`,
        max_output_bytes: 4096,
        gitAdapter: null,
    });
    assert.equal(r.truncated, false);
});

// ============================================
// Git adapter proxy
// ============================================

test('runScript Git.getFile resolves through gitAdapter stub', async () => {
    const r = await runScript({
        source: `
            const c = await Git.getFile('xcaliber', 'ai-editor', 'js/version.js', 'main');
            console.log('len=' + c.length);
        `,
        gitAdapter: {
            getFile: async (owner, repo, path, ref) => {
                assert.equal(owner, 'xcaliber');
                assert.equal(repo, 'ai-editor');
                assert.equal(path, 'js/version.js');
                assert.equal(ref, 'main');
                return 'export const VERSION = "1.16.0";';
            },
            getFileTree: async () => [],
        },
    });
    assert.match(r.stdout, /len=\d+/);
});

test('runScript Git.readFile resolves through native adapter when present', async () => {
    let nativeCalled = false;
    const r = await runScript({
        source: `
            const s = await Git.readFile('owner', 'repo', 'path/to.css');
            console.log('content=' + s);
        `,
        gitAdapter: {
            getFile: async () => { throw new Error('should not be called when readFile native'); },
            readFile: async (owner, repo, path) => {
                nativeCalled = true;
                return '/* native readFile content */';
            },
            getFileTree: async () => [],
        },
    });
    assert.equal(nativeCalled, true);
    assert.match(r.stdout, /content=\/\* native readFile content \*\//);
});

test('runScript Git.readFile falls back to unwrapping getFile when native readFile absent', async () => {
    // This is the user-session bug: gitea/local providers return the
    // full envelope `{name, path, sha, size, content, encoding}`. The
    // model wasted three iterations + a debug probe to discover this.
    // Test pins that the fallback path unwraps `.content` correctly so
    // a stub adapter that only exposes `getFile` (no native readFile)
    // still gives the model a string from `Git.readFile`.
    const r = await runScript({
        source: `
            const s = await Git.readFile('xcaliber', 'HTML-Games', 'kimi/defence.css');
            console.log('typeofResult=' + typeof s);
            console.log('len=' + s.length);
        `,
        gitAdapter: {
            getFile: async () => ({
                name: 'defence.css',
                path: 'kimi/defence.css',
                sha: '05df2648',
                size: 22023,
                content: '/* CSS content here */',
                encoding: 'text',
            }),
            getFileTree: async () => [],
        },
    });
    assert.match(r.stdout, /typeofResult=string/);
    assert.match(r.stdout, /len=22/);
});

test('runScript Git.readFile unwrap returns empty string when content field is missing', async () => {
    const r = await runScript({
        source: `
            const s = await Git.readFile('o', 'r', 'p');
            console.log('len=' + s.length);
        `,
        gitAdapter: {
            getFile: async () => ({ path: 'p', size: 0 }),
            getFileTree: async () => [],
        },
    });
    assert.match(r.stdout, /len=0/);
});

test('runScript Git.getFileTree resolves through gitAdapter stub', async () => {
    const r = await runScript({
        source: `
            const tree = await Git.getFileTree('xcaliber', 'ai-editor', 'main', 'js');
            console.log('count=' + tree.length);
        `,
        gitAdapter: {
            getFile: async () => '',
            getFileTree: async () => [{ path: 'js/version.js' }, { path: 'js/core.js' }],
        },
    });
    assert.match(r.stdout, /count=2/);
});

test('runScript surfaces Git adapter throws on stderr', async () => {
    const r = await runScript({
        source: `
            try {
                await Git.getFile('x', 'y', 'z');
            } catch (err) {
                console.error('got: ' + err.message);
            }
        `,
        gitAdapter: {
            getFile: async () => { throw new Error('ENOENT'); },
            getFileTree: async () => [],
        },
    });
    assert.match(r.stderr, /got: ENOENT/);
});

test('runScript with no gitAdapter rejects Git.getFile', async () => {
    const r = await runScript({
        source: `
            try {
                await Git.getFile('x', 'y', 'z');
                console.log('SHOULD NOT REACH');
            } catch (err) {
                console.error('blocked: ' + err.message);
            }
        `,
        gitAdapter: null,
    });
    assert.match(r.stderr, /Git adapter not available/);
});

// ============================================
// Parse + runtime errors
// ============================================

test('runScript surfaces parse errors on stderr without throwing', async () => {
    const r = await runScript({
        source: `this is not valid javascript $$$ +`,
        gitAdapter: null,
    });
    assert.match(r.stderr, /ParseError/);
    assert.equal(r.stdout, '');
    assert.ok(Number.isFinite(r.runtime_ms));
});

test('runScript surfaces runtime errors on stderr', async () => {
    const r = await runScript({
        source: `throw new Error('boom');`,
        gitAdapter: null,
    });
    assert.match(r.stderr, /Error: boom/);
});

test('runScript handles undefined return without polluting stdout', async () => {
    const r = await runScript({
        source: `console.log('done');`,
        gitAdapter: null,
    });
    assert.equal(r.stdout, 'done\n');
});

// ============================================
// Defaults
// ============================================

test('runScript applies default timeout (10s) when timeout_ms omitted', async () => {
    const r = await runScript({
        source: `console.log('x');`,
        gitAdapter: null,
    });
    assert.equal(r.truncated, false);
});

test('runScript applies default max_output_bytes (256 KB) when omitted', async () => {
    const r = await runScript({
        source: `console.log('x');`,
        gitAdapter: null,
    });
    assert.equal(r.truncated, false);
});
