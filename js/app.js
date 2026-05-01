// ============================================
// MAIN APPLICATION
// ============================================

import { VERSION_DISPLAY } from './version.js';
import { FaviconManager } from './favicon-manager.js';
import { buildAppLayout } from './template-loader.js';
import { State, EventBus, Storage, Plugins, loadSettings } from './core.js';
import { loadInstalledPlugins } from './plugin-loader.js';
import { loadUserPlugins } from './plugin-editor.js';
import { checkOnboarding } from './onboarding.js';
import { openMarkdownModal, closeMarkdownModal } from './markdown-modal.js';
import { initMobile } from './mobile.js';
import { initGitProviders, GitProviderRegistry, Git } from './git.js';
import { IgnoreManager } from './ignore.js';
import { initChat, stopGeneration, clearChat } from './chat/index.js';
import { loadCodeMirror, setLineNumbersVisible, setKeybindingMode, setInvisibleUnicodeEnabled } from './editor.js';
import { ErrorLogger, openErrorLog, closeErrorLog, clearErrorLog, copyErrorLog, exportErrorLog } from './error-logger.js';
import { escapeHtml } from './utils/html.js';
import { openLLMDebug, closeLLMDebug, clearLLMDebug, copyLLMDebug, exportLLMDebug, initLLMDebugAutoRefresh } from './llm-debug-modal.js';
import { QuickOpen, initQuickOpen } from './quick-open.js';
import { initSearchPanel, openSearchPanel, closeSearchPanel } from './search-panel.js';
import { openSettings, closeSettings, saveSettings, fetchModelsForSettings, fetchEmbeddingModelsForSettings } from './settings-manager.js';
import { switchToTab, closeTab, pinTab, renderEditorTabs, initTabChangeListener } from './tab-manager.js';
import { renderFileTree, handleTreeClick, onTreeItemClick, deleteFile, deleteFolder } from './file-tree.js';
import { togglePreviewPane, toggleDiffPane, toggleBlamePane, closeSecondaryPane, toggleSecondaryFullscreen, updateToolbarButtons, initSecondaryPaneAutoRefresh } from './secondary-pane.js';
import { 
    toggleSidebar, 
    toggleChat, 
    updateStatusBar, 
    showToast, 
    closeAllModals,
    updateCommitButton,
    updateRevertButton,
    clearAllDrafts,
    clearProjectDrafts,
    initStatusBarListener
} from './ui-helpers.js';
import { openCommitModal, closeCommitModal, generateCommitMsg, commitAndPush } from './ui/commit.js';
import { openNewBranchModal, closeNewBranchModal, createNewBranch } from './ui/branch.js';
import { openNewFileModal, closeNewFileModal, createNewFile } from './ui/file-create.js';
import { openRenameModal, closeRenameModal, submitRename } from './ui/file-rename.js';
import { revertCurrentFile, closeRevertModal, revertAllFiles, revertOnlyCurrentFile } from './ui/revert.js';
import { openReleaseModal, closeReleaseModal, generateReleaseNotes, createRelease as createGitRelease } from './release-manager.js';
import { 
    refreshProjects, 
    onProjectChange,
    onBranchChange, 
    renderIssues, 
    refreshIssues, 
    renderPullRequests, 
    refreshPullRequests,
    initProjectListeners,
    openIssueTab,
    openIssueDetailModal,
    closeIssueDetailModal,
    openCreatePRModal,
    closeCreatePRModal,
    submitCreatePR,
    openPRDetailModal,
    closePRDetailModal,
    submitMergePR,
    generatePRComment,
    submitPRComment,
    focusIssue,
    unfocusIssue,
    startWorkOnIssue,
    clearProject,
    restoreSession,
    initSessionListeners
} from './project-manager.js';
import { 
    fetchModels, 
    onModelChange, 
    updateModelStatusBar, 
    populateRoleSelector, 
    onRoleChange,
    initCostTracker,
    resetSessionCost,
    initCostTrackerListener,
    fetchProviderBalance
} from './model-manager.js';
import { initPanelResize } from './resize-manager.js';
import { initAccessibility, announce } from './accessibility.js';
import { initOfflineIndicator } from './offline-indicator.js';
import { initIndexIndicator } from './index-indicator.js';
import { initCostRecorder } from './intelligence/cost/index.js';
import {
    installFileLayer as installMemoryFileLayer,
    getPendingContent as memoryGetPendingContent,
    listPendingPaths as memoryListPendingPaths,
    getDiagnostics as memoryGetDiagnostics,
    isEnabled as memoryFileLayerIsEnabled,
    getActiveWorkspaceId as memoryFileLayerWorkspaceId,
    consentClearAll as memoryConsentClearAll,
} from './intelligence/memory/index.js';
import {
    installSessionsSync,
    getPendingContent as sessionsGetPendingContent,
    listPendingPaths as sessionsListPendingPaths,
    getDiagnostics as sessionsGetDiagnostics,
    isEnabled as sessionsIsEnabled,
    getActiveWorkspaceId as sessionsActiveWorkspaceId,
} from './chat/sessions-sync.js';
import { installReplay } from './chat/replay.js';
import { 
    openZipUpload, closeZipUpload, 
    handleZipFileSelect, zipToggleFile, zipSelectAll, scanForDiffs,
    uploadExtractedFiles, initZipDragDrop
} from './zip-upload.js';

