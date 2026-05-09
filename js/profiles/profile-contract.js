// @ts-check
/**
 * Profile contract — the typedef surface for per-surface configuration of
 * the four intelligence subsystems (retrieval, memory, compression, tools).
 *
 * Scaffolded in 1.1.0 (data only, no consumer wired up). Subsystems read
 * the relevant slice of a profile at session start. Profiles do not own
 * runtime state beyond the task ledger; subsystems own their own state.
 *
 * Sources:
 *   - `docs/DESIGN-profiles.md` §"The Profile Contract"
 *   - `docs/DESIGN-retrieval.md` for ChunkerRegistration / FieldSpec shapes
 *   - `docs/DESIGN-memory.md`    for MemoryScope values
 *   - `docs/DESIGN-compression.md` for CompressionRule registration
 *   - `docs/DESIGN-tools.md`     for ToolDef / ToolID
 *
 * Why JSDoc and not real TS: project constraint (`docs/ARCHITECTURE.md`
 * "Design Constraints") — no build step, no transpiler. Type safety
 * comes via `jsconfig.json` `checkJs: true`.
 *
 * @module profiles/profile-contract
 */

/**
 * Memory scope. Phase 1 (1.3.0) ships `user` only; `workspace`, `persona`,
 * `org` follow in 1.3.x. `session` is the legacy scratchpad-style scope
 * (see `js/tools/scratchpad-tools.js`).
 *
 * @typedef {"session"|"user"|"workspace"|"persona"|"org"} MemoryScope
 */

/**
 * Allocation of the total context window across categories. Sum of the
 * non-residual values should be ≤ `total_tokens`; the residual is the
 * retrieval budget (per DESIGN-profiles.md §"Budget shape").
 *
 * @typedef {Object} BudgetSpec
 * @property {number} total_tokens     Ceiling for the full composed prompt.
 * @property {number} system_reserve   Tokens reserved for system framing.
 * @property {number} output_reserve   `max_tokens` for generation.
 * @property {number} history_reserve  Tokens reserved for chat history.
 * @property {number} memory_reserve   Tokens reserved for memory chunks.
 */

/**
 * One chunker registration in the retrieval ingest pipeline. The actual
 * chunker implementations land in 1.5.0; this is just the wiring shape.
 *
 * @typedef {Object} ChunkerRegistration
 * @property {string} kind        e.g. "prose" | "code" | "conversation" | "structured".
 * @property {string} version     Used in ChunkID hashing for cache invalidation.
 * @property {Object} [options]   Surface-specific knobs (e.g. heuristic flavor).
 */

/**
 * Custom metadata field a chunker is told to extract for this surface.
 *
 * @typedef {Object} FieldSpec
 * @property {string} name        Field key on `Metadata.custom`.
 * @property {string} kind        "string" | "number" | "boolean" | "string[]" — interpreted by the chunker.
 * @property {boolean} [required] If true, ingest fails on missing values.
 */

/**
 * Retrieval configuration consumed by the retrieval subsystem (1.5.0).
 *
 * @typedef {Object} RetrievalConfig
 * @property {string[]}                       collections          Which corpora to query by default.
 * @property {MemoryScope[]}                  memory_collections   Which memory scopes to query.
 * @property {Record<string, number>}         strategy_weights     Override default applicability per strategy.
 * @property {ChunkerRegistration[]}          chunkers             Chunkers active in ingest.
 * @property {FieldSpec[]}                    metadata_extensions  Surface-specific Metadata.custom fields.
 * @property {number}                         novelty_threshold    Task ledger re-admission cutoff [0..1].
 */

/**
 * Memory configuration consumed by the memory subsystem (1.3.0).
 *
 * @typedef {Object} MemoryConfig
 * @property {MemoryScope}              default_scope          Where new memories land by default.
 * @property {number|null}              propose_after_n_turns  Null disables automatic proposals.
 * @property {Partial<Record<MemoryScope, number>>} capacity_warnings  Soft caps per scope.
 */

/**
 * One compression rule registration. Implementations land in 1.2.x;
 * this is just the wiring shape.
 *
 * @typedef {Object} CompressionRule
 * @property {string} name       e.g. "subsumption" | "invalidation" | "consumption" | "resolution" | "summarization".
 * @property {number} priority   Lower runs first.
 * @property {Object} [options]  Rule-specific knobs.
 */

/**
 * Summarizer config — the existing `js/chat/summarizer.js` is Rule 5;
 * this just lets a profile declare which summarizer model/prompt to use.
 *
 * @typedef {Object} SummarizerConfig
 * @property {string}      mode               "aggressive" | "balanced" | "conservative" | "custom" — matches existing State.settings.summarizerMode.
 * @property {string|null} promptTemplate     Optional override for the summarizer prompt.
 * @property {string|null} modelOverride      Optional model id for summarization (otherwise uses the chat model).
 */

