// ============================================
// SETTINGS — MODELS TAB
// ============================================

import { State } from '../core.js';
import { LLM } from '../llm.js';
import { showModelCapabilities, populateCommitModelSelect } from './llm-tab.js';

/**
 * Populate the model select dropdowns (default model + commit model).
 */
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

    // Commit model select
    populateCommitModelSelect();
}

/**
 * Fetch models from current settings dialog values.
 */
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
 * Fetch embedding models from API and populate the embedding model input/datalist.
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

// ── Models browser tab ──

/**
 * Populate the Models tab with all fetched models.
 * Shows capabilities, pricing, context, and enable/disable toggles.
 */
export function populateModelsTab() {
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

export function initModelsTabEvents() {
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
