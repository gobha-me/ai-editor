// @ts-check
/**
 * Settings → Retrieval tab (1.5.12).
 *
 * Vanilla DOM, mirrors `tools-tab.js`. Surfaces the query-paraphrase
 * three-way mode + utility model id + rounds + temperature. The tab is
 * the user-facing surface for `State.settings.retrieval.paraphrase*` —
 * the Composer's pre-pass at `js/intelligence/retrieval/composer.js`
 * builds a `QueryParaphraser` from these values via
 * `buildParaphraserFromSettings` in
 * `js/intelligence/retrieval/query-paraphraser.js`.
 *
 * **Why this tab exists separately from Settings → Embeddings.**
 * Paraphrasing is a chat-LLM concern, not an embedder concern. Mixing
 * the two in one tab confuses the cost surface (paraphrase cost is per
 * `find_relevant_files` call; embedding cost amortizes across the index).
 * The Retrieval tab also houses future retrieval knobs (BM25 k1/b,
 * score-weights map, etc.) as the 1.5.x stream lands.
 *
 * **Default mode is `'off'`.** Every user upgrading to 1.5.12 sees zero
 * behavior change — paraphrasing only fires after explicit opt-in.
 *
 * @module settings/retrieval-tab
 */

import { State, EventBus } from '../core.js';
import { registerOnActivate } from './tab-activation-registry.js';

let _bound = false;

/**
 * Defaults applied when `State.settings.retrieval.*` keys are absent.
 * Match the `core.js` defaults verbatim — divergence here would cause
 * the tab to silently override the runtime contract.
 */
export const RETRIEVAL_DEFAULTS = Object.freeze({
    paraphraseMode: 'off',
    paraphraseModelId: '',
    paraphraseRounds: 2,
    paraphraseTemperature: 0,
    crossFileExpansionMode: 'off',
    crossFileExpanderModelId: '',
    crossFileExpanderRounds: 3,
    crossFileExpanderTemperature: 0,
    // 2.89.0 (gitea#505) — third Utility Models entry. Used by
    // `delegate_task` sub-agents; empty string falls through to
    // `paraphraseModelId` → primary in the runner's resolver chain.
    subagentModelId: '',
});

const VALID_MODES = new Set(['off', 'primary', 'utility']);

function _read() {
    const cfg = State.settings?.retrieval || {};
    const mode = VALID_MODES.has(cfg.paraphraseMode)
        ? cfg.paraphraseMode
        : RETRIEVAL_DEFAULTS.paraphraseMode;
    const modelId = typeof cfg.paraphraseModelId === 'string'
        ? cfg.paraphraseModelId
        : RETRIEVAL_DEFAULTS.paraphraseModelId;
    const rounds = Number(cfg.paraphraseRounds);
    const temp = Number(cfg.paraphraseTemperature);
    const expMode = VALID_MODES.has(cfg.crossFileExpansionMode)
        ? cfg.crossFileExpansionMode
        : RETRIEVAL_DEFAULTS.crossFileExpansionMode;
    const expModelId = typeof cfg.crossFileExpanderModelId === 'string'
        ? cfg.crossFileExpanderModelId
        : RETRIEVAL_DEFAULTS.crossFileExpanderModelId;
    const expRounds = Number(cfg.crossFileExpanderRounds);
    const expTemp = Number(cfg.crossFileExpanderTemperature);
    const subagentModelId = typeof cfg.subagentModelId === 'string'
        ? cfg.subagentModelId
        : RETRIEVAL_DEFAULTS.subagentModelId;
    return {
        paraphraseMode: mode,
        paraphraseModelId: modelId,
        paraphraseRounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 3
            ? rounds
            : RETRIEVAL_DEFAULTS.paraphraseRounds,
        paraphraseTemperature: Number.isFinite(temp) && temp >= 0 && temp <= 1
            ? temp
            : RETRIEVAL_DEFAULTS.paraphraseTemperature,
        crossFileExpansionMode: expMode,
        crossFileExpanderModelId: expModelId,
        crossFileExpanderRounds: Number.isInteger(expRounds) && expRounds >= 1 && expRounds <= 5
            ? expRounds
            : RETRIEVAL_DEFAULTS.crossFileExpanderRounds,
        crossFileExpanderTemperature: Number.isFinite(expTemp) && expTemp >= 0 && expTemp <= 1
            ? expTemp
            : RETRIEVAL_DEFAULTS.crossFileExpanderTemperature,
        subagentModelId,
    };
}

function _persist(patch) {
    if (!State.settings.retrieval || typeof State.settings.retrieval !== 'object') {
        State.settings.retrieval = {};
    }
    Object.assign(State.settings.retrieval, patch);
    EventBus.emit('settings:changed', { section: 'retrieval', patch });
}

