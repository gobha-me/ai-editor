/**
 * AI Editor — Commit Tools
 *
 * Allows the LLM to commit dirty editor tabs directly from chat.
 * Reuses the same generateCommitMessage + batchSaveFiles pipeline
 * as the manual commit modal, so the behavior is identical.
 */

import { ToolRegistry } from './registry.js';
import { State, EventBus, Storage } from '../core.js';
import { batchSaveFiles } from '../git.js';
import { generateCommitMessage, stripThinkBlocks } from '../llm.js';
import { getAutoCommittedSinceLastReport } from './_session-auto-commits.js';

// ============================================
// commit_files
// ============================================

async function commitFiles({ paths, message }) {
    if (!State.currentProject) {
        return { error: 'No project is currently loaded. Open a project first.' };
    }

    // Sync current editor content into its tab
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        State.openTabs[State.activeTabIndex].content = State.editorContent;
        State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
    }

    // Collect dirty tabs
    let dirtyTabs = State.openTabs.filter(t => t.dirty);

    if (dirtyTabs.length === 0) {
        // gitea#486 — even with no dirty tabs, write_file new-file calls
        // may have auto-committed files earlier in the session. Drain the
        // tracker so the model sees them instead of "all saved" alone.
        const autoCommitted = getAutoCommittedSinceLastReport();
        const response = {
            success: false,
            message: 'No dirty files to commit. All open files are already saved.'
        };
        if (autoCommitted.length > 0) {
            response.created = autoCommitted;
            response.message = `No dirty files to commit, but ${autoCommitted.length} file(s) were auto-committed earlier in this session by write_file.`;
        }
        return response;
    }

    // Optionally filter to specific paths
    if (paths && Array.isArray(paths) && paths.length > 0) {
        const requested = new Set(paths);
        dirtyTabs = dirtyTabs.filter(t => requested.has(t.path));

        if (dirtyTabs.length === 0) {
            const allDirty = State.openTabs.filter(t => t.dirty).map(t => t.path);
            return {
                success: false,
                message: `None of the requested paths are dirty. Currently dirty files: ${allDirty.join(', ') || 'none'}`
            };
        }
    }

    // Generate commit message if not provided
    let commitMsg = message?.trim();
    if (!commitMsg) {
        try {
            commitMsg = await generateCommitMessage(dirtyTabs);
        } catch (e) {
            // Fallback if LLM is unavailable (shouldn't happen, but be safe)
            const fileNames = dirtyTabs.map(t => t.path.split('/').pop()).join(', ');
            commitMsg = `Update ${fileNames}`;
        }
    }

    // Commit via the same pipeline as the commit modal
    try {
        const { results, errors } = await batchSaveFiles(commitMsg, dirtyTabs);

        // Update tab states (match commit modal behavior)
        for (const result of results) {
            const tab = State.openTabs.find(t => t.path === result.path);
            if (tab) {
                tab.dirty = false;
                tab.originalContent = tab.content;
            }
            // Update editor dirty state if the current file was committed
            if (State.currentFile && State.currentFile.path === result.path) {
                State.editorDirty = false;
            }
        }

        // Refresh UI.
        // Note: `tabs:render` retired at 2.24.1 — was an orphan emit with no
        // subscribers. Tab re-render after a successful commit happens via
        // `git:batchSaved` → ui-helpers.js → renderEditorTabs(); Now-strip's
        // dirty-count badge gets a per-path `tab:contentChanged` from
        // `js/git.js#batchSaveFiles` for each result.
        EventBus.emit('tree:refresh');

        const response = {
            success: true,
            message: commitMsg,
            committed: results.map(r => r.path),
            failed: errors.map(e => ({ path: e.path, error: e.message || String(e) }))
        };

        // gitea#486 — surface paths auto-committed by write_file's new-file
        // branch since the last commit_files call, so the model sees the
        // full picture instead of just the dirty-tab paths flushed by THIS
        // call.
        const autoCommitted = getAutoCommittedSinceLastReport();
        if (autoCommitted.length > 0) {
            response.created = autoCommitted;
        }

        if (errors.length > 0) {
            response.warning = `${errors.length} file(s) failed to commit`;
        }

        return response;

    } catch (error) {
        return { error: `Commit failed: ${error.message}` };
    }
}

ToolRegistry.register('commit_files', commitFiles, {
    type: 'function',
    function: {
        name: 'commit_files',
        description: 'Commit dirty (unsaved) files from the editor. **Provide `message` explicitly when you know what to write** (e.g., when this commit is the implementation of a known issue or follows a clear bug-fix shape) — auto-generation can misclassify small or stylistic changes (e.g., labeling a one-line behavior fix as a refactor). Lists dirty files if you want to see what would be committed before committing.',
        parameters: {
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional: specific file paths to commit. If omitted, ALL dirty files are committed.'
                },
                message: {
                    type: 'string',
                    description: 'Custom commit message (one-line, conventional-commit format, e.g. `fix(scope): description`). Prefer providing this explicitly; auto-generation is a fallback for callers with no context.'
                }
            },
            required: []
        }
    },
});

// ============================================
// list_dirty_files
// ============================================

async function listDirtyFiles() {
    // Sync current editor content into its tab
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        State.openTabs[State.activeTabIndex].content = State.editorContent;
        State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
    }

    const dirtyTabs = State.openTabs.filter(t => t.dirty);

    if (dirtyTabs.length === 0) {
        return { files: [], message: 'No dirty files. All open files match their committed versions.' };
    }

    return {
        files: dirtyTabs.map(t => {
            const original = t.originalContent || '';
            const current = t.content || '';
            const origLines = original.split('\n').length;
            const currLines = current.split('\n').length;
            return {
                path: t.path,
                lines_changed: Math.abs(currLines - origLines),
                size_bytes: current.length
            };
        }),
        message: `${dirtyTabs.length} file(s) with uncommitted changes`
    };
}

ToolRegistry.register('list_dirty_files', listDirtyFiles, {
    type: 'function',
    function: {
        name: 'list_dirty_files',
        description: 'List all files in the editor that have uncommitted changes. Use this to check what would be committed before calling commit_files.',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    readOnly: true,
    // gitea#472 — repo-wide aggregating read with no args. Result depends
    // on FS dirty state that any FILE_MUTATING_TOOLS call can change; the
    // path-keyed invalidator in `cache-invalidation.js` can't match a no-arg
    // entry, so the dup-cache held a stale `{files: []}` envelope across
    // intervening `edit_file` calls (live dogfood repro, 2026-05-20).
    cache: 'never',
});

export { commitFiles, listDirtyFiles };
