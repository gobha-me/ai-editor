// ============================================
// MODEL MANAGER
// ============================================

import { State, Storage, EventBus, ProviderRegistry, Plugins } from './core.js';
import { Profiles } from './profiles/registry.js';
import { ConversationManager } from './chat/conversations.js';
import { applyModelOverrides } from './providers/registry.js';
import { escapeHtml, escapeAttr } from './utils/html.js';
import { LLM } from './llm.js';
import { populateSettingsModelSelects } from './settings-manager.js';
import { Icon } from './ui/icons.js';

export async function fetchModels() {
    try {
        const models = await LLM.listModels();
        const select = document.getElementById('modelSelect');
        const disabled = new Set(State.settings.disabledModels || []);
        const enabledModels = models.filter(m => !disabled.has(m.id));
        
        select.innerHTML = '<option value="">Select model...</option>';
        enabledModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            // 1.3.11: capability hints moved out of the option text into
            // the Lucide-rendered status bar above the chat input. Option
            // elements are plain-text-only and can't render SVG.
            option.textContent = model.name || model.id;
            select.appendChild(option);
        });

        // Set the selected model
        if (State.settings.llmModel && enabledModels.find(m => m.id === State.settings.llmModel)) {
            select.value = State.settings.llmModel;
        } else if (enabledModels.length > 0) {
            select.value = enabledModels[0].id;
            State.settings.llmModel = enabledModels[0].id;
            Storage.set('settings', State.settings);
        }
        
        // Also populate the settings selects
        populateSettingsModelSelects(models);
        updateModelStatusBar();
        
        // B2: Now that the API connection is verified, start balance polling
        startBalancePolling();
        
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
    EventBus.emit('model:changed', { modelId: e.target.value });
    Plugins.runHook('onModelChange', { model: e.target.value });
}

