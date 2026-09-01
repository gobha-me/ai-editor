// ============================================
// SETTINGS MANAGER — Orchestrator
// ============================================
// Thin coordinator that delegates to focused sub-modules.
// Each tab owns its own DOM population and event wiring.
// Persistence owns DOM→State collection and localStorage.

import { State, Providers, ProviderRegistry, EventBus, saveSettings as coreSaveSettings } from './core.js';
import { RetrievalManager } from './intelligence/retrieval/manager.js';
import { IgnoreManager } from './ignore.js';
import { EmbeddingsClient } from './embeddings-client.js';
import { injectTemplate } from './template-loader.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// Sub-modules
import { collectAndSave, exportSettings, importSettings } from './settings/persistence.js';
import { initConnectionsTab } from './settings/connections-tab.js';
import { initMCPServersTab } from './settings/mcp-servers-tab.js';
import { initWorkspaceSettingsTab, decorateOverriddenControls } from './settings/workspace-settings-tab.js';
import { initTestLoopTab } from './settings/test-loop-tab.js';
import { initToolsTab } from './settings/tools-tab.js';
import { initRetrievalTab } from './settings/retrieval-tab.js';
import { populateRoleCards } from './settings/profiles-tab.js';
import { populatePluginsTab } from './settings/plugins-tab.js';
// 2.44.0.2 — side-effect imports: the module body's `registerOnActivate`
// call wires the tab's refresh handler at load time; no name is consumed
// here. Pre-2.44.0.2 these were named imports referenced from the
// (now-deleted) `tab.dataset.tab === '...'` switch in `populateSettingsForm`.
import './storage-metrics.js';
import './settings/memory-tab.js';
import {
    updateProviderDescription, renderProviderSettings, showModelCapabilities,
    populateSummarizerSliders, populateAdvancedParams, updateEmbeddingsStatus,
    populateCommitModelSelect
} from './settings/llm-tab.js';
import {
    populateSettingsModelSelects, fetchModelsForSettings,
    fetchEmbeddingModelsForSettings, initModelsTabEvents,
    populateEmbeddingModelsByProvider
} from './settings/models-tab.js';
import { initCostTab } from './settings/cost-tab.js';
import {
    registerOnActivate,
    dispatchOnActivate,
    dispatchAllOnClose,
} from './settings/tab-activation-registry.js';

// ── Theme switching ──
// Live-swaps the active theme stylesheet by updating the <link> href
// and the <html data-theme> attribute. The link is identified by id
// `theme-link` (set in index.html). Token contract: only the theme
// file changes; component CSS continues reading --tk-* through the
// alias bridge in base.css.
const VALID_THEMES = new Set(['refined', 'editorial']);

export function applyTheme(themeName) {
    const name = VALID_THEMES.has(themeName) ? themeName : 'refined';
    const link = document.getElementById('theme-link');
    if (link && link.dataset.themeName !== name) {
        link.href = `./css/themes/${name}.css`;
        link.dataset.themeName = name;
    }
    document.documentElement.setAttribute('data-theme', name);
    State.settings.theme = name;
}

// ── Open / Close ──

export async function openSettings() {
    // Load settings tabs template if not already loaded
    const container = document.getElementById('settingsTabsContainer');
    if (container && !container.hasChildNodes()) {
        try {
            await injectTemplate('settings-tabs', container);
        } catch (error) {
            console.error('Failed to load settings tabs template:', error);
            window.showToast('Failed to load settings form', 'error');
            return;
        }
    }
    
    populateSettingsForm();
    initConnectionsTab();
    initMCPServersTab();
    initWorkspaceSettingsTab();
    initTestLoopTab();
    initToolsTab();
    initRetrievalTab();
    decorateOverriddenControls();
    updateEmbeddingsStatus();
    document.getElementById('settingsModal').classList.add('active');

    // 1.4.4 — keep inline decoration in sync if the override map changes
    // while the modal is open (e.g. user clicks Reset to global on the
    // Workspace Settings tab). Subscription is idempotent — replaces the
    // previous binding so re-opens don't accumulate handlers.
    if (window._workspaceSettingsDecorateUnsub) {
        try { window._workspaceSettingsDecorateUnsub(); } catch { /* ignore */ }
    }
    window._workspaceSettingsDecorateUnsub = EventBus.on(
        'workspaceSettings:changed',
        () => decorateOverriddenControls(),
    );

    // Reset the sidebar search and focus it so typing immediately filters.
    const search = document.getElementById('settingsSidebarSearch');
    if (search) {
        search.value = '';
        applySidebarFilter('');
        search.focus({ preventScroll: true });
    }
}

