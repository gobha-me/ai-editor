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
import { LLM } from './llm.js';
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
        _setStatus(`Error: ${e.message}`, true);
    }
}

export function closeReleaseModal() {
    const modal = document.getElementById('releaseModal');
    if (modal) modal.classList.remove('active');
    _tags = [];
    _releases = [];
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

        // Step 2: Build rich context for the LLM
        // -- Commit log (short sha + first line)
        const commitLog = (comparison.commits || []).map(c => {
            const shortSha = c.sha.slice(0, 7);
            const firstLine = (c.message || '').split('\n')[0];
            return `${shortSha} ${firstLine} (${c.author})`;
        }).join('\n');

        // -- File summary: filename, status, +/- counts
        const fileSummary = files.map(f => {
            const stats = `+${f.additions} -${f.deletions}`;
            return `[${f.status}] ${f.filename} (${stats})`;
        }).join('\n');

        // -- Truncated patches for meaningful context
        //    Cap total patch size to ~8K chars to avoid blowing the context window
        let patchBudget = 8000;
        const patchSnippets = [];
        for (const f of files) {
            if (!f.patch || patchBudget <= 0) continue;
            // Skip binary/minified — patches with very long lines
            const avgLineLen = f.patch.length / (f.patch.split('\n').length || 1);
            if (avgLineLen > 300) continue;

            const truncated = f.patch.slice(0, Math.min(f.patch.length, patchBudget));
            const wasTruncated = f.patch.length > patchBudget;
            patchSnippets.push(
                `--- ${f.filename} [${f.status}] ---\n` +
                truncated +
                (wasTruncated ? '\n... (truncated)' : '')
            );
            patchBudget -= truncated.length;
        }
        const patchContext = patchSnippets.length > 0
            ? `\n\nCode changes (unified diff excerpts):\n${patchSnippets.join('\n\n')}`
            : '';

        // Step 3: Generate release notes via LLM
        const commitModel = State.settings.commitModel || State.settings.llmModel;
        const repoName = `${owner}/${repo}`;

        if (genBtn) genBtn.textContent = '⏳ Generating…';

        // Stream into the textarea so the user sees progress
        // and we avoid server-side non-streaming timeouts
        notesArea.value = '';
        let accumulated = '';

        const result = await LLM.chat([
            {
                role: 'system',
                content: `You are a release notes writer. Generate clear, well-organized release notes in Markdown format. Group changes by category (Features, Bug Fixes, Improvements, Refactoring, Breaking Changes, etc). Only include categories that have entries. Be concise — one line per item. Use the actual code changes (diffs) to understand what was done, not just the commit messages (which may be generic like "Upload files from zip"). Focus on what changed functionally. Do NOT include a title heading — the user will set the release title separately. Output ONLY the Markdown notes body, no wrapping code fences.`
            },
            {
                role: 'user',
                content: `Generate release notes for ${repoName}.\n\nComparing: ${fromRef} → ${toRef}\nTotal commits: ${comparison.totalCommits}\n\nCommit log:\n${commitLog}\n\nFiles changed (${numFiles}):\n${fileSummary}${patchContext}`
            }
        ], {
            model: commitModel,
            stream: true,
            temperature: 0.3,
            maxTokens: 2048,
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
        _setStatus(`Error: ${e.message}`, true);
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
        _setStatus(`✅ Release created: ${tag}`);

        // Refresh tags in case the tag was new
        _tags = await Git.listTags(owner, repo).catch(() => _tags);

        if (result.url) {
            _setStatus(`✅ <a href="${result.url}" target="_blank" rel="noopener">View release → ${escapeHtml(tag)}</a>`);
        }

    } catch (e) {
        console.error('[Release] Create failed:', e);
        window.showToast(`Failed to create release: ${e.message}`, 'error');
        _setStatus(`Error: ${e.message}`, true);
    } finally {
        if (createBtn) {
            createBtn.disabled = false;
            createBtn.textContent = '🚀 Create Release';
        }
    }
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
