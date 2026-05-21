# DESIGN — Agent Loop: The Consumer Surface

**Status:** Draft
**Sibling architectural surfaces:** `DESIGN-intelligence.md` (umbrella over the four admission subsystems), `DESIGN-profiles.md` (per-surface adapter contract above the four).
**Sibling subsystems referenced:** `DESIGN-tools.md` (catalog + admission), `DESIGN-compression.md` (turns owned and evicted), `DESIGN-retrieval.md` (cache-coordination patterns), `DESIGN-memory.md` (single-writer / per-key RMW pattern).

---

## Problem

The architecture defined by `DESIGN-intelligence.md` covers four admission subsystems (retrieval, memory, compression, tools) and one configuration surface above them (profiles). It does not name the surface that runs *between* "the LLM emits a tool call" and "the resulting turn is admitted on the next round."

That surface exists. Every implementation of this architecture has one. It runs the loop: emit prompt, receive LLM response, execute tool calls, wrap each result in an envelope, append envelope-bearing turns to the conversation buffer, decide whether to continue or terminate, drain any queued user input, repeat. It owns module-level state — caches, dup-streak counters, queued-input FIFOs, pause-Promise slots — that no admission subsystem owns or wants to own.

When this surface is not architecturally named, it accumulates contracts in implementation files. Bugs live at the seams between those contracts because no one owns the seams. The canonical instance is a stale-read / write-tool deadlock pattern observed in production: a tool's own staleness guard (refusing edits when the file has changed since last read) fires correctly; the loop's cross-request duplicate envelope (refusing identical re-reads after a recent identical call) fires correctly; and they deadlock — the loop refuses the re-read needed to defeat the staleness guard, and the staleness guard refuses the edit until the re-read happens. Both contracts are individually correct. The bug exists at the unnamed seam between them.

Naming the seam is not new design. The contracts already exist. The architecture admitting they exist makes them debuggable in the same way the four admission subsystems' contracts are debuggable: by reference to a written rule rather than by archaeology against implementation.

---

## The Load-Bearing Distinction: Admission vs. Consumption

The four subsystems in `DESIGN-intelligence.md` are *admission surfaces*. Each one decides what content enters the prompt: retrieval admits chunks, memory admits curated facts, compression admits surviving turns, tools admits callable definitions. The umbrella's commitment to "four subsystems, no more, no less" is a commitment about admission specifically.

The agent loop is a *consumer surface*. It runs after the prompt is assembled. It executes the LLM call, executes the tool calls in the LLM's response, constructs the envelope-bearing turns those calls produce, and decides when the cycle ends. It does not admit content into the prompt — that is done by the subsystems on the *next* round. It is downstream of admission, not parallel to it.

This is why naming the agent loop does not violate the four-subsystem commitment. The architecture has always been four admission subsystems plus surfaces above and below them. Profiles (the surface above) are documented; the agent loop (the surface below) was not. Both are architectural; neither is a subsystem.

The full architecture, named:

```
                    Profile (per-surface adapter)
                           │
                           ▼
   ┌──────────┬──────────┬────────────┬─────────┐
   │ Retrieval│  Memory  │ Compression│  Tools  │  ← admission subsystems
   └──────────┴──────────┴────────────┴─────────┘
                           │
                           ▼
                    Agent Loop (consumer)
                           │
                           ▼
                          LLM
```

The loop is below the subsystems because it consumes their output. It is above the LLM because it orchestrates the call. Its turns flow back up into the subsystems on the next round.

---

## Goals

- **Name the unowned seams.** Cache coordination across same-request and cross-request boundaries; envelope construction; user-pause; queued input; loop termination. These all sit at the agent-loop layer and need an architectural home.
- **Make envelope authorship explicit.** Distinguish loop-authored envelopes (synthesized by the loop based on loop state) from tool-authored failure shapes (returned by tools from their own logic). Different ownership; different contracts.
- **Make sub-agent inheritance possible.** A bounded child loop with its own configuration must inherit a single, named contract.
- **Bound the loop's failure modes.** Model loops indefinitely; refused-streak fires too early; queued input gets killed by a no-progress timer; mutating-tool retry causes double-commit; cross-request envelope contradicts in-flight tool guard. Each gets a guard or a documented behavior.

