// @ts-check
/**
 * Inline AI ghost-text suggestions (1.4.7).
 *
 * Hotkey-triggered single-completion overlay rendered as a CodeMirror 6
 * decoration. Default hotkey is `Tab`, configurable via
 * `State.settings.ghostText.hotkey`. When Tab is the hotkey there is an
 * indent carve-out: at line-start indent positions, Tab still indents
 * (existing CM6 behavior); mid-line / after non-whitespace, Tab triggers
 * a completion. Same convention as Copilot/Cursor.
 *
 * Cost control: the overlay is *never*
 * automatic. There is no idle polling, no debounced auto-trigger, no
 * "pre-warm on cursor move." One LLM call per user keypress, throttled
 * to a single in-flight request at a time.
 *
 * State machine
 * -------------
 *   IDLE → REQUESTING → SHOWING → IDLE
 *
 *   IDLE     Tab (carve-out passes)         → fires request → REQUESTING
 *   REQUESTING Tab                          → no-op (intent already noted)
 *   REQUESTING Esc / typing                 → abort → IDLE
 *   SHOWING  Tab                            → accept → IDLE
 *   SHOWING  Esc / typing / cursor move     → dismiss → IDLE
 *
 * The throttle and abort live module-local (not in editor state) because
 * the network promise lives outside CM transactions.
 *
 * Removability: setting `?ghostText=off` (or
 * `State.settings.ghostText.enabled === false`) configures the
 * compartment empty — no decoration, no keymap binding, no behavior
 * change. Tab indents universally in that mode.
 *
 * @since 1.4.7
 * @module editor/ghost-text
 */

import { State, EventBus } from '../core.js';
import { CM } from './setup.js';
import { LLMDebug } from '../llm/debug.js';
import { requestGhostTextCompletion, sliceContextAroundCursor } from '../llm/completion.js';
import { getLanguageFromPath } from '../prompts.js';

// ============================================
// CONFIG / DEFAULTS
// ============================================

export const GHOST_TEXT_DEFAULTS = Object.freeze({
    enabled: false,
    hotkey: 'Tab',
    maxTokens: 150,
    contextLines: 40,
    model: '',
});

/**
 * Read the ghost-text settings subtree, falling back to defaults for any
 * missing key. `State.settings.ghostText` may be undefined on first load.
 * @returns {{enabled: boolean, hotkey: string, maxTokens: number, contextLines: number, model: string}}
 */
