/**
 * AI Editor - Issue Detail (Tab + Modal + Triage)
 *
 * v0.9.39: Issues now open as editor tabs instead of modals.
 *   - openIssueTab(n)        — primary entry: opens issue in a tab
 *   - renderIssueTabContent() — renders full detail into editor container
 *   - openIssueDetailModal()  — legacy modal (still available)
 *   - focusIssue() / unfocusIssue() — chat triage bar (unchanged)
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
import { registerTabRenderer } from './tab-manager.js';
import { showConfirm, showPrompt } from './ui/dialogs.js';

// ============================================
// ISSUE TABS (v0.9.39)
// ============================================

/**
 * Open an issue as an editor tab.
 * If the issue is already open, switches to it.
 * Single-click opens as preview; called with pin=true to make permanent.
 * @param {number} issueNumber
 * @param {object} [opts]
 * @param {boolean} [opts.pin=false]  - If true, open as permanent (not preview)
 * @param {boolean} [opts.focus=true] - If true, switch to the tab after creating
 */
export async function openIssueTab(issueNumber, opts = {}) {
    const { pin = false, focus = true } = opts;
    if (!State.currentProject) return;

    // Already open? Switch to it.
    const existingIdx = State.openTabs.findIndex(
        t => t.type === 'issue' && t.issueNumber === issueNumber
    );
    if (existingIdx >= 0) {
        const { switchToTab } = await import('./tab-manager.js');
        await switchToTab(existingIdx);
        if (pin) {
            State.openTabs[existingIdx].isPreview = false;
            const { renderEditorTabs } = await import('./tab-manager.js');
            renderEditorTabs();
        }
        return;
    }

    // Save current file tab state
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        const cur = State.openTabs[State.activeTabIndex];
        if (!cur.type || cur.type === 'file') {
            cur.content = State.editorContent;
            cur.dirty = State.editorDirty;
        }
    }

    const isPreview = !pin;
    const newTab = {
        type: 'issue',
        path: `issue:${issueNumber}`,   // synthetic path for dedup
        issueNumber,
        issueData: null,                // filled on render
        isPreview,
        dirty: false
    };

    if (isPreview) {
        // Replace existing preview tab (any type)
        const previewIdx = State.openTabs.findIndex(t => t.isPreview);
        if (previewIdx >= 0) {
            State.openTabs[previewIdx] = newTab;
            State.activeTabIndex = previewIdx;
        } else {
            State.openTabs.push(newTab);
            State.activeTabIndex = State.openTabs.length - 1;
        }
    } else {
        State.openTabs.push(newTab);
        State.activeTabIndex = State.openTabs.length - 1;
    }

    if (focus) {
        const { switchToTab } = await import('./tab-manager.js');
        await switchToTab(State.activeTabIndex);
    }
}

/**
 * Render issue content into the editor container (called by tab renderer).
 * Fetches full issue data + comments, then builds the in-tab view.
 * @param {HTMLElement} container
 * @param {object} tab - The tab object from State.openTabs
 */
async function renderIssueTabContent(container, tab) {
    const issueNumber = tab.issueNumber;
    const { owner, repo } = State.currentProject || {};
    if (!owner || !repo) {
        container.innerHTML = _issueTabShell(issueNumber, '<p style="color:var(--text-muted)">No project selected</p>');
        return;
    }

    // Show loading state
    container.innerHTML = _issueTabShell(issueNumber, `
        <div class="issue-tab-loading">
            <span class="spinner-dot"></span> Loading issue #${issueNumber}…
        </div>
    `);

    try {
        const issue = await Git.getIssue(owner, repo, issueNumber);
        let comments = [];
        try {
            comments = await Git.getIssueComments(owner, repo, issueNumber);
        } catch (e) {
            console.warn(`[IssueTab] Could not fetch comments for #${issueNumber}:`, e.message);
        }

        const data = { ...issue, comments };
        tab.issueData = data;

        // Re-render tab bar to pick up the title
        const { renderEditorTabs } = await import('./tab-manager.js');
        renderEditorTabs();

        // Build full view
        container.innerHTML = _buildIssueTabView(data);

        // Wire action buttons
        _wireIssueTabActions(container, data);

    } catch (err) {
        console.error(`[IssueTab] Failed to load #${issueNumber}:`, err);
        container.innerHTML = _issueTabShell(issueNumber, `
            <div class="issue-tab-error">
                <p>Failed to load issue #${issueNumber}</p>
                <p style="color:var(--text-muted); font-size: var(--font-md);">${escapeHtml(err.message)}</p>
                <button class="btn btn-secondary" onclick="window.openIssueTab(${issueNumber})">Retry</button>
            </div>
        `);
    }
}

// Register the renderer with the tab manager
registerTabRenderer('issue', renderIssueTabContent);

// ── Issue tab HTML builders ───────────────────────────────

