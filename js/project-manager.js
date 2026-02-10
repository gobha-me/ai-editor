// ============================================
// PROJECT MANAGEMENT
// ============================================

import { State, EventBus } from './core.js';
import { Git, loadProject } from './git.js';
import { renderFileTree } from './file-tree.js';
import { renderMarkdown } from './secondary-pane.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

export async function refreshProjects() {
    try {
        const { repos, errors } = await Git.listAllRepos();
        const select = document.getElementById('projectSelect');
        select.innerHTML = '<option value="">Select a project...</option>';
        
        // Group repos by connection for the optgroup UI
        const grouped = new Map();
        repos.forEach(repo => {
            const key = repo.connectionId;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    label: `${repo.providerIcon} ${repo.connectionLabel}`,
                    repos: []
                });
            }
            grouped.get(key).repos.push(repo);
        });

        // Single connection: flat list. Multiple: optgroups.
        if (grouped.size <= 1) {
            repos.forEach(repo => {
                const option = document.createElement('option');
                // Encode connectionId into the value so onProjectChange can extract it
                option.value = `${repo.connectionId}/${repo.owner}/${repo.name}`;
                option.textContent = repo.fullName;
                select.appendChild(option);
            });
        } else {
            for (const [connId, group] of grouped) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = group.label;
                group.repos.forEach(repo => {
                    const option = document.createElement('option');
                    option.value = `${repo.connectionId}/${repo.owner}/${repo.name}`;
                    option.textContent = repo.fullName;
                    optgroup.appendChild(option);
                });
                select.appendChild(optgroup);
            }
        }

        if (errors.length > 0) {
            console.warn('Some connections failed to load repos:', errors);
        }

        window.showToast(`Loaded ${repos.length} projects`, 'success');
    } catch (error) {
        console.error('Failed to load projects:', error);
        window.showToast('Failed to load projects. Check connection settings.', 'error');
    }
}

