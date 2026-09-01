// ============================================
// TAB MANAGER  (v0.9.39 — typed tabs: file, issue)
// ============================================

import { State, EventBus } from './core.js';
import { createEditor } from './editor.js';
import { escapeHtml, escapeAttr } from './utils/html.js';
import { showConfirm } from './ui/dialogs.js';

// ── Custom tab renderer registry ──────────────────────────
// Keyed by tab type string (e.g. 'issue').
// Value: async (container: HTMLElement, tab: object) => void
const _tabRenderers = {};

/**
 * Register a renderer for a custom (non-file) tab type.
 * Called once at init time by feature modules (e.g. issue-detail.js).
 * @param {string} type - Tab type key ('issue', 'pr', …)
 * @param {(container: HTMLElement, tab: object) => Promise<void>} renderer
 */
export function registerTabRenderer(type, renderer) {
    _tabRenderers[type] = renderer;
}

// ── Switch tab ────────────────────────────────────────────

export async function switchToTab(index) {
    if (index < 0 || index >= State.openTabs.length) return;

    // Save current tab state if it's a file tab
    if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
        const prev = State.openTabs[State.activeTabIndex];
        if (!prev.type || prev.type === 'file') {
            prev.content = State.editorContent;
            prev.dirty = State.editorDirty;
        }
        // Plugin editor saves its own source via CM update listener
    }

    State.activeTabIndex = index;
    const tab = State.openTabs[index];
    const tabType = tab.type || 'file';
    const container = document.getElementById('editorContainer');

    if (tabType !== 'file' && _tabRenderers[tabType]) {
        // ── Custom tab (issue, pr, …) ──
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;
        _setEditorToolbar(false);

        // Close secondary pane — not meaningful for non-file tabs
        import('./secondary-pane.js').then(({ closeSecondaryPane }) => closeSecondaryPane()).catch(() => {});

        await _tabRenderers[tabType](container, tab);
    } else {
        // ── File tab ──
        State.currentFile = {
            path: tab.path,
            content: tab.originalContent || tab.content,
            sha: tab.sha
        };
        State.editorContent = tab.content;
        State.editorDirty = tab.dirty;
        _setEditorToolbar(true);

        await createEditor(container, tab.content, tab.path);
        State.editorDirty = tab.dirty;  // createEditor resets this
    }

    renderEditorTabs();
    EventBus.emit('tab:switched', { index, tab });

    // Highlight active file in tree (file tabs only)
    if (tabType === 'file') {
        document.querySelectorAll('.tree-item').forEach(el => {
            el.classList.toggle('active', el.dataset.path === tab.path);
        });
    } else {
        document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'));
    }
}

/** Enable / disable editor toolbar buttons (Preview, Diff, Blame). */
function _setEditorToolbar(enabled) {
    for (const id of ['btnTogglePreview', 'btnToggleDiff', 'btnToggleBlame']) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = !enabled;
    }
}

// ── Close tab ─────────────────────────────────────────────