function _issueTabShell(issueNumber, body) {
    return `
        <div class="issue-tab-content" data-issue="${issueNumber}">
            ${body}
        </div>
    `;
}

function _buildIssueTabView(issue) {
    const stateClass = issue.state === 'open' ? 'badge-state-open' : 'badge-state-closed';
    const stateIcon = issue.state === 'open' ? '🟢' : '🔴';
    const stateLabel = issue.state ? issue.state.charAt(0).toUpperCase() + issue.state.slice(1) : '';

    const assignee = issue.assignees?.[0] || issue.assignee;
    const assigneeName = typeof assignee === 'string' ? assignee : assignee?.login || assignee?.username || null;
    const created = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString() : '';

    // Labels
    const labelsHtml = (issue.labels || []).map(l => {
        const name = typeof l === 'string' ? l : l.name || l;
        const color = (typeof l === 'object' && l.color) ? l.color : null;
        const style = color ? `background: #${color}; color: ${_contrastColor(color)}` : '';
        return `<span class="issue-label" style="${style}">${escapeHtml(name)}</span>`;
    }).join('');

    // Meta badges
    const metaParts = [];
    if (issue.state) metaParts.push(`<span class="badge-state ${stateClass}">${stateIcon} ${stateLabel}</span>`);
    if (assigneeName) metaParts.push(`<span class="modal-meta-item">👤 ${escapeHtml(assigneeName)}</span>`);
    if (created) metaParts.push(`<span class="modal-meta-item">📅 ${created}</span>`);

    // Body
    const bodyHtml = issue.body
        ? renderMarkdown(issue.body)
        : '<em style="color: var(--text-muted);">No description</em>';

    // Comments
    const comments = issue.comments || [];
    let commentsHtml = '';
    if (comments.length > 0) {
        const commentItems = comments.map((c, i) => {
            const user = escapeHtml(c.user || 'unknown');
            const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
            const cBody = renderMarkdown(c.body || '');
            const open = i === 0 ? ' open' : '';
            const preview = (c.body || '').length > 100 ? escapeHtml((c.body || '').substring(0, 80).replace(/\n/g, ' ')) + '…' : '';
            return `
                <details${open} class="modal-comment-item issue-comment-collapsible">
                    <summary>
                        <span class="comment-chevron">▶</span>
                        <strong>${user}</strong> · ${date}
                        <span class="comment-preview">${preview}</span>
                    </summary>
                    <div class="comment-body preview-markdown">${cBody}</div>
                </details>
            `;
        }).join('');

        commentsHtml = `
            <details class="issue-detail-section" open>
                <summary class="modal-section-header">
                    <span class="section-chevron">▶</span>
                    Comments (${comments.length})
                    ${comments.length > 1 ? `<span style="margin-left:auto;"><button type="button" class="btn btn-secondary btn-xs issue-tab-toggle-comments">Expand All</button></span>` : ''}
                </summary>
                <div class="issue-detail-comments">${commentItems}</div>
            </details>
        `;
    }

    // Branch info — driven by the shared computeIssueBranchState helper so the
    // modal and the inline issue-row Start button stay in lockstep.
    const { branchName, existingBranch, isOnBranch, defaultBranch: baseBranch } =
        computeIssueBranchState(issue, {
            branches: State.branches,
            currentBranch: State.currentBranch,
            defaultBranch: State.currentProject?.defaultBranch,
        });
    let branchInfoHtml = '';
    let startBtnLabel = '✏️ Start Work';
    let startBtnDisabled = false;

    if (isOnBranch) {
        branchInfoHtml = `<div class="issue-detail-branch-info branch-active">✅ Currently on branch: <strong>${escapeHtml(branchName)}</strong></div>`;
        startBtnLabel = '✅ Already Active';
        startBtnDisabled = true;
    } else if (existingBranch) {
        branchInfoHtml = `<div class="issue-detail-branch-info branch-exists">🔀 Branch exists: <strong>${escapeHtml(branchName)}</strong> — Start Work will switch to it</div>`;
        startBtnLabel = '🔀 Switch & Start';
    } else {
        branchInfoHtml = `<div class="issue-detail-branch-info branch-create">🌱 Will create: <strong>${escapeHtml(branchName)}</strong> from <strong>${escapeHtml(baseBranch)}</strong></div>`;
    }

    // External link
    const extLink = issue.url
        ? `<a href="${escapeAttr(issue.url)}" target="_blank" class="btn btn-secondary btn-sm" title="Open in browser" style="text-decoration:none;">🌐 Open in Browser</a>`
        : '';

    return `
        <div class="issue-tab-content" data-issue="${issue.number}">
            <div class="issue-tab-header">
                <h2 class="issue-tab-title">#${issue.number}: ${escapeHtml(issue.title)}</h2>
                <div class="issue-tab-header-actions">
                    ${extLink}
                    <button type="button" class="btn btn-secondary btn-sm issue-tab-refresh" title="Refresh">🔄</button>
                </div>
            </div>

            <div class="issue-tab-meta">
                ${metaParts.join('<span class="meta-sep">·</span>')}
                ${labelsHtml ? `<span class="issue-tab-labels">${labelsHtml}</span>` : ''}
            </div>

            <details class="issue-detail-section" open>
                <summary class="modal-section-header">
                    <span class="section-chevron">▶</span>
                    Description
                </summary>
                <div class="issue-detail-body preview-markdown">${bodyHtml}</div>
            </details>

            ${commentsHtml}

            ${branchInfoHtml}

            <div class="issue-tab-actions">
                <button type="button" class="btn btn-primary issue-tab-start-work" ${startBtnDisabled ? 'disabled' : ''}>
                    ${startBtnLabel}
                </button>
                <button type="button" class="btn btn-sm btn-accept issue-tab-accept" title="Accept — comment and keep open">✅ Accept</button>
                <button type="button" class="btn btn-sm btn-deny issue-tab-deny" title="Deny — close with comment">❌ Deny</button>
                <button type="button" class="btn btn-sm btn-comment issue-tab-comment" title="Add comment">💬 Comment</button>
            </div>
        </div>
    `;
}