// Import tool modules (loaded before chat.js to ensure registry is ready)
import './tools/registry.js';
import './tools/file-tools.js';
import './tools/edit-tools.js';
import './tools/project-tools.js';
import './tools/search-tools.js';
import './tools/issue-tools.js';
import './tools/pr-tools.js';        // PR/MR management tools
import './tools/scratchpad-tools.js'; // LLM persistent notes
import './tools/scan-tools.js';     // Issue #32: Efficient code navigation tools
import './tools/context-tools.js';  // Issue #40: Embeddings-based context management
import './tools/commit-tools.js';   // LLM-driven commit from chat

// --- Plugins ---
import '../plugins/venice-ai.js';
import '../plugins/cross-repo-issues.js';
import '../plugins/release-sync.js';
import '../plugins/venice-billing.js';
import '../plugins/openrouter-billing.js';

// Log version on startup
console.log(`Starting ${VERSION_DISPLAY}`);

// ============================================
// EXPOSE WINDOW FUNCTIONS
// ============================================

window.ErrorLogger = ErrorLogger;
window.openErrorLog = openErrorLog;
window.closeErrorLog = closeErrorLog;
window.clearErrorLog = clearErrorLog;
window.copyErrorLog = copyErrorLog;
window.exportErrorLog = exportErrorLog;

window.openLLMDebug = openLLMDebug;
window.closeLLMDebug = closeLLMDebug;
window.clearLLMDebug = clearLLMDebug;
window.copyLLMDebug = copyLLMDebug;
window.exportLLMDebug = exportLLMDebug;

window.QuickOpen = QuickOpen;

// Dev-mode flag: ?debug=metadata enables the chat-history metadata-coverage
// probe (see js/chat/metadata-probe.js, docs/ROADMAP.md §1.1.0). Read-only;
// the flag is global so it can be inspected from the DevTools console.
{
    const dbg = new URLSearchParams(window.location.search).get('debug') || '';
    window.__AIE_DEBUG_METADATA = dbg.split(',').map(s => s.trim()).includes('metadata');
}

// Help modal
function openHelpModal() {
    document.getElementById('helpModal')?.classList.add('active');
}
function closeHelpModal() {
    document.getElementById('helpModal')?.classList.remove('active');
}

// Help tabs — switch tab and lazy-load markdown docs
const _helpDocCache = {};

function initHelpTabs() {
    const tabBar = document.getElementById('helpTabs');
    if (!tabBar) return;

    tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-help-tab]');
        if (!btn) return;

        const tabId = btn.dataset.helpTab;

        // Switch active tab button
        tabBar.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');

        // Switch active content
        const modal = document.getElementById('helpModal');
        modal.querySelectorAll('.help-tab-content').forEach(c => c.classList.remove('active'));
        const panel = document.getElementById(`helpTab-${tabId}`);
        if (panel) {
            panel.classList.add('active');
            // Lazy-load doc if this tab has a data-doc attribute
            const docPath = panel.dataset.doc;
            if (docPath && !panel.dataset.loaded) {
                _loadHelpDoc(panel, docPath);
            }
        }
    });

    // Arrow visibility on scroll
    tabBar.addEventListener('scroll', _updateHelpTabArrows);
    // Check on open too
    const observer = new MutationObserver(() => {
        if (document.getElementById('helpModal')?.classList.contains('active')) {
            _updateHelpTabArrows();
        }
    });
    observer.observe(document.getElementById('helpModal'), { attributes: true, attributeFilter: ['class'] });
}

function _updateHelpTabArrows() {
    const container = document.getElementById('helpTabs');
    if (!container) return;
    const nav = container.closest('.settings-tabs-nav');
    if (!nav) return;

    const leftBtn = nav.querySelector('.settings-tabs-arrow-left');
    const rightBtn = nav.querySelector('.settings-tabs-arrow-right');
    if (!leftBtn || !rightBtn) return;

    leftBtn.classList.toggle('visible', container.scrollLeft > 1);
    rightBtn.classList.toggle('visible', container.scrollLeft < (container.scrollWidth - container.clientWidth - 1));
}

window.scrollHelpTabs = function(direction) {
    const container = document.getElementById('helpTabs');
    if (!container) return;
    const step = container.clientWidth * 0.6;
    container.scrollBy({ left: direction * step, behavior: 'smooth' });
    setTimeout(_updateHelpTabArrows, 350);
};

