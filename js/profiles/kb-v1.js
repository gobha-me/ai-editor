// @ts-check
/**
 * `kb.v1` — single-purpose knowledge-base assistant. The minimal profile.
 * Inherits from `chat.v1` (per `docs/DESIGN-profiles.md` §"Canonical
 * Profiles" → "kb.v1").
 *
 * Phase 2 of the profiles arc per ROADMAP §"After 2.0.0" line 111. From
 * the design (line 307): *"The KB profile is a useful demonstration that
 * the architecture is opt-in at the profile level. A surface that doesn't
 * need compression pays no cost for it. A surface that doesn't need a
 * task ledger pays no cost for it."*
 *
 * Field provenance: overrides mirror the kb.v1 row at
 * `docs/DESIGN-profiles.md` lines 292–306. The "minimal (citation lookup)"
 * tools row is realized as `allowed_groups: ['all']` — universal-tagged
 * tools only (drops the `'pm'` / `'reviewer'` baselines chat.v1 carries).
 * No standalone `citation_lookup` tool exists today; reserved for a
 * follow-up slice.
 *
 * **2.8.0 — picker promotion via `systemPrompt` addendum.** Phase 2 shipped
 * as `SYNTHETIC_ENTRIES` lookup-only at 2.6.0 because the declared overrides
 * referenced runtime infrastructure that didn't exist; picking kb.v1 then
 * would have behaved indistinguishably from chat.v1. The `KB_SYSTEM_PROMPT`
 * addendum below is the load-bearing lift — it makes choosing kb.v1 a
 * user-observable behavior change (model refuses to write code, cites
 * line ranges, declines to answer outside attached docs) without depending
 * on unbuilt infrastructure. Pattern mirrors `plugin-dev.v1`'s precedent
 * (1.23.x). Consumer site is `js/prompts.js:286-288` — already wired to
 * append `profile.systemPrompt` to the base prompt.
 *
 * @module profiles/kb-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * KB-mode constraint addendum. Appended to the editor's base systemPrompt
 * when kb.v1 is the active profile. Short by design — verbose addenda burn
 * cache against the 200+ line base prompt.
 *
 * @type {string}
 */
export const KB_SYSTEM_PROMPT = `
=== KB MODE ===

You are answering from a knowledge base. Constraints:

- Answer ONLY from content in the user's attached documents. If the answer
  is not in the attached documents, say "not found in attached docs" — do
  not generalize from training-data knowledge.
- Cite every claim with the source path and line range, e.g.
  \`(docs/handbook.md:42-58)\`. Multiple citations welcome.
- Do NOT propose edits, run tools that mutate state, or generate code.
  Read-only consultation only.
`.trim();

/**
 * KB overrides on top of `chat.v1`. Disables compression and task-ledger
 * subsystems entirely; narrows retrieval to `kb_documents`; drops memory.
 * Carries the `KB_SYSTEM_PROMPT` addendum (2.8.0).
 *
 * @type {Profile}
 */
export const KB_V1 = {
    name: 'kb.v1',
    version: '1',
    base: 'chat.v1',

    budget: {},

    retrieval: {
        // DESIGN-profiles.md §kb.v1: *"kb_documents only"*. Replaces
        // chat.v1's `attached_docs` wholesale (array semantics).
        collections: ['kb_documents'],
        // *"Memory collections: none"*.
        memory_collections: [],
        // DESIGN-profiles.md §kb.v1: *"semantic 1.0, thematic 0.4 (for
        // overview queries), structural 0.6"*.
        strategy_weights: {
            semantic: 1.0,
            structural: 0.6,
            thematic: 0.4,
        },
        // chunkers / metadata_extensions / novelty_threshold — inherited.
    },

    memory: {},

    compression: {
        // DESIGN-profiles.md §kb.v1: *"Compression rules: none — sessions
        // too short to compress"*. Empty array replaces chat.v1's Rule-5
        // entry wholesale. Resolver in `js/profiles/resolve.js` returns
        // an empty `rules` list for kb.v1; the chat loop's compression
        // pass becomes a no-op.
        rules: [],
        // preserve_recent: irrelevant when rules is empty, but keep
        // chat.v1's `4` inherited rather than emitting a divergent literal.
    },

    tools: {
        // 2.54.0 (gitea#438) — explicit admission. Was `allowed_groups:
        // ['all']` in the legacy tag-intersection model. Mirrors the
        // legacy admission set (every `'all'`-tagged tool) plus the
        // `'mcp__*'` glob.
        //
        // 2.56.0 (gitea#440) — aggressive read-only trim. The KB system-
        // prompt addendum (line 45) declares kb.v1 read-only ("do not
        // propose edits, run tools that mutate state, or generate code"),
        // but the 2.54.0 byte-equivalent admit list still carried
        // mutating tools (scratchpad write/clear, todo_write,
        // submit_*, delegate_task, set_active_project, sync_releases,
        // mutating preview drivers). This pass makes the admit list and
        // the system-prompt constraint agree — every entry is read-only
        // by construction. Drops the `'mcp__*'` glob too: MCP servers
        // may be mutating; trust boundary is the server config, not the
        // picker profile (mirrors `subagent.v1`'s "explicit per-tool
        // admission" precedent). Preview tools are dropped wholesale —
        // `kb.v1.preview.enabled` is false (inherited from chat.v1) so
        // the runtime filter strips them anyway; admit-list is now
        // self-describing of what kb.v1 actually exposes. Closes
        // github#40 / paper-cut.
        admit: [
            'ask_user',
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
            'open_file',
            'peek_project_file',
            'peek_project_tree',
            'peek_read_lines',
            'read_approved_plan',
            'read_chat_history',
            'read_current_file',
            'read_file',
            'read_function',
            'read_issue',
            'read_lines',
            'read_pull_request',
            'scan_file',
            'scratchpad_read',
            'search_chat_history',
            'search_in_files',
            'select_range',
            'todo_read',
        ],
    },

    task_ledger: {
        // DESIGN-profiles.md §kb.v1: *"Task ledger disabled — short-session
        // pattern doesn't benefit"*.
        enabled: false,
    },

    systemPrompt: KB_SYSTEM_PROMPT,
};