export function closeSettings() {
    // Tear down per-tab on-close handlers (Memory tab unmounts its Preact
    // root so EventBus subscriptions don't accumulate across open/close
    // cycles). Idempotent — handlers no-op when never activated.
    // 2.44.0.2 — routed through tab-activation-registry; pre-2.44.0.2
    // this was an explicit `unmountMemoryTab()` call.
    dispatchAllOnClose();
    document.getElementById('settingsModal').classList.remove('active');
}

/**
 * Bind a delegated click handler for the settings modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * UI event-dispatch contract (DESIGN-ui-event-dispatch.md).
 * Replicates the Phase 1 `mountCommitModal` (js/ui/commit.js:116) shape.
 *
 * Scope `#settingsModal` covers both the modal-body footer buttons (export,
 * import, cancel, save) and the per-tab fetch buttons rendered inside
 * `#settingsTabsContainer` (loaded from html/settings-tabs.html), because the
 * tab container lives inside the modal.
 */
let _wired = false;
export function mountSettingsModal({
    onClose, onSave, onExport, onImport, onFetchModels, onFetchEmbedModels,
} = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#settingsModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeSettings' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'saveSettings' && typeof onSave === 'function') {
            onSave();
        } else if (action === 'exportSettings' && typeof onExport === 'function') {
            onExport();
        } else if (action === 'importSettings' && typeof onImport === 'function') {
            onImport();
        } else if (action === 'fetchModelsForSettings' && typeof onFetchModels === 'function') {
            onFetchModels();
        } else if (action === 'fetchEmbeddingModelsForSettings' && typeof onFetchEmbedModels === 'function') {
            onFetchEmbedModels();
        }
    });
}

// ── Save (collect from DOM → persist → close) ──

export function saveSettings() {
    collectAndSave();
    coreSaveSettings();
    closeSettings();
    window.showToast('Settings saved', 'success');
    window.dispatchEvent(new CustomEvent('settings:saved'));
}

// ── Form population (delegates to each tab module) ──

