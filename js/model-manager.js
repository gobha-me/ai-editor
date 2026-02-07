// ============================================
// MODEL MANAGER
// ============================================

import { State, Storage, Roles, EventBus } from './core.js';
import { LLM } from './llm.js';
import { populateSettingsModelSelects } from './settings-manager.js';

export async function fetchModels() {
    try {
        const models = await LLM.listModels();
        const select = document.getElementById('modelSelect');
        
        select.innerHTML = '<option value="">Select model...</option>';
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            // Show friendly name + key capability hints
            const hints = [];
            if (model.capabilities?.supportsFunctionCalling) hints.push('🔧');
            if (model.capabilities?.supportsReasoning) hints.push('🧠');
            if (model.capabilities?.supportsVision) hints.push('👁');
            if (model.capabilities?.optimizedForCode) hints.push('💻');
            const suffix = hints.length ? ' ' + hints.join('') : '';
            option.textContent = (model.name || model.id) + suffix;
            select.appendChild(option);
        });

        // Set the selected model
        if (State.settings.llmModel && models.find(m => m.id === State.settings.llmModel)) {
            select.value = State.settings.llmModel;
        } else if (models.length > 0) {
            select.value = models[0].id;
            State.settings.llmModel = models[0].id;
            Storage.set('settings', State.settings);
        }
        
        // Also populate the settings selects
        populateSettingsModelSelects(models);
        updateModelStatusBar();
        
        window.showToast(`Loaded ${models.length} models`, 'success');
    } catch (error) {
        console.error('Failed to fetch models:', error);
        window.showToast('Failed to fetch models', 'error');
    }
}

export function onModelChange(e) {
    State.settings.llmModel = e.target.value;
    Storage.set('settings', State.settings);
    updateModelStatusBar();
}

export function updateModelStatusBar() {
    const bar = document.getElementById('modelStatusBar');
    const model = State.models.find(m => m.id === State.settings.llmModel);
    const role = Roles.get(State.settings.role);
    
    const badges = [];

    // Role badge
    if (role && role.id !== 'full') {
        badges.push(`<span class="cap-badge cap-yes">${role.icon} ${role.name}</span>`);
    }
    
    if (model && model.capabilities) {
        const caps = model.capabilities;
        if (caps.supportsFunctionCalling) {
            badges.push('<span class="cap-badge cap-yes">🔧 Tools</span>');
        } else {
            badges.push('<span class="cap-badge cap-no">🚫 Tools</span>');
        }
        if (caps.supportsReasoning) badges.push('<span class="cap-badge cap-yes">🧠 Think</span>');
        if (caps.supportsVision) badges.push('<span class="cap-badge cap-yes">👁 Vision</span>');
        if (caps.optimizedForCode) badges.push('<span class="cap-badge cap-yes">💻 Code</span>');
        if (model.pricing) {
            badges.push(`<span class="cap-badge cap-neutral">$${model.pricing.input}/$${model.pricing.output}</span>`);
        }
        if (model.meta?.contextTokens) {
            badges.push(`<span class="cap-badge cap-neutral">${(model.meta.contextTokens / 1000).toFixed(0)}K</span>`);
        }
    }
    
    bar.innerHTML = badges.join('');
    bar.style.display = badges.length ? 'flex' : 'none';
}

// ============================================
// ROLE SELECTOR (Chat Panel)
// ============================================

export function populateRoleSelector() {
    const select = document.getElementById('roleSelect');
    select.innerHTML = Roles.list().map(role =>
        `<option value="${role.id}" ${role.id === State.settings.role ? 'selected' : ''}>${role.icon} ${role.name}</option>`
    ).join('');
}

export function onRoleChange(e) {
    State.settings.role = e.target.value;
    Storage.set('settings', State.settings);
    updateModelStatusBar();

    // Also sync settings modal role cards if they exist
    const cards = document.querySelectorAll('.role-card');
    cards.forEach(c => {
        c.classList.toggle('active', c.dataset.role === e.target.value);
    });

    const role = Roles.get(e.target.value);
    window.showToast(`Role: ${role.icon} ${role.name}`, 'success');
}

// ============================================
// COST TRACKER
// ============================================

export function initCostTracker() {
    updateCostTracker();
}

export function updateCostTracker() {
    const el = document.getElementById('costTrackerText');
    const sc = State.sessionCost;
    const totalTokens = sc.totalInputTokens + sc.totalOutputTokens;

    let text = `${totalTokens.toLocaleString()} tok`;
    if (sc.totalInputTokens > 0) {
        text += ` (${sc.totalInputTokens.toLocaleString()}↓ ${sc.totalOutputTokens.toLocaleString()}↑)`;
    }

    if (sc.totalCost > 0) {
        const costStr = sc.totalCost < 0.01
            ? `$${sc.totalCost.toFixed(4)}`
            : `$${sc.totalCost.toFixed(3)}`;
        text += ` · <span class="cost-highlight">${costStr}</span>`;
    } else if (totalTokens > 0) {
        text += ' · pricing N/A';
    }

    text += ` · ${sc.requests} req`;
    el.innerHTML = text;
}

export function resetSessionCost() {
    State.sessionCost = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        requests: 0
    };
    updateCostTracker();
    window.showToast('Session cost reset', 'success');
}

// Setup event listener
export function initCostTrackerListener() {
    EventBus.on('cost:updated', updateCostTracker);
}
