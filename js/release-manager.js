/**
 * Release Manager - AI-powered release notes generator
 *
 * Compares two refs (tags/branches), feeds the commit log to the LLM,
 * and produces formatted release notes. Can also create a git release.
 *
 * @module release-manager
 * @since 0.9.31
 */

import { State, EventBus } from './core.js';
import { Git } from './git.js';
import { LLM, resolveMaxTokens } from './llm.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// ============================================
// STATE
// ============================================

let _tags = [];
let _releases = [];
let _loading = false;

// ============================================
// MODAL LIFECYCLE
// ============================================

/**
 * Open the release manager modal.
 * Loads tags and populates the ref selectors.
 */
export async function openReleaseModal() {
    const modal = document.getElementById('releaseModal');
    if (!modal || !State.currentProject) return;

    modal.classList.add('active');
    _resetModal();

    const { owner, repo } = State.currentProject;

    try {
        _setStatus('Loading tags…');
        [_tags, _releases] = await Promise.all([
            Git.listTags(owner, repo).catch(() => []),
            Git.listReleases(owner, repo).catch(() => [])
        ]);

        _populateRefSelectors();
        _setStatus('');
    } catch (e) {
        console.error('[Release] Failed to load data:', e);
        _setStatus(`Error: ${escapeHtml(e.message)}`, true);
    }
}

export function closeReleaseModal() {
    const modal = document.getElementById('releaseModal');
    if (modal) modal.classList.remove('active');
    _tags = [];
    _releases = [];
}

/**
 * Bind a delegated click handler for the release-manager modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * UI event-dispatch contract (DESIGN-ui-event-dispatch.md).
 */
let _wired = false;
export function mountReleaseModal({ onClose, onGenerate, onCreate } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#releaseModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeReleaseModal' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'generateReleaseNotes' && typeof onGenerate === 'function') {
            onGenerate();
        } else if (action === 'createRelease' && typeof onCreate === 'function') {
            onCreate();
        }
    });
}

// ============================================
// REF SELECTORS
// ============================================

function _populateRefSelectors() {
    const fromSelect = document.getElementById('releaseFrom');
    const toSelect = document.getElementById('releaseTo');
    if (!fromSelect || !toSelect) return;

    // Build option groups: tags first, then branches
    const tagOptions = _tags.map(t =>
        `<option value="${escapeAttr(t.name)}">${escapeHtml(t.name)}</option>`
    ).join('');

    const branchOptions = (State.branches || []).map(b =>
        `<option value="${escapeAttr(b.name)}">${escapeHtml(b.name)}</option>`
    ).join('');

    const optionsHtml =
        (_tags.length ? `<optgroup label="Tags">${tagOptions}</optgroup>` : '') +
        `<optgroup label="Branches">${branchOptions}</optgroup>`;

    fromSelect.innerHTML = optionsHtml;
    toSelect.innerHTML = optionsHtml;

    // Smart defaults: "from" = most recent tag, "to" = current branch
    if (_tags.length > 0) {
        fromSelect.value = _tags[0].name;
    }
    toSelect.value = State.currentBranch || 'main';

    // Pre-fill tag name suggestion
    _suggestTagName();
}

/**
 * Suggest a tag name based on the latest existing tag.
 * Tries to auto-increment semver-like tags.
 */
