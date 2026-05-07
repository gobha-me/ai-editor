// @ts-check
/**
 * `coder.v1` — the canonical coder profile, scaffolded data-only in 1.1.0.
 *
 * **No consumer wires up to this object yet.** The roadmap exit criteria
 * for §1.1.0 is explicit: *"Unified `TaskLedger` typedef + empty-state
 * struct present in `js/profiles/`; no consumer wires up yet."* Subsystems
 * begin reading these fields in 1.2.0 (compression), 1.3.0 (memory),
 * 1.4.0 (tools), and 1.5.0 (retrieval), and the full profile contract
 * becomes load-bearing in 2.0.
 *
 * This file's job is to land *the shape* of a profile that mirrors
 * current coder-role behavior (`role: 'coder'` in
 * `js/core.js#BUILTIN_ROLES`). When a future PR wires a subsystem to a
 * field here, that field should already match what the editor does today.
 *
 * Design source: `docs/DESIGN-profiles.md` §"Canonical Profiles" → "coder.v1".
 *
 * @module profiles/coder-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Mirror of the existing coder role's behavior. Field-by-field provenance:
 *
 * - **budget**: Numbers from DESIGN-profiles.md §Budget for the 32K
 *   reference window (chat.v1 baseline + coder overrides: output_reserve
 *   raised to 8000, memory_reserve 1500). At runtime the actual budget
 *   would scale with the loaded model's context window — the
 *   `js/chat/summarizer.js` `getContextScale()` already does this for the
 *   summarizer alone. A future PR will add a `resolveProfileBudget(profile,
 *   model)` helper; until then, these are the documented defaults.
 *
 * - **retrieval**: Mirrors the single-strategy semantic retrieval
 *   currently provided by `js/context-manager.js` and the
 *   `find_relevant_files` tool. The full multi-strategy Composer arrives
 *   in 1.5.0; until then `chunkers` and `metadata_extensions` are the
 *   minimum to keep the typedef satisfied.
 *
 * - **memory**: Current memory is `js/tools/scratchpad-tools.js` (session
 *   scope only). `default_scope: 'session'` is the honest description;
 *   1.3.0 will flip the default to `workspace` for coder.
 *
 * - **compression**: Today only Rule 5 (summarization) runs, via
 *   `js/chat/summarizer.js`. `preserve_recent: 24` matches the
 *   existing `summarizer.recentCountTools` from `core.js#State.settings`
 *   — the value the summarizer uses when tool calls are in recent
 *   history (which is always true for coder). Rules 1–4 register here
 *   in 1.2.x as their implementations land.
 *
 * - **tools**: `catalog` stays as `[]` — the source of truth is
 *   `js/tools/registry.js`, surfaced via the
 *   `js/intelligence/tools/Catalog` adapter (1.3.4 foundation). The
 *   `static` array carries the names called out in ROADMAP §1.4.0:
 *   meta-tools (`list_tool_categories`, `list_tools_by_category`,
 *   `find_tool`) plus `read_file` + `read_lines` + `scan_file` +
 *   `edit_file` + `commit_files` + `list_dirty_files`. The set is
 *   *declared* in 1.3.4 and *consumed* when admission lands in 1.4.0
 *   PR 2; entries the catalog cannot resolve (the meta-tools, until
 *   PR 3) are silently skipped by the consumer.
 *
 * - **task_ledger**: Enabled with the coder-tuned cap and a low novelty
 *   threshold per DESIGN-profiles.md (coder re-admits liberally so a
 *   second look at an already-seen file works for the *new aspect* case).
 *
 * @type {Profile}
 */
