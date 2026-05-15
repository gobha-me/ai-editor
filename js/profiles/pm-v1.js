// @ts-check
/**
 * `pm.v1` — synthetic profile carrying the legacy `'pm'` role's
 * "Project Manager" tool surface.
 *
 * 2.54.0 (gitea#438) — explicit admission. `tools.admit` enumerates the
 * union of every `'all'`-tagged and every `'pm'`-tagged tool from the
 * pre-inversion `Roles.filterTools`, byte-equivalent to the legacy
 * behavior when `State.settings.role === 'pm'`. The narrowing relative
 * to chat.v1 is the absence of reviewer-only tools (which chat.v1
 * carries because picker chat covers PM + reviewer scope).
 *
 * **Synthetic** — registered in [`registry.js`](./registry.js) for lookup
 * (`Profiles.has`/`get` succeed) but excluded from `Profiles.list()`.
 * The picker UI shows only `chat.v1` + `coder.v1` + `kb.v1`; the 2.0.0
 * migration script (slice 3) targets `pm.v1` for users with
 * `settings.role === 'pm'` to preserve granularity.
 *
 * @module profiles/pm-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Project-manager overrides on top of `chat.v1`. Only `tools.admit` is
 * overridden; everything else inherits unchanged.
 *
 * @type {Profile}
 */
export const PM_V1 = {
    name: 'pm.v1',
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
            'create_issue',
            'create_pull_request',
            'delegate_task',
            'find_relevant_files',
            'find_tool',
            'get_ci_logs',
            'get_ci_status',
            'get_embeddings_status',
            'get_project_tree',
            'git_log',
            'goto_line',
            'list_issues',
            'list_open_tabs',
            'list_projects',
            'list_pull_requests',
            'list_tool_categories',
            'list_tools_by_category',
            'memory_recall',
            'memory_remember',
            'memory_revise',
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
            'read_current_file',
            'read_file',
            'read_issue',
            'read_lines',
            'read_pull_request',
            'scan_file',
            'scratchpad_clear',
            'scratchpad_read',
            'scratchpad_write',
            'search_in_files',
            'select_range',
            'set_active_project',
            'submit_plan_for_approval',
            'submit_script_for_approval',
            'sync_releases',
            'todo_read',
            'todo_write',
            'update_issue',
            'mcp__*',
        ],
    },

    task_ledger: {},
};