async function _loadHelpDoc(panel, docPath) {
    // Check cache first
    if (_helpDocCache[docPath]) {
        panel.innerHTML = `<div class="help-doc-content">${_helpDocCache[docPath]}</div>`;
        panel.dataset.loaded = '1';
        return;
    }

    panel.innerHTML = '<div class="help-doc-loading">Loading documentation…</div>';

    try {
        // Fetch relative — <base href> injected by entrypoint handles sub-path resolution
        const resp = await fetch(docPath);
        if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);

        // Guard: if nginx returns index.html as SPA fallback (docs not in image),
        // the Content-Type will be text/html instead of text/plain or text/markdown
        const ct = resp.headers.get('content-type') || '';
        const md = await resp.text();
        if (ct.includes('text/html') || md.trimStart().startsWith('<!') || md.trimStart().startsWith('<html')) {
            throw new Error('Doc file not found — rebuild the Docker image to include docs/');
        }

        // Render markdown (marked.js is always available — bundled in vendor)
        let html;
        if (typeof marked !== 'undefined') {
            html = DOMPurify.sanitize(marked.parse(md, { breaks: true, gfm: true }));
        } else {
            // Fallback: preformatted text
            html = `<pre>${md.replace(/</g, '&lt;')}</pre>`;
        }

        _helpDocCache[docPath] = html;
        panel.innerHTML = `<div class="help-doc-content">${html}</div>`;
        panel.dataset.loaded = '1';
    } catch (err) {
        console.warn(`[Help] Failed to load ${docPath}:`, err.message);
        panel.innerHTML = `<div class="help-doc-error">Could not load ${escapeHtml(docPath)}<br><small>${escapeHtml(err.message)}</small></div>`;
    }
}

// Expose for window + export for read_docs tool
window._helpDocCache = _helpDocCache;
window._loadHelpDoc = _loadHelpDoc;

window.openHelpModal = openHelpModal;
window.closeHelpModal = closeHelpModal;

window.openMarkdownModal = openMarkdownModal;
window.closeMarkdownModal = closeMarkdownModal;

window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.saveSettings = saveSettings;
window.fetchModelsForSettings = fetchModelsForSettings;
window.fetchEmbeddingModelsForSettings = fetchEmbeddingModelsForSettings;

window.switchToTab = switchToTab;
window.closeTab = closeTab;
window.pinTab = pinTab;

window.handleTreeClick = handleTreeClick;
window.onTreeItemClick = onTreeItemClick;
window.deleteFile = deleteFile;
window.deleteFolder = deleteFolder;

window.closeSecondaryPane = closeSecondaryPane;
window.toggleSecondaryFullscreen = toggleSecondaryFullscreen;

window.showToast = showToast;
window.openCommitModal = openCommitModal;
window.closeCommitModal = closeCommitModal;
window.generateCommitMsg = generateCommitMsg;
window.commitAndPush = commitAndPush;

window.openNewBranchModal = openNewBranchModal;
window.closeNewBranchModal = closeNewBranchModal;
window.createNewBranch = createNewBranch;

window.openIssueTab = openIssueTab;
window.openIssueDetailModal = openIssueDetailModal;
window.focusIssue = focusIssue;
window.unfocusIssue = unfocusIssue;
window.closeIssueDetailModal = closeIssueDetailModal;
window.openCreatePRModal = openCreatePRModal;
window.closeCreatePRModal = closeCreatePRModal;
window.submitCreatePR = submitCreatePR;
window.openPRDetailModal = openPRDetailModal;
window.closePRDetailModal = closePRDetailModal;
window.submitMergePR = submitMergePR;
window.generatePRComment = generatePRComment;
window.submitPRComment = submitPRComment;

window.openNewFileModal = openNewFileModal;
window.closeNewFileModal = closeNewFileModal;

window.openRenameModal = openRenameModal;
window.closeRenameModal = closeRenameModal;
window.submitRename = submitRename;

// Plugin modal
window.openPluginModal = openPluginModal;
window.closePluginModal = closePluginModal;
window.createNewFile = createNewFile;

// Revert functions
window.revertCurrentFile = revertCurrentFile;
window.closeRevertModal = closeRevertModal;
window.revertAllFiles = revertAllFiles;
window.revertOnlyCurrentFile = revertOnlyCurrentFile;

// Zip upload functions
window.openZipUpload = openZipUpload;
window.closeZipUpload = closeZipUpload;
window.handleZipFileSelect = handleZipFileSelect;
window.zipToggleFile = zipToggleFile;
window.zipSelectAll = zipSelectAll;
window.scanForDiffs = scanForDiffs;
window.uploadExtractedFiles = uploadExtractedFiles;

// Draft management functions
window.clearAllDrafts = clearAllDrafts;
window.clearProjectDrafts = clearProjectDrafts;

// ============================================
// VISUAL SETTINGS
// ============================================

