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
    `;
}

// Test seam.
export const __test__ = { _read, _persist, TOOLS_DEFAULTS };
