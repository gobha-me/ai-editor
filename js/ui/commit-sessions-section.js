// @ts-check
/**
 * Commit-modal "Session updates" section — parallel to the Memory
 * updates section from PR #197 (`commit-memory-section.js`). Renders
 * pending `.aieditor/sessions/<id>.json` paths produced by the
 * sessions-sync layer (`js/chat/sessions-sync.js`), with the same
 * Flow 3A / Flow 3B split:
 *
 *   - **Flow 3A** (current branch unprotected): a `commit-section--sess`
 *     panel auto-stages every pending session path. Each row has a
 *     "Show diff" toggle that reveals the pending JSON content
 *     prefixed with `+ ` lines.
 *   - **Flow 3B** (current branch protected): a `commit-section--warn`
 *     panel surfaces the same pending paths as a disabled warning,
 *     with three escape-hatch buttons ("Branch off & commit sessions"
 *     / "Keep pending" / "Discard").
 *
 * Sessions and memory share the same Decision §4 protected-branch
 * gate — both sections render their warning band in parallel when
 * pending writes for both layers exist.
 *
 * Why duplicate the memory section's shape rather than abstract it?
 * Per project memory: three similar lines is better than a premature
 * abstraction. Sessions and memory have distinct user-facing semantics
 * (raw transcripts vs. curated facts), distinct toggle granularities
 * (per-conversation vs. workspace), and may diverge further as 1.3.x
 * progresses; keeping the two sections as siblings preserves room
 * for that. The shape mirror is intentional.
 *
 * @module ui/commit-sessions-section
 */

import { EventBus } from '../core.js';
import { escapeAttr } from '../utils/html.js';
import {
    getPendingContent,
    discardPendingSessionWrites,
} from '../chat/sessions-sync.js';

/**
 * @typedef {Object} SessionUpdatesSectionProps
 * @property {boolean} isProtected
 * @property {string[]} pendingPaths
 * @property {string} [branch]
 */

/**
 * Render the section. Returns `''` when there are no pending paths.
 *
 * @param {SessionUpdatesSectionProps} props
 * @returns {string}
 */
export function renderSessionUpdatesSection({ isProtected, pendingPaths, branch }) {
    if (!Array.isArray(pendingPaths) || pendingPaths.length === 0) return '';

    const rows = pendingPaths.map((p, i) => _renderRow(p, i, { isProtected })).join('');
    const count = pendingPaths.length;
    const fileLabel = count === 1 ? '1 file' : `${count} files`;
    const branchLabel = escapeAttr(branch || '');

    if (isProtected) {
        return `
            <div class="commit-section commit-section--warn" data-sess-section="warn">
                <div class="commit-section__head">
                    <span class="commit-section__title commit-section__title--warn">⚠ Session writes can't be staged here</span>
                    <span class="commit-section__count">on protected branch</span>
                </div>
                <p class="commit-section__hint">
                    You have <strong>${count === 1 ? '1 pending session update' : `${count} pending session updates`}</strong>.
                    They won't be committed to <code class="branch-row__name">${branchLabel}</code> —
                    these usually land on feature branches alongside the work they describe.
                </p>
                ${rows}
                <div class="commit-section__actions">
                    <button type="button" class="mem-btn" data-sess-action="branchOff">Branch off &amp; commit sessions</button>
                    <button type="button" class="mem-btn mem-btn--ghost" data-sess-action="keepPending">Keep pending</button>
                    <button type="button" class="mem-btn mem-btn--ghost" data-sess-action="discard">Discard</button>
                </div>
            </div>
        `;
    }

    return `
        <div class="commit-section commit-section--sess" data-sess-section="sess">
            <div class="commit-section__head">
                <span class="commit-section__title commit-section__title--mem">📡 Session updates</span>
                <span class="commit-section__count">auto-staged · ${fileLabel}</span>
            </div>
            ${rows}
        </div>
    `;
}