export function updateModelStatusBar() {
    const bar = document.getElementById('modelStatusBar');
    const model = State.models.find(m => m.id === State.settings.llmModel);

    // 2.0.0 — slice 3: profile badge.
    // Pre-2.0.0 read `Roles.get(State.settings.role)` and showed the
    // role's `name` for any non-full role. Now reads the active profile;
    // shows the picker label for any non-default profile (chat.v1 is
    // the new "implicit" baseline, equivalent to the pre-2.0.0 'full'
    // hide-when-default treatment).
    //
    // 2.8.0 — `getEffectiveProfileName()` reflects the per-chat profile
    // binding (chip-selector pick) so the badge matches what the model
    // actually receives, not just the workspace default.
    const profileName = ConversationManager.getEffectiveProfileName();
    const profileEntry = Profiles.list().find(e => e.name === profileName);

    const badges = [];

    // Profile badge — hidden when on the default chat.v1
    if (profileName !== 'chat.v1') {
        const label = profileEntry ? profileEntry.label : profileName;
        badges.push(`<span class="cap-badge cap-yes">${escapeHtml(label)}</span>`);
    }

    if (model && model.capabilities) {
        const caps = model.capabilities;
        if (caps.supportsFunctionCalling) {
            badges.push(`<span class="cap-badge cap-yes">${Icon.Wrench}<span>Tools</span></span>`);
        } else {
            badges.push(`<span class="cap-badge cap-no">${Icon.X}<span>Tools</span></span>`);
        }
        if (caps.supportsReasoning) badges.push(`<span class="cap-badge cap-yes">${Icon.Brain}<span>Think</span></span>`);
        if (caps.supportsVision) badges.push(`<span class="cap-badge cap-yes">${Icon.Eye}<span>Vision</span></span>`);
        if (caps.optimizedForCode) badges.push(`<span class="cap-badge cap-yes">${Icon.Code}<span>Code</span></span>`);
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

/**
 * Re-populate the main page model dropdown from State.models,
 * filtering out disabled models. Called after settings save.
 */
function _repopulateMainModelSelect() {
    const select = document.getElementById('modelSelect');
    if (!select || !State.models?.length) return;

    const disabled = new Set(State.settings.disabledModels || []);
    const enabledModels = State.models.filter(m => !disabled.has(m.id));
    const currentVal = select.value || State.settings.llmModel;

    select.innerHTML = '<option value="">Select model...</option>';
    enabledModels.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        // Option text is rendered as plain text (no HTML), so capability
        // hints stay omitted here — the per-model edit panel and the
        // status bar above the chat input render the Lucide capability
        // badges via Icon.* (1.3.11).
        option.textContent = model.name || model.id;
        select.appendChild(option);
    });

    // Restore selection if still enabled, else pick first available
    if (enabledModels.find(m => m.id === currentVal)) {
        select.value = currentVal;
    } else if (enabledModels.length > 0) {
        select.value = enabledModels[0].id;
        State.settings.llmModel = enabledModels[0].id;
        Storage.set('settings', State.settings);
    }
    updateModelStatusBar();
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

    // Token counts — 1.3.6: pill format. Detailed breakdown lives in tooltip
    // (the pill is identity-surface; the cost dashboard / Debug slide-out
    // owns drill-down). Token count uses k-suffix for ≥10k for compactness.
    if (totalTokens > 0) {
        const tokStr = _formatTokenCount(totalTokens);
        const details = [
            `${sc.totalInputTokens.toLocaleString()}↓`,
            `${sc.totalOutputTokens.toLocaleString()}↑`
        ];
        if (sc.cachedInputTokens > 0) {
            details.push(`${sc.cachedInputTokens.toLocaleString()} cached`);
        }
        if (sc.reasoningTokens > 0) {
            details.push(`${sc.reasoningTokens.toLocaleString()} reasoning`);
        }
        // Title attribute carries the breakdown that used to live inline.
        parts.push(`<span title="${details.join(' · ')}">${tokStr} tok</span>`);
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

    // Request count dropped from the 1.3.6 pill (cost dashboard owns it).

    // Provider balance
    const bal = State.providerBalance;
    if (bal) {
        let balParts = [];

        // USD balance (from /credits endpoint or Venice)
        if (bal.usd !== null && bal.usd !== undefined) {
            balParts.push(`$${bal.usd.toFixed(2)}`);
        }

        // DIEM with balance/max and reset countdown
        if (bal.diem) {
            const d = bal.diem;
            let diemStr;
            if (d.max !== null && d.max !== undefined) {
                const pct = d.max > 0 ? (d.balance / d.max) * 100 : 100;
                const colorClass = pct < 10 ? 'cost-diem-crit' : pct < 25 ? 'cost-diem-warn' : 'cost-diem';
                diemStr = `<span class="${colorClass}">${d.balance.toFixed(2)}/${d.max.toFixed(1)} DIEM</span>`;
            } else {
                diemStr = `<span class="cost-diem">${d.balance.toFixed(2)} DIEM</span>`;
            }

            // Reset countdown
            if (d.nextEpoch) {
                const resetStr = _formatResetTime(d.nextEpoch);
                diemStr += ` <span class="cost-diem" title="Epoch resets at ${new Date(d.nextEpoch).toUTCString()}">⟳${resetStr}</span>`;
            }
            balParts.push(diemStr);
        }

        if (balParts.length > 0) {
            const tip = bal.tooltip || `Provider balance (${bal.provider})`;
            parts.push(`<span class="cost-balance" title="${tip}">${balParts.join(' · ')}</span>`);
        } else if (bal.label) {
            // Fallback: show provider-supplied label (e.g., OpenRouter usage stats)
            const tip = bal.tooltip || `Provider info (${bal.provider})`;
            parts.push(`<span class="cost-balance" title="${tip}">${bal.label}</span>`);
        }
    }

    el.innerHTML = parts.join(' · ');
}

/**
 * Format a token count for the top-bar pill — k-suffix at ≥10_000 to
 * keep the pill width bounded. 1.3.6.
 */
function _formatTokenCount(n) {
    if (n < 10_000) return n.toLocaleString();
    if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
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
    if (!State.settings.llmApiKey) {
        State.providerBalance = null;
        return null;
    }
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
        cacheReadTokens: 0,      // 1.8.5
        cacheCreationTokens: 0,  // 1.8.5
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
        if (State.settings.llmApiKey) {
            startBalancePolling();
        } else {
            stopBalancePolling();
            updateCostTracker();
        }
        // Re-populate main model dropdown (disabledModels may have changed)
        _repopulateMainModelSelect();
    });

    // B2: Don't start balance polling eagerly on init — wait for
    // fetchModels() success so we don't fire 401s against unconfigured
    // or wrong-provider endpoints on page load.
}
