// @ts-check
/**
 * `reviewer.v1` — synthetic profile carrying the legacy `'reviewer'`
 * role's "Reviewer" tool surface (read-only code access + issue
 * commenting; no editing or issue creation).
 *
 * 2.54.0 (gitea#438) — explicit admission. `tools.admit` enumerates the
 * union of every `'all'`-tagged and every `'reviewer'`-tagged tool from
 * the pre-inversion `Roles.filterTools`, byte-equivalent to the legacy
 * behavior when `State.settings.role === 'reviewer'`.
 *
 * **Synthetic** — same posture as `pm.v1` and `full.v1`: registered for
 * lookup, excluded from `Profiles.list()`, targeted by the 2.0.0
 * migration script (slice 3) for users with `settings.role === 'reviewer'`.
 *
 * @module profiles/reviewer-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Reviewer overrides on top of `chat.v1`. Only `tools.admit` is
 * overridden; everything else inherits unchanged.
 *
 * @type {Profile}
 */
export const REVIEWER_V1 = {
    name: 'reviewer.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},
    retrieval: {},
    memory: {},
    compression: {},

    tools: {
        admit: [
            'add_issue_comment',
            'add_pr_review',
            'ask_user',
            'delegate_task',
            'find_references',
            'find_relevant_files',
            'find_tool',
            'get_ci_logs',
            'get_ci_status',
            'get_embeddings_status',
            'get_project_tree',
            'git_log',
            'goto_line',
            'list_conversations',
            'list_issues',
            'list_open_tabs',
            'list_projects',
            'list_pull_requests',
            'list_tool_categories',
            'list_tools_by_category',
            'memory_recall',
            'merge_pull_request',
            'open_file',
            'peek_project_file',
            'peek_project_tree',
            'peek_read_lines',
            'preview_click',
            'preview_console_logs',
            'preview_errors',
            'preview_fill',
            'preview_inspect',
            'preview_list',
            'preview_logs',
            'preview_network',
            'preview_resize',
            'preview_snapshot',
            'preview_start',
            'preview_stop',
            'read_approved_plan',
            'read_chat_history',
            'read_current_file',
            'read_file',
            'read_function',
            'read_issue',
            'read_lines',
            'read_pull_request',
            'scan_file',
            'scratchpad_clear',
            'scratchpad_read',
            'scratchpad_write',
            'search_chat_history',
            'search_in_files',
            'select_range',
            'set_active_project',
            'submit_plan_for_approval',
            'submit_script_for_approval',
            'sync_releases',
            'todo_read',
            'todo_write',
            'mcp__*',
        ],
    },

    task_ledger: {},
};
