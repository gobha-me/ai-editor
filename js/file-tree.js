// ============================================
// FILE TREE RENDERER
// ============================================

import { State, Storage } from './core.js';
import { getFileIcon, isBinaryFile, looksLikeText } from './editor.js';
import { loadFile, Git } from './git.js';
import { createEditor } from './editor.js';
import { renderEditorTabs } from './tab-manager.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// File operation lock to prevent concurrent loads (FIX #23)
const FileOperationLock = {
    _loading: false,
    _queue: [],
    
    async acquire(operation) {
        if (this._loading) {
            console.log('[LOCK] Operation queued, waiting for current load to finish');
            // Wait for current operation to finish
            return new Promise((resolve) => {
                this._queue.push(() => this.acquire(operation).then(resolve));
            });
        }
        
        this._loading = true;
        console.log('[LOCK] Acquired lock');
        try {
            return await operation();
        } finally {
            this._loading = false;
            console.log('[LOCK] Released lock');
            const next = this._queue.shift();
            if (next) {
                console.log('[LOCK] Processing queued operation');
                next();
            }
        }
    }
};

export function renderFileTree(container) {
    if (!container) container = document.getElementById('fileTree');
    if (!container) return;

    if (State.fileTree.length === 0) {
        container.innerHTML = '<div style="padding: 1rem; color: var(--text-muted);">No files found</div>';
        return;
    }

    // Build tree structure
    const tree = buildTreeStructure(State.fileTree);
    container.innerHTML = renderTreeNodes(tree, 0);

    // Roving tabindex: make only the first item tabbable
    const firstItem = container.querySelector('.tree-item');
    if (firstItem) firstItem.tabIndex = 0;
}

function buildTreeStructure(files) {
    const root = { children: {} };
    
    files.forEach(file => {
        const parts = file.path.split('/');
        let current = root;
        
        parts.forEach((part, i) => {
            if (!current.children[part]) {
                current.children[part] = {
                    name: part,
                    path: parts.slice(0, i + 1).join('/'),
                    type: i === parts.length - 1 ? file.type : 'dir',
                    sha: file.sha,
                    children: {}
                };
            }
            current = current.children[part];
        });
    });

    return root.children;
}

function renderTreeNodes(nodes, depth) {
    return Object.values(nodes)
        .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        })
        .map(node => {
            const isDir = node.type === 'dir';
            const icon = getFileIcon(node.name, isDir);
            const hasChildren = Object.keys(node.children).length > 0;
            const chevron = isDir ? '<span class="chevron">▶</span>' : '<span class="chevron-spacer"></span>';
            
            const itemId = `ti-${escapeAttr(node.path).replace(/[^a-zA-Z0-9]/g, '-')}`;

            let html = `
                <div class="tree-item ${isDir ? 'dir' : ''}"
                     data-depth="${depth}"
                     data-path="${escapeAttr(node.path)}"
                     data-type="${escapeAttr(node.type)}"
                     role="treeitem"
                     tabindex="-1"
                     aria-labelledby="${itemId}"
                     ${isDir && hasChildren ? `aria-expanded="false"` : ''}
                     data-action="handleTreeClick">
                    ${chevron}
                    <span class="icon" aria-hidden="true">${icon}</span>
                    <span class="name" id="${itemId}">${escapeHtml(node.name)}${isDir ? '<span class="sr-only">, folder</span>' : ''}</span>
                    <div class="actions">
                        <button type="button" data-action="openRenameModal" data-path="${escapeAttr(node.path)}" data-is-dir="${isDir}" title="Rename / Move" aria-label="Rename ${escapeAttr(node.name)}">✏️</button>
                        <button type="button" data-action="${isDir ? 'deleteFolder' : 'deleteFile'}" data-path="${escapeAttr(node.path)}" title="Delete" aria-label="Delete ${escapeAttr(node.name)}">🗑</button>
                    </div>
                </div>
            `;

            if (isDir && hasChildren) {
                html += `<div class="tree-children collapsed" data-parent="${escapeAttr(node.path)}" role="group">${renderTreeNodes(node.children, depth + 1)}</div>`;
            }

            return html;
        }).join('');
}

// Click handling with debounce for single/double click detection
let clickTimer = null;
let clickCount = 0;
let lastClickPath = null;

export function handleTreeClick(event, path, type) {
    event.stopPropagation();
    
    // If different path, reset counter
    if (lastClickPath !== path) {
        clickCount = 0;
        if (clickTimer) clearTimeout(clickTimer);
    }
    lastClickPath = path;
    clickCount++;
    
    if (clickCount === 1) {
        // Wait to see if double-click
        clickTimer = setTimeout(() => {
            // Single click - open as preview
            onTreeItemClick(path, type, false);
            clickCount = 0;
        }, 250);
    } else if (clickCount === 2) {
        // Double click - open and pin
        if (clickTimer) clearTimeout(clickTimer);
        clickCount = 0;
        onTreeItemClick(path, type, true);
    }
}

