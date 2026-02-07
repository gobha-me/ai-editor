// ============================================
// MAIN APPLICATION
// ============================================

import { State, EventBus, loadSettings } from './core.js';
import { initChat, stopGeneration, clearChat } from './chat.js';
import { loadCodeMirror } from './editor.js';
import { ErrorLogger, openErrorLog, closeErrorLog, clearErrorLog, copyErrorLog, exportErrorLog } from './error-logger.js';
import { openLLMDebug, closeLLMDebug, clearLLMDebug, copyLLMDebug, exportLLMDebug, initLLMDebugAutoRefresh } from './llm-debug-modal.js';
import { QuickOpen, initQuickOpen } from './quick-open.js';
import { openSettings, closeSettings, saveSettings, fetchModelsForSettings } from './settings-manager.js';
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
    initCostTrackerListener
} from './model-manager.js';

// Import tool modules (loaded before chat.js to ensure registry is ready)
import './tools/registry.js';
import './tools/file-tools.js';
import './tools/edit-tools.js';
import './tools/project-tools.js';
import './tools/search-tools.js';
import './tools/issue-tools.js';
import './tools/scan-tools.js';  // NEW: Issue #32 efficient code navigation tools

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

window.revertCurrentFile = revertCurrentFile;

// ============================================
// VISUAL SETTINGS
// ============================================

function applyVisualSettings() {
    // Font sizes
    document.documentElement.style.setProperty('--ui-font-size', (State.settings.fontSize || 13) + 'px');
    document.documentElement.style.setProperty('--editor-font-size', (State.settings.editorFontSize || 14) + 'px');

    // Panel visibility
    const issuesSections = document.querySelectorAll('[data-collapse="issuesPanelBody"]');
    const workflowsSections = document.querySelectorAll('[data-collapse="workflowsPanelBody"]');
    
    issuesSections.forEach(el => {
        el.closest('.sidebar-section').style.display = State.settings.showIssues !== false ? '' : 'none';
    });
    workflowsSections.forEach(el => {
        el.closest('.sidebar-section').style.display = State.settings.showWorkflows !== false ? '' : 'none';
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
    const container = document.getElementById('editorContainer');
    if (State.settings.showLineNumbers !== false) {
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
            if (!document.getElementById('btnTogglePreview').disabled) {
                togglePreviewPane();
            }
        }

        // Ctrl+Shift+D - Toggle diff
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            if (!document.getElementById('btnToggleDiff').disabled) {
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
    // Header buttons
    document.getElementById('btnToggleSidebar').addEventListener('click', toggleSidebar);
    document.getElementById('btnCommit').addEventListener('click', openCommitModal);
    document.getElementById('btnRevert').addEventListener('click', revertCurrentFile);
    document.getElementById('btnSettings').addEventListener('click', openSettings);
    document.getElementById('btnErrorLog').addEventListener('click', openErrorLog);
    document.getElementById('btnLLMDebug').addEventListener('click', openLLMDebug);
    document.getElementById('btnToggleChat').addEventListener('click', toggleChat);

    // Sidebar buttons
    document.getElementById('btnRefreshProjects').addEventListener('click', refreshProjects);
    document.getElementById('btnNewBranch').addEventListener('click', openNewBranchModal);
    document.getElementById('btnNewFile').addEventListener('click', openNewFileModal);
    document.getElementById('btnRefreshIssues').addEventListener('click', refreshIssues);
    document.getElementById('btnRefreshWorkflows').addEventListener('click', refreshWorkflows);

    // Selectors
    document.getElementById('projectSelect').addEventListener('change', onProjectChange);
    document.getElementById('branchSelect').addEventListener('change', onBranchChange);
    document.getElementById('modelSelect').addEventListener('change', onModelChange);
    document.getElementById('roleSelect').addEventListener('change', onRoleChange);
    document.getElementById('btnResetCost').addEventListener('click', resetSessionCost);

    // Editor toolbar
    document.getElementById('btnToggleLineNumbers').addEventListener('click', toggleLineNumbers);
    document.getElementById('btnTogglePreview').addEventListener('click', togglePreviewPane);
    document.getElementById('btnToggleDiff').addEventListener('click', toggleDiffPane);

    // Chat
    document.getElementById('btnSend').addEventListener('click', () => {
        const input = document.getElementById('chatInput');
        if (input.value.trim()) {
            window.Chat.sendMessage(input.value.trim());
            input.value = '';
        }
    });
    document.getElementById('btnStop').addEventListener('click', stopGeneration);
    document.getElementById('btnFetchModels').addEventListener('click', fetchModels);
    document.getElementById('btnNewChat').addEventListener('click', () => {
        clearChat();
        resetSessionCost();
        showToast('Chat cleared', 'success');
    });
    document.getElementById('btnExportChat').addEventListener('click', () => {
        if (window.Chat && window.Chat.exportChat) {
            window.Chat.exportChat();
        }
    });

    // EventBus listeners
    EventBus.on('llm:generating', (isGenerating) => {
        document.getElementById('btnSend').style.display = isGenerating ? 'none' : 'block';
        document.getElementById('btnStop').style.display = isGenerating ? 'block' : 'none';
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
        if (State.settings.giteaUrl && State.settings.giteaToken) {
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
    console.log('Initializing AI Editor...');
    
    // Initialize error logger first
    ErrorLogger.init();
    
    // Load settings
    loadSettings();
    applyVisualSettings();
    applyLineNumbersVisibility();
    initSidebarCollapse();
    exposeLLMTools();
    populateRoleSelector();
    initCostTracker();
    
    // Initialize components
    initChat(
        document.getElementById('chatMessages'),
        document.getElementById('chatInput')
    );

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

    // Load projects if configured
    if (State.settings.giteaUrl && State.settings.giteaToken) {
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

    console.log('AI Editor initialized');
}

// Start the application
init();
