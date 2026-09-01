/**
 * File Creation Workflow
 * New file modal and git file creation.
 * Extracted from ui-helpers.js in 0.9.13.
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { showToast } from '../ui-helpers.js';

// ============================================
// NEW FILE MODAL
// ============================================

export function openNewFileModal() {
    document.getElementById('newFileModal').classList.add('active');
    const input = document.getElementById('newFileName');
    input.value = '';
    input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); createNewFile(); }
        if (e.key === 'Escape') { e.preventDefault(); closeNewFileModal(); }
    };
    requestAnimationFrame(() => input.focus());
}

export function closeNewFileModal() {
    document.getElementById('newFileModal').classList.remove('active');
}

/**
 * Bind a delegated click handler for the new-file modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * Phase 2a of the inline-handlers migration (DESIGN-ui-event-dispatch.md).
 */
let _wired = false;
export function mountNewFileModal({ onClose, onCreate } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#newFileModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeNewFileModal' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'createNewFile' && typeof onCreate === 'function') {
            onCreate();
        }
    });
}

export async function createNewFile() {
    const path = document.getElementById('newFileName').value.trim();
    
    if (!path) {
        showToast('Please enter a file path', 'warning');
        return;
    }

    const { owner, repo } = State.currentProject;
    
    try {
        await Git.createFile(owner, repo, path, '', `Create ${path}`, State.currentBranch);
        
        EventBus.emit('fs:created', { path, branch: State.currentBranch });
        EventBus.emit('tree:refresh');
        
        closeNewFileModal();
        showToast(`Created: ${path}`, 'success');
        
        window.onTreeItemClick(path, 'file');
    } catch (error) {
        showToast('Failed to create file', 'error');
    }
}
