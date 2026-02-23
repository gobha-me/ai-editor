/**
 * AI Editor - Markdown Viewer Modal
 *
 * Generic reusable modal that fetches a local markdown file,
 * renders it through marked + DOMPurify, and displays it in a
 * scrollable overlay. Used by onboarding (REPOS.md) and available
 * for CHANGELOG.md, README.md, etc.
 *
 * Usage:
 *   import { openMarkdownModal } from './markdown-modal.js';
 *   openMarkdownModal('REPOS.md', 'Git Provider Setup');
 */

// ============================================
// STATE
// ============================================

let _overlay = null;
let _cache = new Map();    // path → rendered HTML

// ============================================
// PUBLIC API
// ============================================

/**
 * Open the markdown viewer modal.
 * @param {string} path - Relative path to the .md file (e.g. 'REPOS.md')
 * @param {string} [title] - Modal title (falls back to filename)
 */
export async function openMarkdownModal(path, title) {
    _ensureDOM();

    const titleEl = _overlay.querySelector('#mdViewerTitle');
    const bodyEl = _overlay.querySelector('#mdViewerBody');
    const displayTitle = title || path.replace(/\.md$/i, '');

    titleEl.textContent = `📄 ${displayTitle}`;
    bodyEl.innerHTML = '<p style="color: var(--text-muted);">Loading…</p>';
    _overlay.classList.add('active');

    try {
        let html = _cache.get(path);
        if (!html) {
            const resp = await fetch(`./${path}`);
            if (!resp.ok) throw new Error(`Failed to load ${path} (${resp.status})`);
            const md = await resp.text();
            html = _renderMarkdown(md);
            _cache.set(path, html);
        }
        bodyEl.innerHTML = html;
    } catch (err) {
        bodyEl.innerHTML = `<p style="color: var(--error);">⚠️ ${_escapeHtml(err.message)}</p>`;
    }

    // Focus the close button for keyboard users
    _overlay.querySelector('.modal-close')?.focus();
}

/**
 * Close the modal.
 */
export function closeMarkdownModal() {
    if (_overlay) _overlay.classList.remove('active');
}

// ============================================
// DOM SETUP (lazy, once)
// ============================================

function _ensureDOM() {
    if (_overlay) return;

    _overlay = document.createElement('div');
    _overlay.className = 'modal-overlay';
    _overlay.id = 'mdViewerOverlay';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-modal', 'true');
    _overlay.setAttribute('aria-labelledby', 'mdViewerTitle');

    _overlay.innerHTML = `
        <div class="modal md-viewer-modal">
            <div class="modal-header">
                <h2 id="mdViewerTitle">📄 Document</h2>
                <button type="button" class="modal-close" aria-label="Close">×</button>
            </div>
            <div class="modal-body md-viewer-body" id="mdViewerBody">
            </div>
        </div>
    `;

    document.body.appendChild(_overlay);

    // Close button
    _overlay.querySelector('.modal-close').addEventListener('click', closeMarkdownModal);

    // Click backdrop to close
    _overlay.addEventListener('click', (e) => {
        if (e.target === _overlay) closeMarkdownModal();
    });

    // Escape to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _overlay.classList.contains('active')) {
            closeMarkdownModal();
        }
    });
}

// ============================================
// MARKDOWN RENDERING
// ============================================

function _renderMarkdown(md) {
    let html = md;

    if (typeof marked !== 'undefined') {
        try {
            html = marked.parse(md);
        } catch { /* fall through to raw */ }
    }

    if (typeof DOMPurify !== 'undefined') {
        html = DOMPurify.sanitize(html);
    } else {
        // SECURITY: DOMPurify not loaded — escape rather than pass through raw HTML
        console.warn('[SECURITY] DOMPurify not loaded — falling back to escaped output');
        html = _escapeHtml(md);
    }

    return html;
}

/** Local escape — avoids adding an import for this single use */
function _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
