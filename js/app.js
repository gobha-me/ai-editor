// ============================================
// MAIN APPLICATION
// ============================================

import { VERSION_DISPLAY } from './version.js';
import { buildAppLayout } from './template-loader.js';
import { State, EventBus, Storage, loadSettings } from './core.js';
import { initGitProviders, GitProviderRegistry } from './git.js';
import { initChat, stopGeneration, clearChat } from './chat/index.js';
import { loadCodeMirror, setLineNumbersVisible } from './editor.js';
import { ErrorLogger, openErrorLog, closeErrorLog, clearErrorLog, copyErrorLog, exportErrorLog } from './error-logger.js';
import { openLLMDebug, closeLLMDebug, clearLLMDebug, copyLLMDebug, exportLLMDebug, initLLMDebugAutoRefresh } from './llm-debug-modal.js';
import { QuickOpen, initQuickOpen } from './quick-open.js';
import { openSettings, closeSettings, saveSettings, fetchModelsForSettings, fetchEmbeddingModelsForSettings } from './settings-manager.js';
import { switchToTab, closeTab, pinTab, renderEditorTabs, initTabChangeListener } from './tab-manager.js';
import { renderFileTree, handleTreeClick, onTreeItemClick, deleteFile } from './file-tree.js';
import { togglePreviewPane, toggleDiffPane, closeSecondaryPane, updateToolbarButtons, initSecondaryPaneAutoRefresh } from './secondary-pane.js';
import { 
    toggleSidebar, 
    toggleChat, 
    updateStatusBar, 
    showToast, 
    closeAllModals,
    openCommitModal,
    closeCommitModal,
    generateCommitMsg,
    commitAndPush,
    openNewBranchModal,
    closeNewBranchModal,
    createNewBranch,
    openNewFileModal,
    closeNewFileModal,
    createNewFile,
    updateCommitButton,
    updateRevertButton,
    revertCurrentFile,
    clearAllDrafts,
    clearProjectDrafts,
    closeRevertModal,
    revertAllFiles,
    revertOnlyCurrentFile,
    initStatusBarListener
} from './ui-helpers.js';
import { 
    refreshProjects, 
    onProjectChange, 
    onBranchChange, 
    renderIssues, 
    refreshIssues, 
    renderWorkflows, 
    refreshWorkflows,
    initProjectListeners
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

// Import tool modules (loaded before chat.js to ensure registry is ready)
import './tools/registry.js';
import './tools/file-tools.js';
import './tools/edit-tools.js';
import './tools/project-tools.js';
import './tools/search-tools.js';
import './tools/issue-tools.js';
import './tools/scan-tools.js';     // Issue #32: Efficient code navigation tools
import './tools/context-tools.js';  // Issue #40: Embeddings-based context management

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

window.showToast = showToast;
window.openCommitModal = openCommitModal;
window.closeCommitModal = closeCommitModal;
window.generateCommitMsg = generateCommitMsg;
window.commitAndPush = commitAndPush;

window.openNewBranchModal = openNewBranchModal;
window.closeNewBranchModal = closeNewBranchModal;
window.createNewBranch = createNewBranch;

window.openNewFileModal = openNewFileModal;
window.closeNewFileModal = closeNewFileModal;
window.createNewFile = createNewFile;

// Revert functions
window.revertCurrentFile = revertCurrentFile;
window.closeRevertModal = closeRevertModal;
window.revertAllFiles = revertAllFiles;
window.revertOnlyCurrentFile = revertOnlyCurrentFile;

// Draft management functions
window.clearAllDrafts = clearAllDrafts;
window.clearProjectDrafts = clearProjectDrafts;

// ============================================
// VISUAL SETTINGS
// ============================================

function applyVisualSettings() {
    // Font sizes
    document.documentElement.style.setProperty('--ui-font-size', (State.settings.fontSize || 13) + 'px');
    document.documentElement.style.setProperty('--editor-font-size', (State.settings.editorFontSize || 14) + 'px');

    // Panel visibility - with null checks
    const issuesSections = document.querySelectorAll('[data-collapse="issuesPanelBody"]');
    const workflowsSections = document.querySelectorAll('[data-collapse="workflowsPanelBody"]');
    
    issuesSections.forEach(el => {
        const section = el.closest('.sidebar-section');
        if (section) {
            section.style.display = State.settings.showIssues !== false ? '' : 'none';
        }
    });
    workflowsSections.forEach(el => {
        const section = el.closest('.sidebar-section');
        if (section) {
            section.style.display = State.settings.showWorkflows !== false ? '' : 'none';
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
        header.addEventListener('click', () => {
            const targetId = header.dataset.collapse;
            const body = document.getElementById(targetId);
            if (!body) return;

            const isCollapsed = body.classList.toggle('collapsed');
            const label = header.querySelector('span');
            if (label) {
                // Swap chevron
                const text = label.textContent.replace(/^[▾▸]\s*/, '');
                label.textContent = (isCollapsed ? '▸ ' : '▾ ') + text;
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

        // Escape - Close modals
        if (e.key === 'Escape') {
            closeAllModals();
        }
    });
}

// ============================================
// EVENT LISTENERS
// ============================================

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

    // Sidebar buttons
    safeAdd('btnRefreshProjects', 'click', refreshProjects);
    safeAdd('btnNewBranch', 'click', openNewBranchModal);
    safeAdd('btnNewFile', 'click', openNewFileModal);
    safeAdd('btnRefreshIssues', 'click', refreshIssues);
    safeAdd('btnRefreshWorkflows', 'click', refreshWorkflows);

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

    // Chat
    safeAdd('btnSend', 'click', () => {
        const input = document.getElementById('chatInput');
        if (input && input.value.trim()) {
            window.Chat.sendMessage(input.value.trim());
            input.value = '';
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
        return;
    }
    
    // Initialize error logger
    ErrorLogger.init();
    
    // Load settings
    loadSettings();
    initGitProviders();  // Must run after loadSettings — migrates legacy giteaUrl/giteaToken to connections[]
    applyVisualSettings();
    applyLineNumbersVisibility();
    initSidebarCollapse();
    exposeLLMTools();
    populateRoleSelector();
    initCostTracker();
    initPanelResize();
    
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

    // Load projects if any connections configured
    if (GitProviderRegistry.listConnections(true).length > 0) {
        await refreshProjects();
    }

    // Load models if configured
    if (State.settings.llmEndpoint && State.settings.llmApiKey) {
        await fetchModels();
    }

    // Pre-load CodeMirror
    await loadCodeMirror();
    
    // Initialize quick open on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initQuickOpen);
    } else {
        initQuickOpen();
    }

    console.log(`✓ ${VERSION_DISPLAY} initialized`);
}

// Start the application
init();
