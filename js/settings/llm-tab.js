// ============================================
// SETTINGS — LLM TAB
// ============================================
// Provider settings, advanced parameters, slider sync,
// summarizer sliders, and embeddings status.

import { State, Providers, ProviderRegistry, EventBus } from '../core.js';
import { ContextManager } from '../context-manager.js';
import { EmbeddingsClient } from '../embeddings-client.js';
import { ChatSummarizer } from '../chat/summarizer.js';
import { escapeHtml, escapeAttr } from '../utils/html.js';

// ── Provider description ──

export function updateProviderDescription() {
    const providerSelect = document.getElementById('settingApiProvider');
    const provider = Providers.get(providerSelect.value);
    document.getElementById('providerDescription').textContent = provider?.description || '';
}

// ── Commit model select ──

export function populateCommitModelSelect() {
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

// ── Model capabilities display ──

export function showModelCapabilities() {
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

// ── Summarizer sliders ──

export function populateSummarizerSliders() {
    const sum = State.settings.summarizer || {};
    const mode = State.settings.summarizerMode || 'balanced';
    // Migrate old values on the fly
    const effectiveMode = mode === 'auto' ? 'balanced' : mode === 'manual' ? 'custom' : mode;
    const defaults = { recentCountBase: 10, recentCountTools: 24, threshold: 30, interval: 15, maxChars: 2000 };

    // Set mode radio
    const radios = {
        aggressive:   document.getElementById('summarizerModeAggressive'),
        balanced:     document.getElementById('summarizerModeBalanced'),
        conservative: document.getElementById('summarizerModeConservative'),
        custom:       document.getElementById('summarizerModeCustom'),
    };
    // Also handle legacy radio IDs
    const legacyAuto = document.getElementById('summarizerModeAuto');
    const legacyManual = document.getElementById('summarizerModeManual');
    
    for (const [key, el] of Object.entries(radios)) {
        if (el) el.checked = (effectiveMode === key);
    }
    // Legacy fallback
    if (legacyAuto) legacyAuto.checked = false;
    if (legacyManual) legacyManual.checked = false;

    const sliders = [
        { id: 'settingSumRecentBase', valueId: 'sumRecentBaseValue', key: 'recentCountBase' },
        { id: 'settingSumRecentTools', valueId: 'sumRecentToolsValue', key: 'recentCountTools' },
        { id: 'settingSumThreshold', valueId: 'sumThresholdValue', key: 'threshold' },
        { id: 'settingSumInterval', valueId: 'sumIntervalValue', key: 'interval' },
        { id: 'settingSumMaxChars', valueId: 'sumMaxCharsValue', key: 'maxChars' },
    ];

    // Get auto-tune params for display
    let autoParams = defaults;
    let autoLabel = 'Small (<32K)';
    let contextTokens = null;
    try {
        const info = ChatSummarizer.getAutoParams();
        autoParams = info.params;
        autoLabel = info.label;
        contextTokens = info.contextTokens;
    } catch { /* ignore — use defaults */ }

    // Determine which values to show
    const isCustom = effectiveMode === 'custom';
    const activeValues = isCustom ? {} : autoParams;

    for (const s of sliders) {
        const el = document.getElementById(s.id);
        const valEl = document.getElementById(s.valueId);
        if (!el) continue;

        const val = isCustom
            ? (sum[s.key] != null ? sum[s.key] : defaults[s.key])
            : (autoParams[s.key] ?? defaults[s.key]);

        el.value = val;
        if (valEl) valEl.textContent = val;
        el.disabled = !isCustom;
        el.style.opacity = isCustom ? '1' : '0.5';

        el.oninput = () => {
            if (valEl) valEl.textContent = el.value;
        };
    }

    // Auto-tune info badge
    const infoEl = document.getElementById('summarizerAutoInfo');
    if (infoEl) {
        if (!isCustom) {
            const ctxStr = contextTokens
                ? `${(contextTokens / 1000).toFixed(0)}K tokens`
                : 'unknown (using conservative defaults)';
            const modeLabel = effectiveMode.charAt(0).toUpperCase() + effectiveMode.slice(1);
            infoEl.innerHTML = `🤖 <strong>${modeLabel}</strong> · Tier: ${autoLabel} · Context: ${ctxStr}`;
            infoEl.style.display = 'block';
        } else {
            infoEl.style.display = 'none';
        }
    }

    // Wire mode toggle (only once)
    const firstRadio = radios.aggressive || radios.balanced;
    if (firstRadio && !firstRadio._wired) {
        firstRadio._wired = true;
        const handler = (e) => {
            // Update state from the newly-selected radio before re-populating
            if (e.target?.value) {
                State.settings.summarizerMode = e.target.value;
            }
            populateSummarizerSliders();
        };
        for (const el of Object.values(radios)) {
            if (el) el.addEventListener('change', handler);
        }
    }
}

/**
 * Update auto-tuned summarizer values when the model changes.
 * Called from model-manager on model selection change.
 */
export function updateSummarizerForModel() {
    const mode = State.settings.summarizerMode || 'balanced';
    if (mode === 'custom' || mode === 'manual') return; // Custom mode — don't touch sliders

    // Re-populate if settings modal is open
    const slidersContainer = document.getElementById('summarizerSliders');
    if (slidersContainer) {
        populateSummarizerSliders();
    }
}

// ── Slider ↔ input bidirectional sync ──

export function setupSliderSync(sliderId, inputId, value) {
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

// ── Advanced parameters ──

export function populateAdvancedParams() {
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

// ── Provider-specific settings ──

export function renderProviderSettings() {
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

            case 'select': {
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
            }

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
export function collectProviderSettings() {
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

// ── Embeddings status ──

export function updateEmbeddingsStatus() {
    const statusText = document.getElementById('embeddingsStatusText');
    if (!statusText) return;

    const stats = ContextManager.getStats();
    const clientStats = EmbeddingsClient.getCacheStats();
    const modelName = State.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
    const mode = modelName.startsWith('Xenova/') ? 'Local (Browser)' : 'Remote (API)';
    const modeIcon = modelName.startsWith('Xenova/') ? '🏠' : '☁️';
    const maxIndex = State.settings.maxIndexFiles || 200;

    if (!State.settings.useEmbeddings) {
        statusText.innerHTML = '❌ Embeddings disabled';
    } else if (stats.filesIndexed === 0) {
        statusText.innerHTML = `⏳ No files indexed yet. Will index on next project load.<br>
            ${modeIcon} <strong>${mode}</strong> mode selected<br>
            📊 Limit: ${maxIndex} files max`;
    } else {
        const limitNote = stats.filesIndexed >= maxIndex
            ? `<br>⚠️ <em>At ${maxIndex}-file limit — increase "Max files to index" to cover more</em>`
            : '';
        statusText.innerHTML = `
            ✅ <strong>${stats.filesIndexed} files</strong> indexed<br>
            📁 Project: <code>${stats.project || 'None'}</code><br>
            🤖 Model: <code>${State.settings.embeddingModel}</code><br>
            ${modeIcon} Mode: <strong>${mode}</strong><br>
            📊 Limit: ${maxIndex} files max${limitNote}
            ${stats.isIndexing ? '<br>⏳ <em>Indexing in progress...</em>' : ''}
        `;
    }
}

// Auto-update summarizer sliders when the model changes
EventBus.on('model:changed', () => {
    updateSummarizerForModel();
});
