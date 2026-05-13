// ============================================
// MAIN APPLICATION
// ============================================

import { VERSION_DISPLAY } from './version.js';
import { FaviconManager } from './favicon-manager.js';
import { buildAppLayout } from './template-loader.js';
import { State, EventBus, Storage, Plugins, loadSettings } from './core.js';
import { mountLeftPaneRail } from './ui/left-pane-rail.js';
import { mountNowStrip } from './ui/now-strip.js';
import { mountSwitcherMenu } from './projects/switcher-menu.js';
import { openPluginModal, closePluginModal, mountPluginModal } from './plugin-modal.js';
import { mountAppShellActions } from './ui/app-shell-actions.js';
import { loadInstalledPlugins } from './plugin-loader.js';
import { loadUserPlugins } from './plugin-editor.js';
import { checkOnboarding } from './onboarding.js';
import { openMarkdownModal, closeMarkdownModal } from './markdown-modal.js';
import { initMobile } from './mobile.js';
import { initGitProviders, GitProviderRegistry, Git } from './git.js';
import { SlotManager, applyProviderContributions } from './slot-manager.js';
import { IgnoreManager } from './ignore.js';
import { initProjectConventions } from './intelligence/project-conventions.js';
import { initChat, stopGeneration, clearChat } from './chat/index.js';
import { hydratePlanMode } from './chat/state.js';
import { mountChatMessages } from './chat/messages.js';
import { loadCodeMirror, setKeybindingMode, setInvisibleUnicodeEnabled } from './editor.js';
import { applyVisualSettings, applyLineNumbersVisibility } from './utils/apply-visual-settings.js';
import { ErrorLogger, openErrorLog, closeErrorLog, clearErrorLog, copyErrorLog, exportErrorLog } from './error-logger.js';
import { escapeHtml } from './utils/html.js';
import { openLLMDebug, closeLLMDebug, clearLLMDebug, copyLLMDebug, exportLLMDebug, initLLMDebugAutoRefresh } from './llm-debug-modal.js';
import { openPrReview, closePrReview, isPrReviewActive } from './pr-review/pr-review-mount.js';
import { closeMergeConflict, isMergeConflictActive } from './merge-conflict/merge-conflict-mount.js';
import { initDebugSlideOut, openDebugSlideOut, closeDebugSlideOut, copyDiagnosticBundle } from './debug-slideout.js';
import { initHelpSlideOut, openHelpSlideOut, closeHelpSlideOut } from './help/index.js';
import { QuickOpen, initQuickOpen } from './quick-open.js';
import { initSearchPanel, openSearchPanel, closeSearchPanel } from './search-panel.js';
import { openSettings, closeSettings, saveSettings, fetchModelsForSettings, fetchEmbeddingModelsForSettings, mountSettingsModal, exportSettings, importSettings } from './settings-manager.js';
import { switchToTab, closeTab, pinTab, renderEditorTabs, initTabChangeListener, mountTabManager } from './tab-manager.js';
import { renderFileTree, handleTreeClick, onTreeItemClick, deleteFile, deleteFolder, mountFileTree } from './file-tree.js';
import { setViewMode as diffSetViewMode, previousChange as diffPreviousChange, nextChange as diffNextChange, mountDiffViewer } from './diff-viewer.js';
import { mountIssueList } from './ui/issue-list.js';
import { mountPrList } from './ui/pr-list.js';
import { mountChatInput } from './chat/input.js';
import { togglePreviewPane, toggleDiffPane, toggleBlamePane, closeSecondaryPane, toggleSecondaryFullscreen, updateToolbarButtons, initSecondaryPaneAutoRefresh } from './secondary-pane.js';
import {
    toggleSidebar,
    toggleChat,
    updateStatusBar,
    showToast,
    closeAllModals,
    closeAllModalOverlays,
    updateCommitButton,
    updateRevertButton,
    clearAllDrafts,
    clearProjectDrafts,
    initStatusBarListener
} from './ui-helpers.js';
import { registerOverlay, closeTopmostOverlay } from './ui/modal-registry.js';
import { bindHotkey, dispatchHotkey } from './ui/hotkey-bindings.js';
import { bindClick, bindEvent, rewireUnboundElements } from './ui/dom-bindings.js';
import { forSlot } from './events/public-channels.js';
import { openCommitModal, closeCommitModal, generateCommitMsg, commitAndPush, mountCommitModal } from './ui/commit.js';
import { openNewBranchModal, closeNewBranchModal, createNewBranch, mountNewBranchModal } from './ui/branch.js';
import { openNewFileModal, closeNewFileModal, createNewFile, mountNewFileModal } from './ui/file-create.js';
import { openRenameModal, closeRenameModal, submitRename, mountRenameModal } from './ui/file-rename.js';
import { revertCurrentFile, closeRevertModal, revertAllFiles, revertOnlyCurrentFile, mountRevertModal } from './ui/revert.js';
import { openReleaseModal, closeReleaseModal, generateReleaseNotes, createRelease as createGitRelease, mountReleaseModal } from './release-manager.js';
import { mountIssueDetailModal, mountIssueTab } from './issue-detail.js';
import {
    refreshProjects,
    onProjectChange,
    onBranchChange,
    initProjectListeners,
    openIssueTab,
    openIssueDetailModal,
    closeIssueDetailModal,
    openCreatePRModal,
    closeCreatePRModal,
    submitCreatePR,
    mountCreatePRModal,
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
    installFileLayer as installWorkspaceSettingsFileLayer,
    getPendingContent as workspaceSettingsGetPendingContent,
    listPendingPaths as workspaceSettingsListPendingPaths,
    getDiagnostics as workspaceSettingsGetDiagnostics,
    isEnabled as workspaceSettingsIsEnabled,
    getActiveWorkspaceId as workspaceSettingsActiveWorkspaceId,
} from './intelligence/workspace-settings/index.js';
import { installTestLoopUi } from './intelligence/test-loop/ui.js';
import {
    installSessionsSync,
    getPendingContent as sessionsGetPendingContent,
    listPendingPaths as sessionsListPendingPaths,
    getDiagnostics as sessionsGetDiagnostics,
    isEnabled as sessionsIsEnabled,
    getActiveWorkspaceId as sessionsActiveWorkspaceId,
} from './chat/sessions-sync.js';
import {
    installReplay,
    mountReplayModal,
    openReplayModal,
    closeReplayModal,
    prev as replayPrev,
    next as replayNext,
} from './chat/replay.js';
import {
    openZipUpload, closeZipUpload,
    handleZipFileSelect, zipToggleFile, zipSelectAll, scanForDiffs,
    uploadExtractedFiles, initZipDragDrop, handleZipFile, isZipDrop,
    mountZipUpload,
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
import './tools/ci-tools.js';       // get_ci_status / wait_for_ci / get_ci_logs (1.4.5)
import './tools/git-log-tools.js';  // git_log — commit history inspection

// --- Plugins ---
import '../plugins/venice-ai.js';
import '../plugins/cross-repo-issues.js';
import '../plugins/release-sync.js';
import '../plugins/venice-billing.js';
import '../plugins/openrouter-billing.js';
import '../plugins/mcp-bridge.js';

// Log version on startup
console.log(`Starting ${VERSION_DISPLAY}`);

// ============================================
// EXPOSE WINDOW FUNCTIONS
// ============================================
//
// 2.32.0 (inline-handlers Phase 4): the bulk of this block was retired
// after Phases 1–3b moved every inline `onclick=` to delegated `data-action`
// dispatchers. What remains has a documented external consumer (plugin
// extension API, cross-module call sites, or a residual non-`onclick`
// inline handler — `ondblclick`, `onchange`, `onkeydown` — deliberately
// out of Phase 3's scope). Each entry below cites who relies on it; if
// the last consumer goes, the alias goes with it.
// See docs/DESIGN-html-inline-handlers-migration.md §Phase 4.

// Diagnostic console hooks — internal error path bridges window.ErrorLogger
// at js/chat/tools.js:11 (decoupled init).
window.ErrorLogger = ErrorLogger;

// Quick-open palette — kept as a DevTools probe surface (window.QuickOpen.open()).
window.QuickOpen = QuickOpen;

// Dev-mode flag: ?debug=metadata enables the chat-history metadata-coverage
// probe (see js/chat/metadata-probe.js, docs/ROADMAP.md §1.1.0). Read-only;
// the flag is global so it can be inspected from the DevTools console.
{
    const dbg = new URLSearchParams(window.location.search).get('debug') || '';
    window.__AIE_DEBUG_METADATA = dbg.split(',').map(s => s.trim()).includes('metadata');
}

// Help slide-out — 1.3.10. Replaces the legacy #helpModal modal.
// `js/help/index.js` sets `window.openHelpModal` / `window.closeHelpModal`
// as back-compat aliases so any inline `onclick=` references keep working.

// Settings entry points used by js/onboarding.js (openSettings) and
// js/settings/plugins-tab.js (closeSettings, called when plugin install
// flips to a fresh settings view).
window.openSettings = openSettings;
window.closeSettings = closeSettings;

// File-tree navigation — 11 external consumers in tools/, ui/, search-panel,
// project-manager, quick-open. Pinning a tab via inline ondblclick in
// js/tab-manager.js:208 still routes through window.pinTab (Phase 3 scope
// was onclick= only; ondblclick is deferred).
window.onTreeItemClick = onTreeItemClick;
window.pinTab = pinTab;

// Toast surface — 174 references across js/ + plugins/.
window.showToast = showToast;

// Commit modal entry point — js/editor/instance.js + js/ui/now-strip.js
// open it when the user stages a save outside the file tree.
window.openCommitModal = openCommitModal;

// Issue/PR surfaces — Phase 3 left onkeydown="…window.openIssueTab(…)" and
// onkeydown="…window.openPrReview(…)" in js/ui/issue-list.js + pr-list.js
// (Enter/Space keyboard activation; out of `onclick=` scope). Also
// openPrReview is called from js/project-manager.js:658.
window.openIssueTab = openIssueTab;
window.openPrReview = openPrReview;

// Create-PR entry point — js/ui/left-pane-rail.js header action.
window.openCreatePRModal = openCreatePRModal;

// Plugin modal — load-bearing extension API. Referenced by
// js/profiles/plugin-dev-v1.js (the documented contract) and three
// bundled plugins (venice-billing, openrouter-billing, release-sync).
window.openPluginModal = openPluginModal;

// Zip upload — switcher-menu + left-pane-rail open it; the modal's file
// input keeps an inline onchange="window.handleZipFileSelect(event)" and
// each per-file checkbox an inline onchange="window.zipToggleFile(...)"
// (both out of Phase 3 onclick= scope).
window.openZipUpload = openZipUpload;
window.handleZipFileSelect = handleZipFileSelect;
window.zipToggleFile = zipToggleFile;

// ============================================
// VISUAL SETTINGS — applyVisualSettings + applyLineNumbersVisibility live
// in js/utils/apply-visual-settings.js since 1.4.4 so the workspace-settings
// file layer can re-paint after merging .aieditor/settings.json overrides.
// ============================================

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

// Sidebar layout — Touch 3 Rail v2 (2.11.0). The legacy stacked
// `.sidebar-section-resizable` chassis (collapse-on-click headers + drag
// handles between Files / Issues / PRs) was retired with the rail
// conversion. The rail's mount + click delegation lives in
// `js/ui/left-pane-rail.js#mountLeftPaneRail()`, called from `init()` below.

// Expose LLMTools reference for role tool list display
function exposeLLMTools() {
    import('./llm.js').then(mod => {
        window._LLMTools = mod.LLMTools;
    }).catch(() => {
        // Fallback: already available through chat module
    });
}

// ============================================
// MODAL REGISTRY — 2.33.0
// ============================================

/**
 * Register the 5 core overlay surfaces with the ModalRegistry. Esc /
 * popstate dispatch through `closeTopmostOverlay` per
 * `js/ui/modal-registry.js`. Priorities mirror the pre-2.33.0 Esc-chain
 * order; the merge-conflict-above-pr-review stacking invariant lives in
 * the priority numbers (80 > 70).
 */
function registerCoreOverlays() {
    registerOverlay({
        id: 'searchPanel',
        priority: 100,
        poppable: false,
        isActive: () => !!document.getElementById('searchPanel')?.classList.contains('active'),
        close: () => closeSearchPanel(),
    });
    registerOverlay({
        id: 'quickOpen',
        priority: 90,
        poppable: false,
        isActive: () => !!document.getElementById('quickOpenOverlay')?.classList.contains('active'),
        close: () => QuickOpen.close(),
    });
    registerOverlay({
        id: 'mergeConflict',
        priority: 80,
        poppable: true,
        isActive: isMergeConflictActive,
        close: (opts) => closeMergeConflict(opts),
    });
    registerOverlay({
        id: 'prReview',
        priority: 70,
        poppable: true,
        isActive: isPrReviewActive,
        close: (opts) => closePrReview(opts),
    });
    registerOverlay({
        id: 'modalOverlays',
        priority: 50,
        poppable: false,
        isActive: () => !!document.querySelector('.modal-overlay.active'),
        close: () => closeAllModalOverlays(),
    });
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================

function setupKeyboardShortcuts() {
    // 2.36.0 — bindings driven by HOTKEYS in js/help/hotkey-registry.js
    // through the dispatcher in js/ui/hotkey-bindings.js. Combo
    // definitions live in HOTKEYS only; this file pairs ids with
    // handlers (+ optional enabled predicate). Adding a new
    // document-bound shortcut means: declare it in HOTKEYS with
    // documentBound: true, then add the bindHotkey call here. The
    // parity check in tests/test-hotkey-bindings.mjs fails CI if
    // either half is missing.

    bindHotkey({
        id: 'file.commit',
        handler: openCommitModal,
        enabled: () => State.openTabs.filter(t => t.dirty).length > 0,
    });
    bindHotkey({ id: 'file.revert', handler: revertCurrentFile });
    bindHotkey({ id: 'settings.open', handler: openSettings });
    bindHotkey({ id: 'sidebar.toggle', handler: toggleSidebar });
    bindHotkey({
        id: 'editor.preview',
        handler: togglePreviewPane,
        enabled: () => {
            const btn = document.getElementById('btnTogglePreview');
            return !!btn && !btn.disabled;
        },
    });
    bindHotkey({
        id: 'editor.diff',
        handler: toggleDiffPane,
        enabled: () => {
            const btn = document.getElementById('btnToggleDiff');
            return !!btn && !btn.disabled;
        },
    });
    bindHotkey({
        id: 'editor.blame',
        handler: toggleBlamePane,
        enabled: () => {
            const btn = document.getElementById('btnToggleBlame');
            return !!btn && !btn.disabled;
        },
    });
    bindHotkey({ id: 'editor.lineNumbers', handler: toggleLineNumbers });
    bindHotkey({ id: 'quickopen.open', handler: () => QuickOpen.open() });
    bindHotkey({ id: 'palette.open', handler: () => QuickOpen.open() });
    bindHotkey({ id: 'file.search', handler: openSearchPanel });
    bindHotkey({ id: 'chat.toggle', handler: toggleChat });
    bindHotkey({ id: 'help.open', handler: () => openHelpSlideOut() });
    // CodeMirror binds Cmd+/ / Ctrl+/ to "toggle line comment" inside
    // the editor; defer to it via the .cm-editor target guard.
    bindHotkey({
        id: 'help.openMod',
        handler: () => openHelpSlideOut(),
        enabled: (e) => !e.target?.closest?.('.cm-editor'),
    });
    bindHotkey({
        id: 'file.rename',
        handler: () => openRenameModal(State.currentFile.path),
        enabled: () => !!State.currentFile && State.activeTabIndex >= 0,
    });
    bindHotkey({
        id: 'focus.sidebar',
        handler: () => {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('hidden')) {
                const first = sidebar.querySelector('select, button, input, [tabindex]');
                if (first) first.focus();
            }
        },
    });
    bindHotkey({
        id: 'focus.editor',
        handler: () => {
            const cm = document.querySelector('.cm-editor .cm-content');
            if (cm) cm.focus();
            else document.getElementById('editorContainer')?.focus();
        },
    });
    bindHotkey({
        id: 'focus.chat',
        handler: () => document.getElementById('chatInput')?.focus(),
    });
    // Esc — close topmost overlay. Priority + stacking (merge-conflict
    // layers above pr-review) lives in js/ui/modal-registry.js, not as
    // a chain here.
    bindHotkey({ id: 'esc.close', handler: () => closeTopmostOverlay() });

    document.addEventListener('keydown', dispatchHotkey);

    // popstate: browser-back closes whichever poppable overlay is on
    // top. Mount modules push history.state.{prReview, mergeConflict};
    // the registry's poppable: true flag scopes this to overlays that
    // pushed a history entry. Out of the hotkey path because it's
    // navigation, not a keystroke.
    window.addEventListener('popstate', () => {
        closeTopmostOverlay({ popstate: true });
    });
}

// ============================================
// EVENT LISTENERS
// ============================================

// ============================================
// TOOLBAR (Debug + others)
// ============================================
// Plugin modal owner moved to js/plugin-modal.js (2.29.0 — Phase 2b
// of the inline-handlers migration).

/**
 * Initialize the top-bar Debug dropdown (1.3.6).
 *
 * 1.3.9: the dropdown bridge (Error log + LLM debug log menu items)
 * is retired; the same `#btnDebugMenu` button now opens the Debug
 * slide-out. Wiring lives in `js/debug-slideout.js` —
 * `initDebugSlideOut()` attaches the click handler, the keyboard
 * shortcut, and the live event subscriptions.
 */

/**
 * Initialize the top-bar branch indicator (1.3.6).
 *
 * Renders the current branch name in `#tbBranchName`. Ahead/behind counts
 * (`#tbBranchCounts`) ship in §1.3.6.1 once provider compare endpoints land.
 */
/**
 * Window-wide .zip drop listener — Touch 3 zip-flow (2.20.0).
 *
 * Materializes a full-window overlay on .zip drag, opens the upload modal on
 * drop. The discriminator (`isZipDrop`) discounts text/image drops so chat
 * input + replay drop zones keep working as before — they were scoped to
 * their own elements anyway, but this guard keeps the overlay from painting
 * during unrelated drags.
 */
function initWindowZipDrop() {
    let overlay = null;
    let dragCounter = 0; // dragenter/leave nest correctly even across child elements

    const ensureOverlay = () => {
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'windowZipDrop';
        overlay.className = 'zip-drop';
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        overlay.innerHTML =
            '<div class="zip-drop__card">' +
                '<svg class="icn icn--hero" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>' +
                '<div class="zip-drop__title">Drop .zip to import</div>' +
                '<div class="zip-drop__sub">Lands in a new branch by default</div>' +
            '</div>';
        document.body.appendChild(overlay);
        return overlay;
    };

    const showOverlay = () => {
        const el = ensureOverlay();
        el.hidden = false;
        el.setAttribute('aria-hidden', 'false');
    };
    const hideOverlay = () => {
        if (!overlay) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
    };

    document.addEventListener('dragenter', (e) => {
        if (!isZipDrop(e.dataTransfer, { mode: 'permissive' })) return;
        dragCounter++;
        showOverlay();
    });
    document.addEventListener('dragover', (e) => {
        if (!isZipDrop(e.dataTransfer, { mode: 'permissive' })) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
        // Only count drag-leaves crossing the window boundary (clientX/Y at 0
        // when leaving the window). This avoids flicker as the cursor moves
        // over nested elements.
        if (e.target !== document && e.clientX !== 0 && e.clientY !== 0) return;
        dragCounter = Math.max(0, dragCounter - 1);
        if (dragCounter === 0) hideOverlay();
    });
    document.addEventListener('drop', async (e) => {
        if (!isZipDrop(e.dataTransfer, { mode: 'strict' })) {
            // Not a .zip — let other handlers (chat input, etc.) take over.
            dragCounter = 0;
            hideOverlay();
            return;
        }
        e.preventDefault();
        dragCounter = 0;
        hideOverlay();

        const file = Array.from(e.dataTransfer.files || []).find(
            f => f && typeof f.name === 'string' && f.name.toLowerCase().endsWith('.zip')
        );
        if (!file) return;

        // Open the modal first so the segmented control + branch input are
        // mounted, then hand the file to handleZipFile. The modal init
        // defaults the segmented control to "new branch", matching the
        // canvas's "drops always become new branches" convention.
        openZipUpload();
        await handleZipFile(file);
    });
}

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
    // 1.12.0: branch picker is the row-list panel; the handler in
    // project-manager updates State.currentBranch and emits `branch:switch`
    // before any await, so a synchronous re-render here stays correct.
    EventBus.on('branch:switch', render);
}

