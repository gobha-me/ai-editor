/**
 * Commit Modal Workflow
 * Open commit modal, generate messages, execute commit+push.
 * Extracted from ui-helpers.js in 0.9.13.
 */

import { State } from '../core.js';
import { batchSaveFiles } from '../git.js';
import { generateCommitMessage } from '../llm.js';
import { getFileIcon } from '../editor.js';
import { renderEditorTabs } from '../tab-manager.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { showToast, updateStatusBar, updateCommitButton } from '../ui-helpers.js';

// ============================================
// COMMIT MODAL
// ============================================

export function openCommitModal() {
    // Ensure current tab content is up-to-date
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        State.openTabs[State.activeTabIndex].content = State.editorContent;
        State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
    }

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
                <input type="checkbox" checked data-path="${escapeAttr(tab.path)}">
                <span class="commit-file-icon">${icon}</span>
                <span class="commit-file-path">${escapeHtml(tab.path)}</span>
            </label>
        `;
    }).join('');

    document.getElementById('btnDoCommit').textContent = `✅ Commit ${dirtyTabs.length} file(s)`;

    const commitModel = State.settings.commitModel || State.settings.llmModel;
    document.getElementById('commitModelInfo').textContent = 
        State.settings.commitModel 
            ? `Utility model: ${commitModel}` 
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
