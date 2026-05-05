// @ts-check
/**
 * Buffer-aware file-content resolver shared across read tools.
 *
 * The read tools (`read_file`, `read_lines`, `scan_file`) need to see
 * dirty edits made by `edit_file` even when the target file is not the
 * active editor tab. Three layers of state can hold the latest content:
 *
 *   1. `State.editorContent`         — the active tab's live buffer.
 *   2. `State.openTabs[i].content`   — saved on tab-switch
 *                                      (see [`js/file-tree.js:188-193`](../file-tree.js)).
 *   3. `Git.getFile()`               — committed/remote version.
 *
 * Until 1.6.8 follow-up the read tools only consulted (1), so any
 * read of a non-active edited file fell through to (3) and returned
 * stale content. Bug surfaced in the issue#15 dogfood session: model
 * calls `edit_file js/core.js`, then `edit_file js/chat/handlers.js`
 * (which switches active tab), then `read_lines js/core.js` returns
 * the pre-edit committed text, the model retries the edit, duplicate
 * lines result.
 *
 * @module tools/_file-content
 */

import { State } from '../core.js';
import { Git } from '../git.js';

/**
 * Resolve the latest content for `path`, preferring buffered/dirty
 * state over remote. Returns `{ content, source }` where source is one
 * of `'editor' | 'tab' | 'remote'`. Throws if the remote fetch errors;
 * caller is expected to catch and translate (404 → friendly message).
 *
 * @param {string} path
 * @returns {Promise<{ content: string, source: 'editor'|'tab'|'remote' }>}
 */
export async function resolveFileContent(path) {
    if (State.currentFile && State.currentFile.path === path) {
        return { content: State.editorContent || '', source: 'editor' };
    }
    const openTab = (State.openTabs || []).find((t) => t && t.path === path);
    if (openTab) {
        return { content: openTab.content || '', source: 'tab' };
    }
    if (!State.currentProject) {
        throw new Error('No project is currently loaded');
    }
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    const file = await Git.getFile(owner, repo, path, branch);
    return { content: file.content, source: 'remote' };
}