function setupEventListeners() {
    // 2.44.0.1: button wirings flow through `dom-bindings.js` so that
    // plugin-mounted buttons (any element mounted into a SlotManager slot
    // after `init()` runs) wire on the next `slot:rail-views:changed`
    // emission instead of being silently dropped. See
    // `docs/audit-2026-Q2/inventory.md` §app-boot.

    // Top-bar (1.3.6 Restructure)
    bindClick('btnCommit', openCommitModal);
    bindClick('btnRevert', revertCurrentFile);  // now in editor toolbar
    bindClick('btnSettings', openSettings);
    bindClick('btnHelp', openHelpSlideOut);
    bindClick('tbCmdK', () => QuickOpen.open());

    // Panel collapse buttons (inside panel headers)
    bindClick('btnCollapseSidebar', toggleSidebar);
    bindClick('btnCollapseChat', toggleChat);

    // Panel edge expand tabs (shown when panel is hidden)
    bindClick('sidebarExpandTab', toggleSidebar);
    bindClick('chatExpandTab', toggleChat);
    // Also support keyboard activation on edge tabs
    const edgeKeyHandler = (fn) => (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    };
    bindEvent('sidebarExpandTab', 'keydown', edgeKeyHandler(toggleSidebar));
    bindEvent('chatExpandTab', 'keydown', edgeKeyHandler(toggleChat));

    // Sidebar buttons
    bindClick('btnRefreshProjects', refreshProjects);
    bindClick('btnClearProject', clearProject);
    // Per-view header buttons (Refresh files / New file / Refresh issues /
    // Refresh PRs / New branch / Download zip / Release / New PR / Zip upload)
    // are wired declaratively via `view.headerActions[].onClick` in
    // `js/ui/left-pane-rail.js#BUILTIN_VIEWS` (2.24.0 SlotManager body migration).

    // Issue focus bar
    bindClick('btnIssueFocusDismiss', unfocusIssue);
    bindClick('btnIssueFocusExpand', () => {
        if (State.focusedIssue) openIssueTab(State.focusedIssue.number, { pin: true });
    });
    // Accept/Deny/Comment/Work wired via EventBus from project-manager

    // Selectors
    bindEvent('projectSelect', 'change', onProjectChange);
    // Branch selector is now the row-list panel — its switch button delegates
    // through `mountBranchPanel({ onSwitch })` in project-manager.js (1.12.0).
    bindEvent('modelSelect', 'change', onModelChange);
    // Cost reset moves to the §1.3.9 Debug slide-out — until then expose on
    // window for power users / docs.
    window.resetSessionCost = resetSessionCost;

    // Editor toolbar
    bindClick('btnToggleLineNumbers', toggleLineNumbers);
    bindClick('btnTogglePreview', togglePreviewPane);
    bindClick('btnToggleDiff', toggleDiffPane);
    bindClick('btnToggleBlame', toggleBlamePane);

    // Chat
    bindClick('btnSend', () => {
        const input = document.getElementById('chatInput');
        const text = input ? input.value.trim() : '';
        const hasImages = document.getElementById('imagePreviewStrip')?.style.display !== 'none'
            && document.getElementById('imagePreviewStrip')?.children.length > 0;
        if (text || hasImages) {
            window.Chat.sendMessage(text);
            if (input) input.value = '';
        }
    });
    bindClick('btnStop', stopGeneration);
    bindClick('btnFetchModels', fetchModels);
    bindClick('btnNewChat', () => {
        clearChat();
        resetSessionCost();
        showToast('New conversation started', 'success');
    });
    bindClick('btnExportChat', () => {
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
                    <h2 style="font-size: 24px; margin-bottom: 1rem; display: inline-flex; align-items: center; gap: 0.4em;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true"><path d="M12 3 2 21h20Z"/><path d="M12 9v4M12 17h.01"/></svg><span>Template Load Error</span></h2>
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

    // 2.40.0: hydrate plan-mode from Storage (and migrate the unprefixed
    // pre-2.40.0 `chat.planMode` legacy localStorage key). Must run after
    // Storage.init() — chat/state.js's module-load timing predates the
    // Storage cache populating.
    hydratePlanMode();

    // Load settings
    loadSettings();
    initGitProviders();  // Must run after loadSettings — migrates legacy giteaUrl/giteaToken to connections[]
    applyProviderContributions();  // 2.22.0 — wire provider manifests to SlotManager (structured `rail-views` is the supported extension seam).
    IgnoreManager.init(); // Must run after loadSettings — reads ignorePatterns from State.settings
    initProjectConventions(); // Subscribes to git:projectLoaded to fetch repo-root CLAUDE.md (github#37)
    applyVisualSettings();
    initPanelResize();


    // Initialize components
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
    registerCoreOverlays();
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
    installWorkspaceSettingsFileLayer();
    installTestLoopUi();
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
        window.AIEditor.workspaceSettings = {
            getPendingContent: workspaceSettingsGetPendingContent,
            listPendingPaths: workspaceSettingsListPendingPaths,
            getDiagnostics: workspaceSettingsGetDiagnostics,
            isEnabled: workspaceSettingsIsEnabled,
            getActiveWorkspaceId: workspaceSettingsActiveWorkspaceId,
        };
        window.AIEditor.SlotManager = SlotManager;
    }
    initSessionListeners();
    mountLeftPaneRail();
    // 2.44.0.1: re-walk dom-bindings entries whose target element wasn't in
    // the boot-time DOM. Today the only structured slot mounting buttons
    // is `rail-views`; if a future structured slot starts mounting
    // wired-by-id elements, add another `forSlot(...)` subscriber here.
    EventBus.on(forSlot('rail-views'), rewireUnboundElements);
    mountNowStrip();
    mountSwitcherMenu();
    mountCommitModal({ onClose: closeCommitModal, onCommit: commitAndPush, onGenerate: generateCommitMsg });
    mountRevertModal({ onClose: closeRevertModal, onRevertCurrent: revertOnlyCurrentFile, onRevertAll: revertAllFiles });
    mountNewBranchModal({ onClose: closeNewBranchModal, onCreate: createNewBranch });
    mountNewFileModal({ onClose: closeNewFileModal, onCreate: createNewFile });
    mountRenameModal({ onClose: closeRenameModal, onSubmit: submitRename });
    mountIssueDetailModal({ onClose: closeIssueDetailModal });
    mountZipUpload({ onClose: closeZipUpload, onSelectAll: zipSelectAll, onScanDiffs: scanForDiffs, onUpload: uploadExtractedFiles });
    mountReleaseModal({ onClose: closeReleaseModal, onGenerate: generateReleaseNotes, onCreate: createGitRelease });
    mountReplayModal({ onClose: closeReplayModal, onPrev: replayPrev, onNext: replayNext });
    mountSettingsModal({
        onClose: closeSettings,
        onSave: saveSettings,
        onExport: exportSettings,
        onImport: importSettings,
        onFetchModels: fetchModelsForSettings,
        onFetchEmbedModels: fetchEmbeddingModelsForSettings,
    });
    mountCreatePRModal({ onClose: closeCreatePRModal, onSubmit: submitCreatePR });
    mountPluginModal({ onClose: closePluginModal });
    mountAppShellActions({
        onOpenSettings: openSettings,
        onOpenZipUpload: openZipUpload,
        onToggleSecondaryFullscreen: toggleSecondaryFullscreen,
        onCloseSecondaryPane: closeSecondaryPane,
        onOpenReplayModal: openReplayModal,
    });
    // Phase 3a of inline-handlers migration — JS-renderer surfaces.
    mountDiffViewer({
        onSetViewMode: diffSetViewMode,
        onPreviousChange: diffPreviousChange,
        onNextChange: diffNextChange,
    });
    mountFileTree({
        onTreeClick: handleTreeClick,
        onRename: openRenameModal,
        onDeleteFile: deleteFile,
        onDeleteFolder: deleteFolder,
    });
    mountIssueList({
        onSendDepMessage: (depNum) => window.Chat?.sendMessage(`Show me issue #${depNum}`),
        onStartWork: (issueNumber) => window.startWorkOnIssueFromList(issueNumber),
        onOpenIssueTab: (issueNumber) => openIssueTab(issueNumber),
    });
    mountPrList({ onOpenPrReview: (number) => openPrReview(number) });
    mountTabManager({ onSwitchTab: switchToTab, onCloseTab: closeTab });
    mountChatInput({ onRemoveImage: (i) => window.Chat?.removeImage(i) });
    mountIssueTab({ onOpenIssueTab: (issueNumber) => openIssueTab(issueNumber) });
    // Phase 3b — js/chat/messages.js renderer (final HTML-side slice). All
    // 9 callbacks already live on the `window.Chat.*` namespace assigned
    // at js/chat/index.js module-load time; we route through it rather
    // than re-importing the individual functions to mirror the
    // mountChatInput pattern above.
    mountChatMessages({
        onApplyPendingEdit: () => window.Chat?.applyPendingEdit?.(),
        onRejectPendingEdit: () => window.Chat?.rejectPendingEdit?.(),
        onContinueResponse: () => window.Chat?.continueResponse?.(),
        onCopyMessage: (btn) => window.Chat?.copyMessage?.(btn),
        onEditMessage: (btn) => window.Chat?.editMessage?.(btn),
        onRetryLastMessage: () => window.Chat?.retryLastMessage?.(),
        onCommitEdit: (btn) => window.Chat?.commitEdit?.(btn),
        onCancelEdit: (btn) => window.Chat?.cancelEdit?.(btn),
        onPreviewImage: (url) => window.Chat?.previewImage?.(url),
    });
    initHelpSlideOut();
    initWindowZipDrop();

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
    initDebugSlideOut();
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
