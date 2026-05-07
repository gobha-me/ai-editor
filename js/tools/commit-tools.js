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
        return {
            success: false,
            message: 'No dirty files to commit. All open files are already saved.'
        };
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

        // Refresh UI
        EventBus.emit('tabs:render');
        EventBus.emit('tree:refresh');

        const response = {
            success: true,
            message: commitMsg,
            committed: results.map(r => r.path),
            failed: errors.map(e => ({ path: e.path, error: e.message || String(e) }))
        };

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
        description: 'Commit dirty (unsaved) files from the editor to the Git repository. Generates an AI commit message automatically if none is provided. Lists dirty files if you want to see what would be committed before committing.',
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
                    description: 'Optional: custom commit message. If omitted, an AI-generated conventional commit message is used.'
                }
            },
            required: []
        }
    },
    roles: ['coder']  // Only coder role can commit
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
    roles: ['coder'],  // Read-only but scoped to coder workflow
    readOnly: true
});

export { commitFiles, listDirtyFiles };
