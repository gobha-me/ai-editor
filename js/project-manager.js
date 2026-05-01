// ============================================
// PROJECT MANAGEMENT
// ============================================

import { State, EventBus, Storage } from './core.js';
import { Git, loadProject } from './git.js';
import { renderFileTree } from './file-tree.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

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

    // Update branch selector
    const branchSelect = document.getElementById('branchSelect');
    if (branchSelect) {
        branchSelect.innerHTML = '';
        State.branches.forEach(b => {
            const option = document.createElement('option');
            option.value = b.name;
            option.textContent = b.name + (b.protected ? ' 🔒' : '');
            branchSelect.appendChild(option);
        });
        branchSelect.value = State.currentBranch;
    }

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

export async function onBranchChange(e) {
    const previousBranch = State.currentBranch;
    State.currentBranch = e.target.value;
    
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

    // Clear session storage
    Storage.set('session', null);

    // Reset UI
    const projectSelect = document.getElementById('projectSelect');
    if (projectSelect) projectSelect.value = '';
    
    const branchSelect = document.getElementById('branchSelect');
    if (branchSelect) branchSelect.innerHTML = '<option value="main">main</option>';

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
    renderFileTree([]);

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

export function renderIssues() {
    const container = document.getElementById('issuesPanel');

    // Update count in sidebar header
    const header = document.querySelector('[data-collapse="issuesPanelBody"] span');
    if (header) {
        header.textContent = State.issues.length > 0
            ? `▾ Issues (${State.issues.length})`
            : '▾ Issues';
    }
    
    if (State.issues.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-size: var(--font-md);">No open issues</div>';
        return;
    }

    container.innerHTML = State.issues.map(issue => {
        // Build dependencies display
        let depsHtml = '';
        if (issue.dependencies && issue.dependencies.length > 0) {
            const depLinks = issue.dependencies.map(depNum => 
                `<span class="dep-link" onclick="event.stopPropagation(); window.Chat.sendMessage('Show me issue #${depNum}')">#${depNum}</span>`
            ).join(', ');
            depsHtml = `<div class="issue-deps"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/></svg> Depends on: ${depLinks}</div>`;
        }

        // Highlight if this issue is active (working) or focused (triaging)
        const isActive = State.currentIssue?.number === issue.number;
        const isFocused = State.focusedIssue?.number === issue.number;
        const activeClass = isActive ? ' issue-item-active' : isFocused ? ' issue-item-focused' : '';
        
        return `
            <div class="issue-item${activeClass}" role="listitem" tabindex="0"
                 onclick="window.openIssueTab(${issue.number})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.openIssueTab(${issue.number})}"
                 aria-label="Issue #${issue.number}: ${escapeAttr(issue.title)}">
                <div class="issue-number">#${issue.number}</div>
                <div class="issue-title">${escapeHtml(issue.title)}</div>
                ${issue.labels.length ? `
                    <div class="issue-labels">
                        ${issue.labels.map(l => `<span class="issue-label">${escapeHtml(l)}</span>`).join('')}
                    </div>
                ` : ''}
                ${depsHtml}
            </div>
        `;
    }).join('');
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
}

// CI_ICONS moved to pr-detail.js (shared constant)
import { CI_ICONS } from './pr-detail.js';

export function renderPullRequests() {
    const container = document.getElementById('prsPanel');
    if (!container) return;

    // Branch-contextual filtering:
    // On default branch → show all open PRs
    // On feature branch → show only PRs where head matches current branch
    const defaultBranch = State.currentProject?.defaultBranch || 'main';
    const onDefault = State.currentBranch === defaultBranch;

    const filtered = onDefault
        ? State.pullRequests
        : State.pullRequests.filter(pr => pr.head === State.currentBranch);

    if (filtered.length === 0) {
        const context = onDefault ? 'No open pull requests' : `No PRs for branch "${State.currentBranch}"`;
        container.innerHTML = `<div style="padding: 0.75rem; color: var(--text-muted); font-size: var(--font-md);">${context}</div>`;
        return;
    }

    container.innerHTML = filtered.map(pr => {
        const ciIcon = CI_ICONS[pr.ciState] || '⚪';
        const ciTitle = pr.ciState === 'unknown' ? 'No CI status' : `CI: ${pr.ciState}`;
        const branchInfo = onDefault ? `<span style="color: var(--text-muted);">${escapeHtml(pr.head)} → ${escapeHtml(pr.base)}</span>` : '';

        return `
            <div class="issue-item" role="listitem" tabindex="0"
                 onclick="window.openPRDetailModal(${pr.number})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.openPRDetailModal(${pr.number})}"
                 title="${ciTitle}" style="cursor: pointer;"
                 aria-label="Pull request #${pr.number}: ${escapeAttr(pr.title)}, CI ${pr.ciState || 'unknown'}">
                <div class="issue-number">
                    <span class="pr-ci-badge" title="${ciTitle}" aria-hidden="true">${ciIcon}</span>
                    #${pr.number}
                </div>
                <div class="issue-title">${escapeHtml(pr.title)}</div>
                ${branchInfo ? `<div style="font-size: var(--font-sm); margin-top: 2px;">${branchInfo}</div>` : ''}
            </div>
        `;
    }).join('');
}

export async function refreshPullRequests() {
    if (!State.currentProject) return;

    const { owner, repo } = State.currentProject;

    try {
        // Phase 1: Fetch PR list and render immediately
        const prs = await Git.listMergeRequests(owner, repo, 'open');
        State.pullRequests = prs.map(pr => ({ ...pr, ciState: 'pending', ciStatuses: [] }));
        renderPullRequests();

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
    } catch (e) {
        console.warn('[PRs] Failed to refresh:', e.message);
        State.pullRequests = [];
        renderPullRequests();
    }
}

/**
 * Re-fetch the branch list and update the branch selector dropdown.
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

    const branchSelect = document.getElementById('branchSelect');
    if (!branchSelect) return;

    branchSelect.innerHTML = State.branches.map(b =>
        `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}${b.protected ? ' 🔒' : ''}</option>`
    ).join('');

    // Keep current selection if it still exists, otherwise switch to default
    const stillExists = State.branches.some(b => b.name === State.currentBranch);
    if (stillExists) {
        branchSelect.value = State.currentBranch;
    } else {
        const defaultBranch = State.currentProject.defaultBranch || 'main';
        branchSelect.value = defaultBranch;
        State.currentBranch = defaultBranch;
        EventBus.emit('branch:switch', { branch: defaultBranch });
    }
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
        // Open the newly created PR
        openPRDetailModal(pr.number);
    } catch (e) {
        errorEl.textContent = `Failed: ${e.message}`;
        errorEl.style.display = '';
        btn.disabled = false;
        btn.innerHTML = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/></svg><span>Create Pull Request</span>';
    }
}


// ============================================
// PR DETAIL (extracted to pr-detail.js)
// ============================================

import {
    openPRDetailModal,
    closePRDetailModal,
    submitMergePR,
    generatePRComment,
    submitPRComment
} from './pr-detail.js';

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
    // PR detail (from pr-detail.js)
    openPRDetailModal,
    closePRDetailModal,
    submitMergePR,
    generatePRComment,
    submitPRComment,
    // Issue detail (from issue-detail.js)
    openIssueTab,
    openIssueDetailModal,
    closeIssueDetailModal,
    startWorkOnIssue,
    focusIssue,
    unfocusIssue,
    clearActiveIssue
};
