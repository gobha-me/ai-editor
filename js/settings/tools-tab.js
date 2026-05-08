// @ts-check
/**
 * Settings → Tools tab (1.4.8).
 *
 * Vanilla DOM, mirrors `test-loop-tab.js`. Surfaces the lazy-expansion knobs
 * that 1.4.1 left as undocumented `State.settings.findToolThreshold`
 * escape-hatch only:
 *   - findToolThreshold       (0–1,    default 0.4)
 *   - findToolTopK            (1–25,   default 8)
 *   - discoveryAdmissionCap   (1–25,   default 3)
 *
 * All keys persist under `State.settings.tools.*`. The semantic
 * `find_tool` reads them via `_readThreshold` / `_readTopK` and
 * `recordDiscoveryAdmissions` reads `discoveryAdmissionCap` via
 * `_readDiscoveryCap` (see `js/intelligence/tools/embeddings.js`).
 * Workspace overrides apply through the existing
 * `.aieditor/settings.json` safelist (1.4.4 — `tools` whole subtree).
 *
 * The legacy flat `State.settings.findToolThreshold` is still honored as a
 * fallback when the nested key is absent — back-compat for sessions that
 * had hand-edited it before 1.4.8.
 *
 * @module settings/tools-tab
 */

import { State, EventBus } from '../core.js';
import {
    DEFAULT_THRESHOLD,
    DEFAULT_TOP_K,
    DISCOVERY_ADMISSION_CAP,
} from '../intelligence/tools/embeddings.js';
import { resolveScriptAutomationConfig } from '../profiles/resolve.js';

let _bound = false;

/**
 * Defaults applied when a key is absent from `State.settings.tools`. Kept
 * in sync with `embeddings.js` constants so the tab and the runtime agree.
 */
export const TOOLS_DEFAULTS = Object.freeze({
    findToolThreshold: DEFAULT_THRESHOLD,
    findToolTopK: DEFAULT_TOP_K,
    discoveryAdmissionCap: DISCOVERY_ADMISSION_CAP,
});

function _read() {
    const cfg = State.settings?.tools || {};
    const threshold = Number(cfg.findToolThreshold);
    const topK = Number(cfg.findToolTopK);
    const cap = Number(cfg.discoveryAdmissionCap);
    return {
        findToolThreshold: Number.isFinite(threshold) && threshold >= 0 && threshold <= 1
            ? threshold
            : TOOLS_DEFAULTS.findToolThreshold,
        findToolTopK: Number.isInteger(topK) && topK > 0 && topK <= 25
            ? topK
            : TOOLS_DEFAULTS.findToolTopK,
        discoveryAdmissionCap: Number.isInteger(cap) && cap > 0 && cap <= 25
            ? cap
            : TOOLS_DEFAULTS.discoveryAdmissionCap,
    };
}

function _persist(patch) {
    if (!State.settings.tools || typeof State.settings.tools !== 'object') {
        State.settings.tools = {};
    }
    Object.assign(State.settings.tools, patch);
    EventBus.emit('settings:changed', { section: 'tools', patch });
}

// 1.16.0 — script automation overlay. Stored under
// `State.settings.scriptAutomation` so it parallels the profile's
// `scriptAutomation` slice. Settings overlay wins when set; otherwise
// the resolved profile default applies. Same pattern as `tools.*` —
// kept in a separate object because the profile slice is per-profile,
// not per-tool.
function _readScript() {
    const role = State?.settings?.role || null;
    const cfg = resolveScriptAutomationConfig(role);
    const overlay = (State.settings && State.settings.scriptAutomation) || {};
    const enabled = typeof overlay.enabled === 'boolean' ? overlay.enabled : cfg.enabled;
    const timeout_ms = Number.isInteger(overlay.timeout_ms) && overlay.timeout_ms > 0
        ? overlay.timeout_ms
        : cfg.timeout_ms;
    const max_output_bytes = Number.isInteger(overlay.max_output_bytes) && overlay.max_output_bytes > 0
        ? overlay.max_output_bytes
        : cfg.max_output_bytes;
    return { enabled, timeout_ms, max_output_bytes, profileDefault: cfg.enabled };
}

