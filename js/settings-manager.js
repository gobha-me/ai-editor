// ============================================
// SETTINGS MANAGER — Orchestrator
// ============================================
// Thin coordinator that delegates to focused sub-modules.
// Each tab owns its own DOM population and event wiring.
// Persistence owns DOM→State collection and localStorage.

import { State, Providers, ProviderRegistry, saveSettings as coreSaveSettings } from './core.js';
import { ContextManager } from './context-manager.js';
import { EmbeddingsClient } from './embeddings-client.js';
import { injectTemplate } from './template-loader.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// Sub-modules
import { collectAndSave, exportSettings, importSettings } from './settings/persistence.js';
import { initConnectionsTab } from './settings/connections-tab.js';
import { populateRoleCards } from './settings/roles-tab.js';
import { populatePluginsTab } from './settings/plugins-tab.js';
import {
    updateProviderDescription, renderProviderSettings, showModelCapabilities,
    populateSummarizerSliders, populateAdvancedParams, updateEmbeddingsStatus,
    populateCommitModelSelect
} from './settings/llm-tab.js';
import {
    populateSettingsModelSelects, fetchModelsForSettings,
    fetchEmbeddingModelsForSettings, populateModelsTab, initModelsTabEvents
} from './settings/models-tab.js';

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
    updateEmbeddingsStatus();
    document.getElementById('settingsModal').classList.add('active');
}

export function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
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
    const llmTimeoutSlider = document.getElementById('settingLlmTimeout');
    const toolTimeoutSlider = document.getElementById('settingToolTimeout');
    const summaryTimeoutSlider = document.getElementById('settingSummaryTimeout');
    
    llmTimeoutSlider.value = (State.settings.llmTimeout || 180000) / 1000;
    toolTimeoutSlider.value = (State.settings.toolTimeout || 30000) / 1000;
    summaryTimeoutSlider.value = (State.settings.summaryTimeout || 60000) / 1000;
    
    document.getElementById('llmTimeoutValue').textContent = llmTimeoutSlider.value + 's';
    document.getElementById('toolTimeoutValue').textContent = toolTimeoutSlider.value + 's';
    document.getElementById('summaryTimeoutValue').textContent = summaryTimeoutSlider.value + 's';

    llmTimeoutSlider.oninput = () => {
        document.getElementById('llmTimeoutValue').textContent = llmTimeoutSlider.value + 's';
    };
    toolTimeoutSlider.oninput = () => {
        document.getElementById('toolTimeoutValue').textContent = toolTimeoutSlider.value + 's';
    };
    summaryTimeoutSlider.oninput = () => {
        document.getElementById('summaryTimeoutValue').textContent = summaryTimeoutSlider.value + 's';
    };

    // --- Appearance Tab ---
    const fontSlider = document.getElementById('settingFontSize');
    const chatFontSlider = document.getElementById('settingChatFontSize');
    const editorFontSlider = document.getElementById('settingEditorFontSize');
    fontSlider.value = State.settings.fontSize || 13;
    chatFontSlider.value = State.settings.chatFontSize || 13;
    editorFontSlider.value = State.settings.editorFontSize || 14;
    document.getElementById('fontSizeValue').textContent = fontSlider.value + 'px';
    document.getElementById('chatFontSizeValue').textContent = chatFontSlider.value + 'px';
    document.getElementById('editorFontSizeValue').textContent = editorFontSlider.value + 'px';

    // Debounced live preview — label updates instantly, CSS var applies after 200ms settle
    let _fontDebounce = null;
    const debouncedFontPreview = (prop, value) => {
        clearTimeout(_fontDebounce);
        _fontDebounce = setTimeout(() => {
            document.documentElement.style.setProperty(prop, value + 'px');
        }, 200);
    };

    fontSlider.oninput = () => {
        document.getElementById('fontSizeValue').textContent = fontSlider.value + 'px';
        debouncedFontPreview('--ui-font-size', fontSlider.value);
    };
    chatFontSlider.oninput = () => {
        document.getElementById('chatFontSizeValue').textContent = chatFontSlider.value + 'px';
        debouncedFontPreview('--chat-font-size', chatFontSlider.value);
    };
    editorFontSlider.oninput = () => {
        document.getElementById('editorFontSizeValue').textContent = editorFontSlider.value + 'px';
        debouncedFontPreview('--editor-font-size', editorFontSlider.value);
    };

    // Checkbox null-safe population
    const showLineNumbersEl = document.getElementById('settingShowLineNumbers');
    if (showLineNumbersEl) showLineNumbersEl.checked = State.settings.showLineNumbers !== false;
    
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
    
    const autoReindexEl = document.getElementById('settingAutoReindex');
    if (autoReindexEl) autoReindexEl.checked = State.settings.autoReindex !== false;
    
    const embeddingCacheExpiryEl = document.getElementById('settingEmbeddingCacheExpiry');
    if (embeddingCacheExpiryEl) embeddingCacheExpiryEl.value = State.settings.embeddingCacheExpiry || 7;

    // Max files slider
    const maxFilesSlider = document.getElementById('settingMaxRelevantFiles');
    if (maxFilesSlider) {
        maxFilesSlider.oninput = () => {
            const valueEl = document.getElementById('maxRelevantFilesValue');
            if (valueEl) valueEl.textContent = maxFilesSlider.value;
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
        embeddingsToggle.onchange(); // Initialize state
    }

    // Clear cache button
    const clearCacheBtn = document.getElementById('btnClearEmbeddingsCache');
    if (clearCacheBtn) {
        clearCacheBtn.onclick = () => {
            ContextManager.clearIndex();
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

    // --- Settings tab switching ---
    // Add role="tabpanel" to tab content panels
    document.querySelectorAll('.settings-tab-content').forEach(panel => {
        panel.setAttribute('role', 'tabpanel');
    });

    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.settings-tab').forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            document.getElementById(tab.dataset.tab).classList.add('active');
            
            // Scroll clicked tab into view
            tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            
            // Update embeddings status when switching to Context tab
            if (tab.dataset.tab === 'tabContext') updateEmbeddingsStatus();
            // Populate Models tab when switching to it
            if (tab.dataset.tab === 'tabModels') populateModelsTab();
            // Refresh Plugins tab when switching to it
            if (tab.dataset.tab === 'tabPlugins') populatePluginsTab();
            
            // Re-check arrow visibility after scroll settles
            setTimeout(updateTabArrows, 100);
        };
    });

    // --- Settings tab arrow buttons ---
    initTabArrows();
}