## Non-Goals

- **Tool-internal failure semantics.** A tool returning `{error: "indexer_not_ready"}` from its own readiness check is the tool's own contract; the loop's envelope passes it through unchanged. Documented at the tool, not here.
- **Native LLM-API tool-call protocols.** Wire formats (OpenAI-style, Anthropic-style, MCP) are surface-layer concerns. The loop assumes some protocol exists; the contracts here are shape-of-loop, not shape-of-wire.
- **Prompt admission.** Content selection for the next prompt is `DESIGN-retrieval.md`, `DESIGN-memory.md`, `DESIGN-compression.md`, `DESIGN-tools.md`. The agent loop produces the conversation history those subsystems read; it does not decide what they admit.
- **Surface-specific UX.** Whether queued input renders in a side panel, whether the user-pause card is modal, what the refusal toast says — `DESIGN-profiles.md` and the surface itself.
- **A unified loop runtime.** Implementations differ. The contracts here describe shape, not API.

---

## The Authorship Rule

The boundary between this surface and the Tools subsystem is testable per-field:

> **If the envelope field is set by the tool, based on the tool's own state, it's a Tools concern. If the envelope field is set by the loop, based on loop state, it's an agent-loop concern.**

Loop state means: caches the loop owns, dup-streak counters the loop maintains, queued input the loop has accepted, pause-Promise slots the loop is awaiting, the side-effects classification the loop reads from `ToolDef`. Tool state means: the tool's own preconditions, its own internal data, its own resource limits, its own error conditions surfaced from the operation it performed.

The rule classifies every borderline case the same way two readers would. A worked classification:

| Field / behavior | Set by | Owner |
|---|---|---|
| `_refused: true` (duplicate-streak detected; tool was *not* invoked) | Loop, after counting consecutive identical calls | Agent loop |
| `_cached: true` (same-request LRU hit; tool was *not* invoked) | Loop, on cache lookup | Agent loop |
| `_cache_note` (mutating-tool cache hit narration) | Loop, branching on `ToolDef.side_effects` | Agent loop |
| `next_action_hint` extension to `_refused` envelope | Loop concatenates from a per-tool registry | Agent loop |
| `error: "indexer_not_ready"` (tool's own readiness check) | Tool returns from its precondition logic | Tools |
| `error: "retrieval_partial"` (tool's own soft-budget timer) | Tool returns when its budget expires | Tools |
| Stale-line content window in error payload | Tool's own drift detection populates it | Tools |
| `pendingUserResponse` Promise resolution | Tool returns the Promise; loop awaits and times-out-bypasses | **Both, at different levels.** Loop owns the seam (Promises pause the loop, bypass standard timeout); Tools owns specific tools that fill the seam |
| Cache-key composition and stateful-read bypass | Loop composes the key, decides to bypass | Agent loop (with `ToolDef.side_effects` consumed as input) |
| Cross-request action log invalidation on file mutation | Loop walks the log on mutation events | Agent loop |
| `noProgressStreak` increment / `HARD_CAP` termination | Loop counts and terminates | Agent loop |

The rule is the test. Apply it to any new contract; the answer falls out.

---

## Two Categories of Envelope

Every tool call produces a result that lands in the conversation buffer as a turn. The shape of that result depends on whether the tool actually ran:

**Tool-authored envelopes** are returned by the tool from its own logic. The tool ran. It performed (or attempted) its operation and returned a structured result describing the outcome — including structured failure shapes for cases the tool itself recognized (precondition not met, soft budget exceeded, internal staleness detected). These pass through the agent loop into the conversation buffer unchanged. The loop wraps them in its `success` envelope (it ran; here is what it returned) without mutating the contents.

**Loop-authored envelopes** are synthesized by the loop *instead of* invoking the tool. The tool did not run. The loop intercepted the call — because of a duplicate streak, a cache hit, a soft-budget overrun, a refusal policy — and produced a synthetic result that tells the model what happened. These shapes are loop concerns. The loop names them, the loop decides when they fire, and the loop owns the failure mode they prevent.

This split is not pedantic. It is the load-bearing distinction the architecture was missing. The canonical deadlock pattern — staleness guard plus cross-request dup envelope — is exactly a tool-authored envelope (the tool ran and refused) interacting with a loop-authored envelope (the loop refused on the loop's behalf). Both individually correct. The seam between them is the bug. Naming the seam requires distinguishing the two categories.

---

## Atomic Units

Three atomic units belong to the agent loop:

**Tool-result envelope.** A loop-authored shape that wraps a tool call's outcome before it becomes a turn. Required fields vary by shape (see *Envelope Shapes* below). Every tool invocation produces exactly one envelope; the envelope is what the model sees as the result. This is the unit other surfaces reference when they need to talk about "what happened during a tool call."

**Iteration round.** One full pass: drain queued user input, check forward-progress, emit prompt, receive LLM response, execute any tool calls, wrap results in envelopes, append envelope-bearing turns. A round either continues to the next round or terminates. Diagnostics are emitted per-round.

**Loop instance.** A single execution context for the loop: its conversation buffer, its caches, its queued-input FIFO, its pause-Promise slots, its termination configuration. A user-driven chat session is one loop instance. A test-driven runner is another. A sub-agent is a child loop instance with its own configuration but the same contract. The loop instance is what sub-agents inherit.

The loop never owns admission rules over chunks, memory records, tool definitions, or turns; those belong to the four subsystems. It owns admission rules over its *own* atomic units (which envelope shape fires, when a round terminates, when input drains).

---

## Loop Iteration Contract

A round, in order:

1. **Drain queued input.** If the user typed input during the previous round (`Queued-Input Drain` below), drain the FIFO into the conversation buffer as user turns. The drain happens *before* the forward-progress check so a stalling model does not get terminated immediately before seeing input the user already typed.
2. **Forward-progress check.** If `noProgressStreak >= NO_PROGRESS_LIMIT` and no input was just drained, terminate with reason `no_progress`. If `roundCount >= HARD_CAP`, terminate with reason `max_iterations`. If a user-supplied wall-clock timeout has expired, terminate with reason `wall_clock`.
3. **Assemble prompt.** Profile assembles per the four subsystems' admission contracts. The agent loop is a consumer here, not a participant.
4. **Emit prompt; receive LLM response.** The wire-level concern (streaming, idle timeout, transient retry) is implementation-specific but the loop owns the configuration: idle timeout, transient-retry-once on round 0, cancel handling.
5. **Execute tool calls.** For each tool call in the response: check caches (same-request LRU, then cross-request action log), check refusal policy (duplicate-streak), check user-pause seam (tool returns Promise), invoke the tool with a per-call timeout, wrap the result in an envelope.
6. **Append turns.** The assistant turn (carrying the LLM's tool calls) and each tool-result turn (carrying its envelope) are appended atomically per the tool-call-pair atomicity rule (`DESIGN-compression.md`). A round never produces an orphan tool turn or an unmatched assistant-with-tool-calls.
7. **Update progress state.** Increment `noProgressStreak` if the round produced no successful tool invocation and no drained input. Reset to zero otherwise.
8. **Continue or terminate.** If the LLM response had no tool calls (terminal response), terminate with reason `complete`. If a tool returned a cancel signal, terminate with reason `user_cancel`. Otherwise loop to step 1.

**Forward progress** is defined as: a successful tool invocation that produced a non-refusal, non-cache envelope, OR a queued-input drain that introduced a new user turn. A round of all-cache-hits or all-refusals is *not* progress. A round whose LLM response was an idle terminal answer is not progress, but the round itself terminates the loop so the question is moot.

**The transient-retry-once on round 0** (a recoverable provider error on the very first round of a fresh session retries once with a clean state) is implementation-specific robustness, not architectural. Mentioned here so implementers know the contract permits it; not part of the load-bearing surface.

---

## Envelope Shapes

Four loop-authored envelope shapes:

### `success(payload)`

The tool was invoked and returned. The payload is exactly what the tool returned, including any tool-authored failure shapes the tool produced from its own logic. The loop does not interpret or modify the payload. The envelope-bearing turn carries the trust label of the tool's content per `DESIGN-intelligence.md` §"Trust Labels on Admitted Content."

### `refused(reason, next_action_hint)`

The tool was *not* invoked. The loop intercepted the call because the same `(tool_name, sorted_args)` has been issued `DUP_REFUSE_THRESHOLD` consecutive times without intervening progress. The model is in a duplicate streak.

The `reason` is the loop's diagnostic (e.g., `"called N consecutive times with identical args"`). The `next_action_hint` is a per-tool guidance string that tells the model what to try instead. Per-tool because the right hint depends on the tool: a CI-status tool's hint might point at creating a PR; an edit tool's hint might point at re-reading the file. The hint table is keyed by tool name; entries cover loop-prone tools surfaced by real usage. A generic fallback exists for tools without a specific entry. The hint is concatenated into the `error` string the LLM reads; cheap-tier models reliably pick up the recovery path when the hint is specific.

The `_refused: true` flag is a structured field for tool-loop instrumentation and debug surfaces; the human-readable recovery information is in the error string.

### `cached(payload, cache_note)`

The tool was *not* invoked. The loop served a memoized prior result. Two sub-cases:

- **Same-request LRU hit.** Identical `(tool_name, sorted_args)` already executed this round; serve the prior result without re-invocation. Prevents redundant work within a round (especially when the LLM emits the same call multiple times in one response).
- **Cross-request action-log hit.** Identical call was logged in a recent round; the loop serves the action-log entry as cached. Prevents the model from re-issuing recent calls just to confirm what it already did.

The `cache_note` is wording that branches on `ToolDef.side_effects`:

- For `read_only` tools: *"The prior result is still valid; no need to re-invoke."* Read tools cache cleanly.
- For `mutating` tools: *"Your prior {tool} call already succeeded — the mutation has happened; do not retry to confirm."* Mutating tools are cached *to prevent unintended re-invocation* (double-commits, double-comments). The narration's job is to tell the model the side effect happened so the model does not interpret the cache hit as a failure.

The `_cached: true` flag is structured. The note is in the human-readable message.

**Trust label retention on cache hits.** A cache-served envelope retains the trust label of the *original* tool invocation, not the cache's. The cached payload was authored by the tool when it originally ran; serving it now does not re-author it. The envelope-bearing Turn that wraps a cache hit therefore carries `authority: tool, authority_id: <tool_id>` and the trust tier from the original ToolDef admission, with `derivation` pointing at the original invocation's label. This is the umbrella's commitment per `DESIGN-intelligence.md` §"Trust Labels on Admitted Content" applied to the cache; it prevents the cache layer from accidentally laundering trust by appearing to author content it merely served.

### `partial(payload, retry_hint, soft_budget_ms, hard_wall_ms)`

The tool was invoked but exceeded a soft budget while a hard wall remains. The loop returns a structured "in-flight; try again" envelope; the tool's pipeline continues running in the background. The next call with the same args is likely a cache hit because the in-flight pipeline tends to populate the cache by the time the model retries.

The `retry_hint` tells the model the call is incomplete but not failed; the model should re-issue. The `soft_budget_ms` and `hard_wall_ms` give the model context for whether to wait or proceed differently. Distinct from `refused` (which says don't retry) and `cached` (which says you already got the answer).

### Tool-authored failure shapes (not envelopes per se)

Tool-authored shapes — `{error: "indexer_not_ready", coverage: 0.06}`, `{error: "retrieval_partial", elapsed_ms: 28000}`, stale-line errors with content windows — pass through the loop in the `success(payload)` envelope. They are the tool's own return value, not the loop's. The four envelope shapes above are exhaustive at the *loop's* level; tool-authored variation lives below. Tool-authored failure shapes are subject to the contract in `DESIGN-tools.md` §"Tool-authored failure shape contract."

---

## Cache Coordination

The agent loop maintains two caches, both keyed on `(tool_name, sorted_args)` with optional bypass for stateful reads:

**Same-request LRU.** Per-round (or per-round-cluster if rounds are tightly coupled) memo of tool returns. Bounded; LRU eviction. Serves identical re-invocations within a round without re-running the tool. Skipped for tools whose `side_effects` is `mutating` and whose `cache_key_axes` (see below) declares the call non-idempotent — a mutating tool re-invoked with identical args is a possible double-commit and the loop must intercept differently (refusal or cache, not skip).

**Cross-request action log.** A bounded persistent record of recent tool invocations and their results, surviving across rounds. Two roles: (a) serves cached envelopes for redundant re-invocations across rounds (e.g., the model reads a file, the loop summarizes context, the model re-reads the file out of habit), and (b) provides the audit trail upstream orchestrators read for progress detection per `DESIGN-profiles.md`'s TaskLedger contract.

**The invalidation contract.** When a tool execution mutates the underlying domain a cached read pertains to (a file write invalidates cached reads of that file's path; a configuration change invalidates cached reads of that configuration), the loop walks *both* caches in one pass and evicts entries whose key matches the mutated domain. This is the contract the canonical deadlock revealed: invalidating only one cache leaves the other holding pre-mutation reads forever, and the model's recovery path (re-read the file to defeat the staleness guard) is refused by the un-invalidated cache. Both walks must happen on the same mutation event, in the same logical operation.

The mutation events the walk responds to are tool-driven (a file-write tool fires; the walk runs after the write succeeds). The walk itself is loop-side. The relationship between the tool's `side_effects` classification and the walk's invalidation domain is derived: tools whose `side_effects` is `mutating` *and* whose effect domain is something cached reads pertain to (files, configurations, indexed content) trigger the walk. A mutating tool whose effects are externally-scoped (posting a comment, sending an email) does not trigger cache invalidation because no cached reads pertain to its domain.

The walk preserves write-tool log entries (those are informational history the orchestrator reads); only stale-read entries are evicted.

---

## Cache-Key Composition + Stateful Reads

Caches are keyed on the inputs the model passed (`tool_name` plus sorted arguments). This works for tools whose result is a function of args alone. It fails for tools whose result depends on hidden state not in args.

A tool that reads "the current file" without naming the path explicitly produces results dependent on runtime state (`State.currentFile.path`) that the cache key does not capture. Two consecutive calls with identical args (`{full: true}`) but different active files collide on the same cache key — the second call returns the previous file's content as a cache hit.

The contract: tools whose result depends on state outside args must be excluded from caching. Today this is loop-side classification (`STATEFUL_READ_TOOLS`-style set membership). The loop bypasses both caches for these tools; stateful reads always re-execute against live state.

**Open question — `cache_key_axes` on `ToolDef`.** A natural extension is to put the bypass axis on the tool definition itself: `cache_key_axes: ["args"]` (default) or `cache_key_axes: ["args", "current_file"]` (declares the tool reads `State.currentFile`). The argument for moving the axis to Tools: the tool knows what state it reads; the tool's author should declare it. The argument for keeping it on the loop: whether to *bypass caching* on that signal is loop policy, not tool description, and the loop may decide differently in different loop instances (e.g., a sub-agent with no shared state may safely cache a tool the parent loop bypasses). Held as an Open Question; the current loop-side classification works.

---

## User-Pause Seam

Some tools cannot complete autonomously. They require external resolution: a user answer, an approval, a manual action. The loop supports this through a seam:

> **A tool may return a Promise that pauses the loop awaiting external resolution. The loop bypasses the standard tool-execution timeout for these tools. The cancel path settles the Promise so cancellation does not leak unsettled handlers.**

The seam itself is generic: the loop maintains a slot (or slots) for awaitable resolutions; tools that fill the seam return a Promise from their handler; the loop awaits; the resolution path settles the Promise with a structured envelope (typically a user-input payload or an approval/rejection result).

Specific tools that fill the seam — an "ask user a question" tool, a "submit plan for approval" tool, an "approve this destructive action" tool — live in the Tools subsystem with their own admission rules. Their tool definitions live there. What the loop owns is the seam contract: the timeout bypass, the cancel-path settlement, the membership criterion (which tools are user-pause tools — currently a loop-side set; could move to a `ToolDef.user_pause: bool` field).

The seam composes with the catalog filter contract: a profile that admits a user-pause tool gets its loop pause behavior automatically; a profile that does not admit such tools never sees the seam fire.

---

## Queued-Input Drain

Long-running rounds can occupy the loop while the user types input. Without a queue, that input either (a) gets typed but lost (worst case), (b) interrupts the in-flight round (also bad), or (c) waits until the round terminates and the user has to re-type. None of these is acceptable.

The contract:

- **A bounded FIFO** stores user input arriving mid-run. Bound is small (single-digit). On overflow, oldest is dropped.
- **The drain happens at iteration boundaries**, between rounds, never mid-round. Specifically, it happens at step 1 of the loop iteration contract, *before* the forward-progress check.
- **Drained input counts as forward progress** for the purposes of the no-progress check: a round that drained input does not increment `noProgressStreak` even if the model produced no tool calls. This is what prevents a stalling model from being killed before it sees the queued input.
- **The queue survives cancellation.** A user who cancels a long round and re-runs gets their queued input on the next round; it is not silently dropped on cancel.

The queue's bound and drain ordering are the load-bearing parts. The bound prevents unbounded memory; the ordering prevents the queue from being killed by the no-progress check before the model gets to see it. Without explicit ordering, this contract has been implemented backwards in independent attempts ("check no-progress first, then drain") and produced exactly the failure mode the contract exists to prevent.

---

## Sub-Agent Inheritance

A sub-agent is a bounded child loop instance. It has its own conversation buffer, its own caches, its own queued-input FIFO, its own configuration (HARD_CAP, NO_PROGRESS_LIMIT, DUP_REFUSE_THRESHOLD, MAX_QUEUE), its own filtered tool catalog (a subset of the parent's, possibly with stricter admission rules). It runs the same agent-loop contract — same authorship rule, same envelope shapes, same cache-coordination contract, same forward-progress definition.

The parent invokes a sub-agent through a tool. The tool definition (catalog entry: `spawn_agent({task, tool_filter, budget})` or similar) lives in the Tools subsystem. The sub-agent's *return* to the parent is a tool result wrapped in the parent's envelope construction — the parent loop sees the sub-agent's final answer the same way it sees any other tool result. There is no special envelope shape for sub-agents; they reuse `success(payload)`.

This is the load-bearing forward-looking commitment: sub-agents inherit through the agent-loop contract, not through the Tools subsystem. The Tools subsystem describes `spawn_agent` as a tool with inputs and a return shape; the loop contract describes how that return is wrapped and admitted. Configuration parameters that vary between parent and sub-agent (HARD_CAP, dup-refuse threshold, queue size) are loop-instance configuration — they live in the loop contract because they are loop concerns. Putting them on Tools would force Tools to grow per-loop-instance configuration, which Tools does not want.

The same inheritance applies to test-loop runners (autonomous loops that drive a task to a CI-pass termination), background runners, and scheduled invocations. All are bounded loop instances with the same contract; only their configuration differs.

---

## Failure Modes

| Failure | Behavior | Surfaced as |
|---|---|---|
| Model loops indefinitely on the same tool | `noProgressStreak >= NO_PROGRESS_LIMIT` terminates with reason `no_progress`; `HARD_CAP` is the last-resort terminator | Termination reason in loop diagnostics |
| Refused-streak fires too early on legitimate retry | `DUP_REFUSE_THRESHOLD` configurable per loop instance; intervening progress (different tool call, drained input) resets the streak | Streak counter exposed in diagnostics |
| Queued input dropped on cancel | Spec preserves queue across cancel; cancel only settles in-flight Promises | Queue length surfaced in diagnostics |
| Mutating-tool retry causes double-commit | Cross-request action log returns `cached` envelope with mutating-tool wording; tool is *not* re-invoked | Cache-hit count + side_effects in diagnostics |
| Cross-request envelope contradicts in-flight tool guard (canonical deadlock) | Cache-invalidation walk runs both caches in one pass on every mutation event | Eviction count in diagnostics |
| Stateful-read collides on cache key | Stateful-read bypass excludes the tool from both caches; tool always re-executes against live state | Bypass list in diagnostics |
| User-pause tool's Promise leaks on cancel | Cancel path settles all pending Promises with cancel envelopes before terminating | Settled-on-cancel count in diagnostics |
| Tool result payload exceeds turn-size limit | Loop truncates with marker; full payload retained in action log if relevant; truncation flagged on the envelope | Truncation flag + retained payload pointer |
| Idle timeout fires mid-tool-loop | Loop-level idle timeout (per-call, separate from the LLM streaming idle timeout); on overrun, the call returns a `partial` envelope | Per-call timeout in diagnostics |
| Provider returns a transient error on round 0 | Retry-once with a clean state; if still failing, terminate with reason `error` | Retry count in diagnostics |
| Profile-supplied tool catalog excludes user-pause tools while a paused tool is in flight | Profile-config error; surfaces at session start, not mid-round | Validation error |

There are no silent terminations and no silent envelope shapes. Every termination carries a reason; every envelope carries a structured flag.

---

## Diagnostics

Per-round, the loop emits:

- `round_index` — monotonic sequence number within the loop instance
- `prompt_tokens`, `completion_tokens`, `cached_tokens` — provider-reported usage
- `tool_calls_emitted` — count of tool calls in the LLM's response
- `tool_calls_invoked` — count actually invoked (excludes cache hits and refusals)
- `envelopes_by_shape` — `{success, refused, cached_lru, cached_log, partial}` counts
- `dup_streak_depth` — current streak length entering the round
- `cache_invalidations` — count of entries evicted on this round's mutation events
- `queued_input_drained` — count of user turns drained at round entry
- `pause_seam_pending` — boolean: did this round include a user-pause tool that has not yet resolved
- `forward_progress` — boolean: did this round count as forward progress
- `latency_ms` — round wall-clock

Per-loop-instance:

- `instance_id`, `parent_instance_id` (for sub-agents), `started_at`, `terminated_at`
- `termination_reason` — one of `complete`, `no_progress`, `max_iterations`, `wall_clock`, `user_cancel`, `error`
- `total_rounds`, `total_envelopes_by_shape`, `total_tool_invocations`
- `peak_dup_streak`, `peak_queued_input`

Both per-round and per-instance diagnostics are exportable as inert structured data per `DESIGN-intelligence.md` Rule 5. Falsifiable questions (*"how often does the dup-streak fire on cheap-tier models vs strong-anchor models?"* / *"what is the cache-hit rate on long-running tasks?"*) are answerable by exporting two runs and comparing them offline.

---

## Worked Example

The canonical deadlock pattern, traced through the loop contract:

**Setup.** Conversation buffer contains a recent successful read of a file at `path/to/X` and a recent successful edit on `path/to/X`. The model now needs to edit `path/to/X` again. The cross-request action log holds the prior read with key `(read_file, path: 'path/to/X')` and the prior edit's mutation event has not yet invalidated the read entry.

**Round N.** The LLM emits `edit_file(path: 'path/to/X', ...)`.

1. *Cache lookup.* No same-request hit; no cross-request hit on the edit args. Proceed to invocation.
2. *Tool invocation.* The tool runs its own staleness guard: file content has changed since the loop-recorded read (the prior edit changed it). Tool returns `{error: "STALE LINE NUMBERS", suggested_lines: [...], _staleWindow: <5/5 content slice>}`. This is a tool-authored failure shape.
3. *Envelope construction.* Loop wraps the return in `success(payload)` — the tool ran and returned its own structured failure. No loop-authored synthesis.
4. *Turn appended.* Conversation buffer now has the failed-edit turn.

**Round N+1.** The LLM, recognizing the staleness, emits `read_file(path: 'path/to/X')` to refresh.

1. *Cache lookup.* Cross-request action-log hit on `(read_file, path: 'path/to/X')` — the prior round's read is still in the log. **Without invalidation, the loop returns a `cached` envelope here, and the model receives the pre-mutation content as cached.** Then the model retries the edit on round N+2 against pre-mutation line numbers; the staleness guard fires again; same `cached` hit on round N+3; the loop is now in a deadlock between the staleness guard (correct: file mutated, must re-read) and the cross-request cache (incorrect: serving pre-mutation content as if it were current).

**Why the cache-invalidation contract resolves this.** The prior edit (the one that mutated the file) was a `mutating` tool whose effect domain is a file path. The cache-invalidation contract requires that the loop walk both caches on the mutation event and evict entries whose `args.path` matches. Done correctly, the cache entry for `(read_file, path: 'path/to/X')` is evicted *at the moment the edit succeeded*, not at the moment the staleness guard fires. Round N+1's lookup misses; the read re-executes; the model gets current content; the next edit succeeds.

The bug is not in either contract individually. The bug is in the coordination. Naming the loop as the owner of cache coordination — and writing the contract that both walks happen on the same mutation event, in the same logical operation — is what prevents the bug class. Implementations that follow the contract do not deadlock here. Implementations that don't, do.

---

## Open Questions

| Question | Why open | Resolution path |
|---|---|---|
| Whether `cache_key_axes` belongs on `ToolDef` | The tool knows what state it reads; the loop decides bypass policy. Both arguments are real. | Defer; revisit when sub-agent work surfaces a case where parent and child want different cache policies for the same tool |
| Whether per-round diagnostics aggregate or stream | Aggregating is simpler; streaming is better for observability of long-running loops | Implementation choice; both are compatible with the contract |
| Whether sub-agent budget enforcement interacts with parent's compression budget | A sub-agent's tool catalog and conversation are bounded; whether its prompt budget is independent or carved from the parent's is undecided | Defer to sub-agent design; the agent-loop contract permits both |
| Whether the user-pause membership belongs on `ToolDef` (`user_pause: bool`) or stays as a loop-side set | Same shape as the `cache_key_axes` question | Same answer: defer; revisit when a profile wants a tool to be user-pause in some contexts and not others |
| Whether `partial` envelopes should auto-retry transparently after a delay | Today the model retries explicitly; transparent retry would be lower-latency but hides loop behavior | Held; explicit retry preserves the model's awareness of the soft-budget event |
| Whether the loop should expose a structured "I am about to terminate, last chance" signal to the model | Could let the model emit a final summary before forced termination | Worth piloting; not load-bearing for the contract |

---

## What This Document Commits To

- **The agent loop is a consumer surface, not an admission subsystem.** It runs after admission. It does not violate the four-subsystem commitment; it sits below the four the way profiles sit above.
- **The Authorship Rule.** If the envelope field is set by the tool based on tool state, it's a Tools concern. If it's set by the loop based on loop state, it's an agent-loop concern. The rule is testable per-field and classifies every borderline case the same way.
- **Two categories of envelope.** Tool-authored failure shapes pass through the `success` envelope unchanged. Loop-authored envelopes (`refused`, `cached`, `partial`) are synthesized by the loop based on loop state, *instead of* invoking the tool.
- **Cache coordination is a loop responsibility.** Same-request LRU and cross-request action log are coordinated on every mutation event in one logical operation. The canonical deadlock pattern is the failure mode this contract prevents.
- **Stateful-read bypass.** Tools whose result depends on state outside args bypass caching entirely. The bypass classification is loop-side today; whether it migrates to `ToolDef.cache_key_axes` is an Open Question.
- **User-pause seam.** Tools may return Promises that pause the loop with timeout bypass and cancel-path settlement. The seam is loop-side; the tools that fill it live in the Tools subsystem.
- **Queued-input drain ordering is load-bearing.** Drain at iteration boundary, before the forward-progress check. Drained input counts as progress. Queue survives cancellation.
- **Sub-agent inheritance through the agent-loop contract.** Sub-agents are bounded child loop instances with their own configuration. They inherit the loop contract, not the Tools subsystem.
- **Per-round and per-instance diagnostics, exportable.** Falsifiability per `DESIGN-intelligence.md` Rule 5; comparison across runs is the test for whether contracts behave as designed.
- **Library, not service.** The agent loop is process-embedded; cross-process loop coordination is out of scope. Implementations may differ; the contracts here describe shape, not API.

These are the load-bearing decisions. Push back on any of them before building.
