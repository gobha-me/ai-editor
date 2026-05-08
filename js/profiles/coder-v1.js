// @ts-check
/**
 * `coder.v1` — the canonical coder profile.
 *
 * Originally scaffolded data-only in 1.1.0 with `base: null`. **As of 1.14.1
 * `coder.v1` inherits from `chat.v1`** (the canonical baseline registered by
 * 1.14.0); the literal here carries only the fields where coder *diverges*
 * from chat. Identical fields fall through to the base via
 * [`resolveProfile`](./inheritance.js).
 *
 * No consumer wires up to a *resolved* coder profile yet — subsystems still
 * read raw `CODER_V1` slices on the existing role-keyed paths
 * (compression at [`resolve.js`](./resolve.js), tools at
 * [`js/chat/handlers.js`](../chat/handlers.js)). The slices kept on the raw
 * literal — `compression.rules` / `preserve_recent`, the full `tools.static`
 * array, `task_ledger.capacity` — are exactly what those raw consumers
 * still need; the slices removed (`budget.total_tokens` etc.) are the ones
 * no consumer reads off raw, so trimming them is safe today and proven
 * sound under resolution by [`tests/test-profile-resolution.mjs`](../../tests/test-profile-resolution.mjs).
 *
 * Subsystems migrate to reading from the *resolved* profile in 1.16
 * (compression), 1.17 (memory), 1.18 (tools), 1.19 (retrieval); see
 * [`docs/ROADMAP.md`](../../docs/ROADMAP.md) §"2.X path".
 *
 * Design source: `docs/DESIGN-profiles.md` §"Canonical Profiles" → "coder.v1".
 *
 * @module profiles/coder-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Coder overrides on top of `chat.v1`. Field-by-field provenance for the
 * surviving (non-trimmed) overrides:
 *
 * - **budget**: Coder raises `output_reserve` to 8000 (longer code edits)
 *   and trims `memory_reserve` to 1500 (coder leans on retrieval, not
 *   memory). The unchanged knobs (`total_tokens` 32000, `system_reserve`
 *   2000, `history_reserve` 8000) come from `chat.v1`'s 32K reference
 *   window. Residual retrieval_budget = 32000 - (2000 + 8000 + 8000 +
 *   1500) = 12500. A future PR will add a `resolveProfileBudget(profile,
 *   model)` helper that scales these with the loaded model's context;
 *   today these are the documented defaults.
 *
 * - **retrieval**: Coder targets workspace corpora and session memory only,
 *   pulls retrieval down to a single semantic strategy (no structural at
 *   coder surfaces yet — that lands with retrieval Phase 1.5.0+ tuning),
 *   and runs a low novelty threshold (re-admits liberally so a second
 *   look at an already-seen file works for the *new aspect* case).
 *   `chunkers` and `metadata_extensions` are inherited from `chat.v1`
 *   (both `[]` until ingest pipeline lands in 1.5.0).
 *
 * - **memory**: Current memory is `js/tools/scratchpad-tools.js` (session
 *   scope only). `default_scope: 'session'` is the honest description;
 *   1.3.0 will flip the default to `workspace`. `capacity_warnings.session:
 *   20` matches the scratchpad balanced-mode maxKeys.
 *
 * - **compression**: Coder runs Rules 1, 2, 5 (`subsumption`,
 *   `invalidation`, `summarization`); chat runs Rule 5 only. The full
 *   3-rule array is an explicit override — array values *replace*
 *   wholesale per [`inheritance.js`](./inheritance.js) (no append).
 *   `preserve_recent: 24` matches `summarizer.recentCountTools` from
 *   `core.js#State.settings` — the conservative window coder needs because
 *   tool-call sequences cluster densely; chat's 4-turn protected window
 *   would put many active sequences inside the eviction zone. The two
 *   reconcile in 1.16.0 when chat surfaces start reading from chat.v1's
 *   resolved compression slice. Inherited from `chat.v1`: `summarizer`
 *   (mode/promptTemplate/modelOverride all match).
 *
 * - **tools.static**: Carries the full coder admission set — meta-tools,
 *   structural-anchor tools (scratchpad/todo, promoted in 1.8.4),
 *   `ask_user` (1.9.0), `submit_plan_for_approval` (1.10.0), file ops,
 *   commit ops, CI tools (1.4.5). The full array is an explicit override
 *   (replaces base wholesale). Inherited from `chat.v1`: `catalog: []`,
 *   `discovery_strategies`, `budget_tokens: 5000`, `expansion_mode`.
 *
 * - **task_ledger**: Coder-tuned 500-record cap (vs chat's 100) and a low
 *   novelty threshold per DESIGN-profiles.md.
 *
 * @type {Profile}
 */
export const CODER_V1 = {
    name: 'coder.v1',
    version: '1',
    base: 'chat.v1', // 1.14.1 — coder inherits from chat.v1; resolveProfile fills in the gaps.

    budget: {
        // total_tokens: 32000           — inherited from chat.v1
        // system_reserve: 2000          — inherited from chat.v1
        output_reserve: 8000,            // coder override per DESIGN-profiles.md
        // history_reserve: 8000         — inherited from chat.v1
        memory_reserve: 1500,            // coder override per DESIGN-profiles.md
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
        // chunkers: []            — inherited from chat.v1 (populated in 1.5.0)
        // metadata_extensions: [] — inherited from chat.v1 (populated in 1.5.0)
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
            // Interaction tool — github#33 Phase 1 (1.9.0). Lets the LLM
            // pause and ask a structured question; same load-bearing
            // case as scratchpad/todo (cheap-tier models won't reliably
            // discover it through find_tool / list_tools_by_category).
            'ask_user',
            // Plan Mode approval gate — github#25 (1.10.0). Always
            // admitted so it's available the moment Plan Mode is
            // toggled on. Marked readOnly so the plan-mode filter
            // keeps it in the LLM's catalog while every mutating
            // tool is dropped.
            'submit_plan_for_approval',
            // LLM-authored automation Phase 1 — 1.16.0. Tier-0
            // sandboxed Worker runs the LLM's reviewed script against
            // the project's virtual file tree. The runtime filter in
            // `js/llm/api.js` (`applyScriptAutomationFilter`) drops
            // this tool when `scriptAutomation.enabled === false` on
            // the resolved profile + settings overlay; otherwise
            // admission flows through static like every other
            // structural-anchor tool. Marked readOnly so Plan Mode
            // admits it (handler is read-only; the per-invocation
            // approval gate handles the actual side effect).
            'submit_script_for_approval',
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

    // 1.16.0 — LLM-authored automation Phase 1 (DESIGN-llm-authored-automation.md).
    // Coder is the value-case surface for the Tier-0 Worker — dead-CSS sweeps,
    // unused-export scans, import-graph audits collapse from ~50 grep calls /
    // ~2M tokens to 2 calls / ~5–10K tokens (DESIGN line 13, 256–262). This
    // override flips the inherited `enabled: false` from chat.v1 to `true`;
    // the timeout / cap defaults stay at chat.v1's values (re-stated here so
    // the override block is self-describing without requiring a resolveProfile
    // round-trip to read the active values).
    scriptAutomation: {
        enabled: true,
        timeout_ms: 30000,         // 30s — bumped from 10s after live Tier-0 testing; see CHANGELOG §1.16.0.
        max_output_bytes: 262144,  // DESIGN line 188.
    },
};
