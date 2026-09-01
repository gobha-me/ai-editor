// @ts-check
/**
 * Compression contracts — the typedef surface for the conversation-history
 * compaction subsystem. Phase 1 (1.2.0) implements Rules 1 (Subsumption) and
 * 2 (Invalidation); the remaining rules (3 Consumption, 4 Resolution, 5
 * Summarization) land in 1.2.x.
 *
 * Sources:
 *   - `docs/DESIGN-compression.md` §"Core Contracts"
 *   - `docs/DESIGN-compression.md` §"The Five Rules"
 *   - `docs/DESIGN-compression.md` §"Pipeline Algorithm"
 *
 * Why JSDoc and not real TS: project constraint
 * (`docs/ARCHITECTURE.md` §"Design Constraints") — no build step, no
 * transpiler. Type safety comes via `jsconfig.json` `checkJs: true`.
 *
 * @module intelligence/compression/contracts
 */

/**
 * Canonical role values for a Turn. Distinct from the existing
 * `ChatMessage.role` ('user'|'assistant'|'tool'|'system'|'error') —
 * `tool_call` and `tool_result` are split per DESIGN-compression.md §"Core
 * Contracts" so rules can address them separately. The mapping from
 * ChatMessage to Turn is in `turn-store.js`.
 *
 * @typedef {"user"|"assistant"|"tool_call"|"tool_result"|"system"} TurnRole
 */

/**
 * Stable identifier for a chat turn. Phase 1 uses a per-call sequence
 * (`T0`, `T1`, ...) derived at Compactor entry — diagnostics are scoped to
 * a single `compress()` invocation so cross-call stability is not yet
 * required. The hash form `hash(session_id || sequence_number ||
 * timestamp_ms)` from DESIGN-compression.md §"Turn Identity and Stability"
 * lands when the turn store gets persisted.
 *
 * @typedef {string} TurnID
 */

/**
 * One file operation extracted from a tool result. Mirrors the shape
 * already produced by `js/chat/turn-enrich.js` (1.1.0 Foundations) so
 * Compression Phase 1 consumes the field directly without conversion.
 *
 * @typedef {Object} FileOp
 * @property {string}                          path
 * @property {"read"|"write"|"edit"}           op
 * @property {[number, number]|null}           range          Line range; required for read/edit per DESIGN.
 * @property {string|null}                     content_hash   For write/edit, hash of the resulting file (Phase 2+).
 */

/**
 * Per-turn metadata. Optional fields are only populated where applicable
 * (e.g. `file_ops` only on tool_result turns; `tool_args` only on tool_call
 * turns). Empty values (`[]`, `{}`) are valid presence indicators.
 *
 * @typedef {Object} TurnMetadata
 * @property {string}              [tool_name]       Set on tool_call and tool_result turns.
 * @property {Object}              [tool_args]       Parsed tool arguments (tool_call turns).
 * @property {TurnID|null}         [tool_result_for] Backref tool_result → tool_call. Per DESIGN, enables Rule 3 (Consumption).
 * @property {string|null}         [tool_call_id]    Provider-supplied tool call id (preserved from existing ChatMessage shape).
 * @property {FileOp[]}            [file_ops]        File operations performed by this turn. Empty `[]` = no file ops.
 * @property {boolean}             [has_tool_calls]  True when an assistant turn carries `tool_calls[]` (paired with subsequent tool_result turns).
 * @property {string[]}            [tool_call_ids]   Provider tool_call ids on an assistant turn. Used by Compactor's tool-pair coherence pass to match dropped tool_results back to their caller.
 * @property {TurnID[]}            [superseded_by]   Caller-supplied causal supersession (escape hatch per DESIGN §Rule 1 edge cases).
 * @property {number}              [source_index]    Position of the originating ChatMessage in the input array (Phase 1 round-trip aid).
 * @property {Object}              [custom]          Opaque library-passthrough field per DESIGN.
 */

/**
 * The atomic unit of compression analysis. One Turn per ChatMessage.
 *
 * @typedef {Object} Turn
 * @property {TurnID}        id
 * @property {TurnRole}      role
 * @property {*}             content       Raw ChatMessage content; may be string, object, or null.
 * @property {number}        tokens        Cheap `chars/3.5` estimate per `tokens.js`.
 * @property {number}        timestamp     Epoch milliseconds. Falls back to insertion order when absent on the source.
 * @property {TurnMetadata}  metadata
 */

