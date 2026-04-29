// ============================================
// SETTINGS — MODELS TAB
// ============================================

import { State, Storage } from '../core.js';
import { LLM } from '../llm.js';
import { showModelCapabilities, populateCommitModelSelect } from './llm-tab.js';
import { applyModelOverrides, DEFAULT_CAPABILITIES } from '../providers/registry.js';

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
            if (m.pricing) hints.push(`${m.pricing.input ?? '?'}`);
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
    // Per 1.1.2 the embedder has its own endpoint/key inputs in
    // Settings → Embeddings. Fall back to the chat LLM inputs only if the
    // user hasn't filled the embedder inputs yet (covers the in-modal
    // first-run flow where they typed the chat creds and want the embedder
    // to mirror).
    const embeddingEndpointEl = document.getElementById('settingEmbeddingEndpoint');
    const embeddingApiKeyEl = document.getElementById('settingEmbeddingApiKey');
    const embedEndpoint = (embeddingEndpointEl?.value || '').trim();
    const embedApiKey = (embeddingApiKeyEl?.value || '').trim();
    const fallbackEndpoint = document.getElementById('settingLlmEndpoint').value.trim();
    const fallbackApiKey = document.getElementById('settingLlmApiKey').value.trim();
    const endpoint = embedEndpoint || fallbackEndpoint;
    const apiKey = embedApiKey || fallbackApiKey;

    if (!endpoint || !apiKey) {
        window.showToast('Please enter embedder endpoint and key first', 'warning');
        return;
    }

    try {
        // Temporarily set the values for the API call
        const origEndpoint = State.settings.embeddingEndpoint;
        const origApiKey = State.settings.embeddingApiKey;

        State.settings.embeddingEndpoint = endpoint;
        State.settings.embeddingApiKey = apiKey;

        const embeddingModels = await LLM.listEmbeddingModels();

        // Restore original values (user hasn't saved yet)
        State.settings.embeddingEndpoint = origEndpoint;
        State.settings.embeddingApiKey = origApiKey;
        
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
        tbody.innerHTML = `<tr><td colspan="6" style="padding: 2rem; text-align: center; color: var(--text-muted);">
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
            priceCell = `${model.pricing.input ?? '?'} / ${model.pricing.output ?? '?'}`;
        }

        // Context / output tokens
        const ctxK  = model.meta?.contextTokens ? `${(model.meta.contextTokens / 1000).toFixed(0)}K` : null;
        const outK  = model.meta?.outputTokens  ? `${(model.meta.outputTokens  / 1000).toFixed(0)}K` : null;
        let ctxCell = '<span style="color: var(--text-muted);">—</span>';
        if (ctxK || outK) {
            const parts = [];
            if (ctxK) parts.push(`<span title="Context window">${ctxK}</span>`);
            if (outK) parts.push(`<span title="Max output" style="color: var(--text-muted);">↑${outK}</span>`);
            ctxCell = parts.join(' / ');
        }

        const rowStyle = isEnabled ? '' : 'opacity: 0.5;';
        const rowBg = !hasTools ? 'background: color-mix(in srgb, var(--bg-primary) 95%, #ff6b35);' : '';
        const hasOverride = !!(State.settings.modelOverrides || {})[model.id];
        const overrideDot = hasOverride
            ? '<span title="Has custom overrides" style="color: var(--accent); margin-left: 3px;">✎</span>'
            : '';

        rows.push(`<tr style="${rowStyle} ${rowBg}" data-model-id="${model.id}">
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border);">
                <input type="checkbox" class="model-toggle" data-model-id="${model.id}" 
                    ${isEnabled ? 'checked' : ''}>
            </td>
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border);">
                <div style="font-weight: 500;">${model.name || model.id}${overrideDot}</div>
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
            <td style="padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); text-align: center;">
                <button type="button" class="model-edit-btn" data-model-id="${model.id}"
                    title="Edit capabilities &amp; context"
                    style="background:none; border:none; cursor:pointer; font-size: 0.95rem; color: var(--text-muted); padding: 0 2px;">✎</button>
            </td>
        </tr>`);
    }

    tbody.innerHTML = rows.length > 0 ? rows.join('') : 
        `<tr><td colspan="6" style="padding: 2rem; text-align: center; color: var(--text-muted);">
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

