/**
 * UI Helpers — Shared Utilities
 *
 * Small, widely-used UI functions that other ui/* modules depend on.
 * Modal workflows extracted to sub-modules in 0.9.13:
 *   ui/commit.js      — Commit modal workflow
 *   ui/revert.js      — Revert workflow  
 *   ui/branch.js      — Branch creation
 *   ui/file-create.js — New file creation
 */

import { State, EventBus, Storage } from './core.js';
import { renderEditorTabs } from './tab-manager.js';

// ============================================
// PANEL TOGGLES
// ============================================

export function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('resizeHandleSidebar');
    const edgeTab = document.getElementById('sidebarExpandTab');
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        // Delegate to mobile module
        import('./mobile.js').then(m => {
            if (sidebar?.classList.contains('mobile-active')) {
                m.mobileShowPanel('editor');
            } else {
                m.mobileShowPanel('sidebar');
            }
        });
    } else {
        const hiding = !sidebar.classList.contains('hidden');
        sidebar.classList.toggle('hidden');
        if (handle) handle.style.display = hiding ? 'none' : '';
        if (edgeTab) edgeTab.style.display = hiding ? '' : 'none';
        Storage.set('sidebarHidden', hiding);
    }
}

export function toggleChat() {
    const chatPanel = document.getElementById('chatPanel');
    const handle = document.getElementById('resizeHandleChat');
    const edgeTab = document.getElementById('chatExpandTab');
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        import('./mobile.js').then(m => {
            if (chatPanel?.classList.contains('mobile-active')) {
                m.mobileShowPanel('editor');
            } else {
                m.mobileShowPanel('chat');
            }
        });
    } else {
        const hiding = !chatPanel.classList.contains('hidden');
        chatPanel.classList.toggle('hidden');
        if (handle) handle.style.display = hiding ? 'none' : '';
        if (edgeTab) edgeTab.style.display = hiding ? '' : 'none';
        Storage.set('chatHidden', hiding);
    }
}

// ============================================
// STATUS BAR & TOAST
// ============================================

export function updateStatusBar() {
    const fileEl = document.getElementById('statusFile');
    const modifiedEl = document.getElementById('statusModified');
    if (fileEl) fileEl.textContent = State.currentFile ? State.currentFile.path : 'No file open';
    if (modifiedEl) modifiedEl.textContent = State.editorDirty ? '● Modified' : '';
}

export function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => toast.remove(), 4000);
}

export function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
    document.getElementById('quickOpenOverlay')?.classList.remove('active');
    document.getElementById('searchPanel')?.classList.remove('active');
}

// ============================================
// DRAFT MANAGEMENT
// ============================================

export async function clearAllDrafts() {
    const drafts = Storage.listDrafts();
    const count = drafts.length;
    
    if (count === 0) {
        showToast('No drafts to clear', 'info');
        return;
    }
    
    const { showConfirm } = await import('./ui/dialogs.js');
    if (!await showConfirm(`Clear ALL ${count} draft(s) from storage?\n\nThis will remove any unsaved changes stored locally.`, { title: 'Clear Drafts', okLabel: 'Clear All', variant: 'danger' })) {
        return;
    }
    
    drafts.forEach(draft => {
        const path = draft.path;
        const parts = path.split('/');
        if (parts.length >= 4) {
            const owner = parts[0];
            const repo = parts[1];
            const branch = parts[2];
            const filePath = parts.slice(3).join('/');
            Storage.clearDraft(owner, repo, branch, filePath);
        }
    });
    
    State.drafts = {};
    
    showToast(`Cleared ${count} draft(s)`, 'success');
    console.log(`[DRAFTS] Cleared ${count} drafts`);
}

export async function clearProjectDrafts() {
    if (!State.currentProject) {
        showToast('No project selected', 'warning');
        return;
    }
    
    const { owner, repo } = State.currentProject;
    const allDrafts = Storage.listDrafts();
    const projectPrefix = `${owner}/${repo}/`;
    const projectDrafts = allDrafts.filter(d => d.path.startsWith(projectPrefix));
    const count = projectDrafts.length;
    
    if (count === 0) {
        showToast('No drafts for this project', 'info');
        return;
    }
    
    const { showConfirm } = await import('./ui/dialogs.js');
    if (!await showConfirm(`Clear ${count} draft(s) for ${owner}/${repo}? This cannot be undone.`, { title: 'Clear Project Drafts', okLabel: 'Clear', variant: 'danger' })) {
        return;
    }
    
    projectDrafts.forEach(draft => {
        const path = draft.path;
        const parts = path.split('/');
        if (parts.length >= 4) {
            const branch = parts[2];
            const filePath = parts.slice(3).join('/');
            Storage.clearDraft(owner, repo, branch, filePath);
        }
    });
    
    showToast(`Cleared ${count} draft(s) for current project`, 'success');
    console.log(`[DRAFTS] Cleared ${count} project drafts`);
}

// ============================================
// COMMIT / REVERT BUTTON STATE
// ============================================

export function updateCommitButton() {
    const btn = document.getElementById('btnCommit');
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        State.openTabs[State.activeTabIndex].content = State.editorContent;
        State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
    }
    const dirtyCount = State.openTabs.filter(t => t.dirty).length;
    if (dirtyCount > 0) {
        btn.style.display = 'inline-flex';
        btn.textContent = `📦 Commit (${dirtyCount})`;
    } else {
        btn.style.display = 'none';
    }
}

export function updateRevertButton() {
    const btn = document.getElementById('btnRevert');
    const dirtyCount = State.openTabs.filter(t => t.dirty).length;
    
    if (dirtyCount === 0) {
        btn.disabled = true;
        btn.textContent = '↩️ Revert';
        btn.title = 'Revert to last commit';
    } else if (dirtyCount === 1) {
        btn.disabled = false;
        btn.textContent = '↩️ Revert';
        btn.title = 'Revert current file to last commit';
    } else {
        btn.disabled = false;
        btn.textContent = `↩️ Revert (${dirtyCount})`;
        btn.title = `Revert ${dirtyCount} modified files to last commit`;
    }
}

// ============================================
// STATUS BAR EVENT LISTENER
// ============================================

export function initStatusBarListener() {
    EventBus.on('statusBar:update', updateStatusBar);
    EventBus.on('editor:change', () => {
        updateStatusBar();
        updateCommitButton();
        updateRevertButton();
    });
    EventBus.on('git:saved', () => {
        updateCommitButton();
        updateRevertButton();
        if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
            State.openTabs[State.activeTabIndex].dirty = false;
            State.openTabs[State.activeTabIndex].content = State.editorContent;
            State.openTabs[State.activeTabIndex].originalContent = State.editorContent;
            State.openTabs[State.activeTabIndex].sha = State.currentFile?.sha;
            renderEditorTabs();
        }
        showToast('File saved successfully', 'success');
    });
    EventBus.on('git:batchSaved', ({ results, errors }) => {
        updateCommitButton();
        updateRevertButton();
        renderEditorTabs();
    });
    EventBus.on('git:error', (error) => {
        showToast(error.message, 'error');
    });
}