/**
 * Decision returned by a `CompressionRule.evaluate()` call. The Compactor
 * uses the discriminator `kind` to dispatch.
 *
 * @typedef {Object} KeepDecision
 * @property {"keep"}  kind
 *
 * @typedef {Object} DropDecision
 * @property {"drop"}  kind
 * @property {string}  reason   e.g. `"subsumed_by:T7"`, `"invalidated_by:T12"`.
 *
 * @typedef {Object} ReplaceDecision
 * @property {"replace"}  kind
 * @property {string}     marker   Synthesized turn content (Rule 4 templated marker).
 * @property {string}     reason
 *
 * @typedef {Object} SummarizeDecision
 * @property {"summarize"}  kind
 * @property {string}       reason   Hint to the Rule 5 fallback; not an immediate action.
 *
 * @typedef {KeepDecision|DropDecision|ReplaceDecision|SummarizeDecision} Decision
 */

/**
 * One compression rule. The Compactor evaluates rules in `priority` order
 * (lower runs first); the first non-Keep decision wins per DESIGN
 * §"Pipeline Algorithm".
 *
 * Rules are pure: same `(turn, history)` input always yields the same
 * `Decision`. Side effects belong in the Compactor, not the rules.
 *
 * @typedef {Object} CompressionRule
 * @property {string}    name        e.g. "subsumption" | "invalidation" | "summarization".
 * @property {number}    priority    Lower runs first.
 * @property {boolean}   [is_summarizer]   True for Rule 5 — Compactor skips it in the per-turn pass.
 * @property {(turn: Turn, history: Turn[]) => Decision}  evaluate
 */

/**
 * Optional caller-supplied Rule-5 fallback. Receives the oldest contiguous
 * span of Keep-decision turns whose summarization would bring history
 * under budget; returns a single synthesized `Turn` (role: "system") to
 * replace the span. May be async.
 *
 * `rules/summarization.js` wraps the existing
 * `js/chat/summarizer.js` so users not yet hitting eviction patterns see
 * no behavior change.
 *
 * @typedef {(span: Turn[]) => (Turn|Promise<Turn>)} SummarizerFn
 */

/**
 * Input to `Compactor.compress()`.
 *
 * @typedef {Object} CompressionRequest
 * @property {Turn[]}            history           Source turns (chronological).
 * @property {number}            budget_tokens     Target ceiling for compressed history.
 * @property {CompressionRule[]} rules             Profile-supplied; Compactor sorts by priority.
 * @property {SummarizerFn|null} [summarizer]      Optional Rule-5 fallback.
 * @property {number}            preserve_recent   Last N turns never evicted (hard invariant).
 */

/**
 * One TurnID range that was summarized away by Rule 5.
 *
 * @typedef {Object} SummarizedSpan
 * @property {TurnID}  first_id
 * @property {TurnID}  last_id
 * @property {number}  span_length
 * @property {number}  latency_ms
 */

/**
 * Diagnostics emitted by every `Compactor.compress()` call. Cheap to
 * populate and surfaced in the LLM debug modal. `rules_skipped` distinguishes
 * "no rule applied" from "rule skipped because metadata absent."
 *
 * @typedef {Object} Diagnostics
 * @property {string[]}                          rules_run             Rule names that were evaluated.
 * @property {Array<{rule: string, reason: string, count: number}>}  rules_skipped   Rules that no-op'd because metadata was absent (or other reason).
 * @property {Object<string, Object<string, number>>} decisions_by_rule    `{ ruleName: { keep: N, drop: N, replace: N, summarize: N } }`.
 * @property {Array<{id: TurnID, rule: string, reason: string}>}     evicted_ids
 * @property {Array<{id: TurnID, rule: string, reason: string, marker: string}>}  replaced_ids
 * @property {SummarizedSpan[]}                  summarized_spans
 * @property {number}                            tokens_in
 * @property {number}                            tokens_out
 * @property {number}                            compression_ratio     `tokens_out / tokens_in`. 1.0 means nothing was compressed.
 * @property {string[]}                          warnings              Free-form structured warnings.
 * @property {Array<{rule: string, error: string}>}  rule_errors       Exceptions thrown by rules (rule defaulted to Keep).
 * @property {Object<string, number>}            latency_per_rule_ms
 * @property {number}                            summarizer_latency_ms 0 if Rule 5 did not fire.
 */

/**
 * Output from `Compactor.compress()`.
 *
 * @typedef {Object} CompressionResult
 * @property {Turn[]}      history          Compressed; may include synthesized `system`-role marker turns from Rule 4.
 * @property {Diagnostics} diagnostics
 * @property {TurnID[]}    evicted_ids      Convenience flat list (also present in `diagnostics.evicted_ids`).
 * @property {TurnID[]}    surviving_ids
 * @property {SummarizedSpan[]}  summarized_spans
 */

// Module exports nothing at runtime — this file is typedefs only.
// Re-exported via `index.js` so consumers can `import('./contracts.js')`.
export {};
