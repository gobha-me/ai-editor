// @ts-check
/**
 * `subagent.v1` — the restrictive-by-default profile that bounds a
 * delegated sub-agent's reach.
 *
 * Per [`docs/DESIGN-sub-agents.md`](../../docs/DESIGN-sub-agents.md)
 * §"The Load-Bearing Decision" — the *profile* is the trust boundary at
 * the sub-agent level. A child agent runs against `subagent.v1`'s
 * admitted tools, not the parent's. The catalog stays the boundary at
 * the tool level (one new tool, `delegate_task`); the profile becomes
 * the boundary at the sub-agent level.
 *
 * **Slice 1 of 2.49.0 (this file).** Profile registers in `Profiles.get`
 * / `Profiles.has` via `SYNTHETIC_ENTRIES` (deliberately not in
 * `ENTRIES` — the picker does not surface a sub-agent profile, since
 * sub-agents are *invoked by the parent agent*, not picked by the
 * user). No runtime consumer wires up to it yet — slice 2 ships the
 * `delegate_task` tool + approval card + sub-agent loop. The data shape
 * lands first so slice 2 can rely on it.
 *
 * Field-by-field provenance: every value mirrors DESIGN-sub-agents.md
 * §Decision §1 lines 178–255. `base: 'chat.v1'` (not `coder.v1`) is
 * load-bearing — see DESIGN §"Why `base: 'chat.v1'` not `coder.v1`":
 * coder admits writes / plan / script / preview, all of which would
 * default the sub-agent to the parent's full reach. The point of the
 * trust boundary is that the *default* is restrictive; the parent agent
 * overrides per-call.
 *
 * @module profiles/subagent-v1
 */

/**
 * @typedef {import('./profile-contract.js').Profile} Profile
 */

/**
 * Restrictive sub-agent default. Inherits chat.v1's baseline; overrides
 * tools to ~5 read-only entries + the meta-tools needed to navigate the
 * narrowed catalog; disables memory writes; carries a fresh `subagent`
 * block with the per-call ceilings (token / dollar / time / recursion).
 *
 * @type {Profile}
 */
export const SUBAGENT_V1 = {
    name: 'subagent.v1',
    version: '1',
    base: 'chat.v1',

    // Lowered output reserve — sub-agents produce summaries, not edits.
    // Lowered history reserve — child contexts stay small; that is the
    // point of delegation (DESIGN §Decision §2 clean-start rationale).
    // Memory reserve zeroed — the sub-agent has no memory tool admits.
    budget: {
        total_tokens: 32000,
        system_reserve: 1500,
        output_reserve: 2048,
        history_reserve: 4000,
        memory_reserve: 0,
    },

    retrieval: {
        // Inherited collections from chat.v1; sub-agent reads what the
        // chat surface reads. No `memory_collections` — sub-agents do
        // not mutate or read user memory by default (DESIGN §Decision §2).
        collections: [],
        memory_collections: [],
        strategy_weights: { semantic: 1.0, structural: 0.0, thematic: 0.0 },
        chunkers: [],
        metadata_extensions: [],
        novelty_threshold: 0.4,
    },

    memory: {
        // No persistent memory writes; `memory_remember` is not in
        // `tools.static` and `capacity_warnings.session: 0` ensures any
        // future admission would be capped at zero.
        default_scope: 'session',
        propose_after_n_turns: null,
        capacity_warnings: { session: 0 },
    },

    compression: {
        // Rule 5 only — sub-agents are short-lived; subsumption /
        // invalidation are coder-shape rules whose value comes from
        // long tool-call sequences. A sub-agent that ran long enough to
        // need them is probably the wrong shape for delegation.
        rules: [{ name: 'summarization', priority: 50 }],
        preserve_recent: 4,
        summarizer: {
            mode: 'balanced',
            promptTemplate: null,
            modelOverride: null,
        },
    },

    tools: {
        catalog: [],
        static: [
            // Read-only catalog. The intersection rule (slice 2's
            // `delegate_task.tools` per-call allowlist) lets a parent
            // call narrow this further per invocation.
            'read_file',
            'read_lines',
            'scan_file',
            'search_in_files',
            'list_dirty_files',
            // Meta-tools so the sub-agent can navigate its own catalog.
            'list_tool_categories',
            'list_tools_by_category',
            'find_tool',
        ],
        discovery_strategies: ['categorical'],
        budget_tokens: 2000,
        expansion_mode: 'short',
        // New `'subagent'` admission group tag (DESIGN §Decision §5) —
        // future tools intended for sub-agent-only admission tag
        // themselves `roles: ['subagent']`; none in Phase 1. `'all'`
        // covers the read tools above (each is tagged `roles: 'all'` at
        // its register site).
        allowed_groups: ['all', 'subagent'],
    },

    task_ledger: {
        // No ledger at sub-agent level. The parent's ledger is the
        // surface of record; the child's tool calls are not admitted
        // into the parent's ledger by design (DESIGN §Decision §2 —
        // clean-start, no parent-state aliasing).
        enabled: false,
        capacity: 0,
        novelty_threshold: 0.4,
    },

    // Sub-agent-specific block. Mirrors `scriptAutomation` / `preview`
    // structurally; consumed by `resolveSubAgentConfig(profileName)` in
    // [`./resolve.js`](./resolve.js). All four ceilings are per-call
    // defaults; slice 2's `delegate_task({max_tokens?, max_dollars?,
    // run_timeout_ms?})` can clamp them lower per invocation but never
    // raise above these values.
    //
    // Defaults rationale (DESIGN §Open Questions — these are guesses,
    // revisited after Phase 1 dogfood):
    //   - `run_timeout_ms: 300000` (5 minutes) — a sub-agent doing ~10
    //     read tool calls has ample headroom; the cost ceiling is the
    //     harder gate either way.
    //   - `max_tokens: 50000` — ~10 read tool calls + summary fit
    //     comfortably; pre-Composer-era ceilings would have hit this
    //     much sooner.
    //   - `max_dollars: 0.50` — order-of-magnitude headroom over a
    //     single read tool call's cost on cheap-tier models.
    //   - `recursion_depth: 0` — no recursion in slice 2; Phase 3
    //     unlocks via a different profile (`subagent_recursive.v1` if
    //     it earns a slot), not by flipping this knob.
    subagent: {
        enabled: true,
        run_timeout_ms: 300000,
        max_tokens: 50000,
        max_dollars: 0.50,
        recursion_depth: 0,
    },
};
