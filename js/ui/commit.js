/**
 * Commit Modal Workflow
 * Open commit modal, generate messages, execute commit+push.
 * Extracted from ui-helpers.js in 0.9.13.
 */

import { State, EventBus } from '../core.js';
import { batchSaveFiles } from '../git.js';
import { generateCommitMessage } from '../llm.js';
import { getFileIcon } from '../editor.js';
import { renderEditorTabs } from '../tab-manager.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { showToast, updateStatusBar, updateCommitButton } from '../ui-helpers.js';
import {
    isEnabled as memoryFileLayerIsEnabled,
    listPendingPaths as memoryListPendingPaths,
    getPendingContent as memoryGetPendingContent,
    discardPendingMemoryWrites,
} from '../intelligence/memory/index.js';
import {
    renderMemoryUpdatesSection,
    wireMemoryUpdatesSection,
} from './commit-memory-section.js';

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

    _renderMemorySection();

    const isProtected = _currentBranchIsProtected();
    const memCount = (memoryFileLayerIsEnabled() ? memoryListPendingPaths().length : 0);
    document.getElementById('btnDoCommit').textContent =
        (isProtected && memCount > 0)
            ? `✅ Commit ${dirtyTabs.length} file(s) (code only)`
            : `✅ Commit ${dirtyTabs.length} file(s)`;

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

function _currentBranchIsProtected() {
    const branches = Array.isArray(State.branches) ? State.branches : [];
    const cur = branches.find((b) => b && b.name === State.currentBranch);
    return cur ? Boolean(cur.protected) : false;
}

function _renderMemorySection() {
    const root = document.getElementById('commitMemorySection');
    if (!root) return;

    if (!memoryFileLayerIsEnabled()) {
        root.innerHTML = '';
        return;
    }
    const pendingPaths = memoryListPendingPaths();
    if (pendingPaths.length === 0) {
        root.innerHTML = '';
        return;
    }

    const isProtected = _currentBranchIsProtected();
    root.innerHTML = renderMemoryUpdatesSection({
        isProtected,
        pendingPaths,
        branch: State.currentBranch || '',
    });
    wireMemoryUpdatesSection(root, { closeModal: closeCommitModal });
}

export async function generateCommitMsg() {
    const textarea = document.getElementById('commitMessage');
    textarea.value = 'Generating...';
    textarea.disabled = true;
    
    try {
        const checkedPaths = getCheckedCommitFiles();
        const dirtyTabs = State.openTabs.filter(t => checkedPaths.includes(t.path));
        
        const msg = await generateCommitMessage(dirtyTabs);
        textarea.value = msg || '';
        if (!msg) {
            showToast('Commit message generation returned empty — model may have used think blocks only', 'warning');
        }
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

    // Touch 1 Flow 3A: auto-stage pending memory files when the file
    // layer is enabled and the current branch isn't protected.
    // Flow 3B (protected) skips this — pending paths surfaced as a
    // disabled warning section in the modal; the user must use the
    // escape-hatch buttons or switch branches first.
    const memoryPaths = (
        memoryFileLayerIsEnabled() && !_currentBranchIsProtected()
            ? memoryListPendingPaths()
            : []
    );
    const memoryPseudoTabs = memoryPaths.map((path) => ({
        path,
        content: memoryGetPendingContent(path) || '',
        sha: undefined,
    }));
    const allTabs = tabsToCommit.concat(memoryPseudoTabs);

    if (allTabs.length === 0) {
        showToast('No changes to commit', 'warning');
        return;
    }

    const commitBtn = document.getElementById('btnDoCommit');
    commitBtn.disabled = true;
    commitBtn.textContent = '⏳ Committing...';

    try {
        const { results, errors } = await batchSaveFiles(message, allTabs);

        // Auto-clear pending memory paths that landed successfully.
        // Partial-success commits leave failed paths pending so the
        // user can retry without losing them.
        if (memoryPaths.length > 0) {
            const committedSet = new Set(results.map((r) => r.path));
            const memoryCommitted = memoryPaths.filter((p) => committedSet.has(p));
            if (memoryCommitted.length > 0) {
                discardPendingMemoryWrites(memoryCommitted);
            }
        }

        if (results.length > 0) {
            showToast(`Committed ${results.length} file(s)`, 'success');
            // Emit fs hooks for plugins
            for (const r of results) {
                EventBus.emit('fs:updated', { path: r.path, branch: State.currentBranch });
            }
        }
        if (errors.length > 0) {
            showToast(`${errors.length} file(s) failed to commit`, 'error');
        }

        renderEditorTabs();
        updateCommitButton();
        updateStatusBar();

        // Refresh file tree to reflect committed state
        EventBus.emit('tree:refresh');

        closeCommitModal();
        document.getElementById('commitMessage').value = '';
    } catch (error) {
        showToast('Commit failed: ' + error.message, 'error');
    }

    commitBtn.disabled = false;
    commitBtn.textContent = `✅ Commit ${tabsToCommit.length} file(s)`;
}
