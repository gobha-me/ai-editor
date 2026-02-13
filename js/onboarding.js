/**
 * AI Editor - First-Run Onboarding
 *
 * Guided setup wizard shown when the app launches with no connections
 * and no LLM configured. Walks through Git → LLM → Done, with skip
 * at every step. Stores completion flag so it only shows once.
 *
 * Non-blocking: the app is fully functional behind the overlay.
 * Users can dismiss at any time and configure later via Settings.
 */

import { Storage, State } from './core.js';
import { GitProviderRegistry } from './git.js';
import { showToast } from './ui-helpers.js';

const STORAGE_KEY = 'onboardingComplete';

// ============================================
// PUBLIC API
// ============================================

/**
 * Check if onboarding should show and display it.
 * Called from app.js after init.
 */
export function checkOnboarding() {
    if (Storage.get(STORAGE_KEY)) return;

    const hasConnections = GitProviderRegistry.listConnections(true).length > 0;
    const hasLLM = State.settings.llmEndpoint && State.settings.llmApiKey;

    // If user already has stuff configured (e.g., imported settings), skip
    if (hasConnections && hasLLM) {
        Storage.set(STORAGE_KEY, true);
        return;
    }

    _showWizard(hasConnections, hasLLM);
}

// ============================================
// WIZARD IMPLEMENTATION
// ============================================

function _showWizard(hasConnections, hasLLM) {
    const overlay = document.getElementById('onboardingOverlay');
    if (!overlay) return;

    // Determine starting step
    let step = 0;
    overlay.classList.add('active');

    const steps = overlay.querySelectorAll('.onboard-step');
    const dots = overlay.querySelectorAll('.onboard-dot');

    function goTo(n) {
        step = n;
        steps.forEach((s, i) => s.classList.toggle('active', i === n));
        dots.forEach((d, i) => {
            d.classList.toggle('active', i === n);
            d.classList.toggle('done', i < n);
        });
    }

    function finish() {
        Storage.set(STORAGE_KEY, true);
        overlay.classList.remove('active');
    }

    // Wire up navigation buttons
    overlay.querySelectorAll('[data-goto]').forEach(btn => {
        btn.addEventListener('click', () => goTo(parseInt(btn.dataset.goto)));
    });

    overlay.querySelectorAll('[data-finish]').forEach(btn => {
        btn.addEventListener('click', finish);
    });

    // "Skip everything" on welcome
    overlay.querySelector('[data-skip-all]')?.addEventListener('click', finish);

    // "Open Settings" buttons — close wizard, open settings to specific tab
    overlay.querySelectorAll('[data-open-settings]').forEach(btn => {
        btn.addEventListener('click', () => {
            finish();
            if (window.openSettings) window.openSettings();
            // Switch to the right tab
            const tab = btn.dataset.openSettings;
            if (tab) {
                setTimeout(() => {
                    const tabBtn = document.querySelector(`.settings-tab[data-tab="${tab}"]`);
                    if (tabBtn) tabBtn.click();
                }, 100);
            }
        });
    });

    // Git connection form (inline in step 1)
    _wireGitForm(overlay, () => goTo(2));

    // LLM form (inline in step 2)
    _wireLLMForm(overlay, () => goTo(3));

    goTo(0);
}

// ============================================
// GIT CONNECTION FORM (Step 1)
// ============================================

function _wireGitForm(overlay, onSuccess) {
    const provider = overlay.querySelector('#obGitProvider');
    const url = overlay.querySelector('#obGitUrl');
    const token = overlay.querySelector('#obGitToken');
    const testBtn = overlay.querySelector('#obGitTest');
    const saveBtn = overlay.querySelector('#obGitSave');
    const status = overlay.querySelector('#obGitStatus');

    if (!provider || !url || !token) return;

    // Provider change → update URL placeholder
    provider.addEventListener('change', () => {
        const presets = {
            github: 'https://api.github.com',
            gitlab: 'https://gitlab.com',
            gitea: 'https://git.example.com'
        };
        url.placeholder = presets[provider.value] || 'https://git.example.com';
        if (provider.value === 'github' && !url.value) url.value = 'https://api.github.com';
        if (provider.value === 'gitlab' && !url.value) url.value = 'https://gitlab.com';
    });

    testBtn?.addEventListener('click', async () => {
        if (!url.value || !token.value) {
            _showStatus(status, 'Please fill in URL and token', 'error');
            return;
        }
        _showStatus(status, 'Testing...', 'info');
        try {
            const providerImpl = GitProviderRegistry.get(provider.value);
            if (!providerImpl) {
                _showStatus(status, 'Provider not registered', 'error');
                return;
            }
            const conn = { provider: provider.value, url: url.value, token: token.value, enabled: true };
            const result = await providerImpl.testConnection(conn);
            if (result.ok) {
                _showStatus(status, `Connected as ${result.user}`, 'success');
            } else {
                _showStatus(status, 'Connection failed', 'error');
            }
        } catch (e) {
            _showStatus(status, e.message, 'error');
        }
    });

    saveBtn?.addEventListener('click', async () => {
        if (!url.value || !token.value) {
            _showStatus(status, 'Please fill in URL and token', 'error');
            return;
        }
        try {
            const label = provider.value.charAt(0).toUpperCase() + provider.value.slice(1);
            const connId = `${provider.value}-${Date.now()}`;
            GitProviderRegistry.addConnection({
                id: connId,
                provider: provider.value,
                label,
                url: url.value,
                token: token.value,
                enabled: true
            });
            // Persist to State + Storage (same as settings save)
            State.settings.connections = GitProviderRegistry.listConnections();
            Storage.set('settings', State.settings);

            _showStatus(status, 'Connection saved!', 'success');
            showToast('Git connection added');
            setTimeout(onSuccess, 600);
        } catch (e) {
            _showStatus(status, e.message, 'error');
        }
    });
}

// ============================================
// LLM FORM (Step 2)
// ============================================

function _wireLLMForm(overlay, onSuccess) {
    const provider = overlay.querySelector('#obLLMProvider');
    const endpoint = overlay.querySelector('#obLLMEndpoint');
    const key = overlay.querySelector('#obLLMKey');
    const saveBtn = overlay.querySelector('#obLLMSave');
    const status = overlay.querySelector('#obLLMStatus');

    if (!provider || !endpoint || !key) return;

    const presets = {
        venice: { url: 'https://api.venice.ai/api/v1', placeholder: 'Venice API key' },
        openrouter: { url: 'https://openrouter.ai/api/v1', placeholder: 'OpenRouter API key' },
        custom: { url: '', placeholder: 'API key' }
    };

    provider.addEventListener('change', () => {
        const p = presets[provider.value] || presets.custom;
        endpoint.value = p.url;
        key.placeholder = p.placeholder;
    });

    // Init default
    if (provider.value && presets[provider.value]) {
        endpoint.value = presets[provider.value].url;
    }

    saveBtn?.addEventListener('click', () => {
        if (!endpoint.value || !key.value) {
            _showStatus(status, 'Please fill in endpoint and API key', 'error');
            return;
        }

        // Save to settings
        State.settings.llmProvider = provider.value;
        State.settings.llmEndpoint = endpoint.value;
        State.settings.llmApiKey = key.value;
        Storage.set('settings', State.settings);

        _showStatus(status, 'LLM configured! Models will load on next page load.', 'success');
        showToast('LLM provider configured');
        setTimeout(onSuccess, 600);
    });
}

// ============================================
// HELPERS
// ============================================

function _showStatus(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.className = 'onboard-status onboard-status-' + type;
    el.style.display = 'block';
}