// ── Wire up action buttons in the tab ──────────────────────

function _wireIssueTabActions(container, issue) {
    const root = container.querySelector('.issue-tab-content');
    if (!root) return;

    // Start Work
    const startBtn = root.querySelector('.issue-tab-start-work');
    if (startBtn && !startBtn.disabled) {
        startBtn.addEventListener('click', () => startWorkOnIssue(issue));
    }

    // Refresh
    const refreshBtn = root.querySelector('.issue-tab-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            // Find and re-render the tab
            const idx = State.openTabs.findIndex(t => t.type === 'issue' && t.issueNumber === issue.number);
            if (idx >= 0) {
                import('./tab-manager.js').then(({ switchToTab }) => switchToTab(idx));
            }
        });
    }

    // Toggle all comments
    const toggleBtn = root.querySelector('.issue-tab-toggle-comments');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const details = root.querySelectorAll('details.issue-comment-collapsible');
            const allOpen = [...details].every(d => d.open);
            details.forEach(d => d.open = !allOpen);
            toggleBtn.textContent = allOpen ? 'Expand All' : 'Collapse All';
        });
    }

    // Accept
    const acceptBtn = root.querySelector('.issue-tab-accept');
    if (acceptBtn) {
        acceptBtn.addEventListener('click', () => _tabQuickAction(issue, 'accept'));
    }

    // Deny
    const denyBtn = root.querySelector('.issue-tab-deny');
    if (denyBtn) {
        denyBtn.addEventListener('click', () => _tabQuickAction(issue, 'deny'));
    }

    // Comment
    const commentBtn = root.querySelector('.issue-tab-comment');
    if (commentBtn) {
        commentBtn.addEventListener('click', () => _tabQuickAction(issue, 'comment'));
    }
}

/**
 * Quick action from within the issue tab (accept / deny / comment).
 * Reuses the logic from the focus bar actions.
 */
async function _tabQuickAction(issue, action) {
    if (!State.currentProject) return;
    const { owner, repo } = State.currentProject;

    if (action === 'accept') {
        const comment = await showPrompt(`Add a comment (optional):`, {
            title: `✅ Accept #${issue.number}`,
            okLabel: 'Accept',
            placeholder: 'Accepted — will address this.',
        });
        if (comment === null) return;
        try {
            const body = comment || 'Accepted — will address this.';
            await _retryOp(() => Git.createIssueComment(owner, repo, issue.number, `✅ **Accepted**\n\n${body}`));
            EventBus.emit('issues:refresh');
            window.showToast(`Accepted #${issue.number}`, 'success');
            _refreshCurrentIssueTab(issue.number);
        } catch (e) {
            window.showToast(`Failed to accept: ${e.message}`, 'error');
        }
    } else if (action === 'deny') {
        const comment = await showPrompt(`Reason for denying (required):`, {
            title: `❌ Deny #${issue.number}`,
            okLabel: 'Deny',
            required: true,
        });
        if (!comment) return;
        try {
            await _retryOp(() => Git.createIssueComment(owner, repo, issue.number, `❌ **Denied**\n\n${comment}`));
            await _retryOp(() => Git.updateIssueState(owner, repo, issue.number, 'closed'));
            EventBus.emit('issues:refresh');
            window.showToast(`Denied & closed #${issue.number}`, 'success');
            _refreshCurrentIssueTab(issue.number);
        } catch (e) {
            window.showToast(`Failed to deny: ${e.message}`, 'error');
        }
    } else if (action === 'comment') {
        const comment = await showPrompt(`Comment on #${issue.number}:`, {
            title: `💬 Add Comment`,
            okLabel: 'Post Comment',
            required: true,
            placeholder: 'Write your comment…',
        });
        if (!comment) return;
        try {
            await _retryOp(() => Git.createIssueComment(owner, repo, issue.number, comment));
            EventBus.emit('issues:refresh');
            window.showToast(`Comment posted on #${issue.number}`, 'success');
            _refreshCurrentIssueTab(issue.number);
        } catch (e) {
            window.showToast(`Failed to comment: ${e.message}`, 'error');
        }
    }
}

