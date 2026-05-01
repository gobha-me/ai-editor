// @ts-check
/**
 * Unified TaskLedger — per-task working state shared across the four
 * intelligence subsystems (retrieval, memory, compression, tools).
 *
 * Scaffolded in 1.1.0 (data only, no consumer wired up). Subsequent
 * tracks fill in the corresponding record arrays:
 *   - 1.4.0 (Tools)     → tool_admissions, tool_invocations
 *   - 1.5.0 (Retrieval) → admissions, exclusions
 *
 * Schema sources:
 *   - `docs/DESIGN-profiles.md` §"The Task Ledger"
 *   - `docs/DESIGN-tools.md`    §"Tool Ledger Integration"
 *
 * Lifecycle: a ledger lives for the duration of one *task* (not session).
 * Tasks begin on heuristics — new top-level user message after inactivity,
 * an explicit `/task` marker, session start. They end on heuristics too —
 * topic shift, completion signal, session end. A profile may run multiple
 * tasks per session; each gets its own ledger. Ledgers do not survive
 * session end by default (working state, not memory — see `DESIGN-memory.md`
 * for the persistence story).
 *
 * @module profiles/task-ledger
 */

/**
 * Stable identifier for a chunk admission target. Will be a hash of
 * `(collection || source_uri || normalized_byte_range || chunker_version)`
 * once the retrieval subsystem (1.5.0) defines it. For now, treated as an
 * opaque string.
 *
 * @typedef {string} ChunkID
 */

/**
 * Stable identifier for a tool. Will be a hash of
 * `(profile_namespace, canonical_name, version)` once the tools subsystem
 * (1.4.0) defines it. For now, treated as an opaque string (matches the
 * existing `name` keys in `js/tools/registry.js`).
 *
 * @typedef {string} ToolID
 */

/**
 * Stable identifier for a chat turn. The existing chat history uses
 * timestamp + index; the formal `TurnID` lands when 1.2.0 introduces the
 * compression turn-store. For now, treated as an opaque string.
 *
 * @typedef {string} TurnID
 */

/**
 * Stable identifier for a task scope. Generated at task start.
 *
 * @typedef {string} TaskID
 */

/**
 * Why retrieval admitted a chunk to context.
 *
 * @typedef {Object} AdmissionRecord
 * @property {ChunkID}        chunk_id
 * @property {number}         admitted_at      Epoch milliseconds.
 * @property {TurnID}         turn_id          Which turn triggered admission.
 * @property {number}         tokens           Token cost of the admitted chunk.
 * @property {string|null}    query            The query that justified admission.
 * @property {number[]|null}  query_embedding  Cached for novelty scoring (re-admission decisions).
 * @property {string}         strategy         "semantic" | "structural" | "thematic" | "pinned".
 * @property {string[]}       facets_covered   Optional aspect descriptors for novelty scoring.
 */

/**
 * Why retrieval *did not* admit a candidate chunk.
 *
 * @typedef {Object} ExclusionRecord
 * @property {ChunkID}     chunk_id
 * @property {number}      excluded_at  Epoch milliseconds.
 * @property {TurnID}      turn_id
 * @property {string}      reason       e.g. "already_admitted_low_novelty" | "out_of_budget" | "filtered_pre_strategy".
 * @property {string}      rule         Which mechanism made the decision.
 */

/**
 * Why the tool admission layer kept a tool callable for this task.
 *
 * Note: tools, unlike chunks, are *retained* once admitted. The ledger's
 * role for tools is retention (LRU eviction when budget exceeded), not
 * suppression. See `DESIGN-tools.md` §"Tool Ledger Integration".
 *
 * @typedef {Object} ToolAdmissionRecord
 * @property {ToolID}              tool_id
 * @property {number}              admitted_at    Epoch milliseconds.
 * @property {"short"|"full"}      form           Lazy schema state.
 * @property {"static"|"sticky"|"discovery"} source
 * @property {number}              cost           Token cost of the tool definition at this form.
 * @property {number|null}         last_used_at   Null until first invocation; LRU eviction key.
 */

/**
 * One actual tool call by the model.
 *
 * @typedef {Object} ToolInvocationRecord
 * @property {ToolID}        tool_id
 * @property {number}        invoked_at     Epoch milliseconds.
 * @property {TurnID}        turn_id
 * @property {string|null}   args_summary   Truncated for ledger compactness.
 * @property {boolean}       succeeded
 */