function _persistScript(patch) {
    if (!State.settings.scriptAutomation || typeof State.settings.scriptAutomation !== 'object') {
        State.settings.scriptAutomation = {};
    }
    Object.assign(State.settings.scriptAutomation, patch);
    EventBus.emit('settings:changed', { section: 'scriptAutomation', patch });
}

/**
 * Initialise the tab. Idempotent — safe to call on every modal open.
 */
export function initToolsTab() {
    render();
    if (_bound) return;
    _bound = true;

    const root = document.getElementById('tabTools');
    if (!root) return;
    root.addEventListener('change', _onChange);
    root.addEventListener('input', _onInput);
    root.addEventListener('change', _onScriptChange);
}

function _onScriptChange(ev) {
    const target = ev.target;
    if (!target || !target.dataset) return;
    const key = target.dataset.scriptKey;
    if (!key) return;
    if (key === 'enabled' && target instanceof HTMLInputElement && target.type === 'checkbox') {
        _persistScript({ enabled: !!target.checked });
        render();
        return;
    }
    if (target instanceof HTMLInputElement && target.type === 'number') {
        const min = Number(target.min) || 0;
        const max = Number(target.max) || 120000;
        let v = Number(target.value);
        if (!Number.isFinite(v)) v = (key === 'timeout_ms') ? 30000 : 262144;
        v = Math.min(Math.max(Math.floor(v), min), max);
        target.value = String(v);
        _persistScript({ [key]: v });
        render();
    }
}

function _onInput(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'range') return;
    const key = target.dataset.toolsKey;
    if (!key) return;
    const display = document.querySelector(`[data-tools-display="${key}"]`);
    if (display) display.textContent = target.value;
}

function _onChange(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = target.dataset.toolsKey;
    if (!key) return;

    const min = Number(target.min) || 0;
    const max = Number(target.max) || 1;
    let v = Number(target.value);
    if (!Number.isFinite(v)) v = TOOLS_DEFAULTS[key];
    v = Math.min(Math.max(v, min), max);
    if (key !== 'findToolThreshold') v = Math.floor(v);
    target.value = String(v);
    _persist({ [key]: v });
    render();
}

/**
 * Render the tab body. Pure function over `State.settings.tools`.
 */