/** Re-render an open issue tab after data changes. */
function _refreshCurrentIssueTab(issueNumber) {
    const idx = State.openTabs.findIndex(t => t.type === 'issue' && t.issueNumber === issueNumber);
    if (idx >= 0 && idx === State.activeTabIndex) {
        import('./tab-manager.js').then(({ switchToTab }) => switchToTab(idx));
    }
}

// ============================================
// ISSUE DETAIL MODAL + BRANCH WORKFLOW (legacy)
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
export function issueBranchName(number, title) {
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
 * Pure helper: given an issue and the current branch context, return the
 * three-state shape used by both the issue-detail modal and the inline
 * "Start" button on issue rows. Single source of truth for the multi-start
 * guard semantics.
 *
 * Caller-supplied `ctx` keeps this testable (no implicit State reads).
 *
 * @param {{ number: number, title: string }} issue
 * @param {Object} ctx
 * @param {Array<{ name: string }>} [ctx.branches]
 * @param {string} [ctx.currentBranch]
 * @param {string} [ctx.defaultBranch]
 * @returns {{ branchName: string, existingBranch: object|undefined, isOnBranch: boolean, defaultBranch: string }}
 */
export function computeIssueBranchState(issue, ctx = {}) {
    const branches = ctx.branches || [];
    const branchName = issueBranchName(issue.number, issue.title || '');
    const existingBranch = branches.find(b => b.name === branchName);
    const isOnBranch = ctx.currentBranch === branchName;
    const defaultBranch = ctx.defaultBranch || 'main';
    return { branchName, existingBranch, isOnBranch, defaultBranch };
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
                const rawColor = (typeof l === 'object' && l.color) ? l.color : null;
                // SECURITY: Sanitize color to hex-only to prevent CSS injection
                const color = rawColor ? rawColor.replace(/[^0-9a-fA-F]/g, '').slice(0, 6) : null;
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
            const safeState = escapeHtml(issue.state);
            metaParts.push(`<span class="badge-state ${stateClass}">${stateIcon} ${safeState.charAt(0).toUpperCase() + safeState.slice(1)}</span>`);
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

            // Copy embedding index from parent branch (files are identical at creation)
            EventBus.emit('branch:created', { sourceBranch: baseBranch, targetBranch: branchName });
        }

        // Switch to the branch
        const previousBranch = State.currentBranch;
        State.currentBranch = branchName;

        // Branch panel re-renders off the `branch:switch` event emitted below
        // (1.12.0 — was a direct `<select>` rewrite). `State.branches` is
        // already current from the listBranches() call above.

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

        // Notify context manager about the branch switch
        EventBus.emit('branch:switch', { branch: branchName, previousBranch });

        // Re-render issues to highlight the active one (avoids circular import)
        EventBus.emit('issues:render');

        closeIssueDetailModal();

        window.showToast(
            existingBranch 
                ? `Switched to branch: ${branchName}` 
                : `Created & switched to: ${branchName}`,
            'success'
        );

        // Plan Mode auto-engage (github#25, 1.10.0) — when the
        // `autoPlanOnIssueStart` setting is on, flip Plan Mode before
        // kicking off the chat run so the LLM sees the read-only tool
        // catalog + plan-mode addendum from round 1. Approval lifts it
        // automatically. Default-off; opt-in from Settings → Roles.
        if (State.settings.autoPlanOnIssueStart) {
            try {
                const { setPlanMode } = await import('./chat/state.js');
                setPlanMode(true);
            } catch (e) {
                console.warn('[issue-detail] Could not auto-engage Plan Mode:', e?.message || e);
            }
        }

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

    const comment = await showPrompt(`Add a comment (optional):`, {
        title: `✅ Accept #${issue.number}`,
        okLabel: 'Accept',
        placeholder: 'Accepted — will address this.',
    });
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

    const comment = await showPrompt(`Reason for denying (required):`, {
        title: `❌ Deny #${issue.number}`,
        okLabel: 'Deny',
        required: true,
    });
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

    const comment = await showPrompt(`Comment on #${issue.number}:`, {
        title: `💬 Add Comment`,
        okLabel: 'Post Comment',
        required: true,
        placeholder: 'Write your comment…',
    });
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
