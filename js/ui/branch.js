/**
 * Branch Creation Workflow
 * New branch modal with git ref sanitization.
 * Extracted from ui-helpers.js in 0.9.13.
 */

import { State } from '../core.js';
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
        State.currentBranch = name;
        
        const branchSelect = document.getElementById('branchSelect');
        branchSelect.innerHTML = State.branches.map(b => 
            `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}${b.protected ? ' 🔒' : ''}</option>`
        ).join('');
        branchSelect.value = name;

        closeNewBranchModal();
        showToast(`Created branch: ${name}`, 'success');
    } catch (error) {
        showToast(`Failed to create branch: ${error.message || error}`, 'error');
        console.error('Branch creation error:', error);
    }
}
