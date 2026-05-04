# Long-Chat Stability — Investigation Findings

> Status: **draft** — one hypothesis confirmed via runtime + static
> trace, one via static trace, others pending. Built on top of the
> 1.5.9 release (2026-05-04) which fixed four adjacent tool-loop bugs;
> this doc surfaces what remained after those landed.
> Started: 2026-05-04 · Owner: Jeff (driving repros) + Claude (code trace, writeup).
> Reference: the LLM streaming + tool-call-loops reference doc shared 2026-05-04.

### Relationship to 1.5.9 (2026-05-04 release)

1.5.9 shipped four fixes for tool-loop and chat-history bugs surfaced
under issue #16:
1. `MAX_TOOL_ROUNDS=8` hard cap removed (replaced with no-progress
   streak + HARD_CAP=100).
2. Duplicate-tool refusal at N=3.
3. Empty assistant turns no longer persisted.
4. **The silent `slice(-100)` clamp on every `Storage.set('chatHistory', …)`
   site removed.** This was a separate data-loss path — it dropped
   messages from `State.chatHistory` itself on persistence, regardless of
   summarization.

The runtime export captured here was on **1.5.8** (Jeff forgot to
refresh to the new tag before testing). So fixes 1–4 above are not
reflected in the captured msgCount / round-latency figures. Our
hypothesis #0 (silent windowing in
[`getContextMessages()`](../../../js/chat/summarizer.js)) is a
**separate path** from any of the 1.5.9 fixes — it lives in the
context-rebuild step, not the persistence step — and remains real on
1.5.9 HEAD.

## Symptom

ai-editor is **currently unusable for long chats** — sessions either fall
apart with provider errors or enter death-spiral loops where the model
repeats tool calls, contradicts its own prior plan, or produces no
forward-progress output. This blocks Jeff from dogfooding ai-editor
against its own retrieval work landing on the 1.5.x track.

## Approach

1. Static code trace against the reference doc's checklist — where does
   ai-editor diverge from the safe pattern?
2. For each hot hypothesis, walk the code path. If a defect is provable
   without runtime data, mark **confirmed (static)**.
3. For hypotheses requiring runtime evidence, define the repro recipe and
   the artifact to capture.
4. Sized fix scope, slotted into the roadmap.

---

## Reproduction recipe

| Field | Value |
|---|---|
| Provider | Venice |
| Model | `minimax-m27` (also seen on `qwen-3-6-plus`) |
| Window | 198K tokens |
| Project context | xcaliber/ai-editor @ main, 428 files indexed |
| Tool admission | Legacy path, role `full`, 81 tools, 11305 tokens |
| Threshold settings | `RECENT_COUNT_TOOLS` ≈ 119, `SUMMARY_THRESHOLD` ≈ 198 (computed from 198K window × balanced fillPct ÷ AVG_TOKENS_PER_MSG, clamped at 200×scale) |
| Turn shape | 1 long user prompt then 5× "Please continue." |
| Symptom | Round latency grows from ~10 s early to 76 s, 118 s late; model starts re-reading files it already read; tool error at 16:26:40 (`read_lines end_line=360 on 358-line file`) consistent with lost positional state |

The session ran 9 minutes, ~95 messages, 0 provider 4xx errors, 0
summarization events, 1 tool error. **No catastrophic failure** — the
"falls apart" symptom in this run was gradual context loss, not a 400
loop. See *Captured artifacts* below.

### Captured artifacts (2026-05-04 16:18-16:27)

