/**
 * AI Editor - PR Detail Modal
 *
 * Full PR detail view: files, diffs, comments, merge, CI polling,
 * and AI-generated review comments.
 *
 * Extracted from project-manager.js for readability.
 * All public exports are re-exported from project-manager.js so
 * downstream imports remain unchanged.
 *
 * @module pr-detail
 */

import { State, EventBus } from './core.js';
import { Git } from './git.js';
import { renderMarkdown } from './secondary-pane.js';
import { escapeHtml } from './utils/html.js';
import { LLM } from './llm.js';

// ============================================
// CI STATUS ICONS (shared with PR list in project-manager)
// ============================================

export const CI_ICONS = {
    success: '✅',
    pending: '🔄',
    failure: '❌',
    error: '❌',
    unknown: '⚪'
};

// ============================================
// PR DETAIL MODAL
// ============================================

let _currentPR = null;
let _ciPollInterval = null;
const CI_POLL_MS = 10_000;   // 10 seconds
const CI_TERMINAL = new Set(['success', 'failure', 'error']);

export async function openPRDetailModal(prNumber) {
    const modal = document.getElementById('prDetailModal');
    if (!modal || !State.currentProject) return;

    modal.classList.add('active');

    // Loading state
    document.getElementById('prDetailTitle').textContent = `PR #${prNumber}`;
    document.getElementById('prDetailMeta').innerHTML = '<span style="color: var(--text-muted);">Loading…</span>';
    document.getElementById('prDetailBranches').textContent = '';
    document.getElementById('prDetailBody').innerHTML = '';
    document.getElementById('prDetailFiles').innerHTML = '';
    document.getElementById('prDetailComments').innerHTML = '';
    document.getElementById('prDetailFileCount').textContent = '';
    document.getElementById('prDetailCommentCount').textContent = '';
    document.getElementById('prDetailMergeControls').style.display = 'none';
    document.getElementById('prDetailAddComment').style.display = 'none';
    const commentTextEl = document.getElementById('prCommentText');
    if (commentTextEl) commentTextEl.value = '';

    const { owner, repo } = State.currentProject;

    try {
        // Phase 1: Fetch PR details — this is fast and gives us everything for the header
        const pr = await Git.getPullRequest(owner, repo, prNumber);

        _currentPR = { ...pr, files: [], comments: [], ci: { state: 'pending', statuses: [] } };

        // Render header immediately — no waiting for files/comments/CI
        document.getElementById('prDetailTitle').textContent = `#${pr.number}: ${pr.title}`;

        const extLink = document.getElementById('prDetailExternalLink');
        if (pr.url) { extLink.href = pr.url; extLink.style.display = ''; }
        else { extLink.style.display = 'none'; }

        // Meta badges (CI starts as pending spinner)
        _renderPRMeta(pr, { state: 'pending', statuses: [] });

        // Branches
        document.getElementById('prDetailBranches').innerHTML = `<code>${escapeHtml(pr.head)}</code> <span class="branch-arrow">→</span> <code>${escapeHtml(pr.base)}</code>`;

        // Body (markdown)
        const bodyEl = document.getElementById('prDetailBody');
        bodyEl.innerHTML = pr.body ? renderMarkdown(pr.body) : '<em style="color: var(--text-muted);">No description</em>';

        // Merge controls
        const mergeControls = document.getElementById('prDetailMergeControls');
        mergeControls.style.display = (pr.state === 'open' && !pr.merged) ? '' : 'none';

        const addComment = document.getElementById('prDetailAddComment');
        if (addComment) {
            addComment.style.display = (pr.state === 'open' || !pr.merged) ? '' : 'none';
        }

        // Show loading placeholders for files & comments
        document.getElementById('prDetailFiles').innerHTML = '<span style="color: var(--text-muted); font-size: var(--font-sm);">Loading files…</span>';
        document.getElementById('prDetailComments').innerHTML = '<span style="color: var(--text-muted); font-size: var(--font-sm);">Loading comments…</span>';

        // Phase 2: Fire files, comments, CI in parallel — render each as it arrives
        const filesPromise = Git.getPullRequestFiles(owner, repo, prNumber).catch(() => []);
        const commentsPromise = Git.getPullRequestComments(owner, repo, prNumber).catch(() => []);
        const ciPromise = Git.getCommitStatus(owner, repo, pr.head).catch(() => ({ state: 'unknown', statuses: [] }));

        filesPromise.then(files => {
            if (!_currentPR || _currentPR.number !== prNumber) return;
            _currentPR.files = files;
            _renderPRFiles(files);
        });

        commentsPromise.then(comments => {
            if (!_currentPR || _currentPR.number !== prNumber) return;
            _currentPR.comments = comments;
            _renderPRComments(comments);
        });

        ciPromise.then(ci => {
            if (!_currentPR || _currentPR.number !== prNumber) return;
            _currentPR.ci = ci;
            _renderPRMeta(pr, ci);
            // Start CI polling if non-terminal
            _stopCiPolling();
            if (pr.state === 'open' && !pr.merged && !CI_TERMINAL.has(ci.state)) {
                _startCiPolling(owner, repo, pr.head);
            }
        });

        // Wait for all to settle so errors are caught
        await Promise.all([filesPromise, commentsPromise, ciPromise]);

    } catch (error) {
        console.error(`Failed to load PR #${prNumber}:`, error);
        document.getElementById('prDetailMeta').innerHTML = `<span style="color: var(--danger);">Error: ${escapeHtml(error.message)}</span>`;
    }
}