function _suggestTagName() {
    const input = document.getElementById('releaseTag');
    if (!input) return;

    if (_tags.length === 0) {
        input.value = 'v0.1.0';
        return;
    }

    const latest = _tags[0].name;
    // Try to increment semver patch: v1.2.3 → v1.2.4
    const semverMatch = latest.match(/^(v?)(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (semverMatch) {
        const [, prefix, major, minor, patch, suffix] = semverMatch;
        input.value = `${prefix}${major}.${minor}.${parseInt(patch) + 1}${suffix}`;
    } else {
        input.value = latest;
    }
}

// ============================================
// COMPARE & GENERATE
// ============================================

/**
 * Compare the selected refs and generate release notes via LLM.
 */
export async function generateReleaseNotes() {
    if (_loading) return;
    _loading = true;

    const fromRef = document.getElementById('releaseFrom')?.value;
    const toRef = document.getElementById('releaseTo')?.value;
    const notesArea = document.getElementById('releaseNotes');
    const genBtn = document.getElementById('btnGenerateRelease');

    if (!fromRef || !toRef) {
        window.showToast('Select both "From" and "To" refs', 'warning');
        _loading = false;
        return;
    }

    if (fromRef === toRef) {
        window.showToast('"From" and "To" must be different', 'warning');
        _loading = false;
        return;
    }

    if (genBtn) {
        genBtn.disabled = true;
        genBtn.textContent = '⏳ Comparing…';
    }

    const { owner, repo } = State.currentProject;

    try {
        // Step 1: Get commits between refs
        _setStatus('Comparing refs…');
        console.log(`[Release] Comparing: ${fromRef} → ${toRef}`);
        const comparison = await Git.compareRefs(owner, repo, fromRef, toRef);
        console.log(`[Release] Compare result: ${comparison.commits?.length ?? 'null'} commits, ${comparison.files?.length ?? 'null'} files, totalCommits=${comparison.totalCommits}`);

        if ((!comparison.commits || comparison.commits.length === 0) &&
            (!comparison.files || comparison.files.length === 0)) {
            console.log('[Release] No changes detected. Raw comparison:', JSON.stringify(comparison).slice(0, 500));
            notesArea.value = `No changes found between ${fromRef} and ${toRef}.\n\nThis can happen if the tag points to the same commit as the branch HEAD.\nCheck the console log for debug info.`;
            _setStatus('No changes found — check console for details.', true);
            return;
        }

        const numCommits = comparison.commits?.length || 0;
        let files = comparison.files || [];

        // Fallback: if compare returned commits but no files, fetch diffs
        // from individual commits (common with older Gitea versions)
        if (files.length === 0 && numCommits > 0) {
            _setStatus(`Found ${numCommits} commit(s), fetching file diffs…`);
            const fileMap = new Map(); // filename → {status, additions, deletions, patch}

            // Fetch up to 10 commit diffs to stay reasonable
            const commitSlice = comparison.commits.slice(0, 10);
            for (const c of commitSlice) {
                try {
                    const diff = await Git.getCommitDiff(owner, repo, c.sha);
                    for (const f of (diff.files || [])) {
                        const existing = fileMap.get(f.path);
                        if (existing) {
                            existing.additions += f.additions || 0;
                            existing.deletions += f.deletions || 0;
                            // Keep the latest patch (most recent change)
                            if (f.patch) existing.patch = f.patch;
                        } else {
                            fileMap.set(f.path, {
                                filename: f.path,
                                status: f.status || 'modified',
                                additions: f.additions || 0,
                                deletions: f.deletions || 0,
                                patch: f.patch || ''
                            });
                        }
                    }
                } catch (e) {
                    console.warn(`[Release] Could not fetch diff for ${c.sha.slice(0, 7)}:`, e.message);
                }
            }

            files = Array.from(fileMap.values());
            console.log(`[Release] Fallback: assembled ${files.length} file(s) from ${commitSlice.length} commit diff(s)`);
        }

        const numFiles = files.length;
        _setStatus(`Found ${numCommits} commit(s), ${numFiles} file(s). Generating notes…`);

        // ── Build rich context for the LLM ──

        // Commit log (short sha + first line)
        const commitLog = (comparison.commits || []).map(c => {
            const shortSha = c.sha.slice(0, 7);
            const firstLine = (c.message || '').split('\n')[0];
            return `${shortSha} ${firstLine} (${c.author})`;
        }).join('\n');

        // Filter and prioritize files for analysis
        const prioritized = _prioritizeFiles(files);

        // File summary (all files for overview)
        const fileSummary = prioritized.map(f => {
            const stats = `+${f.additions} -${f.deletions}`;
            return `[${f.status}] ${f.filename} (${stats})`;
        }).join('\n');

        // Build meaningful patch context — extract only +/- lines, skip noise
        const patchContext = _buildPatchContext(prioritized);

        // If no patches available at all, try to fetch key file contents
        // so the LLM can at least see what the current state looks like
        let fileContentContext = '';
        if (!patchContext && prioritized.length > 0) {
            _setStatus(`No diffs available, fetching key file contents…`);
            fileContentContext = await _fetchKeyFileContents(owner, repo, prioritized);
        }

        // Step 3: Generate release notes via LLM
        const commitModel = State.settings.commitModel || State.settings.llmModel;
        const repoName = `${owner}/${repo}`;

        if (genBtn) genBtn.textContent = '⏳ Generating…';

        // Build the user prompt
        const userPromptParts = [
            `Generate release notes for ${repoName}.`,
            `Comparing: ${fromRef} → ${toRef}`,
            `Total commits: ${comparison.totalCommits}`,
            '',
            `Commit log:\n${commitLog}`,
            '',
            `Files changed (${numFiles}):\n${fileSummary}`,
        ];

        if (patchContext) {
            userPromptParts.push('', `Code changes (key diffs):\n${patchContext}`);
        }
        if (fileContentContext) {
            userPromptParts.push('', `Key file contents (current state):\n${fileContentContext}`);
        }

        const userPrompt = userPromptParts.join('\n');
        console.log(`[Release] LLM context: ${userPrompt.length} chars, ${numCommits} commits, ${numFiles} files, patches=${!!patchContext}, fileContents=${!!fileContentContext}`);

        // Stream into the textarea so the user sees progress
        notesArea.value = '';
        let accumulated = '';

        const result = await LLM.chat([
            {
                role: 'system',
                content: _buildSystemPrompt()
            },
            {
                role: 'user',
                content: userPrompt
            }
        ], {
            model: commitModel,
            stream: true,
            temperature: 0.3,
            maxTokens: resolveMaxTokens(commitModel, 'notes'),
            onToken: (token, full) => {
                accumulated = full;
                notesArea.value = full;
                // Auto-scroll textarea to bottom as content streams in
                notesArea.scrollTop = notesArea.scrollHeight;
            }
        });

        // Final cleanup — prefer the stripped content over accumulated stream
        let notes = (result.content || accumulated).trim();
        // Strip markdown code fences some models wrap output in
        notes = notes.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

        notesArea.value = notes;
        _setStatus(`Generated from ${numCommits} commit(s), ${numFiles} file(s).`);

    } catch (e) {
        console.error('[Release] Generation failed:', e);
        _setStatus(`Error: ${escapeHtml(e.message)}`, true);
        notesArea.value = `Failed to generate: ${e.message}`;
    } finally {
        _loading = false;
        if (genBtn) {
            genBtn.disabled = false;
            genBtn.textContent = '✨ Generate Notes';
        }
    }
}

// ============================================
// CREATE RELEASE
// ============================================

/**
 * Create a release via the git provider API.
 */
export async function createRelease() {
    const tag = document.getElementById('releaseTag')?.value?.trim();
    const title = document.getElementById('releaseTitle')?.value?.trim();
    const body = document.getElementById('releaseNotes')?.value?.trim();
    const target = document.getElementById('releaseTo')?.value;
    const isDraft = document.getElementById('releaseDraft')?.checked || false;
    const isPrerelease = document.getElementById('releasePrerelease')?.checked || false;
    const createBtn = document.getElementById('btnCreateRelease');

    if (!tag) {
        window.showToast('Tag name is required', 'warning');
        return;
    }

    if (!body) {
        window.showToast('Release notes are empty — generate or write them first', 'warning');
        return;
    }

    if (createBtn) {
        createBtn.disabled = true;
        createBtn.textContent = '⏳ Creating…';
    }

    const { owner, repo } = State.currentProject;

    try {
        const result = await Git.createRelease(owner, repo, {
            tag,
            name: title || tag,
            body,
            draft: isDraft,
            prerelease: isPrerelease,
            target
        });

        window.showToast(`Release ${tag} created!`, 'success');
        _setStatus(`✅ Release created: ${escapeHtml(tag)}`);

        // Refresh tags in case the tag was new
        _tags = await Git.listTags(owner, repo).catch(() => _tags);

        if (result.url) {
            _setStatus(`✅ <a href="${escapeAttr(result.url)}" target="_blank" rel="noopener">View release → ${escapeHtml(tag)}</a>`);
        }

    } catch (e) {
        console.error('[Release] Create failed:', e);
        window.showToast(`Failed to create release: ${e.message}`, 'error');
        _setStatus(`Error: ${escapeHtml(e.message)}`, true);
    } finally {
        if (createBtn) {
            createBtn.disabled = false;
            createBtn.innerHTML = '<svg class="icn icn--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/></svg><span>Create Release</span>';
        }
    }
}

// ============================================
// CONTEXT BUILDING HELPERS
// ============================================

/** Noise patterns — files that rarely matter for release notes */
const NOISE_PATTERNS = [
    /^\.gitea\//,
    /^\.github\//,
    /^vendor\//,
    /^node_modules\//,
    /^package-lock\.json$/,
    /^yarn\.lock$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /\.DS_Store$/,
    /^\.eslintcache$/,
];

/** Priority tiers — higher tier = more relevant for release notes */
const FILE_PRIORITY = [
    { pattern: /\.js$/, tier: 4 },            // JS source
    { pattern: /\.html$/, tier: 3 },           // Templates / UI
    { pattern: /\.css$/, tier: 3 },            // Styles
    { pattern: /\.json$/, tier: 2 },           // Config
    { pattern: /\.ya?ml$/, tier: 2 },          // Config
    { pattern: /\.md$/, tier: 1 },             // Docs
    { pattern: /Dockerfile/, tier: 2 },        // Infra
];

/**
 * Filter noise files and sort by relevance.
 * Keeps all files but puts the most important ones first.
 */
function _prioritizeFiles(files) {
    return files
        .filter(f => !NOISE_PATTERNS.some(p => p.test(f.filename)))
        .sort((a, b) => {
            const tierA = FILE_PRIORITY.find(p => p.pattern.test(a.filename))?.tier || 0;
            const tierB = FILE_PRIORITY.find(p => p.pattern.test(b.filename))?.tier || 0;
            if (tierB !== tierA) return tierB - tierA; // Higher tier first
            // Within same tier, sort by change volume
            return (b.additions + b.deletions) - (a.additions + a.deletions);
        });
}

/**
 * Build compact patch context from file diffs.
 * Extracts only added/removed lines (not context lines) for maximum signal.
 * Budget: ~12K chars to leave room for the rest of the prompt.
 */
function _buildPatchContext(files) {
    let budget = 12000;
    const snippets = [];

    for (const f of files) {
        if (!f.patch || budget <= 0) continue;

        // Skip binary/minified — avg line length > 300 chars
        const lines = f.patch.split('\n');
        const avgLen = f.patch.length / (lines.length || 1);
        if (avgLen > 300) continue;

        // Extract only meaningful lines: +/- lines and @@ headers
        const meaningful = lines.filter(line =>
            line.startsWith('+') || line.startsWith('-') || line.startsWith('@@')
        );

        if (meaningful.length === 0) continue;

        // Skip files where 90%+ lines are added (full file replacement from zip upload)
        // These are noise — every line shows as "added" because the file was replaced
        const addedCount = meaningful.filter(l => l.startsWith('+')).length;
        const removedCount = meaningful.filter(l => l.startsWith('-')).length;
        if (addedCount > 50 && removedCount < addedCount * 0.1) {
            // Full replacement — just note it, don't include the patch
            snippets.push(`--- ${f.filename} [${f.status}] --- (full file, +${f.additions} -${f.deletions})`);
            budget -= 80;
            continue;
        }

        const excerpt = meaningful.join('\n');
        const truncated = excerpt.slice(0, Math.min(excerpt.length, budget));
        const wasTruncated = excerpt.length > budget;

        snippets.push(
            `--- ${f.filename} [${f.status}] ---\n` +
            truncated +
            (wasTruncated ? '\n... (truncated)' : '')
        );
        budget -= truncated.length + 50; // 50 for the header
    }

    return snippets.length > 0 ? snippets.join('\n\n') : '';
}

/**
 * When no patches are available at all, fetch the current content of
 * key changed files so the LLM can at least see what exists.
 * Fetches up to 5 high-priority files, ~2K chars each.
 */
async function _fetchKeyFileContents(owner, repo, files) {
    const topFiles = files.filter(f =>
        /\.(js|html|css|json|ya?ml|md)$/.test(f.filename)
    ).slice(0, 5);

    if (topFiles.length === 0) return '';

    const branch = State.currentBranch || 'main';
    const contents = [];
    let budget = 10000;

    for (const f of topFiles) {
        if (budget <= 0) break;
        try {
            const file = await Git.getFile(owner, repo, f.filename, branch);
            if (!file?.content) continue;

            const text = file.content;
            const truncated = text.slice(0, Math.min(text.length, 2000));
            contents.push(
                `--- ${f.filename} (current state, ${f.status}) ---\n` +
                truncated +
                (text.length > 2000 ? '\n... (truncated)' : '')
            );
            budget -= truncated.length;
        } catch {
            // Skip files we can't fetch
        }
    }

    return contents.join('\n\n');
}

/**
 * Build the system prompt for release notes generation.
 */
function _buildSystemPrompt() {
    return `You are a release notes writer for a software project. Generate clear, well-organized release notes in Markdown format.

CRITICAL RULES:
1. Commit messages are often USELESS (e.g., "Upload files from zip", "Update files", "changeset 0.9.32"). IGNORE generic commit messages entirely.
2. Determine what changed by analyzing: the FILE NAMES that changed, the DIFFS/patches (added and removed lines), and the file STRUCTURE (which modules were touched).
3. Group changes by category: Features, Bug Fixes, Improvements, Performance, UI/UX, Refactoring, Infrastructure, Breaking Changes. Only include categories that have entries.
4. Be specific — "Added request timeout to git providers" is good. "Updated files" is worthless.
5. One line per item. Be concise but descriptive.
6. If you see CSS changes, describe the visual/UX impact, not the property changes.
7. If you see JS module changes, describe the behavioral change, not the code structure.
8. Do NOT include a title heading — the user sets the release title separately.
9. Output ONLY the Markdown notes body, no wrapping code fences.
10. If file paths suggest the change scope (e.g., js/chat/ = chat panel, css/sidebar.css = sidebar styling), use that to infer what area was affected.

INFERENCE PATTERNS:
- New files = new features
- Deleted files = removed features
- Changes to multiple related files (e.g., HTML + CSS + JS for same component) = a coordinated feature/fix
- version.js change = version bump (mention it once at the end, don't make it a category)
- Changes to git-providers/ = git integration changes
- Changes to css/ = UI/styling changes
- Changes to html/ = layout/template changes`;
}

// ============================================
// INTERNAL HELPERS
// ============================================

function _resetModal() {
    const notes = document.getElementById('releaseNotes');
    const title = document.getElementById('releaseTitle');
    const tag = document.getElementById('releaseTag');
    const status = document.getElementById('releaseStatus');
    const draft = document.getElementById('releaseDraft');
    const prerelease = document.getElementById('releasePrerelease');

    if (notes) notes.value = '';
    if (title) title.value = '';
    if (tag) tag.value = '';
    if (status) { status.textContent = ''; status.className = 'release-status'; }
    if (draft) draft.checked = false;
    if (prerelease) prerelease.checked = false;
    _loading = false;
}

function _setStatus(msg, isError = false) {
    const el = document.getElementById('releaseStatus');
    if (!el) return;
    el.innerHTML = msg;
    el.className = 'release-status' + (isError ? ' release-status-error' : '');
}

// ============================================
// EXPOSE TO WINDOW (for onclick handlers)
// ============================================

window.openReleaseModal = openReleaseModal;
window.closeReleaseModal = closeReleaseModal;
window.generateReleaseNotes = generateReleaseNotes;
window.createRelease = createRelease;