export function getGhostTextSettings() {
    const raw = (State && State.settings && State.settings.ghostText) || {};
    return {
        enabled: raw.enabled === true,
        hotkey: typeof raw.hotkey === 'string' && raw.hotkey ? raw.hotkey : GHOST_TEXT_DEFAULTS.hotkey,
        maxTokens: Number.isFinite(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens : GHOST_TEXT_DEFAULTS.maxTokens,
        contextLines: Number.isFinite(raw.contextLines) && raw.contextLines > 0 ? raw.contextLines : GHOST_TEXT_DEFAULTS.contextLines,
        model: typeof raw.model === 'string' ? raw.model : '',
    };
}

/**
 * URL-flag kill switch (Decision §7 removability check).
 * @returns {boolean} True iff `?ghostText=off` is set.
 */
export function isGhostTextDisabledByFlag() {
    try {
        const u = new URL(window.location.href);
        return u.searchParams.get('ghostText') === 'off';
    } catch (_) {
        return false;
    }
}

// ============================================
// STATE MACHINE — module-scoped throttle + abort
// ============================================

/**
 * @typedef {'idle'|'requesting'|'showing'} GhostTextStatus
 */

let _inFlight = false;
/** @type {AbortController|null} */
let _activeAbort = null;
let _requestSeq = 0;

/** Reset throttle (used by tests + on accept/dismiss). */
function _clearInFlight() {
    _inFlight = false;
    _activeAbort = null;
}

/**
 * @returns {{inFlight: boolean, requestSeq: number}}
 */
export function _getThrottleStateForTest() {
    return { inFlight: _inFlight, requestSeq: _requestSeq };
}

export function _resetForTest() {
    _clearInFlight();
    _requestSeq = 0;
}

// ============================================
// STATEFIELD — CM6-internal status
// ============================================

let _stateEffectSet = null;

function _getEffects() {
    if (_stateEffectSet) return _stateEffectSet;
    if (!CM.StateEffect) return null;
    _stateEffectSet = {
        requested:  CM.StateEffect.define(),  // payload: { anchor, requestId }
        received:   CM.StateEffect.define(),  // payload: { suggestion, anchor, requestId }
        accepted:   CM.StateEffect.define(),  // payload: null
        dismissed:  CM.StateEffect.define(),  // payload: null
    };
    return _stateEffectSet;
}

let _stateField = null;

function _getStateField() {
    if (_stateField) return _stateField;
    if (!CM.StateField) return null;
    const E = _getEffects();
    if (!E) return null;

    _stateField = CM.StateField.define({
        create() {
            return /** @type {{status: GhostTextStatus, suggestion: string, anchor: number, requestId: number}} */ ({
                status: 'idle',
                suggestion: '',
                anchor: 0,
                requestId: 0,
            });
        },
        update(value, tr) {
            // Effects take precedence over docChanged.
            for (const effect of tr.effects) {
                if (effect.is(E.requested)) {
                    return { status: 'requesting', suggestion: '', anchor: effect.value.anchor, requestId: effect.value.requestId };
                }
                if (effect.is(E.received)) {
                    return { status: 'showing', suggestion: effect.value.suggestion, anchor: effect.value.anchor, requestId: effect.value.requestId };
                }
                if (effect.is(E.accepted)) {
                    return { status: 'idle', suggestion: '', anchor: 0, requestId: 0 };
                }
                if (effect.is(E.dismissed)) {
                    return { status: 'idle', suggestion: '', anchor: 0, requestId: 0 };
                }
            }
            // Any docChange while SHOWING dismisses (the user typed; their
            // edit takes precedence over the suggestion). Map anchor through
            // the changes if we keep it; we don't, so just bail.
            if (tr.docChanged && value.status === 'showing') {
                return { status: 'idle', suggestion: '', anchor: 0, requestId: 0 };
            }
            // Cursor moved while SHOWING (no doc change) also dismisses.
            // The widget anchor is sticky; moving away from it is intent.
            if (!tr.docChanged && tr.selection && value.status === 'showing') {
                const head = tr.state.selection.main.head;
                if (head !== value.anchor) {
                    return { status: 'idle', suggestion: '', anchor: 0, requestId: 0 };
                }
            }
            return value;
        },
    });
    return _stateField;
}

// ============================================
// WIDGET + DECORATION
// ============================================

let _widgetClass = null;

function _getWidgetClass() {
    if (_widgetClass) return _widgetClass;
    if (!CM.WidgetType) return null;
    _widgetClass = class GhostTextWidget extends CM.WidgetType {
        constructor(suggestion) {
            super();
            this._suggestion = suggestion || '';
        }
        eq(other) {
            return other && other._suggestion === this._suggestion;
        }
        toDOM() {
            const el = document.createElement('span');
            el.className = 'cm-ghost-text';
            el.dataset.cmIgnore = 'true';
            // Preserve newlines in the suggestion. Use textContent so any
            // markup in the model output is escaped.
            el.textContent = this._suggestion;
            el.title = 'Ghost suggestion · Tab to accept · Esc to dismiss';
            return el;
        }
        ignoreEvent() {
            return true;
        }
    };
    return _widgetClass;
}

let _viewPluginInstance = null;

function _buildViewPlugin() {
    if (_viewPluginInstance) return _viewPluginInstance;
    if (!CM.ViewPlugin || !CM.EditorView) return null;

    const field = _getStateField();
    if (!field) return null;

    _viewPluginInstance = CM.ViewPlugin.fromClass(class {
        constructor(view) {
            this.decorations = _renderDecorations(view);
        }
        update(update) {
            this.decorations = _renderDecorations(update.view);
        }
    }, {
        decorations: v => v.decorations,
    });
    return _viewPluginInstance;
}

function _renderDecorations(view) {
    if (!CM.Decoration) return null;
    const field = _getStateField();
    if (!field) return CM.Decoration.none;
    const value = view.state.field(field, false);
    if (!value || value.status !== 'showing' || !value.suggestion) {
        return CM.Decoration.none;
    }
    const WidgetClass = _getWidgetClass();
    if (!WidgetClass) return CM.Decoration.none;

    const docLen = view.state.doc.length;
    const anchor = Math.max(0, Math.min(value.anchor | 0, docLen));
    const deco = CM.Decoration.widget({
        widget: new WidgetClass(value.suggestion),
        side: 1,
    }).range(anchor);
    return CM.Decoration.set([deco]);
}

function _buildTheme() {
    if (!CM.EditorView?.theme) return null;
    return CM.EditorView.theme({
        '.cm-ghost-text': {
            opacity: '0.55',
            fontStyle: 'italic',
            color: 'var(--text-muted, #8b8b8b)',
            whiteSpace: 'pre',
            pointerEvents: 'none',
            userSelect: 'none',
        },
    });
}

// ============================================
// CONTEXT DETECTION
// ============================================

/**
 * True when the cursor sits at a line-start indent position — i.e. the
 * line up to the cursor is whitespace only. Used by the Tab-default
 * carve-out so Tab still indents at line start.
 *
 * @param {string} text
 * @param {number} cursor
 * @returns {boolean}
 */
export function isAtIndentContext(text, cursor) {
    if (typeof text !== 'string') return true;
    const offset = Math.max(0, Math.min(cursor | 0, text.length));
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const before = text.slice(lineStart, offset);
    return /^\s*$/.test(before);
}

// ============================================
// COMMANDS — fired from keymap handlers
// ============================================

/**
 * Trigger a completion request at the current cursor. No-op when:
 *   - feature disabled
 *   - URL kill-switch active
 *   - already in flight (throttle)
 *   - the editor has no LLM endpoint configured (the network call would
 *     throw; surface this as a console warning rather than a cryptic
 *     fetch error mid-keypress)
 *
 * Returns true iff the keystroke was claimed by this handler.
 *
 * @param {EditorView} view
 * @param {{filename?: string}} [opts]
 * @returns {boolean}
 */
export function triggerCompletion(view, opts = {}) {
    const settings = getGhostTextSettings();
    if (!settings.enabled || isGhostTextDisabledByFlag()) return false;
    if (_inFlight) return false;
    if (!State.settings || !State.settings.llmEndpoint) {
        console.warn('[ghost-text] no LLM endpoint configured — skipping');
        return false;
    }

    const E = _getEffects();
    const field = _getStateField();
    if (!E || !field) return false;

    const cursor = view.state.selection.main.head;
    const docText = view.state.doc.toString();
    const { prefix, suffix } = sliceContextAroundCursor(docText, cursor, settings.contextLines);
    const filename = opts.filename || (State.currentFile && State.currentFile.path) || '';
    const language = getLanguageFromPath(filename);

    const requestId = ++_requestSeq;
    const abort = new AbortController();
    _inFlight = true;
    _activeAbort = abort;

    view.dispatch({
        effects: [E.requested.of({ anchor: cursor, requestId })],
    });
    EventBus.emit('ghostText:requested', { requestId, anchor: cursor });

    requestGhostTextCompletion({
        prefix,
        suffix,
        language,
        filename,
        signal: abort.signal,
        model: settings.model || undefined,
        maxTokens: settings.maxTokens,
    })
        .then(suggestion => {
            // Drop the result if a different request superseded us
            // (shouldn't happen with single-flight, but defensive).
            const cur = view.state.field(field, false);
            if (!cur || cur.requestId !== requestId) return;

            const trimmed = (suggestion || '').replace(/^\s+/, '');
            if (!trimmed) {
                // Empty suggestion — silent transition back to IDLE.
                view.dispatch({ effects: [E.dismissed.of(null)] });
                EventBus.emit('ghostText:empty', { requestId });
                return;
            }
            view.dispatch({
                effects: [E.received.of({ suggestion: trimmed, anchor: cur.anchor, requestId })],
            });
            EventBus.emit('ghostText:received', { requestId, length: trimmed.length });
        })
        .catch(err => {
            if (err && err.name === 'AbortError') return;
            console.warn('[ghost-text] request failed:', err && err.message);
            try {
                LLMDebug.logChunk(String(err && err.message || err), { type: 'ghost-text-error' });
            } catch (_) { /* swallow */ }
            view.dispatch({ effects: [E.dismissed.of(null)] });
            EventBus.emit('ghostText:failed', { requestId, error: err && err.message });
        })
        .finally(() => {
            if (_activeAbort === abort) _clearInFlight();
        });

    return true;
}

/**
 * Accept the showing suggestion: insert the text at the anchor and
 * transition to IDLE.
 *
 * @param {EditorView} view
 * @returns {boolean} True iff a suggestion was accepted.
 */
export function acceptCompletion(view) {
    const field = _getStateField();
    const E = _getEffects();
    if (!field || !E) return false;
    const cur = view.state.field(field, false);
    if (!cur || cur.status !== 'showing' || !cur.suggestion) return false;

    view.dispatch({
        changes: { from: cur.anchor, to: cur.anchor, insert: cur.suggestion },
        effects: [E.accepted.of(null)],
        selection: { anchor: cur.anchor + cur.suggestion.length },
    });
    EventBus.emit('ghostText:accepted', { length: cur.suggestion.length });
    return true;
}

/**
 * Dismiss any in-flight or showing suggestion. Aborts the network call
 * if one is pending.
 *
 * @param {EditorView} view
 * @returns {boolean} True iff a suggestion was dismissed or a request aborted.
 */
export function dismissCompletion(view) {
    const field = _getStateField();
    const E = _getEffects();
    if (!field || !E) return false;
    const cur = view.state.field(field, false);
    const wasActive = !!cur && cur.status !== 'idle';

    if (_activeAbort) {
        try { _activeAbort.abort(); } catch (_) { /* swallow */ }
    }
    _clearInFlight();

    if (wasActive) {
        view.dispatch({ effects: [E.dismissed.of(null)] });
        EventBus.emit('ghostText:dismissed', {});
        return true;
    }
    return false;
}

// ============================================
// KEYMAP
// ============================================

/**
 * Build the keymap bindings for the configured hotkey + Esc + Tab-accept.
 *
 * Behavior summary:
 *   - When `hotkey === 'Tab'`:
 *       * Pressing Tab while SHOWING accepts (via the same handler).
 *       * At indent context, return false → indentWithTab handles it.
 *       * Otherwise, fire trigger.
 *   - When `hotkey !== 'Tab'`:
 *       * Tab always falls through to indentWithTab unless SHOWING (then
 *         accepts).
 *       * The configured hotkey unconditionally triggers (no carve-out).
 *
 * @param {string} hotkey
 * @returns {Array}
 */
function _buildBindings(hotkey) {
    const bindings = [];
    const tabBinding = {
        key: 'Tab',
        run: (view) => {
            // SHOWING → accept first.
            if (acceptCompletion(view)) return true;
            // If Tab IS the trigger hotkey, decide based on indent context.
            if (hotkey === 'Tab') {
                const cursor = view.state.selection.main.head;
                const text = view.state.doc.toString();
                if (isAtIndentContext(text, cursor)) {
                    return false; // let indentWithTab indent
                }
                return triggerCompletion(view);
            }
            // Hotkey is not Tab → Tab always indents.
            return false;
        },
    };
    bindings.push(tabBinding);

    if (hotkey && hotkey !== 'Tab') {
        bindings.push({
            key: hotkey,
            run: (view) => triggerCompletion(view),
        });
    }

    bindings.push({
        key: 'Escape',
        run: (view) => dismissCompletion(view),
    });

    return bindings;
}

// ============================================
// COMPARTMENT + EXTENSION BUILDER
// ============================================

let _compartment = null;

/**
 * The reconfigurable compartment. Created lazily (after CM has loaded).
 * @returns {Compartment|null}
 */
export function getGhostTextCompartment() {
    if (_compartment) return _compartment;
    if (!CM.Compartment) return null;
    _compartment = new CM.Compartment();
    return _compartment;
}

/**
 * Build the extension array for the ghost-text feature.
 * Returns `[]` when disabled — the compartment installs zero-cost.
 *
 * @returns {Array}
 */
export function buildGhostTextExtension() {
    const settings = getGhostTextSettings();
    if (!settings.enabled || isGhostTextDisabledByFlag()) return [];
    if (!CM.keymap || !CM.keymap.of) return [];

    const field = _getStateField();
    const plugin = _buildViewPlugin();
    const theme = _buildTheme();
    if (!field || !plugin) return [];

    const km = CM.keymap.of(_buildBindings(settings.hotkey));

    return [field, plugin, theme, km].filter(Boolean);
}

/**
 * Reconfigure the live editor when settings change. No-op if the
 * compartment isn't installed.
 *
 * @param {EditorView} view
 */
export function refreshGhostTextExtension(view) {
    if (!view) return;
    const comp = getGhostTextCompartment();
    if (!comp) return;
    // If a request is in flight, abort it — the new config supersedes.
    if (_activeAbort) {
        try { _activeAbort.abort(); } catch (_) { /* swallow */ }
    }
    _clearInFlight();
    view.dispatch({ effects: comp.reconfigure(buildGhostTextExtension()) });
}
