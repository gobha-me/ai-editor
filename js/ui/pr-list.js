/**
 * PR list — pure renderer for the left-sidebar Pull Requests panel
 * (2.23.0 extraction, mirrors the 1.13.0 issue-list pattern).
 *
 * Branch-contextual filtering lives here as a data-driven step before the
 * row map: on the default branch we show all open PRs; on a feature branch
 * we narrow to PRs whose `head` matches the current branch. The empty-state
 * copy mirrors what `renderPullRequests()` produced inline before the split.
 *
 * Pure: data in, HTML out, no DOM. Wire-up + event handling stays in
 * `project-manager.renderPullRequests()` (DOM mount) + `app.js` (window globals).
 *
 * @module ui/pr-list
 */

import { escapeHtml, escapeAttr } from '../utils/html.js';
import { getCiStatusMeta } from './icons.js';

/**
 * Filter the PR list by the active-branch context.
 *
 * @param {Array} pullRequests
 * @param {string} currentBranch
 * @param {string} defaultBranch
 * @returns {{ filtered: Array, onDefault: boolean }}
 */
export function filterPullRequests(pullRequests, currentBranch, defaultBranch) {
    const onDefault = currentBranch === defaultBranch;
    const filtered = onDefault
        ? pullRequests
        : pullRequests.filter(pr => pr.head === currentBranch);
    return { filtered, onDefault };
}

/**
 * Build the empty-state HTML for the PR panel.
 *
 * @param {boolean} onDefault
 * @param {string} currentBranch
 * @returns {string}
 */
export function renderPrEmptyHtml(onDefault, currentBranch) {
    const context = onDefault
        ? 'No open pull requests'
        : `No PRs for branch "${escapeHtml(currentBranch || '')}"`;
    return `<div style="padding: 0.75rem; color: var(--text-muted); font-size: var(--font-md);">${context}</div>`;
}

/**
 * Render the PR rows for the sidebar Pull Requests panel.
 *
 * Returns the empty-state HTML when the filtered list is empty, so a single
 * caller can mount the result without re-deciding the empty-state shape.
 *
 * @param {Object} ctx
 * @param {Array<{number: number, title: string, head: string, base: string, ciState?: string}>} ctx.pullRequests
 * @param {string} [ctx.currentBranch]
 * @param {string} [ctx.defaultBranch]
 * @returns {string}
 */
export function renderPrRowsHtml(ctx) {
    const { pullRequests, currentBranch, defaultBranch } = ctx;
    const defBranch = defaultBranch || 'main';
    const { filtered, onDefault } = filterPullRequests(
        pullRequests || [],
        currentBranch,
        defBranch,
    );

    if (filtered.length === 0) {
        return renderPrEmptyHtml(onDefault, currentBranch);
    }

    return filtered.map(pr => {
        const ciIcon = getCiStatusMeta(pr.ciState).emoji;
        const ciTitle = pr.ciState === 'unknown' || !pr.ciState
            ? 'No CI status'
            : `CI: ${pr.ciState}`;
        const branchInfo = onDefault
            ? `<span style="color: var(--text-muted);">${escapeHtml(pr.head)} → ${escapeHtml(pr.base)}</span>`
            : '';

        return `
            <div class="issue-item" role="listitem" tabindex="0"
                 data-action="openPrReview" data-number="${pr.number}"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.openPrReview(${pr.number})}"
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

/**
 * Bind a delegated click handler for PR rows. Phase 3a of the
 * inline-handlers migration (DESIGN-html-inline-handlers-migration.md).
 * Scoped to `#prsPanel` — `renderPullRequests()` rewrites the panel's
 * innerHTML on every refresh, so the document-level listener survives
 * container re-creation.
 *
 * The `onkeydown` Enter/Space activation on the row remains an inline
 * handler — Phase 3 covers `onclick` only.
 */
let _wired = false;
export function mountPrList({ onOpenPrReview } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#prsPanel')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'openPrReview' && typeof onOpenPrReview === 'function') {
            onOpenPrReview(Number(btn.getAttribute('data-number')));
        }
    });
}