/**
 * Initialise the tab. Idempotent — safe to call on every modal open.
 */
export function initRetrievalTab() {
    render();
    if (_bound) return;
    _bound = true;

    const root = document.getElementById('tabRetrieval');
    if (!root) return;
    root.addEventListener('change', _onChange);
    root.addEventListener('input', _onInput);
}

function _onInput(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'range') return;
    const key = target.dataset.retrievalKey;
    if (!key) return;
    const display = document.querySelector(`[data-retrieval-display="${key}"]`);
    if (display) display.textContent = target.value;
}

function _onChange(ev) {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const key = target.dataset.retrievalKey;
    if (!key) return;
    /** @type {Object<string, any>} */
    let patch = {};
    if (key === 'paraphraseMode') {
        const value = VALID_MODES.has(target.value)
            ? target.value
            : RETRIEVAL_DEFAULTS.paraphraseMode;
        patch.paraphraseMode = value;
        // 1.8.1 — paraphrase + cross-file expansion are mutually exclusive
        // levers; UI guards by snapping the *other* mode to 'off' when this
        // one moves off 'off'. Back-end (`composer.js`) defends regardless,
        // but keeping the UI consistent prevents the user from leaving both
        // visibly enabled and getting silent expander-wins behavior.
        if (value !== 'off') patch.crossFileExpansionMode = 'off';
    } else if (key === 'paraphraseModelId') {
        patch.paraphraseModelId = target.value.trim();
    } else if (key === 'paraphraseRounds') {
        let v = Math.floor(Number(target.value));
        if (!Number.isFinite(v) || v < 1) v = RETRIEVAL_DEFAULTS.paraphraseRounds;
        if (v > 3) v = 3;
        target.value = String(v);
        patch.paraphraseRounds = v;
    } else if (key === 'paraphraseTemperature') {
        let v = Number(target.value);
        if (!Number.isFinite(v) || v < 0) v = RETRIEVAL_DEFAULTS.paraphraseTemperature;
        if (v > 1) v = 1;
        target.value = String(v);
        patch.paraphraseTemperature = v;
    } else if (key === 'crossFileExpansionMode') {
        const value = VALID_MODES.has(target.value)
            ? target.value
            : RETRIEVAL_DEFAULTS.crossFileExpansionMode;
        patch.crossFileExpansionMode = value;
        if (value !== 'off') patch.paraphraseMode = 'off';
    } else if (key === 'crossFileExpanderModelId') {
        patch.crossFileExpanderModelId = target.value.trim();
    } else if (key === 'crossFileExpanderRounds') {
        let v = Math.floor(Number(target.value));
        if (!Number.isFinite(v) || v < 1) v = RETRIEVAL_DEFAULTS.crossFileExpanderRounds;
        if (v > 5) v = 5;
        target.value = String(v);
        patch.crossFileExpanderRounds = v;
    } else if (key === 'crossFileExpanderTemperature') {
        let v = Number(target.value);
        if (!Number.isFinite(v) || v < 0) v = RETRIEVAL_DEFAULTS.crossFileExpanderTemperature;
        if (v > 1) v = 1;
        target.value = String(v);
        patch.crossFileExpanderTemperature = v;
    } else if (key === 'subagentModelId') {
        // 2.89.0 (gitea#505) — sub-agent utility model id. Consumed by
        // `js/chat/subagent-runner.js` via the resolveSubAgentModel chain.
        patch.subagentModelId = target.value.trim();
    } else {
        return;
    }
    _persist(patch);
    render();
}

/**
 * Render the tab body. Pure function over `State.settings.retrieval`.
 * Re-renders on every persisted change so the mode-conditional reveal
 * of the utility model id input stays in sync.
 */