export async function onProjectChange(e) {
    const value = e.target.value;
    if (!value) return;

    // Value format: "connectionId/owner/repo"
    const parts = value.split('/');
    if (parts.length < 3) {
        console.error('Invalid project selector value:', value);
        return;
    }
    const connectionId = parts[0];
    const owner = parts[1];
    const repo = parts.slice(2).join('/');  // Handle repos with slashes in name
    
    try {
        // Clear open tabs when switching projects
        State.openTabs = [];
        State.activeTabIndex = -1;
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;
        State.currentIssue = null;
        
        // Show welcome screen
        document.getElementById('editorContainer').innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: var(--font-2xl); margin-bottom: 1rem;">⚡ AI Editor</h2>
                    <p>Select a file to edit</p>
                </div>
            </div>
        `;
        
        const { renderEditorTabs } = await import('./tab-manager.js');
        renderEditorTabs();
        
        await loadProject(connectionId, owner, repo);
        
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
        EventBus.emit('project:loaded', { connectionId, owner, repo });

        window.showToast(`Loaded ${owner}/${repo}`, 'success');

    } catch (error) {
        console.error('Failed to load project:', error);
        window.showToast('Failed to load project', 'error');
    }
}

export async function onBranchChange(e) {
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
                    <h2 style="font-size: var(--font-2xl); margin-bottom: 1rem;">⚡ AI Editor</h2>
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

    EventBus.emit('statusBar:update');
}

// ============================================
// ISSUES & WORKFLOWS
// ============================================

export function renderIssues() {
    const container = document.getElementById('issuesPanel');
    
    if (State.issues.length === 0) {
        container.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-size: var(--font-md);">No open issues</div>';
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

        // Highlight if this issue is active (working) or focused (triaging)
        const isActive = State.currentIssue?.number === issue.number;
        const isFocused = State.focusedIssue?.number === issue.number;
        const activeClass = isActive ? ' issue-item-active' : isFocused ? ' issue-item-focused' : '';
        
        return `
            <div class="issue-item${activeClass}" onclick="window.focusIssue(${issue.number})">
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
    State.issues = await Git.listIssues(owner, repo);
    renderIssues();
}

const CI_ICONS = {
    'success': '✅',
    'pending': '🔄',
    'failure': '❌',
    'error': '❌',
    'unknown': '⚪'
};

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

    container.innerHTML = filtered.slice(0, 15).map(pr => {
        const ciIcon = CI_ICONS[pr.ciState] || '⚪';
        const ciTitle = pr.ciState === 'unknown' ? 'No CI status' : `CI: ${pr.ciState}`;
        const branchInfo = onDefault ? `<span style="color: var(--text-muted);">${escapeHtml(pr.head)} → ${escapeHtml(pr.base)}</span>` : '';

        return `
            <div class="issue-item" onclick="window.open('${escapeAttr(pr.url)}', '_blank')" title="${ciTitle}">
                <div class="issue-number">
                    <span class="pr-ci-badge" title="${ciTitle}">${ciIcon}</span>
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
        // Fetch all open PRs
        const prs = await Git.listMergeRequests(owner, repo, 'open');

        // Fetch CI status for each PR's head branch (parallel)
        const withStatus = await Promise.all(prs.map(async (pr) => {
            try {
                const status = await Git.getCommitStatus(owner, repo, pr.head);
                return { ...pr, ciState: status.state, ciStatuses: status.statuses };
            } catch {
                return { ...pr, ciState: 'unknown', ciStatuses: [] };
            }
        }));

        State.pullRequests = withStatus;
    } catch (e) {
        console.warn('[PRs] Failed to refresh:', e.message);
        State.pullRequests = [];
    }

    renderPullRequests();
}

// ============================================
// ISSUE DETAIL MODAL + BRANCH WORKFLOW
// ============================================

/** Currently viewed issue in the modal (full data, not just State.issues summary) */
let _modalIssue = null;

/**
 * Generate a deterministic branch name from an issue.
 * Format: issue/<number>-<slugified-title>
 * @param {number} number
 * @param {string} title
 * @returns {string}
 */
function issueBranchName(number, title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → dash
        .replace(/-{2,}/g, '-')         // collapse consecutive dashes
        .replace(/^-|-$/g, '')          // trim leading/trailing dashes
        .slice(0, 50)                   // cap length
        .replace(/-$/, '');             // trim trailing dash after truncation
    return `issue/${number}-${slug}`;
}

/**
 * Open the issue detail modal. Fetches full issue data (body, comments).
 * @param {number} issueNumber
 */
export async function openIssueDetailModal(issueNumber) {
    const modal = document.getElementById('issueDetailModal');
    if (!modal || !State.currentProject) return;

    const { owner, repo } = State.currentProject;

    // Show modal immediately with loading state
    modal.classList.add('active');
    document.getElementById('issueDetailTitle').textContent = `Issue #${issueNumber}`;
    document.getElementById('issueDetailBody').textContent = 'Loading…';
    document.getElementById('issueDetailLabels').innerHTML = '';
    document.getElementById('issueDetailMeta').textContent = '';
    document.getElementById('issueDetailComments').innerHTML = '';
    document.getElementById('issueDetailBranchInfo').style.display = 'none';

    try {
        // Fetch full issue data
        const issue = await Git.getIssue(owner, repo, issueNumber);

        // Fetch comments (non-blocking failure)
        let comments = [];
        try {
            comments = await Git.getIssueComments(owner, repo, issueNumber);
        } catch (e) {
            console.warn(`Could not fetch comments for #${issueNumber}:`, e.message);
        }

        _modalIssue = { ...issue, comments };

        // Title
        document.getElementById('issueDetailTitle').textContent = `#${issue.number}: ${issue.title}`;

        // Labels
        const labelsEl = document.getElementById('issueDetailLabels');
        if (issue.labels?.length) {
            labelsEl.innerHTML = issue.labels.map(l => {
                const name = typeof l === 'string' ? l : l.name || l;
                const color = (typeof l === 'object' && l.color) ? l.color : null;
                const style = color ? `background: #${color}; color: ${_contrastColor(color)}` : '';
                return `<span class="issue-label" style="${style}">${escapeHtml(name)}</span>`;
            }).join('');
        }

        // Meta
        const assignee = issue.assignees?.[0] || issue.assignee;
        const assigneeName = typeof assignee === 'string' ? assignee : assignee?.login || assignee?.username || null;
        const created = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString() : '';
        const metaParts = [];
        if (issue.state) metaParts.push(`State: ${issue.state}`);
        if (assigneeName) metaParts.push(`Assignee: ${assigneeName}`);
        if (created) metaParts.push(`Created: ${created}`);
        document.getElementById('issueDetailMeta').textContent = metaParts.join(' · ');

        // Body (render as markdown)
        const bodyEl = document.getElementById('issueDetailBody');
        bodyEl.innerHTML = issue.body
            ? renderMarkdown(issue.body)
            : '<em style="color: var(--text-muted);">No description</em>';
        bodyEl.classList.add('preview-markdown');

        // Comments preview (last 5)
        const commentsEl = document.getElementById('issueDetailComments');
        if (comments.length > 0) {
            const shown = comments.slice(-5);
            commentsEl.innerHTML = `
                <div style="font-size: var(--font-md); font-weight: 600; color: var(--text-secondary); margin-bottom: 0.4rem;">
                    Comments (${comments.length})
                </div>
                ${shown.map(c => `
                    <div style="font-size: var(--font-md); border-left: 2px solid var(--border); padding-left: 0.5rem; margin-bottom: 0.5rem;">
                        <div style="color: var(--text-muted);">${escapeHtml(c.user || 'unknown')} · ${c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}</div>
                        <div class="preview-markdown" style="max-height: 120px; overflow-y: auto;">${renderMarkdown(c.body || '')}</div>
                    </div>
                `).join('')}
            `;
        } else {
            commentsEl.innerHTML = '';
        }

        // Check if issue branch already exists
        const branchName = issueBranchName(issue.number, issue.title);
        const existingBranch = State.branches.find(b => b.name === branchName);
        const branchInfo = document.getElementById('issueDetailBranchInfo');
        const isOnBranch = State.currentBranch === branchName;

        if (isOnBranch) {
            branchInfo.style.display = 'block';
            branchInfo.innerHTML = `🔀 Currently on branch: <strong>${escapeHtml(branchName)}</strong>`;
            document.getElementById('btnIssueStartWork').textContent = '✅ Already Active';
            document.getElementById('btnIssueStartWork').disabled = true;
        } else if (existingBranch) {
            branchInfo.style.display = 'block';
            branchInfo.innerHTML = `🔀 Branch exists: <strong>${escapeHtml(branchName)}</strong> — Start Work will switch to it`;
            document.getElementById('btnIssueStartWork').textContent = '🔀 Switch & Start';
            document.getElementById('btnIssueStartWork').disabled = false;
        } else {
            branchInfo.style.display = 'block';
            const baseBranch = State.currentProject.defaultBranch || 'main';
            branchInfo.innerHTML = `🌱 Will create: <strong>${escapeHtml(branchName)}</strong> from <strong>${escapeHtml(baseBranch)}</strong>`;
            document.getElementById('btnIssueStartWork').textContent = '🚀 Start Work';
            document.getElementById('btnIssueStartWork').disabled = false;
        }

        // Wire up Start Work button
        document.getElementById('btnIssueStartWork').onclick = () => {
            startWorkOnIssue(issue);
        };

    } catch (error) {
        console.error(`Failed to load issue #${issueNumber}:`, error);
        document.getElementById('issueDetailBody').textContent = `Error loading issue: ${error.message}`;
    }
}

export function closeIssueDetailModal() {
    const modal = document.getElementById('issueDetailModal');
    if (modal) modal.classList.remove('active');
    _modalIssue = null;
}

/**
 * Start work on an issue:
 * 1. Create branch if it doesn't exist, or switch to it
 * 2. Set State.currentIssue
 * 3. Refresh file tree, branch selector, issues panel
 * 4. Inject issue context into system prompt (via State.currentIssue)
 */
export async function startWorkOnIssue(issue) {
    if (!State.currentProject) return;
    const { owner, repo } = State.currentProject;
    const branchName = issueBranchName(issue.number, issue.title);
    const baseBranch = State.currentProject.defaultBranch || 'main';

    const startBtn = document.getElementById('btnIssueStartWork');
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.textContent = '⏳ Working…';
    }

    try {
        // Check if branch exists
        const existingBranch = State.branches.find(b => b.name === branchName);

        if (!existingBranch) {
            // Create the branch from default
            await Git.createBranch(owner, repo, branchName, baseBranch);
            // Refresh branch list
            State.branches = await Git.listBranches(owner, repo);
        }

        // Switch to the branch
        State.currentBranch = branchName;

        // Update branch selector to reflect reality
        const branchSelect = document.getElementById('branchSelect');
        if (branchSelect) {
            branchSelect.innerHTML = State.branches.map(b =>
                `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}${b.protected ? ' 🔒' : ''}</option>`
            ).join('');
            branchSelect.value = branchName;
        }

        // Clear open tabs (branch context changed)
        State.openTabs = [];
        State.activeTabIndex = -1;
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;

        document.getElementById('editorContainer').innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: var(--font-2xl); margin-bottom: 1rem;">⚡ AI Editor</h2>
                    <p>Working on #${issue.number}: ${escapeHtml(issue.title)}</p>
                    <p style="font-size: var(--font-md); margin-top: 0.5rem;">Branch: ${branchName}</p>
                </div>
            </div>
        `;

        const { renderEditorTabs } = await import('./tab-manager.js');
        renderEditorTabs();

        // Close secondary pane
        const { closeSecondaryPane } = await import('./secondary-pane.js');
        closeSecondaryPane();

        // Set active issue (drives system prompt injection)
        State.currentIssue = {
            number: issue.number,
            title: issue.title,
            branch: branchName
        };

        // Refresh file tree for new branch
        EventBus.emit('tree:refresh');
        EventBus.emit('statusBar:update');

        // Re-render issues to highlight the active one
        renderIssues();

        closeIssueDetailModal();

        window.showToast(
            existingBranch 
                ? `Switched to branch: ${branchName}` 
                : `Created & switched to: ${branchName}`,
            'success'
        );

        // Kick off the LLM — it will see the active issue in the system prompt
        // and can read_issue for full details
        window.Chat?.sendMessage(`Start work on issue #${issue.number}`);

    } catch (error) {
        console.error('Failed to start work on issue:', error);
        window.showToast(`Failed: ${error.message}`, 'error');
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = '🚀 Start Work';
        }
    }
}