// ── Render helpers ──

function _renderPRMeta(pr, ci) {
    const meta = document.getElementById('prDetailMeta');
    const stateBadge = pr.merged
        ? '<span class="badge-state badge-state-merged">🟣 Merged</span>'
        : pr.state === 'open'
            ? '<span class="badge-state badge-state-open">🟢 Open</span>'
            : '<span class="badge-state badge-state-closed">🔴 Closed</span>';

    const ciIcon = CI_ICONS[ci.state] || '⚪';
    const ciBadge = `<span class="pr-ci-live" title="CI: ${ci.state}">${ciIcon} CI ${ci.state}</span>`;

    const mergeableBadge = pr.merged ? '' : pr.mergeable
        ? '<span style="color: var(--success);">✅ Mergeable</span>'
        : '<span style="color: var(--warning);">⚠️ Conflicts</span>';

    const stats = `<span class="modal-meta-item">+${pr.additions || 0} −${pr.deletions || 0} · ${pr.changed_files || 0} files</span>`;
    const author = `<span class="modal-meta-item">by ${escapeHtml(pr.user || 'unknown')}</span>`;

    meta.innerHTML = [stateBadge, ciBadge, mergeableBadge, stats, author].filter(Boolean).join('<span class="meta-sep">·</span>');
}

function _renderPRFiles(files) {
    const container = document.getElementById('prDetailFiles');
    const countEl = document.getElementById('prDetailFileCount');

    countEl.textContent = `(${files.length})`;

    if (files.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: var(--font-sm);">No changed files</div>';
        return;
    }

    container.innerHTML = files.map((f, i) => {
        const statusIcons = { added: '🟢', removed: '🔴', modified: '🟡', renamed: '🔵', copied: '🔵' };
        const icon = statusIcons[f.status] || '⚪';
        const stats = `<span style="color: var(--success);">+${f.additions}</span> <span style="color: var(--danger);">−${f.deletions}</span>`;
        const renamed = f.previousFilename ? ` <span style="color: var(--text-muted);">← ${escapeHtml(f.previousFilename)}</span>` : '';

        const hasPatch = f.patch && f.patch.length > 0;
        const patchHtml = hasPatch ? `
            <div class="pr-file-diff" id="prDiff-${i}" style="display: none; margin-top: 0.5rem;">
                <pre>${_formatDiffPatch(f.patch)}</pre>
            </div>` : '';

        return `
            <div class="pr-file-item" style="margin-bottom: 0.25rem;">
                <div style="display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.5rem; border-radius: 4px; cursor: ${hasPatch ? 'pointer' : 'default'}; font-size: var(--font-sm);"
                     ${hasPatch ? `onclick="(function(){ var d=document.getElementById('prDiff-${i}'); d.style.display=d.style.display==='none'?'':'none'; })()"` : ''}>
                    <span>${icon}</span>
                    <span style="flex: 1; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(f.filename)}${renamed}</span>
                    <span style="flex-shrink: 0;">${stats}</span>
                    ${hasPatch ? '<span style="color: var(--text-muted);">▸</span>' : ''}
                </div>
                ${patchHtml}
            </div>
        `;
    }).join('');
}

function _formatDiffPatch(patch) {
    // Syntax-highlight diff lines
    return escapeHtml(patch).split('\n').map(line => {
        if (line.startsWith('+')) return `<span style="color: var(--success);">${line}</span>`;
        if (line.startsWith('-')) return `<span style="color: var(--danger);">${line}</span>`;
        if (line.startsWith('@@')) return `<span style="color: var(--accent);">${line}</span>`;
        return line;
    }).join('\n');
}