function applyVisualSettings() {
    // Theme — swap the active theme stylesheet to match persisted setting.
    // Must run before any font/panel calculations so theme-driven font
    // stacks resolve correctly. Imported lazily to avoid a circular dep
    // on settings-manager.js during early app boot.
    import('./settings-manager.js').then(({ applyTheme }) => {
        applyTheme(State.settings.theme || 'refined');
    });

    // Font sizes
    document.documentElement.style.setProperty('--ui-font-size', (State.settings.fontSize || 13) + 'px');
    document.documentElement.style.setProperty('--chat-font-size', (State.settings.chatFontSize || 13) + 'px');
    document.documentElement.style.setProperty('--editor-font-size', (State.settings.editorFontSize || 14) + 'px');

    // Panel visibility - with null checks
    const issuesSections = document.querySelectorAll('[data-collapse="issuesPanelBody"]');
    const prsSections = document.querySelectorAll('[data-collapse="prsPanelBody"]');
    
    issuesSections.forEach(el => {
        const section = el.closest('.sidebar-section');
        if (section) {
            section.style.display = State.settings.showIssues !== false ? '' : 'none';
        }
    });
    prsSections.forEach(el => {
        const section = el.closest('.sidebar-section');
        if (section) {
            section.style.display = State.settings.showPullRequests !== false ? '' : 'none';
        }
    });
}

// ============================================
// LINE NUMBERS TOGGLE
// ============================================

function toggleLineNumbers() {
    State.settings.showLineNumbers = !(State.settings.showLineNumbers !== false);
    Storage.set('settings', State.settings);
    applyLineNumbersVisibility();
    updateToolbarButtons();
    showToast(State.settings.showLineNumbers ? 'Line numbers shown' : 'Line numbers hidden', 'success');
}

function applyLineNumbersVisibility() {
    const show = State.settings.showLineNumbers !== false;
    
    // Primary: CM6 compartment-based toggle (works reliably with CM6 layout system)
    setLineNumbersVisible(show);
    
    // Fallback: CSS class on container (in case compartment isn't ready yet)
    const container = document.getElementById('editorContainer');
    if (!container) return;
    
    if (show) {
        container.classList.remove('hide-line-numbers');
    } else {
        container.classList.add('hide-line-numbers');
    }
}

function initSidebarCollapse() {
    document.querySelectorAll('.sidebar-header-collapsible').forEach(header => {
        const targetId = header.dataset.collapse;
        const body = document.getElementById(targetId);
        if (!body) return;

        // Find parent resizable section
        const section = header.closest('.sidebar-section-resizable');

        const toggle = () => {
            const isCollapsed = body.classList.toggle('collapsed');
            header.setAttribute('aria-expanded', String(!isCollapsed));
            const label = header.querySelector('span');
            if (label) {
                const text = label.textContent.replace(/^[▾▸]\s*/, '');
                label.textContent = (isCollapsed ? '▸ ' : '▾ ') + text;
            }
            // When collapsed, remove flex-grow so section shrinks to header only
            if (section) {
                section.classList.toggle('section-collapsed', isCollapsed);
                // Clear any inline flex overrides from drag resize
                if (isCollapsed) {
                    section.style.flexBasis = '';
                    section.style.flexGrow = '';
                }
            }
            // Reflow: let expanded sections reclaim space & hide orphan handles
            _reflowSidebarSections();
        };

        header.addEventListener('click', toggle);

        // Keyboard: Enter/Space toggles, same as a button
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    });
}

/**
 * After collapse/expand, redistribute flex space and hide resize handles
 * adjacent to collapsed sections so expanded sections fill available space.
 */
function _reflowSidebarSections() {
    const container = document.getElementById('sidebarSections');
    if (!container) return;

    const sections = container.querySelectorAll('.sidebar-section-resizable');
    const handles = container.querySelectorAll('.sidebar-resize-handle');

    // Count expanded sections
    const expanded = [...sections].filter(s => !s.classList.contains('section-collapsed'));

    // Reset expanded sections to equal flex if their inline styles were cleared
    expanded.forEach(s => {
        if (!s.style.flexBasis) {
            s.style.flexGrow = '';  // let CSS flex rule take over
        }
    });

    // If only one section is expanded, let it take all space
    if (expanded.length === 1) {
        expanded[0].style.flexGrow = '1';
        expanded[0].style.flexBasis = '';
    }

    // Hide handles where either neighbor is collapsed
    handles.forEach(h => {
        const aboveEl = document.getElementById(h.dataset.above);
        const belowEl = document.getElementById(h.dataset.below);
        const hide = aboveEl?.classList.contains('section-collapsed') ||
                     belowEl?.classList.contains('section-collapsed');
        h.style.display = hide ? 'none' : '';
    });
}

/**
 * Sidebar vertical section resize.
 * Drag handles between Files ↔ Issues ↔ PRs to redistribute vertical space.
 */
