// @ts-check
/**
 * Side-effect classifications by tool name.
 *
 * **2.76.0 (gitea#480)** — lifted out of `catalog.js` so the tool-registry
 * dispatch gate can consult it without forming an import cycle
 * (`catalog.js` depends on `js/tools/registry.js` for `getDefinitions`;
 * registry now needs the side-effect lookup at dispatch time for plan-mode
 * enforcement). Source of truth for `SideEffectClass` per tool — both
 * `catalog.js` (for the model-visible category surface) and
 * `js/tools/registry.js` (for `checkPlanModeAccess`) read from here.
 *
 * @module intelligence/tools/side-effects
 */

/** @typedef {import('./contracts.js').SideEffectClass} SideEffectClass */

/**
 * Side-effect classification by tool name. New tools must add an entry
 * here; the parity lint at `tests/test-plan-mode-source-scan.mjs` fails
 * CI when a `registry.register('X', ...)` literal has no matching entry.
 *
 * Fail-closed semantics: lookup defaults to `'external'` for unknown
 * names (see `getSideEffectByName`). The plan-mode dispatch gate then
 * rejects them. MCP-bridged tools land without classification and are
 * therefore blocked in plan mode, which is the conservative correct
 * outcome — the registry can't introspect MCP semantics.
 *
 * Why `'external'` and not `'read'` as the default: when we can't
 * classify, "needs caution" beats "looks safe."
 *
 * @type {Object.<string, SideEffectClass>}
 */
export const SIDE_EFFECTS_BY_NAME = {
    'read_file': 'read',
    'read_lines': 'read',
    'read_current_file': 'read',
    'read_function': 'read',
    'open_file': 'read',
    'list_open_tabs': 'read',
    'scan_file': 'read',
    'find_references': 'read',
    'search_in_files': 'read',
    'list_dirty_files': 'read',
    'list_projects': 'read',
    'get_project_tree': 'read',
    'peek_project_tree': 'read',
    'peek_project_file': 'read',
    'peek_read_lines': 'read',
    'list_issues': 'read',
    'read_issue': 'read',
    'list_pull_requests': 'read',
    'read_pull_request': 'read',
    'get_ci_status': 'read',
    'get_ci_logs': 'read',
    'find_relevant_files': 'read',
    'get_embeddings_status': 'read',
    'memory_recall': 'read',
    'scratchpad_read': 'read',
    'read_plugin_source': 'read',
    'list_user_plugins': 'read',
    'read_docs': 'read',
    'list_tool_categories': 'read',
    'list_tools_by_category': 'read',
    'find_tool': 'read',
    // introspection — Phase 1 (2.90.0, gitea#504). Read chat history /
    // conversation index; no repo / external mutation.
    'list_conversations': 'read',
    'read_chat_history': 'read',
    'search_chat_history': 'read',
    // introspection — Phase 2 (2.92.0, gitea#506). Runtime state +
    // telemetry readers. All snapshot the running app; no repo / external
    // mutation. Admitted in plan mode (read class).
    'get_active_profile': 'read',
    'list_loaded_tools': 'read',
    'get_budget_state': 'read',
    'get_token_usage': 'read',
    'get_retrieval_stats': 'read',
    'get_recent_errors': 'read',
    'ask_user': 'read',
    'submit_plan_for_approval': 'read',
    'read_approved_plan': 'read',
    // 2.76.0 (gitea#480) — entries below were missing pre-2.76.0 and
    // fell through to the 'external' default. The catalog-parity lint
    // at `tests/test-plan-mode-source-scan.mjs` enforces every
    // `register('NAME', ...)` literal in `js/tools/*.js` has an entry
    // here. Classifications preserve pre-fix admission intent (each
    // tool listed below was registered with the legacy `readOnly: true`
    // flag, signalling "no repo / external mutation"; the matching
    // honest class lands them at 'read').
    'todo_read': 'read',
    'todo_write': 'write',
    'delegate_task': 'read',
    'git_log': 'read',
    'wait_for_ci': 'read',
    'submit_script_for_approval': 'read',
    'preview_console_logs': 'read',
    'preview_errors': 'read',
    'preview_inspect': 'read',
    'preview_list': 'read',
    'preview_logs': 'read',
    'preview_network': 'read',
    'preview_snapshot': 'read',

    'edit_file': 'write',
    'replace_lines': 'write',
    'insert_lines': 'write',
    'delete_lines': 'write',
    'replace_selection': 'write',
    'insert_at_cursor': 'write',
    'goto_line': 'write',
    'select_range': 'write',
    'memory_remember': 'write',
    'memory_revise': 'write',
    'scratchpad_write': 'write',
    'scratchpad_clear': 'write',
    'write_plugin_source': 'write',
    'index_project': 'write',
    'set_active_project': 'write',
    // 2.76.0 (gitea#480) — preview action tools: mutate the sandboxed
    // iframe DOM / start/stop the preview server. No repo / file /
    // remote effect. Pre-fix they all carried `readOnly: true` (the
    // preview-tools.js header comment grouped reads + actions together
    // under "observe the workspace"); the honest classification is
    // 'write' (iframe DOM mutation), and `js/tools/registry.js`
    // PLAN_MODE_SESSION_WRITE_ALLOWLIST admits them so plan-mode
    // admission matches the pre-2.76.0 baseline.
    'preview_click': 'write',
    'preview_fill': 'write',
    'preview_resize': 'write',
    'preview_start': 'write',
    'preview_stop': 'write',

    'create_file': 'external',
    'delete_file': 'external',
    'write_file': 'external',
    'commit_files': 'external',
    'create_pull_request': 'external',
    'add_pr_review': 'external',
    'merge_pull_request': 'external',
    'create_issue': 'external',
    'update_issue': 'external',
    'add_issue_comment': 'external',
    'run_plugin': 'external',
    'run_code': 'external',
};

/**
 * Look up the `SideEffectClass` for a tool by canonical name. Fail-closed:
 * unknown names return `'external'` so the plan-mode gate treats them as
 * mutating (callers can distinguish "explicitly external" from "unknown"
 * via `name in SIDE_EFFECTS_BY_NAME` if needed).
 *
 * @param {string} name
 * @returns {SideEffectClass}
 */
export function getSideEffectByName(name) {
    if (name in SIDE_EFFECTS_BY_NAME) return SIDE_EFFECTS_BY_NAME[name];
    return 'external';
}
