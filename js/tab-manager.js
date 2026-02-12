// ============================================
// TAB MANAGER
// ============================================

import { State, EventBus } from './core.js';
import { createEditor } from './editor.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// Switch to a specific tab
export async function switchToTab(index) {
    if (index < 0 || index >= State.openTabs.length) return;
    
    // Save current tab state if there's an active tab
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        State.openTabs[State.activeTabIndex].content = State.editorContent;
        State.openTabs[State.activeTabIndex].dirty = State.editorDirty;
    }
    
    State.activeTabIndex = index;
    const tab = State.openTabs[index];
    
    // Update current file state
    State.currentFile = {
        path: tab.path,
        content: tab.originalContent || tab.content,
        sha: tab.sha
    };
    State.editorContent = tab.content;
    State.editorDirty = tab.dirty;
    
    // Create editor with tab content
    await createEditor(
        document.getElementById('editorContainer'),
        tab.content,
        tab.path
    );
    
    // Restore dirty state (createEditor resets editorDirty to false)
    State.editorDirty = tab.dirty;
    
    renderEditorTabs();
    
    // Trigger event for other modules to update
    EventBus.emit('tab:switched', { index, tab });
    
    // Highlight active file in tree
    document.querySelectorAll('.tree-item').forEach(el => {
        el.classList.toggle('active', el.dataset.path === tab.path);
    });
}

// Close a tab
export function closeTab(index, event) {
    if (event) {
        event.stopPropagation();
    }
    
    if (index < 0 || index >= State.openTabs.length) return;
    
    const tab = State.openTabs[index];
    
    // Warn if dirty
    if (tab.dirty && !confirm(`${tab.path} has unsaved changes. Close anyway?`)) {
        return;
    }
    
    // Remove tab
    State.openTabs.splice(index, 1);
    EventBus.emit('tab:closed', { path: tab.path });
    
    // Adjust active index
    if (State.openTabs.length === 0) {
        State.activeTabIndex = -1;
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;
        
        // Close secondary pane (diff/preview are invalid with no file open)
        import('./secondary-pane.js').then(({ closeSecondaryPane }) => closeSecondaryPane());
        
        // Show welcome screen
        document.getElementById('editorContainer').innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted);">
                <div style="text-align: center;">
                    <h2 style="font-size: 24px; margin-bottom: 1rem;">⚡ AI Editor</h2>
                    <p>Select a file to edit</p>
                </div>
            </div>
        `;
        renderEditorTabs();
        EventBus.emit('statusBar:update');
    } else if (index <= State.activeTabIndex) {
        // Switch to previous or next tab
        const newIndex = Math.min(State.activeTabIndex, State.openTabs.length - 1);
        if (newIndex !== State.activeTabIndex || index === State.activeTabIndex) {
            State.activeTabIndex = Math.max(0, newIndex - (index < State.activeTabIndex ? 1 : 0));
            switchToTab(State.activeTabIndex);
        } else {
            renderEditorTabs();
        }
    } else {
        renderEditorTabs();
    }
}

// Pin a preview tab (convert to permanent)
export function pinTab(index) {
    if (index >= 0 && index < State.openTabs.length) {
        State.openTabs[index].isPreview = false;
        renderEditorTabs();
    }
}

// Render all editor tabs
export function renderEditorTabs() {
    const tabsContainer = document.getElementById('editorTabs');
    
    if (State.openTabs.length === 0) {
        tabsContainer.innerHTML = `
            <div class="editor-tab active">
                <span class="tab-name">Welcome</span>
            </div>
        `;
        return;
    }
    
    tabsContainer.innerHTML = State.openTabs.map((tab, index) => {
        const fileName = tab.path.split('/').pop();
        const isActive = index === State.activeTabIndex;
        const previewClass = tab.isPreview ? 'preview' : '';
        const activeClass = isActive ? 'active' : '';
        
        return `
            <div class="editor-tab ${activeClass} ${previewClass}" 
                 role="tab"
                 tabindex="${isActive ? '0' : '-1'}"
                 aria-selected="${isActive}"
                 aria-label="${escapeAttr(fileName)}${tab.dirty ? ', modified' : ''}${tab.isPreview ? ', preview' : ''}"
                 onclick="window.switchToTab(${index})"
                 ondblclick="window.pinTab(${index})"
                 title="${escapeAttr(tab.path)}">
                <span class="tab-name">${escapeHtml(fileName)}</span>
                <span class="modified" aria-hidden="true" style="display: ${tab.dirty ? 'inline' : 'none'}">●</span>
                <button class="close" onclick="window.closeTab(${index}, event)" title="Close" aria-label="Close ${escapeAttr(fileName)}">×</button>
            </div>
        `;
    }).join('');
}

// Update current tab's dirty state when editor changes
export function initTabChangeListener() {
    EventBus.on('editor:change', () => {
        if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
            State.openTabs[State.activeTabIndex].dirty = true;
            State.openTabs[State.activeTabIndex].content = State.editorContent;
            // Pin the tab if it was a preview (editing pins it)
            if (State.openTabs[State.activeTabIndex].isPreview) {
                State.openTabs[State.activeTabIndex].isPreview = false;
            }
            renderEditorTabs();
        }
    });
}
