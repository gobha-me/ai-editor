/**
 * Tests for `js/preview/sw-bridge.js` (gitea#500 / 2.88.0).
 *
 * The preview Service Worker bridge resolves workspace paths for the SW to
 * synthesize Responses. Before 2.88.0 the bridge called `Git.getFile` directly
 * — which returns committed remote content — so any `edit_file` that hadn't
 * been `commit_files`'d to the remote was invisible to the preview. Read tools
 * went through `resolveFileContent` (editor → tab → remote) and saw the dirty
 * edit; the SW bridge did not. The fix routes text extensions through
 * `resolveFileContent` while keeping binary extensions on the raw `Git.getFile`
 * path so the gitea#338 atob byte-recovery contract is preserved.
 *
 * These tests reach into the page-side resolver through the exported
 * `_resolveWorkspacePath` ESM internal. The bridge module's only public
 * surface is `initSwBridge()`, but the resolver is the unit under test.
 */

import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { Git } from '../js/git.js';

// Import via the module's namespace so we can poke the internal resolver.
// sw-bridge.js exports `initSwBridge` and `_resetForTests`; the resolver is
// module-internal. We exercise it through the message-event seam by
// re-importing the module-scoped helpers via a small probe export added in
// 2.88.0 — but to avoid widening the public surface, we instead drive the
// resolver indirectly through a `MessageChannel`-shaped postMessage path.
// Simpler: re-export the resolver as a test-only seam.

let _origGetFile;
let _gitGetFileCalls;

beforeEach(() => {
    State.currentFile = null;
    State.editorContent = '';
    State.openTabs = [];
    State.currentProject = { owner: 'owner', repo: 'repo' };
    State.currentBranch = 'main';
    _gitGetFileCalls = [];
    if (!_origGetFile) _origGetFile = Git.getFile;
    Git.getFile = async (_o, _r, p) => {
        _gitGetFileCalls.push(p);
        // For text paths the test asserts this is never called.
        // For binary paths return an atob-fallback byte string (each char 0-255).
        return { path: p, content: '\x00\x01\x02BINARY' };
    };
});

// Re-import the bridge so we can reach the resolver. The module exports
// `_resolveWorkspacePathForTests` as the seam — see sw-bridge.js.
const { _resolveWorkspacePathForTests } = await import('../js/preview/sw-bridge.js');

test('active-editor file: returns State.editorContent bytes, never hits Git.getFile', async () => {
    State.currentFile = { path: 'oregon-trail/js/events/regions/desert.js' };
    State.editorContent = 'const FIXED = "single quotes";';
    State.openTabs = [{ path: 'oregon-trail/js/events/regions/desert.js', content: 'STALE' }];

    const r = await _resolveWorkspacePathForTests('oregon-trail/js/events/regions/desert.js');
    assert.equal(r.ok, true);
    assert.equal(r.ext, 'js');
    const out = new TextDecoder().decode(new Uint8Array(r.body));
    assert.equal(out, 'const FIXED = "single quotes";');
    assert.equal(_gitGetFileCalls.length, 0, 'must not hit Git.getFile for text in active editor');
});

test('open-tab file: returns dirty openTabs content, never hits Git.getFile', async () => {
    State.currentFile = { path: 'index.html' };
    State.editorContent = '<html></html>';
    State.openTabs = [
        { path: 'index.html', content: '<html></html>' },
        { path: 'js/events.js', content: 'export const FIXED = true;' },
    ];

    const r = await _resolveWorkspacePathForTests('js/events.js');
    assert.equal(r.ok, true);
    const out = new TextDecoder().decode(new Uint8Array(r.body));
    assert.equal(out, 'export const FIXED = true;');
    assert.equal(_gitGetFileCalls.length, 0, 'dirty tab must short-circuit remote read');
});

test('cold file: falls through resolveFileContent to Git.getFile (preserves existing behaviour)', async () => {
    State.currentFile = null;
    State.openTabs = [];
    Git.getFile = async (_o, _r, p) => {
        _gitGetFileCalls.push(p);
        return { path: p, content: 'export const REMOTE = 1;' };
    };

    const r = await _resolveWorkspacePathForTests('js/never-opened.js');
    assert.equal(r.ok, true);
    const out = new TextDecoder().decode(new Uint8Array(r.body));
    assert.equal(out, 'export const REMOTE = 1;');
    assert.deepEqual(_gitGetFileCalls, ['js/never-opened.js']);
});

test('binary extension: routes through Git.getFile with byte-preserving recovery (gitea#338)', async () => {
    State.currentFile = null;
    State.openTabs = [];
    // 4-byte signature reused from the woff2 dogfood case.
    const rawBytes = '\x77\x4F\x46\x32';
    Git.getFile = async (_o, _r, p) => {
        _gitGetFileCalls.push(p);
        return { path: p, content: rawBytes };
    };

    const r = await _resolveWorkspacePathForTests('assets/font.woff2');
    assert.equal(r.ok, true);
    assert.equal(r.ext, 'woff2');
    const bytes = new Uint8Array(r.body);
    assert.deepEqual(
        Array.from(bytes),
        [0x77, 0x4F, 0x46, 0x32],
        'binary extension must preserve raw bytes via atob byte-recovery, not UTF-8 mangle them',
    );
    assert.deepEqual(_gitGetFileCalls, ['assets/font.woff2']);
});

test('gitea#500 trace: edit_file desert.js (non-active) → preview asks for desert.js → returns dirty buffer not stale Gitea content', async () => {
    // Mirror the exact dogfood pattern. The model edits desert.js, then
    // switches to another file in the editor, then the preview iframe loads
    // desert.js as an ES module via the SW. Before 2.88.0 the SW saw stale
    // Gitea content; after, it sees the in-tab fix.
    State.currentFile = { path: 'oregon-trail/index.html' };
    State.editorContent = '<html><script type="module" src="js/events/regions/desert.js"></script></html>';
    State.openTabs = [
        { path: 'oregon-trail/index.html', content: '<html></html>' },
        { path: 'oregon-trail/js/events/regions/desert.js',
          content: 'export const text = "single quotes";' },
    ];
    Git.getFile = async (_o, _r, p) => {
        _gitGetFileCalls.push(p);
        return { path: p, content: 'export const text = "mismatched\'quotes\";' };
    };

    const r = await _resolveWorkspacePathForTests('oregon-trail/js/events/regions/desert.js');
    assert.equal(r.ok, true);
    const out = new TextDecoder().decode(new Uint8Array(r.body));
    assert.equal(out, 'export const text = "single quotes";',
        'preview must see the dirty edit, not the stale Gitea content');
    assert.equal(_gitGetFileCalls.length, 0,
        'preview must not re-fetch from remote when a dirty tab buffer exists');
});

test('no project loaded: returns 503 envelope', async () => {
    State.currentProject = null;

    const r = await _resolveWorkspacePathForTests('anything.js');
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
});

test('empty path: returns 400 envelope', async () => {
    const r = await _resolveWorkspacePathForTests('/');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
});
