/**
 * Issue list — pure renderer for the left-sidebar Issues panel
 * (1.13.0, Touch 3 extraction B).
 *
 * Surfaces an inline `▶ Start` / `🔀 Switch & Start` / `✅ Active` button per
 * issue row so the auto-branch-on-session-start flow no longer requires
 * opening the issue tab first. The button shape is computed by the shared
 * `computeIssueBranchState` helper in `issue-detail.js` so the modal and
 * the row stay in lockstep.
 *
 * Pure: HTML in, HTML out, no DOM. Wire-up + event handling stays in
 * `project-manager.renderIssues()` (DOM mount) + `app.js` (window globals).
 *
 * @module ui/issue-list
 */

import { escapeHtml, escapeAttr } from '../utils/html.js';
import { computeIssueBranchState } from '../issue-detail.js';

/**
 * Render the issue rows for the sidebar Issues panel.
 *
 * @param {Object} ctx
 * @param {Array<{number: number, title: string, labels?: string[], dependencies?: number[]}>} ctx.issues
 * @param {Array<{name: string}>} [ctx.branches]
 * @param {string} [ctx.currentBranch]
 * @param {string} [ctx.defaultBranch]
 * @param {{number?: number}} [ctx.currentIssue]
 * @param {{number?: number}} [ctx.focusedIssue]
 * @returns {string}
 */
export function renderIssueRowsHtml(ctx) {
    const { issues, branches, currentBranch, defaultBranch, currentIssue, focusedIssue } = ctx;
    if (!issues || issues.length === 0) return '';

    return issues.map(issue => {
        const isActive = currentIssue?.number === issue.number;
        const isFocused = focusedIssue?.number === issue.number;
        const activeClass = isActive ? ' issue-item-active' : isFocused ? ' issue-item-focused' : '';

        // Dependencies row (mirrors legacy renderIssues — preserved for parity).
        let depsHtml = '';
        if (issue.dependencies && issue.dependencies.length > 0) {
            const depLinks = issue.dependencies.map(depNum =>
                `<span class="dep-link" onclick="event.stopPropagation(); window.Chat.sendMessage('Show me issue #${depNum}')">#${depNum}</span>`
            ).join(', ');
            depsHtml = `<div class="issue-deps"><svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/></svg> Depends on: ${depLinks}</div>`;
        }

        // Labels row.
        const labelsHtml = (issue.labels && issue.labels.length)
            ? `<div class="issue-labels">${issue.labels.map(l => `<span class="issue-label">${escapeHtml(l)}</span>`).join('')}</div>`
            : '';

        // Inline Start button — three-state shape from the shared helper.
        const { isOnBranch, existingBranch } = computeIssueBranchState(issue, {
            branches,
            currentBranch,
            defaultBranch,
        });

        let startLabel;
        let startTitle;
        let startDisabledAttr = '';
        let startClassExtra = '';
        if (isOnBranch) {
            startLabel = '✅ Active';
            startTitle = 'Currently working on this issue';
            startDisabledAttr = 'disabled';
            startClassExtra = ' issue-item-start--active';
        } else if (existingBranch) {
            startLabel = '🔀 Switch & Start';
            startTitle = 'Switch to existing branch and start work';
        } else {
            startLabel = '▶ Start';
            startTitle = 'Create branch and start work';
        }

        // stopPropagation guards against the row-level openIssueTab onclick.
        const startBtn = `<button type="button" class="issue-item-start${startClassExtra}" ${startDisabledAttr}
                title="${escapeAttr(startTitle)}"
                onclick="event.stopPropagation(); window.startWorkOnIssueFromList(${issue.number})"
                aria-label="${escapeAttr(`${startTitle}: #${issue.number}`)}">${startLabel}</button>`;

        return `
            <div class="issue-item${activeClass}" role="listitem" tabindex="0"
                 onclick="window.openIssueTab(${issue.number})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.openIssueTab(${issue.number})}"
                 aria-label="Issue #${issue.number}: ${escapeAttr(issue.title)}">
                <div class="issue-number">#${issue.number}</div>
                <div class="issue-title">${escapeHtml(issue.title)}</div>
                ${labelsHtml}
                ${depsHtml}
                <div class="issue-item-actions">${startBtn}</div>
            </div>
        `;
    }).join('');
}
