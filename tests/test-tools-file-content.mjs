/**
 * Tests for `js/tools/_file-content.js` (1.6.8 follow-up).
 *
 * Bug surfaced in the issue#15 dogfood session: read tools (`read_file`,
 * `read_lines`, `scan_file`) only consulted `State.currentFile`, so any
 * read of a non-active edited file fell through to `Git.getFile()` and
 * returned stale committed content. The helper resolves three layers
 * (editor buffer → open-tab buffer → remote) so dirty edits made by
 * prior `edit_file` calls on other tabs are visible.
 */

import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { Git } from '../js/git.js';
import { resolveFileContent } from '../js/tools/_file-content.js';

let _origGetFile;

beforeEach(() => {
    State.currentFile = null;
    State.editorContent = '';
    State.openTabs = [];
    State.currentProject = { owner: 'owner', repo: 'repo' };
    State.currentBranch = 'main';
    if (!_origGetFile) _origGetFile = Git.getFile;
    Git.getFile = async (_o, _r, p) => ({ path: p, content: `REMOTE_OF_${p}` });
});

test('resolves from active editor buffer when path matches currentFile', async () => {
    State.currentFile = { path: 'js/foo.js' };
    State.editorContent = 'EDITOR_BUFFER';
    State.openTabs = [{ path: 'js/foo.js', content: 'STALE_TAB' }];

    const r = await resolveFileContent('js/foo.js');
    assert.equal(r.source, 'editor');
    assert.equal(r.content, 'EDITOR_BUFFER');
});

test('resolves from open tab buffer when target is not the active file', async () => {
    State.currentFile = { path: 'js/active.js' };
    State.editorContent = 'ACTIVE_BUFFER';
    State.openTabs = [
        { path: 'js/active.js', content: 'ACTIVE_BUFFER' },
        { path: 'js/dirty-other.js', content: 'DIRTY_OTHER_BUFFER' },
    ];

    const r = await resolveFileContent('js/dirty-other.js');
    assert.equal(r.source, 'tab');
    assert.equal(r.content, 'DIRTY_OTHER_BUFFER');
});

test('falls through to Git.getFile when file is not open', async () => {
    State.currentFile = { path: 'js/active.js' };
    State.editorContent = 'ACTIVE';
    State.openTabs = [{ path: 'js/active.js', content: 'ACTIVE' }];

    const r = await resolveFileContent('js/never-opened.js');
    assert.equal(r.source, 'remote');
    assert.equal(r.content, 'REMOTE_OF_js/never-opened.js');
});

test('regression for issue#15 trace: edit_file A → edit_file B (switches tabs) → read of A returns A\'s dirty content', async () => {
    // Simulate the exact dogfood pattern that broke:
    //   1. edit_file js/core.js — opens js/core.js, applies edit. Active.
    //   2. edit_file js/chat/handlers.js — switches tabs. js/core.js's
    //      dirty edit moves into State.openTabs[i].content.
    //   3. read_lines / read_file js/core.js — should see the dirty edit.
    State.currentFile = { path: 'js/chat/handlers.js' };
    State.editorContent = 'HANDLERS_DIRTY';
    State.openTabs = [
        { path: 'js/core.js',          content: 'CORE_DIRTY_FROM_PRIOR_EDIT' },
        { path: 'js/chat/handlers.js', content: 'HANDLERS_DIRTY' },
    ];

    const r = await resolveFileContent('js/core.js');
    assert.equal(r.source, 'tab', 'must read from open-tab buffer, not remote');
    assert.equal(r.content, 'CORE_DIRTY_FROM_PRIOR_EDIT',
        'must return the dirty content from the prior edit_file, not the committed version');
});

test('treats empty State.openTabs gracefully', async () => {
    State.currentFile = null;
    State.openTabs = [];

    const r = await resolveFileContent('js/anything.js');
    assert.equal(r.source, 'remote');
});

test('treats missing State.openTabs gracefully', async () => {
    State.currentFile = null;
    delete State.openTabs;

    const r = await resolveFileContent('js/anything.js');
    assert.equal(r.source, 'remote');
});

test('skips tab entries without a content field (defensive)', async () => {
    State.currentFile = null;
    State.openTabs = [
        null,
        { path: 'js/foo.js' /* no content */ },
    ];

    const r = await resolveFileContent('js/foo.js');
    assert.equal(r.source, 'tab');
    assert.equal(r.content, '');
});

test('throws when no project is loaded and remote fetch is required', async () => {
    State.currentProject = null;
    State.currentFile = null;
    State.openTabs = [];

    await assert.rejects(
        () => resolveFileContent('js/needs-remote.js'),
        /No project is currently loaded/,
    );
});
