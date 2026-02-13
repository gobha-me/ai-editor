/**
 * AI Editor - Issue Detail Modal & Triage
 *
 * Issue detail view, branch workflow (start work on issue),
 * conversational triage (focus bar, accept/deny/comment), and
 * helper utilities.
 *
 * Extracted from project-manager.js for readability.
 * All public exports are re-exported from project-manager.js so
 * downstream imports remain unchanged.
 *
 * @module issue-detail
 */

import { State, EventBus } from './core.js';
import { Git } from './git.js';
import { renderMarkdown } from './secondary-pane.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

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
    document.getElementById('issueDetailMeta').innerHTML = '';
    document.getElementById('issueDetailComments').innerHTML = '';
    document.getElementById('issueDetailBranchInfo').style.display = 'none';
    const extLinkEl = document.getElementById('issueDetailExternalLink');
    if (extLinkEl) extLinkEl.style.display = 'none';
    // Reset collapsible sections
    const bodySection = document.getElementById('issueDetailBodySection');
    if (bodySection) bodySection.open = true;
    const commentsHdr = document.getElementById('issueDetailCommentsHeader');
    if (commentsHdr) commentsHdr.style.display = 'none';
    const commentsSec = document.getElementById('issueDetailCommentsSection');
    if (commentsSec) commentsSec.open = false;

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
            labelsEl.style.display = '';
        } else {
            labelsEl.style.display = 'none';
        }

        // Meta — render as badge row (matching PR modal style)
        const assignee = issue.assignees?.[0] || issue.assignee;
        const assigneeName = typeof assignee === 'string' ? assignee : assignee?.login || assignee?.username || null;
        const created = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString() : '';
        const metaEl = document.getElementById('issueDetailMeta');
        const metaParts = [];

        // State badge
        if (issue.state) {
            const stateClass = issue.state === 'open' ? 'badge-state-open' : 'badge-state-closed';
            const stateIcon = issue.state === 'open' ? '🟢' : '🔴';
            metaParts.push(`<span class="badge-state ${stateClass}">${stateIcon} ${issue.state.charAt(0).toUpperCase() + issue.state.slice(1)}</span>`);
        }
        if (assigneeName) {
            metaParts.push(`<span class="modal-meta-item">👤 ${escapeHtml(assigneeName)}</span>`);
        }
        if (created) {
            metaParts.push(`<span class="modal-meta-item">📅 ${created}</span>`);
        }
        metaEl.innerHTML = metaParts.join('<span class="meta-sep">·</span>');

        // External link
        const extLink = document.getElementById('issueDetailExternalLink');
        if (extLink && issue.url) {
            extLink.href = issue.url;
            extLink.style.display = '';
        } else if (extLink) {
            extLink.style.display = 'none';
        }

        // Body (render as markdown)
        const bodyEl = document.getElementById('issueDetailBody');
        bodyEl.innerHTML = issue.body
            ? renderMarkdown(issue.body)
            : '<em style="color: var(--text-muted);">No description</em>';
        bodyEl.classList.add('preview-markdown');

        // Comments — collapsible when 2+
        const commentsEl = document.getElementById('issueDetailComments');
        const commentsHeader = document.getElementById('issueDetailCommentsHeader');
        const commentsTitle = document.getElementById('issueDetailCommentsTitle');
        const commentsSection = document.getElementById('issueDetailCommentsSection');
        const toggleAllBtn = document.getElementById('btnToggleAllComments');

        if (comments.length > 0) {
            // Show the section header and auto-open
            if (commentsHeader) commentsHeader.style.display = '';
            if (commentsSection) commentsSection.open = true;
            if (commentsTitle) commentsTitle.textContent = `Comments (${comments.length})`;

            // Show expand/collapse all when 2+ comments
            if (toggleAllBtn) {
                toggleAllBtn.style.display = comments.length > 1 ? '' : 'none';
                toggleAllBtn.textContent = 'Expand All';
            }

            const commentItems = comments.map((c, i) => {
                const user = escapeHtml(c.user || 'unknown');
                const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
                const bodyHtml = renderMarkdown(c.body || '');
                // First comment open by default, rest collapsed
                const open = i === 0 ? ' open' : '';
                const preview = (c.body || '').length > 100 ? escapeHtml((c.body || '').substring(0, 80).replace(/\n/g, ' ')) + '…' : '';
                return `
                    <details${open} class="modal-comment-item issue-comment-collapsible">
                        <summary>
                            <span class="comment-chevron">▶</span>
                            <strong>${user}</strong> · ${date}
                            <span class="comment-preview">${preview}</span>
                        </summary>
                        <div class="comment-body preview-markdown">${bodyHtml}</div>
                    </details>
                `;
            }).join('');

            commentsEl.innerHTML = commentItems;

            // Wire expand/collapse all
            if (toggleAllBtn) {
                toggleAllBtn.onclick = (e) => {
                    e.stopPropagation();
                    const details = commentsEl.querySelectorAll('details.issue-comment-collapsible');
                    const allOpen = [...details].every(d => d.open);
                    details.forEach(d => d.open = !allOpen);
                    toggleAllBtn.textContent = allOpen ? 'Expand All' : 'Collapse All';
                };
            }
        } else {
            commentsEl.innerHTML = '';
            if (commentsHeader) commentsHeader.style.display = 'none';
            if (commentsSection) commentsSection.open = false;
        }

        // Check if issue branch already exists
        const branchName = issueBranchName(issue.number, issue.title);
        const existingBranch = State.branches.find(b => b.name === branchName);
        const branchInfo = document.getElementById('issueDetailBranchInfo');
        const isOnBranch = State.currentBranch === branchName;

        if (isOnBranch) {
            branchInfo.style.display = 'block';
            branchInfo.className = 'issue-detail-branch-info branch-active';
            branchInfo.innerHTML = `✅ Currently on branch: <strong>${escapeHtml(branchName)}</strong>`;
            document.getElementById('btnIssueStartWork').textContent = '✅ Already Active';
            document.getElementById('btnIssueStartWork').disabled = true;
        } else if (existingBranch) {
            branchInfo.style.display = 'block';
            branchInfo.className = 'issue-detail-branch-info branch-exists';
            branchInfo.innerHTML = `🔀 Branch exists: <strong>${escapeHtml(branchName)}</strong> — Start Work will switch to it`;
            document.getElementById('btnIssueStartWork').textContent = '🔀 Switch & Start';
            document.getElementById('btnIssueStartWork').disabled = false;
        } else {
            branchInfo.style.display = 'block';
            branchInfo.className = 'issue-detail-branch-info branch-create';
            const baseBranch = State.currentProject.defaultBranch || 'main';
            branchInfo.innerHTML = `🌱 Will create: <strong>${escapeHtml(branchName)}</strong> from <strong>${escapeHtml(baseBranch)}</strong>`;
            document.getElementById('btnIssueStartWork').textContent = '✏️ Start Work';
            document.getElementById('btnIssueStartWork').disabled = false;
        }

        // Wire up Start Work button
        document.getElementById('btnIssueStartWork').onclick = () => {
            startWorkOnIssue(issue);
        };

    } catch (error) {
        console.error(`Failed to load issue #${issueNumber}:`, error);
        document.getElementById('issueDetailBody').textContent = `Error: ${error.message}`;
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

        // Re-render issues to highlight the active one (avoids circular import)
        EventBus.emit('issues:render');

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
            startBtn.textContent = '✏️ Start Work';
        }
    }
}

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

        // Highlight in sidebar (avoids circular import)
        EventBus.emit('issues:render');

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
    EventBus.emit('issues:render');  // Remove highlight
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
        const headerText = comments.length > 3
            ? `💬 Comments (${comments.length}, showing last 3)`
            : `💬 Comments (${comments.length})`;
        const header = `<div style="font-size: 11px; font-weight: 600; color: var(--text-muted); margin-bottom: 0.3rem;">${headerText}</div>`;
        commentsEl.innerHTML = header + shown.map(c => `
            <div class="issue-focus-comment-item">
                <div class="issue-focus-comment-meta">${escapeHtml(c.user || 'unknown')} · ${c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}</div>
                <div class="issue-focus-comment-body preview-markdown">${renderMarkdown(c.body || '')}</div>
            </div>
        `).join('');
    } else {
        commentsEl.innerHTML = '';
    }
}

