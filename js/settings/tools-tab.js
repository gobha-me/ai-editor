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
import { resolveScriptAutomationConfig, resolvePreviewConfig, resolvePluginConfig, resolveSubAgentConfig, PLUGIN_TOOL_NAMES, getActiveProfileName } from '../profiles/resolve.js';
import { registerOnActivate } from './tab-activation-registry.js';

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
    const profileName = getActiveProfileName(State?.settings);
    const cfg = resolveScriptAutomationConfig(profileName);
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

// 1.22.0 — preview overlay. Stored under `State.settings.preview` so it
// parallels the profile's `preview` slice. Settings overlay wins when
// set; otherwise the resolved profile default applies. Same shape as
// `_readScript` / `_persistScript` above.
function _readPreview() {
    const profileName = getActiveProfileName(State?.settings);
    const cfg = resolvePreviewConfig(profileName);
    const overlay = (State.settings && State.settings.preview) || {};
    const enabled = typeof overlay.enabled === 'boolean' ? overlay.enabled : cfg.enabled;
    return { enabled, profileDefault: cfg.enabled };
}

function _persistPreview(patch) {
    if (!State.settings.preview || typeof State.settings.preview !== 'object') {
        State.settings.preview = {};
    }
    Object.assign(State.settings.preview, patch);
    EventBus.emit('settings:changed', { section: 'preview', patch });
}

// 2.58.0 — plugin overlay (gitea#442). Stored under `State.settings.plugin`
// so it parallels the profile's `plugin` slice. Settings overlay wins
// when set; otherwise the resolved profile default applies (which is OFF
// everywhere — the flag is opt-in). Same shape as `_readScript` /
// `_readPreview` above.
function _readPlugin() {
    const profileName = getActiveProfileName(State?.settings);
    const cfg = resolvePluginConfig(profileName);
    const overlay = (State.settings && State.settings.plugin) || {};
    const enabled = typeof overlay.enabled === 'boolean' ? overlay.enabled : cfg.enabled;
    return { enabled, profileDefault: cfg.enabled };
}

function _persistPlugin(patch) {
    if (!State.settings.plugin || typeof State.settings.plugin !== 'object') {
        State.settings.plugin = {};
    }
    Object.assign(State.settings.plugin, patch);
    EventBus.emit('settings:changed', { section: 'plugin', patch });
}

// 2.49.0 — sub-agents overlay (github#24 Phase 1 slice 2). Stored under
// `State.settings.subagent` so it parallels the profile's `subagent`
// slice. Settings overlay wins when set; otherwise the resolved profile
// default applies. Same shape as `_readScript` / `_readPreview` above.
function _readSubAgent() {
    const profileName = getActiveProfileName(State?.settings);
    const cfg = resolveSubAgentConfig(profileName);
    const overlay = (State.settings && State.settings.subagent) || {};
    const enabled = typeof overlay.enabled === 'boolean' ? overlay.enabled : cfg.enabled;
    // `sessionCap` is workspace-wide (parallel to ScriptAutomation's
    // timeout/byte caps). DESIGN-sub-agents.md §Decision §6 names this
    // as a workspace setting, not a per-profile knob.
    const overlaySessionCap = Number(overlay.sessionCap);
    const sessionCap = Number.isFinite(overlaySessionCap) && overlaySessionCap > 0
        ? overlaySessionCap
        : 5.0;
    return { enabled, sessionCap, profileDefault: cfg.enabled };
}

function _persistSubAgent(patch) {
    if (!State.settings.subagent || typeof State.settings.subagent !== 'object') {
        State.settings.subagent = {};
    }
    Object.assign(State.settings.subagent, patch);
    EventBus.emit('settings:changed', { section: 'subagent', patch });
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
    root.addEventListener('change', _onPreviewChange);
    root.addEventListener('change', _onPluginChange);
    root.addEventListener('change', _onSubAgentChange);
    root.addEventListener('input', _onSubAgentChange);
}

function _onPluginChange(ev) {
    const target = ev.target;
    if (!target || !target.dataset) return;
    const key = target.dataset.pluginKey;
    if (!key) return;
    if (key === 'enabled' && target instanceof HTMLInputElement && target.type === 'checkbox') {
        _persistPlugin({ enabled: !!target.checked });
        render();
    }
}

function _onSubAgentChange(ev) {
    const target = ev.target;
    if (!target || !target.dataset) return;
    const key = target.dataset.subagentKey;
    if (!key) return;
    if (key === 'enabled' && target instanceof HTMLInputElement && target.type === 'checkbox') {
        _persistSubAgent({ enabled: !!target.checked });
        render();
        return;
    }
    if (key === 'sessionCap' && target instanceof HTMLInputElement && target.type === 'number') {
        let v = Number(target.value);
        if (!Number.isFinite(v)) v = 5.0;
        v = Math.max(0.01, Math.min(v, 100));
        // Round to 2 decimal places.
        v = Math.round(v * 100) / 100;
        if (ev.type === 'change') target.value = String(v);
        _persistSubAgent({ sessionCap: v });
    }
}