export async function onTreeItemClick(path, type, isDoubleClick = false) {
    console.log(`[CLICK] path=${path}, type=${type}, double=${isDoubleClick}`);
    
    if (type === 'dir') {
        // Toggle directory expansion
        const item = document.querySelector(`.tree-item[data-path="${path}"]`);
        const children = document.querySelector(`.tree-children[data-parent="${path}"]`);
        if (children) {
            const isExpanding = children.classList.toggle('collapsed') === false;
            const chevron = item.querySelector('.chevron');
            if (chevron) {
                chevron.classList.toggle('expanded', isExpanding);
            }
            // Sync ARIA state
            item.setAttribute('aria-expanded', String(isExpanding));
        }
        return;
    }

    // Block known binary files (images, archives, compiled, etc.)
    if (isBinaryFile(path)) {
        window.showToast('Cannot edit binary files', 'warning');
        return;
    }

    // Wrap in operation lock to prevent concurrent file loads (FIX #23)
    return FileOperationLock.acquire(async () => {
        console.log('[LOCK] Starting file operation for', path);
        
        try {
            // *** FIX: Save current tab state BEFORE loading anything ***
            if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
                console.log('[SAVE] Saving current tab state before load');
                State.openTabs[State.activeTabIndex].content = State.editorContent;
                State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
            }

            // Check if file is already open
            const existingTabIndex = State.openTabs.findIndex(t => t.path === path);
            console.log(`[CHECK] Existing tab index: ${existingTabIndex}`);
            
            if (existingTabIndex >= 0) {
                // File already open - switch to it
                console.log('[SWITCH] Switching to existing tab');
                const { switchToTab } = await import('./tab-manager.js');
                await switchToTab(existingTabIndex);
                // If double-clicked, pin the preview tab
                if (isDoubleClick && State.openTabs[existingTabIndex].isPreview) {
                    State.openTabs[existingTabIndex].isPreview = false;
                    renderEditorTabs();
                }
                return;
            }

            // Load the file from remote (async operation)
            console.log('[LOAD] Loading file from remote...');
            await loadFile(path);

            // Post-load binary content sniff for files with unrecognised extensions
            if (!looksLikeText(State.currentFile.content)) {
                console.warn('[LOAD] Content sniff detected binary data for', path);
                window.showToast('File appears to contain binary data', 'warning');
                return;
            }
            
            // Store the original (server) content for revert — NOT the draft
            const originalContent = State.currentFile.content;
            // Preserve draft dirty state (createEditor will reset State.editorDirty)
            const hasDraft = State.editorDirty;
            
            // Handle preview tabs - single click opens preview, replaces existing preview
            const isPreview = !isDoubleClick;
            console.log(`[TAB] Creating tab: isPreview=${isPreview}`);
            
            if (isPreview) {
                // Find and replace existing preview tab
                const previewIndex = State.openTabs.findIndex(t => t.isPreview);
                console.log(`[PREVIEW] Preview index: ${previewIndex}`);
                if (previewIndex >= 0) {
                    // Replace preview tab
                    State.openTabs[previewIndex] = {
                        path: path,
                        content: State.editorContent,
                        originalContent: originalContent,
                        sha: State.currentFile.sha,
                        dirty: State.editorDirty,
                        isPreview: true
                    };
                    State.activeTabIndex = previewIndex;
                } else {
                    // Add new preview tab
                    State.openTabs.push({
                        path: path,
                        content: State.editorContent,
                        originalContent: originalContent,
                        sha: State.currentFile.sha,
                        dirty: State.editorDirty,
                        isPreview: true
                    });
                    State.activeTabIndex = State.openTabs.length - 1;
                }
            } else {
                // Double-click: add as permanent tab
                State.openTabs.push({
                    path: path,
                    content: State.editorContent,
                    originalContent: originalContent,
                    sha: State.currentFile.sha,
                    dirty: State.editorDirty,
                    isPreview: false
                });
                State.activeTabIndex = State.openTabs.length - 1;
            }
            
            console.log(`[TABS] After: openTabs=${State.openTabs.length}, activeIndex=${State.activeTabIndex}`);
            
            // Create editor
            await createEditor(
                document.getElementById('editorContainer'),
                State.editorContent,
                path
            );

            // Restore draft dirty state (createEditor resets editorDirty to false)
            if (hasDraft) {
                State.editorDirty = true;
                if (State.activeTabIndex >= 0) {
                    State.openTabs[State.activeTabIndex].dirty = true;
                }
            }

            // Render tabs
            renderEditorTabs();
            
            // Trigger event for other modules to update
            const { EventBus } = await import('./core.js');
            EventBus.emit('file:opened', { path });
            
            // Highlight active file in tree
            document.querySelectorAll('.tree-item').forEach(el => {
                el.classList.toggle('active', el.dataset.path === path);
            });
            
            console.log('[LOCK] File operation completed successfully');

        } catch (error) {
            console.error('[ERROR] Failed to load file:', error);
            window.showToast('Failed to load file', 'error');
        }
    });
}