function initSidebarSectionResize() {
    const handles = document.querySelectorAll('.sidebar-resize-handle');
    if (!handles.length) return;

    handles.forEach(handle => {
        const aboveId = handle.dataset.above;
        const belowId = handle.dataset.below;
        const aboveEl = document.getElementById(aboveId);
        const belowEl = document.getElementById(belowId);
        if (!aboveEl || !belowEl) return;

        let startY = 0;
        let startAboveH = 0;
        let startBelowH = 0;

        const onMouseMove = (e) => {
            e.preventDefault();
            const delta = e.clientY - startY;
            const newAbove = Math.max(32, startAboveH + delta);   // min = header height
            const newBelow = Math.max(32, startBelowH - delta);
            aboveEl.style.flexBasis = newAbove + 'px';
            aboveEl.style.flexGrow = '0';
            belowEl.style.flexBasis = newBelow + 'px';
            belowEl.style.flexGrow = '0';
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            // Save proportions
            const saved = {};
            document.querySelectorAll('.sidebar-section-resizable').forEach(s => {
                const key = s.dataset.section;
                if (key && s.style.flexBasis) {
                    saved[key] = s.style.flexBasis;
                }
            });
            Storage.set('sidebarSectionSizes', saved);
        };

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startAboveH = aboveEl.getBoundingClientRect().height;
            startBelowH = belowEl.getBoundingClientRect().height;
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });

    // Restore saved sizes
    const saved = Storage.get('sidebarSectionSizes');
    if (saved) {
        Object.entries(saved).forEach(([key, basis]) => {
            const el = document.querySelector(`.sidebar-section-resizable[data-section="${key}"]`);
            if (el) {
                el.style.flexBasis = basis;
                el.style.flexGrow = '0';
            }
        });
    }
}

// Expose LLMTools reference for role tool list display
function exposeLLMTools() {
    import('./llm.js').then(mod => {
        window._LLMTools = mod.LLMTools;
    }).catch(() => {
        // Fallback: already available through chat module
    });
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl+S - Open commit modal
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            const dirtyCount = State.openTabs.filter(t => t.dirty).length;
            if (dirtyCount > 0) {
                openCommitModal();
            }
        }

        // Ctrl+Shift+Z - Revert file to original
        if (e.ctrlKey && e.shiftKey && e.key === 'Z') {
            e.preventDefault();
            revertCurrentFile();
        }

        // Ctrl+, - Settings
        if (e.ctrlKey && e.key === ',') {
            e.preventDefault();
            openSettings();
        }

        // Ctrl+B - Toggle sidebar
        if (e.ctrlKey && e.key === 'b') {
            e.preventDefault();
            toggleSidebar();
        }

        // Ctrl+Shift+P - Toggle preview
        if (e.ctrlKey && e.shiftKey && e.key === 'P') {
            e.preventDefault();
            const btn = document.getElementById('btnTogglePreview');
            if (btn && !btn.disabled) {
                togglePreviewPane();
            }
        }

        // Ctrl+Shift+D - Toggle diff
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            const btn = document.getElementById('btnToggleDiff');
            if (btn && !btn.disabled) {
                toggleDiffPane();
            }
        }

        // Ctrl+Shift+B - Toggle blame
        if (e.ctrlKey && e.shiftKey && e.key === 'B') {
            e.preventDefault();
            const btn = document.getElementById('btnToggleBlame');
            if (btn && !btn.disabled) {
                toggleBlamePane();
            }
        }

        // Ctrl+Shift+L - Toggle line numbers
        if (e.ctrlKey && e.shiftKey && e.key === 'L') {
            e.preventDefault();
            toggleLineNumbers();
        }

        // Ctrl+P - Quick Open file finder
        if (e.ctrlKey && !e.shiftKey && e.key === 'p') {
            e.preventDefault();
            QuickOpen.open();
        }

        // Ctrl+K - Top-bar command surface
        // 1.3.6 Phase 1: aliases the Ctrl+P file finder. The palette accretes
        // commands and settings/help search in 1.3.7+; until then ⌘K and
        // Ctrl+P share a single overlay so muscle memory works either way.
        if (e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            QuickOpen.open();
        }

        // Ctrl+Shift+F - Project search
        if (e.ctrlKey && e.shiftKey && e.key === 'F') {
            e.preventDefault();
            openSearchPanel();
        }

        // Ctrl+J - Toggle chat panel
        if (e.ctrlKey && !e.shiftKey && e.key === 'j') {
            e.preventDefault();
            toggleChat();
        }

        // F1 - Keyboard shortcuts help
        if (e.key === 'F1') {
            e.preventDefault();
            openHelpModal();
        }

        // F2 - Rename current file
        if (e.key === 'F2' && !e.ctrlKey && !e.shiftKey) {
            if (State.currentFile && State.activeTabIndex >= 0) {
                e.preventDefault();
                openRenameModal(State.currentFile.path);
            }
        }

        // Ctrl+1 - Focus sidebar
        if (e.ctrlKey && !e.shiftKey && e.key === '1') {
            e.preventDefault();
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('hidden')) {
                const first = sidebar.querySelector('select, button, input, [tabindex]');
                if (first) first.focus();
            }
        }

        // Ctrl+2 - Focus editor
        if (e.ctrlKey && !e.shiftKey && e.key === '2') {
            e.preventDefault();
            const cm = document.querySelector('.cm-editor .cm-content');
            if (cm) cm.focus();
            else document.getElementById('editorContainer')?.focus();
        }

        // Ctrl+3 - Focus chat input
        if (e.ctrlKey && !e.shiftKey && e.key === '3') {
            e.preventDefault();
            document.getElementById('chatInput')?.focus();
        }

        // Escape - Close modals
        if (e.key === 'Escape') {
            // Close in priority order: search panel → quick open → modals
            const searchPanel = document.getElementById('searchPanel');
            if (searchPanel?.classList.contains('active')) {
                closeSearchPanel();
                return;
            }
            const quickOpen = document.getElementById('quickOpenOverlay');
            if (quickOpen?.classList.contains('active')) {
                QuickOpen.close();
                return;
            }
            closeAllModals();
        }
    });
}

