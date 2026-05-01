/**
 * Browser smoke tests for the Debug slide-out (1.3.9).
 *
 * Pins the integration contract:
 *   - 5 tab buttons render in design order (logs / conn / indexer / ai / plugins).
 *   - openDebugSlideOut(tab) activates the overlay and switches to that panel.
 *   - Logs panel renders rows from a seeded ErrorLogger.logs and respects
 *     the level chip filter.
 *   - Connections panel groups rows by registered provider and resolves
 *     the per-row pill kind via the same `statusFor` the Settings tab uses.
 *   - AI panel renders one .debug__table-row per LLMDebug exchange.
 *   - copyDiagnosticBundle() / buildDiagnosticBundle() produce a payload
 *     with the 5 top-level data keys + version + ts.
 *   - Esc closes the slide-out.
 *
 * Test isolation: GitProviderRegistry, ErrorLogger.logs, LLMDebug.exchanges,
 * and the slide-out's internal state are all module singletons. The test
 * snapshots them, seeds fixtures, and restores on teardown.
 */

import { GitProviderRegistry } from '../js/git-providers/index.js';
import { ErrorLogger } from '../js/error-logger.js';
import { LLMDebug } from '../js/llm.js';
import {
    initDebugSlideOut,
    openDebugSlideOut,
    closeDebugSlideOut,
    buildDiagnosticBundle,
    __test_renderActive,
    __test_selectTab,
    __test_setLogLevel,
    __test_resetState,
} from '../js/debug-slideout.js';
import { statusFor } from '../js/settings/connections-tab.js';

const { T } = window;

T.suite('Debug slide-out — 1.3.9 Touch 2 layout');

// ----- DOM scaffold (mirrors html/debug-slideout.html + the topbar btn) -----

const fixture = document.createElement('div');
fixture.id = 'debugSlideOutFixture';
fixture.innerHTML = `
    <button id="btnDebugMenu">🐛</button>
    <div class="slide-out-overlay" id="debugSlideOut" aria-hidden="true">
        <aside class="slide-out">
            <div class="debug">
                <div class="debug__head">
                    <div class="debug__title" id="debugSlideOutTitle"><span>Debug</span></div>
                    <div class="debug__head-meta"><span id="debugSessionLabel">1 active session · 0m</span></div>
                    <button id="debugPauseBtn" aria-pressed="false">⏸ Pause</button>
                    <button id="debugCopyBundleBtn">📋 Copy bundle</button>
                    <button id="debugCloseBtn">✕</button>
                </div>
                <div class="debug__tabs" role="tablist">
                    <button class="debug__tab debug__tab--active" data-debug-tab="logs" aria-selected="true">Logs <span class="debug__tab-count" id="debugTabCountLogs" hidden>0</span></button>
                    <button class="debug__tab" data-debug-tab="conn" aria-selected="false">Connections <span class="debug__tab-count" id="debugTabCountConn" hidden>0</span></button>
                    <button class="debug__tab" data-debug-tab="indexer" aria-selected="false">Indexer</button>
                    <button class="debug__tab" data-debug-tab="ai" aria-selected="false">AI <span class="debug__tab-count" id="debugTabCountAI" hidden>0</span></button>
                    <button class="debug__tab" data-debug-tab="plugins" aria-selected="false">Plugins <span class="debug__tab-count" id="debugTabCountPlugins" hidden>0</span></button>
                </div>
                <div class="debug__body">
                    <div class="debug__panel" data-debug-panel="logs"></div>
                    <div class="debug__panel" data-debug-panel="conn" hidden></div>
                    <div class="debug__panel" data-debug-panel="indexer" hidden></div>
                    <div class="debug__panel" data-debug-panel="ai" hidden></div>
                    <div class="debug__panel" data-debug-panel="plugins" hidden></div>
                </div>
            </div>
        </aside>
    </div>
`;
document.body.appendChild(fixture);

// ----- Snapshot module-singleton state -----

const priorConnections = GitProviderRegistry.listConnections();
const priorErrorLogs = ErrorLogger.logs.slice();
const priorExchanges = LLMDebug.exchanges.slice();

GitProviderRegistry.loadConnections([]);
ErrorLogger.logs = [];
LLMDebug.exchanges = [];

// Re-register provider stubs (idempotent — register() replaces by id)
GitProviderRegistry.register({
    id: 'github', name: 'GitHub', icon: '🐙', fixedUrl: 'https://api.github.com',
    listRepos: async () => [], testConnection: async () => ({ ok: true })
});
GitProviderRegistry.register({
    id: 'gitea', name: 'Gitea', icon: '🍵',
    listRepos: async () => [], testConnection: async () => ({ ok: true })
});

GitProviderRegistry.addConnection({
    id: 'gh-personal', provider: 'github', label: 'personal',
    url: 'https://api.github.com', token: 'tok-1', enabled: true
});
GitProviderRegistry.addConnection({
    id: 'gitea-home', provider: 'gitea', label: 'home lab',
    url: 'https://git.example.dev', token: '', enabled: true
});

// Seed errors at three levels
ErrorLogger.logs.push(
    { timestamp: '2026-05-01T12:00:00.000Z', type: 'ERROR', message: 'boom-1', stack: '', file: 'a.js', line: 1, col: 1 },
    { timestamp: '2026-05-01T12:00:01.000Z', type: 'WARN',  message: 'careful', stack: '', file: '', line: 0, col: 0 },
    { timestamp: '2026-05-01T12:00:02.000Z', type: 'LOG',   message: 'fyi',     stack: '', file: '', line: 0, col: 0 },
);

