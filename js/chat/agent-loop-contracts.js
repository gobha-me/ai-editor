// @ts-check
/**
 * Agent-loop contract surface — JSDoc typedefs naming the shapes the loop
 * authors and the state it owns. No runtime exports; consumers reference
 * the typedefs via `import('./agent-loop-contracts.js').*` in JSDoc.
 *
 * Authoritative design: [`docs/DESIGN-agent-loop.md`](../../docs/DESIGN-agent-loop.md).
 * Landed 2026-05-21; this module is the source-side citation point so
 * future cache-deadlock / dup-loop / envelope-authorship disputes have a
 * named home instead of doing archaeology against implementation.
 *
 * Consumers (4):
 *  - `./tool-loop-core.js` — loop body; authors `EnvelopeShape`; owns
 *    `LoopState` counters (`noProgressStreak`, `roundCount`,
 *    `duplicateStreak`); constants `NO_PROGRESS_LIMIT`, `HARD_CAP`,
 *    `DUP_REFUSE_THRESHOLD` declared at the top of that module.
 *  - `./cache-invalidation.js` — cache-coordination walks across the
 *    same-request `toolCallCache` and the cross-request `toolActionLog`;
 *    builds `CachedEnvelope` payloads via `buildCrossRequestCacheResult`.
 *  - `./cache-policy.js` — `isStatefulRead` / `getStatefulReadToolsLive`
 *    decide which tools bypass the dup-caches per design
 *    §"Cache-Key Composition + Stateful Reads."
 *  - `./refusal-hints.js` — per-tool `next_action_hint` registry feeds
 *    `buildRefusalPayload`, which authors `RefusedEnvelope` when the
 *    dup-streak guard fires.
 *
 * No behavior change. JSDoc-only. Centralizing the un-emitted shape
 * (`PartialEnvelope`) is deliberate — the design lists 4 envelopes;
 * production emits 3 (`success`, `refused`, `cached`); naming the
 * 4th here gives future soft-budget work a named contract to land
 * against without a synthesized fake emitter today.
 *
 * @module chat/agent-loop-contracts
 */

/* -------------------------------------------------------------------------- */
/* The Authorship Rule                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The boundary between this surface and the Tools subsystem is testable
 * per-field:
 *
 * > **If the envelope field is set by the tool, based on the tool's own
 * > state, it's a Tools concern. If the envelope field is set by the loop,
 * > based on loop state, it's an agent-loop concern.**
 *
 * Loop state means: caches the loop owns, dup-streak counters the loop
 * maintains, queued input the loop has accepted, pause-Promise slots the
 * loop is awaiting, the side-effects classification the loop reads from
 * `ToolDef`. Tool state means: the tool's own preconditions, its own
 * internal data, its own resource limits, its own error conditions
 * surfaced from the operation it performed.
 *
 * Verbatim classification table from `DESIGN-agent-loop.md` §"The
 * Authorship Rule":
 *
 * | Field / behavior                                                                  | Set by                                                       | Owner          |
 * |-----------------------------------------------------------------------------------|--------------------------------------------------------------|----------------|
 * | `_refused: true` (duplicate-streak detected; tool was *not* invoked)              | Loop, after counting consecutive identical calls             | Agent loop     |
 * | `_cached: true` (same-request LRU hit; tool was *not* invoked)                    | Loop, on cache lookup                                        | Agent loop     |
 * | `_cache_note` (mutating-tool cache hit narration)                                 | Loop, branching on `ToolDef.side_effects`                    | Agent loop     |
 * | `next_action_hint` extension to `_refused` envelope                               | Loop concatenates from a per-tool registry                   | Agent loop     |
 * | `error: "indexer_not_ready"` (tool's own readiness check)                         | Tool returns from its precondition logic                     | Tools          |
 * | `error: "retrieval_partial"` (tool's own soft-budget timer)                       | Tool returns when its budget expires                         | Tools          |
 * | Stale-line content window in error payload                                        | Tool's own drift detection populates it                      | Tools          |
 * | `pendingUserResponse` Promise resolution                                          | Tool returns the Promise; loop awaits and times-out-bypasses | Both, at different levels |
 * | Cache-key composition and stateful-read bypass                                    | Loop composes the key, decides to bypass                     | Agent loop (with `ToolDef.side_effects` as input) |
 * | Cross-request action log invalidation on file mutation                            | Loop walks the log on mutation events                        | Agent loop     |
 * | `noProgressStreak` increment / `HARD_CAP` termination                             | Loop counts and terminates                                   | Agent loop     |
 *
 * The rule is the test. Apply it to any new contract; the answer falls out.
 */

