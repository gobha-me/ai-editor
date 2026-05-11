/**
 * Branch Panel — row-list switcher for the left sidebar (1.12.0, Touch 3 extraction A).
 *
 * Replaces the legacy `<select id="branchSelect">` dropdown with a list of
 * branch rows. Each row shows the branch name, a `↑N ↓M` ahead/behind chip
 * (when known), and inline action buttons:
 *   - Switch — on non-current branches
 *   - Cut release — on the current branch (opens the existing Release modal)
 *   - Delete — on non-current, non-protected branches (with confirm)
 *
 * Counts come from `State.branchMetadata[branch] = { ahead, behind }`,
 * populated lazily by `populateBranchMetadata()` after `branches:refresh`
 * and `git:projectLoaded`. `null` counts are hidden — they mean "unknown",
 * not "in sync".
 *
 * Keep the renderer (`renderBranchPanelHtml`) pure: HTML in, HTML out, no
 * DOM. Wire-up + event delegation live in `mountBranchPanel()`.
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

const PANEL_ID = 'branchPanel';
const ACTION_ATTR = 'data-branch-action';
const NAME_ATTR = 'data-branch-name';

const SVG_SWITCH = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 3 4 4-4 4"/><path d="M3 7h18"/><path d="m7 21-4-4 4-4"/><path d="M21 17H3"/></svg>';
const SVG_RELEASE = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>';
const SVG_DELETE = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
const SVG_EXPORT = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m6 9 6 6 6-6"/><path d="M3 21h18"/></svg>';

/**
 * Render the branch panel as an HTML string.
 *
 * Pure function — exported for tests. Does not touch the DOM.
 *
 * @param {Object} opts
 * @param {Array<{name: string, protected?: boolean}>} opts.branches
 * @param {string} opts.currentBranch
 * @param {Object<string, {ahead: number|null, behind: number|null}>} [opts.metadata]
 * @returns {string}
 */
export function renderBranchPanelHtml({ branches, currentBranch, metadata = {}, showExport = false }) {
    if (!branches || branches.length === 0) {
        return '<div class="branch-panel__empty">No branches yet</div>';
    }

    return branches.map((b) => {
        const isCurrent = b.name === currentBranch;
        const isProtected = !!b.protected;
        const meta = metadata[b.name] || {};
        const counts = renderCounts(meta.ahead, meta.behind, isCurrent);

        const rowClasses = [
            'branch-panel__row',
            isCurrent ? 'branch-panel__row--current' : '',
        ].filter(Boolean).join(' ');

        const tags = [];
        if (isProtected) {
            tags.push('<span class="branch-panel__tag branch-panel__tag--protected" title="Protected branch">protected</span>');
        }

        const actions = [];
        if (showExport) {
            actions.push(
                `<button type="button" class="branch-panel__btn branch-panel__btn--export" ` +
                `${ACTION_ATTR}="exportZip" ${NAME_ATTR}="${escapeAttr(b.name)}" ` +
                `title="Export ${escapeAttr(b.name)} as .zip" ` +
                `aria-label="Export branch ${escapeAttr(b.name)} as .zip">${SVG_EXPORT}</button>`
            );
        }
        if (isCurrent) {
            actions.push(
                `<button type="button" class="branch-panel__btn branch-panel__btn--release" ` +
                `${ACTION_ATTR}="cutRelease" title="Cut release from this branch" ` +
                `aria-label="Cut release from ${escapeAttr(b.name)}">${SVG_RELEASE}<span>Release</span></button>`
            );
        } else {
            actions.push(
                `<button type="button" class="branch-panel__btn branch-panel__btn--switch" ` +
                `${ACTION_ATTR}="switch" ${NAME_ATTR}="${escapeAttr(b.name)}" ` +
                `title="Switch to ${escapeAttr(b.name)}" ` +
                `aria-label="Switch to ${escapeAttr(b.name)}">${SVG_SWITCH}<span>Switch</span></button>`
            );
            if (!isProtected) {
                actions.push(
                    `<button type="button" class="branch-panel__btn branch-panel__btn--delete" ` +
                    `${ACTION_ATTR}="delete" ${NAME_ATTR}="${escapeAttr(b.name)}" ` +
                    `title="Delete ${escapeAttr(b.name)}" ` +
                    `aria-label="Delete branch ${escapeAttr(b.name)}">${SVG_DELETE}</button>`
                );
            }
        }

        return `<div class="${rowClasses}" role="listitem" data-branch-name="${escapeAttr(b.name)}">` +
            `<div class="branch-panel__row-main">` +
                `<span class="branch-panel__name" title="${escapeAttr(b.name)}">${escapeHtml(b.name)}</span>` +
                tags.join('') +
                counts +
            `</div>` +
            `<div class="branch-panel__actions">${actions.join('')}</div>` +
        `</div>`;
    }).join('');
}

/**
 * Render the `↑N ↓M` chip when the counts are known.
 * Hidden (empty string) when both counts are null OR when this is the
 * current branch and both are zero (the chip would be visual noise).
 */
