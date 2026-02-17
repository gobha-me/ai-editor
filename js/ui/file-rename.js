/**
 * File Rename / Move Workflow
 * Modal for renaming or moving files within the repo.
 * Emits fs:renamed event for plugin hooks.
 */

import { State, EventBus, Storage } from '../core.js';
import { Git } from '../git.js';
import { showToast } from '../ui-helpers.js';

let currentOldPath = '';

// ============================================
// RENAME / MOVE MODAL
// ============================================

export function openRenameModal(path) {
    currentOldPath = path;
    const input = document.getElementById('renameFilePath');
    input.value = path;
    document.getElementById('renameFileModal').classList.add('active');

    // Enter to submit, Escape to close
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); closeRenameModal(); }
    };

    // Select just the filename portion for quick rename
    const lastSlash = path.lastIndexOf('/');
    const nameStart = lastSlash + 1;
    const dotIndex = path.lastIndexOf('.');
    const nameEnd = dotIndex > nameStart ? dotIndex : path.length;
    // Focus after the modal is visible
    requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(nameStart, nameEnd);
    });
}

export function closeRenameModal() {
    document.getElementById('renameFileModal').classList.remove('active');
    currentOldPath = '';
}

export async function submitRename() {
    const newPath = document.getElementById('renameFilePath').value.trim();

    if (!newPath) {
        showToast('Please enter a file path', 'warning');
        return;
    }
    if (newPath === currentOldPath) {
        closeRenameModal();
        return;
    }
    // Basic validation
    if (newPath.startsWith('/') || newPath.includes('//') || newPath.endsWith('/')) {
        showToast('Invalid path — no leading/trailing/double slashes', 'warning');
        return;
    }

    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch;
    const oldPath = currentOldPath;

    try {
        await Git.renameFile(owner, repo, oldPath, newPath,
            `Rename ${oldPath} → ${newPath}`, branch
        );

        // --- Migrate open tab ---
        const tabIndex = State.openTabs.findIndex(t => t.path === oldPath);
        if (tabIndex >= 0) {
            State.openTabs[tabIndex].path = newPath;
            // Update currentFile if this is the active tab
            if (tabIndex === State.activeTabIndex && State.currentFile) {
                State.currentFile.path = newPath;
            }
            const { renderEditorTabs } = await import('../tab-manager.js');
            renderEditorTabs();
        }

        // --- Migrate draft ---
        const draftContent = Storage.getDraft(owner, repo, branch, oldPath);
        if (draftContent !== null) {
            Storage.clearDraft(owner, repo, branch, oldPath);
            Storage.saveDraft(owner, repo, branch, newPath, draftContent);
        }

        // --- Emit fs hook event for plugins ---
        EventBus.emit('fs:renamed', { oldPath, newPath, branch });

        // --- Refresh tree ---
        EventBus.emit('tree:refresh');

        closeRenameModal();
        showToast(`Renamed → ${newPath}`, 'success');

    } catch (error) {
        console.error('Rename failed:', error);
        showToast(`Rename failed: ${error.message}`, 'error');
    }
}
