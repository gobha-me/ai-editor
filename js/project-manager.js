// ============================================
// PROJECT MANAGEMENT
// ============================================

import { State, EventBus, Storage } from './core.js';
import { Git, loadProject } from './git.js';
import { renderFileTree } from './file-tree.js';
import { escapeHtml, escapeAttr } from './utils/html.js';
import {
    renderBranchPanel,
    mountBranchPanel,
    populateBranchMetadata,
} from './ui/branch-panel.js';
import { renderIssueRowsHtml } from './ui/issue-list.js';
import { renderPrRowsHtml } from './ui/pr-list.js';

export async function refreshProjects() {
    try {
        // Bypass circuit breaker cooldown so manual refresh always tries the network
        Git.forceRetryAll();

        const { repos, errors } = await Git.listAllRepos();
        const select = document.getElementById('projectSelect');
        select.innerHTML = '<option value="">Select a project...</option>';

        // Collect IDs of connections that are still down after the retry
        const downIds = new Set(Git.getDownConnectionIds());

        // Group repos by connection for the optgroup UI
        const grouped = new Map();
        repos.forEach(repo => {
            const key = repo.connectionId;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    label: repo.connectionLabel,
                    repos: []
                });
            }
            grouped.get(key).repos.push(repo);
        });

        // Add stub groups for connections that returned zero repos because they're down
        for (const err of errors) {
            if (!grouped.has(err.connectionId)) {
                grouped.set(err.connectionId, {
                    label: `${err.connectionId}`,
                    repos: []
                });
            }
        }

        // Single connection: flat list. Multiple: optgroups.
        if (grouped.size <= 1 && downIds.size === 0) {
            repos.forEach(repo => {
                const option = document.createElement('option');
                option.value = `${repo.connectionId}::${repo.owner}::${repo.name}`;
                option.textContent = repo.fullName;
                select.appendChild(option);
            });
        } else {
            for (const [connId, group] of grouped) {
                const optgroup = document.createElement('optgroup');
                const isDown = downIds.has(connId);
                // optgroup.label is plain text (no HTML); use a textual prefix
                // for offline state instead of an emoji.
                optgroup.label = isDown
                    ? `[OFFLINE] ${group.label}`
                    : group.label;
                group.repos.forEach(repo => {
                    const option = document.createElement('option');
                    option.value = `${repo.connectionId}::${repo.owner}::${repo.name}`;
                    option.textContent = repo.fullName;
                    optgroup.appendChild(option);
                });
                select.appendChild(optgroup);
            }
        }

        // Re-select current project if one is loaded (e.g. after settings save)
        if (State.currentProject) {
            const currentValue = `${State.currentProject.connectionId}::${State.currentProject.owner}::${State.currentProject.repo}`;
            const opt = select.querySelector(`option[value="${currentValue}"]`);
            if (opt) select.value = currentValue;
        }

        if (errors.length > 0) {
            console.warn('Some connections failed to load repos:', errors);
            const downCount = errors.length;
            window.showToast(`Loaded ${repos.length} projects (${downCount} connection${downCount > 1 ? 's' : ''} offline)`, 'warning');
        } else {
            window.showToast(`Loaded ${repos.length} projects`, 'success');
        }
    } catch (error) {
        console.error('Failed to load projects:', error);
        window.showToast('Failed to load projects. Check connection settings.', 'error');
    }
}

/**
 * Core project-switching logic. Clears editor state, loads the project,
 * populates branch selector, and emits project:loaded.
 * Used by both the UI dropdown and LLM set_active_project tool.
 * @param {string} connectionId
 * @param {string} owner
 * @param {string} repo
 * @param {Object} [options]
 * @param {string} [options.branch] - Specific branch to switch to (default: repo default)
 * @returns {Promise<{owner, repo, branch}>}
 */
