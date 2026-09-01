/**
 * Dispatcher tests for js/zip-upload.js#mountZipUpload — Phase 2a of the
 * inline-handlers migration (docs/DESIGN-ui-event-dispatch.md).
 *
 * The zip-upload modal is the only Phase 2a modal with a payload-arg action:
 * `zipSelectAll` carries a `data-zip-select="all"|"none"` attribute that
 * routes to `onSelectAll(true|false)`. These tests cover both branches.
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

const { mountZipUpload } = await import('../js/zip-upload.js');

const _spy = { close: 0, selectAllArg: null, scan: 0, upload: 0 };
let _selectAllCalls = 0;
mountZipUpload({
    onClose: () => { _spy.close++; },
    onSelectAll: (checked) => { _selectAllCalls++; _spy.selectAllArg = checked; },
    onScanDiffs: () => { _spy.scan++; },
    onUpload: () => { _spy.upload++; },
});

function resetSpy() {
    _spy.close = 0;
    _spy.selectAllArg = null;
    _selectAllCalls = 0;
    _spy.scan = 0;
    _spy.upload = 0;
}

function makeBtn({ action, inScope, zipSelect }) {
    const btn = {
        getAttribute: (name) => {
            if (name === 'data-action') return action;
            if (name === 'data-zip-select') return zipSelect || null;
            return null;
        },
    };
    btn.closest = (sel) => {
        if (sel === '[data-action]') return btn;
        if (sel === '#zipUploadModal') return inScope ? {} : null;
        return null;
    };
    return btn;
}

function makeClick({ action, inScope, zipSelect }) {
    if (action === null) return { target: { closest: () => null } };
    return { target: makeBtn({ action, inScope, zipSelect }) };
}

test('mountZipUpload installs exactly one document click listener', () => {
    assert.equal(_clickListenerCount, 1);
});

test('data-action="closeZipUpload" inside #zipUploadModal → onClose fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeZipUpload', inScope: true }));
    assert.equal(_spy.close, 1);
});

test('data-action="zipSelectAll" data-zip-select="all" → onSelectAll(true)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'zipSelectAll', inScope: true, zipSelect: 'all' }));
    assert.equal(_selectAllCalls, 1);
    assert.equal(_spy.selectAllArg, true);
});

test('data-action="zipSelectAll" data-zip-select="none" → onSelectAll(false)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'zipSelectAll', inScope: true, zipSelect: 'none' }));
    assert.equal(_selectAllCalls, 1);
    assert.equal(_spy.selectAllArg, false);
});

test('data-action="zipSelectAll" with missing data-zip-select → onSelectAll(false)', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'zipSelectAll', inScope: true, zipSelect: null }));
    assert.equal(_selectAllCalls, 1);
    assert.equal(_spy.selectAllArg, false);
});

test('data-action="scanForDiffs" inside #zipUploadModal → onScanDiffs fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'scanForDiffs', inScope: true }));
    assert.equal(_spy.scan, 1);
});

test('data-action="uploadExtractedFiles" inside #zipUploadModal → onUpload fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'uploadExtractedFiles', inScope: true }));
    assert.equal(_spy.upload, 1);
});

test('data-action button OUTSIDE #zipUploadModal scope → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'closeZipUpload', inScope: false }));
    assert.equal(_spy.close, 0);
    assert.equal(_selectAllCalls, 0);
    assert.equal(_spy.scan, 0);
    assert.equal(_spy.upload, 0);
});

test('click with no [data-action] ancestor → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: null, inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_selectAllCalls, 0);
});

test('unknown data-action value → no callback fires', () => {
    resetSpy();
    _capturedListener(makeClick({ action: 'someOtherAction', inScope: true }));
    assert.equal(_spy.close, 0);
    assert.equal(_spy.upload, 0);
});

test('second mountZipUpload call is a no-op', () => {
    const before = _clickListenerCount;
    mountZipUpload({
        onClose: () => { assert.fail('second-mount onClose must not fire'); },
        onSelectAll: () => { assert.fail('second-mount onSelectAll must not fire'); },
        onScanDiffs: () => { assert.fail('second-mount onScanDiffs must not fire'); },
        onUpload: () => { assert.fail('second-mount onUpload must not fire'); },
    });
    assert.equal(_clickListenerCount, before);
});