function _renderRow(path, index, { isProtected }) {
    const safePath = escapeAttr(path);
    const checkboxAttrs = isProtected
        ? `disabled aria-disabled="true"`
        : `checked data-sess-path="${safePath}"`;
    const rowClass = isProtected
        ? 'commit-file commit-file--mem is-disabled'
        : 'commit-file commit-file--mem';
    const diffLink = `<a class="src-link commit-file__diff-toggle" data-sess-diff-toggle="${index}" data-sess-path-for-diff="${safePath}" role="button" tabindex="0">Show diff</a>`;

    return `
        <label class="${rowClass}">
            <input type="checkbox" ${checkboxAttrs}>
            <code class="path">${safePath}</code>
            ${diffLink}
        </label>
        <pre class="commit-mem-diff" data-sess-diff-target="${index}" hidden></pre>
    `;
}

/**
 * Format a pending file's content as `+ ` prefixed lines for the
 * Show diff preview. Pending session files are always treated as adds
 * for the preview — true file-vs-HEAD diffing is a follow-up.
 *
 * @param {string} content
 * @returns {string}
 */
export function formatPendingDiff(content) {
    if (!content) return '';
    return content
        .split('\n')
        .map((line) => `+ ${line}`)
        .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Click handlers — wired once per render via event delegation.               */
/* -------------------------------------------------------------------------- */

/**
 * Bind click handlers to the rendered section. Idempotent: every call
 * replaces the previous listener so re-rendering between modal opens
 * doesn't accumulate handlers.
 *
 * @param {HTMLElement} rootEl
 * @param {{ closeModal?: () => void }} [callbacks]
 * @returns {void}
 */
export function wireSessionUpdatesSection(rootEl, callbacks = {}) {
    if (!rootEl) return;

    if (rootEl._sessSectionHandler) {
        rootEl.removeEventListener('click', rootEl._sessSectionHandler);
        rootEl._sessSectionHandler = null;
    }

    const handler = (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;

        const action = target.dataset.sessAction;
        if (action) {
            ev.preventDefault();
            _handleAction(action, rootEl, callbacks);
            return;
        }

        const diffToggle = target.closest('[data-sess-diff-toggle]');
        if (diffToggle instanceof HTMLElement) {
            ev.preventDefault();
            _toggleDiff(diffToggle, rootEl);
        }
    };

    rootEl.addEventListener('click', handler);
    rootEl._sessSectionHandler = handler;
}

function _toggleDiff(toggleEl, rootEl) {
    const idx = toggleEl.dataset.sessDiffToggle;
    const path = toggleEl.dataset.sessPathForDiff;
    const pre = rootEl.querySelector(`[data-sess-diff-target="${idx}"]`);
    if (!(pre instanceof HTMLElement)) return;

    const open = !pre.hidden;
    if (open) {
        pre.hidden = true;
        toggleEl.textContent = 'Show diff';
        return;
    }

    if (!pre.textContent) {
        const content = path ? getPendingContent(path) : null;
        pre.textContent = content ? formatPendingDiff(content) : '(no content)';
    }
    pre.hidden = false;
    toggleEl.textContent = 'Hide diff';
}

function _handleAction(action, rootEl, callbacks) {
    switch (action) {
        case 'branchOff': {
            const paths = _collectVisiblePaths(rootEl);
            EventBus.emit('sessions:branchOffRequested', { paths });
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                window.showToast(
                    'Branch-off flow lands in a follow-up — keeping sessions pending for now.',
                    'info',
                );
            }
            return;
        }
        case 'keepPending': {
            if (typeof callbacks.closeModal === 'function') callbacks.closeModal();
            return;
        }
        case 'discard': {
            const paths = _collectVisiblePaths(rootEl);
            const dropped = discardPendingSessionWrites(paths);
            const section = rootEl.querySelector('[data-sess-section]');
            if (section instanceof HTMLElement) section.remove();
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                window.showToast(
                    `Discarded ${dropped.length} pending session ${dropped.length === 1 ? 'file' : 'files'}.`,
                    'info',
                );
            }
            return;
        }
        default:
            return;
    }
}

function _collectVisiblePaths(rootEl) {
    const codes = rootEl.querySelectorAll('.commit-file--mem .path');
    return Array.from(codes).map((el) => el.textContent || '').filter(Boolean);
}
