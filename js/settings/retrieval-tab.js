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
    return {
        paraphraseMode: mode,
        paraphraseModelId: modelId,
        paraphraseRounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 3
            ? rounds
            : RETRIEVAL_DEFAULTS.paraphraseRounds,
        paraphraseTemperature: Number.isFinite(temp) && temp >= 0 && temp <= 1
            ? temp
            : RETRIEVAL_DEFAULTS.paraphraseTemperature,
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
    let value;
    if (key === 'paraphraseMode') {
        value = VALID_MODES.has(target.value)
            ? target.value
            : RETRIEVAL_DEFAULTS.paraphraseMode;
    } else if (key === 'paraphraseModelId') {
        value = target.value.trim();
    } else if (key === 'paraphraseRounds') {
        let v = Math.floor(Number(target.value));
        if (!Number.isFinite(v) || v < 1) v = RETRIEVAL_DEFAULTS.paraphraseRounds;
        if (v > 3) v = 3;
        target.value = String(v);
        value = v;
    } else if (key === 'paraphraseTemperature') {
        let v = Number(target.value);
        if (!Number.isFinite(v) || v < 0) v = RETRIEVAL_DEFAULTS.paraphraseTemperature;
        if (v > 1) v = 1;
        target.value = String(v);
        value = v;
    } else {
        return;
    }
    _persist({ [key]: value });
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
    root.innerHTML = `
      <h3>Retrieval</h3>
      <p class="settings-help">
        Configure the query-paraphrase pre-pass for the new retrieval pipeline.
        When enabled, your search query is rephrased into a few alternative
        wordings before embedding; the strategy fuses per-variant rankings
        via reciprocal rank fusion (RRF) and returns a single ranked list.
        Paraphrasing adds one chat-LLM call per <code>find_relevant_files</code>
        invocation — cached per query within a session. Disabled by default.
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
    `;
}

// Test seam.
export const __test__ = { _read, _persist, RETRIEVAL_DEFAULTS };