export function render() {
    const root = document.getElementById('tabRetrieval');
    if (!root) return;
    const c = _read();
    const utilityHidden = c.paraphraseMode !== 'utility' ? 'hidden' : '';
    const expansionUtilityHidden = c.crossFileExpansionMode !== 'utility' ? 'hidden' : '';
    const paraphraseActive = c.paraphraseMode !== 'off';
    const expansionActive = c.crossFileExpansionMode !== 'off';
    root.innerHTML = `
      <h3>Retrieval</h3>
      <p class="settings-help">
        Two query-rewrite pre-passes for <code>find_relevant_files</code>.
        Each one adds one chat-LLM call per retrieval, cached per query.
        Both default to <strong>off</strong>; pick at most one — they're
        mutually exclusive levers solving the same problem.
      </p>

      <h4 style="margin-top: 1.2rem;">Query paraphrase</h4>
      <p class="settings-help">
        Vocabulary-different rewordings of your query that preserve intent.
        The Composer fuses the original ranking with paraphrase rankings
        via reciprocal rank fusion (RRF). Useful when natural-language
        synonym variation (e.g. "auth" vs "authentication") matters.
      </p>

      <div class="form-group" data-setting-key="retrieval.paraphraseMode">
        <label>Query paraphrase mode</label>
        <div style="display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.4rem;">
          <label style="display: flex; gap: 0.5rem; align-items: center; font-weight: normal;">
            <input type="radio" name="paraphraseMode" value="off"
                   data-retrieval-key="paraphraseMode"
                   ${c.paraphraseMode === 'off' ? 'checked' : ''}>
            <span><strong>Off</strong> — no paraphrasing; original query only (default).</span>
          </label>
          <label style="display: flex; gap: 0.5rem; align-items: center; font-weight: normal;">
            <input type="radio" name="paraphraseMode" value="primary"
                   data-retrieval-key="paraphraseMode"
                   ${c.paraphraseMode === 'primary' ? 'checked' : ''}>
            <span><strong>Use primary chat model</strong> — reuses the model in <em>LLM</em> tab.</span>
          </label>
          <label style="display: flex; gap: 0.5rem; align-items: center; font-weight: normal;">
            <input type="radio" name="paraphraseMode" value="utility"
                   data-retrieval-key="paraphraseMode"
                   ${c.paraphraseMode === 'utility' ? 'checked' : ''}>
            <span><strong>Use utility model</strong> — separate, typically smaller/cheaper model.</span>
          </label>
        </div>
        ${expansionActive ? `<small style="color: var(--accent, #888); display: block; margin-top: 0.4rem;">
          Cross-file expansion is currently active — switching paraphrase off
          will keep that mode. Switching paraphrase on will turn expansion off
          (mutually exclusive).
        </small>` : ''}
      </div>

      <div class="form-group" data-setting-key="retrieval.paraphraseModelId" ${utilityHidden}>
        <label for="retrievalParaphraseModelId">Utility model id</label>
        <input id="retrievalParaphraseModelId" type="text"
               data-retrieval-key="paraphraseModelId"
               value="${c.paraphraseModelId.replace(/"/g, '&quot;')}"
               placeholder="e.g. claude-haiku-4-5-20251001">
        <small>
          Provider must be the same as your primary chat model
          (provider/endpoint/key are reused). Multi-provider paraphrase
          is post-2.0.
        </small>
      </div>

      <div class="form-group" data-setting-key="retrieval.paraphraseRounds">
        <label for="retrievalParaphraseRounds">Paraphrases per query</label>
        <input id="retrievalParaphraseRounds" type="number" min="1" max="3" step="1"
               data-retrieval-key="paraphraseRounds" value="${c.paraphraseRounds}">
        <small>
          How many alternative phrasings to request. Default
          <strong>${RETRIEVAL_DEFAULTS.paraphraseRounds}</strong>. Two
          paraphrases plus the original query give three rankings to
          fuse — enough to surface cross-variant agreement without
          paying for many LLM calls. Range 1–3.
        </small>
      </div>

      <div class="form-group" data-setting-key="retrieval.paraphraseTemperature">
        <label for="retrievalParaphraseTemperature">Paraphrase temperature</label>
        <input id="retrievalParaphraseTemperature" type="number" min="0" max="1" step="0.05"
               data-retrieval-key="paraphraseTemperature" value="${c.paraphraseTemperature}">
        <small>
          LLM sampling temperature for paraphrases. Default
          <strong>${RETRIEVAL_DEFAULTS.paraphraseTemperature}</strong>
          (deterministic — required for reproducible measurement runs).
          Raise to encourage more diverse phrasings.
        </small>
      </div>

      <h4 style="margin-top: 1.6rem;">Cross-file query expansion (lever B)</h4>
      <p class="settings-help">
        Codebase-aware identifier-vocabulary alternatives — the LLM emits
        the symbol names an engineer would actually type into a code-search
        box (<code>register_capability</code>, <code>RbacContext</code>).
        Composer drops the baseline ranking from the fusion (the
        "drop-baseline-from-fusion" rule from the
        <a href="../docs/ROADMAP.md">2026-05-07 lever-B probe</a>) and RRF-fuses
        only the alts. Best on natural-language queries that don't share
        vocabulary with the codebase (e.g. "how does the request pipeline
        enforce role-based access control?" vs. <code>RbacFilter</code>).
      </p>

      <div class="form-group" data-setting-key="retrieval.crossFileExpansionMode">
        <label>Cross-file expansion mode</label>
        <div style="display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.4rem;">
          <label style="display: flex; gap: 0.5rem; align-items: center; font-weight: normal;">
            <input type="radio" name="crossFileExpansionMode" value="off"
                   data-retrieval-key="crossFileExpansionMode"
                   ${c.crossFileExpansionMode === 'off' ? 'checked' : ''}>
            <span><strong>Off</strong> — no expansion; original query only (default).</span>
          </label>
          <label style="display: flex; gap: 0.5rem; align-items: center; font-weight: normal;">
            <input type="radio" name="crossFileExpansionMode" value="primary"
                   data-retrieval-key="crossFileExpansionMode"
                   ${c.crossFileExpansionMode === 'primary' ? 'checked' : ''}>
            <span><strong>Use primary chat model</strong> — reuses the model in <em>LLM</em> tab.</span>
          </label>
          <label style="display: flex; gap: 0.5rem; align-items: center; font-weight: normal;">
            <input type="radio" name="crossFileExpansionMode" value="utility"
                   data-retrieval-key="crossFileExpansionMode"
                   ${c.crossFileExpansionMode === 'utility' ? 'checked' : ''}>
            <span><strong>Use utility model</strong> — separate, typically smaller/cheaper model.</span>
          </label>
        </div>
        ${paraphraseActive ? `<small style="color: var(--accent, #888); display: block; margin-top: 0.4rem;">
          Paraphrase is currently active — switching expansion on will turn
          paraphrase off (mutually exclusive).
        </small>` : ''}
      </div>

      <div class="form-group" data-setting-key="retrieval.crossFileExpanderModelId" ${expansionUtilityHidden}>
        <label for="retrievalExpanderModelId">Utility model id</label>
        <input id="retrievalExpanderModelId" type="text"
               data-retrieval-key="crossFileExpanderModelId"
               value="${c.crossFileExpanderModelId.replace(/"/g, '&quot;')}"
               placeholder="e.g. claude-haiku-4-5-20251001">
        <small>
          Provider must be the same as your primary chat model.
        </small>
      </div>

      <div class="form-group" data-setting-key="retrieval.crossFileExpanderRounds">
        <label for="retrievalExpanderRounds">Alts per query</label>
        <input id="retrievalExpanderRounds" type="number" min="1" max="5" step="1"
               data-retrieval-key="crossFileExpanderRounds" value="${c.crossFileExpanderRounds}">
        <small>
          How many identifier-vocabulary alternatives to request. Default
          <strong>${RETRIEVAL_DEFAULTS.crossFileExpanderRounds}</strong>
          (mirrors the lever-B probe). Range 1–5.
        </small>
      </div>

      <div class="form-group" data-setting-key="retrieval.crossFileExpanderTemperature">
        <label for="retrievalExpanderTemperature">Expansion temperature</label>
        <input id="retrievalExpanderTemperature" type="number" min="0" max="1" step="0.05"
               data-retrieval-key="crossFileExpanderTemperature" value="${c.crossFileExpanderTemperature}">
        <small>
          LLM sampling temperature for expansion alts. Default
          <strong>${RETRIEVAL_DEFAULTS.crossFileExpanderTemperature}</strong>
          (deterministic). Raise to encourage broader identifier coverage.
        </small>
      </div>

      <h4 style="margin-top: 1.6rem;">Sub-agent utility model</h4>
      <p class="settings-help">
        Cheap-tier model id <code>delegate_task</code> sub-agents run on by
        default. Delivers the <em>spend</em> half of sub-agent
        bounded-trust + bounded-spend
        (<a href="../docs/DESIGN-sub-agents.md">DESIGN-sub-agents.md</a> §"The
        Load-Bearing Decision") — the parent's tokens are saved by
        context-isolation, the child's tokens cost less by running on a
        smaller model. Empty falls through to the paraphrase utility model
        above, then to the primary chat model. Per-call override available
        via the <code>delegate_task({ model })</code> arg.
      </p>

      <div class="form-group" data-setting-key="retrieval.subagentModelId">
        <label for="retrievalSubagentModelId">Sub-agent model id</label>
        <input id="retrievalSubagentModelId" type="text"
               data-retrieval-key="subagentModelId"
               value="${c.subagentModelId.replace(/"/g, '&quot;')}"
               placeholder="e.g. claude-haiku-4-5-20251001">
        <small>
          Provider must be the same as your primary chat model
          (provider/endpoint/key are reused).
        </small>
      </div>
    `;
}

// Test seam.
export const __test__ = { _read, _persist, RETRIEVAL_DEFAULTS };

// 2.44.0.2 — replaces the `tab.dataset.tab === 'tabRetrieval'` branch in
// `js/settings-manager.js`'s pre-2.44.0.2 switch statement.
registerOnActivate('tabRetrieval', initRetrievalTab);
