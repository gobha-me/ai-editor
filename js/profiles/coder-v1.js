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
 * - **tools**: Catalog left empty here on purpose — the existing
 *   `js/tools/registry.js` is the source of truth. 1.4.0 will populate
 *   this from the registry filtered by role, and `static` will hold the
 *   small always-loaded subset called out in
 *   ROADMAP.md:301: meta-tools + read_file + read_lines + scan_file +
 *   edit_file + commit_files + list_dirty_files.
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
        rules: [
            // Rules 1–4 (Subsumption, Invalidation, Consumption, Resolution) register
            // here as they land in 1.2.x. Rule 5 is the only running rule today.
            { name: 'summarization', priority: 50 },
        ],
        preserve_recent: 24, // Mirrors State.settings.summarizer.recentCountTools.
        summarizer: {
            mode: 'balanced',  // Mirrors State.settings.summarizerMode default.
            promptTemplate: null,
            modelOverride: null,
        },
    },

    tools: {
        catalog: [],            // Populated from js/tools/registry.js when 1.4.0 wires admission.
        static: [],             // 1.4.0: meta-tools + read_file/read_lines/scan_file/edit_file/commit_files/list_dirty_files.
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