// ============================================
// EVENT LISTENERS
// ============================================

// ============================================
// PLUGIN MODAL & TOOLBAR
// ============================================

function openPluginModal(modalId) {
    const overlay = document.getElementById('pluginModal');
    const def = Plugins.getModal(modalId);
    if (!overlay || !def) return;

    document.getElementById('pluginModalTitle').textContent = def.title || 'Plugin';
    const content = document.getElementById('pluginModalContent');
    if (def.width && content) {
        content.style.maxWidth = def.width;
    }

    const body = document.getElementById('pluginModalBody');
    body.innerHTML = '';

    if (def.render) {
        const result = def.render(body);
        if (typeof result === 'string') body.innerHTML = result;
    }

    overlay.classList.add('active');
}

function closePluginModal() {
    const overlay = document.getElementById('pluginModal');
    if (overlay) overlay.classList.remove('active');
}

/**
 * Initialize the top-bar Debug dropdown (1.3.6).
 *
 * Consolidates the prior `#btnErrorLog` + `#btnLLMDebug` icons into a
 * single 🐛 menu button. Bridge until §1.3.9 ships the full Debug
 * slide-out; the items here move into that surface as tabs.
 */
function initDebugMenu() {
    const btn = document.getElementById('btnDebugMenu');
    const dropdown = document.getElementById('tbDebugDropdown');
    if (!btn || !dropdown) return;

    const setOpen = (open) => {
        if (open) dropdown.removeAttribute('hidden');
        else dropdown.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', String(open));
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(dropdown.hasAttribute('hidden'));
    });
    document.addEventListener('click', () => setOpen(false));
    dropdown.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('tbDebugErrorLog')?.addEventListener('click', () => {
        setOpen(false);
        openErrorLog();
    });
    document.getElementById('tbDebugLLM')?.addEventListener('click', () => {
        setOpen(false);
        openLLMDebug();
    });
}

/**
 * Initialize the top-bar branch indicator (1.3.6).
 *
 * Renders the current branch name in `#tbBranchName`. Ahead/behind counts
 * (`#tbBranchCounts`) ship in §1.3.6.1 once provider compare endpoints land.
 */
function initBranchIndicator() {
    const wrap = document.getElementById('tbBranchIndicator');
    const nameEl = document.getElementById('tbBranchName');
    if (!wrap || !nameEl) return;

    const render = () => {
        const branch = State.currentBranch || (State.currentProject ? '—' : '—');
        nameEl.textContent = branch;
        wrap.disabled = !State.currentProject;
        wrap.title = State.currentProject
            ? `Branch: ${branch}`
            : 'No project loaded';
    };

    render();
    EventBus.on('project:loaded', render);
    EventBus.on('branches:refresh', render);
    // Branch picker is in the sidebar; mirror its change into the top bar.
    document.getElementById('branchSelect')?.addEventListener('change', () => {
        // onBranchChange runs first (async), but State.currentBranch is set
        // synchronously inside it before the await; render is safe immediately.
        setTimeout(render, 0);
    });
}

