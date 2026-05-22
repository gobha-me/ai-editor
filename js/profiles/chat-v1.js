// @ts-check
/**
 * `chat.v1` — the canonical standard-chat profile and the base from which
 * every other canonical profile inherits (per `docs/DESIGN-profiles.md`
 * §"Canonical Profiles" → *"chat.v1 — Standard chat — The base profile
 * from which the others inherit"*).
 *
 * **No consumer wires up to this object yet.** Same posture as
 * [`coder-v1.js`](./coder-v1.js): the data file lands first; subsystems
 * begin reading the relevant slices in subsequent slices, and the full
 * profile contract becomes load-bearing in 2.0. Today's runtime still
 * routes through `js/profiles/resolve.js`'s role-string switch (and its
 * `rule5_only_shim` for non-coder roles); switching that switch to read
 * from a resolved profile is deferred until a follow-up that proves
 * `resolveProfile(coder_with_base) ≡ CODER_V1_standalone` field-by-field.
 *
 * Field-by-field provenance: every value mirrors the chat.v1 row of the
 * `docs/DESIGN-profiles.md` Canonical Profiles table (the 32K reference
 * window). Where a field has no design value (e.g. `chunkers`,
 * `metadata_extensions`), the empty-but-typedef-satisfying value is used —
 * the chunker registry doesn't exist yet (lands with retrieval Phase 1.5.0).
 *
 * @module profiles/chat-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Standard-chat baseline. The four other canonical profiles in
 * `DESIGN-profiles.md` (`chat_multi.v1`, `rp.v1`, `coder.v1`, `kb.v1`)
 * inherit from this one and override only what their surface needs.
 *
 * @type {Profile}
 */
