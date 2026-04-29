/**
 * AI Editor — Invisible Unicode Editor Decoration (CodeMirror 6 Extension)
 *
 * Renders zero-width / bidi-override / glassworm tag-block characters as
 * visible inline widgets so a casual reader can see them.  Click a widget
 * to delete the underlying character.  `Mod-Shift-U` strips every
 * invisible character in the current selection.
 *
 * Powered by `js/security/invisible-unicode.js` — the character ranges
 * live there.  The CI lint at `.gitea/workflows/ci.yaml` covers the same
 * ranges at PR time; this module covers source the user opens in the
 * editor.
 *
 * Usage (`js/editor/instance.js`):
 *   const comp = getInvisibleUnicodeCompartment();
 *   if (comp) extensions.push(comp.of(buildInvisibleUnicodeExtension(filename, enabled)));
 *   // Toggle later (Settings change or file swap):
 *   setInvisibleUnicodeMode(editorView, filename, enabled);
 *
 * @module editor/invisible-unicode-decoration
 */

import { CM } from './setup.js';
import { scan, findingsToCharRanges, stripInvisible, shouldScan } from '../security/invisible-unicode.js';

let _compartment = null;

/**
 * Get the invisible-Unicode compartment. Created lazily after CM has loaded.
 * @returns {Compartment|null}
 */
export function getInvisibleUnicodeCompartment() {
    if (_compartment) return _compartment;
    if (!CM.Compartment) return null;
    _compartment = new CM.Compartment();
    return _compartment;
}

let _widgetClass = null;

function _getWidgetClass() {
    if (_widgetClass) return _widgetClass;
    if (!CM.WidgetType) return null;

    _widgetClass = class InvisibleUnicodeWidget extends CM.WidgetType {
        constructor(finding) {
            super();
            this._finding = finding;
        }
        eq(other) {
            return other._finding.codepoint === this._finding.codepoint &&
                   other._finding.index === this._finding.index;
        }
        toDOM() {
            const el = document.createElement('span');
            el.className = 'cm-invisible-unicode';
            el.dataset.codepoint = this._finding.codepoint.toString(16);
            el.dataset.cmIgnore = 'true';
            const hex = `U+${this._finding.codepoint
                .toString(16)
                .toUpperCase()
                .padStart(4, '0')}`;
            el.textContent = hex;
            el.title = `Invisible Unicode: ${this._finding.name} (${hex})\nClick to delete · supply-chain risk — see docs/SECURITY.md`;
            return el;
        }
        ignoreEvent(event) {
            // Allow click events to bubble so our handler can run.
            return event.type !== 'click' && event.type !== 'mousedown';
        }
    };
    return _widgetClass;
}

function _buildDecorationSet(text) {
    if (!CM.Decoration) return null;
    const findings = scan(text);
    if (findings.length === 0) return CM.Decoration.none;
    const WidgetClass = _getWidgetClass();
    if (!WidgetClass) return CM.Decoration.none;

    const ranges = findingsToCharRanges(findings);
    const decorations = findings.map((finding, i) => {
        const { from, to } = ranges[i];
        return CM.Decoration.replace({
            widget: new WidgetClass(finding)
        }).range(from, to);
    });
    return CM.Decoration.set(decorations, true);
}

let _viewPluginInstance = null;

function _buildViewPlugin() {
    if (_viewPluginInstance) return _viewPluginInstance;
    if (!CM.ViewPlugin || !CM.EditorView) return null;

    _viewPluginInstance = CM.ViewPlugin.fromClass(class {
        constructor(view) {
            this.decorations = _buildDecorationSet(view.state.doc.toString()) || CM.Decoration.none;
        }
        update(update) {
            if (update.docChanged) {
                this.decorations = _buildDecorationSet(update.state.doc.toString()) || CM.Decoration.none;
            }
        }
    }, {
        decorations: v => v.decorations,
        eventHandlers: {
            click(event, view) {
                const target = event.target;
                if (!target || !target.classList || !target.classList.contains('cm-invisible-unicode')) {
                    return false;
                }
                const pos = view.posAtDOM(target);
                if (pos == null) return false;
                const text = view.state.doc.toString();
                const findings = scan(text);
                const hit = findings.find(f => f.index === pos);
                if (!hit) return false;
                view.dispatch({
                    changes: { from: hit.index, to: hit.index + hit.char.length, insert: '' }
                });
                event.preventDefault();
                return true;
            }
        }
    });
    return _viewPluginInstance;
}

function _buildTheme() {
    if (!CM.EditorView?.theme) return null;
    return CM.EditorView.theme({
        '.cm-invisible-unicode': {
            display: 'inline-block',
            padding: '0 3px',
            margin: '0 1px',
            border: '1px solid var(--error, #f14c4c)',
            borderRadius: '3px',
            background: 'color-mix(in srgb, var(--error, #f14c4c) 18%, transparent)',
            color: 'var(--error, #f14c4c)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: '0.85em',
            fontWeight: '600',
            lineHeight: '1',
            verticalAlign: 'baseline',
            cursor: 'pointer',
            userSelect: 'none'
        },
        '.cm-invisible-unicode:hover': {
            background: 'color-mix(in srgb, var(--error, #f14c4c) 32%, transparent)'
        }
    });
}

function _stripSelectionCommand(view) {
    const { state } = view;
    const changes = [];
    for (const range of state.selection.ranges) {
        if (range.empty) continue;
        const slice = state.doc.sliceString(range.from, range.to);
        const stripped = stripInvisible(slice);
        if (stripped !== slice) {
            changes.push({ from: range.from, to: range.to, insert: stripped });
        }
    }
    if (changes.length === 0) return false;
    view.dispatch({ changes });
    return true;
}

/**
 * Build the extension array for the invisible-Unicode decoration.
 *
 * Returns `[]` when:
 *   - The setting is disabled (`enabled === false`)
 *   - The filename's extension is a prose format (Markdown, HTML, XML — see `shouldScan`)
 *   - CodeMirror APIs aren't loaded yet
 *
 * @param {string} filename
 * @param {boolean} enabled — value of `State.settings.editorScanInvisibleUnicode`
 * @returns {Array}
 */
export function buildInvisibleUnicodeExtension(filename, enabled) {
    if (enabled === false) return [];
    if (!shouldScan(filename || '')) return [];
    const plugin = _buildViewPlugin();
    if (!plugin) return [];
    const theme = _buildTheme();
    const keymap = (CM.keymap && CM.keymap.of)
        ? CM.keymap.of([{
            key: 'Mod-Shift-u',
            run: _stripSelectionCommand
        }])
        : null;
    return [plugin, theme, keymap].filter(Boolean);
}

/**
 * Reconfigure the decoration on a live editor (Settings toggle, file swap).
 * No-op if the compartment isn't installed.
 *
 * @param {EditorView} view
 * @param {string} filename
 * @param {boolean} enabled
 */
export function setInvisibleUnicodeMode(view, filename, enabled) {
    if (!view) return;
    const comp = getInvisibleUnicodeCompartment();
    if (!comp) return;
    view.dispatch({
        effects: comp.reconfigure(buildInvisibleUnicodeExtension(filename, enabled))
    });
}