/* -------------------------------------------------------------------------- */
/* Envelope shapes                                                            */
/*                                                                            */
/* These describe what the loop ACTUALLY emits today, not a prescriptive      */
/* future shape. Discrimination is via flag-presence (`_refused: true`,       */
/* `_cached: true`) — no `kind` discriminator field is added to runtime       */
/* envelopes by this PR. That would be a behavior change.                     */
/* -------------------------------------------------------------------------- */

/**
 * Tool was invoked and returned. The envelope IS the tool's return value
 * verbatim — no wrapping object, no added flags. The loop wraps it into
 * the conversation buffer as a `tool_result` turn (in `enrichToolResultTurn`),
 * but at the loop's call-site level the "envelope" is just `toolResult =
 * await executeToolCall(...)`. Tool-authored failure shapes (per
 * `DESIGN-tools.md` §"Tool-authored failure shape contract") flow through
 * here — `{error: "indexer_not_ready"}` is still a `SuccessEnvelope` at
 * the loop's level because the tool ran.
 *
 * The envelope-bearing turn carries the trust label of the tool's content
 * per `DESIGN-intelligence.md` §"Trust Labels on Admitted Content."
 *
 * Discriminator: absence of `_refused`, `_cached`, and `_partial` flags.
 *
 * @typedef {object} SuccessEnvelope  The tool's raw return; freeform shape per tool.
 */

/**
 * Tool was *not* invoked. The loop intercepted the call because the same
 * `(tool_name, sorted_args)` was issued `DUP_REFUSE_THRESHOLD` consecutive
 * times without intervening progress. Authored by `buildRefusalPayload`
 * in `./refusal-hints.js`.
 *
 * The `error` string concatenates the loop's diagnostic with the per-tool
 * `next_action_hint` from the hints registry below `STRONG_THRESHOLD`, or
 * with the imperative STOP prose at `streak >= STRONG_THRESHOLD` (which
 * the dup-streak guard fires when the loop reaches `DUP_REFUSE_THRESHOLD`).
 * Cheap-tier models reliably pick up the recovery path when the hint is
 * specific.
 *
 * The `_refused: true` flag is the structured discriminator for tool-loop
 * instrumentation / debug surfaces; the human-readable recovery info is
 * in `error`.
 *
 * @typedef {object} RefusedEnvelope
 * @property {string} error
 * @property {true} _refused
 * @property {string} [last_user_message]  Plumbed for diagnostics when available.
 */

/**
 * Tool was *not* invoked. The loop served a memoized prior result. Two
 * sub-cases — same-request LRU hit (`toolCallCache`) and cross-request
 * action-log hit (`toolActionLog`) — share this shape; the runtime does
 * not currently encode a `source` discriminator, but the
 * `_cache_note` wording differs (cross-request narrates *"Cached across
 * requests"*; same-request narrates *"Cached from earlier in this
 * conversation"*). Both branches set `_cached: true`.
 *
 * `_cache_note` wording branches on `ToolDef.side_effects` (mutating
 * tools get a *"the mutation has happened; do not retry to confirm"*
 * narration; read tools get a *"prior result is still valid"* narration).
 *
 * The remaining fields are spread from the original tool return — the
 * envelope shape is *the original return + `_cached: true` + `_cache_note`*.
 * Field set is therefore freeform with two pinned keys.
 *
 * **Trust label retention on cache hits.** A cache-served envelope retains
 * the trust label of the *original* tool invocation, not the cache's. The
 * cached payload was authored by the tool when it originally ran; serving
 * it now does not re-author it. Per design §"Trust label retention on
 * cache hits" — the envelope-bearing Turn carries `authority: tool`,
 * `authority_id: <tool_id>`, and the trust tier from the original ToolDef
 * admission, with `derivation` pointing at the original invocation. This
 * prevents the cache layer from accidentally laundering trust by appearing
 * to author content it merely served.
 *
 * @typedef {object} CachedEnvelope
 * @property {true} _cached
 * @property {string} _cache_note  Human-readable narration; branches on `ToolDef.side_effects` and on same-vs-cross-request.
 */

/**
 * Tool was invoked but exceeded a soft budget while a hard wall remains.
 * The loop returns a structured "in-flight; try again" envelope; the
 * tool's pipeline continues running in the background. The next call with
 * the same args is likely a cache hit because the in-flight pipeline tends
 * to populate the cache by the time the model retries.
 *
 * Distinct from `RefusedEnvelope` (which says don't retry) and
 * `CachedEnvelope` (which says you already got the answer).
 *
 * **No current emitter.** Documented here as the contract per design
 * lines 172-176 so future soft-budget work has a named shape to land
 * against. Discriminator chosen to match the existing `_refused`/`_cached`
 * convention: `_partial: true`. Centralizing the un-emitted shape is the
 * whole point of this module — see module header.
 *
 * @typedef {object} PartialEnvelope
 * @property {true} _partial
 * @property {string} retry_hint
 * @property {number} soft_budget_ms
 * @property {number} hard_wall_ms
 */