function populateSettingsForm() {
    // --- LLM Tab ---
    document.getElementById('settingLlmEndpoint').value = State.settings.llmEndpoint || '';
    document.getElementById('settingLlmApiKey').value = State.settings.llmApiKey || '';

    // Provider dropdown
    const providerSelect = document.getElementById('settingApiProvider');
    providerSelect.innerHTML = Providers.list().map(p =>
        `<option value="${escapeAttr(p.id)}" ${p.id === State.settings.apiProvider ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
    ).join('');
    updateProviderDescription();

    // Model selects
    populateSettingsModelSelects(State.models);
    const modelSelect = document.getElementById('settingLlmModel');
    if (State.settings.llmModel) modelSelect.value = State.settings.llmModel;
    
    providerSelect.onchange = () => {
        updateProviderDescription();
        renderProviderSettings();
        // Auto-fill endpoint when provider changes (if endpoint is empty)
        const endpointInput = document.getElementById('settingLlmEndpoint');
        const defaultEndpoint = ProviderRegistry.getDefaultEndpoint(providerSelect.value);
        if (endpointInput && !endpointInput.value && defaultEndpoint) {
            endpointInput.value = defaultEndpoint;
        }
    };
    modelSelect.onchange = showModelCapabilities;
    showModelCapabilities();

    // Timeout sliders
    const llmIdleTimeoutSlider = document.getElementById('settingLlmIdleTimeout');
    const toolTimeoutSlider = document.getElementById('settingToolTimeout');
    const longRunningToolTimeoutSlider = document.getElementById('settingLongRunningToolTimeout');
    const summaryTimeoutSlider = document.getElementById('settingSummaryTimeout');

    llmIdleTimeoutSlider.value = (State.settings.llmIdleTimeout || 90000) / 1000;
    toolTimeoutSlider.value = (State.settings.toolTimeout || 30000) / 1000;
    longRunningToolTimeoutSlider.value = (State.settings.longRunningToolTimeout || 300000) / 1000;
    summaryTimeoutSlider.value = (State.settings.summaryTimeout || 60000) / 1000;

    document.getElementById('llmIdleTimeoutValue').textContent = llmIdleTimeoutSlider.value + 's';
    document.getElementById('toolTimeoutValue').textContent = toolTimeoutSlider.value + 's';
    document.getElementById('longRunningToolTimeoutValue').textContent = longRunningToolTimeoutSlider.value + 's';
    document.getElementById('summaryTimeoutValue').textContent = summaryTimeoutSlider.value + 's';

    llmIdleTimeoutSlider.oninput = () => {
        document.getElementById('llmIdleTimeoutValue').textContent = llmIdleTimeoutSlider.value + 's';
    };
    toolTimeoutSlider.oninput = () => {
        document.getElementById('toolTimeoutValue').textContent = toolTimeoutSlider.value + 's';
    };
    longRunningToolTimeoutSlider.oninput = () => {
        document.getElementById('longRunningToolTimeoutValue').textContent = longRunningToolTimeoutSlider.value + 's';
    };
    summaryTimeoutSlider.oninput = () => {
        document.getElementById('summaryTimeoutValue').textContent = summaryTimeoutSlider.value + 's';
    };

    // --- Appearance Tab ---

    // Theme dropdown — Refined IDE (default) / Editorial Calm.
    // Live-applies on change so users see the swap without reload.
    const themeSelect = document.getElementById('settingTheme');
    if (themeSelect) {
        themeSelect.value = State.settings.theme || 'refined';
        themeSelect.onchange = () => {
            applyTheme(themeSelect.value);
        };
    }

    const uiScaleSlider = document.getElementById('settingUiScale');
    const editorFontSlider = document.getElementById('settingEditorFontSize');
    uiScaleSlider.value = State.settings.uiScale || 100;
    editorFontSlider.value = State.settings.editorFontSize || 14;
    document.getElementById('uiScaleValue').textContent = uiScaleSlider.value + '%';
    uiScaleSlider.setAttribute('aria-valuenow', uiScaleSlider.value);
    document.getElementById('editorFontSizeValue').textContent = editorFontSlider.value + 'px';

    // Debounced live preview — label updates instantly, CSS var applies after 200ms settle
    let _fontDebounce = null;
    const debouncedFontPreview = (prop, value) => {
        clearTimeout(_fontDebounce);
        _fontDebounce = setTimeout(() => {
            document.documentElement.style.setProperty(prop, value + 'px');
        }, 200);
    };

    let _scaleDebounce = null;
    uiScaleSlider.oninput = () => {
        const scale = parseInt(uiScaleSlider.value);
        document.getElementById('uiScaleValue').textContent = scale + '%';
        uiScaleSlider.setAttribute('aria-valuenow', scale);
        clearTimeout(_scaleDebounce);
        _scaleDebounce = setTimeout(() => {
            const px = Math.round(13 * (scale / 100)) + 'px';
            document.documentElement.style.setProperty('--ui-font-size', px);
            document.documentElement.style.setProperty('--chat-font-size', px);
        }, 200);
    };
    editorFontSlider.oninput = () => {
        document.getElementById('editorFontSizeValue').textContent = editorFontSlider.value + 'px';
        debouncedFontPreview('--editor-font-size', editorFontSlider.value);
    };

    // Checkbox null-safe population
    const showLineNumbersEl = document.getElementById('settingShowLineNumbers');
    if (showLineNumbersEl) showLineNumbersEl.checked = State.settings.showLineNumbers !== false;

    // Keybinding mode radio (Default / Vim) — null-safe; falls through to 'default' on legacy installs
    const kbMode = State.settings.editorKeybindingMode === 'vim' ? 'vim' : 'default';
    const kbRadio = document.querySelector(`input[name="editorKeybindingMode"][value="${kbMode}"]`);
    if (kbRadio) kbRadio.checked = true;

    // Invisible-Unicode scan checkbox — defaults to true on legacy installs.
    const scanInvisibleEl = document.getElementById('settingEditorScanInvisibleUnicode');
    if (scanInvisibleEl) scanInvisibleEl.checked = State.settings.editorScanInvisibleUnicode !== false;

    // Ghost text (1.4.7). Subtree may be absent on first load — fall back to defaults.
    const _gt = State.settings.ghostText || {};
    const gtEnabledEl = document.getElementById('settingGhostTextEnabled');
    if (gtEnabledEl) gtEnabledEl.checked = _gt.enabled === true;
    const gtHotkeyEl = document.getElementById('settingGhostTextHotkey');
    if (gtHotkeyEl) gtHotkeyEl.value = _gt.hotkey || 'Tab';
    const gtMaxTokensEl = document.getElementById('settingGhostTextMaxTokens');
    if (gtMaxTokensEl) gtMaxTokensEl.value = _gt.maxTokens || 150;
    const gtContextLinesEl = document.getElementById('settingGhostTextContextLines');
    if (gtContextLinesEl) gtContextLinesEl.value = _gt.contextLines || 40;
    // Model dropdown is populated by populateGhostTextModelSelect() in
    // llm-tab.js; called from the settings-open hook below.

    const showIssuesEl = document.getElementById('settingShowIssues');
    if (showIssuesEl) showIssuesEl.checked = State.settings.showIssues !== false;
    
    const showPRsEl = document.getElementById('settingShowPullRequests');
    if (showPRsEl) showPRsEl.checked = State.settings.showPullRequests !== false;

    // --- Context Tab ---
    const useEmbeddingsEl = document.getElementById('settingUseEmbeddings');
    if (useEmbeddingsEl) useEmbeddingsEl.checked = State.settings.useEmbeddings || false;
    
    const embeddingModelInput = document.getElementById('settingEmbeddingModel');
    if (embeddingModelInput) embeddingModelInput.value = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
    
    const maxRelevantFilesEl = document.getElementById('settingMaxRelevantFiles');
    if (maxRelevantFilesEl) maxRelevantFilesEl.value = State.settings.maxRelevantFiles || 5;
    
    const maxRelevantFilesValueEl = document.getElementById('maxRelevantFilesValue');
    if (maxRelevantFilesValueEl) maxRelevantFilesValueEl.textContent = State.settings.maxRelevantFiles || 5;

    const maxIndexFilesEl = document.getElementById('settingMaxIndexFiles');
    if (maxIndexFilesEl) maxIndexFilesEl.value = State.settings.maxIndexFiles || 5000;

    const maxIndexFilesValueEl = document.getElementById('maxIndexFilesValue');
    if (maxIndexFilesValueEl) maxIndexFilesValueEl.textContent = State.settings.maxIndexFiles || 5000;

    const maxIndexTokensEl = document.getElementById('settingMaxIndexTokens');
    if (maxIndexTokensEl) maxIndexTokensEl.value = State.settings.maxIndexTokens || 300000;

    const maxIndexTokensValueEl = document.getElementById('maxIndexTokensValue');
    if (maxIndexTokensValueEl) maxIndexTokensValueEl.textContent = String(State.settings.maxIndexTokens || 300000);

    const autoReindexEl = document.getElementById('settingAutoReindex');
    if (autoReindexEl) autoReindexEl.checked = State.settings.autoReindex !== false;
    
    const embeddingCacheExpiryEl = document.getElementById('settingEmbeddingCacheExpiry');
    if (embeddingCacheExpiryEl) embeddingCacheExpiryEl.value = State.settings.embeddingCacheExpiry || 7;

    // Max files sliders
    const maxFilesSlider = document.getElementById('settingMaxRelevantFiles');
    if (maxFilesSlider) {
        maxFilesSlider.oninput = () => {
            const valueEl = document.getElementById('maxRelevantFilesValue');
            if (valueEl) valueEl.textContent = maxFilesSlider.value;
        };
    }
    const maxIndexSlider = document.getElementById('settingMaxIndexFiles');
    if (maxIndexSlider) {
        maxIndexSlider.oninput = () => {
            const valueEl = document.getElementById('maxIndexFilesValue');
            if (valueEl) valueEl.textContent = maxIndexSlider.value;
        };
    }
    const maxIndexTokensSlider = document.getElementById('settingMaxIndexTokens');
    if (maxIndexTokensSlider) {
        maxIndexTokensSlider.oninput = () => {
            const valueEl = document.getElementById('maxIndexTokensValue');
            if (valueEl) valueEl.textContent = maxIndexTokensSlider.value;
        };
    }

    // Embeddings toggle
    const embeddingsToggle = document.getElementById('settingUseEmbeddings');
    const embeddingsSettings = document.getElementById('embeddingsSettings');
    if (embeddingsToggle && embeddingsSettings) {
        embeddingsToggle.onchange = () => {
            embeddingsSettings.style.opacity = embeddingsToggle.checked ? '1' : '0.5';
            embeddingsSettings.style.pointerEvents = embeddingsToggle.checked ? 'auto' : 'none';
        };
        embeddingsToggle.checked = !!State.settings.useEmbeddings;
        embeddingsToggle.onchange(); // Initialize state
    }

    // Embedder provider radios — populate from State and toggle endpoint/key visibility.
    const embeddingProvider = State.settings.embeddingProvider || 'local';
    const providerRadio = document.querySelector(`input[name="embeddingProvider"][value="${embeddingProvider}"]`);
    if (providerRadio) providerRadio.checked = true;
    const remoteSettings = document.getElementById('embeddingRemoteSettings');
    const updateRemoteVisibility = () => {
        const selected = document.querySelector('input[name="embeddingProvider"]:checked')?.value || 'local';
        if (remoteSettings) remoteSettings.style.display = (selected === 'local') ? 'none' : '';
        // Repopulate the model picker so it only shows options for the
        // active provider — Xenova/* in local mode, API-fetched in remote.
        populateEmbeddingModelsByProvider(selected);
    };
    document.querySelectorAll('input[name="embeddingProvider"]').forEach(r => {
        r.onchange = updateRemoteVisibility;
    });
    updateRemoteVisibility();

    // Embedder endpoint/key inputs
    const embeddingEndpointEl = document.getElementById('settingEmbeddingEndpoint');
    if (embeddingEndpointEl) embeddingEndpointEl.value = State.settings.embeddingEndpoint || '';
    const embeddingApiKeyEl = document.getElementById('settingEmbeddingApiKey');
    if (embeddingApiKeyEl) embeddingApiKeyEl.value = State.settings.embeddingApiKey || '';

    // "Use chat LLM credentials" — copy from the LLM tab's inputs (not from
    // State directly, so unsaved changes in the LLM tab still propagate).
    const useChatCredsBtn = document.getElementById('btnEmbeddingUseChatLlmCreds');
    if (useChatCredsBtn) {
        useChatCredsBtn.onclick = () => {
            const llmEndpoint = document.getElementById('settingLlmEndpoint')?.value.trim() || '';
            const llmApiKey = document.getElementById('settingLlmApiKey')?.value.trim() || '';
            if (embeddingEndpointEl) embeddingEndpointEl.value = llmEndpoint;
            if (embeddingApiKeyEl) embeddingApiKeyEl.value = llmApiKey;
            window.showToast('Copied chat LLM credentials into embedder fields', 'success');
        };
    }

    // Clear cache button
    const clearCacheBtn = document.getElementById('btnClearEmbeddingsCache');
    if (clearCacheBtn) {
        clearCacheBtn.onclick = () => {
            RetrievalManager.clearIndex();
            EmbeddingsClient.clearCache();
            updateEmbeddingsStatus();
            window.showToast('Embeddings cache cleared', 'success');
        };
    }

    // --- Delegate to tab modules ---
    populateSummarizerSliders();
    populateRoleCards();
    populatePluginsTab();
    populateAdvancedParams();
    initModelsTabEvents();
    initCostTab();

    // --- Ignore Tab ---
    const ignoreTextarea = document.getElementById('settingIgnorePatterns');
    if (ignoreTextarea) {
        ignoreTextarea.value = IgnoreManager.getGlobalPatterns();
    }
    const resetIgnoreBtn = document.getElementById('btnResetIgnore');
    if (resetIgnoreBtn) {
        resetIgnoreBtn.onclick = () => {
            IgnoreManager.resetToDefaults();
            const ta = document.getElementById('settingIgnorePatterns');
            if (ta) ta.value = IgnoreManager.getGlobalPatterns();
            _updateIgnoreStats();
            window.showToast('Ignore patterns reset to defaults', 'success');
        };
    }
    _updateIgnoreStats();
    _updateProjectIgnoreDisplay();

    // --- Settings tab switching ---
    // Scope to settings modal only — help modal has its own .settings-tab elements
    const settingsModal = document.getElementById('settingsModal');

    // Add role="tabpanel" to tab content panels
    settingsModal.querySelectorAll('.settings-tab-content').forEach(panel => {
        panel.setAttribute('role', 'tabpanel');
    });

    settingsModal.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => {
            settingsModal.querySelectorAll('.settings-tab').forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            settingsModal.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            document.getElementById(tab.dataset.tab).classList.add('active');

            // 2.44.0.2 — routed through tab-activation-registry. Each tab
            // module self-registers its on-activate handler at module-
            // load; pre-2.44.0.2 this was an 11-branch switch in-place.
            // Tabs without a registration are no-ops (most tabs are fully
            // populated once during `populateSettingsForm()`).
            dispatchOnActivate(tab.dataset.tab);
        };
    });

    // --- Sidebar search filter (1.3.7) ---
    initSidebarSearch();
}

// ── Sidebar search filter ──
// Filters .settings-sidebar__item by label text. Hides any group whose
// items are all filtered out so the group header doesn't strand.
// Esc clears; modal-open focuses the input automatically.

function initSidebarSearch() {
    const input = document.getElementById('settingsSidebarSearch');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';

    input.addEventListener('input', () => applySidebarFilter(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) {
            e.stopPropagation();
            input.value = '';
            applySidebarFilter('');
        }
    });
}

function applySidebarFilter(query) {
    const q = (query || '').trim().toLowerCase();
    const sidebar = document.querySelector('.settings-sidebar');
    if (!sidebar) return;

    let totalVisible = 0;
    sidebar.querySelectorAll('.settings-sidebar__group').forEach(group => {
        let groupVisible = 0;
        group.querySelectorAll('.settings-sidebar__item').forEach(item => {
            const matches = !q || item.textContent.toLowerCase().includes(q);
            item.hidden = !matches;
            if (matches) groupVisible++;
        });
        group.classList.toggle('settings-sidebar__group--empty', groupVisible === 0);
        totalVisible += groupVisible;
    });

    const empty = document.getElementById('settingsSidebarEmpty');
    if (empty) empty.hidden = totalVisible > 0;
}

// ── Ignore tab helpers ──

function _updateIgnoreStats() {
    const el = document.getElementById('ignoreStats');
    if (!el) return;
    const stats = IgnoreManager.stats();
    const parts = [`${stats.total} active rules`];
    if (stats.project > 0) parts.push(`(${stats.project} from .aieditorignore)`);
    el.textContent = parts.join(' ');
}

function _updateProjectIgnoreDisplay() {
    const container = document.getElementById('projectIgnoreInfo');
    const content = document.getElementById('projectIgnoreContent');
    if (!container || !content) return;
    const projectPatterns = IgnoreManager.getProjectPatterns();
    if (projectPatterns.trim()) {
        content.textContent = projectPatterns;
        container.style.display = 'block';
    } else {
        container.style.display = 'none';
    }
}

// 2.44.0.2 — Ignore tab has no dedicated `ignore-tab.js` module (its
// state lives in `IgnoreManager` and its UI in the local helpers above),
// so the registration is here. Replaces the
// `tab.dataset.tab === 'tabIgnore'` branch from the pre-2.44.0.2 switch.
registerOnActivate('tabIgnore', () => {
    _updateIgnoreStats();
    _updateProjectIgnoreDisplay();
});

// ── Re-exports for external consumers ──

export { populateSettingsModelSelects, fetchModelsForSettings, fetchEmbeddingModelsForSettings };
export { exportSettings, importSettings };

// Expose to window for button onclick handlers
window.exportSettings = exportSettings;
window.importSettings = importSettings;
window.fetchModelsForSettings = fetchModelsForSettings;
window.fetchEmbeddingModelsForSettings = fetchEmbeddingModelsForSettings;