// ── Triage quick actions ──

/**
 * Retry a git operation up to `n` times with a brief delay.
 * Designed for transient "Failed to fetch" / CORS preflight failures.
 */
async function _retryOp(fn, retries = 2, delayMs = 600) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            const isTransient = !e.status && /fetch|network|abort/i.test(e.message);
            if (i < retries && isTransient) {
                await new Promise(r => setTimeout(r, delayMs * (i + 1)));
                continue;
            }
            throw e;
        }
    }
}

/**
 * Quick action: Accept issue — post comment and close.
 */
export async function acceptFocusedIssue() {
    const issue = State.focusedIssue;
    if (!issue || !State.currentProject) return;

    const comment = prompt(`Accept #${issue.number}: ${issue.title}\n\nAdd a comment (optional):`);
    if (comment === null) return;  // Cancelled

    const { owner, repo } = State.currentProject;
    try {
        const body = comment || 'Accepted — will address this.';
        await _retryOp(() => Git.createIssueComment(owner, repo, issue.number, `✅ **Accepted**\n\n${body}`));
        // Don't close — accepted means "will work on". Leave open for tracking.
        EventBus.emit('issues:refresh');
        window.showToast(`Accepted #${issue.number}`, 'success');
        // Refresh focus bar with new comment
        await focusIssue(issue.number);
    } catch (e) {
        console.error('[Triage] Accept failed:', e);
        window.showToast(`Failed to accept: ${e.message}`, 'error');
    }
}

