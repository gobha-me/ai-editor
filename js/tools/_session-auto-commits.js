/**
 * AI Editor — Session auto-commit tracker (gitea#486, 2.80.0)
 *
 * `write_file` auto-commits brand-new files via Git.createFile() — one
 * commit per file, separate from any subsequent `commit_files` call.
 * Without an in-session record, the `commit_files` response only reports
 * the dirty-tab paths flushed by THIS call, so the model loses sight of
 * the new files (real session: 5+ wasted turns chasing phantom uncommitted
 * files; see HTML-Games issue #238).
 *
 * This module keeps a session-scoped Set of paths that have been
 * auto-committed since the last `commit_files` report. `commit_files`
 * drains the set into its response as `created: [...]`. The conversation
 * lifecycle (`js/chat/conversations.js`) clears the set on conversation
 * switch / new chat alongside `clearApprovedPlan()`.
 */

const _autoCommittedPaths = new Set();

/**
 * Record that `path` was auto-committed by `write_file` (new-file branch).
 * Idempotent — calling twice with the same path is a no-op.
 *
 * @param {string} path
 */
export function recordAutoCommit(path) {
    if (typeof path === 'string' && path.length > 0) {
        _autoCommittedPaths.add(path);
    }
}

/**
 * Return the list of paths auto-committed since the last report, and
 * clear the set. Used by `commit_files` to populate `response.created`.
 *
 * @returns {string[]}
 */
export function getAutoCommittedSinceLastReport() {
    const paths = Array.from(_autoCommittedPaths);
    _autoCommittedPaths.clear();
    return paths;
}

/**
 * Clear the set unconditionally. Called by `js/chat/conversations.js` on
 * conversation switch / new chat / conversation delete — same lifecycle
 * as `clearApprovedPlan()`.
 */
export function clearAutoCommitted() {
    _autoCommittedPaths.clear();
}