// ── Per-model edit panel ──────────────────────────────────────────────────────

/** Labels for every capability flag (matches DEFAULT_CAPABILITIES keys) */
const CAP_LABELS = {
    supportsFunctionCalling: '🔧 Tool Use',
    supportsVision:          '👁 Vision',
    supportsReasoning:       '🧠 Reasoning',
    supportsResponseSchema:  '📐 Schema',
    supportsWebSearch:       '🌐 Web Search',
    supportsAudioInput:      '🎙 Audio',
    supportsVideoInput:      '🎬 Video',
    supportsLogProbs:        '📊 LogProbs',
    optimizedForCode:        '💻 Code',
};

/** ID of the model currently open in the edit panel, or null */
let _editingModelId = null;

/**
 * Highlight the active edit row and clear any previous highlight.
 * @param {string|null} modelId
 */
function _setEditRowHighlight(modelId) {
    document.querySelectorAll('tr.model-edit-active').forEach(r => r.classList.remove('model-edit-active'));
    if (modelId) {
        const tbody = document.getElementById('modelsTableBody');
        const row = tbody?.querySelector(`tr[data-model-id="${CSS.escape(modelId)}"]`);
        if (row) row.classList.add('model-edit-active');
    }
}

/**
 * Open the edit panel for the given model ID.
 * The panel lives below the table in the HTML and is shown/hidden in place —
 * no DOM moving, so it can never be destroyed by tbody.innerHTML rewrites.
 * @param {string} modelId
 */
function _openEditPanel(modelId) {
    const model = (State.models || []).find(m => m.id === modelId);
    if (!model) return;

    _editingModelId = modelId;
    const overrides = (State.settings.modelOverrides || {})[modelId] || {};
    const mergedCaps = { ...DEFAULT_CAPABILITIES, ...(model.capabilities || {}), ...(overrides.capabilities || {}) };

    // Title
    const title = document.getElementById('modelEditPanelTitle');
    if (title) title.textContent = model.name || modelId;

    // Capability toggles
    const capsContainer = document.getElementById('modelEditCapabilities');
    if (capsContainer) {
        capsContainer.innerHTML = Object.entries(CAP_LABELS).map(([key, label]) => {
            const isOverridden = overrides.capabilities && key in overrides.capabilities;
            const checked = mergedCaps[key] ? 'checked' : '';
            const accentStyle = isOverridden ? 'color: var(--accent); font-weight: 600;' : '';
            return `<label style="display:inline-flex; align-items:center; gap:4px; font-size:var(--font-sm); cursor:pointer; ${accentStyle}">
                <input type="checkbox" class="model-edit-cap" data-cap="${key}" ${checked}> ${label}
            </label>`;
        }).join('');
    }

    // Context tokens
    const ctxInput   = document.getElementById('modelEditContextTokens');
    const ctxDefault = document.getElementById('modelEditContextDefault');
    const baseCtx    = model._baseContextTokens ?? model.meta?.contextTokens ?? null;
    const overrideCtx = typeof overrides.contextTokens === 'number' ? overrides.contextTokens : null;
    if (ctxInput) ctxInput.value = overrideCtx !== null ? overrideCtx : (baseCtx ?? '');
    if (ctxDefault) {
        ctxDefault.textContent = overrideCtx !== null
            ? `(default: ${baseCtx !== null ? Math.round(baseCtx / 1000) + 'K' : 'unknown'})`
            : baseCtx !== null ? `(${Math.round(baseCtx / 1000)}K)` : '';
        ctxDefault.style.color = overrideCtx !== null ? 'var(--accent)' : '';
    }

    // Output tokens
    const outInput   = document.getElementById('modelEditOutputTokens');
    const outDefault = document.getElementById('modelEditOutputDefault');
    const baseOut    = model._baseOutputTokens ?? model.meta?.outputTokens ?? null;
    const overrideOut = typeof overrides.outputTokens === 'number' ? overrides.outputTokens : null;
    if (outInput) outInput.value = overrideOut !== null ? overrideOut : (baseOut ?? '');
    if (outDefault) {
        outDefault.textContent = overrideOut !== null
            ? `(default: ${baseOut !== null ? Math.round(baseOut / 1000) + 'K' : 'unknown'})`
            : baseOut !== null ? `(${Math.round(baseOut / 1000)}K)` : '';
        outDefault.style.color = overrideOut !== null ? 'var(--accent)' : '';
    }

    // Show panel — it stays in place below the table, no DOM move needed
    const panel = document.getElementById('modelEditPanel');
    if (panel) panel.style.display = '';

    _setEditRowHighlight(modelId);
}