/**
 * One iteration of an agentic loop (e.g. test-driven loop, 1.4.5).
 *
 * The loop orchestrator (`js/intelligence/test-loop/`) appends one of these
 * per iteration so the LLM Debug modal can render the loop's history and
 * post-mortems can replay what happened. Same struct semantics as the other
 * record arrays — append-only, capped, session-scoped.
 *
 * @typedef {Object} LoopIterationRecord
 * @property {string}      loop_id        Stable id for the whole loop run; same across iterations.
 * @property {number}      iteration      1-indexed iteration number within this loop.
 * @property {number}      started_at     Epoch milliseconds.
 * @property {number|null} ended_at       Null while in-flight; epoch ms on completion.
 * @property {number}      tokens_used    Approximate token spend for this iteration.
 * @property {string|null} commit_sha     SHA committed during the iteration (null if model didn't commit).
 * @property {string|null} ci_state       "success" | "failure" | "error" | "cancelled" | "pending" | null.
 * @property {string}      exit_reason    "in_flight" | "ci_pass" | "ci_fail" | "no_progress" | "max_iterations" | "max_tokens" | "wall_clock" | "user_abort" | "error".
 */

/**
 * The ledger itself. One owner per task; record arrays inside it.
 *
 * Capacity is bounded (default 500 admission records). Older records
 * spill to a compact form (chunk_id + turn_id, dropping query embeddings)
 * and eventually drop entirely with a warning. A long-running task
 * pressing the cap is a signal the profile's task boundaries are too
 * coarse — re-tune the boundary detection rather than expanding the cap.
 *
 * @typedef {Object} TaskLedger
 * @property {TaskID}                   task_id
 * @property {string}                   surface              Profile name for diagnostics, e.g. "coder.v1".
 * @property {number}                   started_at           Epoch milliseconds.
 * @property {AdmissionRecord[]}        admissions           Chunk admissions (filled in 1.5.0).
 * @property {ExclusionRecord[]}        exclusions           Chunk exclusions (filled in 1.5.0).
 * @property {ToolAdmissionRecord[]}    tool_admissions      Tool admissions (filled in 1.4.0).
 * @property {ToolInvocationRecord[]}   tool_invocations     Tool invocations (filled in 1.4.0).
 * @property {LoopIterationRecord[]}    loop_iterations      Test-driven loop iterations (filled in 1.4.5).
 * @property {number}                   capacity             Max admission records before spill/drop.
 */

/**
 * Default cap on admission records per task (per DESIGN-profiles.md §Capacity).
 * Coder profile may raise this; KB profile disables ledgers entirely.
 */
export const DEFAULT_LEDGER_CAPACITY = 500;

/**
 * Construct an empty ledger. Canonical entry point for every consumer —
 * 1.4.0 and 1.5.0 both call this so they cannot drift on initial shape.
 *
 * @param {Object}  opts
 * @param {TaskID}  opts.taskId    Required. Caller assigns the id at task start.
 * @param {string}  opts.surface   Profile name, e.g. "coder.v1".
 * @param {number} [opts.capacity] Override the default cap. Default: 500.
 * @param {number} [opts.startedAt] Override clock for tests. Default: Date.now().
 * @returns {TaskLedger}
 */
export function createTaskLedger({ taskId, surface, capacity, startedAt }) {
    if (typeof taskId !== 'string' || !taskId) {
        throw new TypeError('createTaskLedger: taskId must be a non-empty string');
    }
    if (typeof surface !== 'string' || !surface) {
        throw new TypeError('createTaskLedger: surface must be a non-empty string');
    }
    return {
        task_id: taskId,
        surface,
        started_at: typeof startedAt === 'number' ? startedAt : Date.now(),
        admissions: [],
        exclusions: [],
        tool_admissions: [],
        tool_invocations: [],
        loop_iterations: [],
        capacity: typeof capacity === 'number' && capacity > 0 ? capacity : DEFAULT_LEDGER_CAPACITY,
    };
}

/**
 * Type guard — confirms an arbitrary value has the shape of a TaskLedger.
 * Cheap structural check, not a deep validation. Used by tests and future
 * consumers that accept ledgers from external callers.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isTaskLedger(v) {
    if (!v || typeof v !== 'object') return false;
    const o = /** @type {Record<string, unknown>} */ (v);
    return (
        typeof o.task_id === 'string' &&
        typeof o.surface === 'string' &&
        typeof o.started_at === 'number' &&
        Array.isArray(o.admissions) &&
        Array.isArray(o.exclusions) &&
        Array.isArray(o.tool_admissions) &&
        Array.isArray(o.tool_invocations) &&
        Array.isArray(o.loop_iterations) &&
        typeof o.capacity === 'number'
    );
}