function _onPreviewChange(ev) {
    const target = ev.target;
    if (!target || !target.dataset) return;
    const key = target.dataset.previewKey;
    if (!key) return;
    if (key === 'enabled' && target instanceof HTMLInputElement && target.type === 'checkbox') {
        _persistPreview({ enabled: !!target.checked });
        render();
    }
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

      ${_renderPreviewSection()}

      ${_renderPluginSection()}

      ${_renderSubAgentSection()}
    `;
}

function _renderPluginSection() {
    const p = _readPlugin();
    const profileLabel = p.profileDefault ? 'enabled' : 'disabled';
    const toolList = PLUGIN_TOOL_NAMES.map(n => `<code>${n}</code>`).join(' / ');
    return `
      <h3 style="margin-top: 1.5em;">Plugin development mode</h3>
      <p class="settings-help">
        Opt-in capability overlay that admits the Plugin SDK + doc tools
        onto whatever profile is active — flip it on mid-session without
        burning the working system prompt, budget, scratchpad, or
        conversation ledger. Mirrors the <code>preview.enabled</code>
        pattern. Decision recorded at
        <code>docs/discussion/plugin-dev-mode-vs-profile.md</code>.
        Per-profile default for the current profile:
        <strong>${profileLabel}</strong>.
      </p>

      <div class="form-group" data-setting-key="plugin.enabled">
        <label>
          <input type="checkbox"
                 data-plugin-key="enabled"
                 ${p.enabled ? 'checked' : ''}>
          Enable plugin SDK + doc tools
        </label>
        <small>
          Overrides the profile default. When on, admits ${toolList} onto
          the active profile's tool list for the current turn. Default
          OFF everywhere — opt-in only.
        </small>
      </div>
    `;
}

function _renderSubAgentSection() {
    const s = _readSubAgent();
    const profileLabel = s.profileDefault ? 'enabled' : 'disabled';
    return `
      <h3 style="margin-top: 1.5em;">Sub-agents (delegate_task)</h3>
      <p class="settings-help">
        Lets the parent agent spawn bounded child sub-agents on focused
        investigative sub-tasks (e.g. "find every call site of X across
        N files"). Each child runs against a restrictive read-only
        profile (<code>subagent.v1</code>) by default; you review the
        delegation + capability summary on an approval card before the
        child runs. The child's full transcript + cost surfaces back as
        a structured envelope. Per-profile default for the current
        role: <strong>${profileLabel}</strong>.
      </p>

      <div class="form-group" data-setting-key="subagent.enabled">
        <label>
          <input type="checkbox"
                 data-subagent-key="enabled"
                 ${s.enabled ? 'checked' : ''}>
          Enable <code>delegate_task</code> tool
        </label>
        <small>
          Overrides the profile default. When off, the model never sees
          the tool and cannot delegate. Per-call ceilings
          (<code>max_tokens</code> / <code>max_dollars</code> /
          <code>run_timeout_ms</code>) come from the sub-agent's own
          profile, not from this section.
        </small>
      </div>

      <div class="form-group" data-setting-key="subagent.sessionCap">
        <label for="subagentSessionCap">Per-conversation cost cap ($)</label>
        <input id="subagentSessionCap" type="number" min="0.01" max="100" step="0.05"
               data-subagent-key="sessionCap" value="${s.sessionCap.toFixed(2)}">
        <small>
          Hard dollar cap on cumulative sub-agent spend across all
          <code>delegate_task</code> invocations in the current
          conversation. Default <strong>$5.00</strong>. The approval
          card surfaces the running aggregate; calls that would exceed
          this cap are rejected before mounting the card.
        </small>
      </div>
    `;
}

function _renderPreviewSection() {
    const p = _readPreview();
    const profileLabel = p.profileDefault ? 'enabled' : 'disabled';
    return `
      <h3 style="margin-top: 1.5em;">In-editor preview (Tier 1)</h3>
      <p class="settings-help">
        Lets the LLM render the active workspace in a sandboxed iframe and
        return a URL the agent can verify against. The iframe runs at a
        sandbox <em>null</em> origin (no <code>allow-same-origin</code>) so
        workspace JS cannot reach the editor's State, tokens, or
        <code>localStorage</code>; a Service Worker resolves workspace
        paths via <code>Git.getFile</code> and a CSP locks outbound
        network. Closes the Sokoban-class boot-error gap surfaced by the
        2026-05-08 HTML-Games dogfood. Per-profile default for the
        current role: <strong>${profileLabel}</strong>.
      </p>

      <div class="form-group" data-setting-key="preview.enabled">
        <label>
          <input type="checkbox"
                 data-preview-key="enabled"
                 ${p.enabled ? 'checked' : ''}>
          Enable preview tools (Tier 1 + Tier 2)
        </label>
        <small>
          Overrides the profile default. When off, the model never sees
          any of the seven preview tools (Tier 1 lifecycle:
          <code>preview_start</code> / <code>preview_stop</code> /
          <code>preview_list</code>; Tier 2 capture readers:
          <code>preview_console_logs</code> /
          <code>preview_errors</code> / <code>preview_logs</code> /
          <code>preview_network</code>) and cannot spawn an iframe.
          Tier 3 (driveable preview) ships later as its own minor.
        </small>
      </div>
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

// 2.44.0.2 — replaces the `tab.dataset.tab === 'tabTools'` branch in
// `js/settings-manager.js`'s pre-2.44.0.2 switch statement.
registerOnActivate('tabTools', initToolsTab);
