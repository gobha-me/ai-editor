// ============================================
// MAIN APPLICATION
// ============================================

import { VERSION_DISPLAY } from './version.js';
import { FaviconManager } from './favicon-manager.js';
import { buildAppLayout } from './template-loader.js';
import { State, EventBus, Storage, Plugins, loadSettings } from './core.js';
import { loadInstalledPlugins } from './plugin-loader.js';
import { initGitProviders, GitProviderRegistry } from './git.js';
import { initChat, stopGeneration, clearChat } from './chat/index.js';
import { loadCodeMirror, setLineNumbersVisible } from './editor.js';
import { ErrorLogger, openErrorLog, closeErrorLog, clearErrorLog, copyErrorLog, exportErrorLog } from './error-logger.js';
import { openLLMDebug, closeLLMDebug, clearLLMDebug, copyLLMDebug, exportLLMDebug, initLLMDebugAutoRefresh } from './llm-debug-modal.js';
import { QuickOpen, initQuickOpen } from './quick-open.js';
import { initSearchPanel, openSearchPanel, closeSearchPanel } from './search-panel.js';
import { openSettings, closeSettings, saveSettings, fetchModelsForSettings, fetchEmbeddingModelsForSettings } from './settings-manager.js';
import { switchToTab, closeTab, pinTab, renderEditorTabs, initTabChangeListener } from './tab-manager.js';
import { renderFileTree, handleTreeClick, onTreeItemClick, deleteFile } from './file-tree.js';
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
import { revertCurrentFile, closeRevertModal, revertAllFiles, revertOnlyCurrentFile } from './ui/revert.js';
import { 
    refreshProjects, 
    onProjectChange, 
    onBranchChange, 
    renderIssues, 
    refreshIssues, 
    renderPullRequests, 
    refreshPullRequests,
    initProjectListeners,
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

// Help modal
function openHelpModal() {
    document.getElementById('helpModal')?.classList.add('active');
}
function closeHelpModal() {
    document.getElementById('helpModal')?.classList.remove('active');
}
window.openHelpModal = openHelpModal;
window.closeHelpModal = closeHelpModal;

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

        const toggle = () => {
            const isCollapsed = body.classList.toggle('collapsed');
            header.setAttribute('aria-expanded', String(!isCollapsed));
            const label = header.querySelector('span');
            if (label) {
                const text = label.textContent.replace(/^[▾▸]\s*/, '');
                label.textContent = (isCollapsed ? '▸ ' : '▾ ') + text;
            }
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
 * Initialize the plugin toolbar dropdown.
 * Shows/hides based on whether any plugins have registered buttons.
 */
function initPluginToolbar() {
    const toolbar = document.getElementById('pluginToolbar');
    const btn = document.getElementById('btnPluginMenu');
    const dropdown = document.getElementById('pluginDropdown');
    if (!toolbar || !btn || !dropdown) return;

    function render() {
        const buttons = Plugins.getButtons();
        if (buttons.length === 0) {
            toolbar.style.display = 'none';
            return;
        }

        toolbar.style.display = '';
        dropdown.innerHTML = buttons.map((b, i) => `
            <button class="plugin-dropdown-item" data-plugin-btn-idx="${i}">
                <span class="plugin-btn-icon">${b.icon || '⚡'}</span>
                <span>${b.label || 'Action'}</span>
            </button>
        `).join('');

        dropdown.querySelectorAll('[data-plugin-btn-idx]').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.pluginBtnIdx);
                if (buttons[idx]?.onClick) buttons[idx].onClick();
                dropdown.style.display = 'none';
            });
        });
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = dropdown.style.display !== 'none';
        dropdown.style.display = isVisible ? 'none' : '';
    });

    // Close on outside click
    document.addEventListener('click', () => {
        dropdown.style.display = 'none';
    });

    // Re-render when plugins change
    EventBus.on('plugin:buttonRegistered', render);
    EventBus.on('plugin:enabledChanged', render);

    render();
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

    // Header buttons
    safeAdd('btnToggleSidebar', 'click', toggleSidebar);
    safeAdd('btnCommit', 'click', openCommitModal);
    safeAdd('btnRevert', 'click', revertCurrentFile);
    safeAdd('btnSettings', 'click', openSettings);
    safeAdd('btnErrorLog', 'click', openErrorLog);
    safeAdd('btnLLMDebug', 'click', openLLMDebug);
    safeAdd('btnToggleChat', 'click', toggleChat);
    safeAdd('btnHelp', 'click', openHelpModal);

    // Sidebar buttons
    safeAdd('btnRefreshProjects', 'click', refreshProjects);
    safeAdd('btnClearProject', 'click', clearProject);
    safeAdd('btnNewBranch', 'click', openNewBranchModal);
    safeAdd('btnNewFile', 'click', openNewFileModal);
    safeAdd('btnRefreshIssues', 'click', refreshIssues);
    safeAdd('btnRefreshPRs', 'click', refreshPullRequests);

    // Issue focus bar
    safeAdd('btnIssueFocusDismiss', 'click', unfocusIssue);
    safeAdd('btnIssueFocusExpand', 'click', () => {
        if (State.focusedIssue) openIssueDetailModal(State.focusedIssue.number);
    });
    // Accept/Deny/Comment/Work wired via EventBus from project-manager

    // Selectors
    safeAdd('projectSelect', 'change', onProjectChange);
    safeAdd('branchSelect', 'change', onBranchChange);
    safeAdd('modelSelect', 'change', onModelChange);
    safeAdd('roleSelect', 'change', onRoleChange);
    safeAdd('btnResetCost', 'click', resetSessionCost);

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
        showToast('Chat cleared', 'success');
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
    initSessionListeners();

    // Load projects if any connections configured
    if (GitProviderRegistry.listConnections(true).length > 0) {
        await refreshProjects();
        // Restore previous session (project + branch + tabs)
        await restoreSession();
    }

    // Load models if configured
    if (State.settings.llmEndpoint && State.settings.llmApiKey) {
        await fetchModels();
    }

    // Pre-load CodeMirror
    await loadCodeMirror();
    
    // Initialize quick open and search panel (DOM is ready after buildAppLayout)
    initQuickOpen();
    initSearchPanel();
    initZipDragDrop();
    initAccessibility();
    initOfflineIndicator();

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

    // Initialize built-in plugins
    initPluginToolbar();
    for (const plugin of Plugins.list()) {
        await Plugins.init(plugin.id);
    }

    // Load externally installed plugins (from URLs saved in storage)
    const extResult = await loadInstalledPlugins();
    if (extResult.loaded > 0 || extResult.failed > 0) {
        console.log(`[plugins] External: ${extResult.loaded} loaded, ${extResult.failed} failed`);
        // Re-render toolbar in case new plugins added buttons
        initPluginToolbar();
    }

    console.log(`✓ ${VERSION_DISPLAY} initialized`);
}

// Start the application
init();