export async function switchProject(connectionId, owner, repo, { branch } = {}) {
    // Clear open tabs when switching projects
    State.openTabs = [];
    State.activeTabIndex = -1;
    State.currentFile = null;
    State.editorContent = '';
    State.editorDirty = false;
    State.currentIssue = null;

    // Show welcome screen
    const editorContainer = document.getElementById('editorContainer');
    if (editorContainer) {
        editorContainer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: var(--font-2xl); margin-bottom: 1rem; display: inline-flex; align-items: center; gap: 0.4em;"><svg class="icn icn--lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg><span>AI Editor</span></h2>
                    <p>Select a file to edit</p>
                </div>
            </div>
        `;
    }

    const { renderEditorTabs } = await import('./tab-manager.js');
    renderEditorTabs();

    // If a specific branch was requested, set it before loadProject reads it
    if (branch) {
        State.currentBranch = branch;
    }

    await loadProject(connectionId, owner, repo);

    // Reset metadata so we don't render stale ahead/behind counts from the
    // previous project; the populate-step below repopulates lazily.
    State.branchMetadata = {};
    renderBranchPanel();
    // Fire-and-forget — counts pop in via `branches:metadataChanged`.
    populateBranchMetadata(State.currentProject, State.branches);

    // Update project selector to match
    const projectSelect = document.getElementById('projectSelect');
    if (projectSelect) {
        const selectorValue = `${connectionId}::${owner}::${repo}`;
        // If the option exists, select it
        const opt = projectSelect.querySelector(`option[value="${selectorValue}"]`);
        if (opt) projectSelect.value = selectorValue;
    }

    // Trigger refresh events for other modules
    EventBus.emit('project:loaded', { connectionId, owner, repo });
    saveSession();

    return { owner, repo, branch: State.currentBranch };
}

export async function onProjectChange(e) {
    const value = e.target.value;
    if (!value) return;

    // Value format: "connectionId::owner::repo" (:: delimiter avoids ambiguity with nested groups)
    const parts = value.split('::');
    if (parts.length !== 3) {
        console.error('Invalid project selector value:', value);
        return;
    }
    const connectionId = parts[0];
    const owner = parts[1];
    const repo = parts[2];
    
    try {
        await switchProject(connectionId, owner, repo);
        window.showToast(`Loaded ${owner}/${repo}`, 'success');

    } catch (error) {
        console.error('Failed to load project:', error);
        window.showToast('Failed to load project', 'error');
    }
}

/**
 * Switch the editor to a different branch.
 *
 * @param {string|Event} branchOrEvent — branch name (preferred) or a legacy
 *   change-event from a `<select>` (kept for backward-compat with any
 *   external caller). The legacy form is only used when `branchOrEvent`
 *   is an Event-like object with `.target.value`.
 */
export async function onBranchChange(branchOrEvent) {
    const newBranch = typeof branchOrEvent === 'string'
        ? branchOrEvent
        : branchOrEvent?.target?.value;
    if (!newBranch || newBranch === State.currentBranch) return;

    const previousBranch = State.currentBranch;

    // Check for dirty tabs before switching branches
    const dirtyTabs = State.openTabs.filter(t => t.dirty);
    if (dirtyTabs.length > 0) {
        const { showConfirm } = await import('./ui/dialogs.js');
        const fileNames = dirtyTabs.map(t => t.path.split('/').pop()).join(', ');
        const confirmed = await showConfirm(
            `You have unsaved changes in: ${fileNames}\n\nWhat would you like to do?`,
            {
                title: 'Unsaved Changes',
                okLabel: 'Discard & Switch',
                cancelLabel: 'Cancel',
                variant: 'danger',
            }
        );
        if (!confirmed) return;
        // User chose to discard — clear drafts from storage for the old branch
        if (State.currentProject) {
            const { owner, repo } = State.currentProject;
            for (const tab of dirtyTabs) {
                Storage.clearDraft(owner, repo, previousBranch, tab.path);
            }
        }
    }

    State.currentBranch = newBranch;
    
    // Clear active issue if switching away from its branch
    if (State.currentIssue && State.currentBranch !== State.currentIssue.branch) {
        State.currentIssue = null;
        renderIssues(); // Remove highlight
    }

    // Re-render PRs with branch-contextual filtering
    renderPullRequests();
    
    if (State.currentProject) {
        // Clear open tabs when switching branches (files may differ)
        State.openTabs = [];
        State.activeTabIndex = -1;
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;
        
        document.getElementById('editorContainer').innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: var(--font-2xl); margin-bottom: 1rem; display: inline-flex; align-items: center; gap: 0.4em;"><svg class="icn icn--lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg><span>AI Editor</span></h2>
                    <p>Select a file to edit</p>
                </div>
            </div>
        `;
        
        const { renderEditorTabs } = await import('./tab-manager.js');
        renderEditorTabs();
        
        // Close secondary pane (diff/preview are invalid after branch switch)
        const { closeSecondaryPane } = await import('./secondary-pane.js');
        closeSecondaryPane();
        
        // Reload file tree for new branch
        EventBus.emit('tree:refresh');
    }

    // Notify context manager and other listeners about branch switch
    EventBus.emit('branch:switch', { branch: State.currentBranch, previousBranch });

    EventBus.emit('statusBar:update');
    saveSession();
}