// ── Tab arrow navigation ──

function initTabArrows() {
    const container = document.querySelector('.settings-tabs');
    if (!container) return;

    container.addEventListener('scroll', updateTabArrows);

    let arrowRafId = null;
    const observer = new ResizeObserver(() => {
        if (arrowRafId) return;
        arrowRafId = requestAnimationFrame(() => {
            updateTabArrows();
            arrowRafId = null;
        });
    });
    observer.observe(container);

    updateTabArrows();
}

function updateTabArrows() {
    const container = document.querySelector('.settings-tabs');
    if (!container) return;

    const leftBtn = document.querySelector('.settings-tabs-arrow-left');
    const rightBtn = document.querySelector('.settings-tabs-arrow-right');
    if (!leftBtn || !rightBtn) return;

    const canScrollLeft = container.scrollLeft > 1;
    const canScrollRight = container.scrollLeft < (container.scrollWidth - container.clientWidth - 1);

    leftBtn.classList.toggle('visible', canScrollLeft);
    rightBtn.classList.toggle('visible', canScrollRight);
}

window.scrollSettingsTabs = function(direction) {
    const container = document.querySelector('.settings-tabs');
    if (!container) return;
    const step = container.clientWidth * 0.6;
    container.scrollBy({ left: direction * step, behavior: 'smooth' });
};

// ── Re-exports for external consumers ──

export { populateSettingsModelSelects, fetchModelsForSettings, fetchEmbeddingModelsForSettings };
export { exportSettings, importSettings };

// Expose to window for button onclick handlers
window.exportSettings = exportSettings;
window.importSettings = importSettings;
window.fetchModelsForSettings = fetchModelsForSettings;
window.fetchEmbeddingModelsForSettings = fetchEmbeddingModelsForSettings;
