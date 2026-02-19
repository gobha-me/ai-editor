/**
 * Revert Workflow
 * Single-file and batch revert with confirmation modal.
 * Extracted from ui-helpers.js in 0.9.13.
 */

import { State, EventBus, Storage } from '../core.js';
import { getFileIcon } from '../editor.js';
import { renderEditorTabs } from '../tab-manager.js';
import { escapeHtml } from '../utils/html.js';
import { showToast, updateStatusBar, updateCommitButton, updateRevertButton } from '../ui-helpers.js';
import { showConfirm } from './dialogs.js';

// ============================================
// REVERT ENTRY POINT
// ============================================

/**
 * Revert current file OR all dirty tabs if multiple are modified
 */
export async function revertCurrentFile() {
    const dirtyTabs = State.openTabs.filter(t => t.dirty);
    
    if (dirtyTabs.length === 0) {
        showToast('No changes to revert', 'info');
        return;
    }
    
    if (dirtyTabs.length === 1) {
        await revertSingleTab(dirtyTabs[0]);
        return;
    }
    
    openRevertModal(dirtyTabs);
}

// ============================================
// SINGLE TAB REVERT
// ============================================

async function revertSingleTab(tab) {
    const originalContent = tab.originalContent;
    if (originalContent === undefined || originalContent === null) {
        showToast('No original content to revert to', 'warning');
        return;
    }

    if (!await showConfirm(`Revert "${tab.path.split('/').pop()}" to last committed version? All local changes will be lost.`, { title: 'Revert File', okLabel: 'Revert', variant: 'danger' })) {
        return;
    }

    tab.content = originalContent;
    tab.dirty = false;

    if (State.currentProject) {
        const { owner, repo } = State.currentProject;
        Storage.clearDraft(owner, repo, State.currentBranch, tab.path);
    }

    const tabIndex = State.openTabs.indexOf(tab);
    if (tabIndex === State.activeTabIndex) {
        const { createEditor } = await import('../editor.js');
        State.editorContent = originalContent;
        State.editorDirty = false;

        await createEditor(
            document.getElementById('editorContainer'),
            originalContent,
            tab.path
        );
        
        EventBus.emit('file:reverted', { path: tab.path });
    }

    renderEditorTabs();
    updateStatusBar();
    updateCommitButton();
    updateRevertButton();
    showToast(`Reverted ${tab.path.split('/').pop()}`, 'success');
}

// ============================================
// REVERT MODAL (multi-file choice)
// ============================================

function openRevertModal(dirtyTabs) {
    const modal = document.getElementById('revertModal');
    const fileListEl = document.getElementById('revertFileList');
    const currentTab = State.openTabs[State.activeTabIndex];
    
    fileListEl.innerHTML = dirtyTabs.map(tab => {
        const fileName = tab.path.split('/').pop();
        const icon = getFileIcon(fileName);
        const isCurrent = tab === currentTab;
        return `
            <div class="revert-file-item ${isCurrent ? 'current' : ''}">
                <span class="revert-file-icon">${icon}</span>
                <span class="revert-file-path">${escapeHtml(tab.path)}</span>
                ${isCurrent ? '<span class="revert-current-badge">● Current</span>' : ''}
            </div>
        `;
    }).join('');
    
    modal.classList.add('active');
}

export function closeRevertModal() {
    document.getElementById('revertModal').classList.remove('active');
}

/**
 * Revert all dirty tabs to their original content
 */
export async function revertAllFiles() {
    const dirtyTabs = State.openTabs.filter(t => t.dirty);
    
    if (dirtyTabs.length === 0) {
        showToast('No changes to revert', 'info');
        closeRevertModal();
        return;
    }
    
    if (!await showConfirm(`Revert ALL ${dirtyTabs.length} file(s) to last committed version? This cannot be undone.`, { title: 'Revert All', okLabel: 'Revert All', variant: 'danger' })) {
        return;
    }
    
    let revertedCount = 0;
    const { owner, repo } = State.currentProject;
    
    for (const tab of dirtyTabs) {
        if (tab.originalContent !== undefined && tab.originalContent !== null) {
            tab.content = tab.originalContent;
            tab.dirty = false;
            
            if (State.currentProject) {
                Storage.clearDraft(owner, repo, State.currentBranch, tab.path);
            }
            
            revertedCount++;
        }
    }
    
    const currentTab = State.openTabs[State.activeTabIndex];
    if (currentTab && !currentTab.dirty) {
        const { createEditor } = await import('../editor.js');
        State.editorContent = currentTab.originalContent;
        State.editorDirty = false;

        await createEditor(
            document.getElementById('editorContainer'),
            State.editorContent,
            currentTab.path
        );
        
        EventBus.emit('file:reverted', { path: currentTab.path });
    }
    
    renderEditorTabs();
    updateStatusBar();
    updateCommitButton();
    updateRevertButton();
    closeRevertModal();
    
    showToast(`Reverted ${revertedCount} file(s)`, 'success');
    console.log(`[REVERT] Reverted ${revertedCount} files to original content`);
}

/**
 * Revert only the current tab
 */
export async function revertOnlyCurrentFile() {
    const currentTab = State.openTabs[State.activeTabIndex];
    if (!currentTab) {
        showToast('No file open', 'warning');
        closeRevertModal();
        return;
    }
    
    closeRevertModal();
    await revertSingleTab(currentTab);
}