/**
 * Clear the active issue (e.g., when switching branches manually).
 */
// ============================================
// CONVERSATIONAL ISSUE TRIAGE
// Focus an issue in the chat panel for discussion
// ============================================

/**
 * Focus an issue in the chat panel for conversational triage.
 * Fetches full issue data + comments and renders the focus bar.
 */
export async function focusIssue(issueNumber) {
    if (!State.currentProject) return;
    const { owner, repo } = State.currentProject;

    // Show bar immediately with loading state
    const bar = document.getElementById('issueFocusBar');
    if (bar) {
        bar.style.display = '';
        document.getElementById('issueFocusTitle').textContent = `Loading #${issueNumber}…`;
        document.getElementById('issueFocusMeta').textContent = '';
        document.getElementById('issueFocusBody').textContent = '';
        document.getElementById('issueFocusComments').innerHTML = '';
    }

    try {
        const issue = await Git.getIssue(owner, repo, issueNumber);
        let comments = [];
        try {
            comments = await Git.getIssueComments(owner, repo, issueNumber);
        } catch (e) {
            console.warn(`[focusIssue] Could not fetch comments for #${issueNumber}:`, e.message);
        }

        State.focusedIssue = { ...issue, issueComments: comments };
        renderIssueFocusBar();

        // Highlight in sidebar
        renderIssues();

        // Seed the chat with context about the focused issue
        EventBus.emit('issue:focused', State.focusedIssue);
    } catch (error) {
        console.error(`[focusIssue] Failed to load #${issueNumber}:`, error);
        if (bar) {
            document.getElementById('issueFocusTitle').textContent = `Error loading #${issueNumber}`;
            document.getElementById('issueFocusBody').textContent = error.message;
        }
    }
}

