/**
 * Help search index — substring + simple weighted ranking.
 *
 * Built lazily on first open. Indexes: the 4 static pages
 * (Getting started / Hotkeys / Command palette / Themes) plus the 6
 * markdown-backed pages (Plugin SDK / Tools / Roles / Memory /
 * Architecture / Changelog). Each doc is split into sections by `##`
 * headings; each section is searchable independently so a hit can
 * deep-link back to its source page.
 *
 * Ranking weights:
 *   title match   10
 *   heading match  5
 *   body match     1
 *
 * Snippet: ±70 chars around the first match, with the match wrapped
 * in `<mark>`. No fuzzy matching, no stemming, no fuse.js.
 */

import { loadDocText } from './markdown-loader.js';
import { DOC_PATHS } from './pages/markdown-pages.js';
import { HOTKEYS } from './hotkey-registry.js';
import { escapeHtml } from '../utils/html.js';

/** @typedef {{ heading: string, text: string }} Section */
/** @typedef {{ id: string, title: string, group: string, sections: Section[] }} IndexedDoc */

let _index = null;

const STATIC_DOCS = [
    { id: 'getting-started', title: 'Getting started', group: '' },
    { id: 'hotkeys',         title: 'Hotkeys',         group: '' },
    { id: 'command-palette', title: 'Command palette', group: '' },
    { id: 'themes',          title: 'Themes',          group: 'Building' },
];

const MARKDOWN_DOC_TITLES = {
    'plugin-sdk':   'Plugin SDK',
    'tools':        'Tools API',
    'roles':        'Roles',
    'memory':       'Memory',
    'architecture': 'Architecture',
    'security':     'Security',
    'changelog':    'Changelog',
};

const MARKDOWN_DOC_GROUPS = {
    'plugin-sdk':   'Building',
    'tools':        'Building',
    'roles':        'Concepts',
    'memory':       'Concepts',
    'architecture': 'Concepts',
    'security':     'Concepts',
    'changelog':    'Reference',
};

/** Strip HTML tags + collapse whitespace for indexing static pages. */
function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent.replace(/\s+/g, ' ').trim();
}

/** Split markdown into sections by `##` headings; the first chunk
 *  before the first `##` becomes a synthetic "Overview" section. */
