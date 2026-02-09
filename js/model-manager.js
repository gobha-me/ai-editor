// ============================================
// MODEL MANAGER
// ============================================

import { State, Storage, Roles, EventBus, ProviderRegistry } from './core.js';
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

    const parts = [];

    // Token counts
    if (totalTokens > 0) {
        let tokStr = `${totalTokens.toLocaleString()} tok`;
        const details = [];
        details.push(`${sc.totalInputTokens.toLocaleString()}↓`);
        details.push(`${sc.totalOutputTokens.toLocaleString()}↑`);
        if (sc.cachedInputTokens > 0) {
            details.push(`${sc.cachedInputTokens.toLocaleString()} cached`);
        }
        if (sc.reasoningTokens > 0) {
            details.push(`${sc.reasoningTokens.toLocaleString()} reasoning`);
        }
        tokStr += ` (${details.join(' · ')})`;
        parts.push(tokStr);
    } else {
        parts.push('0 tok');
    }

    // Cost
    if (sc.totalCost > 0) {
        const costStr = sc.totalCost < 0.01
            ? `$${sc.totalCost.toFixed(4)}`
            : `$${sc.totalCost.toFixed(3)}`;
        let costPart = `<span class="cost-highlight">${costStr}</span>`;
        // Show cache savings
        if (sc.cacheSavings > 0) {
            const savedStr = sc.cacheSavings < 0.01
                ? `$${sc.cacheSavings.toFixed(4)}`
                : `$${sc.cacheSavings.toFixed(3)}`;
            costPart += ` <span class="cost-saved" title="Saved from prompt caching">(-${savedStr})</span>`;
        }
        parts.push(costPart);
    } else if (totalTokens > 0) {
        parts.push('pricing N/A');
    }

    // Request count
    parts.push(`${sc.requests} req`);

    // Provider balance
    const bal = State.providerBalance;
    if (bal) {
        let balParts = [];

        // USD balance
        if (bal.usd !== null && bal.usd !== undefined) {
            balParts.push(`$${bal.usd.toFixed(2)}`);
        }

        // DIEM with balance/max and reset countdown
        if (bal.diem) {
            const d = bal.diem;
            const pct = d.max > 0 ? (d.balance / d.max) * 100 : 100;
            const colorClass = pct < 10 ? 'cost-diem-crit' : pct < 25 ? 'cost-diem-warn' : 'cost-diem';
            let diemStr = `<span class="${colorClass}">${d.balance.toFixed(1)}/${d.max.toFixed(1)} DIEM</span>`;

            // Reset countdown
            if (d.nextEpoch) {
                const resetStr = _formatResetTime(d.nextEpoch);
                diemStr += ` <span class="cost-diem" title="Epoch resets at ${new Date(d.nextEpoch).toUTCString()}">⟳${resetStr}</span>`;
            }
            balParts.push(diemStr);
        }

        if (balParts.length > 0) {
            parts.push(`<span class="cost-balance" title="Provider balance (${bal.provider})">${balParts.join(' · ')}</span>`);
        }
    }

    el.innerHTML = parts.join(' · ');
}

/**
 * Format a reset timestamp as a human-readable countdown or time.
 * Shows "Xh Ym" when > 1h, "Xm" when < 1h, or "HH:MM UTC" if > 24h.
 */
function _formatResetTime(isoTimestamp) {
    const now = Date.now();
    const reset = new Date(isoTimestamp).getTime();
    const diffMs = reset - now;

    if (diffMs <= 0) return 'now';

    const mins = Math.floor(diffMs / 60_000);
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;

    if (hrs >= 24) {
        // Far away — show absolute time
        const d = new Date(isoTimestamp);
        return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')} UTC`;
    } else if (hrs > 0) {
        return `${hrs}h${remMins > 0 ? remMins + 'm' : ''}`;
    } else {
        return `${mins}m`;
    }
}

/** Fetch and display provider account balance. */
export async function fetchProviderBalance() {
    try {
        const balance = await ProviderRegistry.fetchBalance(State.settings);
        State.providerBalance = balance;
        if (balance) {
            console.log(`[Balance] ${balance.provider}: ${balance.label}`);
        }
        updateCostTracker();
        return balance;
    } catch (err) {
        console.warn('[Balance] Failed to fetch:', err.message);
        return null;
    }
}

/** Balance polling interval ID */
let _balanceInterval = null;

/**
 * Start periodic balance polling.
 * Fetches immediately, then every intervalMs (default 60s).
 */
export function startBalancePolling(intervalMs = 60_000) {
    stopBalancePolling();
    fetchProviderBalance(); // Fetch immediately
    _balanceInterval = setInterval(fetchProviderBalance, intervalMs);
}

export function stopBalancePolling() {
    if (_balanceInterval) {
        clearInterval(_balanceInterval);
        _balanceInterval = null;
    }
}

export function resetSessionCost() {
    State.sessionCost = {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalCost: 0,
        cacheSavings: 0,
        requests: 0
    };
    updateCostTracker();
    window.showToast('Session cost reset', 'success');
}

// Setup event listener
export function initCostTrackerListener() {
    EventBus.on('cost:updated', updateCostTracker);

    // Re-fetch balance when settings change (provider/key may have changed)
    window.addEventListener('settings:saved', () => {
        State.providerBalance = null;
        fetchProviderBalance();
    });

    // Start balance polling if we have an API key
    if (State.settings.llmApiKey) {
        startBalancePolling();
    }
}
