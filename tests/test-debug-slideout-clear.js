/**
 * Browser tests for the 1.8.3 Debug slide-out Clear button.
 *
 * Pins: when 1.3.9 retired the standalone Error log + LLM debug modals
 * into the right-edge slide-out, the Clear buttons were not migrated.
 * `clearErrorLog()` and `clearLLMDebug()` continued to exist but no UI
 * surface invoked them, so `ErrorLogger.logs` could only grow and
 * `ErrorLogger.updateBadge()` painted `#btnDebugMenu` red with no path
 * to clear it. Surfaced as the breakout #124 dogfood UX gap.
 *
 * 1.8.3 adds a tab-aware Clear button in the slide-out head:
 *   - logs tab → `clearErrorLog()` → `ErrorLogger.clear()` → updateBadge()
 *   - ai tab   → `clearLLMDebug()` → `LLMDebug.clear()`
 *   - other    → no-op (read-only views)
 */

import { ErrorLogger } from '../js/error-logger.js';
import { LLMDebug } from '../js/llm.js';
import {
    initDebugSlideOut,
    openDebugSlideOut,
    closeDebugSlideOut,
    __test_selectTab,
    __test_clearActiveTab,
    __test_resetState,
} from '../js/debug-slideout.js';

const { T } = window;

T.suite('Debug slide-out Clear button — 1.8.3');

// ----- Fixture mirrors html/debug-slideout.html (incl. new debugClearBtn) -----

const fixture = document.createElement('div');
fixture.id = 'debugSlideOutClearFixture';
fixture.innerHTML = `
    <button id="btnDebugMenu">🐛</button>
    <div class="slide-out-overlay" id="debugSlideOut" aria-hidden="true">
        <aside class="slide-out">
            <div class="debug">
                <div class="debug__head">
                    <button id="debugPauseBtn" aria-pressed="false">⏸</button>
                    <button id="debugCopyBundleBtn">Copy bundle</button>
                    <button id="debugClearBtn" title="Clear active tab" aria-label="Clear active tab">🗑</button>
                    <button id="debugCloseBtn">✕</button>
                </div>
                <div class="debug__tabs" role="tablist">
                    <button class="debug__tab debug__tab--active" data-debug-tab="logs" aria-selected="true">Logs <span class="debug__tab-count" id="debugTabCountLogs" hidden>0</span></button>
                    <button class="debug__tab" data-debug-tab="conn" aria-selected="false">Connections</button>
                    <button class="debug__tab" data-debug-tab="indexer" aria-selected="false">Indexer</button>
                    <button class="debug__tab" data-debug-tab="ai" aria-selected="false">AI <span class="debug__tab-count" id="debugTabCountAI" hidden>0</span></button>
                    <button class="debug__tab" data-debug-tab="plugins" aria-selected="false">Plugins</button>
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

// ----- Snapshot module-singleton state to restore on teardown -----

const priorErrorLogs = ErrorLogger.logs.slice();
const priorExchanges = LLMDebug.exchanges.slice();
ErrorLogger.logs = [];
LLMDebug.exchanges = [];

__test_resetState();
initDebugSlideOut();

// ----- Test 1: button exists and is wired -----

const clearBtn = document.getElementById('debugClearBtn');
T.assert(clearBtn, '#debugClearBtn is present in the slide-out head');

// ----- Test 2: ErrorLogger.clear() resets the #btnDebugMenu badge -----
//
// This is the data-layer guarantee the Clear button relies on. If this
// breaks, the badge stays red even after a successful clear.

const debugMenuBtn = document.getElementById('btnDebugMenu');
ErrorLogger.logs = [
    { timestamp: '2026-05-07T12:00:00.000Z', type: 'ERROR', message: 'boom', stack: '', file: '', line: 0, col: 0 }
];
ErrorLogger.updateBadge();
T.assert(
    debugMenuBtn.style.backgroundColor !== '',
    'After error logged, #btnDebugMenu badge background is set'
);
ErrorLogger.clear();
T.eq(ErrorLogger.logs.length, 0, 'ErrorLogger.clear() empties the logs ring buffer');
T.eq(
    debugMenuBtn.style.backgroundColor, '',
    'ErrorLogger.clear() resets #btnDebugMenu badge background (sticky badge fix)'
);

// ----- Test 3: Clear button on logs tab → clearErrorLog() chain ------
//
// The Clear handler routes through showConfirm. We auto-confirm by
// polling for the dialog's OK button and clicking it. Tests the full
// wiring end-to-end (button → handler → showConfirm → ErrorLogger.clear).

ErrorLogger.logs = [
    { timestamp: '2026-05-07T12:00:01.000Z', type: 'ERROR', message: 'boom-2', stack: '', file: '', line: 0, col: 0 }
];

openDebugSlideOut('logs');
__test_selectTab('logs');

const clearPromise = __test_clearActiveTab();

// Poll briefly for the confirm dialog to appear, then click OK.
await new Promise(resolve => {
    let tries = 0;
    const tick = () => {
        const ok = document.getElementById('dialogOkBtn');
        if (ok && document.getElementById('dialogOverlay')?.classList.contains('active')) {
            ok.click();
            resolve();
        } else if (tries++ > 50) {
            resolve(); // give up; downstream assertion will catch it
        } else {
            setTimeout(tick, 20);
        }
    };
    tick();
});
await clearPromise;

T.eq(ErrorLogger.logs.length, 0,
    'Clear button on logs tab empties ErrorLogger.logs after confirm');

closeDebugSlideOut();

// ----- Test 4: Clear button on AI tab → clearLLMDebug() chain ------

LLMDebug.exchanges = [
    { id: 1, ts: '2026-05-07T12:00:02.000Z', model: 'venice-uncensored', stream: true,
      toolsSent: 0, msgCount: 1, messages: [], chunks: [], thinkEvents: [],
      result: null, error: null, durationMs: 100, compression: null }
];

openDebugSlideOut('ai');
__test_selectTab('ai');

const clearAIPromise = __test_clearActiveTab();
await new Promise(resolve => {
    let tries = 0;
    const tick = () => {
        const ok = document.getElementById('dialogOkBtn');
        if (ok && document.getElementById('dialogOverlay')?.classList.contains('active')) {
            ok.click();
            resolve();
        } else if (tries++ > 50) {
            resolve();
        } else {
            setTimeout(tick, 20);
        }
    };
    tick();
});
await clearAIPromise;

T.eq(LLMDebug.exchanges.length, 0,
    'Clear button on AI tab empties LLMDebug.exchanges after confirm');

closeDebugSlideOut();

// ----- Test 5: Clear button on a non-clearable tab is a no-op ------
//
// The Connections tab is a live view of registered git providers, not a
// ring buffer. Clicking Clear there should not throw, not nuke state,
// and surface a toast hint.

openDebugSlideOut('conn');
__test_selectTab('conn');
let toastShown = null;
const priorToast = window.showToast;
window.showToast = (msg) => { toastShown = msg; };
await __test_clearActiveTab();
T.assert(toastShown && /nothing to clear/i.test(toastShown),
    'Clear button on non-clearable tab shows "Nothing to clear" toast');
window.showToast = priorToast;
closeDebugSlideOut();

// ----- Teardown -----

ErrorLogger.logs = priorErrorLogs;
LLMDebug.exchanges = priorExchanges;
fixture.remove();
document.getElementById('dialogOverlay')?.remove();
