/**
 * Project Conventions — github#37 Phase 1 (1.6.13)
 *
 * Loads a repo-root CLAUDE.md once when a project is loaded and stashes the
 * verbatim text in `State.projectConventions`. The system-prompt builder in
 * `js/prompts.js` reads it back as a `<PROJECT_CONVENTIONS>...</PROJECT_CONVENTIONS>`
 * block in the editor system prompt — committed by the project maintainer
 * and therefore trusted (NOT wrapped in `<UNTRUSTED_*>` markers).
 *
 * Phase 1 escape hatch (per github#37 issue body):
 *   - One file: repo-root `CLAUDE.md`.
 *   - One trigger: `git:projectLoaded` (fires from `loadProject()` after the
 *     repo + branches + file tree resolve; mirrors the precedent in
 *     `js/ignore.js` for `.aieditorignore`).
 *   - On 404 / unsupported provider / network error → silent: leave
 *     `State.projectConventions = null`. Empty-state UX is "no block".
 *   - No role filtering, no section markers, no length cap, no compression
 *     coupling, no memory-subsystem coupling.
 *
 * Deferred design questions (see issue body) intentionally NOT addressed
 * here — Phase 2 will scope them from a real dogfood session.
 */

import { State, EventBus } from '../core.js';

const CONVENTIONS_PATH = 'CLAUDE.md';

/**
 * Fetch the repo-root CLAUDE.md and stash in State.projectConventions.
 * Wired to the `git:projectLoaded` event by `initProjectConventions()`.
 *
 * @param {{ connectionId: string, owner: string, repo: string }} payload
 *   The `State.currentProject` snapshot emitted by `loadProject()`.
 */
async function loadConventions(payload = {}) {
    const { connectionId, owner, repo } = payload || {};
    if (!owner || !repo) {
        State.projectConventions = null;
        return;
    }

    // Dynamic import to avoid a static dependency cycle with git.js (which
    // pulls in provider modules that themselves import core.js). Mirrors the
    // pattern in js/ignore.js#_loadProjectIgnore.
    const { Git } = await import('../git.js');

    try {
        const ref = State.currentBranch || 'main';
        const file = await Git.getFile(owner, repo, CONVENTIONS_PATH, ref);
        const content = file?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            State.projectConventions = content;
            console.log(`[ProjectConventions] Loaded ${CONVENTIONS_PATH} (${content.length} chars) for ${owner}/${repo}`);
            EventBus.emit('project:conventionsLoaded', { connectionId, owner, repo, length: content.length });
        } else {
            State.projectConventions = null;
        }
    } catch (err) {
        // 404, network failure, provider doesn't implement getFile, etc. —
        // silent empty-state per the Phase 1 spec. Debug log only, no toast.
        State.projectConventions = null;
        console.log(`[ProjectConventions] No ${CONVENTIONS_PATH} at repo root for ${owner}/${repo} (${err?.message || err})`);
    }
}

/** Reset on `project:cleared`. */
function clearConventions() {
    State.projectConventions = null;
}

let _wired = false;

/**
 * Idempotent — safe to call multiple times. Subscribes to `git:projectLoaded`
 * and `project:cleared` so the conventions slot tracks the active project.
 */
function initProjectConventions() {
    if (_wired) return;
    _wired = true;
    EventBus.on('git:projectLoaded', loadConventions);
    EventBus.on('project:cleared', clearConventions);
}

export { initProjectConventions, loadConventions, clearConventions };
