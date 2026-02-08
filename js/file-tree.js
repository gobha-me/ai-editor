// ============================================
// FILE TREE RENDERER
// ============================================

import { State } from './core.js';
import { getFileIcon, isTextFile } from './editor.js';
import { loadFile, Git } from './git.js';
import { createEditor } from './editor.js';
import { renderEditorTabs } from './tab-manager.js';

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

export function renderFileTree() {
    const container = document.getElementById('fileTree');
    
    if (State.fileTree.length === 0) {
        container.innerHTML = '<div style="padding: 1rem; color: var(--text-muted);">No files found</div>';
        return;
    }

    // Build tree structure
    const tree = buildTreeStructure(State.fileTree);
    container.innerHTML = renderTreeNodes(tree, 0);
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
            
            // Use mousedown handler with click counting for proper single/double click detection
            const clickHandler = `window.handleTreeClick(event, '${node.path}', '${node.type}')`;
            
            let html = `
                <div class="tree-item ${isDir ? 'dir' : ''}" 
                     data-depth="${depth}" 
                     data-path="${node.path}"
                     data-type="${node.type}"
                     onclick="${clickHandler}">
                    ${chevron}
                    <span class="icon">${icon}</span>
                    <span class="name">${node.name}</span>
                    <div class="actions">
                        ${!isDir ? `<button onclick="event.stopPropagation(); window.deleteFile('${node.path}')" title="Delete">🗑</button>` : ''}
                    </div>
                </div>
            `;

            if (isDir && hasChildren) {
                html += `<div class="tree-children collapsed" data-parent="${node.path}">${renderTreeNodes(node.children, depth + 1)}</div>`;
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
            children.classList.toggle('collapsed');
            const chevron = item.querySelector('.chevron');
            if (chevron) {
                chevron.classList.toggle('expanded');
            }
        }
        return;
    }

    // Check if it's a text file
    if (!isTextFile(path)) {
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
    if (!confirm(`Delete ${path}?`)) return;

    const { owner, repo } = State.currentProject;
    const file = State.fileTree.find(f => f.path === path);
    
    try {
        await Git.deleteFile(owner, repo, path, `Delete ${path}`, file.sha, State.currentBranch);
        
        // Close tab if open
        const tabIndex = State.openTabs.findIndex(t => t.path === path);
        if (tabIndex >= 0) {
            State.openTabs.splice(tabIndex, 1);
            if (State.activeTabIndex >= tabIndex) {
                State.activeTabIndex = Math.max(0, State.activeTabIndex - 1);
            }
            if (State.openTabs.length > 0) {
                const { switchToTab } = await import('./tab-manager.js');
                await switchToTab(State.activeTabIndex);
            }
        }
        
        // Refresh file tree
        const { EventBus } = await import('./core.js');
        EventBus.emit('tree:refresh');
        
        window.showToast('File deleted', 'success');
    } catch (error) {
        window.showToast('Failed to delete file', 'error');
    }
}
