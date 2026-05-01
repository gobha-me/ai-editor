// ============================================
// SETTINGS — PERSISTENCE
// ============================================
// DOM → State collection, State → localStorage, export/import.
// This is the single file to swap when migrating to a backend API.

import { State, Storage, ProviderRegistry } from '../core.js';
import { GitProviderRegistry } from '../git-providers/index.js';
import { MCPServerRegistry } from '../mcp/registry.js';
import { collectProviderSettings } from './llm-tab.js';
import { getInstalledPlugins } from '../plugin-loader.js';
import { getUserPlugins } from '../plugin-editor.js';
import { IgnoreManager } from '../ignore.js';
import {
    SAFELIST as WORKSPACE_SETTINGS_SAFELIST,
    isEnabled as workspaceSettingsIsEnabled,
    recordChanges as workspaceSettingsRecordChanges,
    getOriginalGlobals as workspaceSettingsGetOriginalGlobals,
} from '../intelligence/workspace-settings/index.js';

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

    // Persist MCP servers from registry into State (1.4.2)
    State.settings.mcpServers = MCPServerRegistry.serialize();

    // Timeouts (convert seconds to milliseconds)
    State.settings.llmIdleTimeout = parseInt(document.getElementById('settingLlmIdleTimeout').value) * 1000 || 90000;
    State.settings.toolTimeout = parseInt(document.getElementById('settingToolTimeout').value) * 1000 || 30000;
    State.settings.summaryTimeout = parseInt(document.getElementById('settingSummaryTimeout').value) * 1000 || 60000;

    // Appearance - with null checks
    const themeEl = document.getElementById('settingTheme');
    State.settings.theme = themeEl ? themeEl.value : (State.settings.theme || 'refined');

    State.settings.uiScale = parseInt(document.getElementById('settingUiScale').value) || 100;
    State.settings.editorFontSize = parseInt(document.getElementById('settingEditorFontSize').value) || 14;
    
    const showLineNumbersEl = document.getElementById('settingShowLineNumbers');
    State.settings.showLineNumbers = showLineNumbersEl ? showLineNumbersEl.checked : false;

    const keybindingModeEl = document.querySelector('input[name="editorKeybindingMode"]:checked');
    State.settings.editorKeybindingMode = keybindingModeEl ? keybindingModeEl.value : 'default';

    const scanInvisibleEl = document.getElementById('settingEditorScanInvisibleUnicode');
    State.settings.editorScanInvisibleUnicode = scanInvisibleEl ? scanInvisibleEl.checked : true;

    const showIssuesEl = document.getElementById('settingShowIssues');
    State.settings.showIssues = showIssuesEl ? showIssuesEl.checked : false;
    
    const showPRsEl = document.getElementById('settingShowPullRequests');
    State.settings.showPullRequests = showPRsEl ? showPRsEl.checked : false;

    // Embeddings tab — provider, endpoint, key + indexing controls
    const embeddingProviderEl = document.querySelector('input[name="embeddingProvider"]:checked');
    State.settings.embeddingProvider = embeddingProviderEl ? embeddingProviderEl.value : 'local';

    const embeddingEndpointEl = document.getElementById('settingEmbeddingEndpoint');
    State.settings.embeddingEndpoint = embeddingEndpointEl ? embeddingEndpointEl.value.trim() : '';

    const embeddingApiKeyEl = document.getElementById('settingEmbeddingApiKey');
    State.settings.embeddingApiKey = embeddingApiKeyEl ? embeddingApiKeyEl.value.trim() : '';

    const useEmbeddingsEl = document.getElementById('settingUseEmbeddings');
    State.settings.useEmbeddings = useEmbeddingsEl ? useEmbeddingsEl.checked : false;

    const embeddingModelEl = document.getElementById('settingEmbeddingModel');
    State.settings.embeddingModel = embeddingModelEl ? embeddingModelEl.value.trim() : 'Xenova/all-MiniLM-L6-v2';

    const maxRelevantFilesEl = document.getElementById('settingMaxRelevantFiles');
    State.settings.maxRelevantFiles = maxRelevantFilesEl ? parseInt(maxRelevantFilesEl.value) || 5 : 5;

    const maxIndexFilesEl = document.getElementById('settingMaxIndexFiles');
    State.settings.maxIndexFiles = maxIndexFilesEl ? parseInt(maxIndexFilesEl.value) || 200 : 200;

    const autoReindexEl = document.getElementById('settingAutoReindex');
    State.settings.autoReindex = autoReindexEl ? autoReindexEl.checked : false;

    const embeddingCacheExpiryEl = document.getElementById('settingEmbeddingCacheExpiry');
    State.settings.embeddingCacheExpiry = embeddingCacheExpiryEl ? parseInt(embeddingCacheExpiryEl.value) || 7 : 7;

    // Summarizer
    let summarizerMode = document.querySelector('input[name="summarizerMode"]:checked')?.value || 'balanced';
    // Migrate old values
    if (summarizerMode === 'auto') summarizerMode = 'balanced';
    if (summarizerMode === 'manual') summarizerMode = 'custom';
    State.settings.summarizerMode = summarizerMode;

    if (summarizerMode === 'custom') {
        State.settings.summarizer = {
            recentCountBase:  parseInt(document.getElementById('settingSumRecentBase')?.value)  || 10,
            recentCountTools: parseInt(document.getElementById('settingSumRecentTools')?.value) || 24,
            threshold:        parseInt(document.getElementById('settingSumThreshold')?.value)   || 30,
            interval:         parseInt(document.getElementById('settingSumInterval')?.value)    || 15,
            maxChars:         parseInt(document.getElementById('settingSumMaxChars')?.value)    || 2000,
        };
    }
    // In named modes, don't save slider values — they're computed from context window + mode

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

    // Ignore patterns
    const ignorePatternsEl = document.getElementById('settingIgnorePatterns');
    if (ignorePatternsEl) {
        IgnoreManager.setGlobalPatterns(ignorePatternsEl.value);
    }

    // Sync main page role selector
    const roleSelectEl = document.getElementById('roleSelect');
    if (roleSelectEl) {
        roleSelectEl.value = State.settings.role;
    }

    // Persist to localStorage is handled by the caller (coreSaveSettings)

    // 1.4.4 — route safelisted writes to .aieditor/settings.json when the
    // workspace-settings file layer is active. Pass every safelisted key;
    // the file-layer compares against its applied snapshot and only marks
    // genuinely-changed keys as pending. No-op when the layer is disabled.
    try {
        if (workspaceSettingsIsEnabled()) {
            workspaceSettingsRecordChanges(WORKSPACE_SETTINGS_SAFELIST);
        }
    } catch (err) {
        console.warn('[settings/persistence] workspace-settings recordChanges failed:', err);
    }

    return State.settings;
}

