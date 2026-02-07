// ============================================
// SETTINGS MANAGER
// ============================================

import { State, Storage, Providers, Roles, saveSettings as coreSaveSettings } from './core.js';
import { LLM } from './llm.js';
import { ToolRegistry } from './tools/registry.js';

export function openSettings() {
    populateSettingsForm();
    document.getElementById('settingsModal').classList.add('active');
}

export function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
}

function populateSettingsForm() {
    // --- General Tab ---
    document.getElementById('settingGiteaUrl').value = State.settings.giteaUrl || '';
    document.getElementById('settingGiteaToken').value = State.settings.giteaToken || '';
    document.getElementById('settingLlmEndpoint').value = State.settings.llmEndpoint || '';
    document.getElementById('settingLlmApiKey').value = State.settings.llmApiKey || '';

    // Provider dropdown
    const providerSelect = document.getElementById('settingApiProvider');
    providerSelect.innerHTML = Providers.list().map(p =>
        `<option value="${p.id}" ${p.id === State.settings.apiProvider ? 'selected' : ''}>${p.name}</option>`
    ).join('');
    updateProviderDescription();

    // Model selects
    populateSettingsModelSelects(State.models);
    const modelSelect = document.getElementById('settingLlmModel');
    if (State.settings.llmModel) modelSelect.value = State.settings.llmModel;
    
    providerSelect.onchange = updateProviderDescription;
    modelSelect.onchange = showModelCapabilities;
    showModelCapabilities();

    // --- Appearance Tab ---
    const fontSlider = document.getElementById('settingFontSize');
    const editorFontSlider = document.getElementById('settingEditorFontSize');
    fontSlider.value = State.settings.fontSize || 13;
    editorFontSlider.value = State.settings.editorFontSize || 14;
    document.getElementById('fontSizeValue').textContent = fontSlider.value + 'px';
    document.getElementById('editorFontSizeValue').textContent = editorFontSlider.value + 'px';

    fontSlider.oninput = () => {
        document.getElementById('fontSizeValue').textContent = fontSlider.value + 'px';
        // Live preview
        document.documentElement.style.setProperty('--ui-font-size', fontSlider.value + 'px');
    };
    editorFontSlider.oninput = () => {
        document.getElementById('editorFontSizeValue').textContent = editorFontSlider.value + 'px';
        document.documentElement.style.setProperty('--editor-font-size', editorFontSlider.value + 'px');
    };

    document.getElementById('settingShowIssues').checked = State.settings.showIssues !== false;
    document.getElementById('settingShowWorkflows').checked = State.settings.showWorkflows !== false;
    document.getElementById('settingShowLineNumbers').checked = State.settings.showLineNumbers !== false;

    // --- Roles Tab ---
    populateRoleCards();

    // --- Settings tab switching ---
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
        };
    });
}

function populateRoleCards() {
    const container = document.getElementById('roleCards');
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
            <span style="font-size: 10px; color: var(--text-muted); margin-left: auto;">[${roles.join(', ')}]</span>
        </div>`;
    }).join('');

    // Show count
    const enabledCount = roleTools.length;
    const tokenSavings = (allTools.length - enabledCount) * 120;
    list.insertAdjacentHTML('beforeend', `
        <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 11px;">
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
    const modelId = document.getElementById('settingLlmModel').value;
    const model = State.models.find(m => m.id === modelId);
    const container = document.getElementById('modelCapabilitiesInfo');
    
    if (!model || !model.capabilities) {
        container.style.display = 'none';
        return;
    }
    
    const caps = model.capabilities;
    const hasAnyCap = Object.values(caps).some(v => v);
    
    if (!hasAnyCap && !model.pricing) {
        // Generic provider with no capability data
        container.style.display = 'block';
        container.innerHTML = `<div style="font-size: 11px; color: var(--text-muted);">
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
    
    let html = `<div style="font-size: 11px;">
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

export function saveSettings() {
    // General
    State.settings.giteaUrl = document.getElementById('settingGiteaUrl').value.trim();
    State.settings.giteaToken = document.getElementById('settingGiteaToken').value.trim();
    State.settings.llmEndpoint = document.getElementById('settingLlmEndpoint').value.trim();
    State.settings.llmApiKey = document.getElementById('settingLlmApiKey').value.trim();
    State.settings.llmModel = document.getElementById('settingLlmModel').value.trim();
    State.settings.commitModel = document.getElementById('settingCommitModel').value.trim();
    State.settings.apiProvider = document.getElementById('settingApiProvider').value;

    // Appearance
    State.settings.fontSize = parseInt(document.getElementById('settingFontSize').value) || 13;
    State.settings.editorFontSize = parseInt(document.getElementById('settingEditorFontSize').value) || 14;
    State.settings.showLineNumbers = document.getElementById('settingShowLineNumbers').checked;
    State.settings.showIssues = document.getElementById('settingShowIssues').checked;
    State.settings.showWorkflows = document.getElementById('settingShowWorkflows').checked;

    // Roles
    const activeRoleCard = document.querySelector('.role-card.active');
    State.settings.role = activeRoleCard ? activeRoleCard.dataset.role : 'full';

    // Sync main page role selector
    document.getElementById('roleSelect').value = State.settings.role;

    coreSaveSettings();
    closeSettings();
    window.showToast('Settings saved', 'success');

    // Trigger updates in other modules
    window.dispatchEvent(new CustomEvent('settings:saved'));
}

export function populateSettingsModelSelects(models) {
    models = models || State.models;
    
    // Default model select
    const defaultSelect = document.getElementById('settingLlmModel');
    if (defaultSelect) {
        const currentVal = defaultSelect.value || State.settings.llmModel;
        defaultSelect.innerHTML = '<option value="">Select model...</option>';
        models.forEach(m => {
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
        
        window.showToast(`Found ${models.length} models`, 'success');
    } catch (error) {
        console.error('Failed to fetch models:', error);
        window.showToast('Failed to fetch models: ' + error.message, 'error');
    }
}
