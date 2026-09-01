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
import {
    isEnabled as sessionsSyncIsEnabled,
    listPendingPaths as sessionsListPendingPaths,
    getPendingContent as sessionsGetPendingContent,
    discardPendingSessionWrites,
} from '../chat/sessions-sync.js';
import {
    renderSessionUpdatesSection,
    wireSessionUpdatesSection,
} from './commit-sessions-section.js';
import {
    isEnabled as workspaceSettingsIsEnabled,
    listPendingPaths as workspaceSettingsListPendingPaths,
    getPendingContent as workspaceSettingsGetPendingContent,
    discardPendingWrites as workspaceSettingsDiscardPendingWrites,
} from '../intelligence/workspace-settings/index.js';
import {
    renderWorkspaceSettingsSection,
    wireWorkspaceSettingsSection,
} from './commit-workspace-settings-section.js';

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
    _renderSessionsSection();
    _renderWorkspaceSettingsSection();

    const isProtected = _currentBranchIsProtected();
    const memCount = (memoryFileLayerIsEnabled() ? memoryListPendingPaths().length : 0);
    const sessCount = (sessionsSyncIsEnabled() ? sessionsListPendingPaths().length : 0);
    const wsCount = (workspaceSettingsIsEnabled() ? workspaceSettingsListPendingPaths().length : 0);
    document.getElementById('btnDoCommit').textContent =
        (isProtected && (memCount > 0 || sessCount > 0 || wsCount > 0))
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

/**
 * Bind a delegated click handler for the commit modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * Phase 1 of the inline-handlers migration (DESIGN-ui-event-dispatch.md).
 * Pilot replicating the `mountBranchPanel` (js/ui/branch-panel.js:216) shape
 * on the commit modal. The HTML carries `data-action="closeCommitModal"`,
 * `"generateCommitMsg"`, `"commitAndPush"` instead of `onclick="window.foo()"`;
 * this listener routes each action to the typed callback.
 *
 * The `window.*` aliases in js/app.js stay intact through Phase 3; they
 * retire in Phase 4's cleanup pass.
 */
let _wired = false;
export function mountCommitModal({ onClose, onCommit, onGenerate } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#commitModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeCommitModal' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'commitAndPush' && typeof onCommit === 'function') {
            onCommit();
        } else if (action === 'generateCommitMsg' && typeof onGenerate === 'function') {
            onGenerate();
        }
    });
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

function _renderSessionsSection() {
    const root = document.getElementById('commitSessionsSection');
    if (!root) return;

    if (!sessionsSyncIsEnabled()) {
        root.innerHTML = '';
        return;
    }
    const pendingPaths = sessionsListPendingPaths();
    if (pendingPaths.length === 0) {
        root.innerHTML = '';
        return;
    }

    const isProtected = _currentBranchIsProtected();
    root.innerHTML = renderSessionUpdatesSection({
        isProtected,
        pendingPaths,
        branch: State.currentBranch || '',
    });
    wireSessionUpdatesSection(root, { closeModal: closeCommitModal });
}

function _renderWorkspaceSettingsSection() {
    const root = document.getElementById('commitWorkspaceSettingsSection');
    if (!root) return;

    if (!workspaceSettingsIsEnabled()) {
        root.innerHTML = '';
        return;
    }
    const pendingPaths = workspaceSettingsListPendingPaths();
    if (pendingPaths.length === 0) {
        root.innerHTML = '';
        return;
    }

    const isProtected = _currentBranchIsProtected();
    root.innerHTML = renderWorkspaceSettingsSection({
        isProtected,
        pendingPaths,
        branch: State.currentBranch || '',
    });
    wireWorkspaceSettingsSection(root, { closeModal: closeCommitModal });
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

    // 1.3.2 — same Flow 3A/3B gate for sessions.
    const sessionPaths = (
        sessionsSyncIsEnabled() && !_currentBranchIsProtected()
            ? sessionsListPendingPaths()
            : []
    );
    const sessionPseudoTabs = sessionPaths.map((path) => ({
        path,
        content: sessionsGetPendingContent(path) || '',
        sha: undefined,
    }));

    // 1.4.4 — same Flow 3A/3B gate for workspace settings (.aieditor/settings.json).
    const workspaceSettingsPaths = (
        workspaceSettingsIsEnabled() && !_currentBranchIsProtected()
            ? workspaceSettingsListPendingPaths()
            : []
    );
    const workspaceSettingsPseudoTabs = workspaceSettingsPaths.map((path) => ({
        path,
        content: workspaceSettingsGetPendingContent(path) || '',
        sha: undefined,
    }));

    const allTabs = tabsToCommit
        .concat(memoryPseudoTabs)
        .concat(sessionPseudoTabs)
        .concat(workspaceSettingsPseudoTabs);

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
        const committedSet = new Set(results.map((r) => r.path));
        if (memoryPaths.length > 0) {
            const memoryCommitted = memoryPaths.filter((p) => committedSet.has(p));
            if (memoryCommitted.length > 0) {
                discardPendingMemoryWrites(memoryCommitted);
            }
        }
        if (sessionPaths.length > 0) {
            const sessionsCommitted = sessionPaths.filter((p) => committedSet.has(p));
            if (sessionsCommitted.length > 0) {
                discardPendingSessionWrites(sessionsCommitted);
            }
        }
        if (workspaceSettingsPaths.length > 0) {
            const wsCommitted = workspaceSettingsPaths.filter((p) => committedSet.has(p));
            if (wsCommitted.length > 0) {
                workspaceSettingsDiscardPendingWrites(wsCommitted);
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