/**
 * Export all settings to JSON file for backup/transfer.
 *
 * 1.4.4 — when the workspace-settings file layer is active, the user's
 * `State.settings` reflects per-workspace overrides on top of their
 * true global values. Exporting that merged view would silently bake
 * the open project's theme/role/etc. into a "global" backup. We pull
 * the un-merged originals from the file layer for safelisted keys.
 */
export function exportSettings() {
    const wsActive = (() => {
        try { return workspaceSettingsIsEnabled(); } catch { return false; }
    })();
    const originals = wsActive ? workspaceSettingsGetOriginalGlobals() : {};
    const pickGlobal = (key) => (key in originals ? originals[key] : State.settings[key]);

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
        llmIdleTimeout: pickGlobal('llmIdleTimeout'),
        toolTimeout: pickGlobal('toolTimeout'),
        summaryTimeout: pickGlobal('summaryTimeout'),

        // Embeddings
        useEmbeddings: pickGlobal('useEmbeddings'),
        embeddingProvider: pickGlobal('embeddingProvider'),
        embeddingEndpoint: State.settings.embeddingEndpoint,
        embeddingApiKey: State.settings.embeddingApiKey,
        embeddingModel: pickGlobal('embeddingModel'),
        embeddingCacheExpiry: pickGlobal('embeddingCacheExpiry'),
        autoReindex: pickGlobal('autoReindex'),
        maxRelevantFiles: pickGlobal('maxRelevantFiles'),
        maxIndexFiles: pickGlobal('maxIndexFiles'),

        // Appearance
        theme: pickGlobal('theme'),
        uiScale: pickGlobal('uiScale'),
        editorFontSize: pickGlobal('editorFontSize'),
        showLineNumbers: pickGlobal('showLineNumbers'),
        editorKeybindingMode: pickGlobal('editorKeybindingMode'),
        editorScanInvisibleUnicode: pickGlobal('editorScanInvisibleUnicode'),
        showIssues: pickGlobal('showIssues'),
        showPullRequests: pickGlobal('showPullRequests'),

        // Advanced Parameters
        advancedParams: State.settings.advancedParams,

        // Provider-specific parameters (all registered providers)
        veniceParameters: State.settings.veniceParameters,
        openRouterParameters: State.settings.openRouterParameters,

        // Other
        role: pickGlobal('role'),
        disabledModels: State.settings.disabledModels || [],
        ignorePatterns: State.settings.ignorePatterns,
        
        // Plugins
        pluginState: Storage.get('pluginState') || {},
        installedPlugins: getInstalledPlugins().map(p => ({
            url: p.url, pluginId: p.pluginId, name: p.name
        })),
        userPlugins: getUserPlugins(),
        
        // Metadata
        exportedAt: new Date().toISOString(),
        exportedFrom: 'AI Editor',
        version: '1.1'
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

                // Invisible-Unicode scan — surface tampering before applying settings.
                // Catches glassworm / Trojan Source / zero-width injections in connection
                // URLs, API keys, plugin metadata. Permissive (warn-and-confirm) to
                // match the validator's existing style; blocking would leave Storage
                // half-written if a throw lands mid-flow.
                const { scan } = await import('../security/invisible-unicode.js');
                const findings = scan(text);
                if (findings.length > 0) {
                    const { showConfirm } = await import('../ui/dialogs.js');
                    const preview = findings.slice(0, 3)
                        .map(f => `• L${f.line}:${f.col} ${f.name}`)
                        .join('\n');
                    const proceed = await showConfirm(
                        `Settings file contains ${findings.length} invisible Unicode character(s):\n\n${preview}${findings.length > 3 ? `\n… and ${findings.length - 3} more` : ''}\n\nThese may indicate tampering (glassworm, Trojan Source). See docs/SECURITY.md.\n\nContinue with import?`,
                        { title: 'Invisible Unicode detected', okLabel: 'Import anyway', variant: 'danger' }
                    );
                    if (!proceed) {
                        window.showToast?.('Import cancelled', 'info');
                        reject(new Error('Import cancelled by user'));
                        return;
                    }
                }

                const imported = JSON.parse(text);

                // Validate it looks like a settings file (has at least one recognizable key)
                const knownKeys = ['connections', 'giteaUrl', 'llmEndpoint', 'llmApiKey', 'apiProvider', 'llmModel', 'role', 'uiScale', 'fontSize', 'advancedParams', 'pluginState', 'userPlugins', 'embeddingProvider', 'embeddingEndpoint', 'embeddingApiKey'];
                const hasValidKey = knownKeys.some(k => k in imported);
                if (!hasValidKey) {
                    throw new Error('Invalid settings file: no recognized settings keys found');
                }

                // Apply settings (excluding metadata and plugin data)
                const {
                    exportedAt, exportedFrom, version,
                    pluginState: importedPluginState,
                    installedPlugins: importedInstalledPlugins,
                    userPlugins: importedUserPlugins,
                    ...settingsToApply
                } = imported;
                // 1.3.13 migration: legacy fontSize/chatFontSize from a pre-1.3.13
                // export → uiScale percent. Done at import time because the
                // post-reload loadSettings migration only fires when uiScale is
                // absent in the saved blob; here defaults would have populated it.
                if (settingsToApply.uiScale === undefined &&
                    (settingsToApply.fontSize !== undefined || settingsToApply.chatFontSize !== undefined)) {
                    const maxLegacy = Math.max(settingsToApply.fontSize || 13, settingsToApply.chatFontSize || 13);
                    const raw = (maxLegacy / 13) * 100;
                    const snapped = Math.round(raw / 5) * 5;
                    settingsToApply.uiScale = Math.max(80, Math.min(175, snapped));
                    console.info('[Settings] Migrated legacy fontSize/chatFontSize → uiScale', settingsToApply.uiScale);
                }
                delete settingsToApply.fontSize;
                delete settingsToApply.chatFontSize;
                Object.assign(State.settings, settingsToApply);

                // Save core settings
                Storage.set('settings', State.settings);

                // Restore plugin state (enabled/disabled + config per plugin)
                // Merges with existing — doesn't overwrite plugins not in the export
                if (importedPluginState && typeof importedPluginState === 'object') {
                    const current = Storage.get('pluginState') || {};
                    Object.assign(current, importedPluginState);
                    Storage.set('pluginState', current);
                    console.log('[Settings] Restored plugin state for', Object.keys(importedPluginState).length, 'plugin(s)');
                }

                // Restore installed plugin URLs (will attempt to fetch on reload)
                if (Array.isArray(importedInstalledPlugins) && importedInstalledPlugins.length > 0) {
                    const current = Storage.get('installedPlugins') || [];
                    const existingUrls = new Set(current.map(p => p.url));
                    let added = 0;
                    for (const entry of importedInstalledPlugins) {
                        if (entry.url && !existingUrls.has(entry.url)) {
                            current.push({
                                url: entry.url,
                                pluginId: entry.pluginId || null,
                                name: entry.name || entry.pluginId || 'Unknown',
                                installedAt: new Date().toISOString(),
                                error: null
                            });
                            added++;
                        }
                    }
                    Storage.set('installedPlugins', current);
                    if (added > 0) console.log(`[Settings] Restored ${added} external plugin URL(s)`);
                }

                // Restore user-created plugins (source code)
                if (importedUserPlugins && typeof importedUserPlugins === 'object') {
                    const current = Storage.get('userPlugins') || {};
                    let added = 0;
                    for (const [id, entry] of Object.entries(importedUserPlugins)) {
                        if (entry.source && !current[id]) {
                            current[id] = entry;
                            added++;
                        }
                    }
                    Storage.set('userPlugins', current);
                    if (added > 0) console.log(`[Settings] Restored ${added} user-created plugin(s)`);
                }

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