// Seed two LLM exchanges
LLMDebug.exchanges.push(
    {
        id: 1714564800001, ts: '2026-05-01T12:00:00.001Z', model: 'venice-uncensored',
        stream: true, toolsSent: 5, msgCount: 3, messages: [{ role: 'system', preview: 'sys', hasToolCalls: false }],
        chunks: [], thinkEvents: [], result: { contentLen: 120, contentPreview: 'hello', toolCalls: null,
        finishReason: 'stop', usage: { prompt_tokens: 800, completion_tokens: 120 } },
        error: null, durationMs: 1200, compression: null,
    },
    {
        id: 1714564800002, ts: '2026-05-01T12:00:05.000Z', model: 'gpt-4o',
        stream: true, toolsSent: 3, msgCount: 2, messages: [{ role: 'user', preview: 'hi', hasToolCalls: false }],
        chunks: [], thinkEvents: [], result: null, error: 'aborted', durationMs: 8000, compression: null,
    }
);

// ----- Init the slide-out (wires button + panel) -----

__test_resetState();
initDebugSlideOut();

// ----- 1. Open the slide-out via the topbar button -----

document.getElementById('btnDebugMenu').click();

const overlay = document.getElementById('debugSlideOut');
T.assert(overlay.classList.contains('active'), 'Clicking #btnDebugMenu activates the overlay');
T.eq(overlay.getAttribute('aria-hidden'), 'false', 'Overlay aria-hidden flips to false when active');

// ----- 2. Five tabs render in design order -----

const tabBtns = [...overlay.querySelectorAll('[data-debug-tab]')];
T.deepEq(
    tabBtns.map(b => b.dataset.debugTab),
    ['logs', 'conn', 'indexer', 'ai', 'plugins'],
    'Tab buttons render in design order'
);

// ----- 3. Logs panel renders one row per seeded error and filters by level -----

__test_selectTab('logs');
const logsPanel = overlay.querySelector('[data-debug-panel="logs"]');
const allRows = logsPanel.querySelectorAll('.debug__log-row');
T.eq(allRows.length, 3, 'Logs panel renders one row per seeded entry at level=all');

__test_setLogLevel('error');
__test_renderActive();
const errorOnly = logsPanel.querySelectorAll('.debug__log-row');
T.eq(errorOnly.length, 1, 'Setting level=error filters to ERROR-typed rows');
T.assert(
    errorOnly[0].querySelector('.debug__log-level--error'),
    'Filtered row carries the level--error class'
);
__test_setLogLevel('all'); // restore for subsequent tabs

// ----- 4. Connections tab uses statusFor() resolution -----

__test_selectTab('conn');
const connPanel = overlay.querySelector('[data-debug-panel="conn"]');
const connBlocks = connPanel.querySelectorAll('.debug__conn');
T.assert(connBlocks.length >= 2, 'Connections tab renders at least one row per git connection plus the AI block');

const githubConn = GitProviderRegistry.getConnection('gh-personal');
const giteaConn  = GitProviderRegistry.getConnection('gitea-home');
T.eq(statusFor(githubConn).kind, 'ok',   'Pre-flight: github personal resolves to ok');
T.eq(statusFor(giteaConn).kind,  'warn', 'Pre-flight: gitea home (no token) resolves to warn');

const okPills = connPanel.querySelectorAll('.conn__status--ok');
const warnPills = connPanel.querySelectorAll('.conn__status--warn');
T.assert(okPills.length >= 1,   'At least one ok pill renders (gh-personal + AI)');
T.assert(warnPills.length >= 1, 'At least one warn pill renders (gitea-home / no token)');

// ----- 5. AI tab renders one row per LLMDebug exchange -----

__test_selectTab('ai');
const aiPanel = overlay.querySelector('[data-debug-panel="ai"]');
const aiRows = aiPanel.querySelectorAll('[data-exchange-id]');
T.eq(aiRows.length, 2, 'AI tab renders one row per exchange');
T.assert(
    aiPanel.textContent.includes('venice-uncensored') && aiPanel.textContent.includes('gpt-4o'),
    'AI tab surfaces the model names from each exchange'
);
T.assert(
    aiPanel.querySelector('.debug__pill--error'),
    'Failed exchange (error: aborted) renders the error pill'
);

// ----- 6. Diagnostic bundle has the expected top-level keys -----

const bundle = buildDiagnosticBundle();
const bundleKeys = new Set(Object.keys(bundle));
T.assert(bundleKeys.has('version'),     'Bundle has version');
T.assert(bundleKeys.has('ts'),          'Bundle has ts');
T.assert(bundleKeys.has('errors'),      'Bundle has errors');
T.assert(bundleKeys.has('exchanges'),   'Bundle has exchanges');
T.assert(bundleKeys.has('connections'), 'Bundle has connections');
T.assert(bundleKeys.has('indexer'),     'Bundle has indexer');
T.assert(bundleKeys.has('plugins'),     'Bundle has plugins');
T.eq(bundle.connections.length, 2, 'Bundle.connections includes both seeded connections');
T.eq(bundle.exchanges.length,   2, 'Bundle.exchanges includes both seeded exchanges');
T.eq(bundle.errors.length,      3, 'Bundle.errors includes the seeded log entries (within 100 cap)');

// ----- 7. Esc closes the slide-out -----

document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
T.assert(!overlay.classList.contains('active'), 'Esc deactivates the overlay');

// ----- Teardown -----

GitProviderRegistry.loadConnections(priorConnections);
ErrorLogger.logs = priorErrorLogs;
LLMDebug.exchanges = priorExchanges;
fixture.remove();
__test_resetState();