export async function closeTab(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= State.openTabs.length) return;

    const tab = State.openTabs[index];
    const tabType = tab.type || 'file';

    // Warn about unsaved changes for file and plugin-editor tabs
    if ((tabType === 'file' || tabType === 'plugin-editor') && tab.dirty) {
        const label = tabType === 'plugin-editor'
            ? (tab.pluginName || 'plugin')
            : tab.path.split('/').pop();
        const discard = await showConfirm(`"${label}" has unsaved changes. Close anyway?`, {
            title: 'Unsaved Changes',
            okLabel: 'Discard',
            variant: 'danger',
        });
        if (!discard) return;
    }

    State.openTabs.splice(index, 1);
    EventBus.emit('tab:closed', { path: tab.path, type: tabType, issueNumber: tab.issueNumber });

    if (State.openTabs.length === 0) {
        State.activeTabIndex = -1;
        State.currentFile = null;
        State.editorContent = '';
        State.editorDirty = false;
        _setEditorToolbar(false);

        import('./secondary-pane.js').then(({ closeSecondaryPane }) => closeSecondaryPane()).catch(() => {});

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

// ── Pin tab ───────────────────────────────────────────────

export function pinTab(index) {
    if (index >= 0 && index < State.openTabs.length) {
        State.openTabs[index].isPreview = false;
        renderEditorTabs();
    }
}

// ── Tab display helpers ───────────────────────────────────

/** Return icon + label for a tab based on its type. */
function _tabDisplay(tab) {
    switch (tab.type) {
        case 'issue': {
            const title = tab.issueData?.title || '';
            const short = title.length > 28 ? title.slice(0, 26) + '…' : title;
            return { icon: '🔖', label: `#${tab.issueNumber}` + (short ? `: ${short}` : '') };
        }
        case 'plugin-editor': {
            const name = tab.pluginName || 'New Plugin';
            const short = name.length > 28 ? name.slice(0, 26) + '…' : name;
            return { icon: '🧩', label: short };
        }
        default:
            return { icon: '', label: tab.path ? tab.path.split('/').pop() : 'Untitled' };
    }
}

// ── Render tabs bar ───────────────────────────────────────

export function renderEditorTabs() {
    const tabsContainer = document.getElementById('editorTabs');

    if (State.openTabs.length === 0) {
        tabsContainer.innerHTML = `
            <div class="editor-tab active" role="tab" aria-selected="true" tabindex="0">
                <span class="tab-name">Welcome</span>
            </div>
        `;
        return;
    }

    tabsContainer.innerHTML = State.openTabs.map((tab, index) => {
        const isActive = index === State.activeTabIndex;
        const tabType = tab.type || 'file';
        const previewClass = tab.isPreview ? 'preview' : '';
        const activeClass = isActive ? 'active' : '';
        const typeClass = tabType !== 'file' ? `tab-${tabType}` : '';
        const { icon, label } = _tabDisplay(tab);
        const showDirty = (tabType === 'file' || tabType === 'plugin-editor') && tab.dirty;

        return `
            <div class="editor-tab ${activeClass} ${previewClass} ${typeClass}"
                 role="tab"
                 tabindex="${isActive ? '0' : '-1'}"
                 aria-selected="${isActive}"
                 aria-label="${escapeAttr(label)}${showDirty ? ', modified' : ''}${tab.isPreview ? ', preview' : ''}"
                 data-action="switchToTab" data-index="${index}"
                 ondblclick="window.pinTab(${index})"
                 title="${escapeAttr(label)}">
                ${icon ? `<span class="tab-icon" aria-hidden="true">${icon}</span>` : ''}
                <span class="tab-name">${escapeHtml(label)}</span>
                <span class="modified" aria-hidden="true" style="display: ${showDirty ? 'inline' : 'none'}">●</span>
                <button class="close" data-action="closeTab" data-index="${index}" title="Close" aria-label="Close ${escapeAttr(label)}">×</button>
            </div>
        `;
    }).join('');
}

/**
 * Bind a delegated click handler for editor tabs (switch + close). Phase 3a
 * of the inline-handlers migration (DESIGN-ui-event-dispatch.md).
 * Scoped to `#editorTabs` — `renderEditorTabs()` rewrites the bar's innerHTML
 * on every state change, so the document-level listener survives re-creation.
 *
 * The `ondblclick` pin-tab handler remains an inline handler — Phase 3
 * covers `onclick` only.
 */
let _wired = false;
export function mountTabManager({ onSwitchTab, onCloseTab } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#editorTabs')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'switchToTab' && typeof onSwitchTab === 'function') {
            onSwitchTab(Number(btn.getAttribute('data-index')));
        } else if (action === 'closeTab' && typeof onCloseTab === 'function') {
            onCloseTab(Number(btn.getAttribute('data-index')), e);
        }
    });
}

// ── Editor change listener ────────────────────────────────

export function initTabChangeListener() {
    EventBus.on('editor:change', () => {
        if (State.activeTabIndex >= 0 && State.activeTabIndex < State.openTabs.length) {
            const tab = State.openTabs[State.activeTabIndex];
            // Only track dirty state for file tabs
            if (!tab.type || tab.type === 'file') {
                tab.dirty = true;
                tab.content = State.editorContent;
                if (tab.isPreview) tab.isPreview = false;
                renderEditorTabs();
            }
        }
    });
}