// ============================================
// SESSION PERSISTENCE
// ============================================

/**
 * Save current project, branch, and open tab paths to Storage.
 * Called after project switch, branch change, and tab changes.
 */
export function saveSession() {
    if (!State.currentProject) {
        Storage.set('session', null);
        return;
    }

    const session = {
        connectionId: State.currentProject.connectionId,
        owner: State.currentProject.owner,
        repo: State.currentProject.repo,
        branch: State.currentBranch || 'main',
        // Only save pinned (non-preview) tabs — preview tabs are transient
        openTabs: State.openTabs
            .filter(t => !t.isPreview)
            .map(t => t.path),
        activeTabPath: State.activeTabIndex >= 0
            ? State.openTabs[State.activeTabIndex]?.path || null
            : null,
        savedAt: Date.now()
    };

    Storage.set('session', session);
    console.log(`[Session] Saved: ${session.owner}/${session.repo}@${session.branch}, ${session.openTabs.length} tabs`);
}

/**
 * Restore project, branch, and open tabs from previous session.
 * Called once at startup after refreshProjects populates the dropdown.
 * @returns {Promise<boolean>} true if session was restored
 */
export async function restoreSession() {
    const session = Storage.get('session');
    if (!session?.connectionId || !session?.owner || !session?.repo) {
        return false;
    }

    try {
        console.log(`[Session] Restoring: ${session.owner}/${session.repo}@${session.branch}`);

        // Switch to the saved project + branch
        await switchProject(session.connectionId, session.owner, session.repo, {
            branch: session.branch
        });

        // Re-open saved tabs (best-effort, skip missing files)
        if (session.openTabs?.length > 0 && window.onTreeItemClick) {
            for (const path of session.openTabs) {
                // Verify file exists in current tree before opening
                const exists = State.fileTree.some(f => f.path === path);
                if (exists) {
                    try {
                        await window.onTreeItemClick(path, 'file', true); // true = pin
                    } catch (err) {
                        console.warn(`[Session] Failed to restore tab: ${path}`, err.message);
                    }
                } else {
                    console.warn(`[Session] Skipping missing file: ${path}`);
                }
            }

            // Switch to the tab that was active when session was saved
            if (session.activeTabPath) {
                const targetIdx = State.openTabs.findIndex(t => t.path === session.activeTabPath);
                if (targetIdx >= 0 && targetIdx !== State.activeTabIndex) {
                    const { switchToTab } = await import('./tab-manager.js');
                    await switchToTab(targetIdx);
                }
            }
        }

        window.showToast(`Restored ${session.owner}/${session.repo}`, 'info');
        return true;
    } catch (error) {
        console.warn('[Session] Restore failed:', error.message);
        Storage.set('session', null);
        return false;
    }
}

/**
 * Clear the current project and reset the workspace.
 */
