// ============================================
// UI HELPERS
// ============================================

import { State, EventBus, Storage } from './core.js';
import { GiteaAPI, batchSaveFiles } from './gitea.js';
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
        await GiteaAPI.createBranch(owner, repo, name, from);
        
        // Refresh branches and switch to new one
        State.branches = await GiteaAPI.listBranches(owner, repo);
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
        await GiteaAPI.createFile(owner, repo, path, '', `Create ${path}`, State.currentBranch);
        
        // Refresh file tree
        State.fileTree = await GiteaAPI.getFileTree(owner, repo, State.currentBranch);
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
// REVERT BUTTON
// ============================================

export function updateRevertButton() {
    const btn = document.getElementById('btnRevert');
    btn.disabled = !(State.currentFile && State.editorDirty);
}

export async function revertCurrentFile() {
    if (!State.currentFile) return;
    
    const tab = State.openTabs[State.activeTabIndex];
    if (!tab) return;

    const originalContent = tab.originalContent;
    if (originalContent === undefined || originalContent === null) {
        showToast('No original content to revert to', 'warning');
        return;
    }

    if (!confirm(`Revert "${tab.path}" to last committed version? All local changes will be lost.`)) {
        return;
    }

    // Reset editor to original content
    const { createEditor } = await import('./editor.js');
    State.editorContent = originalContent;
    State.editorDirty = false;
    tab.content = originalContent;
    tab.dirty = false;

    // Clear the draft from localStorage
    if (State.currentProject) {
        const { owner, repo } = State.currentProject;
        Storage.clearDraft(owner, repo, State.currentBranch, tab.path);
    }

    await createEditor(
        document.getElementById('editorContainer'),
        originalContent,
        tab.path
    );

    renderEditorTabs();
    updateStatusBar();
    updateCommitButton();
    updateRevertButton();
    showToast(`Reverted ${tab.path.split('/').pop()}`, 'success');
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
    EventBus.on('gitea:saved', () => {
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
    EventBus.on('gitea:batchSaved', ({ results, errors }) => {
        updateCommitButton();
        updateRevertButton();
        renderEditorTabs();
    });
    EventBus.on('gitea:error', (error) => {
        showToast(error.message, 'error');
    });
}
