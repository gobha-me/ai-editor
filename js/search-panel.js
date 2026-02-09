/**
 * Search Panel UI Controller
 * Bridges SearchManager (web worker) ↔ search-panel.html DOM.
 * 
 * Usage:
 *   import { initSearchPanel, openSearchPanel, closeSearchPanel } from './search-panel.js';
 *   initSearchPanel();          // After DOM ready
 *   openSearchPanel();          // Ctrl+Shift+F
 */

import { State, EventBus } from './core.js';
import { SearchManager } from './managers/search-manager.js';

// ============================================
// DOM REFS (lazy — resolved after init)
// ============================================

const el = {
    panel:      () => document.getElementById('searchPanel'),
    input:      () => document.getElementById('searchInput'),
    results:    () => document.getElementById('searchResults'),
    status:     () => document.getElementById('searchStatus'),
    statusText: () => document.getElementById('searchStatusText'),
    replaceBar: () => document.getElementById('replaceBar'),
    replaceInput: () => document.getElementById('replaceInput'),
    caseSensitive: () => document.getElementById('searchCaseSensitive'),
    regex:      () => document.getElementById('searchRegex'),
    wholeWord:  () => document.getElementById('searchWholeWord'),
};

let _lastResults = null;

// ============================================
// OPEN / CLOSE
// ============================================

export function openSearchPanel() {
    const panel = el.panel();
    if (!panel) return;
    panel.classList.add('active');
    el.input()?.focus();
    el.input()?.select();
}

export function closeSearchPanel() {
    const panel = el.panel();
    if (!panel) return;
    panel.classList.remove('active');
    _lastResults = null;
}

export function toggleSearchPanel() {
    const panel = el.panel();
    if (!panel) return;
    panel.classList.contains('active') ? closeSearchPanel() : openSearchPanel();
}

// ============================================
// SEARCH EXECUTION
// ============================================

async function doSearch() {
    const query = el.input()?.value?.trim();
    if (!query) return;

    const options = {
        caseSensitive: el.caseSensitive()?.checked || false,
        regex: el.regex()?.checked || false,
        wholeWord: el.wholeWord()?.checked || false,
    };

    // Show searching status
    _showStatus('Searching...');

    // Gather file contents from the loaded file tree
    const files = await _gatherFileContents();
    if (files.length === 0) {
        _showStatus('No project files loaded. Open a project first.');
        return;
    }

    SearchManager.search(files, query, options);
}

/**
 * Gather file contents for search.
 * Uses State.fileTree paths and fetches content via the git provider.
 */
async function _gatherFileContents() {
    const tree = State.fileTree || [];
    const files = tree.filter(f => f.type === 'file');

    if (!State.currentProject) return [];

    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';

    // Check if we have a cached file content map
    // For performance, we fetch files in parallel (batched)
    const results = [];
    const batchSize = 20;

    // First check open tabs — they already have content
    const tabContent = new Map();
    for (const tab of (State.openTabs || [])) {
        if (tab.content) tabContent.set(tab.path, tab.content);
    }

    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const fetches = batch.map(async (f) => {
            // Use tab content if available (includes unsaved edits)
            if (tabContent.has(f.path)) {
                return { path: f.path, content: tabContent.get(f.path) };
            }
            try {
                const { GitProviderRegistry } = await import('./git-providers/index.js');
                const connId = State.settings.connections?.find(c => c.enabled)?.id;
                if (!connId) return null;
                const { provider, connection } = GitProviderRegistry.resolve(connId);
                const file = await provider.getFile(connection, owner, repo, f.path, branch);
                return { path: f.path, content: file?.content || '' };
            } catch {
                return null;
            }
        });

        const batch_results = await Promise.all(fetches);
        results.push(...batch_results.filter(Boolean));

        // Update progress
        _showStatus(`Loading files... ${Math.min(i + batchSize, files.length)}/${files.length}`);
    }

    return results;
}

// ============================================
// RESULTS RENDERING
// ============================================

function _renderResults(results) {
    _lastResults = results;
    const container = el.results();
    if (!container) return;

    if (results.totalMatches === 0) {
        container.innerHTML = `
            <div class="search-empty">
                <div class="search-empty-icon">🔍</div>
                <div class="search-empty-text">No matches found</div>
            </div>`;
        _showStatus(`0 results in ${results.totalFiles} files`);
        return;
    }

    const filePaths = Object.keys(results.files).sort();
    _showStatus(`${results.totalMatches} match${results.totalMatches !== 1 ? 'es' : ''} in ${filePaths.length} file${filePaths.length !== 1 ? 's' : ''}`);

    container.innerHTML = filePaths.map(path => {
        const file = results.files[path];
        const matchItems = file.matches.slice(0, 100).map(m => {
            const lineContent = _escapeHtml(m.lineContent || '');
            const highlighted = _highlightMatch(lineContent, m.match, m.column);
            return `
                <div class="search-result-match" data-path="${_escapeHtml(path)}" data-line="${m.lineNum}">
                    <span class="match-line-number">${m.lineNum}</span>
                    <span class="match-content">${highlighted}</span>
                </div>`;
        }).join('');

        return `
            <div class="search-result-file expanded">
                <div class="search-result-file-header" data-path="${_escapeHtml(path)}">
                    <span class="file-path">${_escapeHtml(path)}</span>
                    <span class="file-stats">${file.matchCount} match${file.matchCount !== 1 ? 'es' : ''}</span>
                </div>
                <div class="search-result-matches">
                    ${matchItems}
                    ${file.matchCount > 100 ? `<div class="search-result-match" style="color:var(--text-muted);padding-left:52px;">... and ${file.matchCount - 100} more</div>` : ''}
                </div>
            </div>`;
    }).join('');
}