export const CODER_V1 = {
    name: 'coder.v1',
    version: '1',
    base: null, // 1.1.0 ships only `coder.v1`; `chat.v1` arrives with 2.0 inheritance.

    budget: {
        total_tokens: 32000,
        system_reserve: 2000,
        output_reserve: 8000,   // coder override per DESIGN-profiles.md
        history_reserve: 8000,
        memory_reserve: 1500,   // coder override per DESIGN-profiles.md
        // retrieval_budget = 32000 - (2000 + 8000 + 8000 + 1500) = 12500 (residual).
    },

    retrieval: {
        collections: ['workspace_code', 'workspace_docs', 'recent_tool_results'],
        memory_collections: ['session'],
        strategy_weights: {
            // Current single-strategy retrieval is semantic-only (via embeddings).
            // Structural/thematic land in 1.5.0; weights here are the design target,
            // not the running behavior.
            semantic: 1.0,
            structural: 0.0,
            thematic: 0.0,
        },
        chunkers: [],            // Populated when ingest pipeline lands in 1.5.0.
        metadata_extensions: [], // Populated when chunkers register fields in 1.5.0.
        novelty_threshold: 0.3,  // Coder re-admits liberally — see DESIGN-profiles.md "novelty threshold low".
    },

    memory: {
        default_scope: 'session', // Today: scratchpad. 1.3.x flips to 'workspace'.
        propose_after_n_turns: null, // No automatic proposals until 1.3.0 ships consent UI.
        capacity_warnings: {
            session: 20,         // Matches scratchpad balanced-mode maxKeys (see scratchpad-tools.js).
        },
    },

    compression: {
        // Phase 1 (1.2.0) ships Rules 1, 2, 5. Rules 3 (Consumption) and
        // 4 (Resolution) register here as they land in 1.2.2 / 1.2.3.
        // Resolver (`js/profiles/resolve.js`) maps these name+priority
        // entries to the runtime `CompressionRule` objects in
        // `js/intelligence/compression/rules/`.
        rules: [
            { name: 'subsumption',   priority: 10 },
            { name: 'invalidation',  priority: 20 },
            { name: 'summarization', priority: 50 },
        ],
        // preserve_recent reconciliation: the design's Open Question
        // ("Default preserve_recent value — Start at 4") is the
        // *future chat.v1* default. Coder keeps the conservative 24 it
        // inherited from `summarizer.recentCountTools` because tool-
        // call sequences cluster densely in coder sessions and a 4-turn
        // protected window would put many active sequences inside the
        // eviction zone. Tunable from real-usage measurements once the
        // 1.2.1 cost dashboard ships.
        preserve_recent: 24,
        summarizer: {
            mode: 'balanced',  // Mirrors State.settings.summarizerMode default.
            promptTemplate: null,
            modelOverride: null,
        },
    },

    tools: {
        catalog: [],            // Source of truth is js/tools/registry.js via the Catalog adapter (js/intelligence/tools/).
        static: [
            // Meta-tools — PR 3 of 1.4.0 adds the implementations; resolution returns null until then.
            'list_tool_categories',
            'list_tools_by_category',
            'find_tool',
            // Structural-anchor tools — promoted to static in 1.8.4 alongside
            // the scratchpad visibility panel (github#34). Pre-1.3.15 these
            // tools were always-loaded; the 1.3.15 admission policy moved
            // them behind discovery, which silently dropped scratchpad usage
            // because cheap-tier models don't reliably run
            // `list_tools_by_category` to admit them, and the
            // `SCRATCHPAD_INSTRUCTIONS` block at js/prompts.js:233 is gated
            // on `scratchpad_write` admission. Hidden-by-default is for
            // niche / expensive tools (MCP, peek_*, eval_*); structural
            // anchors are load-bearing for compression-survival and the
            // visibility panel makes their first-class status legible to
            // users — they belong in static.
            'scratchpad_write',
            'scratchpad_read',
            'scratchpad_clear',
            'todo_write',
            'todo_read',
            // Always-loaded coder essentials — ROADMAP §1.4.0.
            'read_file',
            'read_lines',
            'scan_file',
            'edit_file',
            'commit_files',
            'list_dirty_files',
            // CI tools added in 1.4.5 alongside the test-driven loop. The
            // orchestrator polls CI itself, but exposing the tools to the
            // model lets one-shot status checks happen mid-conversation
            // without the loop UI.
            'get_ci_status',
            'wait_for_ci',
            'get_ci_logs',
        ],
        discovery_strategies: ['categorical'], // ROADMAP §1.4.0: categorical only; semantic in 1.4.1.
        budget_tokens: 5000,    // ROADMAP §Decisions 5: tool budget defaults to 5000.
        expansion_mode: 'short', // Lazy schema — name + 1-line on discovery; full on first call.
    },

    task_ledger: {
        enabled: true,
        capacity: 500,         // DESIGN-profiles.md "coder.v1": 500-record cap.
        novelty_threshold: 0.3, // Mirrors retrieval.novelty_threshold for now; profiles may diverge later.
    },
};
