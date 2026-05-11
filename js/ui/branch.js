/**
 * Branch Creation Workflow
 * New branch modal with git ref sanitization.
 * Extracted from ui-helpers.js in 0.9.13.
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';
import { showToast } from '../ui-helpers.js';

// ============================================
// NEW BRANCH MODAL
// ============================================

export function openNewBranchModal() {
    const fromSelect = document.getElementById('newBranchFrom');
    fromSelect.innerHTML = State.branches.map(b => 
        `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}</option>`
    ).join('');
    document.getElementById('newBranchModal').classList.add('active');
}

export function closeNewBranchModal() {
    document.getElementById('newBranchModal').classList.remove('active');
}

/**
 * Bind a delegated click handler for the new-branch modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * Phase 2a of the inline-handlers migration (DESIGN-html-inline-handlers-migration.md).
 */
let _wired = false;
export function mountNewBranchModal({ onClose, onCreate } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#newBranchModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeNewBranchModal' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'createNewBranch' && typeof onCreate === 'function') {
            onCreate();
        }
    });
}

export async function createNewBranch() {
    let name = document.getElementById('newBranchName').value.trim();
    const from = document.getElementById('newBranchFrom').value || State.currentBranch || 'main';
    
    if (!name) {
        showToast('Please enter a branch name', 'warning');
        return;
    }

    // Sanitize for git ref naming rules
    name = name
        .replace(/[\s~^:?*\[\]\\@{}"'<>|]/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]/, '')
        .replace(/[-.]+$/, '')
        .replace(/\.lock$/i, '');
    
    if (!name) {
        showToast('Branch name contains only invalid characters', 'warning');
        return;
    }

    document.getElementById('newBranchName').value = name;
    
    const { owner, repo } = State.currentProject;
    
    try {
        await Git.createBranch(owner, repo, name, from);

        State.branches = await Git.listBranches(owner, repo);
        const previousBranch = State.currentBranch;
        State.currentBranch = name;

        // Copy embedding index from parent branch (files are identical at creation)
        EventBus.emit('branch:created', { sourceBranch: from, targetBranch: name });

        // Re-render the branch panel via its event subscriptions; emitting
        // `branches:refresh` triggers refreshBranches() which calls
        // renderBranchPanel() + populateBranchMetadata() in project-manager.
        EventBus.emit('branches:refresh');

        // Notify context manager about branch switch
        EventBus.emit('branch:switch', { branch: name, previousBranch });

        closeNewBranchModal();
        showToast(`Created branch: ${name}`, 'success');
    } catch (error) {
        showToast(`Failed to create branch: ${error.message || error}`, 'error');
        console.error('Branch creation error:', error);
    }
}