function splitMarkdown(md) {
    const lines = md.split('\n');
    const sections = [];
    let current = { heading: 'Overview', text: '' };
    for (const line of lines) {
        const m = /^##\s+(.+)$/.exec(line);
        if (m) {
            if (current.text.trim()) sections.push(current);
            current = { heading: m[1].trim(), text: '' };
        } else {
            current.text += line + '\n';
        }
    }
    if (current.text.trim()) sections.push(current);

    // Strip markdown markup from text to keep snippets readable.
    return sections.map(s => ({
        heading: s.heading,
        text: s.text
            .replace(/```[\s\S]*?```/g, '')        // fenced code blocks
            .replace(/`([^`]+)`/g, '$1')           // inline code
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
            .replace(/[*_>#-]/g, ' ')              // markdown chrome
            .replace(/\s+/g, ' ')
            .trim(),
    }));
}

/** Index the static pages by rendering them and stripping HTML. */
async function indexStaticPages() {
    const out = [];
    for (const doc of STATIC_DOCS) {
        const sections = await indexStaticDoc(doc.id);
        out.push({ ...doc, sections });
    }
    return out;
}

async function indexStaticDoc(id) {
    if (id === 'hotkeys') {
        // The hotkeys page is data-driven; index from the registry directly
        // (avoids importing the page renderer which creates a render cycle).
        const groups = new Map();
        for (const hk of HOTKEYS) {
            if (!groups.has(hk.group)) groups.set(hk.group, []);
            groups.get(hk.group).push(`${hk.combo.join('+')}  ${hk.desc}`);
        }
        return Array.from(groups.entries()).map(([heading, lines]) => ({
            heading,
            text: lines.join(' · '),
        }));
    }

    const { renderGettingStarted } = await import('./pages/getting-started.js');
    const { renderCommandPalette } = await import('./pages/command-palette.js');
    const { renderThemes } = await import('./pages/themes.js');

    const html =
        id === 'getting-started' ? renderGettingStarted() :
        id === 'command-palette' ? renderCommandPalette() :
        id === 'themes'          ? renderThemes() : '';

    if (!html) return [{ heading: 'Overview', text: '' }];

    // Parse the static HTML into <h2>-bounded sections.
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const sections = [];
    let heading = 'Overview';
    let buf = '';
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'H2') {
                if (buf.trim()) sections.push({ heading, text: buf.replace(/\s+/g, ' ').trim() });
                heading = child.textContent.trim();
                buf = '';
            } else {
                buf += ' ' + (child.textContent || '');
            }
        }
    };
    walk(tmp);
    if (buf.trim()) sections.push({ heading, text: buf.replace(/\s+/g, ' ').trim() });
    return sections;
}

async function indexMarkdownDoc(id) {
    const path = DOC_PATHS[id];
    if (!path) return null;
    try {
        const md = await loadDocText(path);
        return {
            id,
            title: MARKDOWN_DOC_TITLES[id] || id,
            group: MARKDOWN_DOC_GROUPS[id] || '',
            sections: splitMarkdown(md),
        };
    } catch (err) {
        console.warn(`[help-search] Skipping ${id}: ${err.message}`);
        return null;
    }
}

export async function buildSearchIndex() {
    if (_index) return _index;
    const staticDocs = await indexStaticPages();
    const mdDocs = (await Promise.all(Object.keys(DOC_PATHS).map(indexMarkdownDoc)))
        .filter(Boolean);
    _index = { docs: [...staticDocs, ...mdDocs] };
    return _index;
}

/** Reset for tests. */
export function _resetIndex() {
    _index = null;
}

/** Set the index directly — test seam to skip the build step. */
export function _setIndex(index) {
    _index = index;
}

/** Build a snippet ±70 chars around the first match, with the match
 *  wrapped in <mark>. Both the surrounding text and the match are
 *  HTML-escaped — only the <mark> tags are unescaped. */
function buildSnippet(text, query) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text.slice(0, 140)) + (text.length > 140 ? '…' : '');
    const start = Math.max(0, idx - 70);
    const end = Math.min(text.length, idx + query.length + 70);
    const before = (start > 0 ? '…' : '') + escapeHtml(text.slice(start, idx));
    const matched = escapeHtml(text.slice(idx, idx + query.length));
    const after = escapeHtml(text.slice(idx + query.length, end)) + (end < text.length ? '…' : '');
    return `${before}<mark>${matched}</mark>${after}`;
}

/**
 * Search the index. Returns ranked results.
 * @param {string} query
 * @returns {Array<{ docId: string, docTitle: string, section: string, snippet: string, score: number }>}
 */
export function search(query) {
    if (!_index) return [];
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const qLower = q.toLowerCase();

    /** @type {Array<{ docId: string, docTitle: string, section: string, snippet: string, score: number }>} */
    const out = [];

    for (const doc of _index.docs) {
        // Title match wins big — surfaces the doc itself as a result.
        if (doc.title.toLowerCase().includes(qLower)) {
            out.push({
                docId: doc.id,
                docTitle: doc.title,
                section: doc.title,
                snippet: buildSnippet(doc.title, q),
                score: 10,
            });
        }
        for (const sec of doc.sections) {
            const headHit = sec.heading.toLowerCase().includes(qLower);
            const bodyHit = sec.text.toLowerCase().includes(qLower);
            if (headHit) {
                out.push({
                    docId: doc.id,
                    docTitle: doc.title,
                    section: sec.heading,
                    snippet: buildSnippet(sec.text || sec.heading, q),
                    score: 5,
                });
            } else if (bodyHit) {
                out.push({
                    docId: doc.id,
                    docTitle: doc.title,
                    section: sec.heading,
                    snippet: buildSnippet(sec.text, q),
                    score: 1,
                });
            }
        }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 30);
}