function _renderPRComments(comments) {
    const container = document.getElementById('prDetailComments');
    const countEl = document.getElementById('prDetailCommentCount');

    countEl.textContent = `(${comments.length})`;

    if (comments.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: var(--font-sm);">No comments</div>';
        return;
    }

    const commentItems = comments.map((c, i) => {
        const pathInfo = c.path ? `<span style="font-family: var(--font-mono); font-size: var(--font-xs);">${escapeHtml(c.path)}${c.line ? `:${c.line}` : ''}</span>` : '';
        const user = escapeHtml(c.user || 'unknown');
        const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '';
        const bodyHtml = renderMarkdown(c.body || '');
        const open = i === 0 ? ' open' : '';
        const preview = (c.body || '').length > 100 ? escapeHtml((c.body || '').substring(0, 80).replace(/\n/g, ' ')) + '…' : '';

        return `
            <details${open} class="modal-comment-item pr-comment-collapsible">
                <summary>
                    <span class="comment-chevron">▶</span>
                    <strong>${user}</strong> · ${date} ${pathInfo}
                    <span class="comment-preview">${preview}</span>
                </summary>
                <div class="comment-body preview-markdown">${bodyHtml}</div>
            </details>
        `;
    }).join('');

    container.innerHTML = `
        ${comments.length > 1 ? `
            <div style="text-align: right; margin-bottom: 0.3rem;">
                <button type="button" class="btn btn-secondary btn-xs pr-toggle-comments">
                    Expand All
                </button>
            </div>
        ` : ''}
        ${commentItems}
    `;

    // Wire expand/collapse all
    const toggleBtn = container.querySelector('.pr-toggle-comments');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const details = container.querySelectorAll('details.pr-comment-collapsible');
            const allOpen = [...details].every(d => d.open);
            details.forEach(d => d.open = !allOpen);
            toggleBtn.textContent = allOpen ? 'Expand All' : 'Collapse All';
        });
    }
}

// ── Close ──

export function closePRDetailModal() {
    _stopCiPolling();
    const modal = document.getElementById('prDetailModal');
    if (modal) modal.classList.remove('active');
    _currentPR = null;
}

// ── CI Polling ──

/**
 * Start polling CI status for the given ref.
 * Updates the CI badge in the PR detail modal in-place.
 */
function _startCiPolling(owner, repo, ref) {
    _ciPollInterval = setInterval(async () => {
        if (!_currentPR) { _stopCiPolling(); return; }

        try {
            const ci = await Git.getCommitStatus(owner, repo, ref);
            if (!ci) return;

            // Update stored state
            _currentPR.ci = ci;

            // Update badge in modal
            const meta = document.getElementById('prDetailMeta');
            if (meta) {
                const oldBadge = meta.querySelector('.pr-ci-live');
                const icon = CI_ICONS[ci.state] || '⚪';
                const newBadge = document.createElement('span');
                newBadge.className = 'pr-ci-live';
                newBadge.title = `CI: ${ci.state}`;
                newBadge.textContent = `${icon} CI ${ci.state}`;
                if (oldBadge) {
                    oldBadge.replaceWith(newBadge);
                }
            }

            // Also update the PR list badge if visible
            _updatePRListCIBadge(_currentPR.number, ci.state);

            // Stop if terminal
            if (CI_TERMINAL.has(ci.state)) {
                _stopCiPolling();
            }
        } catch (e) {
            console.warn('[CI Poll] Error:', e.message);
        }
    }, CI_POLL_MS);
}

function _stopCiPolling() {
    if (_ciPollInterval) {
        clearInterval(_ciPollInterval);
        _ciPollInterval = null;
    }
}

/**
 * Update a PR's CI badge in the sidebar list (if visible).
 */
function _updatePRListCIBadge(prNumber, ciState) {
    // Find the PR item in State and update it for next render
    const pr = State.pullRequests.find(p => p.number === prNumber);
    if (pr) pr.ciState = ciState;

    // Live-update the badge icon in the DOM
    const panel = document.getElementById('prsPanel');
    if (!panel) return;
    const items = panel.querySelectorAll('.issue-item');
    for (const item of items) {
        if (item.textContent.includes(`#${prNumber}`)) {
            const badge = item.querySelector('.pr-ci-badge');
            if (badge) {
                badge.textContent = CI_ICONS[ciState] || '⚪';
                badge.title = `CI: ${ciState}`;
            }
            break;
        }
    }
}

// ── Merge ──