/**
 * Dismiss the focused issue, return chat to normal mode.
 */
export function unfocusIssue() {
    State.focusedIssue = null;
    const bar = document.getElementById('issueFocusBar');
    if (bar) bar.style.display = 'none';
    renderIssues();  // Remove highlight
    EventBus.emit('issue:unfocused');
}

/**
 * Render the issue focus bar in the chat panel.
 */
function renderIssueFocusBar() {
    const issue = State.focusedIssue;
    const bar = document.getElementById('issueFocusBar');
    if (!bar || !issue) return;

    bar.style.display = '';

    // Title
    document.getElementById('issueFocusTitle').textContent = `#${issue.number}: ${issue.title}`;

    // Meta: state, labels, assignees, date
    const metaEl = document.getElementById('issueFocusMeta');
    const parts = [];
    if (issue.state) parts.push(issue.state === 'open' ? '🟢 Open' : '🔴 Closed');
    if (issue.assignees?.length) parts.push(`👤 ${issue.assignees.join(', ')}`);
    if (issue.createdAt) parts.push(new Date(issue.createdAt).toLocaleDateString());

    let labelsHtml = '';
    if (issue.labels?.length) {
        labelsHtml = issue.labels.map(l => {
            const name = typeof l === 'string' ? l : l.name || l;
            return `<span class="issue-label">${escapeHtml(name)}</span>`;
        }).join('');
    }
    metaEl.innerHTML = escapeHtml(parts.join(' · ')) + (labelsHtml ? ' ' + labelsHtml : '');

    // Body (render as markdown)
    const bodyEl = document.getElementById('issueFocusBody');
    bodyEl.innerHTML = issue.body
        ? renderMarkdown(issue.body)
        : '<em style="color: var(--text-muted);">No description</em>';
    bodyEl.classList.add('preview-markdown');

    // Comments (last 3)
    const commentsEl = document.getElementById('issueFocusComments');
    const comments = issue.issueComments || [];
    if (comments.length > 0) {
        const shown = comments.slice(-3);
        const moreText = comments.length > 3 ? `<div style="color: var(--text-muted); margin-bottom: 0.3rem;">… ${comments.length - 3} earlier comments</div>` : '';
        commentsEl.innerHTML = moreText + shown.map(c => `
            <div class="issue-focus-comment-item">
                <div class="issue-focus-comment-meta">${escapeHtml(c.user || 'unknown')} · ${c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}</div>
                <div class="issue-focus-comment-body preview-markdown">${renderMarkdown(c.body || '')}</div>
            </div>
        `).join('');
    } else {
        commentsEl.innerHTML = '';
    }
}

