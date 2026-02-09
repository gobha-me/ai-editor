// ============================================
// UI HELPERS
// ============================================

import { State, EventBus, Storage } from './core.js';
import { Git, batchSaveFiles } from './git.js';
import { generateCommitMessage } from './llm.js';
import { getFileIcon } from './editor.js';
import { renderEditorTabs } from './tab-manager.js';

export function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('resizeHandleSidebar');
    const isMobile = window.innerWidth <= 900;
    
    if (isMobile) {
        sidebar.classList.toggle('open');
    } else {
        const hiding = !sidebar.classList.contains('hidden');
        sidebar.classList.toggle('hidden');
        if (handle) handle.style.display = hiding ? 'none' : '';
        Storage.set('sidebarHidden', hiding);
    }
}

export function toggleChat() {
    const chatPanel = document.getElementById('chatPanel');
    const handle = document.getElementById('resizeHandleChat');
    const isMobile = window.innerWidth <= 900;
    
    if (isMobile) {
        chatPanel.classList.toggle('open');
    } else {
        const hiding = !chatPanel.classList.contains('hidden');
        chatPanel.classList.toggle('hidden');
        if (handle) handle.style.display = hiding ? 'none' : '';
        Storage.set('chatHidden', hiding);
    }
}

export function updateStatusBar() {
    const fileEl = document.getElementById('statusFile');
    const modifiedEl = document.getElementById('statusModified');
    const branchEl = document.getElementById('statusBranch');

    fileEl.textContent = State.currentFile?.path || 'No file open';
    modifiedEl.textContent = State.editorDirty ? '● Modified' : '';
    modifiedEl.className = `status-item ${State.editorDirty ? 'modified' : 'saved'}`;
    branchEl.textContent = State.currentBranch || 'main';
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
// DRAFT MANAGEMENT - CLEAR ALL STALE DRAFTS
// ============================================

/**
 * Clear ALL drafts from localStorage
 * Use this to fix stale draft issues
 */
export function clearAllDrafts() {
    const drafts = Storage.listDrafts();
    const count = drafts.length;
    
    if (count === 0) {
        showToast('No drafts to clear', 'info');
        return;
    }
    
    if (!confirm(`Clear ALL ${count} draft(s) from localStorage? This cannot be undone.\n\nThis will remove any unsaved changes stored locally.`)) {
        return;
    }
    
    // Clear each draft
    drafts.forEach(draft => {
        const path = draft.path;
        // Extract owner/repo/branch/file from the path
        const parts = path.split('/');
        if (parts.length >= 4) {
            const owner = parts[0];
            const repo = parts[1];
            const branch = parts[2];
            const filePath = parts.slice(3).join('/');
            Storage.clearDraft(owner, repo, branch, filePath);
        }
    });
    
    // Also clear the in-memory drafts object
    State.drafts = {};
    
    showToast(`Cleared ${count} draft(s) from localStorage`, 'success');
    console.log(`[DRAFTS] Cleared ${count} drafts from localStorage`);
}

/**
 * Clear drafts for current project only
 */
export function clearProjectDrafts() {
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
    
    if (!confirm(`Clear ${count} draft(s) for ${owner}/${repo}? This cannot be undone.`)) {
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
// COMMIT MODAL
// ============================================

export function openCommitModal() {
    // Ensure current tab content is up-to-date
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        State.openTabs[State.activeTabIndex].content = State.editorContent;
        State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
    }

    // Build the changed files list
    const dirtyTabs = State.openTabs.filter(t => t.dirty);
    const fileListEl = document.getElementById('commitFileList');
    
    if (dirtyTabs.length === 0) {
        showToast('No changes to commit', 'warning');
        return;
    }

    fileListEl.innerHTML = dirtyTabs.map((tab, i) => {
        const fileName = tab.path.split('/').pop();
        const icon = getFileIcon(fileName);
        return `
            <label class="commit-file-item">
                <input type="checkbox" checked data-path="${tab.path}">
                <span class="commit-file-icon">${icon}</span>
                <span class="commit-file-path">${tab.path}</span>
            </label>
        `;
    }).join('');

    // Update commit button text
    document.getElementById('btnDoCommit').textContent = `✅ Commit ${dirtyTabs.length} file(s)`;

    // Show which model will be used for commit messages
    const commitModel = State.settings.commitModel || State.settings.llmModel;
    document.getElementById('commitModelInfo').textContent = 
        State.settings.commitModel 
            ? `Commit model: ${commitModel}` 
            : `Using default model: ${commitModel}`;

    document.getElementById('commitModal').classList.add('active');
}

export function closeCommitModal() {
    document.getElementById('commitModal').classList.remove('active');
}

export async function generateCommitMsg() {
    const textarea = document.getElementById('commitMessage');
    textarea.value = 'Generating...';
    textarea.disabled = true;
    
    try {
        // Get checked dirty files for context
        const checkedPaths = getCheckedCommitFiles();
        const dirtyTabs = State.openTabs.filter(t => checkedPaths.includes(t.path));
        
        const msg = await generateCommitMessage(dirtyTabs);
        textarea.value = msg;
    } catch (error) {
        textarea.value = '';
        showToast('Failed to generate commit message: ' + error.message, 'error');
    }
    
    textarea.disabled = false;
}

function getCheckedCommitFiles() {
    const checkboxes = document.querySelectorAll('#commitFileList input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.dataset.path);
}

export async function commitAndPush() {
    const message = document.getElementById('commitMessage').value.trim();
    
    if (!message) {
        showToast('Please enter a commit message', 'warning');
        return;
    }

    const checkedPaths = getCheckedCommitFiles();
    if (checkedPaths.length === 0) {
        showToast('No files selected', 'warning');
        return;
    }

    // Get the dirty tabs that are checked
    const tabsToCommit = State.openTabs.filter(t => checkedPaths.includes(t.path) && t.dirty);

    if (tabsToCommit.length === 0) {
        showToast('No changes to commit', 'warning');
        return;
    }

    const commitBtn = document.getElementById('btnDoCommit');
    commitBtn.disabled = true;
    commitBtn.textContent = '⏳ Committing...';

    try {
        const { results, errors } = await batchSaveFiles(message, tabsToCommit);
        
        if (results.length > 0) {
            showToast(`Committed ${results.length} file(s)`, 'success');
        }
        if (errors.length > 0) {
            showToast(`${errors.length} file(s) failed to commit`, 'error');
        }

        // Update tab states and re-render
        renderEditorTabs();
        updateCommitButton();
        updateStatusBar();

        closeCommitModal();
        document.getElementById('commitMessage').value = '';
    } catch (error) {
        showToast('Commit failed: ' + error.message, 'error');
    }

    commitBtn.disabled = false;
    commitBtn.textContent = `✅ Commit ${tabsToCommit.length} file(s)`;
}

// ============================================
// NEW BRANCH MODAL
// ============================================

export function openNewBranchModal() {
    const fromSelect = document.getElementById('newBranchFrom');
    fromSelect.innerHTML = State.branches.map(b => 
        `<option value="${b.name}">${b.name}</option>`
    ).join('');
    document.getElementById('newBranchModal').classList.add('active');
}

export function closeNewBranchModal() {
    document.getElementById('newBranchModal').classList.remove('active');
}

export async function createNewBranch() {
    let name = document.getElementById('newBranchName').value.trim();
    const from = document.getElementById('newBranchFrom').value || State.currentBranch || 'main';
    
    if (!name) {
        showToast('Please enter a branch name', 'warning');
        return;
    }

    // Sanitize for git ref naming rules
    name = name
        .replace(/[\s~^:?*\[\]\\@{}"'<>|]/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]/, '')
        .replace(/[-.]+$/, '')
        .replace(/\.lock$/i, '');
    
    if (!name) {
        showToast('Branch name contains only invalid characters', 'warning');
        return;
    }

    document.getElementById('newBranchName').value = name;
    
    const { owner, repo } = State.currentProject;
    
    try {
        await Git.createBranch(owner, repo, name, from);
        
        // Refresh branches and switch to new one
        State.branches = await Git.listBranches(owner, repo);
        State.currentBranch = name;
        
        const branchSelect = document.getElementById('branchSelect');
        branchSelect.innerHTML = State.branches.map(b => 
            `<option value="${b.name}">${b.name}${b.protected ? ' 🔒' : ''}</option>`
        ).join('');
        branchSelect.value = name;

        closeNewBranchModal();
        showToast(`Created branch: ${name}`, 'success');
    } catch (error) {
        showToast(`Failed to create branch: ${error.message || error}`, 'error');
        console.error('Branch creation error:', error);
    }
}

// ============================================
// NEW FILE MODAL
// ============================================

export function openNewFileModal() {
    document.getElementById('newFileModal').classList.add('active');
}

export function closeNewFileModal() {
    document.getElementById('newFileModal').classList.remove('active');
}

export async function createNewFile() {
    const path = document.getElementById('newFileName').value.trim();
    
    if (!path) {
        showToast('Please enter a file path', 'warning');
        return;
    }

    const { owner, repo } = State.currentProject;
    
    try {
        await Git.createFile(owner, repo, path, '', `Create ${path}`, State.currentBranch);
        
        // Refresh file tree
        EventBus.emit('tree:refresh');
        
        closeNewFileModal();
        showToast(`Created: ${path}`, 'success');
        
        // Open the new file
        window.onTreeItemClick(path, 'file');
    } catch (error) {
        showToast('Failed to create file', 'error');
    }
}

// ============================================
// COMMIT BUTTON
// ============================================

export function updateCommitButton() {
    const btn = document.getElementById('btnCommit');
    // Ensure current tab is reflected
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

// ============================================
// REVERT FUNCTIONALITY - SINGLE & MULTIPLE
// ============================================

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

/**
 * Revert current file OR all dirty tabs if multiple are modified
 */
export async function revertCurrentFile() {
    const dirtyTabs = State.openTabs.filter(t => t.dirty);
    
    if (dirtyTabs.length === 0) {
        showToast('No changes to revert', 'info');
        return;
    }
    
    // If only one dirty file, revert just that
    if (dirtyTabs.length === 1) {
        await revertSingleTab(dirtyTabs[0]);
        return;
    }
    
    // Multiple dirty files - show choice modal
    openRevertModal(dirtyTabs);
}

/**
 * Revert a single tab to its original content
 */
async function revertSingleTab(tab) {
    const originalContent = tab.originalContent;
    if (originalContent === undefined || originalContent === null) {
        showToast('No original content to revert to', 'warning');
        return;
    }

    if (!confirm(`Revert "${tab.path}" to last committed version? All local changes will be lost.`)) {
        return;
    }

    // Reset tab to original content
    tab.content = originalContent;
    tab.dirty = false;

    // Clear the draft from localStorage
    if (State.currentProject) {
        const { owner, repo } = State.currentProject;
        Storage.clearDraft(owner, repo, State.currentBranch, tab.path);
    }

    // If this is the active tab, update editor
    const tabIndex = State.openTabs.indexOf(tab);
    if (tabIndex === State.activeTabIndex) {
        const { createEditor } = await import('./editor.js');
        State.editorContent = originalContent;
        State.editorDirty = false;

        await createEditor(
            document.getElementById('editorContainer'),
            originalContent,
            tab.path
        );
        
        // Notify listeners that file was reverted (NOT editor:change,
        // which would re-dirty the tab via core.js and tab-manager.js)
        EventBus.emit('file:reverted', { path: tab.path });
    }

    renderEditorTabs();
    updateStatusBar();
    updateCommitButton();
    updateRevertButton();
    showToast(`Reverted ${tab.path.split('/').pop()}`, 'success');
}

/**
 * Open modal to choose: revert current, revert all, or cancel
 */
function openRevertModal(dirtyTabs) {
    const modal = document.getElementById('revertModal');
    const fileListEl = document.getElementById('revertFileList');
    const currentTab = State.openTabs[State.activeTabIndex];
    
    // Show list of dirty files
    fileListEl.innerHTML = dirtyTabs.map(tab => {
        const fileName = tab.path.split('/').pop();
        const icon = getFileIcon(fileName);
        const isCurrent = tab === currentTab;
        return `
            <div class="revert-file-item ${isCurrent ? 'current' : ''}">
                <span class="revert-file-icon">${icon}</span>
                <span class="revert-file-path">${tab.path}</span>
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
    
    if (!confirm(`Revert ALL ${dirtyTabs.length} file(s) to last committed version? This cannot be undone.`)) {
        return;
    }
    
    let revertedCount = 0;
    const { owner, repo } = State.currentProject;
    
    // Revert each dirty tab
    for (const tab of dirtyTabs) {
        if (tab.originalContent !== undefined && tab.originalContent !== null) {
            tab.content = tab.originalContent;
            tab.dirty = false;
            
            // Clear draft from localStorage
            if (State.currentProject) {
                Storage.clearDraft(owner, repo, State.currentBranch, tab.path);
            }
            
            revertedCount++;
        }
    }
    
    // Update editor if current tab was reverted
    const currentTab = State.openTabs[State.activeTabIndex];
    if (currentTab && !currentTab.dirty) {
        const { createEditor } = await import('./editor.js');
        State.editorContent = currentTab.originalContent;
        State.editorDirty = false;

        await createEditor(
            document.getElementById('editorContainer'),
            State.editorContent,
            currentTab.path
        );
        
        // Notify listeners that file was reverted (NOT editor:change,
        // which would re-dirty the tab via core.js and tab-manager.js)
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
        // Update tab dirty state
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