export const CHAT_V1 = {
    name: 'chat.v1',
    version: '1',
    base: null, // chat.v1 IS the base; the design's passing reference to a deeper "base.v1" is not a separate profile.

    budget: {
        // 32K reference window from DESIGN-profiles.md §chat.v1 row.
        // retrieval_budget = 32000 - (2000 + 4000 + 8000 + 2000) = 16000 (residual).
        total_tokens: 32000,
        system_reserve: 2000,
        output_reserve: 4000,
        history_reserve: 8000,
        memory_reserve: 2000,
    },

    retrieval: {
        // Standard chat queries attached docs only — workspace_code etc.
        // are coder-only and arrive via the coder override.
        collections: ['attached_docs'],
        memory_collections: ['user', 'persona'],
        strategy_weights: {
            semantic: 1.0,
            structural: 0.5,
            thematic: 0.0,
        },
        chunkers: [],            // Populated when ingest pipeline lands in 1.5.0.
        metadata_extensions: [], // Populated when chunkers register fields in 1.5.0.
        novelty_threshold: 0.5,  // Mid-range; chat re-admits less liberally than coder (0.3) but more than KB.
    },

    memory: {
        // chat.v1 default scope is `user` — coder will override to `workspace`,
        // rp.v1 will override to `persona`, kb.v1 disables memory entirely.
        default_scope: 'user',
        propose_after_n_turns: null, // No automatic proposals until 1.3.0 ships consent UI.
        capacity_warnings: {},        // Populated per scope as the memory subsystem matures.
    },

    compression: {
        // chat.v1 ships Rule 5 only — DESIGN-profiles.md §chat.v1 row:
        // *"Compression rules: Rule 5 only (generic summarization)"*.
        // Coder layers Rules 1, 2, (3, 4 when they land), 5 on top.
        rules: [
            { name: 'summarization', priority: 50 },
        ],
        // DESIGN-profiles.md §chat.v1 row: *"preserve_recent: 4"*. As of
        // 1.17.0 chat surfaces read from this resolved compression slice
        // via `resolveCompressionConfig('chat.v1')`, so this value is now
        // load-bearing — the previous `rule5_only_shim` (preserve_recent: 24)
        // was retired with that slice.
        preserve_recent: 4,
        summarizer: {
            mode: 'balanced',  // Mirrors State.settings.summarizerMode default (same as coder).
            promptTemplate: null,
            modelOverride: null,
        },
    },

    tools: {
        catalog: [],            // Source of truth is js/tools/registry.js via the Catalog adapter (1.3.4).
        static: [
            // Chat baseline keeps only the interaction tool. Everything else
            // (file ops, ci tools, scratchpad/todo, plan-mode gate) is coder-
            // surface scope and arrives via the coder override. Cheap-tier
            // models won't reliably discover `ask_user` through the meta-
            // tools, so it stays static across every profile that allows
            // structured pauses (same load-bearing reason it joined coder.v1
            // in 1.9.0; see js/prompts.js §ASK_USER_INSTRUCTIONS).
            'ask_user',
        ],
        discovery_strategies: ['categorical'], // Same default as coder.v1; semantic discovery in 1.4.1.
        budget_tokens: 5000,    // ROADMAP §Decisions 5: tool budget defaults to 5000.
        expansion_mode: 'short', // Lazy schema — name + 1-line on discovery; full on first call.
        // 2.54.0 (gitea#438) — explicit admission. Replaces the legacy
        // `allowed_groups: ['all', 'pm', 'reviewer']` tag-intersection
        // model with an explicit list of tool names. Each name is a tool
        // that `Profiles.filterTools` admits for this profile; the
        // `'mcp__*'` glob admits MCP-bridge tools whose names are formed
        // as `mcp__<serverId>__<toolName>` (see `js/mcp/bridge.js`).
        //
        // 2.56.0 (gitea#440) — hand-curation pass. The 2.54.0 migration
        // produced a byte-equivalent superset of the legacy tag union
        // (`'all' ∪ 'pm' ∪ 'reviewer'`), which carried the original
        // github#40 paper-cut: `create_issue` reachable from picker chat
        // via the `'pm'` tag the user never saw. This pass trims chat.v1
        // to a conversational + read-shaped surface. Removed entries:
        // the issue-write cohort (`create_issue`, `update_issue`,
        // `add_issue_comment`) relocates to `coder.v1` where it actually
        // belongs; the PR-write cohort (`create_pull_request`,
        // `merge_pull_request`, `add_pr_review`) stays in `coder.v1`
        // only; `delegate_task`, `set_active_project`,
        // `submit_script_for_approval`, `sync_releases` are coder/admin
        // operations that slipped in via byte-equivalent migration.
        // Closes github#40.
        admit: [
            'ask_user',
            'find_references',
            'find_relevant_files',
            'find_tool',
            'get_active_profile',
            'get_budget_state',
            'get_ci_logs',
            'get_ci_status',
            'get_embeddings_status',
            'get_project_tree',
            'get_recent_errors',
            'get_retrieval_stats',
            'get_token_usage',
            'git_log',
            'goto_line',
            'list_conversations',
            'list_issues',
            'list_loaded_tools',
            'list_open_tabs',
            'list_projects',
            'list_pull_requests',
            'list_tool_categories',
            'list_tools_by_category',
            'memory_recall',
            'memory_remember',
            'memory_revise',
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
            'submit_plan_for_approval',
            'todo_read',
            'todo_write',
            'mcp__*',
        ],
    },

    task_ledger: {
        // DESIGN-profiles.md §chat.v1 row: *"Task ledger enabled, 100-record cap"*.
        enabled: true,
        capacity: 100,
        novelty_threshold: 0.5, // Mirrors retrieval.novelty_threshold; profiles may diverge later.
    },

    // 1.16.0 — LLM-authored automation Phase 1 (DESIGN-llm-authored-automation.md).
    // chat.v1 keeps the Tier-0 Worker surface DISABLED. Standard chat doesn't
    // need ad-hoc fs walks; the value case (X^N collapse on dead-CSS / unused-
    // export shapes) is a coder-surface concern. Coder overrides `enabled: true`.
    // The `timeout_ms` and `max_output_bytes` defaults are inherited but the
    // surface never spawns a Worker until enabled flips.
    scriptAutomation: {
        enabled: false,
        timeout_ms: 30000,         // 30s — bumped from 10s after live Tier-0 testing; see CHANGELOG §1.16.0.
        max_output_bytes: 262144,  // 256 KB — DESIGN line 188.
    },

    // 1.22.0 — In-editor preview & verify Tier 1 (DESIGN-preview.md).
    // chat.v1 keeps the preview surface DISABLED. Standard chat has no
    // workspace to render; the value case (closing the Sokoban-class
    // boot-error gap) is a coder-surface concern. Coder overrides
    // `enabled: true`. Per DESIGN-preview.md §"First-Ship Scope" → Profile
    // config row.
    preview: {
        enabled: false,
    },
};