/**
 * Compression configuration consumed by the compression subsystem (1.2.x).
 *
 * @typedef {Object} CompressionConfig
 * @property {CompressionRule[]}     rules            Ordered (priority ascending).
 * @property {number}                preserve_recent  Last N turns never evicted (hard invariant).
 * @property {SummarizerConfig|null} summarizer       Null disables Rule 5 entirely.
 */

/**
 * Tool definition shape — placeholder typedef matching what the existing
 * `js/tools/registry.js` exposes (name + role gates). The full
 * `ToolDef`/`AuthSpec` shape from `DESIGN-tools.md` lands in 1.4.0.
 *
 * @typedef {Object} ToolDefRef
 * @property {string}   name              Canonical tool name (matches registry key).
 * @property {string[]} [required_groups] RBAC gate (placeholder; not enforced until 1.4.0).
 * @property {boolean}  [requires_consent] Surface prompts the user before execution.
 */

/**
 * Tools configuration consumed by the tools subsystem (1.4.0).
 *
 * `allowed_groups` (1.23.0) is the profile-side authorization vector
 * consumed by `Profiles.filterTools`. Mirrors the legacy tool-side
 * `_registeredRoles` shape — `'all'` admits every tool tagged 'all',
 * `'*'` is the bypass marker (every tool admits regardless), otherwise
 * a tool admits when its `_registeredRoles` and the profile's
 * `allowed_groups` overlap. Optional during the prep slice; consumed
 * for real at 1.24.0.
 *
 * @typedef {Object} ToolsConfig
 * @property {ToolDefRef[]} catalog               Available tools for this surface.
 * @property {string[]}     static                Always-loaded subset (tool names — `ToolID` once 1.4.0 lands).
 * @property {string[]}     discovery_strategies  "categorical" | "semantic" | "frequency".
 * @property {number}       budget_tokens         Ceiling for the tool slice (default 5000 per ROADMAP §Decision 5).
 * @property {"short"|"full"} expansion_mode      Default lazy-schema state for discovered tools.
 * @property {string[]}     [allowed_groups]      Profile-side admission set; see `Profiles.filterTools`.
 */

/**
 * Profile-level task ledger config. The ledger struct itself is in
 * `task-ledger.js`; this just controls how the profile uses it.
 *
 * @typedef {Object} TaskLedgerConfig
 * @property {boolean} enabled            False disables ledgers entirely (e.g. KB profile).
 * @property {number}  capacity           Max admission records per task.
 * @property {number}  novelty_threshold  Default re-admission cutoff (overridable per request).
 */

/**
 * The full profile contract.
 *
 * `systemPrompt` (1.23.0) is the profile-side replacement for the
 * legacy `Roles.get(role).systemPrompt` field consumed by
 * [`js/prompts.js`](../prompts.js). Optional — `null` / undefined
 * means no addendum. Today only the synthetic `plugin-dev.v1` carries
 * a value (the SDK addendum lifted from `js/core.js`); other profiles
 * leave it absent.
 *
 * @typedef {Object} Profile
 * @property {string}             name           Canonical id, e.g. "coder.v1".
 * @property {string}             version
 * @property {string|null}        base           Optional inheritance — "chat.v1" to start from chat defaults.
 * @property {BudgetSpec}         budget
 * @property {RetrievalConfig}    retrieval
 * @property {MemoryConfig}       memory
 * @property {CompressionConfig}  compression
 * @property {ToolsConfig}        tools
 * @property {TaskLedgerConfig}   task_ledger
 * @property {string|null}        [systemPrompt] Optional profile-scoped prompt addendum.
 */

/**
 * Type guard — confirms a value has the top-level Profile shape. Used by
 * tests; not yet enforced at runtime by any consumer.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isProfile(v) {
    if (!v || typeof v !== 'object') return false;
    const o = /** @type {Record<string, unknown>} */ (v);
    return (
        typeof o.name === 'string' &&
        typeof o.version === 'string' &&
        (o.base === null || typeof o.base === 'string') &&
        !!o.budget && typeof o.budget === 'object' &&
        !!o.retrieval && typeof o.retrieval === 'object' &&
        !!o.memory && typeof o.memory === 'object' &&
        !!o.compression && typeof o.compression === 'object' &&
        !!o.tools && typeof o.tools === 'object' &&
        !!o.task_ledger && typeof o.task_ledger === 'object'
    );
}