function renderCounts(ahead, behind, isCurrent) {
    const aheadKnown = typeof ahead === 'number';
    const behindKnown = typeof behind === 'number';
    if (!aheadKnown && !behindKnown) return '';
    if (isCurrent && ahead === 0 && behind === 0) return '';

    const parts = [];
    if (aheadKnown) parts.push(`<span class="branch-panel__count branch-panel__count--ahead" title="${ahead} commit${ahead === 1 ? '' : 's'} ahead of default">↑${ahead}</span>`);
    if (behindKnown) parts.push(`<span class="branch-panel__count branch-panel__count--behind" title="${behind} commit${behind === 1 ? '' : 's'} behind default">↓${behind}</span>`);
    return `<span class="branch-panel__counts">${parts.join('')}</span>`;
}

/**
 * Fetch ahead/behind counts for every branch against the project's default
 * branch and stash them in `State.branchMetadata`. Concurrency-capped so we
 * don't fan out 50 parallel HTTP calls on a large repo. Re-renders the
 * panel after each completion so users see counts pop in over time.
 *
 * Idempotent — calling twice during a refresh just produces duplicate work,
 * not corrupted state. The simple guard below skips a second invocation if
 * the previous one is still active for the same project signature.
 *
 * @param {{owner: string, repo: string, defaultBranch?: string}} project
 * @param {Array<{name: string}>} branches
 */
let _activeSignature = null;
export async function populateBranchMetadata(project, branches) {
    if (!project || !branches || branches.length === 0) return;
    const { owner, repo } = project;
    const defaultBranch = project.defaultBranch || 'main';

    const signature = `${owner}/${repo}@${defaultBranch}#${branches.length}`;
    if (_activeSignature === signature) return;
    _activeSignature = signature;

    const targets = branches.filter(b => b.name !== defaultBranch);
    // Default branch is always 0/0 against itself.
    State.branchMetadata = {
        ...(State.branchMetadata || {}),
        [defaultBranch]: { ahead: 0, behind: 0 },
    };

    const queue = targets.slice();
    const CONCURRENCY = 4;
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            try {
                const counts = await Git.getBranchAheadBehind(owner, repo, next.name, defaultBranch);
                State.branchMetadata = {
                    ...(State.branchMetadata || {}),
                    [next.name]: counts,
                };
            } catch {
                State.branchMetadata = {
                    ...(State.branchMetadata || {}),
                    [next.name]: { ahead: null, behind: null },
                };
            }
            EventBus.emit('branches:metadataChanged', { branch: next.name });
        }
    });

    try {
        await Promise.all(workers);
    } finally {
        if (_activeSignature === signature) _activeSignature = null;
    }
}

/**
 * Render the branch panel into its container in the DOM. No-op if the panel
 * element is absent (other surfaces, tests under Node, etc.).
 */
export function renderBranchPanel(container) {
    const el = container || document.getElementById(PANEL_ID);
    if (!el) return;

    if (!State.currentProject || !State.branches || State.branches.length === 0) {
        el.innerHTML = '<div class="branch-panel__empty">No project loaded</div>';
        return;
    }

    const isLocal = State.currentProject?.connectionId === '__local__';
    el.innerHTML = renderBranchPanelHtml({
        branches: State.branches,
        currentBranch: State.currentBranch,
        metadata: State.branchMetadata || {},
        showExport: !isLocal,
    });
}

/**
 * Bind delegated click handlers + EventBus subscriptions. Idempotent.
 *
 * Click delegation lives on `document` so the wiring is decoupled from
 * whether `#branchPanel` exists at mount time — the rail's `render(body)`
 * creates `#branchPanel` lazily on rail rebuilds (2.24.0 SlotManager body
 * migration), and the `.branch-panel` scope keeps the document-level
 * listener from catching unrelated `[data-branch-action]` attrs elsewhere.
 */
let _wired = false;
export function mountBranchPanel({ onSwitch, onDelete, onCutRelease, onExportZip } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', async (e) => {
        const btn = e.target.closest(`[${ACTION_ATTR}]`);
        if (!btn) return;
        if (!btn.closest('.branch-panel')) return;
        const action = btn.getAttribute(ACTION_ATTR);
        const name = btn.getAttribute(NAME_ATTR) || State.currentBranch;
        if (action === 'switch' && typeof onSwitch === 'function') {
            await onSwitch(name);
        } else if (action === 'delete' && typeof onDelete === 'function') {
            await onDelete(name);
        } else if (action === 'cutRelease' && typeof onCutRelease === 'function') {
            await onCutRelease(name);
        } else if (action === 'exportZip' && typeof onExportZip === 'function') {
            await onExportZip(name);
        }
    });

    // Re-render when underlying data changes.
    EventBus.on('project:loaded', renderBranchPanel);
    EventBus.on('project:cleared', renderBranchPanel);
    EventBus.on('branches:refresh', renderBranchPanel);
    EventBus.on('branches:metadataChanged', renderBranchPanel);
    EventBus.on('branch:switch', renderBranchPanel);
    EventBus.on('branch:created', renderBranchPanel);
}