export async function submitMergePR() {
    if (!_currentPR || !State.currentProject) return;

    const btn = document.getElementById('btnMergePR');
    const strategy = document.getElementById('prMergeStrategy').value;
    const deleteBranch = document.getElementById('prDeleteBranch').checked;

    // Inline confirmation: first click → confirm state, second click → merge
    if (btn.dataset.confirming !== 'true') {
        btn.dataset.confirming = 'true';
        btn.textContent = `⚠️ Confirm ${strategy}?`;
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-primary');
        // Reset after 3 seconds if not confirmed
        setTimeout(() => {
            if (btn.dataset.confirming === 'true') {
                btn.dataset.confirming = '';
                btn.textContent = '✅ Merge';
                btn.classList.remove('btn-danger');
                btn.classList.add('btn-primary');
            }
        }, 3000);
        return;
    }

    // Second click — do the merge
    btn.dataset.confirming = '';
    btn.disabled = true;
    btn.textContent = '⏳ Merging…';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');

    try {
        const { owner, repo } = State.currentProject;
        await Git.mergePullRequest(owner, repo, _currentPR.number, {
            mergeType: strategy,
            deleteBranch,
            headSha: _currentPR.headSha || ''
        });

        btn.textContent = '✅ Merged!';

        // Notify context manager about the merge so it can reindex changed files
        const changedFiles = (_currentPR.files || []).map(f => f.filename);
        EventBus.emit('context:prMerged', {
            baseBranch: _currentPR.base,
            headBranch: _currentPR.head,
            changedFiles,
            deletedBranch: deleteBranch ? _currentPR.head : null
        });

        // Ask project-manager to refresh (avoids circular import)
        EventBus.emit('project:refreshAfterMerge');

        // Refresh the modal to show merged state
        setTimeout(() => openPRDetailModal(_currentPR.number), 500);

    } catch (e) {
        console.error('[PR] Merge failed:', e);
        window.showToast(`Merge failed: ${e.message}`, 'error');
        btn.disabled = false;
        btn.textContent = '✅ Merge';
    }
}

// ── PR Comment: Generate + Post ──

export async function generatePRComment() {
    if (!_currentPR) return;

    const textarea = document.getElementById('prCommentText');
    const btn = document.getElementById('btnGeneratePRComment');
    if (!textarea || !btn) return;

    btn.disabled = true;
    btn.textContent = '⏳ Generating…';
    textarea.value = 'Analyzing PR…';
    textarea.disabled = true;

    try {
        // Build context from PR data
        const diffSummary = (_currentPR.files || []).map(f => {
            const stats = `+${f.additions} −${f.deletions}`;
            const patchSnippet = f.patch ? f.patch.slice(0, 800) : '';
            return `File: ${f.filename} (${f.status}, ${stats})\n${patchSnippet}`;
        }).join('\n---\n');

        const existingComments = (_currentPR.comments || [])
            .map(c => `${c.user}: ${c.body}`)
            .join('\n');

        const prompt = `You are reviewing PR #${_currentPR.number}: "${_currentPR.title}"
Branch: ${_currentPR.head} → ${_currentPR.base}
Author: ${_currentPR.user || 'unknown'}

Description:
${(_currentPR.body || 'No description').slice(0, 1000)}

Changed files (${_currentPR.files?.length || 0}):
${diffSummary.slice(0, 4000)}
${existingComments ? `\nExisting comments:\n${existingComments.slice(0, 1000)}` : ''}

Write a concise, constructive code review comment. Focus on:
- Code quality, potential bugs, or edge cases
- Suggestions for improvement (if any)
- Positive observations about good patterns
Keep it under 200 words. Do NOT use markdown headers. Respond with ONLY the review comment text.`;

        const commitModel = State.settings.commitModel || State.settings.llmModel;
        const result = await LLM.chat([
            { role: 'user', content: prompt }
        ], {
            stream: false,
            temperature: 0.4,
            maxTokens: 400,
            model: commitModel
        });

        textarea.value = result.content.trim();
    } catch (error) {
        console.error('[PR] Comment generation failed:', error);
        textarea.value = '';
        window.showToast('Failed to generate comment: ' + error.message, 'error');
    }

    textarea.disabled = false;
    btn.disabled = false;
    btn.textContent = '✨ Generate with AI';
}

export async function submitPRComment() {
    if (!_currentPR || !State.currentProject) return;

    const textarea = document.getElementById('prCommentText');
    const btn = document.getElementById('btnPostPRComment');
    const body = textarea?.value.trim();

    if (!body) {
        window.showToast('Comment is empty', 'warning');
        return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Posting…';

    try {
        const { owner, repo } = State.currentProject;
        await Git.addPullRequestComment(owner, repo, _currentPR.number, body);

        textarea.value = '';
        btn.textContent = '✅ Posted!';
        window.showToast('Comment posted', 'success');

        // Refresh comments in the modal
        const comments = await Git.getPullRequestComments(owner, repo, _currentPR.number).catch(() => []);
        _currentPR.comments = comments;
        _renderPRComments(comments);

        setTimeout(() => {
            btn.textContent = '📝 Post';
            btn.disabled = false;
        }, 1000);

    } catch (e) {
        console.error('[PR] Comment post failed:', e);
        window.showToast(`Failed to post comment: ${e.message}`, 'error');
        btn.disabled = false;
        btn.textContent = '📝 Post';
    }
}
