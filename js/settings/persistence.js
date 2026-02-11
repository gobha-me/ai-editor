// ============================================
// SETTINGS — PERSISTENCE
// ============================================
// DOM → State collection, State → localStorage, export/import.
// This is the single file to swap when migrating to a backend API.

import { State, Storage, ProviderRegistry } from '../core.js';
import { GitProviderRegistry } from '../git-providers/index.js';
import { collectProviderSettings } from './llm-tab.js';

/**
 * Helper to get numeric value from input (returns undefined if empty).
 */
function getNumericValue(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return undefined;
    const val = el.value.trim();
    if (val === '') return undefined;
    const num = parseFloat(val);
    return isNaN(num) ? undefined : num;
}

/**
 * Collect all settings from the DOM and persist to State + localStorage.
 * Returns the settings object for potential API submission.
 */
export function collectAndSave() {
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

    // Persist to localStorage is handled by the caller (coreSaveSettings)

    return State.settings;
}

/**
 * Export all settings to JSON file for backup/transfer.
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
 * Import settings from JSON file.
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