export async function clearProject() {
    // Check for unsaved work
    const dirtyTabs = State.openTabs.filter(t => t.dirty);
    if (dirtyTabs.length > 0) {
        const paths = dirtyTabs.map(t => t.path.split('/').pop()).join(', ');
        const { showConfirm } = await import('./ui/dialogs.js');
        if (!await showConfirm(`You have unsaved changes in: ${paths}\n\nDiscard and clear project?`, { title: 'Unsaved Changes', okLabel: 'Discard', variant: 'danger' })) {
            return;
        }
    }

    // Clear all project state
    State.currentProject = null;
    State.currentBranch = 'main';
    State.fileTree = [];
    State.openTabs = [];
    State.activeTabIndex = -1;
    State.currentFile = null;
    State.editorContent = '';
    State.editorDirty = false;
    State.currentIssue = null;
    State.issues = [];
    State.pullRequests = [];
    State.branches = [];
    State.branchMetadata = {};

    // Clear session storage
    Storage.set('session', null);

    // Reset UI
    const projectSelect = document.getElementById('projectSelect');
    if (projectSelect) projectSelect.value = '';

    renderBranchPanel();

    const editorContainer = document.getElementById('editorContainer');
    if (editorContainer) {
        editorContainer.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: var(--font-2xl); margin-bottom: 1rem; display: inline-flex; align-items: center; gap: 0.4em;"><svg class="icn icn--lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg><span>AI Editor</span></h2>
                    <p>Select a project to get started</p>
                </div>
            </div>
        `;
    }

    const { renderEditorTabs } = await import('./tab-manager.js');
    renderEditorTabs();
    renderFileTree();

    // Close secondary pane
    const { closeSecondaryPane } = await import('./secondary-pane.js');
    closeSecondaryPane();

    // Notify other modules
    EventBus.emit('project:cleared');
    EventBus.emit('statusBar:update');

    window.showToast('Project cleared', 'success');
}

/**
 * Initialize session persistence listeners.
 * Debounces tab change events so we don't write to Storage on every keystroke.
 */
export function initSessionListeners() {
    let _saveDebounce = null;
    const debouncedSave = () => {
        clearTimeout(_saveDebounce);
        _saveDebounce = setTimeout(saveSession, 1000);
    };

    EventBus.on('file:opened', debouncedSave);
    EventBus.on('tab:closed', debouncedSave);
    EventBus.on('tab:switched', debouncedSave);
}

// ============================================
// ISSUES & WORKFLOWS
// ============================================

export function renderIssues(container) {
    if (!container) container = document.getElementById('issuesPanel');
    if (!container) return;

    if (State.issues.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-size: var(--font-md);">No open issues</div>';
        return;
    }

    container.innerHTML = renderIssueRowsHtml({
        issues: State.issues,
        branches: State.branches,
        currentBranch: State.currentBranch,
        defaultBranch: State.currentProject?.defaultBranch,
        currentIssue: State.currentIssue,
        focusedIssue: State.focusedIssue,
    });
}

export async function refreshIssues() {
    if (!State.currentProject) return;

    const { owner, repo } = State.currentProject;
    try {
        State.issues = await Git.listIssues(owner, repo);
    } catch (e) {
        console.warn('[Issues] Failed to refresh:', e.message);
        // Keep existing issues in state rather than wiping them
    }
    renderIssues();
    // Post-fetch broadcast so listeners that ran synchronously on
    // `issues:refresh` (rail badge) can re-read State now that it's fresh.
    EventBus.emit('issues:render');
}

export function renderPullRequests(container) {
    if (!container) container = document.getElementById('prsPanel');
    if (!container) return;

    container.innerHTML = renderPrRowsHtml({
        pullRequests: State.pullRequests,
        currentBranch: State.currentBranch,
        defaultBranch: State.currentProject?.defaultBranch || 'main',
    });
}

export async function refreshPullRequests() {
    if (!State.currentProject) return;

    const { owner, repo } = State.currentProject;

    try {
        // Phase 1: Fetch PR list and render immediately
        const prs = await Git.listMergeRequests(owner, repo, 'open');
        State.pullRequests = prs.map(pr => ({ ...pr, ciState: 'pending', ciStatuses: [] }));
        renderPullRequests();
        // Post-fetch broadcast so listeners that ran synchronously on
        // `prs:refresh` (rail badge) can re-read State now that it's fresh.
        EventBus.emit('prs:render');

        // Phase 2: Backfill CI status in parallel, then re-render
        State.pullRequests = await Promise.all(prs.map(async (pr) => {
            try {
                const status = await Git.getCommitStatus(owner, repo, pr.head);
                return { ...pr, ciState: status.state, ciStatuses: status.statuses };
            } catch {
                return { ...pr, ciState: 'unknown', ciStatuses: [] };
            }
        }));
        renderPullRequests();
        EventBus.emit('prs:render');
    } catch (e) {
        console.warn('[PRs] Failed to refresh:', e.message);
        State.pullRequests = [];
        renderPullRequests();
        EventBus.emit('prs:render');
    }
}

/**
 * Re-fetch the branch list and re-render the branch panel.
 * Called after merge (especially with delete-branch), branch creation, etc.
 */
export async function refreshBranches() {
    if (!State.currentProject) return;

    const { owner, repo } = State.currentProject;

    try {
        State.branches = await Git.listBranches(owner, repo);
    } catch (e) {
        console.warn('[Branches] Failed to refresh:', e.message);
        return;
    }

    // Keep current selection if it still exists, otherwise fall back to default.
    const stillExists = State.branches.some(b => b.name === State.currentBranch);
    if (!stillExists) {
        const defaultBranch = State.currentProject.defaultBranch || 'main';
        State.currentBranch = defaultBranch;
        EventBus.emit('branch:switch', { branch: defaultBranch });
    }

    renderBranchPanel();
    populateBranchMetadata(State.currentProject, State.branches);
}

// ============================================
// CREATE PR MODAL
// ============================================

export function openCreatePRModal() {
    if (!State.currentProject) return;

    const modal = document.getElementById('createPRModal');
    if (!modal) return;

    const defaultBranch = State.currentProject.defaultBranch || 'main';

    // Populate branch selectors
    const headSelect = document.getElementById('prCreateHead');
    const baseSelect = document.getElementById('prCreateBase');
    const branches = State.branches || [];

    headSelect.innerHTML = branches.map(b =>
        `<option value="${escapeAttr(b.name)}" ${b.name === State.currentBranch ? 'selected' : ''}>${escapeHtml(b.name)}</option>`
    ).join('');

    baseSelect.innerHTML = branches.map(b =>
        `<option value="${escapeAttr(b.name)}" ${b.name === defaultBranch ? 'selected' : ''}>${escapeHtml(b.name)}</option>`
    ).join('');

    // Auto-fill title from branch name: issue/42-fix-bug → Fix bug (#42)
    const branch = State.currentBranch || '';
    let autoTitle = '';
    const issueMatch = branch.match(/^issue\/(\d+)-(.+)$/);
    if (issueMatch) {
        autoTitle = issueMatch[2].replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()) + ` (#${issueMatch[1]})`;
    } else if (branch !== defaultBranch) {
        autoTitle = branch.replace(/[-_/]/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();
    }
    document.getElementById('prCreateTitle').value = autoTitle;
    document.getElementById('prCreateBody').value = '';
    document.getElementById('prCreateError').style.display = 'none';
    document.getElementById('btnSubmitPR').disabled = false;

    modal.classList.add('active');
    document.getElementById('prCreateTitle').focus();
}

export function closeCreatePRModal() {
    const modal = document.getElementById('createPRModal');
    if (modal) modal.classList.remove('active');
}

export async function submitCreatePR() {
    const title = document.getElementById('prCreateTitle').value.trim();
    const body = document.getElementById('prCreateBody').value.trim();
    const head = document.getElementById('prCreateHead').value;
    const base = document.getElementById('prCreateBase').value;
    const errorEl = document.getElementById('prCreateError');
    const btn = document.getElementById('btnSubmitPR');

    if (!title) {
        errorEl.textContent = 'Title is required';
        errorEl.style.display = '';
        return;
    }
    if (head === base) {
        errorEl.textContent = 'Head and base branches must be different';
        errorEl.style.display = '';
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Creating…';
    errorEl.style.display = 'none';

    try {
        const { owner, repo } = State.currentProject;
        const pr = await Git.createMergeRequest(owner, repo, title, body, head, base);
        closeCreatePRModal();
        await refreshPullRequests();
        // 2.13.0 — open the freshly-created PR in the takeover surface.
        // The legacy modal rollback path was removed when pr-detail.js
        // was deleted; the surface is the only inspector now.
        window.openPrReview(pr.number);
    } catch (e) {
        errorEl.textContent = `Failed: ${e.message}`;
        errorEl.style.display = '';
        btn.disabled = false;
        btn.innerHTML = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/></svg><span>Create Pull Request</span>';
    }
}


// ============================================
// ISSUE DETAIL (extracted to issue-detail.js)
// ============================================

import {
    openIssueTab,
    openIssueDetailModal,
    closeIssueDetailModal,
    startWorkOnIssue,
    focusIssue,
    unfocusIssue,
    clearActiveIssue,
    acceptFocusedIssue,
    denyFocusedIssue,
    commentOnFocusedIssue
} from './issue-detail.js';

// ============================================
// NEW PROJECT MODAL
// ============================================

export function openNewProjectModal() {
    const modal = document.getElementById('newProjectModal');
    if (!modal) return;

    // Populate connection dropdown with enabled connections
    const connSelect = document.getElementById('newProjectConnection');
    if (connSelect) {
        const connections = (State.settings.connections || []).filter(c => c.enabled !== false);
        connSelect.innerHTML = connections.map(c =>
            `<option value="${escapeAttr(c.id)}">${escapeHtml(c.label || c.id)} (${escapeHtml(c.provider)})</option>`
        ).join('');

        if (connections.length === 0) {
            connSelect.innerHTML = '<option value="">No connections configured</option>';
        }
    }

    // Clear form
    const nameInput = document.getElementById('newProjectName');
    if (nameInput) nameInput.value = '';
    const descInput = document.getElementById('newProjectDesc');
    if (descInput) descInput.value = '';
    document.getElementById('newProjectPrivate').checked = true;
    document.getElementById('newProjectAutoInit').checked = true;

    modal.classList.add('active');
    if (nameInput) setTimeout(() => nameInput.focus(), 100);
}

export function closeNewProjectModal() {
    const modal = document.getElementById('newProjectModal');
    if (modal) modal.classList.remove('active');
}

export async function submitNewProject() {
    const connectionId = document.getElementById('newProjectConnection')?.value;
    const name = document.getElementById('newProjectName')?.value?.trim();
    const description = document.getElementById('newProjectDesc')?.value?.trim() || '';
    const isPrivate = document.getElementById('newProjectPrivate')?.checked ?? true;
    const autoInit = document.getElementById('newProjectAutoInit')?.checked ?? true;

    if (!connectionId) {
        window.showToast('No connection selected', 'error');
        return;
    }
    if (!name) {
        window.showToast('Repository name is required', 'error');
        return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        window.showToast('Invalid repo name — use letters, numbers, hyphens, dots, underscores', 'error');
        return;
    }

    const btn = document.getElementById('btnSubmitNewProject');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }

    try {
        const result = await Git.createRepo(connectionId, name, { description, isPrivate, autoInit });
        closeNewProjectModal();
        window.showToast(`Created ${result.owner}/${result.name}`, 'success');

        // Refresh project list and auto-select the new repo
        await refreshProjects();
        await switchProject(connectionId, result.owner, result.name);

    } catch (error) {
        console.error('[NewProject] Create failed:', error);
        window.showToast(`Failed to create repo: ${error.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/></svg><span>Create</span>'; }
    }
}

// Setup event listeners for project changes
export function initProjectListeners() {
    // Mount the branch row-list panel and its delegated handlers (1.12.0).
    mountBranchPanel({
        onSwitch: (name) => onBranchChange(name),
        onDelete: async (name) => {
            if (!State.currentProject) return;
            const protectedSet = new Set(
                (State.branches || []).filter(b => b.protected).map(b => b.name)
            );
            if (protectedSet.has(name)) {
                window.showToast?.(`Cannot delete protected branch "${name}"`, 'warning');
                return;
            }
            const { showConfirm } = await import('./ui/dialogs.js');
            const confirmed = await showConfirm(
                `Delete branch "${name}"? This cannot be undone.`,
                {
                    title: 'Delete branch',
                    okLabel: 'Delete',
                    cancelLabel: 'Cancel',
                    variant: 'danger',
                }
            );
            if (!confirmed) return;
            const { owner, repo } = State.currentProject;
            try {
                await Git.deleteBranch(owner, repo, name);
                window.showToast?.(`Deleted branch "${name}"`, 'success');
                await refreshBranches();
            } catch (err) {
                console.error('[Branches] Delete failed:', err);
                window.showToast?.(`Failed to delete "${name}": ${err.message || err}`, 'error');
            }
        },
        onCutRelease: () => {
            // Existing modal reads `State.currentBranch` and pre-fills target;
            // the panel's Cut release button only renders on the current row.
            window.openReleaseModal?.();
        },
        onExportZip: async (name) => {
            if (!State.currentProject) return;
            const { owner, repo } = State.currentProject;
            const { exportBranchAsZip } = await import('./zip-export.js');
            const { showConfirm } = await import('./ui/dialogs.js');
            window.showToast?.(`Exporting branch "${name}"…`, 'info');
            try {
                const result = await exportBranchAsZip({
                    owner, repo, branch: name,
                    confirm: async ({ fileCount, totalBytes }) => {
                        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
                        return showConfirm(
                            `Export ${fileCount} files (${mb} MB) — this may take a moment. Continue?`,
                            { title: 'Large export', okLabel: 'Export', cancelLabel: 'Cancel' }
                        );
                    },
                });
                if (result) {
                    window.showToast?.(`Downloaded ${result.filename}`, 'success');
                }
            } catch (err) {
                console.error('[Branches] Export zip failed:', err);
                window.showToast?.(`Export failed: ${err.message || err}`, 'error');
            }
        },
    });

    EventBus.on('project:loaded', () => {
        renderFileTree();
        renderIssues();
        renderPullRequests();
    });
    
    EventBus.on('tree:refresh', async () => {
        if (State.currentProject) {
            const { owner, repo } = State.currentProject;
            try {
                State.fileTree = await Git.getFileTree(owner, repo, State.currentBranch);
            } catch (e) {
                console.error('[tree:refresh] Failed to fetch file tree:', e);
            }
        }
        renderFileTree();
    });
    
    EventBus.on('issues:refresh', refreshIssues);
    EventBus.on('prs:refresh', refreshPullRequests);
    EventBus.on('branches:refresh', refreshBranches);

    // Events from extracted modules (avoids circular imports)
    EventBus.on('issues:render', renderIssues);
    EventBus.on('prs:render', renderPullRequests);
    // Manual branch switches (via the row-list panel) need to refresh issue
    // rows so the inline "Start" button flips between Active / Switch / Start.
    // `startWorkOnIssue` already emits `issues:render` after a session-start
    // switch; this catches the user-initiated case.
    EventBus.on('branch:switch', renderIssues);
    EventBus.on('branches:refresh', renderIssues);
    EventBus.on('project:refreshAfterMerge', async () => {
        await refreshPullRequests();
        await refreshBranches();
    });

    // Issue focus bar action buttons
    const safeClick = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    };
    safeClick('btnIssueFocusAccept', acceptFocusedIssue);
    safeClick('btnIssueFocusDeny', denyFocusedIssue);
    safeClick('btnIssueFocusComment', commentOnFocusedIssue);
    safeClick('btnIssueFocusWork', () => {
        if (State.focusedIssue) startWorkOnIssue(State.focusedIssue);
    });

    // New Project modal
    safeClick('btnNewProject', openNewProjectModal);
    safeClick('btnCloseNewProject', closeNewProjectModal);
    safeClick('btnCancelNewProject', closeNewProjectModal);
    safeClick('btnSubmitNewProject', submitNewProject);

    // Close on overlay click
    const overlay = document.getElementById('newProjectModal');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeNewProjectModal();
        });
    }

    // Enter key submits
    const nameInput = document.getElementById('newProjectName');
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitNewProject();
        });
    }
}

// ============================================
// RE-EXPORTS (from extracted modules — preserves downstream imports)
// ============================================

export {
    // Issue detail (from issue-detail.js)
    openIssueTab,
    openIssueDetailModal,
    closeIssueDetailModal,
    startWorkOnIssue,
    focusIssue,
    unfocusIssue,
    clearActiveIssue
};