function _highlightMatch(lineHtml, matchText, column) {
    // Simple highlight — find the match position and wrap it
    const escaped = _escapeHtml(matchText);
    const idx = lineHtml.toLowerCase().indexOf(escaped.toLowerCase());
    if (idx === -1) return lineHtml;
    return lineHtml.slice(0, idx) +
        `<span class="match-highlight">${lineHtml.slice(idx, idx + escaped.length)}</span>` +
        lineHtml.slice(idx + escaped.length);
}

// ============================================
// REPLACE ALL
// ============================================

async function doReplaceAll() {
    if (!_lastResults || _lastResults.totalMatches === 0) return;

    const query = el.input()?.value?.trim();
    const replacement = el.replaceInput()?.value ?? '';
    if (!query) return;

    const options = {
        caseSensitive: el.caseSensitive()?.checked || false,
        regex: el.regex()?.checked || false,
        wholeWord: el.wholeWord()?.checked || false,
    };

    const filePaths = Object.keys(_lastResults.files);
    const confirmed = confirm(`Replace all ${_lastResults.totalMatches} matches across ${filePaths.length} files?`);
    if (!confirmed) return;

    _showStatus('Replacing...');

    let totalReplaced = 0;

    for (const path of filePaths) {
        // Find the tab or fetch the content
        const tab = State.openTabs.find(t => t.path === path);
        let content = tab?.content;

        if (!content) {
            // Need to fetch file content
            try {
                const { GitProviderRegistry } = await import('./git-providers/index.js');
                const connId = State.settings.connections?.find(c => c.enabled)?.id;
                if (!connId) continue;
                const { provider, connection } = GitProviderRegistry.resolve(connId);
                const { owner, repo } = State.currentProject;
                const file = await provider.getFile(connection, owner, repo, path, State.currentBranch);
                content = file?.content;
            } catch { continue; }
        }

        if (!content) continue;

        // Build regex
        let pat = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (options.wholeWord) pat = `\\b${pat}\\b`;
        const flags = options.caseSensitive ? 'gm' : 'gim';

        try {
            const regex = new RegExp(pat, flags);
            let count = 0;
            const newContent = content.replace(regex, () => { count++; return replacement; });

            if (count > 0) {
                totalReplaced += count;
                // If tab is open, update it
                if (tab) {
                    tab.content = newContent;
                    tab.dirty = true;
                    EventBus.emit('tab:contentChanged', { path, content: newContent });
                }
            }
        } catch { /* skip */ }
    }

    _showStatus(`Replaced ${totalReplaced} occurrences across ${filePaths.length} files`);

    // Re-run search to update results
    if (totalReplaced > 0) {
        setTimeout(() => doSearch(), 500);
    }
}

// ============================================
// HELPERS
// ============================================

function _showStatus(text) {
    const statusEl = el.status();
    const textEl = el.statusText();
    if (statusEl) statusEl.style.display = 'flex';
    if (textEl) textEl.textContent = text;
}

function _escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================
// INIT
// ============================================

export function initSearchPanel() {
    // Initialize the search manager (web worker)
    SearchManager.init();

    // Search button
    document.getElementById('btnDoSearch')?.addEventListener('click', doSearch);

    // Close button
    document.getElementById('btnCloseSearch')?.addEventListener('click', closeSearchPanel);

    // Toggle replace
    document.getElementById('btnToggleReplace')?.addEventListener('click', () => {
        const bar = el.replaceBar();
        if (bar) {
            const visible = bar.style.display !== 'none';
            bar.style.display = visible ? 'none' : 'flex';
            if (!visible) el.replaceInput()?.focus();
        }
    });

    // Replace all button
    document.getElementById('btnReplaceAll')?.addEventListener('click', doReplaceAll);

    // Enter to search
    el.input()?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeSearchPanel();
        }
    });

    // Enter in replace input
    el.replaceInput()?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeSearchPanel();
        }
    });

    // Click on result → open file at line
    el.results()?.addEventListener('click', (e) => {
        // Toggle file group expand/collapse
        const header = e.target.closest('.search-result-file-header');
        if (header) {
            const fileGroup = header.closest('.search-result-file');
            fileGroup?.classList.toggle('expanded');
            return;
        }

        // Click on match → open file at line
        const match = e.target.closest('.search-result-match');
        if (match) {
            const path = match.dataset.path;
            const line = parseInt(match.dataset.line, 10);
            if (path) {
                // Open file via tree click (will open in tab)
                window.onTreeItemClick?.(path, 'file', false);
                // After file loads, scroll to line
                if (line) {
                    setTimeout(() => {
                        EventBus.emit('editor:scrollToLine', { line });
                    }, 300);
                }
            }
        }
    });

    // Listen for search results from SearchManager
    EventBus.on('search:complete', _renderResults);

    EventBus.on('search:error', (data) => {
        _showStatus(`Error: ${data.error}`);
    });

    EventBus.on('search:progress', (data) => {
        _showStatus(`Searching... ${data.current}/${data.total} files`);
    });

    console.log('[SearchPanel] Initialized');
}