function _closeEditPanel() {
    const panel = document.getElementById('modelEditPanel');
    if (panel) panel.style.display = 'none';
    _setEditRowHighlight(null);
    _editingModelId = null;
}

function _saveEditPanel() {
    const modelId = _editingModelId;
    if (!modelId) return;
    const model = (State.models || []).find(m => m.id === modelId);
    if (!model) return;

    // Read capability toggles — only store values that differ from the base model
    const capCheckboxes = document.querySelectorAll('#modelEditCapabilities .model-edit-cap');
    const capOverrides = {};
    capCheckboxes.forEach(cb => {
        const key  = cb.dataset.cap;
        const base = (model._baseCapabilities || model.capabilities || {})[key] ?? (DEFAULT_CAPABILITIES[key] ?? false);
        if (cb.checked !== base) capOverrides[key] = cb.checked;
    });

    // Read context tokens — only store if different from base
    const ctxInput = document.getElementById('modelEditContextTokens');
    const rawCtx   = ctxInput ? parseInt(ctxInput.value, 10) : NaN;
    const baseCtx  = model._baseContextTokens ?? model.meta?.contextTokens ?? null;
    const ctxOverride = !isNaN(rawCtx) && rawCtx !== baseCtx ? rawCtx : undefined;

    // Read output tokens — only store if different from base
    const outInput = document.getElementById('modelEditOutputTokens');
    const rawOut   = outInput ? parseInt(outInput.value, 10) : NaN;
    const baseOut  = model._baseOutputTokens ?? model.meta?.outputTokens ?? null;
    const outOverride = !isNaN(rawOut) && rawOut !== baseOut ? rawOut : undefined;

    // Build override entry — omit keys that match base so storage stays minimal
    const allOverrides = State.settings.modelOverrides || {};
    const entry = {};
    if (Object.keys(capOverrides).length > 0) entry.capabilities = capOverrides;
    if (ctxOverride !== undefined) entry.contextTokens = ctxOverride;
    if (outOverride !== undefined) entry.outputTokens  = outOverride;

    if (Object.keys(entry).length > 0) {
        allOverrides[modelId] = entry;
    } else {
        delete allOverrides[modelId];
    }
    State.settings.modelOverrides = allOverrides;
    Storage.set('settings', State.settings);

    applyModelOverrides(State.models, State.settings.modelOverrides);

    _closeEditPanel();
    populateModelsTab();
    window.showToast('Model overrides saved', 'success');
}

function _resetEditPanel() {
    const modelId = _editingModelId;
    if (!modelId) return;
    const allOverrides = State.settings.modelOverrides || {};
    delete allOverrides[modelId];
    State.settings.modelOverrides = allOverrides;
    Storage.set('settings', State.settings);

    applyModelOverrides(State.models, State.settings.modelOverrides);

    _closeEditPanel();
    populateModelsTab();
    window.showToast('Model reset to defaults', 'info');
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

    // Edit panel — delegate from the stable #modelsListContainer ancestor so it
    // survives tbody.innerHTML rewrites done by populateModelsTab().
    const listContainer = document.getElementById('modelsListContainer');
    if (listContainer) {
        listContainer.addEventListener('click', e => {
            const btn = e.target.closest('.model-edit-btn');
            if (!btn) return;
            const modelId = btn.dataset.modelId;
            if (_editingModelId === modelId) {
                _closeEditPanel();
            } else {
                _openEditPanel(modelId);
            }
        });
    }

    // Edit panel buttons — panel never moves so these listeners stay valid forever
    const saveBtn  = document.getElementById('modelEditSave');
    const resetBtn = document.getElementById('modelEditReset');
    const closeBtn = document.getElementById('modelEditPanelClose');
    if (saveBtn)  saveBtn.addEventListener('click', _saveEditPanel);
    if (resetBtn) resetBtn.addEventListener('click', _resetEditPanel);
    if (closeBtn) closeBtn.addEventListener('click', _closeEditPanel);
}