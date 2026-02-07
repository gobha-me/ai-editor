// ============================================
// QUICK OPEN (Ctrl+P FILE FINDER)
// ============================================

import { State } from './core.js';

let selectedIndex = 0;
let filteredFiles = [];
const overlay = () => document.getElementById('quickOpenOverlay');
const input = () => document.getElementById('quickOpenInput');
const results = () => document.getElementById('quickOpenResults');

/** Simple fuzzy match: returns score (higher=better) or -1 for no match */
function fuzzyScore(query, target) {
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    // Exact substring match (highest priority)
    if (t.includes(q)) {
        // Bonus for filename match vs path match
        const filename = t.split('/').pop();
        if (filename.includes(q)) return 1000 - filename.indexOf(q);
        return 500 - t.indexOf(q);
    }

    // Fuzzy: all chars must appear in order
    let qi = 0, score = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi]) {
            // Bonus for matching at word boundaries (after / . - _)
            if (ti === 0 || '/.-_'.includes(t[ti - 1])) score += 10;
            score += 1;
            qi++;
        }
    }
    return qi === q.length ? score : -1;
}

/** Highlight matched chars in display string */
function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let result = '', qi = 0;
    for (let i = 0; i < text.length; i++) {
        if (qi < q.length && t[i] === q[qi]) {
            result += `<span class="qo-match">${escapeHtml(text[i])}</span>`;
            qi++;
        } else {
            result += escapeHtml(text[i]);
        }
    }
    return result;
}

function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function getFileIcon(path) {
    const ext = path.split('.').pop().toLowerCase();
    const icons = {
        js: '📜', jsx: '⚛️', ts: '📘', tsx: '⚛️',
        html: '🌐', css: '🎨', scss: '🎨', less: '🎨',
        json: '📋', yaml: '📋', yml: '📋', toml: '📋',
        md: '📝', txt: '📄', py: '🐍', go: '🔵',
        rs: '🦀', c: '⚙️', cpp: '⚙️', h: '⚙️',
        sh: '🖥️', bash: '🖥️', dockerfile: '🐳',
        svg: '🖼️', png: '🖼️', jpg: '🖼️',
    };
    return icons[ext] || '📄';
}

function filter(query) {
    const files = (State.fileTree || []).filter(f => f.type === 'file');
    if (!query.trim()) {
        // Show recently opened files first, then all files
        const openPaths = new Set((State.openTabs || []).map(t => t.path));
        filteredFiles = [
            ...files.filter(f => openPaths.has(f.path)),
            ...files.filter(f => !openPaths.has(f.path))
        ].slice(0, 30);
        return;
    }

    filteredFiles = files
        .map(f => ({ ...f, score: fuzzyScore(query, f.path) }))
        .filter(f => f.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
}

function render(query) {
    const el = results();
    if (!el) return;

    if (filteredFiles.length === 0) {
        el.innerHTML = '<div class="quick-open-empty">No matching files</div>';
        return;
    }

    el.innerHTML = filteredFiles.map((f, i) => {
        const parts = f.path.split('/');
        const name = parts.pop();
        const dir = parts.join('/');
        return `<div class="quick-open-item${i === selectedIndex ? ' selected' : ''}"
                    data-path="${escapeHtml(f.path)}" data-index="${i}">
                <span class="qo-icon">${getFileIcon(f.path)}</span>
                <span class="qo-name">${highlightMatch(name, query)}</span>
                ${dir ? `<span class="qo-path">${highlightMatch(dir, query)}</span>` : ''}
            </div>`;
    }).join('');

    // Scroll selected into view
    const sel = el.querySelector('.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function openSelected(pin) {
    if (filteredFiles.length === 0) return;
    const file = filteredFiles[selectedIndex];
    if (!file) return;
    close();
    // Use existing tree click handler: pin=double-click, preview=single-click
    window.onTreeItemClick(file.path, 'file', !!pin);
}

export function open() {
    selectedIndex = 0;
    const el = overlay();
    const inp = input();
    if (!el || !inp) return;
    inp.value = '';
    el.classList.add('active');
    filter('');
    render('');
    inp.focus();
}

export function close() {
    overlay()?.classList.remove('active');
}

// Event delegation — set up once on DOMContentLoaded
export function initQuickOpen() {
    const inp = input();
    const res = results();
    if (!inp || !res) return;

    inp.addEventListener('input', () => {
        const q = inp.value;
        selectedIndex = 0;
        filter(q);
        render(q);
    });

    inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, filteredFiles.length - 1);
            render(inp.value);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            render(inp.value);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            openSelected(e.shiftKey);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });

    res.addEventListener('click', (e) => {
        const item = e.target.closest('.quick-open-item');
        if (item) {
            selectedIndex = parseInt(item.dataset.index, 10);
            openSelected(e.shiftKey);
        }
    });

    overlay().addEventListener('click', (e) => {
        if (e.target === overlay()) close();
    });
}

export const QuickOpen = { open, close };
