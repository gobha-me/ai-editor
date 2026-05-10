// @ts-check
/**
 * PR Review — merge controls.
 *
 * Extracted from the legacy `js/pr-detail.js#submitMergePR` (deleted in
 * 2.13.0). Lives inside the dock so the dock owns every PR action in
 * one place — Submit + Merge — and so the post-merge state-refresh runs
 * through the same `prs:refresh` seam the rest of the surface already
 * subscribes to (`PrReviewSurface.js:175`).
 *
 * The user feedback that drove this slice: in slice 1 + the legacy
 * modal there was no refresh affordance after merge, so a successful
 * merge left the UI showing stale state. Solution: the merge action
 * itself emits `prs:refresh` on success → the surface re-runs `load()`
 * → `pr.state` flips to `'merged'`, the dock hides Submit/Merge, the
 * Topbar state badge re-renders. **No separate Refresh button.**
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 * @module pr-review/PrMergeControls
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { getPreact } from '../utils/preact-mount.js';

const { html, useState, useRef, useEffect } = await getPreact();

const CONFIRM_TIMEOUT_MS = 3000;

/**
 * @param {{
 *   prNumber: number,
 *   pr: any,
 *   onError: (msg:string) => void
 * }} props
 */
export function PrMergeControls({ prNumber, pr, onError }) {
    const [strategy, setStrategy] = useState('squash');
    const [deleteBranch, setDeleteBranch] = useState(true);
    const [confirming, setConfirming] = useState(false);
    const [merging, setMerging] = useState(false);
    const confirmTimerRef = useRef(null);

    // Reset the confirm flag if the user takes too long.
    useEffect(() => {
        if (!confirming) return;
        confirmTimerRef.current = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
        return () => {
            if (confirmTimerRef.current) {
                clearTimeout(confirmTimerRef.current);
                confirmTimerRef.current = null;
            }
        };
    }, [confirming]);

    async function handleClick() {
        if (merging) return;
        if (!confirming) {
            setConfirming(true);
            return;
        }
        setConfirming(false);
        setMerging(true);
        try {
            if (!State.currentProject) throw new Error('No project loaded');
            const { owner, repo } = State.currentProject;
            await Git.mergePullRequest(owner, repo, prNumber, {
                mergeType: strategy,
                deleteBranch,
                headSha: pr?.headSha || '',
            });

            // Notify retrieval / context layers — same payload as
            // pr-detail.js:404-409 to preserve the post-merge reindex hook.
            const changedFiles = []; // surface doesn't track files at this depth; reindex runs on push event anyway
            EventBus.emit('context:prMerged', {
                baseBranch: pr?.base,
                headBranch: pr?.head,
                changedFiles,
                deletedBranch: deleteBranch ? pr?.head : null,
            });
            EventBus.emit('project:refreshAfterMerge');

            // Load-on-click: post-action refetch. The surface subscribes
            // to `prs:refresh` (slice-1 line 175) — emitting here drives
            // the whole surface (state badge, dock, files) to re-render
            // with `pr.state === 'merged'`. No separate Refresh button.
            EventBus.emit('prs:refresh');
        } catch (e) {
            console.error('[pr-review] merge failed:', e);
            onError(`Merge failed: ${e?.message || String(e)}`);
        } finally {
            setMerging(false);
        }
    }

    const btnLabel = merging
        ? '⏳ Merging…'
        : confirming
            ? `⚠️ Confirm ${strategy}?`
            : '✅ Merge';

    return html`
        <div class="pr-dock__merge" role="group" aria-label="Merge controls">
            <select
                class="pr-dock__select"
                value=${strategy}
                onChange=${(e) => setStrategy(e.target.value)}
                disabled=${merging}
                aria-label="Merge strategy">
                <option value="squash">Squash</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
            </select>
            <label class="pr-dock__check">
                <input
                    type="checkbox"
                    checked=${deleteBranch}
                    onChange=${(e) => setDeleteBranch(e.target.checked)}
                    disabled=${merging}
                />
                Delete branch
            </label>
            <button
                type="button"
                class=${'pr__btn ' + (confirming ? 'pr__btn--danger' : 'pr__btn--primary')}
                onClick=${handleClick}
                disabled=${merging}>
                ${btnLabel}
            </button>
        </div>
    `;
}
