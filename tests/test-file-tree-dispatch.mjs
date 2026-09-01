/**
 * Dispatcher tests for js/file-tree.js#mountFileTree — Phase 3a of the
 * UI event-dispatch contract (docs/DESIGN-ui-event-dispatch.md).
 *
 * Scoped to `#fileTree`. Four actions:
 *   - `handleTreeClick` reads `data-path` + `data-type` (called with the event)
 *   - `openRenameModal` reads `data-path` + `data-is-dir` (boolean coercion)
 *   - `deleteFile` reads `data-path`
 *   - `deleteFolder` reads `data-path`
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let _capturedListener = null;
let _clickListenerCount = 0;
globalThis.document.addEventListener = (type, handler) => {
    if (type === 'click') {
        _clickListenerCount++;
        _capturedListener = handler;
    }
};

const { mountFileTree } = await import('../js/file-tree.js');

_clickListenerCount = 0;
_capturedListener = null;

const _spy = { tree: [], rename: [], delFile: [], delFolder: [] };
mountFileTree({
    onTreeClick: (e, path, type) => { _spy.tree.push({ e, path, type }); },
    onRename: (path, isDir) => { _spy.rename.push({ path, isDir }); },
    onDeleteFile: (path) => { _spy.delFile.push(path); },
    onDeleteFolder: (path) => { _spy.delFolder.push(path); },
});

function resetSpy() { _spy.tree = []; _spy.rename = []; _spy.delFile = []; _spy.delFolder = []; }

function makeBtn({ action, path, type, isDir, inScope }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-path') return path ?? null;
            if (name === 'data-type') return type ?? null;
            return null;
        },
        dataset: {
            isDir: isDir == null ? undefined : String(isDir),
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#fileTree') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick(opts) {
    if (opts.action === null) return { target: { closest: () => null } };
    return { target: makeBtn(opts) };
}

test('mountFileTree installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="handleTreeClick" → onTreeClick(event, path, type)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'handleTreeClick', path: 'src/a.js', type: 'file', inScope: true }));
    assert.equal(_spy.tree.length, 1);
    assert.equal(_spy.tree[0].path, 'src/a.js');
    assert.equal(_spy.tree[0].type, 'file');
    assert.ok(_spy.tree[0].e, 'event passed through to handler');
});

test('data-action="openRenameModal" data-is-dir="true" → onRename(path, true)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openRenameModal', path: 'src/sub', isDir: true, inScope: true }));
    assert.deepEqual(_spy.rename, [{ path: 'src/sub', isDir: true }]);
});

test('data-action="openRenameModal" data-is-dir="false" → onRename(path, false)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'openRenameModal', path: 'README.md', isDir: false, inScope: true }));
    assert.deepEqual(_spy.rename, [{ path: 'README.md', isDir: false }]);
});

test('data-action="deleteFile" → onDeleteFile(path)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'deleteFile', path: 'src/a.js', inScope: true }));
    assert.deepEqual(_spy.delFile, ['src/a.js']);
    assert.equal(_spy.delFolder.length, 0);
});

test('data-action="deleteFolder" → onDeleteFolder(path)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'deleteFolder', path: 'src/sub', inScope: true }));
    assert.deepEqual(_spy.delFolder, ['src/sub']);
    assert.equal(_spy.delFile.length, 0);
});

test('data-action OUTSIDE #fileTree scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'deleteFile', path: 'a', inScope: false }));
    assert.equal(_spy.delFile.length, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.tree.length, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.tree.length, 0);
});

test('second mountFileTree call is a no-op', () => {
    const before = _clickListenerCount;
    mountFileTree({
        onTreeClick: () => { assert.fail('second-mount onTreeClick must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