Full debug export held by Jeff (not committed — contains connection labels and balance lines we'd rather keep out of the public mirror). Cite by exchange `id` / `ts` in writeups instead.

Key log signals:

- **No `[ChatSummarizer] Pruned …` log anywhere.** Summarizer never
  fired; threshold of ~198 messages was never reached.
- **`[ChatSummarizer] Expanded context to include assistant+tool_calls
  at index 9` (turn 5)** and **`at index 29` (turn 6)** — the backward
  scan defense is firing at the recent-window boundary, doing its job.
- **Context message count by turn:** 1 → 23 → 46 → 66 → 76 → 75. Turn
  6 dropped vs turn 5: backward scan started further in
  (`index 29` vs `index 9`) so fewer history rows survived the window.
- **`msgCount` (request body size) per exchange across turn 5 sub-rounds:**
  77 → 80 → 82 → 84 → 86 → 88 → 90 → 92. Then turn 6 starts at 76
  — a **drop of 16 messages between turns** is the windowing slice taking
  effect on the rebuilt context.
- **Round latency growth across the session:** 90 s, 82 s, 51 s, 48 s,
  118 s, 84 s. Largest single LLM exchange = 76 s (16:23:51, 1858 reasoning
  tokens emitted).
- **Cache-read working well:** Venice `cached_tokens` = 95-98% of
  `prompt_tokens` once the prefix stabilizes — so the wire-level cost is
  fine even though the prompt is large.

---

---

## Hypothesis table

| # | Hypothesis | Status | Evidence |
|---|---|---|---|
| 0 | **Silent windowing without summary** drops earlier turns from the API request without notifying the model | ✓ **confirmed (runtime + static)** | 2026-05-04 export; trace at [summarizer.js:589-657](../../../js/chat/summarizer.js) |
| 1 | Summarization breaks tool_call_id integrity | ✓ confirmed (static); did not manifest in 2026-05-04 run because summarizer never fired | Code trace below; latent until threshold reached |
| 2 | `function.name` `+=` corruption on chunk-repeating providers | ? pending | Needs per-provider stream log |
| 3 | Idle timeout fires mid-tool-loop | ? pending — single-call ceiling ~76 s observed (under 90 s default) | Watch for >90 s exchanges in future runs |
| 4 | Reasoning preservation gap on continuation | ? likely inert | See note below |
| 5 | `delta.reasoning_content` channel ignored | ? scope-dependent | Only relevant for R1/QwQ |
| 6 | Multi-store coupling drift | ? pending | Correlate with pruning events |
| 7 | **Threshold scales with window**, so summarization waits ~half the window before firing | ✓ confirmed (runtime + static) | Computed `SUMMARY_THRESHOLD` ≈ 198 for a 198K-window model; session topped out at ~95 messages and never crossed it |

### Hypothesis #0 — confirmed runtime root cause (silent windowing)

**Statement.** [`getContextMessages()`](../../../js/chat/summarizer.js) at
summarizer.js:589-657 always windows `history` to `RECENT_COUNT` items
(line 596: `startIndex = Math.max(0, history.length - RECENT_COUNT)`).
The summary prefix at lines 630-654 is only injected **when an
`info.summary` exists**:

```js
if (info?.summary && history.length > this.RECENT_COUNT) {
    return [{ role: 'system', content: 'CONVERSATION SUMMARY...' }, ...recent];
}
return recent;
```

When `history.length > RECENT_COUNT` **and** no summary has been
generated yet (because `shouldSummarize()` hasn't crossed
`SUMMARY_THRESHOLD`), the older messages are silently sliced off and the
fallback `return recent;` ships without any heads-up that earlier
context existed. The model has no marker, no system note — it just
doesn't see those messages and has no way to know they were ever there.

**Evidence from the 2026-05-04 export.**

- Threshold for `minimax-m27` (198K window, balanced fillPct):
  `SUMMARY_THRESHOLD = clamp(capacity, 20, 200×scale) ≈ 198`. Session
  reached ~95 messages → `shouldSummarize()` returned false the entire
  time. No summary ever stored, no `chatPruneStash` event, no
  `[ChatSummarizer] Pruned …` log.
- `RECENT_COUNT_TOOLS` for the same model: `clamp(round(capacity ×
  0.60), 16, 100×scale)` ≈ 119 messages.
- At turn 6 entry, exchange msgCount=76 means the rebuilt context was
  76 — so up to 19 messages from the live `chatHistory` were dropped
  with no replacement, including the **original user framing** ("we
  need to have a long talk… stick to reads…").
- Subsequent rounds show the model re-reading files it already
  inspected (`[EditTracker] Recorded read: js/chat/handlers.js
  lines 620-680` after earlier read 620-700, then 540-700, etc.) and a
  positional error at 16:26:40 (`read_lines end_line=360 on a 358-line
  file`) consistent with lost positional state.

**Why this is the actual driver of "chat falls apart" before
summarization fires.** The model gradually loses the original task
framing and earlier exchange context. With 81 tools admitted and a
"Please continue" prompt that carries no instruction of its own, the
model improvises — re-reading, contradicting, asking the user for a
plan it already had. The user perceives this as "death spiral".

**Why the existing backward-scan defense at
[summarizer.js:599-619](../../../js/chat/summarizer.js) doesn't help
here.** The scan only protects `assistant(tool_calls)` paired with
their `tool` results at the boundary. It does NOT inject a
"truncation occurred" signal for the silently-dropped earlier turns.
The 2026-05-04 export shows the scan firing as designed (`Expanded
context to include assistant+tool_calls at index 9` then `at index 29`)
— it's doing its job; it just doesn't address this failure mode.

### Hypothesis #1 — confirmed root cause (static)

**Statement.** `ChatSummarizer._pruneHistory()` cuts `State.chatHistory` at a
**count-based boundary** that is not aware of `assistant(tool_calls)`/`tool`
message pairing. After such a cut, the recent window can begin with one or
more `tool` messages whose `tool_call_id` references an `assistant`
message that has just been pruned. The next API request sends those
orphaned tool messages — providers that validate tool_call_id integrity
return 400; providers that don't validate confuse the model with a tool
result that has no preceding tool call.

**Code path.**

1. **Trigger.** Every call to `addMessage()` checks
   [`ChatSummarizer.shouldSummarize()`](../../../js/chat/messages.js)
   (messages.js:71). When true, `generateAndStore()` runs after a 1500 ms
   `setTimeout`, fire-and-forget.

2. **Naïve slice.**
   [`generateAndStore()`](../../../js/chat/summarizer.js) at
   summarizer.js:454-510 computes `older = history.slice(0,
   -RECENT_COUNT)` (line 458) and calls `_pruneHistory(older.length)`
   (line 501). **No inspection of message roles or `tool_calls` shape.**

3. **Splice.**
   [`_pruneHistory()`](../../../js/chat/summarizer.js) at
   summarizer.js:524-544 does `State.chatHistory.splice(0, pruneCount)`
   (line 528) blindly. If `chatHistory[pruneCount-1]` is an `assistant`
   message with `tool_calls`, those calls are gone from `chatHistory`
   while the matching `tool` messages at `chatHistory[pruneCount...]`
   remain.

4. **Backward-scan defense fails.**
   [`getContextMessages()`](../../../js/chat/summarizer.js) at
   summarizer.js:589-657 has a CRITICAL FIX comment at lines 599-619
   that scans backward from `startIndex - 1` looking for an
   `assistant` with `tool_calls`. **This scan operates on `history`
   AFTER the prune.** If the assistant message has been spliced out,
   the scan reaches `i = -1` and exits without expanding the window.
   The recent slice still begins with orphan tool messages.

5. **Filter doesn't catch it.** Lines 623-628 filter `isSummary`,
   `system`, and remap `error` → `user`. Orphan `tool` messages pass
   through unchanged.

6. **Outgoing request.** The `messages` array built at
   [handlers.js:370-374](../../../js/chat/handlers.js) is:
   `[system_prompt, summary_message, ...recent_starting_with_orphan_tool, user_input]`.
   The summary message is a regular `system` message — it carries no
   `tool_calls`. The orphaned `tool` message has no preceding
   `assistant` with a matching id in the request.

**Provider behavior on this shape.**

- **OpenAI / OpenAI-strict compat (most modern providers):** 400 with a
  message like `"messages with role 'tool' must follow a preceding
  message with 'tool_calls'"`. The error surfaces in `LLM.chat`'s catch.
  The retry logic at handlers.js:450-466 only retries on round 0 with
  `toolActions.length === 0` and a transient-error string — it does
  NOT recognize this shape, so the request fails hard.
- **Lax providers (some local Ollama setups, older vLLM):** Accept the
  message; the model now sees a tool result with no tool call. Common
  responses: confused re-attempts, hallucinated continuations,
  repeated identical tool calls (which then trip the duplicate-streak
  refusal at [handlers.js:560-620](../../../js/chat/handlers.js)).
  Either way, the model has lost the thread.

**Why the existing rollback at handlers.js:469-475 doesn't save us.** That
rollback restores `State.chatHistory.length` to a within-request snapshot
on transient API failure — it defends against orphans created **mid-loop
during a single request**. The summarization-induced orphan is created
**between requests** by an async timer 1500 ms after `addMessage`. The
snapshot from the next request is taken AFTER the orphan already exists.

**Why the existing toolActionLog band-aid at
[summarizer.js:631-643](../../../js/chat/summarizer.js) doesn't save us.**
The injected text reminds the model what tools it called. It does **not**
fix the request shape — the orphan tool message still ships, and providers
still 400 (or models still get confused). The band-aid was for
context-eviction signal-loss, a different problem.

**Quick repro signal (for Jeff).** With `LLMDebug` enabled, after a
session reaches `RECENT_COUNT * 2`-ish messages, watch for:

- Console log `[ChatSummarizer] Pruned N messages (stashed for undo)` at
  [summarizer.js:539](../../../js/chat/summarizer.js).
- Within ~1.5 s of that log, the next user turn fails with a 400 referencing
  `tool` / `tool_call_id` / `tool_calls`.
- Or, the model reply on the next turn ignores or contradicts the prior
  tool result.

### Hypothesis #2 — `function.name` append (latent, low priority)

[api.js:791](../../../js/llm/api.js) does
`toolCalls[tc.index].function.name += tc.function.name` rather than
overwrite-if-empty. OpenAI and Venice send `name` only on the first chunk
of a given `tc.index`, so `+=` is harmless there. If any provider
re-emits `name` on later chunks, the accumulated name becomes
`get_weatherget_weather` and tool dispatch fails to look up the function.

**Pending.** Capture per-provider `tool_call_delta` logs from
[api.js:701](../../../js/llm/api.js) and grep for repeated `name` fields
on the same `index`.

### Hypothesis #3 — idle timeout mid-loop (plausible)

[api.js:609](../../../js/llm/api.js) defaults `llmIdleTimeout` to 90 s,
re-armed on every `reader.read()` chunk arrival (post-#260 fix). For a
slow tool-execution round (sequential 30 s per-tool budget at
[handlers.js:628](../../../js/chat/handlers.js)), the SSE can stall
between tool-call chunks if the model is composing many calls in
sequence at the API end.

**Pending.** Inter-arrival timing logs from a failing turn.

### Hypothesis #4 — reasoning preservation gap (likely inert)

`<think>` tag extraction is gated at
[api.js:723](../../../js/llm/api.js) on
`!hasToolCallsInResponse && !hasTools`. In the typical tool-using turn,
extraction does NOT run, so reasoning stays in `content` and is echoed
back verbatim on continuation. In the no-tools terminal turn,
extraction runs but the turn has no continuation. The `assistantMsg.reasoning`
sidecar at [handlers.js:880](../../../js/chat/handlers.js) is well-formed
but ignored by ~all providers; it persists for UI display, not wire shape.

Net: probably not a death-spiral driver. Could become one if a future
change un-gates extraction during tool-using turns. Worth a regression
test in the eventual fix track.

### Hypothesis #5 — `delta.reasoning_content` ignored

ai-editor consumes only `<think>` tags from `delta.content`. If Jeff's
testing model emits reasoning via `delta.reasoning_content`
(DeepSeek-R1, QwQ, some vLLM-served models), the reasoning is silently
dropped on the floor. Whether this contributes to spirals depends on
which model triggers them. **Confirm scope before sizing.**

### Hypothesis #6 — multi-store coupling drift

Five stores track AI activity:
[`State.chatHistory`](../../../js/core.js),
[`messages`](../../../js/chat/handlers.js) (request-body, rebuilt
per-request),
[`chatPruneStash`](../../../js/chat/summarizer.js),
[`State.toolActionLog`](../../../js/chat/handlers.js),
[`chatSummaryInfo`](../../../js/chat/summarizer.js). The `toolActionLog`
is already a band-aid for context eviction. Confirm whether spirals
correlate with stash-restore moments
([summarizer.js:563](../../../js/chat/summarizer.js)) or summary-injection
moments ([summarizer.js:646-654](../../../js/chat/summarizer.js)). Likely
downstream of #1 rather than independent.

---

## Recommended fix scope

Sized as PR-sized increments matching the cadence in
[`docs/ROADMAP.md`](../../ROADMAP.md). Each PR cites the regression test
it ships.

### PR 0 — truncation marker when no summary exists (closes #0)

**Files.** [`js/chat/summarizer.js`](../../../js/chat/summarizer.js)
`getContextMessages()`.

**Change.** When `history.length > RECENT_COUNT` AND
`info?.summary` is null, prepend a synthetic system message so the
model knows context was truncated:

```js
if (history.length > this.RECENT_COUNT && !info?.summary) {
    const dropped = history.length - recent.length;
    return [
        {
            role: 'system',
            content: `[Context note: ${dropped} earlier message(s) ` +
                     `were truncated to fit the window. Ask the user ` +
                     `to repeat any task framing if you've lost the thread.]`,
            isSummary: true
        },
        ...recent
    ];
}
```

This is **the smallest possible fix** that closes the actual
runtime symptom. It buys time before the larger summarization fix
lands. Trade-off: the marker takes a few tokens and tells the model
explicitly that it doesn't have full context, which may make it more
cautious / more likely to ask the user to re-frame. That's fine for
this failure mode.

**Regression test.** Build a `chatHistory` of length `>
RECENT_COUNT` with no summary stored. Call `getContextMessages()`.
Assert the first returned message is a system message with
`isSummary: true` and content containing `truncated`.

**Roadmap slot.** First PR of the stability sub-track. Highest
priority; closes the failure mode demonstrated in the 2026-05-04
export.

### PR 1 — boundary-aware prune (closes #1)

**Files.** [`js/chat/summarizer.js`](../../../js/chat/summarizer.js).

**Change.** `_pruneHistory(pruneCount)` must adjust `pruneCount` to
align to a safe cut:

- If `chatHistory[pruneCount]` is a `tool` message, walk forward until
  reaching the first non-`tool` message (include all tool results in
  the pruned slice OR include all of them in the recent window —
  whichever is smaller / preserves the assistant pair).
- If `chatHistory[pruneCount - 1]` is an `assistant` with `tool_calls`,
  walk backward to before that assistant (or forward past the matching
  tool messages, whichever the policy picks).

Recommended policy: **prune through the last complete tool group before
`pruneCount`** — never split an `assistant(tool_calls)` from its `tool`
messages. If no safe boundary exists in the older slice, decline to prune
this round (let `coveredCount` carry forward).

**Regression test.** A new test in `tests/chat-summarizer.html` (or
equivalent) that:
1. Builds a `chatHistory` ending in `[..., assistant(tool_calls), tool, tool]`.
2. Sets `pruneCount` to land between the assistant and the first tool.
3. Asserts the post-prune history starts on a clean boundary.
4. Asserts `getContextMessages()` returns no orphan `tool` messages.

**Roadmap slot.** First PR of the stability sub-track.

### PR 2 — request-shape validator (defense-in-depth)

**Files.** new `js/chat/history-validator.js` or inline in
[`js/chat/handlers.js`](../../../js/chat/handlers.js) before line 370.

**Change.** Before sending `messages` to `LLM.chat`, walk the array and
assert: every `tool` message has a preceding `assistant` with a
`tool_calls[].id` matching the message's `tool_call_id`. On failure,
either:

- Drop the orphan tool messages and log a warning (chosen if speed
  matters), OR
- Re-rebuild context with summary-only prefix (more conservative).

**Regression test.** Synthesize a poisoned history; confirm the
validator catches and the request is either cleaned or rebuilt.

**Roadmap slot.** Second PR.

### PR 3 — function.name overwrite-if-empty (closes #2 latently)

**Files.** [`js/llm/api.js`](../../../js/llm/api.js) line 791.

**Change.** `if (tc.function?.name && !toolCalls[tc.index].function.name)
toolCalls[tc.index].function.name = tc.function.name;`

**Regression test.** Synthesize a stream with `name` repeated on later
chunks; assert accumulated name is single, not concatenated.

**Roadmap slot.** Bundle with PR 1 if scope permits, else third PR.

### PR 4 (deferred) — measurement harness for stability

**Scope.** A test fixture that drives a multi-turn tool-using
conversation against a configurable provider/model, with a known
`chatHistory` shape that triggers summarization, and asserts the
post-summarization request shape is valid. Acts as the gating regression
suite for any future history changes.

**Roadmap slot.** Phase-2 of the stability track.

### PR 5 — token-based summarization trigger (closes #7)

**Files.** [`js/chat/summarizer.js`](../../../js/chat/summarizer.js)
`shouldSummarize()` and `_computeParams()`.

**Change.** `SUMMARY_THRESHOLD` currently scales with the model
window (clamp at 200×scale). For a 198K window, threshold ≈ 198
messages — which means a session has to be *very* long before any
summary fires. Replace the message-count gate with a **token-estimate
gate**: trigger summarization when the projected outgoing prompt size
is above a fraction of the window, regardless of message count.

`exchange.usage.prompt_tokens` is already captured per exchange —
the running estimate is cheap to maintain.

**Regression test.** With a synthesized history that exceeds 50% of
the window in token count but stays under 30 messages,
`shouldSummarize()` should return true.

**Roadmap slot.** After PR 0/1/2 land. Lower urgency once the
truncation marker is in place, but this is the long-term fix for
the gating math.

### Out of scope (deferred per plan)

- Sequential-vs-parallel tool dispatch — perf, not correctness.
- Iteration cap formalization — current heuristic adequate.
- `error` role remap to `user` — behavioral choice, not stability bug.
- Anthropic extended-thinking signed-block preservation — N/A.
- `delta.reasoning_content` consumption (#5) — scope-conditional;
  decide after Jeff confirms which models he uses.

---

## Roadmap slot proposal

**Recommended.** A dedicated minor — call it **1.6.0 — Chat stability**
— inserted before continuing the 1.5.9 / 1.5.10 retrieval thread.
Rationale:

- The retrieval track's exit criterion is `meanRecallAt5 ≥ 0.80`, measured
  via [`tests/retrieval-measurement.html`](../../../tests/retrieval-measurement.html).
  That harness doesn't dogfood the chat surface — retrieval can ship
  without stable chat.
- But the **profile track** at 2.0 explicitly assumes chat is the
  primary driving surface. Shipping profile changes against an unstable
  chat loop would conflate stability bugs with profile bugs in
  measurement.
- The fix is bounded — three PRs, no cross-track contention. Sequencing
  it as a minor between 1.5.x and the next subsystem keeps the
  in-track-patches rule from
  [`feedback_roadmap_in_track_patches.md`](../../../.claude/projects/-config-Projects-ai-editor/memory/feedback_roadmap_in_track_patches.md)
  honest.

**Alternative 1.** Sub-track 1.5.x.y patches (e.g., 1.5.9, 1.5.10,
1.5.11) interleaved with retrieval work. Faster to start; muddies the
1.5.x signal.

**Alternative 2.** Defer until profile track. Risky — loses dogfooding
window.

**Open question for Jeff.** Pick the slot. The diagnosis stands either
way.

---

## Verification (per the plan)

- [x] Hypothesis #1 confirmed via static code trace (no repro needed —
  the defect is structurally guaranteed by the pruning algorithm).
- [ ] Hypotheses #2, #3, #5, #6 await runtime evidence from a repro
  session.
- [ ] Hypothesis #4 marked likely-inert; no further work unless a
  related change un-gates extraction.
- [ ] A reader of this doc can re-trace #1 from the cited line numbers
  and reach the same conclusion.
- [ ] Fix scope sized as PR-sized increments per ROADMAP cadence.

Pending items will be addressed when Jeff drives a repro session and
captures the artifacts listed under *Reproduction recipe*.

---

## Next session — what to fix

In rough priority order. Each line is a one-PR slice.

1. **PR 0 — truncation marker in `getContextMessages()`.** Smallest
   fix; closes the runtime symptom from the 2026-05-04 export.
   [`js/chat/summarizer.js`](../../../js/chat/summarizer.js)
   `getContextMessages()` lines 589-657. Add the marker block AND
   ship the regression test described in §"PR 0" above. Bump
   `js/version.js` to 1.5.10 (or whatever the next track-aligned
   patch is) and promote `[Unreleased]` in CHANGELOG.

2. **Optional refinement on PR 0** — also pin the very first user
   message in the slice (the "task framing"). When `history[0]?.role
   === 'user'` and would otherwise be sliced off, prepend it
   alongside the truncation marker. Cheaper than a real summary and
   addresses the specific failure mode where the model loses its
   original instructions.

3. **PR 1 — boundary-aware prune in `_pruneHistory()`.** Static-trace
   hypothesis #1. Latent until summarization fires; ship before any
   change that lowers `SUMMARY_THRESHOLD` (including PR 5 below).
   [`js/chat/summarizer.js:524-544`](../../../js/chat/summarizer.js).

4. **PR 2 — request-shape validator before `LLM.chat`.** Belt-and-
   braces. Asserts every `tool` message has a matching preceding
   `assistant.tool_calls[].id`. Drops orphans with a warning rather
   than 400-ing the request.
   [`js/chat/handlers.js:370`](../../../js/chat/handlers.js).

5. **PR 3 — `function.name` overwrite-if-empty.** Latent.
   [`js/llm/api.js:791`](../../../js/llm/api.js). One-line fix +
   regression test.

6. **PR 5 — token-based summarization trigger.** Replace the
   message-count `SUMMARY_THRESHOLD` with a token-estimate gate based
   on running `prompt_tokens`. Lower urgency once PR 0 lands; fixes
   the long-term gating math.
   [`js/chat/summarizer.js:200-208`](../../../js/chat/summarizer.js).

### Verification artifacts to capture during the next repro

Before any of the above lands, drive one more long session on 1.5.9 HEAD
to confirm the symptom is unchanged from 1.5.8 (rule out that any of the
four 1.5.9 fixes accidentally addressed it). Capture:

- Same fields as the §"Reproduction recipe" table.
- Set `localStorage.setItem('debug.dump.summarizerSnapshots', '1')` (or
  add a one-line dump in `_pruneHistory` / `getContextMessages` if such
  a flag doesn't exist) so each rebuild's `RECENT_COUNT`, `startIndex`,
  `info?.summary` presence, and dropped count are logged.
- After ~5 user turns, screenshot `State.chatHistory.length` vs latest
  exchange `msgCount` from the debug export — the gap *is* the silent
  drop.

### Out-of-scope items spotted during this investigation

- Debug area lost the **Clear button** (re-implementation in 1.5.x);
  unrelated to chat stability but worth a tiny UI patch.
- Debug area **unread badge never clears**; same scope as above.
- Wishlist: `git_blame` LLM tool wrapper around the existing
  `Git.getBlame()` (provider layer + Git module already support it,
  only the tool wrapper is missing). Tracked separately.
