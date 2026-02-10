// ============================================
// SETTINGS MANAGER
// ============================================

import { State, Storage, Providers, ProviderRegistry, Roles, Plugins, saveSettings as coreSaveSettings } from './core.js';
import { LLM } from './llm.js';
import { ToolRegistry } from './tools/registry.js';
import { ContextManager } from './context-manager.js';
import { EmbeddingsClient } from './embeddings-client.js';
import { injectTemplate } from './template-loader.js';
import { GitProviderRegistry } from './git-providers/index.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

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
    updateEmbeddingsStatus(); // Update status when opening
    document.getElementById('settingsModal').classList.add('active');
}

export function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
}

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

    // Add null checks for checkbox elements
    const showLineNumbersEl = document.getElementById('settingShowLineNumbers');
    if (showLineNumbersEl) {
        showLineNumbersEl.checked = State.settings.showLineNumbers !== false;
    }
    
    const showIssuesEl = document.getElementById('settingShowIssues');
    if (showIssuesEl) {
        showIssuesEl.checked = State.settings.showIssues !== false;
    }
    
    const showPRsEl = document.getElementById('settingShowPullRequests');
    if (showPRsEl) {
        showPRsEl.checked = State.settings.showPullRequests !== false;
    }

    // --- Context Tab ---
    const useEmbeddingsEl = document.getElementById('settingUseEmbeddings');
    if (useEmbeddingsEl) {
        useEmbeddingsEl.checked = State.settings.useEmbeddings || false;
    }
    
    // Populate embedding model - handle both input and select elements
    const embeddingModelInput = document.getElementById('settingEmbeddingModel');
    if (embeddingModelInput) {
        embeddingModelInput.value = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
    }
    
    const maxRelevantFilesEl = document.getElementById('settingMaxRelevantFiles');
    if (maxRelevantFilesEl) {
        maxRelevantFilesEl.value = State.settings.maxRelevantFiles || 5;
    }
    
    const maxRelevantFilesValueEl = document.getElementById('maxRelevantFilesValue');
    if (maxRelevantFilesValueEl) {
        maxRelevantFilesValueEl.textContent = State.settings.maxRelevantFiles || 5;
    }
    
    const autoReindexEl = document.getElementById('settingAutoReindex');
    if (autoReindexEl) {
        autoReindexEl.checked = State.settings.autoReindex !== false;
    }
    
    const embeddingCacheExpiryEl = document.getElementById('settingEmbeddingCacheExpiry');
    if (embeddingCacheExpiryEl) {
        embeddingCacheExpiryEl.value = State.settings.embeddingCacheExpiry || 7;
    }

    // Max files slider
    const maxFilesSlider = document.getElementById('settingMaxRelevantFiles');
    if (maxFilesSlider) {
        maxFilesSlider.oninput = () => {
            const valueEl = document.getElementById('maxRelevantFilesValue');
            if (valueEl) {
                valueEl.textContent = maxFilesSlider.value;
            }
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

    // --- Summarizer Settings ---
    populateSummarizerSliders();

    // --- Roles Tab ---
    populateRoleCards();

    // --- Plugins Tab ---
    populatePluginsTab();

    // --- Advanced Tab ---
    populateAdvancedParams();

    // --- Models Tab ---
    _initModelsTabEvents();

    // --- Settings tab switching ---
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
            
            // Scroll clicked tab into view
            tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            
            // Update embeddings status when switching to Context tab
            if (tab.dataset.tab === 'tabContext') {
                updateEmbeddingsStatus();
            }
            // Populate Models tab when switching to it
            if (tab.dataset.tab === 'tabModels') {
                populateModelsTab();
            }
            // Refresh Plugins tab when switching to it
            if (tab.dataset.tab === 'tabPlugins') {
                populatePluginsTab();
            }
            
            // Re-check arrow visibility after scroll settles
            setTimeout(updateTabArrows, 100);
        };
    });

    // --- Settings tab arrow buttons ---
    initTabArrows();
}

/**
 * Initialize tab arrow navigation buttons.
 * Shows/hides ‹ › arrows based on whether tabs overflow their container.
 */