export function render() {
    const root = document.getElementById('tabTools');
    if (!root) return;
    const c = _read();
    root.innerHTML = `
      <h3>Tools</h3>
      <p class="settings-help">
        Tune the semantic <code>find_tool</code> meta-tool that drives lazy
        admission. Lower thresholds admit more candidates per query (broader
        recall, more tokens); higher thresholds tighten the gate.
        Discovery candidates pay only their short-form cost (~50 tokens)
        until the model invokes one — at which point the next turn renders
        the full schema.
      </p>

      <div class="form-group" data-setting-key="tools.findToolThreshold">
        <label for="toolsFindToolThreshold">
          Semantic match threshold
          <span class="settings-tab__value" data-tools-display="findToolThreshold">${c.findToolThreshold}</span>
        </label>
        <input id="toolsFindToolThreshold" type="range"
               min="0" max="1" step="0.05"
               data-tools-key="findToolThreshold"
               value="${c.findToolThreshold}">
        <small>
          Cosine similarity gate for <code>find_tool</code> matches. Default
          <strong>${TOOLS_DEFAULTS.findToolThreshold}</strong>. Lower values
          recall more tools per query; higher values surface only the
          strongest matches.
        </small>
      </div>

      <div class="form-group" data-setting-key="tools.findToolTopK">
        <label for="toolsFindToolTopK">Top-K matches per query</label>
        <input id="toolsFindToolTopK" type="number" min="1" max="25" step="1"
               data-tools-key="findToolTopK" value="${c.findToolTopK}">
        <small>
          Maximum candidates <code>find_tool</code> returns ranked by
          similarity. Default <strong>${TOOLS_DEFAULTS.findToolTopK}</strong>.
          Capped at 25 — larger values rarely seat against the 5000-token
          tool budget anyway.
        </small>
      </div>

      <div class="form-group" data-setting-key="tools.discoveryAdmissionCap">
        <label for="toolsDiscoveryCap">Discovery admission cap</label>
        <input id="toolsDiscoveryCap" type="number" min="1" max="25" step="1"
               data-tools-key="discoveryAdmissionCap" value="${c.discoveryAdmissionCap}">
        <small>
          How many of the Top-K candidates per <code>find_tool</code> call
          earn an actual short-form admission in the ledger. Default
          <strong>${TOOLS_DEFAULTS.discoveryAdmissionCap}</strong>.
          Protects budget when a query returns many strong matches; the
          rest stay in the ranking but are not admitted.
        </small>
      </div>

      <div class="form-group">
        <label>Eviction</label>
        <small>
          When admitted tool definitions exceed the profile's tool-token
          budget, the Composer drops the longest-unused non-static entries
          first (LRU by <code>last_used_at</code>). Static profile tools
          are never evicted; if the static set alone exceeds the budget,
          that surfaces as a configuration error in the LLM Debug modal.
          See <strong>LRU evicted</strong> rows under each turn's tool
          admission section.
        </small>
      </div>

      ${_renderScriptAutomationSection()}
    `;
}

function _renderScriptAutomationSection() {
    const s = _readScript();
    const profileLabel = s.profileDefault ? 'enabled' : 'disabled';
    return `
      <h3 style="margin-top: 1.5em;">Script Automation (Tier 0 sandbox)</h3>
      <p class="settings-help">
        Lets the LLM submit a JS script for you to review and approve.
        On approval the script runs in a sandboxed Web Worker with no
        network, no DOM, no <code>process</code> — only
        <code>Git.getFile</code> / <code>Git.getFileTree</code>. Useful
        for the X^N-shaped audits that otherwise grind through dozens of
        <code>read_file</code> calls (dead-CSS sweeps, unused-export
        scans, import-graph audits). Per-profile default for the
        current role: <strong>${profileLabel}</strong>.
      </p>

      <div class="form-group" data-setting-key="scriptAutomation.enabled">
        <label>
          <input type="checkbox"
                 data-script-key="enabled"
                 ${s.enabled ? 'checked' : ''}>
          Enable <code>submit_script_for_approval</code> tool
        </label>
        <small>
          Overrides the profile default. When off, the model never sees
          the tool and can't trigger a sandbox run.
        </small>
      </div>

      <div class="form-group" data-setting-key="scriptAutomation.timeout_ms">
        <label for="scriptTimeoutMs">Worker timeout (ms)</label>
        <input id="scriptTimeoutMs" type="number" min="1000" max="120000" step="500"
               data-script-key="timeout_ms" value="${s.timeout_ms}">
        <small>
          Hard timeout on the sandboxed run. Default
          <strong>30000</strong> ms. Range 1000–120000. Real fs walks
          against a multi-hundred-file repo can saturate the smaller
          budget on the postMessage round-trip alone.
        </small>
      </div>

      <div class="form-group" data-setting-key="scriptAutomation.max_output_bytes">
        <label for="scriptMaxOutput">Max stdout+stderr bytes</label>
        <input id="scriptMaxOutput" type="number" min="1024" max="1048576" step="1024"
               data-script-key="max_output_bytes" value="${s.max_output_bytes}">
        <small>
          Hard byte cap on combined stdout+stderr. Default
          <strong>262144</strong> (256 KB). Truncation surfaces as
          <code>truncated: true</code> in the tool result.
        </small>
      </div>
    `;
}

// Test seam.
export const __test__ = { _read, _persist, TOOLS_DEFAULTS };
