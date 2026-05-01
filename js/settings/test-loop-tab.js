// @ts-check
/**
 * Settings → Test Loop tab (1.4.5).
 *
 * Vanilla DOM, mirrors `workspace-settings-tab.js`. Lets the user enable
 * the test-driven loop UI and tune its bounds:
 *   - enabled                 (default off — start tight)
 *   - maxIterations           (1–50,   default 10)
 *   - maxWallClockMinutes     (1–60,   default 30)
 *   - maxTokensPerIteration   (1000–50000, default 8000)
 *   - ciPollTimeoutMinutes    (1–10,   default 5)
 *
 * All keys persist under `State.settings.testLoop.*`. The orchestrator reads
 * them via `resolveBounds()`. Workspace overrides apply through the existing
 * `.aieditor/settings.json` safelist.
 *
 * @module settings/test-loop-tab
 */

import { State, EventBus } from '../core.js';

let _bound = false;

/**
 * Defaults applied when a key is absent from `State.settings.testLoop`. Kept
 * here (not in core.js) so the tab and the orchestrator agree on one source.
 */
export const TEST_LOOP_DEFAULTS = Object.freeze({
    enabled: false,
    maxIterations: 10,
    maxWallClockMinutes: 30,
    maxTokensPerIteration: 8000,
    ciPollTimeoutMinutes: 5,
});

function _read() {
    const cfg = State.settings?.testLoop || {};
    return {
        enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : TEST_LOOP_DEFAULTS.enabled,
        maxIterations: Number(cfg.maxIterations) || TEST_LOOP_DEFAULTS.maxIterations,
        maxWallClockMinutes: Number(cfg.maxWallClockMinutes) || TEST_LOOP_DEFAULTS.maxWallClockMinutes,
        maxTokensPerIteration: Number(cfg.maxTokensPerIteration) || TEST_LOOP_DEFAULTS.maxTokensPerIteration,
        ciPollTimeoutMinutes: Number(cfg.ciPollTimeoutMinutes) || TEST_LOOP_DEFAULTS.ciPollTimeoutMinutes,
    };
}

function _persist(patch) {
    if (!State.settings.testLoop || typeof State.settings.testLoop !== 'object') {
        State.settings.testLoop = {};
    }
    Object.assign(State.settings.testLoop, patch);
    EventBus.emit('settings:changed', { section: 'testLoop', patch });
}

/**
 * Initialise the tab. Idempotent — safe to call on every modal open.
 */
export function initTestLoopTab() {
    render();
    if (_bound) return;
    _bound = true;

    const root = document.getElementById('tabTestLoop');
    if (!root) return;
    root.addEventListener('change', _onChange);
}

function _onChange(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = target.dataset.testLoopKey;
    if (!key) return;

    if (key === 'enabled') {
        _persist({ enabled: target.checked });
    } else {
        const min = Number(target.min) || 1;
        const max = Number(target.max) || Infinity;
        let v = Number(target.value);
        if (!Number.isFinite(v)) v = TEST_LOOP_DEFAULTS[key];
        v = Math.min(Math.max(v, min), max);
        target.value = String(v);
        _persist({ [key]: v });
    }
    render();
}

/**
 * Render the tab body. Pure function over `State.settings.testLoop`.
 */
export function render() {
    const root = document.getElementById('tabTestLoop');
    if (!root) return;
    const c = _read();
    root.innerHTML = `
      <h3>Test-driven loop</h3>
      <p class="settings-help">
        Bounded agentic CI iterator. When enabled (and the active role is
        <code>coder</code>), a 🔁 button appears next to the chat send button.
        Clicking it lets you describe a failing test; the model edits, commits,
        waits for CI, and iterates until CI passes or one of the bounds below
        trips.
      </p>

      <div class="form-group" data-setting-key="testLoop.enabled">
        <label class="settings-toggle">
          <input type="checkbox" data-test-loop-key="enabled" ${c.enabled ? 'checked' : ''}>
          <span>Enable test-driven loop</span>
        </label>
      </div>

      <div class="form-group" data-setting-key="testLoop.maxIterations">
        <label for="testLoopMaxIterations">Max iterations</label>
        <input id="testLoopMaxIterations" type="number" min="1" max="50" step="1"
               data-test-loop-key="maxIterations" value="${c.maxIterations}">
        <small>Stops the loop after this many attempts even if CI is still failing.</small>
      </div>

      <div class="form-group" data-setting-key="testLoop.maxWallClockMinutes">
        <label for="testLoopMaxWallClock">Max wall-clock (minutes)</label>
        <input id="testLoopMaxWallClock" type="number" min="1" max="60" step="1"
               data-test-loop-key="maxWallClockMinutes" value="${c.maxWallClockMinutes}">
        <small>Total run-time cap including time spent waiting for CI.</small>
      </div>

      <div class="form-group" data-setting-key="testLoop.maxTokensPerIteration">
        <label for="testLoopMaxTokens">Max tokens per iteration</label>
        <input id="testLoopMaxTokens" type="number" min="1000" max="50000" step="500"
               data-test-loop-key="maxTokensPerIteration" value="${c.maxTokensPerIteration}">
        <small>Best-effort cap on the model's response per iteration. Not all providers honor this.</small>
      </div>

      <div class="form-group" data-setting-key="testLoop.ciPollTimeoutMinutes">
        <label for="testLoopCiPoll">CI poll timeout (minutes)</label>
        <input id="testLoopCiPoll" type="number" min="1" max="10" step="1"
               data-test-loop-key="ciPollTimeoutMinutes" value="${c.ciPollTimeoutMinutes}">
        <small>How long each <code>wait_for_ci</code> call polls before giving up. Backs off 1s → 30s.</small>
      </div>
    `;
}

// Test seam.
export const __test__ = { _read, _persist, TEST_LOOP_DEFAULTS };