function initTabArrows() {
    const container = document.querySelector('.settings-tabs');
    if (!container) return;

    // Update arrows whenever the container scrolls
    container.addEventListener('scroll', updateTabArrows);

    // Also update on resize (font changes can trigger reflow)
    let arrowRafId = null;
    const observer = new ResizeObserver(() => {
        if (arrowRafId) return;
        arrowRafId = requestAnimationFrame(() => {
            updateTabArrows();
            arrowRafId = null;
        });
    });
    observer.observe(container);

    // Initial state
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

/**
 * Scroll settings tabs left (-1) or right (+1).
 * Scrolls by roughly 2 tab widths per click.
 */
window.scrollSettingsTabs = function(direction) {
    const container = document.querySelector('.settings-tabs');
    if (!container) return;

    // Scroll by ~2 tab widths
    const step = container.clientWidth * 0.6;
    container.scrollBy({ left: direction * step, behavior: 'smooth' });
};

/**
 * Populate and wire summarizer slider controls in the Context tab.
 */
function populateSummarizerSliders() {
    const sum = State.settings.summarizer || {};
    const defaults = { recentCountBase: 10, recentCountTools: 24, threshold: 30, interval: 15, maxChars: 2000 };

    const sliders = [
        { id: 'settingSumRecentBase', valueId: 'sumRecentBaseValue', key: 'recentCountBase' },
        { id: 'settingSumRecentTools', valueId: 'sumRecentToolsValue', key: 'recentCountTools' },
        { id: 'settingSumThreshold', valueId: 'sumThresholdValue', key: 'threshold' },
        { id: 'settingSumInterval', valueId: 'sumIntervalValue', key: 'interval' },
        { id: 'settingSumMaxChars', valueId: 'sumMaxCharsValue', key: 'maxChars' },
    ];

    for (const s of sliders) {
        const el = document.getElementById(s.id);
        const valEl = document.getElementById(s.valueId);
        if (!el) continue;

        const val = sum[s.key] != null ? sum[s.key] : defaults[s.key];
        el.value = val;
        if (valEl) valEl.textContent = val;

        el.oninput = () => {
            if (valEl) valEl.textContent = el.value;
        };
    }
}

function populateAdvancedParams() {
    const adv = State.settings.advancedParams || {};

    // Reasoning / Thinking
    const reasoningSelect = document.getElementById('settingReasoningEffort');
    if (reasoningSelect) reasoningSelect.value = adv.reasoning_effort || '';
    
    const stripThinking = document.getElementById('settingStripThinkingResponse');
    if (stripThinking) stripThinking.checked = adv.strip_thinking_response || false;
    
    const disableThinking = document.getElementById('settingDisableThinking');
    if (disableThinking) disableThinking.checked = adv.disable_thinking || false;

    // Temperature controls with bidirectional sync
    setupSliderSync('settingTemperature', 'settingTemperatureValue', adv.temperature);
    setupSliderSync('settingMinTemperature', 'settingMinTemperatureValue', adv.min_temp);
    setupSliderSync('settingMaxTemperature', 'settingMaxTemperatureValue', adv.max_temp);

    // Sampling parameters
    setupSliderSync('settingTopP', 'settingTopPValue', adv.top_p);
    setupSliderSync('settingMinP', 'settingMinPValue', adv.min_p);
    
    const topK = document.getElementById('settingTopK');
    if (topK) topK.value = adv.top_k !== undefined ? adv.top_k : '';

    // Token control
    const maxTokens = document.getElementById('settingMaxTokens');
    if (maxTokens) maxTokens.value = adv.max_tokens !== undefined ? adv.max_tokens : '';
    
    const maxCompletionTokens = document.getElementById('settingMaxCompletionTokens');
    if (maxCompletionTokens) maxCompletionTokens.value = adv.max_completion_tokens !== undefined ? adv.max_completion_tokens : '';

    // Penalty parameters
    setupSliderSync('settingFrequencyPenalty', 'settingFrequencyPenaltyValue', adv.frequency_penalty);
    setupSliderSync('settingPresencePenalty', 'settingPresencePenaltyValue', adv.presence_penalty);
    setupSliderSync('settingRepetitionPenalty', 'settingRepetitionPenaltyValue', adv.repetition_penalty);

    // Other options
    const seed = document.getElementById('settingSeed');
    if (seed) seed.value = adv.seed !== undefined ? adv.seed : '';
    
    const n = document.getElementById('settingN');
    if (n) n.value = adv.n !== undefined ? adv.n : '';
    
    const stopSequences = document.getElementById('settingStopSequences');
    if (stopSequences) stopSequences.value = adv.stop ? (Array.isArray(adv.stop) ? adv.stop.join(', ') : adv.stop) : '';
    
    const logprobs = document.getElementById('settingLogprobs');
    if (logprobs) logprobs.checked = adv.logprobs || false;

    // Provider-specific parameters (dynamic from settingsSchema)
    renderProviderSettings();
}

/**
 * Setup bidirectional sync between slider and number input
 */
function setupSliderSync(sliderId, inputId, value) {
    const slider = document.getElementById(sliderId);
    const input = document.getElementById(inputId);
    
    if (!slider || !input) return;

    // Set initial values
    if (value !== undefined && value !== null && value !== '') {
        slider.value = value;
        input.value = value;
    } else {
        slider.value = slider.min;
        input.value = '';
    }

    // Sync slider -> input
    slider.oninput = () => {
        input.value = slider.value;
    };

    // Sync input -> slider
    input.oninput = () => {
        const val = parseFloat(input.value);
        if (!isNaN(val)) {
            slider.value = Math.max(slider.min, Math.min(slider.max, val));
        }
    };
}

/**
 * Render provider-specific settings fields dynamically from settingsSchema.
 * Called on provider change and initial load.
 */
function renderProviderSettings() {
    const section = document.getElementById('providerParamsSection');
    const title = document.getElementById('providerParamsTitle');
    const subtitle = document.getElementById('providerParamsSubtitle');
    const container = document.getElementById('providerParamsFields');
    if (!section || !container) return;

    const providerSelect = document.getElementById('settingApiProvider');
    const providerId = providerSelect?.value || State.settings.apiProvider || 'openai';
    const provider = ProviderRegistry.get(providerId);
    const schema = provider.settingsSchema || {};

    // Hide section if provider has no settings schema (e.g. base OpenAI)
    if (Object.keys(schema).length === 0) {
        section.style.display = 'none';
        return;
    }

    // Show section with provider name
    section.style.display = 'block';
    if (title) title.textContent = `${provider.name} Parameters`;
    if (subtitle) subtitle.textContent = `These only apply when API Provider is set to ${provider.name}`;

    // Get current values from the provider's settings key
    const settingsKey = provider.settingsKey;
    const currentValues = settingsKey ? (State.settings[settingsKey] || {}) : {};

    // Generate form fields from schema
    const html = [];
    for (const [key, field] of Object.entries(schema)) {
        const fieldId = `settingProvider_${providerId}_${key}`;
        const value = currentValues[key] !== undefined ? currentValues[key] : field.default;

        switch (field.type) {
            case 'boolean':
                html.push(`
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="${fieldId}" 
                                data-provider-key="${key}"
                                ${value ? 'checked' : ''}>
                            ${field.label}
                        </label>
                        ${field.description ? `<small style="display: block; color: var(--text-muted); margin-top: 2px;">${field.description}</small>` : ''}
                    </div>
                `);
                break;

            case 'select':
                const options = (field.options || []).map(opt => {
                    const optValue = typeof opt === 'object' ? opt.value : opt;
                    const optLabel = typeof opt === 'object' ? opt.label : opt;
                    const selected = String(value) === String(optValue) ? 'selected' : '';
                    return `<option value="${optValue}" ${selected}>${optLabel}</option>`;
                }).join('');
                html.push(`
                    <div class="form-group">
                        <label for="${fieldId}">${field.label}:</label>
                        <select id="${fieldId}" data-provider-key="${key}">
                            ${options}
                        </select>
                        ${field.description ? `<small style="display: block; color: var(--text-muted); margin-top: 2px;">${field.description}</small>` : ''}
                    </div>
                `);
                break;

            case 'text':
                html.push(`
                    <div class="form-group">
                        <label for="${fieldId}">${field.label}:</label>
                        <input type="text" id="${fieldId}" 
                            data-provider-key="${key}"
                            value="${value || ''}" 
                            placeholder="${field.placeholder || ''}">
                        ${field.description ? `<small style="display: block; color: var(--text-muted); margin-top: 2px;">${field.description}</small>` : ''}
                    </div>
                `);
                break;

            case 'number':
                html.push(`
                    <div class="form-group">
                        <label for="${fieldId}">${field.label}:</label>
                        <input type="number" id="${fieldId}" 
                            data-provider-key="${key}"
                            value="${value || ''}" 
                            ${field.min !== undefined ? `min="${field.min}"` : ''}
                            ${field.max !== undefined ? `max="${field.max}"` : ''}
                            ${field.step !== undefined ? `step="${field.step}"` : ''}
                            placeholder="${field.placeholder || ''}">
                        ${field.description ? `<small style="display: block; color: var(--text-muted); margin-top: 2px;">${field.description}</small>` : ''}
                    </div>
                `);
                break;
        }
    }

    container.innerHTML = html.join('');
}

/**
 * Collect provider-specific settings from the dynamically rendered form.
 * Returns the collected object and the settings key to store it under.
 */
function collectProviderSettings() {
    const providerSelect = document.getElementById('settingApiProvider');
    const providerId = providerSelect?.value || State.settings.apiProvider || 'openai';
    const provider = ProviderRegistry.get(providerId);
    const schema = provider.settingsSchema || {};
    const settingsKey = provider.settingsKey;

    if (!settingsKey || Object.keys(schema).length === 0) {
        return { settingsKey: null, values: {} };
    }

    const values = {};
    const container = document.getElementById('providerParamsFields');
    if (!container) return { settingsKey, values };

    for (const [key, field] of Object.entries(schema)) {
        const fieldId = `settingProvider_${providerId}_${key}`;
        const el = document.getElementById(fieldId);
        if (!el) continue;

        switch (field.type) {
            case 'boolean':
                values[key] = el.checked;
                break;
            case 'select':
                values[key] = el.value;
                break;
            case 'text':
                values[key] = el.value;
                break;
            case 'number':
                values[key] = el.value ? parseFloat(el.value) : null;
                break;
        }
    }

    return { settingsKey, values };
}

function updateEmbeddingsStatus() {
    const statusText = document.getElementById('embeddingsStatusText');
    if (!statusText) return;

    const stats = ContextManager.getStats();
    const clientStats = EmbeddingsClient.getCacheStats();
    const modelName = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
    const mode = modelName.startsWith('Xenova/') ? 'Local (Browser)' : 'Remote (API)';
    const modeIcon = modelName.startsWith('Xenova/') ? '🏠' : '☁️';

    if (!State.settings.useEmbeddings) {
        statusText.innerHTML = '❌ Embeddings disabled';
    } else if (stats.filesIndexed === 0) {
        statusText.innerHTML = `⏳ No files indexed yet. Will index on next project load.<br>
            ${modeIcon} <strong>${mode}</strong> mode selected`;
    } else {
        statusText.innerHTML = `
            ✅ <strong>${stats.filesIndexed} files</strong> indexed<br>
            📁 Project: <code>${stats.project || 'None'}</code><br>
            🤖 Model: <code>${State.settings.embeddingModel}</code><br>
            ${modeIcon} Mode: <strong>${mode}</strong><br>
            ${stats.isIndexing ? '⏳ <em>Indexing in progress...</em>' : ''}
        `;
    }
}

// ============================================
// CONNECTIONS TAB
// ============================================

/** Currently editing connection ID (null = new) */
let _editingConnectionId = null;

/**
 * Initialize the Connections tab: render list, wire up buttons.
 */
function initConnectionsTab() {
    renderConnectionsList();

    const addBtn = document.getElementById('btnAddConnection');
    if (addBtn) addBtn.onclick = () => showConnectionEditor(null);

    const cancelBtn = document.getElementById('btnCancelConnection');
    if (cancelBtn) cancelBtn.onclick = hideConnectionEditor;

    const saveBtn = document.getElementById('btnSaveConnection');
    if (saveBtn) saveBtn.onclick = saveConnectionFromEditor;

    const testBtn = document.getElementById('btnTestConnection');
    if (testBtn) testBtn.onclick = testConnectionFromEditor;

    // Hide URL field when provider has a fixed URL
    const providerSelect = document.getElementById('connEditProvider');
    if (providerSelect) {
        providerSelect.onchange = () => {
            const provider = GitProviderRegistry.get(providerSelect.value);
            const urlGroup = document.getElementById('connEditUrlGroup');
            if (urlGroup && provider) {
                if (provider.fixedUrl) {
                    urlGroup.style.display = 'none';
                    document.getElementById('connEditUrl').value = provider.fixedUrl;
                } else {
                    urlGroup.style.display = '';
                }
            }
        };
    }
}

/**
 * Render the connections list from the GitProviderRegistry.
 */
function renderConnectionsList() {
    const container = document.getElementById('connectionsList');
    if (!container) return;

    const connections = GitProviderRegistry.listConnections();

    if (connections.length === 0) {
        container.innerHTML = `
            <div class="connections-empty">
                <div class="connections-empty-icon">🔌</div>
                <div>No connections configured yet.</div>
                <div style="margin-top: 0.25rem; font-size: var(--font-sm);">Add a git provider to get started.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = connections.map(conn => {
        const provider = GitProviderRegistry.get(conn.provider);
        const icon = provider ? provider.icon : '📦';
        const providerName = provider ? provider.name : conn.provider;
        const disabledClass = conn.enabled ? '' : ' disabled';
        const statusDot = conn.enabled
            ? '<span style="color: var(--success);" title="Enabled">●</span>'
            : '<span style="color: var(--text-muted);" title="Disabled">○</span>';

        return `
            <div class="connection-card${disabledClass}" data-conn-id="${escapeAttr(conn.id)}">
                <div class="connection-card-icon">${icon}</div>
                <div class="connection-card-info">
                    <div class="connection-card-label">${statusDot} ${escapeHtml(conn.label)}</div>
                    <div class="connection-card-meta">${escapeHtml(providerName)} · ${escapeHtml(conn.url || '—')}</div>
                </div>
                <div class="connection-card-actions">
                    <button onclick="window._editConnection('${escapeAttr(conn.id)}')" title="Edit">✏️</button>
                    <button class="danger" onclick="window._removeConnection('${escapeAttr(conn.id)}')" title="Remove">🗑️</button>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Show the connection editor form for adding or editing.
 * @param {string|null} connId - null = new connection
 */
function showConnectionEditor(connId) {
    _editingConnectionId = connId;
    const editor = document.getElementById('connectionEditor');
    const title = document.getElementById('connectionEditorTitle');
    const result = document.getElementById('connectionTestResult');
    if (!editor) return;

    // Populate provider dropdown
    const providerSelect = document.getElementById('connEditProvider');
    const providers = GitProviderRegistry.list();
    providerSelect.innerHTML = providers.map(p =>
        `<option value="${escapeAttr(p.id)}">${p.icon} ${escapeHtml(p.name)}</option>`
    ).join('');

    if (connId) {
        // Edit existing
        const conn = GitProviderRegistry.getConnection(connId);
        if (!conn) return;
        title.textContent = `Edit: ${conn.label}`;
        document.getElementById('connEditId').value = conn.id;
        providerSelect.value = conn.provider;
        document.getElementById('connEditLabel').value = conn.label;
        document.getElementById('connEditUrl').value = conn.url;
        document.getElementById('connEditToken').value = conn.token;
        document.getElementById('connEditEnabled').checked = conn.enabled;
        providerSelect.disabled = true; // Don't allow changing provider of existing connection
    } else {
        // New connection
        title.textContent = 'New Connection';
        document.getElementById('connEditId').value = '';
        document.getElementById('connEditLabel').value = '';
        document.getElementById('connEditUrl').value = '';
        document.getElementById('connEditToken').value = '';
        document.getElementById('connEditEnabled').checked = true;
        providerSelect.disabled = false;
    }

    // Trigger provider change to show/hide URL field
    providerSelect.dispatchEvent(new Event('change'));

    // Reset test result
    if (result) result.style.display = 'none';

    editor.style.display = 'block';
    document.getElementById('btnAddConnection').style.display = 'none';

    // Focus the label field
    setTimeout(() => document.getElementById('connEditLabel').focus(), 50);
}

function hideConnectionEditor() {
    const editor = document.getElementById('connectionEditor');
    if (editor) editor.style.display = 'none';
    document.getElementById('btnAddConnection').style.display = '';
    _editingConnectionId = null;
}

/**
 * Save the connection being edited (add or update).
 */
function saveConnectionFromEditor() {
    const providerId = document.getElementById('connEditProvider').value;
    const label = document.getElementById('connEditLabel').value.trim();
    const url = document.getElementById('connEditUrl').value.trim();
    const token = document.getElementById('connEditToken').value.trim();
    const enabled = document.getElementById('connEditEnabled').checked;

    if (!label) {
        window.showToast('Connection label is required', 'warning');
        return;
    }
    if (!token) {
        window.showToast('API token is required', 'warning');
        return;
    }

    const provider = GitProviderRegistry.get(providerId);
    const finalUrl = provider?.fixedUrl || url;
    if (!finalUrl) {
        window.showToast('URL is required for this provider', 'warning');
        return;
    }

    try {
        if (_editingConnectionId) {
            // Update existing
            GitProviderRegistry.updateConnection(_editingConnectionId, {
                label, url: finalUrl, token, enabled
            });
            window.showToast(`Updated: ${label}`, 'success');
        } else {
            // Generate a slug ID from label
            const id = label.toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                || `conn-${Date.now()}`;

            // Check for duplicate ID
            if (GitProviderRegistry.getConnection(id)) {
                GitProviderRegistry.addConnection({
                    id: `${id}-${Date.now()}`,
                    provider: providerId,
                    label, url: finalUrl, token, enabled
                });
            } else {
                GitProviderRegistry.addConnection({
                    id, provider: providerId,
                    label, url: finalUrl, token, enabled
                });
            }
            window.showToast(`Added: ${label}`, 'success');
        }

        // Persist immediately
        State.settings.connections = GitProviderRegistry.listConnections();
        coreSaveSettings();

        hideConnectionEditor();
        renderConnectionsList();
    } catch (err) {
        console.error('[Settings] Connection save error:', err);
        window.showToast(`Error: ${err.message}`, 'error');
    }
}

/**
 * Test the connection configured in the editor form.
 */
async function testConnectionFromEditor() {
    const providerId = document.getElementById('connEditProvider').value;
    const url = document.getElementById('connEditUrl').value.trim();
    const token = document.getElementById('connEditToken').value.trim();
    const result = document.getElementById('connectionTestResult');

    const provider = GitProviderRegistry.get(providerId);
    if (!provider) {
        showTestResult(result, 'error', '❌ Unknown provider');
        return;
    }

    const finalUrl = provider.fixedUrl || url;
    if (!finalUrl || !token) {
        showTestResult(result, 'error', '❌ URL and token are required');
        return;
    }

    showTestResult(result, 'info', '⏳ Testing connection…');

    try {
        const testConn = { url: finalUrl, token };
        const repos = await provider.listRepos(testConn);
        showTestResult(result, 'success',
            `✅ Connected! Found ${repos.length} repo${repos.length !== 1 ? 's' : ''}.`
        );
    } catch (err) {
        const status = err.status ? ` (HTTP ${err.status})` : '';
        showTestResult(result, 'error', `❌ Failed${status}: ${err.message}`);
    }
}

function showTestResult(el, type, message) {
    if (!el) return;
    el.style.display = 'block';
    el.textContent = message;
    el.style.background = type === 'success' ? 'rgba(78, 201, 176, 0.12)'
        : type === 'error' ? 'rgba(201, 58, 58, 0.12)'
        : 'var(--bg-tertiary)';
    el.style.color = type === 'success' ? 'var(--success)'
        : type === 'error' ? 'var(--danger)'
        : 'var(--text-secondary)';
}

/**
 * Remove a connection (with confirmation).
 */
function removeConnection(connId) {
    const conn = GitProviderRegistry.getConnection(connId);
    if (!conn) return;

    if (!confirm(`Remove connection "${conn.label}"?\n\nProjects using this connection will need to be reassigned.`)) {
        return;
    }

    GitProviderRegistry.removeConnection(connId);
    State.settings.connections = GitProviderRegistry.listConnections();
    coreSaveSettings();
    renderConnectionsList();
    window.showToast(`Removed: ${conn.label}`, 'success');
}

// Expose to window for onclick handlers in rendered HTML
window._editConnection = showConnectionEditor;
window._removeConnection = removeConnection;

function populateRoleCards() {
    const container = document.getElementById('roleCards');
    if (!container) {
        console.warn('[Settings] roleCards container not found, skipping role cards population');
        return;
    }
    
    const currentRole = State.settings.role || 'full';
    
    container.innerHTML = Roles.list().map(role => `
        <div class="role-card ${role.id === currentRole ? 'active' : ''}" data-role="${role.id}">
            <div class="role-card-icon">${role.icon}</div>
            <div class="role-card-name">${role.name}</div>
            <div class="role-card-desc">${role.description}</div>
        </div>
    `).join('');

    // Click handlers
    container.querySelectorAll('.role-card').forEach(card => {
        card.onclick = () => {
            container.querySelectorAll('.role-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            updateRoleToolsList(card.dataset.role);
        };
    });

    updateRoleToolsList(currentRole);
}

function updateRoleToolsList(roleId) {
    const role = Roles.get(roleId);
    const label = document.getElementById('roleToolsLabel');
    const list = document.getElementById('roleToolsList');
    
    if (!label || !list) {
        console.warn('[Settings] roleToolsLabel or roleToolsList not found, skipping tools list update');
        return;
    }
    
    label.textContent = role.name;
    
    // Get all tool definitions from registry
    const allTools = ToolRegistry.getDefinitions();
    
    if (allTools.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); padding: 0.5rem 0;">No tools loaded yet. Tools register when chat initializes.</div>';
        return;
    }
    
    // Get tools filtered for this role
    const roleTools = ToolRegistry.getToolsForRole(roleId);
    const roleToolNames = new Set(roleTools.map(t => t.function?.name || t.name));
    
    list.innerHTML = allTools.map(tool => {
        const name = tool.function?.name || tool.name;
        const desc = tool.function?.description || '';
        const enabled = roleToolNames.has(name);
        const roles = tool._registeredRoles || ['unknown'];
        
        return `<div class="role-tool-item ${enabled ? 'enabled' : 'disabled'}">
            <span>${enabled ? '✅' : '⬜'}</span>
            <span><strong>${name}</strong> — ${desc.slice(0, 60)}${desc.length > 60 ? '…' : ''}</span>
            <span style="font-size: var(--font-xs); color: var(--text-muted); margin-left: auto;">[${roles.join(', ')}]</span>
        </div>`;
    }).join('');

    // Show count
    const enabledCount = roleTools.length;
    const tokenSavings = (allTools.length - enabledCount) * 120;
    list.insertAdjacentHTML('beforeend', `
        <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--font-sm);">
            ${enabledCount} of ${allTools.length} tools active${tokenSavings > 0 ? ` · ~${tokenSavings.toLocaleString()} fewer prompt tokens vs full` : ''}
        </div>
    `);
}

function updateProviderDescription() {
    const providerSelect = document.getElementById('settingApiProvider');
    const provider = Providers.get(providerSelect.value);
    document.getElementById('providerDescription').textContent = provider?.description || '';
}

function populateCommitModelSelect() {
    const select = document.getElementById('settingCommitModel');
    
    // Guard: Settings modal not open yet, skip population
    if (!select) {
        console.log('[Settings] Commit model select not in DOM yet, skipping population');
        return;
    }
    
    const current = State.settings.commitModel || '';
    select.innerHTML = '<option value="">Same as default model</option>';
    
    State.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.selected = model.id === current;
        // Show capability badges inline
        const badges = [];
        if (model.pricing) badges.push(`$${model.pricing.input ?? '?'}/$${model.pricing.output ?? '?'}`);
        if (model.capabilities?.supportsReasoning) badges.push('🧠');
        option.textContent = model.name + (badges.length ? ` (${badges.join(' ')})` : '');
        select.appendChild(option);
    });
}

function showModelCapabilities() {
    const modelSelect = document.getElementById('settingLlmModel');
    const container = document.getElementById('modelCapabilitiesInfo');
    
    // Guard: Settings modal not open yet
    if (!modelSelect || !container) {
        return;
    }
    
    const modelId = modelSelect.value;
    const model = State.models.find(m => m.id === modelId);
    
    if (!model || !model.capabilities) {
        container.style.display = 'none';
        return;
    }
    
    const caps = model.capabilities;
    const hasAnyCap = Object.values(caps).some(v => v);
    
    if (!hasAnyCap && !model.pricing) {
        // Generic provider with no capability data
        container.style.display = 'block';
        container.innerHTML = `<div style="font-size: var(--font-sm); color: var(--text-muted);">
            ℹ️ No capability metadata available for this provider. Tool calling will be attempted and will fall back gracefully if unsupported.
        </div>`;
        return;
    }
    
    const capBadges = [];
    if (caps.supportsFunctionCalling) capBadges.push('<span class="cap-badge cap-yes">🔧 Tools</span>');
    if (caps.supportsReasoning) capBadges.push('<span class="cap-badge cap-yes">🧠 Reasoning</span>');
    if (caps.supportsVision) capBadges.push('<span class="cap-badge cap-yes">👁 Vision</span>');
    if (caps.supportsWebSearch) capBadges.push('<span class="cap-badge cap-yes">🔍 Web</span>');
    if (caps.supportsResponseSchema) capBadges.push('<span class="cap-badge cap-yes">📐 Schema</span>');
    if (caps.optimizedForCode) capBadges.push('<span class="cap-badge cap-yes">💻 Code</span>');
    if (caps.supportsAudioInput) capBadges.push('<span class="cap-badge cap-yes">🎙 Audio</span>');
    if (caps.supportsVideoInput) capBadges.push('<span class="cap-badge cap-yes">🎬 Video</span>');
    
    if (!caps.supportsFunctionCalling) capBadges.push('<span class="cap-badge cap-no">🚫 No Tools</span>');
    
    let html = `<div style="font-size: var(--font-sm);">
        <div style="margin-bottom: 0.5rem; color: var(--text-secondary); font-weight: 600;">${model.name}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.5rem;">${capBadges.join('')}</div>`;
    
    if (model.pricing) {
        html += `<div style="color: var(--text-muted); margin-top: 0.25rem;">
            💰 $${model.pricing.input}/M in · $${model.pricing.output}/M out
            ${model.pricing.cacheInput ? ` · $${model.pricing.cacheInput}/M cache` : ''}
        </div>`;
    }
    
    if (model.meta?.contextTokens) {
        html += `<div style="color: var(--text-muted);">📏 ${(model.meta.contextTokens / 1000).toFixed(0)}K context</div>`;
    }
    
    if (model.meta?.description) {
        html += `<div style="color: var(--text-muted); margin-top: 0.35rem; font-style: italic;">${model.meta.description.slice(0, 200)}</div>`;
    }
    
    html += '</div>';
    container.style.display = 'block';
    container.innerHTML = html;
}

// ============================================
// PLUGINS TAB
// ============================================

/**
 * Populate the Plugins tab with all registered plugins.
 * Shows enable/disable toggles, description, and config fields.
 */
function populatePluginsTab() {
    const container = document.getElementById('pluginsList');
    if (!container) return;

    const plugins = Plugins.list();

    if (plugins.length === 0) {
        container.innerHTML = `
            <div class="connections-empty">
                <div class="connections-empty-icon">🧩</div>
                <div>No plugins registered.</div>
                <div style="margin-top: 0.25rem; font-size: var(--font-sm);">Place plugin files in the <code>plugins/</code> directory.</div>
            </div>
        `;
        return;
    }

    container.innerHTML = plugins.map(p => {
        const disabledClass = p.enabled ? '' : ' disabled';
        const statusDot = p.enabled
            ? '<span style="color: var(--success);" title="Enabled">●</span>'
            : '<span style="color: var(--text-muted);" title="Disabled">○</span>';
        const icon = p.id.includes('billing') ? '💰' : p.id.includes('cross') ? '🔀' : p.id.includes('venice') ? '🌊' : '🧩';

        // Build config fields HTML
        const configFields = (p.configSchema || []).map(field => {
            const value = p.config?.[field.key] || '';
            const escapedValue = escapeAttr(typeof value === 'string' ? value : JSON.stringify(value));
            const type = field.type === 'password' ? 'password' : field.type === 'textarea' ? 'textarea' : 'text';

            if (type === 'textarea') {
                return `
                    <div class="form-group" style="margin-bottom: 0.5rem;">
                        <label style="font-size: var(--font-sm);">${escapeHtml(field.label)}:</label>
                        <textarea data-plugin-id="${escapeAttr(p.id)}" data-config-key="${escapeAttr(field.key)}"
                            placeholder="${escapeAttr(field.placeholder || '')}"
                            rows="3" style="width: 100%; font-size: var(--font-sm); font-family: var(--font-mono); resize: vertical;">${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</textarea>
                        ${field.help ? `<small style="color: var(--text-muted);">${escapeHtml(field.help)}</small>` : ''}
                    </div>
                `;
            }

            return `
                <div class="form-group" style="margin-bottom: 0.5rem;">
                    <label style="font-size: var(--font-sm);">${escapeHtml(field.label)}:</label>
                    <input type="${type}" data-plugin-id="${escapeAttr(p.id)}" data-config-key="${escapeAttr(field.key)}"
                        value="${escapedValue}" placeholder="${escapeAttr(field.placeholder || '')}"
                        style="font-size: var(--font-sm);">
                    ${field.help ? `<small style="color: var(--text-muted);">${escapeHtml(field.help)}</small>` : ''}
                </div>
            `;
        }).join('');

        const hasConfig = (p.configSchema || []).length > 0;

        return `
            <div class="connection-card${disabledClass}" data-plugin-card="${escapeAttr(p.id)}">
                <div class="connection-card-icon">${icon}</div>
                <div class="connection-card-info">
                    <div class="connection-card-label">${statusDot} ${escapeHtml(p.name)}</div>
                    <div class="connection-card-meta">v${escapeHtml(p.version || '1.0')}${p.author ? ` · by ${escapeHtml(p.author)}` : ''} · ${escapeHtml(p.description || '')}</div>
                </div>
                <div class="connection-card-actions">
                    ${hasConfig ? `<button data-plugin-expand="${escapeAttr(p.id)}" title="Configure">⚙️</button>` : ''}
                    <button data-plugin-toggle="${escapeAttr(p.id)}" title="${p.enabled ? 'Disable' : 'Enable'}">${p.enabled ? '✅' : '⬜'}</button>
                </div>
            </div>
            ${hasConfig ? `
            <div class="plugin-config-panel" id="pluginConfig-${escapeAttr(p.id)}" style="display: none; margin: -0.25rem 0 0.5rem 0; padding: 0.75rem; background: var(--bg-primary); border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px;">
                ${configFields}
            </div>
            ` : ''}
        `;
    }).join('');

    // Wire enable/disable toggles
    container.querySelectorAll('[data-plugin-toggle]').forEach(el => {
        el.addEventListener('click', () => {
            const pluginId = el.dataset.pluginToggle;
            const plugin = Plugins.get(pluginId);
            if (!plugin) return;
            const newState = !plugin.enabled;
            Plugins.setEnabled(pluginId, newState);
            populatePluginsTab();  // Re-render to update visual state
        });
    });

    // Wire config expand buttons
    container.querySelectorAll('[data-plugin-expand]').forEach(el => {
        el.addEventListener('click', () => {
            const panel = document.getElementById(`pluginConfig-${el.dataset.pluginExpand}`);
            if (panel) {
                panel.style.display = panel.style.display === 'none' ? '' : 'none';
            }
        });
    });

    // Wire config field changes (save on blur)
    container.querySelectorAll('[data-plugin-id][data-config-key]').forEach(el => {
        const save = () => {
            const pluginId = el.dataset.pluginId;
            const key = el.dataset.configKey;
            const currentConfig = Plugins.getConfig(pluginId);
            let value = el.tagName === 'TEXTAREA' ? el.value : el.value;
            if (el.tagName === 'TEXTAREA') {
                try { value = JSON.parse(value); } catch { /* keep as string */ }
            }
            currentConfig[key] = value;
            Plugins.setConfig(pluginId, currentConfig);
        };
        el.addEventListener('blur', save);
        el.addEventListener('change', save);
    });
}

// ============================================
// MODELS TAB
// ============================================

/**
 * Populate the Models tab with all fetched models.
 * Shows capabilities, pricing, context, and enable/disable toggles.
 */
function populateModelsTab() {
    const tbody = document.getElementById('modelsTableBody');
    if (!tbody) return;

    const models = State.models || [];
    if (models.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding: 2rem; text-align: center; color: var(--text-muted);">
            No models loaded. Fetch models from the LLM tab first.
        </td></tr>`;
        _updateModelCount();
        return;
    }

    const disabled = new Set(State.settings.disabledModels || []);
    const filterTools = document.getElementById('modelFilterTools')?.checked || false;
    const search = (document.getElementById('modelSearchInput')?.value || '').toLowerCase().trim();

    const rows = [];
    let visibleCount = 0;

    for (const model of models) {
        const caps = model.capabilities || {};
        const hasTools = !!caps.supportsFunctionCalling;
        const isEnabled = !disabled.has(model.id);

        // Apply filters
        if (filterTools && !hasTools) continue;
        if (search && !model.id.toLowerCase().includes(search) && 
            !(model.name || '').toLowerCase().includes(search)) continue;

        visibleCount++;

        // Build capability badges
        const badges = [];
        if (hasTools) badges.push('<span class="cap-badge cap-yes" title="Tool/function calling">🔧</span>');
        else badges.push('<span class="cap-badge cap-no" title="No tool support — limited editor functionality">🚫</span>');
        if (caps.supportsReasoning) badges.push('<span class="cap-badge cap-yes" title="Extended thinking">🧠</span>');
        if (caps.supportsVision) badges.push('<span class="cap-badge cap-yes" title="Vision">👁</span>');
        if (caps.optimizedForCode) badges.push('<span class="cap-badge cap-yes" title="Code-optimized">💻</span>');
        if (caps.supportsWebSearch) badges.push('<span class="cap-badge cap-yes" title="Web search">🔍</span>');

        // Pricing
        let priceCell = '<span style="color: var(--text-muted);">—</span>';
        if (model.pricing) {
            priceCell = `$${model.pricing.input ?? '?'} / $${model.pricing.output ?? '?'}`;
        }

        // Context
        let ctxCell = '<span style="color: var(--text-muted);">—</span>';
        if (model.meta?.contextTokens) {
            ctxCell = `${(model.meta.contextTokens / 1000).toFixed(0)}K`;
        }

        const rowStyle = isEnabled ? '' : 'opacity: 0.5;';
        const rowBg = !hasTools ? 'background: color-mix(in srgb, var(--bg-primary) 95%, #ff6b35);' : '';

        rows.push(`<tr style="${rowStyle} ${rowBg}" data-model-id="${model.id}">
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border);">
                <input type="checkbox" class="model-toggle" data-model-id="${model.id}" 
                    ${isEnabled ? 'checked' : ''}>
            </td>
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border);">
                <div style="font-weight: 500;">${model.name || model.id}</div>
                ${model.name !== model.id ? `<div style="font-size: var(--font-xs); color: var(--text-muted); word-break: break-all;">${model.id}</div>` : ''}
            </td>
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: center;">
                <div style="display: flex; flex-wrap: wrap; gap: 2px; justify-content: center;">${badges.join('')}</div>
            </td>
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; font-size: var(--font-sm);">
                ${priceCell}
            </td>
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; font-size: var(--font-sm);">
                ${ctxCell}
            </td>
        </tr>`);
    }

    tbody.innerHTML = rows.length > 0 ? rows.join('') : 
        `<tr><td colspan="5" style="padding: 2rem; text-align: center; color: var(--text-muted);">
            No models match the current filters.
        </td></tr>`;

    _updateModelCount(visibleCount, models.length, disabled.size);
}

function _updateModelCount(visible, total, disabledCount) {
    const label = document.getElementById('modelCountLabel');
    if (!label) return;
    if (!total) { label.textContent = ''; return; }
    const enabled = total - disabledCount;
    label.textContent = `${enabled}/${total} enabled` + (visible < total ? ` · ${visible} shown` : '');
}

function _onModelToggle(e) {
    const checkbox = e.target;
    if (!checkbox.classList.contains('model-toggle')) return;
    
    const modelId = checkbox.dataset.modelId;
    const disabled = State.settings.disabledModels || [];
    
    if (checkbox.checked) {
        State.settings.disabledModels = disabled.filter(id => id !== modelId);
    } else {
        if (!disabled.includes(modelId)) {
            State.settings.disabledModels = [...disabled, modelId];
        }
    }
    
    // Update row opacity
    const row = checkbox.closest('tr');
    if (row) row.style.opacity = checkbox.checked ? '' : '0.5';
    
    _updateModelCount(
        document.querySelectorAll('.model-toggle').length,
        (State.models || []).length,
        (State.settings.disabledModels || []).length
    );
}

function _initModelsTabEvents() {
    const container = document.getElementById('modelsListContainer');
    if (container) container.addEventListener('change', _onModelToggle);

    const filterTools = document.getElementById('modelFilterTools');
    if (filterTools) filterTools.addEventListener('change', populateModelsTab);

    const searchInput = document.getElementById('modelSearchInput');
    if (searchInput) {
        let debounce;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(populateModelsTab, 200);
        });
    }

    const btnEnableAll = document.getElementById('btnEnableAllModels');
    if (btnEnableAll) btnEnableAll.addEventListener('click', () => {
        State.settings.disabledModels = [];
        populateModelsTab();
    });

    const btnDisableAll = document.getElementById('btnDisableAllModels');
    if (btnDisableAll) btnDisableAll.addEventListener('click', () => {
        State.settings.disabledModels = (State.models || []).map(m => m.id);
        populateModelsTab();
    });

    const btnToolOnly = document.getElementById('btnEnableToolModels');
    if (btnToolOnly) btnToolOnly.addEventListener('click', () => {
        State.settings.disabledModels = (State.models || [])
            .filter(m => !m.capabilities?.supportsFunctionCalling)
            .map(m => m.id);
        populateModelsTab();
    });
}

/**
 * Helper to get numeric value from input (returns undefined if empty)
 */
function getNumericValue(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return undefined;
    const val = el.value.trim();
    if (val === '') return undefined;
    const num = parseFloat(val);
    return isNaN(num) ? undefined : num;
}

export function saveSettings() {
    // LLM settings
    State.settings.llmEndpoint = document.getElementById('settingLlmEndpoint').value.trim();
    State.settings.llmApiKey = document.getElementById('settingLlmApiKey').value.trim();
    State.settings.llmModel = document.getElementById('settingLlmModel').value.trim();
    State.settings.commitModel = document.getElementById('settingCommitModel').value.trim();
    State.settings.apiProvider = document.getElementById('settingApiProvider').value;

    // Persist connections from registry into State
    State.settings.connections = GitProviderRegistry.listConnections();

    // Timeouts (convert seconds to milliseconds)
    State.settings.llmTimeout = parseInt(document.getElementById('settingLlmTimeout').value) * 1000 || 180000;
    State.settings.toolTimeout = parseInt(document.getElementById('settingToolTimeout').value) * 1000 || 30000;
    State.settings.summaryTimeout = parseInt(document.getElementById('settingSummaryTimeout').value) * 1000 || 60000;

    // Appearance - with null checks
    State.settings.fontSize = parseInt(document.getElementById('settingFontSize').value) || 13;
    State.settings.chatFontSize = parseInt(document.getElementById('settingChatFontSize').value) || 13;
    State.settings.editorFontSize = parseInt(document.getElementById('settingEditorFontSize').value) || 14;
    
    const showLineNumbersEl = document.getElementById('settingShowLineNumbers');
    State.settings.showLineNumbers = showLineNumbersEl ? showLineNumbersEl.checked : false;
    
    const showIssuesEl = document.getElementById('settingShowIssues');
    State.settings.showIssues = showIssuesEl ? showIssuesEl.checked : false;
    
    const showPRsEl = document.getElementById('settingShowPullRequests');
    State.settings.showPullRequests = showPRsEl ? showPRsEl.checked : false;

    // Context - with null checks
    const useEmbeddingsEl = document.getElementById('settingUseEmbeddings');
    State.settings.useEmbeddings = useEmbeddingsEl ? useEmbeddingsEl.checked : false;
    
    const embeddingModelEl = document.getElementById('settingEmbeddingModel');
    State.settings.embeddingModel = embeddingModelEl ? embeddingModelEl.value.trim() : 'Xenova/all-MiniLM-L6-v2';
    
    const maxRelevantFilesEl = document.getElementById('settingMaxRelevantFiles');
    State.settings.maxRelevantFiles = maxRelevantFilesEl ? parseInt(maxRelevantFilesEl.value) || 5 : 5;
    
    const autoReindexEl = document.getElementById('settingAutoReindex');
    State.settings.autoReindex = autoReindexEl ? autoReindexEl.checked : false;
    
    const embeddingCacheExpiryEl = document.getElementById('settingEmbeddingCacheExpiry');
    State.settings.embeddingCacheExpiry = embeddingCacheExpiryEl ? parseInt(embeddingCacheExpiryEl.value) || 7 : 7;

    // Summarizer
    State.settings.summarizer = {
        recentCountBase:  parseInt(document.getElementById('settingSumRecentBase')?.value)  || 10,
        recentCountTools: parseInt(document.getElementById('settingSumRecentTools')?.value) || 24,
        threshold:        parseInt(document.getElementById('settingSumThreshold')?.value)   || 30,
        interval:         parseInt(document.getElementById('settingSumInterval')?.value)    || 15,
        maxChars:         parseInt(document.getElementById('settingSumMaxChars')?.value)    || 2000,
    };

    // Roles
    const activeRoleCard = document.querySelector('.role-card.active');
    State.settings.role = activeRoleCard ? activeRoleCard.dataset.role : 'full';

    // Advanced Parameters
    const advancedParams = {};
    
    // Reasoning / Thinking
    const reasoningEffort = document.getElementById('settingReasoningEffort')?.value;
    if (reasoningEffort) advancedParams.reasoning_effort = reasoningEffort;
    
    const stripThinking = document.getElementById('settingStripThinkingResponse');
    if (stripThinking?.checked) advancedParams.strip_thinking_response = true;
    
    const disableThinking = document.getElementById('settingDisableThinking');
    if (disableThinking?.checked) advancedParams.disable_thinking = true;

    // Temperature
    const temp = getNumericValue('settingTemperatureValue');
    if (temp !== undefined) advancedParams.temperature = temp;
    
    const minTemp = getNumericValue('settingMinTemperatureValue');
    if (minTemp !== undefined) advancedParams.min_temp = minTemp;
    
    const maxTemp = getNumericValue('settingMaxTemperatureValue');
    if (maxTemp !== undefined) advancedParams.max_temp = maxTemp;

    // Sampling
    const topP = getNumericValue('settingTopPValue');
    if (topP !== undefined) advancedParams.top_p = topP;
    
    const topK = getNumericValue('settingTopK');
    if (topK !== undefined) advancedParams.top_k = Math.floor(topK);
    
    const minP = getNumericValue('settingMinPValue');
    if (minP !== undefined) advancedParams.min_p = minP;

    // Token control
    const maxTokens = getNumericValue('settingMaxTokens');
    if (maxTokens !== undefined) advancedParams.max_tokens = Math.floor(maxTokens);
    
    const maxCompletionTokens = getNumericValue('settingMaxCompletionTokens');
    if (maxCompletionTokens !== undefined) advancedParams.max_completion_tokens = Math.floor(maxCompletionTokens);

    // Penalties
    const freqPenalty = getNumericValue('settingFrequencyPenaltyValue');
    if (freqPenalty !== undefined) advancedParams.frequency_penalty = freqPenalty;
    
    const presPenalty = getNumericValue('settingPresencePenaltyValue');
    if (presPenalty !== undefined) advancedParams.presence_penalty = presPenalty;
    
    const repPenalty = getNumericValue('settingRepetitionPenaltyValue');
    if (repPenalty !== undefined) advancedParams.repetition_penalty = repPenalty;

    // Other options
    const seed = getNumericValue('settingSeed');
    if (seed !== undefined) advancedParams.seed = Math.floor(seed);
    
    const n = getNumericValue('settingN');
    if (n !== undefined) advancedParams.n = Math.floor(n);
    
    const stopSeqInput = document.getElementById('settingStopSequences')?.value.trim();
    if (stopSeqInput) {
        advancedParams.stop = stopSeqInput.split(',').map(s => s.trim()).filter(s => s);
    }
    
    const logprobs = document.getElementById('settingLogprobs');
    if (logprobs?.checked) advancedParams.logprobs = true;

    State.settings.advancedParams = advancedParams;

    // Provider-specific parameters (dynamic from settingsSchema)
    const { settingsKey, values } = collectProviderSettings();
    if (settingsKey) {
        State.settings[settingsKey] = values;
    }

    // Sync main page role selector
    const roleSelectEl = document.getElementById('roleSelect');
    if (roleSelectEl) {
        roleSelectEl.value = State.settings.role;
    }

    coreSaveSettings();
    closeSettings();
    window.showToast('Settings saved', 'success');

    // Trigger updates in other modules
    window.dispatchEvent(new CustomEvent('settings:saved'));
}

export function populateSettingsModelSelects(models) {
    models = models || State.models;
    const disabled = new Set(State.settings.disabledModels || []);
    const enabledModels = models.filter(m => !disabled.has(m.id));
    
    // Default model select — show only enabled models
    const defaultSelect = document.getElementById('settingLlmModel');
    if (defaultSelect) {
        const currentVal = defaultSelect.value || State.settings.llmModel;
        defaultSelect.innerHTML = '<option value="">Select model...</option>';
        enabledModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.selected = m.id === currentVal;
            const hints = [];
            if (m.capabilities?.supportsFunctionCalling) hints.push('🔧');
            if (m.capabilities?.supportsReasoning) hints.push('🧠');
            if (m.pricing) hints.push(`$${m.pricing.input ?? '?'}`);
            opt.textContent = (m.name || m.id) + (hints.length ? ' (' + hints.join(' ') + ')' : '');
            defaultSelect.appendChild(opt);
        });
    }

    // Commit model select - now with null check
    populateCommitModelSelect();
}

// Fetch models specifically from settings dialog (uses current input values)
export async function fetchModelsForSettings() {
    const endpoint = document.getElementById('settingLlmEndpoint').value.trim();
    const apiKey = document.getElementById('settingLlmApiKey').value.trim();
    const provider = document.getElementById('settingApiProvider').value;
    
    if (!endpoint || !apiKey) {
        window.showToast('Please enter API endpoint and key first', 'warning');
        return;
    }
    
    try {
        // Temporarily set the values for the API call
        const origEndpoint = State.settings.llmEndpoint;
        const origApiKey = State.settings.llmApiKey;
        const origProvider = State.settings.apiProvider;
        
        State.settings.llmEndpoint = endpoint;
        State.settings.llmApiKey = apiKey;
        State.settings.apiProvider = provider;
        
        const models = await LLM.listModels();
        
        // Restore original values (user hasn't saved yet)
        State.settings.llmEndpoint = origEndpoint;
        State.settings.llmApiKey = origApiKey;
        State.settings.apiProvider = origProvider;
        
        // Populate both model selects in settings
        populateSettingsModelSelects(models);
        
        // Trigger capabilities display
        showModelCapabilities();
        
        // Refresh Models tab if it's visible
        populateModelsTab();
        
        window.showToast(`Found ${models.length} models`, 'success');
    } catch (error) {
        console.error('Failed to fetch models:', error);
        window.showToast('Failed to fetch models: ' + error.message, 'error');
    }
}

/**
 * Fetch embedding models from API and populate the embedding model input/datalist
 */
export async function fetchEmbeddingModelsForSettings() {
    const endpoint = document.getElementById('settingLlmEndpoint').value.trim();
    const apiKey = document.getElementById('settingLlmApiKey').value.trim();
    
    if (!endpoint || !apiKey) {
        window.showToast('Please enter API endpoint and key first', 'warning');
        return;
    }
    
    try {
        // Temporarily set the values for the API call
        const origEndpoint = State.settings.llmEndpoint;
        const origApiKey = State.settings.llmApiKey;
        
        State.settings.llmEndpoint = endpoint;
        State.settings.llmApiKey = apiKey;
        
        const embeddingModels = await LLM.listEmbeddingModels();
        
        // Restore original values (user hasn't saved yet)
        State.settings.llmEndpoint = origEndpoint;
        State.settings.llmApiKey = origApiKey;
        
        if (embeddingModels.length === 0) {
            window.showToast('No embedding models found. You can still enter a model ID manually or use local Xenova/* models.', 'warning');
            return;
        }
        
        // Populate the datalist with API models
        const datalist = document.getElementById('embeddingModelsList');
        if (datalist) {
            // Keep the local models, add API models
            const localModels = [
                { id: 'Xenova/all-MiniLM-L6-v2', name: 'all-MiniLM-L6-v2 (Local, ~23MB)' },
                { id: 'Xenova/bge-small-en-v1.5', name: 'bge-small-en-v1.5 (Local, ~33MB)' },
                { id: 'Xenova/bge-base-en-v1.5', name: 'bge-base-en-v1.5 (Local, ~130MB)' }
            ];
            
            const allModels = [
                ...localModels.map(m => `<option value="${m.id}">${m.name}</option>`),
                ...embeddingModels.map(m => `<option value="${m.id}">${m.name || m.id} (API)</option>`)
            ];
            
            datalist.innerHTML = allModels.join('');
        }
        
        window.showToast(`Found ${embeddingModels.length} API embedding model(s)`, 'success');
    } catch (error) {
        console.error('Failed to fetch embedding models:', error);
        window.showToast('Failed to fetch embedding models: ' + error.message, 'error');
    }
}

// ============================================
// SETTINGS EXPORT/IMPORT
// ============================================

/**
 * Export all settings to JSON file for backup/transfer
 */
export function exportSettings() {
    const settings = {
        // Git Connections
        connections: State.settings.connections || [],
        
        // LLM Configuration
        llmEndpoint: State.settings.llmEndpoint,
        llmApiKey: State.settings.llmApiKey,
        llmModel: State.settings.llmModel,
        commitModel: State.settings.commitModel,
        apiProvider: State.settings.apiProvider,
        
        // Timeouts
        llmTimeout: State.settings.llmTimeout,
        toolTimeout: State.settings.toolTimeout,
        summaryTimeout: State.settings.summaryTimeout,
        
        // Embeddings
        useEmbeddings: State.settings.useEmbeddings,
        embeddingModel: State.settings.embeddingModel,
        embeddingMode: State.settings.embeddingMode,
        embeddingCacheExpiry: State.settings.embeddingCacheExpiry,
        autoReindex: State.settings.autoReindex,
        maxRelevantFiles: State.settings.maxRelevantFiles,
        
        // Appearance
        theme: State.settings.theme,
        fontSize: State.settings.fontSize,
        editorFontSize: State.settings.editorFontSize,
        showLineNumbers: State.settings.showLineNumbers,
        showIssues: State.settings.showIssues,
        showPullRequests: State.settings.showPullRequests,
        
        // Advanced Parameters
        advancedParams: State.settings.advancedParams,
        
        // Provider-specific parameters (all registered providers)
        veniceParameters: State.settings.veniceParameters,
        openRouterParameters: State.settings.openRouterParameters,
        
        // Other
        role: State.settings.role,
        disabledModels: State.settings.disabledModels || [],
        
        // Metadata
        exportedAt: new Date().toISOString(),
        exportedFrom: 'AI Editor',
        version: '1.0'
    };

    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-editor-settings-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('[Settings] Exported settings');
    window.showToast('Settings exported successfully', 'success');
}

/**
 * Import settings from JSON file
 */
export async function importSettings() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) {
                reject(new Error('No file selected'));
                return;
            }

            try {
                const text = await file.text();
                const imported = JSON.parse(text);

                // Validate it looks like a settings file (has at least one recognizable key)
                const knownKeys = ['connections', 'giteaUrl', 'llmEndpoint', 'llmApiKey', 'apiProvider', 'llmModel', 'role', 'fontSize', 'advancedParams'];
                const hasValidKey = knownKeys.some(k => k in imported);
                if (!hasValidKey) {
                    throw new Error('Invalid settings file: no recognized settings keys found');
                }

                // Apply settings (excluding metadata)
                const { exportedAt, exportedFrom, version, ...settingsToApply } = imported;
                Object.assign(State.settings, settingsToApply);

                // Save to localStorage
                Storage.set('settings', State.settings);

                console.log('[Settings] Imported settings from:', file.name);
                window.showToast('Settings imported successfully! Reloading...', 'success');
                
                // Reload to apply all settings
                setTimeout(() => location.reload(), 1500);
                
                resolve(imported);
            } catch (error) {
                console.error('[Settings] Import failed:', error);
                window.showToast(`Import failed: ${error.message}`, 'error');
                reject(error);
            }
        };

        input.click();
    });
}

// Expose to window for button onclick handlers
window.exportSettings = exportSettings;
window.importSettings = importSettings;
window.fetchModelsForSettings = fetchModelsForSettings;
window.fetchEmbeddingModelsForSettings = fetchEmbeddingModelsForSettings;