// Delete file
export async function deleteFile(path) {
    const { showConfirm } = await import('./ui/dialogs.js');
    if (!await showConfirm(`Delete ${path.split('/').pop()}?`, { title: 'Delete File', okLabel: 'Delete', variant: 'danger' })) return;

    const { owner, repo } = State.currentProject;
    const file = State.fileTree.find(f => f.path === path);
    
    try {
        await Git.deleteFile(owner, repo, path, `Delete ${path}`, file.sha, State.currentBranch);
        
        // Clear any orphaned draft for this file
        Storage.clearDraft(owner, repo, State.currentBranch, path);
        
        // Close tab if open
        await _closeTabForPath(path);
        
        // Refresh file tree
        const { EventBus } = await import('./core.js');
        EventBus.emit('fs:deleted', { path, branch: State.currentBranch });
        EventBus.emit('tree:refresh');
        
        window.showToast('File deleted', 'success');
    } catch (error) {
        window.showToast('Failed to delete file', 'error');
    }
}

// Delete folder (recursive)
export async function deleteFolder(folderPath) {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    const fileCount = (State.fileTree || []).filter(f => f.type === 'file' && f.path.startsWith(prefix)).length;

    if (fileCount === 0) {
        window.showToast('Folder is empty', 'warning');
        return;
    }

    const { showConfirm } = await import('./ui/dialogs.js');
    if (!await showConfirm(`Delete folder "${folderPath}" and all ${fileCount} file${fileCount !== 1 ? 's' : ''} inside it?`, { title: 'Delete Folder', okLabel: 'Delete', variant: 'danger' })) return;

    const { owner, repo } = State.currentProject;

    try {
        const result = await Git.deleteFolder(
            owner, repo, folderPath,
            `Delete folder ${folderPath} (${fileCount} files)`,
            State.currentBranch
        );

        // Close all tabs for files in this folder
        const affectedFiles = (State.fileTree || []).filter(f => f.type === 'file' && f.path.startsWith(prefix));
        for (const file of affectedFiles) {
            Storage.clearDraft(owner, repo, State.currentBranch, file.path);
            await _closeTabForPath(file.path);
        }

        const { EventBus } = await import('./core.js');
        EventBus.emit('fs:deleted', { path: folderPath, branch: State.currentBranch, isFolder: true });
        EventBus.emit('tree:refresh');

        if (result.errors > 0) {
            window.showToast(`Deleted ${result.deleted} files, ${result.errors} failed`, 'warning');
        } else {
            window.showToast(`Deleted folder (${result.deleted} files)`, 'success');
        }
    } catch (error) {
        console.error('Folder delete failed:', error);
        window.showToast(`Failed to delete folder: ${error.message}`, 'error');
    }
}

/**
 * Bind a delegated click handler for tree rows + per-row rename/delete
 * buttons. Phase 3a of the inline-handlers migration
 * (DESIGN-html-inline-handlers-migration.md). Scoped to `#fileTree` —
 * `renderFileTree` rebuilds the entire tree on each refresh, so the
 * document-level listener survives container re-creation.
 */
let _wired = false;
export function mountFileTree({ onTreeClick, onRename, onDeleteFile, onDeleteFolder } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#fileTree')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'handleTreeClick' && typeof onTreeClick === 'function') {
            onTreeClick(e, btn.getAttribute('data-path'), btn.getAttribute('data-type'));
        } else if (action === 'openRenameModal' && typeof onRename === 'function') {
            onRename(btn.getAttribute('data-path'), btn.dataset.isDir === 'true');
        } else if (action === 'deleteFile' && typeof onDeleteFile === 'function') {
            onDeleteFile(btn.getAttribute('data-path'));
        } else if (action === 'deleteFolder' && typeof onDeleteFolder === 'function') {
            onDeleteFolder(btn.getAttribute('data-path'));
        }
    });
}

/** Close tab for a given path if open, adjusting active index */
async function _closeTabForPath(path) {
    const tabIndex = State.openTabs.findIndex(t => t.path === path);
    if (tabIndex < 0) return;

    State.openTabs.splice(tabIndex, 1);
    if (State.activeTabIndex >= tabIndex) {
        State.activeTabIndex = Math.max(0, State.activeTabIndex - 1);
    }
    if (State.openTabs.length > 0) {
        const { switchToTab } = await import('./tab-manager.js');
        await switchToTab(State.activeTabIndex);
    }
}