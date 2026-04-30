// @ts-check
/**
 * Commit-modal "Memory updates" section — Touch 1 Flow 3A/3B.
 *
 * Renders an HTML string injected into `#commitMemorySection` from
 * `openCommitModal()` whenever the file layer has pending memory writes.
 * Two surface variants:
 *
 *   - **Flow 3A** (current branch is unprotected): a `commit-section--mem`
 *     panel auto-stages every pending `.aieditor/memory/*.md` path. Each
 *     row has a "Show diff" toggle that reveals the pending content
 *     prefixed with `+ ` lines.
 *   - **Flow 3B** (current branch is protected per `State.branches`):
 *     a `commit-section--warn` panel surfacing the same pending paths as
 *     a disabled, unstageable warning, with three escape-hatch buttons
 *     ("Branch off & commit memory" / "Keep pending" / "Discard").
 *
 * Renderer is pure (string in, string out — uses `escapeAttr` so the
 * `node:test` suite can run without a DOM). `wireMemoryUpdatesSection()`
 * binds click handlers on the rendered DOM via event delegation;
 * idempotent so the modal can re-render between opens without leaking
 * listeners.
 *
 * The "Branch off & commit memory" button is a placeholder in PR #7 —
 * it emits `memory:branchOffRequested` and shows a toast pointing at the
 * 1.3.x patch that wires the real branch-creation flow. The button is
 * shipped because the design + Decision §4 commit to the affordance,
 * and an honest "lands soon" toast beats hiding the button.
 *
 * @module ui/commit-memory-section
 */

import { EventBus } from '../core.js';
import { escapeAttr } from '../utils/html.js';
import {
    getPendingContent,
    discardPendingMemoryWrites,
} from '../intelligence/memory/index.js';

/**
 * @typedef {Object} MemoryUpdatesSectionProps
 * @property {boolean} isProtected
 * @property {string[]} pendingPaths
 * @property {string} [branch]
 */

/**
 * Render the section. Returns `''` when there are no pending paths
 * (the modal builds the section unconditionally; an empty string keeps
 * the DOM mount point but contributes no visual surface).
 *
 * @param {MemoryUpdatesSectionProps} props
 * @returns {string}
 */
export function renderMemoryUpdatesSection({ isProtected, pendingPaths, branch }) {
    if (!Array.isArray(pendingPaths) || pendingPaths.length === 0) return '';

    const rows = pendingPaths.map((p, i) => _renderRow(p, i, { isProtected })).join('');
    const count = pendingPaths.length;
    const fileLabel = count === 1 ? '1 file' : `${count} files`;
    const branchLabel = escapeAttr(branch || '');

    if (isProtected) {
        return `
            <div class="commit-section commit-section--warn" data-mem-section="warn">
                <div class="commit-section__head">
                    <span class="commit-section__title commit-section__title--warn">⚠ Memory writes can't be staged here</span>
                    <span class="commit-section__count">on protected branch</span>
                </div>
                <p class="commit-section__hint">
                    You have <strong>${fileLabel === '1 file' ? '1 pending memory update' : `${count} pending memory updates`}</strong>.
                    They won't be committed to <code class="branch-row__name">${branchLabel}</code> —
                    these usually land on feature branches or in a dedicated <code class="branch-row__name">memory/</code> branch.
                </p>
                ${rows}
                <div class="commit-section__actions">
                    <button type="button" class="mem-btn" data-mem-action="branchOff">Branch off &amp; commit memory</button>
                    <button type="button" class="mem-btn mem-btn--ghost" data-mem-action="keepPending">Keep pending</button>
                    <button type="button" class="mem-btn mem-btn--ghost" data-mem-action="discard">Discard</button>
                </div>
            </div>
        `;
    }

    return `
        <div class="commit-section commit-section--mem" data-mem-section="mem">
            <div class="commit-section__head">
                <span class="commit-section__title commit-section__title--mem">◆ Memory updates</span>
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
        : `checked data-mem-path="${safePath}"`;
    const rowClass = isProtected
        ? 'commit-file commit-file--mem is-disabled'
        : 'commit-file commit-file--mem';
    // Show/Hide diff toggle is offered on both flows so the user can
    // inspect what would (or wouldn't) be committed.
    const diffLink = `<a class="src-link commit-file__diff-toggle" data-mem-diff-toggle="${index}" data-mem-path-for-diff="${safePath}" role="button" tabindex="0">Show diff</a>`;

    return `
        <label class="${rowClass}">
            <input type="checkbox" ${checkboxAttrs}>
            <code class="path">${safePath}</code>
            ${diffLink}
        </label>
        <pre class="commit-mem-diff" data-mem-diff-target="${index}" hidden></pre>
    `;
}

/**
 * Format a pending file's content as `+ ` prefixed lines for the
 * Show diff preview. Pending memory files are always treated as adds
 * for the preview — true file-vs-HEAD diffing is a 1.3.x patch.
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
 * @param {HTMLElement} rootEl Container holding the rendered section
 *   (the `#commitMemorySection` div from `html/modals.html`).
 * @param {{ closeModal?: () => void }} [callbacks]
 * @returns {void}
 */
export function wireMemoryUpdatesSection(rootEl, callbacks = {}) {
    if (!rootEl) return;

    if (rootEl._memSectionHandler) {
        rootEl.removeEventListener('click', rootEl._memSectionHandler);
        rootEl._memSectionHandler = null;
    }

    const handler = (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;

        const action = target.dataset.memAction;
        if (action) {
            ev.preventDefault();
            _handleAction(action, rootEl, callbacks);
            return;
        }

        const diffToggle = target.closest('[data-mem-diff-toggle]');
        if (diffToggle instanceof HTMLElement) {
            ev.preventDefault();
            _toggleDiff(diffToggle, rootEl);
        }
    };

    rootEl.addEventListener('click', handler);
    rootEl._memSectionHandler = handler;
}

function _toggleDiff(toggleEl, rootEl) {
    const idx = toggleEl.dataset.memDiffToggle;
    const path = toggleEl.dataset.memPathForDiff;
    const pre = rootEl.querySelector(`[data-mem-diff-target="${idx}"]`);
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
            EventBus.emit('memory:branchOffRequested', { paths });
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                window.showToast(
                    'Branch-off flow lands in 1.3.x — keeping memory pending for now.',
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
            const dropped = discardPendingMemoryWrites(paths);
            const section = rootEl.querySelector('[data-mem-section]');
            if (section instanceof HTMLElement) section.remove();
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
                window.showToast(
                    `Discarded ${dropped.length} pending memory ${dropped.length === 1 ? 'file' : 'files'}.`,
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
