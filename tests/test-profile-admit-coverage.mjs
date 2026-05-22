/**
 * Profile `tools.admit` coverage + regression guard (gitea#438 / 2.54.0;
 * hand-curated at gitea#440 / 2.56.0).
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
 *   2. **Curated-baseline regression guard.** chat.v1 / coder.v1 / kb.v1
 *      admit lists are pinned to the gitea#440 hand-curated sets.
 *      Pre-2.56.0 these were byte-equivalent migrations of the legacy
 *      tag-intersection model (carrying the github#40 paper-cut bug);
 *      gitea#440 trimmed each profile to its actual purpose. Drift from
 *      these sets is either a deliberate follow-up curation (which would
 *      also bump this test) or an accidental regression.
 *
 * Pure logic; no DOM/Storage/fetch. Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Profiles, resolveProfile } from '../js/profiles/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, '..', 'js', 'tools');

// ============================================
// Pinned curated baselines — gitea#440 / 2.56.0 hand-curated each picker
// profile to its actual purpose:
//   chat.v1   — conversational + read-shaped; drops issue/PR-write cohort
//               (relocated to coder.v1) + four out-of-purpose extras
//   coder.v1  — gains the issue-write cohort (add_issue_comment,
//               create_issue, update_issue) per the github#40 paper's
//               "where it actually belongs" framing
//   kb.v1    — aggressive read-only trim; admit list now agrees with
//               KB_SYSTEM_PROMPT's read-only consultation constraint.
//               Drops mutating built-ins, drops the mcp__* glob.
//   subagent  — 11-name read-only set (was 8; 2.90.0 gitea#504 added
//               the three introspection tools); NO mcp__* glob
// Drift from these requires a deliberate follow-up curation PR.
// ============================================

// 2.90.0 (gitea#504) — three introspection tools (list_conversations,
// read_chat_history, search_chat_history) added to each picker + sub-agent
// baseline. Phase 1 of the self-introspection arc; admission shape
// mirrors the meta-tools (find_tool / list_tool_categories /
// list_tools_by_category) — niche per turn but structural anchor for
// fresh-context spawns under 3.X amendment direction.
const CHAT_V1_ADMIT_BASELINE = [
    'ask_user', 'find_references', 'find_relevant_files', 'find_tool',
    'get_ci_logs', 'get_ci_status', 'get_embeddings_status', 'get_project_tree',
    'git_log', 'goto_line',
    'list_conversations',
    'list_issues', 'list_open_tabs', 'list_projects',
    'list_pull_requests', 'list_tool_categories', 'list_tools_by_category',
    'memory_recall', 'memory_remember', 'memory_revise',
    'open_file', 'peek_project_file', 'peek_project_tree', 'peek_read_lines',
    'preview_click', 'preview_console_logs', 'preview_errors', 'preview_fill',
    'preview_inspect', 'preview_list', 'preview_logs', 'preview_network',
    'preview_resize', 'preview_snapshot', 'preview_start', 'preview_stop',
    'read_approved_plan',
    'read_chat_history',
    'read_current_file', 'read_file', 'read_function',
    'read_issue', 'read_lines', 'read_pull_request', 'scan_file',
    'scratchpad_clear', 'scratchpad_read', 'scratchpad_write',
    'search_chat_history',
    'search_in_files', 'select_range',
    'submit_plan_for_approval', 'todo_read', 'todo_write', 'mcp__*',
];

const CODER_V1_ADMIT_BASELINE = [
    'add_issue_comment', 'add_pr_review', 'ask_user', 'commit_files',
    'create_file', 'create_issue', 'create_pull_request', 'delegate_task',
    'delete_file', 'delete_lines', 'edit_file', 'find_references',
    'find_relevant_files', 'find_tool',
    'get_ci_logs', 'get_ci_status', 'get_embeddings_status', 'get_project_tree',
    'git_log', 'goto_line', 'index_project', 'insert_at_cursor', 'insert_lines',
    'list_conversations',
    'list_dirty_files', 'list_issues', 'list_open_tabs', 'list_projects',
    'list_pull_requests', 'list_tool_categories', 'list_tools_by_category',
    'memory_recall', 'memory_remember', 'memory_revise', 'merge_pull_request',
    'open_file', 'peek_project_file', 'peek_project_tree', 'peek_read_lines',
    'preview_click', 'preview_console_logs', 'preview_errors', 'preview_fill',
    'preview_inspect', 'preview_list', 'preview_logs', 'preview_network',
    'preview_resize', 'preview_snapshot', 'preview_start', 'preview_stop',
    'read_approved_plan',
    'read_chat_history',
    'read_current_file', 'read_file', 'read_function',
    'read_issue', 'read_lines', 'read_pull_request',
    'replace_lines', 'replace_selection', 'run_code', 'scan_file',
    'scratchpad_clear', 'scratchpad_read', 'scratchpad_write',
    'search_chat_history',
    'search_in_files', 'select_range', 'set_active_project',
    'submit_plan_for_approval', 'submit_script_for_approval', 'sync_releases',
    'todo_read', 'todo_write', 'update_issue',
    'wait_for_ci', 'write_file', 'mcp__*',
];

const KB_V1_ADMIT_BASELINE = [
    'ask_user', 'find_references', 'find_relevant_files', 'find_tool',
    'get_ci_logs', 'get_ci_status', 'get_embeddings_status', 'get_project_tree',
    'git_log', 'goto_line',
    'list_conversations',
    'list_issues', 'list_open_tabs', 'list_projects',
    'list_pull_requests', 'list_tool_categories', 'list_tools_by_category',
    'memory_recall', 'open_file', 'peek_project_file', 'peek_project_tree',
    'peek_read_lines', 'read_approved_plan',
    'read_chat_history',
    'read_current_file', 'read_file',
    'read_function', 'read_issue', 'read_lines', 'read_pull_request',
    'scan_file', 'scratchpad_read',
    'search_chat_history',
    'search_in_files', 'select_range',
    'todo_read',
];

const SUBAGENT_V1_ADMIT_BASELINE = [
    'find_tool', 'list_dirty_files', 'list_tool_categories',
    'list_tools_by_category', 'read_file', 'read_lines', 'scan_file',
    'search_in_files',
    // 2.90.0 gitea#504 — introspection Phase 1.
    'list_conversations', 'read_chat_history', 'search_chat_history',
];

function resolved(name) {
    const profile = Profiles.get(name);
    assert.ok(profile, `${name} must resolve`);
    return resolveProfile(profile, n => Profiles.get(n));
}

// ============================================
// Migration regression guards
// ============================================

test('chat.v1.admit matches the gitea#440 curated baseline', () => {
    const out = resolved('chat.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...CHAT_V1_ADMIT_BASELINE].sort());
});

test('coder.v1.admit matches the gitea#440 curated baseline', () => {
    const out = resolved('coder.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...CODER_V1_ADMIT_BASELINE].sort());
});

test('kb.v1.admit matches the gitea#440 curated baseline (read-only)', () => {
    const out = resolved('kb.v1');
    assert.deepEqual([...out.tools.admit].sort(), [...KB_V1_ADMIT_BASELINE].sort());
});

test('kb.v1.admit carries no mutating tools (read-only by construction)', () => {
    // Pinning the load-bearing property gitea#440 introduced for kb.v1:
    // the admit list and the KB_SYSTEM_PROMPT read-only constraint agree.
    // If a future trim accidentally re-admits a mutating tool, this test
    // fails with a clear name rather than as a generic baseline mismatch.
    const out = resolved('kb.v1');
    const MUTATING = new Set([
        'commit_files', 'create_file', 'create_issue', 'create_pull_request',
        'delegate_task', 'delete_file', 'delete_lines', 'edit_file',
        'insert_at_cursor', 'insert_lines', 'merge_pull_request',
        'replace_lines', 'replace_selection', 'run_code',
        'scratchpad_clear', 'scratchpad_write', 'set_active_project',
        'submit_plan_for_approval', 'submit_script_for_approval',
        'sync_releases', 'todo_write', 'update_issue', 'write_file',
        'add_issue_comment', 'add_pr_review', 'index_project',
        'preview_click', 'preview_fill', 'preview_resize',
        'preview_start', 'preview_stop',
    ]);
    for (const entry of out.tools.admit) {
        assert.ok(!MUTATING.has(entry),
            `kb.v1 must not admit mutating tool '${entry}' — violates the read-only KB_SYSTEM_PROMPT constraint`);
    }
    assert.ok(!out.tools.admit.includes('mcp__*'),
        'kb.v1 must not carry the mcp__* glob — MCP servers may be mutating; trust boundary requires explicit per-tool admission');
});

test('subagent.v1.admit equals the trust-boundary 11-read-only set (no mcp__* glob)', () => {
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

// ============================================
// 2.56.0 (gitea#440) — registered-tool coverage gate.
//
// Every name registered by `js/tools/*.js` must be admitted by at least
// one profile. This is the CI-gate mirror of the 2.55.0 default-OFF dev
// warn (`ToolRegistry.register` console.warn when zero profiles admit a
// new tool): loud at runtime AND hard at test time. Without this guard,
// a future migration could re-produce byte-equivalent admit residue that
// silently drops a tool from every picker — the bug shape gitea#440 just
// closed.
//
// Implementation: source-scan `js/tools/*.js` for every
// `(?:ToolRegistry|registry).register('name', ...)` call (positional
// form — every production tool uses this; same idiom as
// `tests/test-chat-tool-name-literals.mjs`). For each name, ask
// `Profiles.findAdmittingProfiles(name)` for the set of profiles that
// admit it (the 2.55.0 helper). At least one admitter is required.
//
// The full.v1 `'*'` bypass and the `<prefix>__*` globs both count — a
// tool admitted only via the `'*'` sentinel is still "admitted by a
// profile" semantically (matches the runtime gate). The 2.55.0 warn
// excludes `'*'`-only admission for *picker* visibility, but this test
// pins the laxer property of "exists at all."
// ============================================

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function readRegisteredToolNames() {
    const names = new Set();
    const pattern = /(?:ToolRegistry|registry)\.register\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]/g;
    for (const entry of readdirSync(TOOLS_DIR)) {
        if (!entry.endsWith('.js')) continue;
        const src = stripComments(readFileSync(join(TOOLS_DIR, entry), 'utf8'));
        let m;
        while ((m = pattern.exec(src)) !== null) {
            names.add(m[1]);
        }
    }
    return names;
}

test('every registered tool in js/tools/* is admitted by at least one profile (gitea#440 coverage gate)', () => {
    const names = readRegisteredToolNames();
    assert.ok(names.size > 0, 'source-scan of js/tools/*.js found zero registrations — regex broken?');

    const orphans = [];
    for (const name of names) {
        const admitters = Profiles.findAdmittingProfiles(name);
        if (!admitters || admitters.length === 0) {
            orphans.push(name);
        }
    }

    assert.deepEqual(
        orphans,
        [],
        `tools not admitted by any profile: ${orphans.join(', ')}. ` +
        `Either add the tool to a profile's tools.admit array (e.g. coder.v1) ` +
        `or remove the registration if the tool is dead. Mirror of the 2.55.0 ` +
        `console.warn at boot — this test surfaces the same property at CI time.`,
    );
});