function setupEventListeners() {
    // Helper to safely add event listener
    const safeAdd = (id, event, handler) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(event, handler);
        } else {
            console.warn(`Element #${id} not found during event listener setup`);
        }
    };

    // Top-bar (1.3.6 Restructure)
    safeAdd('btnCommit', 'click', openCommitModal);
    safeAdd('btnRevert', 'click', revertCurrentFile);  // now in editor toolbar
    safeAdd('btnSettings', 'click', openSettings);
    safeAdd('btnHelp', 'click', openHelpModal);
    safeAdd('tbCmdK', 'click', () => QuickOpen.open());

    // Panel collapse buttons (inside panel headers)
    safeAdd('btnCollapseSidebar', 'click', toggleSidebar);
    safeAdd('btnCollapseChat', 'click', toggleChat);

    // Panel edge expand tabs (shown when panel is hidden)
    safeAdd('sidebarExpandTab', 'click', toggleSidebar);
    safeAdd('chatExpandTab', 'click', toggleChat);
    // Also support keyboard activation on edge tabs
    const edgeKeyHandler = (fn) => (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    };
    const sidebarTab = document.getElementById('sidebarExpandTab');
    const chatTab = document.getElementById('chatExpandTab');
    if (sidebarTab) sidebarTab.addEventListener('keydown', edgeKeyHandler(toggleSidebar));
    if (chatTab) chatTab.addEventListener('keydown', edgeKeyHandler(toggleChat));

    // Sidebar buttons
    safeAdd('btnRefreshProjects', 'click', refreshProjects);
    safeAdd('btnClearProject', 'click', clearProject);
    safeAdd('btnNewBranch', 'click', openNewBranchModal);
    safeAdd('btnDownloadZip', 'click', async () => {
        if (!State.currentProject) {
            showToast('No project loaded', 'warning');
            return;
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        const btn = document.getElementById('btnDownloadZip');
        try {
            if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
            showToast(`Downloading ${owner}/${repo} @ ${branch}…`, 'info');
            const blob = await Git.downloadArchive(owner, repo, branch);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${repo}-${branch}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showToast('Download started', 'success');
        } catch (err) {
            console.error('[Download] Archive failed:', err);
            showToast(`Download failed: ${err.message}`, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📥'; }
        }
    });
    safeAdd('btnRefreshFiles', 'click', () => {
        EventBus.emit('tree:refresh');
        EventBus.emit('branches:refresh');
        window.showToast('Refreshing files & branches…', 'info');
    });
    safeAdd('btnNewFile', 'click', openNewFileModal);
    safeAdd('btnRefreshIssues', 'click', refreshIssues);
    safeAdd('btnRefreshPRs', 'click', refreshPullRequests);

    // Issue focus bar
    safeAdd('btnIssueFocusDismiss', 'click', unfocusIssue);
    safeAdd('btnIssueFocusExpand', 'click', () => {
        if (State.focusedIssue) openIssueTab(State.focusedIssue.number, { pin: true });
    });
    // Accept/Deny/Comment/Work wired via EventBus from project-manager

    // Selectors
    safeAdd('projectSelect', 'change', onProjectChange);
    safeAdd('branchSelect', 'change', onBranchChange);
    safeAdd('modelSelect', 'change', onModelChange);
    safeAdd('roleSelect', 'change', onRoleChange);
    // Cost reset moves to the §1.3.9 Debug slide-out — until then expose on
    // window for power users / docs.
    window.resetSessionCost = resetSessionCost;

    // Editor toolbar
    safeAdd('btnToggleLineNumbers', 'click', toggleLineNumbers);
    safeAdd('btnTogglePreview', 'click', togglePreviewPane);
    safeAdd('btnToggleDiff', 'click', toggleDiffPane);
    safeAdd('btnToggleBlame', 'click', toggleBlamePane);

    // Chat
    safeAdd('btnSend', 'click', () => {
        const input = document.getElementById('chatInput');
        const text = input ? input.value.trim() : '';
        const hasImages = document.getElementById('imagePreviewStrip')?.style.display !== 'none'
            && document.getElementById('imagePreviewStrip')?.children.length > 0;
        if (text || hasImages) {
            window.Chat.sendMessage(text);
            if (input) input.value = '';
        }
    });
    safeAdd('btnStop', 'click', stopGeneration);
    safeAdd('btnFetchModels', 'click', fetchModels);
    safeAdd('btnNewChat', 'click', () => {
        clearChat();
        resetSessionCost();
        showToast('New conversation started', 'success');
    });
    safeAdd('btnExportChat', 'click', () => {
        if (window.Chat && window.Chat.exportChat) {
            window.Chat.exportChat();
        }
    });

    // EventBus listeners
    EventBus.on('llm:generating', (isGenerating) => {
        const btnSend = document.getElementById('btnSend');
        const btnStop = document.getElementById('btnStop');
        if (btnSend) btnSend.style.display = isGenerating ? 'none' : 'block';
        if (btnStop) btnStop.style.display = isGenerating ? 'block' : 'none';
    });
}

// ============================================
// SETTINGS SAVED HANDLER
// ============================================

function setupSettingsSavedListener() {
    window.addEventListener('settings:saved', () => {
        applyVisualSettings();
        applyLineNumbersVisibility();
        setKeybindingMode(State.settings.editorKeybindingMode || 'default');
        setInvisibleUnicodeEnabled(State.settings.editorScanInvisibleUnicode !== false);
        updateModelStatusBar();
        
        // Refresh data with new settings
        if (GitProviderRegistry.listConnections(true).length > 0) {
            refreshProjects();
        }
        if (State.settings.llmEndpoint && State.settings.llmApiKey) {
            fetchModels();
        }
    });
}

// ============================================
// INITIALIZATION
// ============================================

async function init() {
    console.log(`Initializing ${VERSION_DISPLAY}...`);
    
    // Initialize FaviconManager first (before templates load for error state support)
    FaviconManager.init();
    
    // **CRITICAL: Load templates FIRST before anything else**
    try {
        await buildAppLayout();
        console.log('✓ Templates loaded');
    } catch (error) {
        console.error('Failed to load application templates:', error);
        document.getElementById('app').innerHTML = `
            <div style="display: flex; align-items: center; justify-content: center; height: 100vh; color: #f88;">
                <div style="text-align: center;">
                    <h2 style="font-size: 24px; margin-bottom: 1rem;">⚠️ Template Load Error</h2>
                    <p>Failed to load application layout.</p>
                    <pre style="margin-top: 1rem; text-align: left; background: #222; padding: 1rem; border-radius: 4px; font-size: 11px;">${error.message}\n${error.stack}</pre>
                </div>
            </div>
        `;
        FaviconManager.setError();
        return;
    }
    
    // Initialize error logger
    ErrorLogger.init();
    
    // Initialize storage (IDB + migration) before loading settings
    await Storage.init();
    
    // Load settings
    loadSettings();
    initGitProviders();  // Must run after loadSettings — migrates legacy giteaUrl/giteaToken to connections[]
    IgnoreManager.init(); // Must run after loadSettings — reads ignorePatterns from State.settings
    applyVisualSettings();
    initPanelResize();
    
    
    // Initialize components
    populateRoleSelector();
    initCostTracker();
    
    // Initialize components
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    if (chatMessages && chatInput) {
        initChat(chatMessages, chatInput);
    } else {
        console.error('Chat elements not found');
    }

    // Setup event listeners
    setupEventListeners();
    setupKeyboardShortcuts();
    setupSettingsSavedListener();
    
    // Initialize module-specific listeners
    initTabChangeListener();
    initLLMDebugAutoRefresh();
    initSecondaryPaneAutoRefresh();
    initStatusBarListener();
    initProjectListeners();
    initCostTrackerListener();
    initCostRecorder();
    installMemoryFileLayer();
    installSessionsSync();
    installReplay();
    // Memory PR #6 — drop pending consent candidates when chat clears.
    // The conversational context that produced agent-proposed proposals is
    // gone; pending cards from a prior chat shouldn't restore on the new one.
    EventBus.on('chat:cleared', () => {
        try { memoryConsentClearAll(); } catch (e) {
            console.warn('[app] consent queue clear failed:', e);
        }
    });
    if (typeof window !== 'undefined' && window.AIEditor) {
        window.AIEditor.memoryFileLayer = {
            getPendingContent: memoryGetPendingContent,
            listPendingPaths: memoryListPendingPaths,
            getDiagnostics: memoryGetDiagnostics,
            isEnabled: memoryFileLayerIsEnabled,
            getActiveWorkspaceId: memoryFileLayerWorkspaceId,
        };
        window.AIEditor.sessionsSync = {
            getPendingContent: sessionsGetPendingContent,
            listPendingPaths: sessionsListPendingPaths,
            getDiagnostics: sessionsGetDiagnostics,
            isEnabled: sessionsIsEnabled,
            getActiveWorkspaceId: sessionsActiveWorkspaceId,
        };
    }
    initSessionListeners();
    initSidebarCollapse();
    initSidebarSectionResize();
    initHelpTabs();

    // ── Parallel init: git + LLM + editor load concurrently ──
    // Git provider outage must NOT block LLM or editor loading.

    const gitReady = (async () => {
        if (GitProviderRegistry.listConnections(true).length > 0) {
            try {
                await refreshProjects();
                await restoreSession();
            } catch (e) {
                console.warn('[Init] Git initialization failed (provider may be down):', e.message);
                window.showToast('Git provider unreachable — editor & chat still work', 'warning');
            }
        }
    })();

    const llmReady = (async () => {
        if (State.settings.llmEndpoint && State.settings.llmApiKey) {
            try {
                await fetchModels();
            } catch (e) {
                console.warn('[Init] LLM model fetch failed:', e.message);
            }
        }
    })();

    const editorReady = loadCodeMirror();

    // Wait for all three, but each is independent
    await Promise.allSettled([gitReady, llmReady, editorReady]);
    
    // Initialize quick open and search panel (DOM is ready after buildAppLayout)
    initQuickOpen();
    initSearchPanel();
    initZipDragDrop();
    initAccessibility();
    initOfflineIndicator();
    initIndexIndicator();
    initMobile();

    // Screen reader announcements for key state changes
    EventBus.on('file:opened', ({ path }) => {
        const name = path.split('/').pop();
        announce(`Opened ${name}`);
    });
    EventBus.on('tab:switched', ({ tab }) => {
        if (tab?.path) {
            const name = tab.path.split('/').pop();
            announce(`Tab: ${name}`);
        }
    });

    // Top-bar Debug menu + branch indicator (1.3.6)
    initDebugMenu();
    initBranchIndicator();

    // Initialize built-in plugins. Plugin-registered toolbar actions render
    // inside Settings → Plugins → Toolbar actions (1.3.6 — was a top-bar
    // dropdown pre-Restructure).
    for (const plugin of Plugins.list()) {
        await Plugins.init(plugin.id);
    }

    // Load externally installed plugins (from URLs saved in storage)
    const extResult = await loadInstalledPlugins();
    if (extResult.loaded > 0 || extResult.failed > 0) {
        console.log(`[plugins] External: ${extResult.loaded} loaded, ${extResult.failed} failed`);
    }

    // Load user-created plugins (from Storage, built with plugin editor)
    const userResult = await loadUserPlugins();
    if (userResult.loaded > 0 || userResult.failed > 0) {
        console.log(`[plugins] User-created: ${userResult.loaded} loaded, ${userResult.failed} failed`);
    }

    console.log(`✓ ${VERSION_DISPLAY} initialized`);

    // Show first-run onboarding if no connections/LLM configured
    checkOnboarding();
}

// Start the application
init();
