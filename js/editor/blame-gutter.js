/**
 * AI Editor — Inline Blame Gutter (CodeMirror 6 Extension)
 *
 * Shows blame annotations in the editor gutter: SHA · author · date.
 * Only displays on the first line of each blame range (GitLens-style).
 *
 * Uses a Compartment so the gutter column only exists when blame data
 * is active — no empty 180px column when blame is off.
 *
 * Usage:
 *   import { getBlameCompartment, setBlameData, clearBlameData } from './blame-gutter.js';
 *
 *   // Add compartment when creating editor (starts empty = no gutter)
 *   const comp = getBlameCompartment();
 *   if (comp) extensions.push(comp.of([]));
 *
 *   // Push blame data into the editor — gutter appears
 *   setBlameData(editorView, blameRanges);
 *
 *   // Clear it — gutter disappears
 *   clearBlameData(editorView);
 */

import { CM } from './setup.js';

// ============================================
// COLOR PALETTE (matches secondary-pane.js)
// ============================================

const BLAME_PALETTE = [
    '#3b82f6', // blue
    '#10b981', // green
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
];

// ============================================
// COMPARTMENT (created lazily)
// ============================================

let _compartment = null;

/**
 * Get the blame compartment. Creates it lazily when CM is available.
 * Add `comp.of([])` to your editor extensions — starts empty (no gutter).
 * @returns {Compartment|null}
 */
export function getBlameCompartment() {
    if (_compartment) return _compartment;
    if (!CM.Compartment) return null;
    _compartment = new CM.Compartment();
    return _compartment;
}

// ============================================
// GUTTER MARKER (lazy subclass)
// ============================================

let BlameMarkerClass = null;

function _getMarkerClass() {
    if (BlameMarkerClass) return BlameMarkerClass;
    if (!CM.GutterMarker) return null;

    BlameMarkerClass = class BlameMarker extends CM.GutterMarker {
        constructor(info, color) {
            super();
            this._info = info;
            this._color = color;
        }

        toDOM() {
            const el = document.createElement('div');
            el.className = 'cm-blame-marker';
            el.style.borderLeft = `3px solid ${this._color}`;

            const sha = document.createElement('span');
            sha.className = 'cm-blame-sha';
            sha.textContent = this._info.shortSha;
            sha.title = this._info.message || '';
            sha.dataset.sha = this._info.sha;

            const author = document.createElement('span');
            author.className = 'cm-blame-author';
            author.textContent = _shortAuthor(this._info.author);

            const date = document.createElement('span');
            date.className = 'cm-blame-date';
            date.textContent = _shortDate(this._info.date);

            el.appendChild(sha);
            el.appendChild(author);
            el.appendChild(date);
            return el;
        }
    };

    return BlameMarkerClass;
}

// ============================================
// BUILD GUTTER EXTENSIONS FOR A DATA MAP
// ============================================

function _buildGutterExtensions(blameMap) {
    if (!CM.gutter || !CM.EditorView) return [];

    const MarkerClass = _getMarkerClass();
    if (!MarkerClass) return [];

    const gutterExt = CM.gutter({
        class: 'cm-blame-gutter',
        lineMarker(view, line) {
            if (!blameMap || blameMap.size === 0) return null;
            const lineNum = view.state.doc.lineAt(line.from).number;
            const info = blameMap.get(lineNum);
            if (!info) return null;
            return new MarkerClass(info, info._color);
        }
    });

    const theme = CM.EditorView.theme({
        '.cm-blame-gutter': {
            width: '180px',
            minWidth: '180px',
            background: 'var(--bg-secondary)',
            borderRight: '1px solid var(--border)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            cursor: 'default',
        },
        '.cm-blame-gutter .cm-gutterElement': {
            padding: '0 4px',
            display: 'flex',
            alignItems: 'center',
        },
        '.cm-blame-marker': {
            display: 'flex',
            gap: '6px',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            paddingLeft: '4px',
            width: '100%',
            lineHeight: '1.5',
        },
        '.cm-blame-sha': {
            color: 'var(--accent)',
            cursor: 'pointer',
            flexShrink: '0',
        },
        '.cm-blame-sha:hover': {
            textDecoration: 'underline',
        },
        '.cm-blame-author': {
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexShrink: '1',
            minWidth: '0',
        },
        '.cm-blame-date': {
            color: 'var(--text-muted)',
            flexShrink: '0',
            marginLeft: 'auto',
        },
    });

    return [gutterExt, theme];
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Push blame data into the editor. Injects the gutter via compartment.
 * @param {EditorView} view
 * @param {{ranges: Array}} blameData
 */
export function setBlameData(view, blameData) {
    const comp = getBlameCompartment();
    if (!comp || !view) return;

    const map = new Map();
    const commitColors = new Map();
    let colorIdx = 0;

    for (const range of (blameData?.ranges || [])) {
        const sha = range.commit.sha;
        if (!commitColors.has(sha)) {
            commitColors.set(sha, BLAME_PALETTE[colorIdx % BLAME_PALETTE.length]);
            colorIdx++;
        }

        const lineNum = range.startLine;
        if (lineNum && lineNum > 0) {
            map.set(lineNum, {
                sha: range.commit.sha,
                shortSha: range.commit.shortSha,
                author: range.commit.author,
                date: range.commit.date,
                message: range.commit.message,
                _color: commitColors.get(sha)
            });
        }
    }

    // Reconfigure compartment: inject gutter extensions
    const exts = _buildGutterExtensions(map);
    view.dispatch({ effects: comp.reconfigure(exts) });
}

/**
 * Clear blame data and remove the gutter column entirely.
 * @param {EditorView} view
 */
export function clearBlameData(view) {
    const comp = getBlameCompartment();
    if (!comp || !view) return;

    // Reconfigure compartment to empty = gutter column disappears
    view.dispatch({ effects: comp.reconfigure([]) });
}

// ============================================
// HELPERS
// ============================================

function _shortAuthor(name) {
    if (!name) return '';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 8);
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function _shortDate(dateStr) {
    if (!dateStr) return '';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr.slice(0, 10);
        const diffDays = Math.floor((Date.now() - d) / 86400000);
        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yday';
        if (diffDays < 30) return `${diffDays}d`;
        if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
        return `${d.getFullYear()}`;
    } catch { return ''; }
}
