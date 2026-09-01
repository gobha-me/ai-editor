/**
 * File Rename / Move Workflow
 * Modal for renaming or moving files within the repo.
 * Emits fs:renamed event for plugin hooks.
 */

import { State, EventBus, Storage } from '../core.js';
import { Git } from '../git.js';
import { showToast } from '../ui-helpers.js';

let currentOldPath = '';
let currentIsFolder = false;

// ============================================
// RENAME / MOVE MODAL
// ============================================

export function openRenameModal(path, isFolder = false) {
    currentOldPath = path;
    currentIsFolder = isFolder;
    const input = document.getElementById('renameFilePath');
    input.value = path;
    document.getElementById('renameFileModal').classList.add('active');

    // Update modal title hint
    const titleEl = document.querySelector('#renameFileModal .modal-title, #renameFileModal h3');
    if (titleEl) {
        titleEl.textContent = isFolder ? 'Rename / Move Folder' : 'Rename / Move File';
    }

    // Enter to submit, Escape to close
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); closeRenameModal(); }
    };

    if (isFolder) {
        // Select the folder name (last segment)
        const lastSlash = path.lastIndexOf('/');
        const nameStart = lastSlash + 1;
        requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(nameStart, path.length);
        });
    } else {
        // Select just the filename portion for quick rename
        const lastSlash = path.lastIndexOf('/');
        const nameStart = lastSlash + 1;
        const dotIndex = path.lastIndexOf('.');
        const nameEnd = dotIndex > nameStart ? dotIndex : path.length;
        requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(nameStart, nameEnd);
        });
    }
}

export function closeRenameModal() {
    document.getElementById('renameFileModal').classList.remove('active');
    currentOldPath = '';
    currentIsFolder = false;
}

/**
 * Bind a delegated click handler for the rename modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * Phase 2a of the inline-handlers migration (DESIGN-ui-event-dispatch.md).
 */
let _wired = false;
export function mountRenameModal({ onClose, onSubmit } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#renameFileModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeRenameModal' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'submitRename' && typeof onSubmit === 'function') {
            onSubmit();
        }
    });
}

export async function submitRename() {
    const newPath = document.getElementById('renameFilePath').value.trim();

    if (!newPath) {
        showToast('Please enter a path', 'warning');
        return;
    }
    if (newPath === currentOldPath) {
        closeRenameModal();
        return;
    }
    // Basic validation
    if (newPath.startsWith('/') || newPath.includes('//')) {
        showToast('Invalid path — no leading slashes or double slashes', 'warning');
        return;
    }
    // Files shouldn't end with /, folders are fine either way (we normalize)
    if (!currentIsFolder && newPath.endsWith('/')) {
        showToast('Invalid file path — cannot end with /', 'warning');
        return;
    }

    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch;
    const oldPath = currentOldPath;
    const cleanNewPath = newPath.replace(/\/+$/, ''); // Strip trailing slash for folders

    try {
        if (currentIsFolder) {
            await _submitFolderRename(owner, repo, oldPath, cleanNewPath, branch);
        } else {
            await _submitFileRename(owner, repo, oldPath, cleanNewPath, branch);
        }
    } catch (error) {
        console.error('Rename failed:', error);
        showToast(`Rename failed: ${error.message}`, 'error');
    }
}

async function _submitFileRename(owner, repo, oldPath, newPath, branch) {
    await Git.renameFile(owner, repo, oldPath, newPath,
        `Rename ${oldPath} → ${newPath}`, branch
    );

    // --- Migrate open tab ---
    const tabIndex = State.openTabs.findIndex(t => t.path === oldPath);
    if (tabIndex >= 0) {
        State.openTabs[tabIndex].path = newPath;
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

    EventBus.emit('fs:renamed', { oldPath, newPath, branch });
    EventBus.emit('tree:refresh');
    closeRenameModal();
    showToast(`Renamed → ${newPath}`, 'success');
}

async function _submitFolderRename(owner, repo, oldFolder, newFolder, branch) {
    const prefix = oldFolder.endsWith('/') ? oldFolder : oldFolder + '/';
    const fileCount = (State.fileTree || []).filter(f => f.type === 'file' && f.path.startsWith(prefix)).length;

    const result = await Git.renameFolder(owner, repo, oldFolder, newFolder,
        `Rename ${oldFolder}/ → ${newFolder}/ (${fileCount} files)`, branch
    );

    // --- Migrate open tabs ---
    let tabsMigrated = 0;
    for (const tab of State.openTabs) {
        if (tab.path.startsWith(prefix)) {
            const newTabPath = newFolder + tab.path.slice(oldFolder.length);
            tab.path = newTabPath;
            tabsMigrated++;
        }
    }
    if (State.activeTabIndex >= 0 && State.currentFile?.path?.startsWith(prefix)) {
        State.currentFile.path = newFolder + State.currentFile.path.slice(oldFolder.length);
    }
    if (tabsMigrated > 0) {
        const { renderEditorTabs } = await import('../tab-manager.js');
        renderEditorTabs();
    }

    // --- Migrate drafts ---
    const affectedFiles = (State.fileTree || []).filter(f => f.type === 'file' && f.path.startsWith(prefix));
    for (const file of affectedFiles) {
        const draft = Storage.getDraft(owner, repo, branch, file.path);
        if (draft !== null) {
            Storage.clearDraft(owner, repo, branch, file.path);
            const newFilePath = newFolder + file.path.slice(oldFolder.length);
            Storage.saveDraft(owner, repo, branch, newFilePath, draft);
        }
    }

    EventBus.emit('fs:renamed', { oldPath: oldFolder, newPath: newFolder, branch, isFolder: true });
    EventBus.emit('tree:refresh');
    closeRenameModal();

    if (result.errors > 0) {
        showToast(`Moved ${result.moved} files, ${result.errors} failed`, 'warning');
    } else {
        showToast(`Moved folder → ${newFolder}/ (${result.moved} files)`, 'success');
    }
}
