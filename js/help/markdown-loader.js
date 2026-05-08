/**
 * Markdown loader — extracted from `js/app.js` `_loadHelpDoc` (1.3.9).
 *
 * Renders a markdown file into the Help content pane with marked.js +
 * DOMPurify. Caches per-path so a tab switch back is instant. Also
 * exports `loadDocText` returning plain text for the search index.
 *
 * Doc paths can be `docs/PLUGIN.md` (most pages) or root-relative like
 * `CHANGELOG.md`. The fetch URL is the path verbatim — `<base href>`
 * injected by the entry point handles sub-path resolution.
 */

import { escapeHtml } from '../utils/html.js';
import { DOC_PATHS } from './pages/markdown-pages.js';

const _htmlCache = new Map();
const _textCache = new Map();

/** Build a `{ "BASENAME.md": "page-id" }` lookup from `DOC_PATHS` so any
 *  `<a href="…/BASENAME.md">` that marked produces can be rewritten to
 *  in-app navigation. Recomputed on every call so tests that mutate
 *  `DOC_PATHS` see fresh state. */
function _basenameToPageId() {
    const out = {};
    for (const [id, path] of Object.entries(DOC_PATHS)) {
        const base = path.split('/').pop();
        if (base) out[base] = id;
    }
    return out;
}

/** Walk sanitized HTML for `<a href="…">` links. If the href resolves to
 *  a known help-page basename (e.g. `SECURITY.md`, `PLUGIN.md`), rewrite
 *  it to an in-app link the help slide-out can intercept. External
 *  links and same-page anchors pass through untouched.
 *  Exported for `tests/test-help-internal-links.mjs`. */
export function rewriteCrossDocLinks(html) {
    const map = _basenameToPageId();
    return String(html).replace(
        /<a\b([^>]*?)\shref="([^"]+)"([^>]*)>/gi,
        (match, before, href, after) => {
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:)/i.test(href)) return match;
            const cleanHref = href.replace(/^\.\//, '').split(/[?#]/)[0];
            const basename = cleanHref.split('/').pop();
            const pageId = map[basename];
            if (!pageId) return match;
            return `<a${before} href="#" data-help-page="${pageId}" class="help__internal-link"${after}>`;
        }
    );
}

/** Render markdown into a target element. The target must already
 *  exist; the caller controls the wrapper class.
 *  @param {HTMLElement} panel
 *  @param {string} docPath
 *  @returns {Promise<void>} */
export async function renderDocInto(panel, docPath) {
    if (!panel) return;

    if (_htmlCache.has(docPath)) {
        panel.innerHTML = `<div class="help__doc">${_htmlCache.get(docPath)}</div>`;
        return;
    }

    panel.innerHTML = '<div class="help__doc-loading">Loading documentation…</div>';

    try {
        const md = await fetchDocText(docPath);
        let html;
        if (typeof window.marked !== 'undefined') {
            const raw = window.marked.parse(md, { breaks: true, gfm: true });
            html = (typeof window.DOMPurify !== 'undefined')
                ? window.DOMPurify.sanitize(raw)
                : raw;
        } else {
            html = `<pre>${escapeHtml(md)}</pre>`;
        }
        html = rewriteCrossDocLinks(html);
        _htmlCache.set(docPath, html);
        panel.innerHTML = `<div class="help__doc">${html}</div>`;
    } catch (err) {
        console.warn(`[Help] Failed to load ${docPath}:`, err.message);
        panel.innerHTML = `<div class="help__doc-error">Could not load <code>${escapeHtml(docPath)}</code><br><small>${escapeHtml(err.message)}</small></div>`;
    }
}

/** Fetch the doc as plain text, with the same `text/html` SPA-fallback
 *  guard the original `_loadHelpDoc` had. Caches text for the search
 *  index. */
export async function fetchDocText(docPath) {
    if (_textCache.has(docPath)) return _textCache.get(docPath);

    const resp = await fetch(docPath);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);

    const ct = resp.headers.get('content-type') || '';
    const md = await resp.text();
    if (ct.includes('text/html') || md.trimStart().startsWith('<!') || md.trimStart().startsWith('<html')) {
        throw new Error('Doc file not found — rebuild the Docker image to include docs/');
    }

    _textCache.set(docPath, md);
    return md;
}

/** For the search index — returns plain markdown text. Failures bubble
 *  to the caller so the index build can skip individual docs without
 *  failing the whole index. */
export async function loadDocText(docPath) {
    return fetchDocText(docPath);
}

export function clearCache() {
    _htmlCache.clear();
    _textCache.clear();
}
