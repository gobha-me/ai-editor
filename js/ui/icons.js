/**
 * AI Editor — Icon Library
 *
 * Lucide-shaped line icons ported from `docs/design/touch-2-facelift/project/icons.jsx`.
 *
 * **Offline by construction.** Every SVG path is inlined as a string. Nothing
 * fetches at runtime; the icon set ships with the JS bundle. Air-gapped Docker
 * images render the same icons as internet-connected ones. (Future swap to
 * `lucide-static` would go through Stage 1 of the Dockerfile alongside the
 * other vendor bundles; this module is the offline-safe contract until then.)
 *
 * Each value is a ready-to-render SVG string with `class="icn"`. Use directly
 * in template literals (`${Icon.Bolt}`) or innerHTML paths. For the rare case
 * needing a class/label override, call `renderIcon(name, opts)`.
 *
 * Sizing/stroke/color come from `css/icons.css` + the `--tk-icon-*` token
 * contract added in 1.3.11. Don't hardcode dimensions on the SVG itself.
 *
 * Added: 1.3.11 (2026-05-01) — Touch 2 PROBE iconography.
 */

const SVG_OPEN  = '<svg class="icn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

function svg(body) {
    return SVG_OPEN + body + SVG_CLOSE;
}

export const Icon = {
    // ===== Brand / chrome =====
    Bolt:        svg('<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>'),
    Sparkles:    svg('<path d="m12 3-2 5-5 2 5 2 2 5 2-5 5-2-5-2ZM19 3v4M21 5h-4M3 17v4M5 19H1"/>'),

    // ===== Navigation / surfaces =====
    Settings:    svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1 1.7 1.7 0 0 0 .3 1.8M3 11a2 2 0 1 0 0 4h.1a1.7 1.7 0 0 1 1.5 1M5.6 5.6a2 2 0 0 0 0 2.8M11 3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5"/>'),
    Help:        svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
    Bug:         svg('<path d="M8 6h8v6a4 4 0 0 1-8 0ZM2 22l3-3M22 22l-3-3"/>'),
    Search:      svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    Plug:        svg('<path d="M12 22v-5M9 7V2M15 7V2M6 13V8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z"/>'),

    // ===== File / project =====
    Box:         svg('<path d="m21 16-9 5-9-5V8l9-5 9 5v8Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>'),
    Folder:      svg('<path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/>'),
    FileEdit:    svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10.4 12.6 4-4 2 2-4 4H10.4Z"/>'),
    Code:        svg('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>'),

    // ===== Git =====
    GitBranch:   svg('<circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 5v14M6 14a6 6 0 0 1 6-6h2a4 4 0 0 0 4-4"/>'),
    GitCommit:   svg('<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>'),
    GitCompare:  svg('<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h6a4 4 0 0 1 4 4v8M17 18h-6a4 4 0 0 1-4-4V6"/>'),
    GitMerge:    svg('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8M6 16a8 8 0 0 0 8-8h2"/>'),
    GitPullRequest: svg('<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M11 6h3a4 4 0 0 1 4 4v6"/>'),

    // ===== Editor toolbar =====
    Undo:        svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v6"/>'),
    Eye:         svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
    Hash:        svg('<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>'),
    Maximize:    svg('<path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4"/>'),

    // ===== Generic actions =====
    Plus:        svg('<path d="M12 5v14M5 12h14"/>'),
    Close:       svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    X:           svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    More:        svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    Send:        svg('<path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/>'),
    Paperclip:   svg('<path d="m21.4 11-9 9a5 5 0 1 1-7-7l9-9a3.5 3.5 0 1 1 5 5l-8.9 9a2 2 0 1 1-3-3l8.4-8.4"/>'),
    AtSign:      svg('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
    Refresh:     svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    Copy:        svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    Pause:       svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
    Play:        svg('<path d="m6 3 14 9-14 9V3Z"/>'),
    ChevronRight: svg('<path d="m9 6 6 6-6 6"/>'),
    ChevronDown: svg('<path d="m6 9 6 6 6-6"/>'),

    // ===== Domain =====
    Layers:      svg('<path d="m12 2 9 5-9 5-9-5 9-5Zm-9 15 9 5 9-5M3 12l9 5 9-5"/>'),
    Brain:       svg('<path d="M9 5a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 1 2.2 3 3 0 0 0-.5 1.8 3 3 0 0 0 3 3 3 3 0 0 0 2.5 1.5A3 3 0 0 0 12 21V5a3 3 0 0 0-3-3M15 5a3 3 0 0 1 3 3 3 3 0 0 1 3 3 3 3 0 0 1-1 2.2 3 3 0 0 1 .5 1.8 3 3 0 0 1-3 3 3 3 0 0 1-2.5 1.5A3 3 0 0 1 12 21"/>'),
    Palette:     svg('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2a10 10 0 1 0 9.7 12.5 1.5 1.5 0 0 0-1.5-2H17a2 2 0 0 1-2-2 2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 0 1.5-1.7A10 10 0 0 0 12 2Z"/>'),
    Server:      svg('<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>'),
    Database:    svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/>'),
    ListChecks:  svg('<path d="m3 6 2 2 4-4M3 14l2 2 4-4M13 6h8M13 12h8M13 18h8"/>'),
    Link:        svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/>'),
    Activity:    svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    Filter:      svg('<path d="M3 4h18l-7 9v6l-4 2v-8Z"/>'),

    // ===== Save / danger / status =====
    Save:        svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
    AlertTriangle: svg('<path d="M12 3 2 21h20Z"/><path d="M12 9v4M12 17h.01"/>'),
    Pencil:      svg('<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
    Trash:       svg('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    DollarSign:  svg('<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    Square:      svg('<rect x="3" y="3" width="18" height="18" rx="2"/>'),
    SquareCheck: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 5-6"/>'),

    // ===== External / web =====
    Globe:       svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z"/>'),

    // ===== Debug / diagnostics =====
    Puzzle:      svg('<path d="M19 11h2a2 2 0 0 1 0 4h-2v2a2 2 0 0 1-2 2h-2a2 2 0 1 1 0-4v-2a2 2 0 0 1 2-2h2zM4 12a2 2 0 0 1 2-2h2V8a2 2 0 0 1 2-2h2a2 2 0 1 1 0 4h2v2a2 2 0 0 1-2 2h-2a2 2 0 1 0 0 4H6a2 2 0 0 1-2-2v-2z"/>'),
    Scroll:      svg('<path d="M8 3v2a2 2 0 0 1-2 2H4M16 3v2a2 2 0 0 0 2 2h2M5 7h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 11h8M8 15h6"/>'),

    // ===== Chat / conversation =====
    BookOpen:    svg('<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2ZM22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8Z"/>'),
    Clipboard:   svg('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/>'),
    Check:       svg('<path d="m4 12 5 5 11-11"/>'),
    ArrowUpDown: svg('<path d="m7 4-3 3 3 3M4 7h13M17 14l3 3-3 3M20 17H7"/>'),
    Stop:        svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
    BarChart:    svg('<path d="M3 21V11M9 21V3M15 21v-7M21 21v-4"/>'),
    Calendar:    svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
    Bell:        svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    Wrench:      svg('<path d="M14 7a3 3 0 1 0 3 3l4 4-4 4-4-4 1-2-2-1 2-2-1-2Z"/>'),
    Mic:         svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    Video:       svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m22 8-6 4 6 4Z"/>'),

    // ===== Sidebar / file-tree actions =====
    File:        svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    FilePlus:    svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6M9 15h6"/>'),
    FolderPlus:  svg('<path d="M4 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/>'),
    Download:    svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>'),
    Tag:         svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
    MessageSquare: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
    ChevronLeft:  svg('<path d="m15 6-6 6 6 6"/>'),

    // ===== Help-page only =====
    Book:        svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15ZM6.5 17H20v5H6.5A2.5 2.5 0 0 1 4 19.5v0A2.5 2.5 0 0 1 6.5 17Z"/>'),
    Map:         svg('<path d="M9 4 3 6v15l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v15M15 6v15"/>'),
    Coffee:      svg('<path d="M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8ZM6 2v3M10 2v3M14 2v3"/>'),
    Github:      svg('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.5c3-.4 6.1-1.5 6.1-6.7A5.2 5.2 0 0 0 19.8 5a4.9 4.9 0 0 0-.1-3.5s-1.2-.4-3.7 1.4a13 13 0 0 0-7 0C6.5 1 5.3 1.5 5.3 1.5A4.9 4.9 0 0 0 5.2 5a5.2 5.2 0 0 0-1.4 3.6c0 5.2 3.1 6.3 6.1 6.7a3.4 3.4 0 0 0-.9 2.5V22"/>'),
};

/**
 * Render an icon with optional class extension or aria label override.
 * Useful when the default `class="icn"` markup needs an additional modifier
 * (e.g. `icn--sm`) or when the icon is the sole content of an interactive
 * element and needs an accessible label.
 *
 * @param {string} name — key into `Icon`
 * @param {{ className?: string, label?: string }} [opts]
 * @returns {string} SVG markup
 */
export function renderIcon(name, opts = {}) {
    const base = Icon[name];
    if (!base) return '';
    let out = base;
    if (opts.className) {
        out = out.replace('class="icn"', `class="icn ${opts.className}"`);
    }
    if (opts.label) {
        const escaped = String(opts.label).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        out = out.replace('aria-hidden="true"', `role="img" aria-label="${escaped}"`);
    }
    return out;
}

// Make available on `window` for non-module callers (HTML partials, plugin
// sandboxes that don't import).
if (typeof window !== 'undefined') {
    window.Icon = Icon;
    window.renderIcon = renderIcon;
}
