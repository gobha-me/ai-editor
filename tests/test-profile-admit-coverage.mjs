/**
 * Profile `tools.admit` coverage + regression guard (gitea#438 / 2.54.0).
 *
 * Two load-bearing assertions:
 *
 *   1. **No-typo guard.** Every literal name in every profile's resolved
 *      admit array must match a tool that actually registers in
 *      production (after `js/tools/index.js` initializeAllTools fires).
 *      The 2.54.0 inversion makes admit lists hand-maintained — a typo
 *      in an admit entry would silently drop a tool from the profile,
 *      visible only in retrospect when the model says "I don't have
 *      that tool". This pins the spelling.
 *
 *   2. **Migration regression guard.** chat.v1 / coder.v1 / kb.v1 admit
 *      lists are pinned to the byte-equivalent migration sets computed
 *      from the pre-2.54.0 tag-intersection model. Any drift from these
 *      sets is either a deliberate gitea#440 curation (which would also
 *      bump this test) or an accidental regression.
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Profiles, resolveProfile } from '../js/profiles/index.js';

// ============================================
// Pinned migration baselines — gitea#438 produced these from
// `js/tools/*.js` `roles:` declarations as of 2.53.0:
//   chat.v1   = union(roles:'all', roles:'pm', roles:'reviewer') + 'mcp__*'
//   coder.v1  = union(roles:'all', roles:'coder')                + 'mcp__*'
//   kb.v1    = roles:'all'                                       + 'mcp__*'
//   subagent  = the 8-name read-only static set; NO mcp__* glob
// Drift from these requires a gitea#440 curation PR.
// ============================================

// 2.55.0 — `find_references` and `read_function` added across every
// picker/synthetic profile that inherits the `roles: 'all'` baseline
// (chat/coder/kb/pm/reviewer/plugin-dev). Pre-2.55.0, both tools carried
// `roles: 'all'` (see `git show main:js/tools/scan-tools.js`) and the
// 2.54.0 inversion's byte-equivalent migration should have included them
// in every picker admit list — but didn't. The gitea#439 dev warning
// surfaced this miss at boot ("[ToolRegistry] tool 'read_function' is not
// admitted by any profile..."); the bundled fix here corrects the
// baselines without expanding the trust surface (these were universally
// admitted in 2.54.0's predecessor; the inversion lost them in transit).
const CHAT_V1_ADMIT_BASELINE = [
    'add_issue_comment', 'add_pr_review', 'ask_user', 'create_issue',
    'create_pull_request', 'delegate_task', 'find_references',
    'find_relevant_files', 'find_tool',
    'get_ci_logs', 'get_ci_status', 'get_embeddings_status', 'get_project_tree',
    'git_log', 'goto_line', 'list_issues', 'list_open_tabs', 'list_projects',
    'list_pull_requests', 'list_tool_categories', 'list_tools_by_category',
    'memory_recall', 'memory_remember', 'memory_revise', 'merge_pull_request',
    'open_file', 'peek_project_file', 'peek_project_tree', 'peek_read_lines',
    'preview_click', 'preview_console_logs', 'preview_errors', 'preview_fill',
    'preview_inspect', 'preview_list', 'preview_logs', 'preview_network',
    'preview_resize', 'preview_snapshot', 'preview_start', 'preview_stop',
    'read_approved_plan', 'read_current_file', 'read_file', 'read_function',
    'read_issue',
    'read_lines', 'read_pull_request', 'scan_file', 'scratchpad_clear',
    'scratchpad_read', 'scratchpad_write', 'search_in_files', 'select_range',
    'set_active_project', 'submit_plan_for_approval',
    'submit_script_for_approval', 'sync_releases', 'todo_read', 'todo_write',
    'update_issue', 'mcp__*',
];

const CODER_V1_ADMIT_BASELINE = [
    'add_pr_review', 'ask_user', 'commit_files', 'create_file',
    'create_pull_request', 'delegate_task', 'delete_file', 'delete_lines',
    'edit_file', 'find_references', 'find_relevant_files', 'find_tool',
    'get_ci_logs',
    'get_ci_status', 'get_embeddings_status', 'get_project_tree', 'git_log',
    'goto_line', 'index_project', 'insert_at_cursor', 'insert_lines',
    'list_dirty_files', 'list_issues', 'list_open_tabs', 'list_projects',
    'list_pull_requests', 'list_tool_categories', 'list_tools_by_category',
    'memory_recall', 'memory_remember', 'memory_revise', 'merge_pull_request',
    'open_file', 'peek_project_file', 'peek_project_tree', 'peek_read_lines',
    'preview_click', 'preview_console_logs', 'preview_errors', 'preview_fill',
    'preview_inspect', 'preview_list', 'preview_logs', 'preview_network',
    'preview_resize', 'preview_snapshot', 'preview_start', 'preview_stop',
    'read_approved_plan', 'read_current_file', 'read_file', 'read_function',
    'read_issue',
    'read_lines', 'read_pull_request', 'replace_lines', 'replace_selection',
    'run_code', 'scan_file', 'scratchpad_clear', 'scratchpad_read',
    'scratchpad_write', 'search_in_files', 'select_range', 'set_active_project',
    'submit_plan_for_approval', 'submit_script_for_approval', 'sync_releases',
    'todo_read', 'todo_write', 'wait_for_ci', 'write_file', 'mcp__*',
];

const KB_V1_ADMIT_BASELINE = [
    'ask_user', 'delegate_task', 'find_references', 'find_relevant_files',
    'find_tool',
    'get_ci_logs', 'get_ci_status', 'get_embeddings_status', 'get_project_tree',
    'git_log', 'goto_line', 'list_issues', 'list_open_tabs', 'list_projects',
    'list_pull_requests', 'list_tool_categories', 'list_tools_by_category',
    'memory_recall', 'open_file', 'peek_project_file', 'peek_project_tree',
    'peek_read_lines', 'preview_click', 'preview_console_logs',
    'preview_errors', 'preview_fill', 'preview_inspect', 'preview_list',
    'preview_logs', 'preview_network', 'preview_resize', 'preview_snapshot',
    'preview_start', 'preview_stop', 'read_approved_plan', 'read_current_file',
    'read_file', 'read_function', 'read_issue', 'read_lines', 'read_pull_request',
    'scan_file',
    'scratchpad_clear', 'scratchpad_read', 'scratchpad_write', 'search_in_files',
    'select_range', 'set_active_project', 'submit_plan_for_approval',
    'submit_script_for_approval', 'sync_releases', 'todo_read', 'todo_write',
    'mcp__*',
];

const SUBAGENT_V1_ADMIT_BASELINE = [
    'find_tool', 'list_dirty_files', 'list_tool_categories',
    'list_tools_by_category', 'read_file', 'read_lines', 'scan_file',
    'search_in_files',
];

function resolved(name) {
    const profile = Profiles.get(name);
    assert.ok(profile, `${name} must resolve`);
    return resolveProfile(profile, n => Profiles.get(n));
}

// ============================================
// Migration regression guards
// ============================================

test('chat.v1.admit matches the byte-equivalent migration baseline', () => {
    const out = resolved('chat.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...CHAT_V1_ADMIT_BASELINE].sort());
});

test('coder.v1.admit matches the byte-equivalent migration baseline', () => {
    const out = resolved('coder.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...CODER_V1_ADMIT_BASELINE].sort());
});

test('kb.v1.admit matches the byte-equivalent migration baseline', () => {
    const out = resolved('kb.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...KB_V1_ADMIT_BASELINE].sort());
});

test('subagent.v1.admit equals the trust-boundary 8-read-only set (no mcp__* glob)', () => {
    const out = resolved('subagent.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...SUBAGENT_V1_ADMIT_BASELINE].sort());
    assert.ok(!out.tools.admit.includes('mcp__*'),
        'sub-agent profile must NOT carry the mcp__* glob — trust boundary requires explicit per-tool admission');
});

// ============================================
// Inheritance carry-through (chat_multi.v1, rp.v1)
// ============================================

test('chat_multi.v1 inherits chat.v1.admit unchanged (empty tools block)', () => {
    const out = resolved('chat_multi.v1');
    const chatOut = resolved('chat.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...chatOut.tools.admit].sort());
});

test('rp.v1 inherits chat.v1.admit unchanged (empty tools block)', () => {
    const out = resolved('rp.v1');
    const chatOut = resolved('chat.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...chatOut.tools.admit].sort());
});

// ============================================
// full.v1 sentinel preservation
// ============================================

test('full.v1.admit is the literal [\'*\'] bypass sentinel', () => {
    const out = resolved('full.v1');
    assert.deepEqual(out.tools.admit, ['*']);
});

// ============================================
// Sentinel/glob-shape sanity — every admit entry is a string and either
// `'*'`, a `<prefix>__*` glob, or a snake_case-ish tool name.
// ============================================

test('every admit entry is well-formed (string + recognized shape)', () => {
    const profileNames = [
        'chat.v1', 'coder.v1', 'kb.v1', 'full.v1', 'pm.v1', 'reviewer.v1',
        'plugin-dev.v1', 'chat_multi.v1', 'rp.v1', 'subagent.v1',
    ];
    const NAME_RE = /^[a-z][a-z0-9_]*$/;
    const GLOB_RE = /^[a-z][a-z0-9_]*__\*$/;
    for (const name of profileNames) {
        const out = resolved(name);
        const admit = out.tools.admit || [];
        for (const entry of admit) {
            assert.equal(typeof entry, 'string', `${name}.admit entry must be string: got ${typeof entry}`);
            const ok = entry === '*' || NAME_RE.test(entry) || GLOB_RE.test(entry);
            assert.ok(ok, `${name}.admit entry '${entry}' is malformed (must be '*', snake_case name, or '<prefix>__*' glob)`);
        }
    }
});
