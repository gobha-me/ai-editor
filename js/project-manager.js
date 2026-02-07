// ============================================
// PROJECT MANAGEMENT
// ============================================

import { State, EventBus } from './core.js';
import { GiteaAPI, loadProject } from './gitea.js';
import { renderFileTree } from './file-tree';

export async function refreshProjects() {
    try {
        const repos = await GiteaAPI.listUserRepos();
        const select = document.getElementById('projectSelect');
        select.innerHTML = '<option value="">Select a project...</option>';
        
        repos.forEach(repo => {
            const option = document.createElement('option');
            option.value = `${repo.owner}/${repo.name}`;
            option.textContent = repo.fullName;
            select.appendChild(option);
        });

        window.showToast(`Loaded ${repos.length} projects`, 'success');
    } catch (error) {
        console.error('Failed to load projects:', error);
        window.showToast('Failed to load projects. Check Gitea settings.', 'error');
    }
}

export async function onProjectChange(e) {
    const value = e.target.value;
    if (!value) return;

    const [owner, repo] = value.split('/');
    
    try {
        // Clear open tabs when switching projects
        State.openTabs = [];
        State.activeTabIndex = -1;
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;
        
        // Show welcome screen
        document.getElementById('editorContainer').innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: 24px; margin-bottom: 1rem;">⚡ AI Editor</h2>
                    <p>Select a file to edit</p>
                </div>
            </div>
        `;
        
        const { renderEditorTabs } = await import('./tab-manager.js');
        renderEditorTabs();
        
        await loadProject(owner, repo);
        
        // Update branch selector
        const branchSelect = document.getElementById('branchSelect');
        branchSelect.innerHTML = '';
        State.branches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch.name;
            option.textContent = branch.name + (branch.protected ? ' 🔒' : '');
            branchSelect.appendChild(option);
        });
        branchSelect.value = State.currentBranch;

        // Trigger refresh events for other modules
        EventBus.emit('project:loaded', { owner, repo });

        window.showToast(`Loaded ${owner}/${repo}`, 'success');

    } catch (error) {
        console.error('Failed to load project:', error);
        window.showToast('Failed to load project', 'error');
    }
}

export async function onBranchChange(e) {
    State.currentBranch = e.target.value;
    
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
                    <h2 style="font-size: 24px; margin-bottom: 1rem;">⚡ AI Editor</h2>
                    <p>Select a file to edit</p>
                </div>
            </div>
        `;
        
        const { renderEditorTabs } = await import('./tab-manager.js');
        renderEditorTabs();
        
        // Reload file tree for new branch
        const { owner, repo } = State.currentProject;
        State.fileTree = await GiteaAPI.getFileTree(owner, repo, State.currentBranch);
        EventBus.emit('tree:refresh');
    }

    EventBus.emit('statusBar:update');
}

// ============================================
// ISSUES & WORKFLOWS
// ============================================

export function renderIssues() {
    const container = document.getElementById('issuesPanel');
    
    if (State.issues.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-size: 12px;">No open issues</div>';
        return;
    }

    container.innerHTML = State.issues.slice(0, 15).map(issue => {
        // Build dependencies display
        let depsHtml = '';
        if (issue.dependencies && issue.dependencies.length > 0) {
            const depLinks = issue.dependencies.map(depNum => 
                `<span class="dep-link" onclick="event.stopPropagation(); window.Chat.sendMessage('Show me issue #${depNum}')">#${depNum}</span>`
            ).join(', ');
            depsHtml = `<div class="issue-deps">⛓️ Depends on: ${depLinks}</div>`;
        }
        
        return `
            <div class="issue-item" onclick="window.Chat.sendMessage('Work on issue #${issue.number}')">
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
    State.issues = await GiteaAPI.listIssues(owner, repo);
    renderIssues();
}

export function renderWorkflows() {
    const container = document.getElementById('workflowsPanel');
    
    if (State.workflowRuns.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-size: 12px;">No workflow runs</div>';
        return;
    }

    const statusIcons = {
        'completed': '✅',
        'success': '✅',
        'failure': '❌',
        'cancelled': '⚪',
        'in_progress': '🔄',
        'queued': '⏳'
    };

    container.innerHTML = State.workflowRuns.slice(0, 5).map(run => `
        <div class="issue-item" onclick="window.open('${run.url}', '_blank')">
            <div class="issue-number">${statusIcons[run.conclusion || run.status] || '❓'} ${run.name}</div>
            <div class="issue-title" style="font-size: 11px; color: var(--text-muted);">${run.branch} · ${run.event}</div>
        </div>
    `).join('');
}

export async function refreshWorkflows() {
    if (!State.currentProject) return;
    
    const { owner, repo } = State.currentProject;
    State.workflowRuns = await GiteaAPI.listWorkflowRuns(owner, repo);
    renderWorkflows();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Setup event listeners for project changes
export function initProjectListeners() {
    EventBus.on('project:loaded', () => {
        renderFileTree();
        renderIssues();
        renderWorkflows();
    });
    
    EventBus.on('tree:refresh', async () => {
        renderFileTree();
    });
    
    EventBus.on('issues:refresh', refreshIssues);
}