/**
 * Quick action: Accept issue — post comment and close.
 */
async function acceptFocusedIssue() {
    const issue = State.focusedIssue;
    if (!issue || !State.currentProject) return;

    const comment = prompt(`Accept #${issue.number}: ${issue.title}\n\nAdd a comment (optional):`);
    if (comment === null) return;  // Cancelled

    const { owner, repo } = State.currentProject;
    try {
        const body = comment || 'Accepted — will address this.';
        await Git.createIssueComment(owner, repo, issue.number, `✅ **Accepted**\n\n${body}`);
        // Don't close — accepted means "will work on". Leave open for tracking.
        EventBus.emit('issues:refresh');
        // Refresh focus bar with new comment
        await focusIssue(issue.number);
    } catch (e) {
        alert(`Failed to comment: ${e.message}`);
    }
}

/**
 * Quick action: Deny issue — post comment and close.
 */
async function denyFocusedIssue() {
    const issue = State.focusedIssue;
    if (!issue || !State.currentProject) return;

    const comment = prompt(`Deny #${issue.number}: ${issue.title}\n\nReason (required):`);
    if (!comment) return;  // Cancelled or empty

    const { owner, repo } = State.currentProject;
    try {
        await Git.createIssueComment(owner, repo, issue.number, `❌ **Denied**\n\n${comment}`);
        await Git.updateIssueState(owner, repo, issue.number, 'closed');
        EventBus.emit('issues:refresh');
        unfocusIssue();
    } catch (e) {
        alert(`Failed to deny issue: ${e.message}`);
    }
}

/**
 * Quick action: Add comment without changing state.
 */
async function commentOnFocusedIssue() {
    const issue = State.focusedIssue;
    if (!issue || !State.currentProject) return;

    const comment = prompt(`Comment on #${issue.number}: ${issue.title}`);
    if (!comment) return;

    const { owner, repo } = State.currentProject;
    try {
        await Git.createIssueComment(owner, repo, issue.number, comment);
        EventBus.emit('issues:refresh');
        await focusIssue(issue.number);
    } catch (e) {
        alert(`Failed to comment: ${e.message}`);
    }
}

export function clearActiveIssue() {
    State.currentIssue = null;
    renderIssues();
}

/**
 * Pick white or black text for a hex background color.
 * @param {string} hex - 6-char hex color (no #)
 * @returns {string} '#fff' or '#000'
 */
function _contrastColor(hex) {
    if (!hex || hex.length < 6) return '#fff';
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000' : '#fff';
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
}