/**
 * Quick action: Deny issue — post comment and close.
 * Handles partial failure: if comment posts but close fails,
 * reports which step failed so the user isn't confused.
 */
export async function denyFocusedIssue() {
    const issue = State.focusedIssue;
    if (!issue || !State.currentProject) return;

    const comment = prompt(`Deny #${issue.number}: ${issue.title}\n\nReason (required):`);
    if (!comment) return;  // Cancelled or empty

    const { owner, repo } = State.currentProject;
    let commentPosted = false;

    try {
        // Step 1: Post denial comment
        await _retryOp(() => Git.createIssueComment(owner, repo, issue.number, `❌ **Denied**\n\n${comment}`));
        commentPosted = true;

        // Step 2: Close the issue
        await _retryOp(() => Git.updateIssueState(owner, repo, issue.number, 'closed'));

        EventBus.emit('issues:refresh');
        window.showToast(`Denied & closed #${issue.number}`, 'success');
        unfocusIssue();
    } catch (e) {
        console.error('[Triage] Deny failed:', e);
        if (commentPosted) {
            // Comment posted but close failed — partial success
            window.showToast(`Comment posted but failed to close #${issue.number}: ${e.message}`, 'warning');
            EventBus.emit('issues:refresh');
            await focusIssue(issue.number);
        } else {
            window.showToast(`Failed to deny #${issue.number}: ${e.message}`, 'error');
        }
    }
}

/**
 * Quick action: Add comment without changing state.
 */
export async function commentOnFocusedIssue() {
    const issue = State.focusedIssue;
    if (!issue || !State.currentProject) return;

    const comment = prompt(`Comment on #${issue.number}: ${issue.title}`);
    if (!comment) return;

    const { owner, repo } = State.currentProject;
    try {
        await _retryOp(() => Git.createIssueComment(owner, repo, issue.number, comment));
        EventBus.emit('issues:refresh');
        window.showToast(`Comment posted on #${issue.number}`, 'success');
        await focusIssue(issue.number);
    } catch (e) {
        console.error('[Triage] Comment failed:', e);
        window.showToast(`Failed to comment: ${e.message}`, 'error');
    }
}

export function clearActiveIssue() {
    State.currentIssue = null;
    EventBus.emit('issues:render');
}

// ============================================
// HELPERS
// ============================================

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