/**
 * Union over the four loop-authored envelope shapes the loop body
 * produces. Discrimination is flag-presence-based:
 *
 *  - `_refused: true` → `RefusedEnvelope`
 *  - `_cached: true`  → `CachedEnvelope`
 *  - `_partial: true` → `PartialEnvelope` (no current emitter)
 *  - none of the above → `SuccessEnvelope` (raw tool return)
 *
 * Tool-authored failure shapes (e.g. `{error: "indexer_not_ready"}`) are
 * carried inside `SuccessEnvelope` — the tool ran; the loop wraps its
 * return unchanged. The presence of `error` does NOT discriminate to
 * `RefusedEnvelope`; only `_refused: true` does.
 *
 * @typedef {SuccessEnvelope | RefusedEnvelope | CachedEnvelope | PartialEnvelope} EnvelopeShape
 */

/* -------------------------------------------------------------------------- */
/* Loop state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Module-level state owned by a single loop instance. A user-driven chat
 * session is one loop instance; a test runner is another; a sub-agent is
 * a child loop instance with its own configuration but the same contract.
 *
 * The constants `NO_PROGRESS_LIMIT`, `HARD_CAP`, `DUP_REFUSE_THRESHOLD`
 * live at the top of `./tool-loop-core.js`. They are NOT re-declared
 * here — keeping them at the loop-body site keeps this module pure
 * documentation and avoids an import-shuffle behavior change.
 *
 * @typedef {object} LoopState
 * @property {number} noProgressStreak     Rounds in a row with no successful tool invocation and no drained input. Reset on progress.
 * @property {number} roundCount           Monotonic round counter; `HARD_CAP` terminates.
 * @property {Map<string, number>} duplicateStreak  Per-`callKeyHash` consecutive-identical counter.
 * @property {Map<string, object>} toolCallCache    Same-request LRU; key = `callKeyHash`.
 * @property {Array<object>} toolActionLog          Cross-request action log; bounded ~50 entries.
 * @property {Array<object>} [queuedInputFIFO]      User input typed during the previous round; drained at iteration boundary.
 * @property {Promise<object>|null} [userPausePromise]  Slot held while a user-pause tool awaits external resolution.
 */

/* -------------------------------------------------------------------------- */
/* Cache coordination                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Result of a cache lookup against the two caches the loop owns. The
 * loop performs two sequential lookups today — first the same-request
 * `toolCallCache.get(cacheKey)` (returns payload or `undefined`), then
 * the cross-request action-log scan via `findMatchingCrossRequestEntry`
 * (returns an action-log entry or `undefined`). A defined return =
 * cache hit; the loop wraps it into a `CachedEnvelope`. An `undefined`
 * return = cache miss; the loop falls through to live tool execution.
 *
 * Per design §"Cache Coordination" — both caches are walked on the same
 * mutation event (a file write invalidates cached reads of that path in
 * the same logical operation; the canonical deadlock pattern of
 * gitea#301 was exactly the bug of invalidating only one cache).
 *
 * Not currently a unified runtime type — the two lookups have different
 * return shapes (the same-request cache returns the raw payload; the
 * cross-request log returns an action-log entry with metadata). Named
 * here as a contract concept; a future refactor that lifts the lookups
 * into a single `lookupCache(toolName, args): CacheResult` helper would
 * be the place to formalize the shape below.
 *
 * @typedef {object} CacheResult
 * @property {boolean} hit
 * @property {'same-request'|'cross-request'|null} source
 * @property {object} [payload]
 * @property {string} [cacheNote]
 * @property {string} [originalToolId]  Original invocation id for trust-label retention.
 */

/* -------------------------------------------------------------------------- */
/* Dup-streak policy                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Configuration for the duplicate-streak guard. The guard counts
 * consecutive identical `(tool_name, sorted_args)` invocations and fires
 * a `RefusedEnvelope` once `threshold` is reached without intervening
 * progress.
 *
 * `callKeyHash` matches the existing hash composition at
 * `tool-loop-core.js:333` — `toolName + '|' + canonicalArgsKey(args)`.
 *
 * `intervening_progress_resets`: a different tool call, a drained user
 * input, or any other forward progress (per design §"Forward progress")
 * resets the streak to zero. Without this, the guard fires too early on
 * legitimate retry patterns.
 *
 * @typedef {object} DupStreakPolicy
 * @property {number} threshold                       e.g. `DUP_REFUSE_THRESHOLD = 3` in `./tool-loop-core.js`.
 * @property {(toolName: string, args: object) => string} callKeyHash
 * @property {boolean} intervening_progress_resets
 */

// JSDoc-only module; no runtime exports.
export {};
