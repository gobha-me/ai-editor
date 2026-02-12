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
}

export function closeNewFileModal() {
    document.getElementById('newFileModal').classList.remove('active');
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
        
        EventBus.emit('tree:refresh');
        
        closeNewFileModal();
        showToast(`Created: ${path}`, 'success');
        
        window.onTreeItemClick(path, 'file');
    } catch (error) {
        showToast('Failed to create file', 'error');
    }
}
