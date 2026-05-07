# Dogfood trace — grok-4-3 `get_ci_status` loop on Minesweeper

**Date:** 2026-05-07
**Substrate:** [HTML-Games](https://git.gobha.me/xcaliber/HTML-Games) · issue#98 *"new game: Minesweeper"*
**Branch under task:** `issue/98-new-game-minesweeper` (auto-created by ai-editor on session start; no PR yet)
**Model:** grok-4-3 (cheap tier; ~$0.20/M in / ~$0.50/M out)
**Editor version under test:** ai-editor `main` HEAD = 1.8.0 at session time *(pre-1.8.1; this trace is what shaped the 1.8.2 fix)*
**Chat export reference:** conversation timestamp `5/7/2026, 11:02:32 AM` (raw export not attached to this trace)
**Archetype:** *Create new minimal game* — measures planning, file creation, convention recall, zero-corpus retrieval behavior.
**Outcome:** session aborted at the model layer; logic infrastructure functioned correctly; **single tool-ergonomics fault identified, fixed downstream at 1.8.2**.

---

## Why this trace exists

This is the **first** trace under [ROADMAP §"Test design under operational constraints"](../ROADMAP.md). It establishes the template; future traces should follow the same shape but feel free to evolve it as patterns emerge. The headline output of a trace is the **logic-vs-LLM split** on each axis — *what does this incident tell us about the editor's logic, separate from the model's behavior?*

This session has a clean answer: the editor's cache + refusal infrastructure (1.7.1) fired exactly as designed. The fault was at the model-recovery layer — the refusal envelope didn't tell a weak model what to do next, and the weak model didn't infer it. **Logic infrastructure: correct. Tool-ergonomics: insufficient for cheap-tier recovery.**

---

## Symptom chain

```
turn N         list_tool_categories                                    →  ok (exploration)
turn N+1       list_tools_by_category(...)                             →  ok (exploration)
turn N+2       get_ci_status                                           →  real result: build success, no PR, empty
turn N+3       get_ci_status (identical args)                          →  _cached: true
turn N+4       get_ci_status (identical args)                          →  _cached: true (nested)
turn N+5       get_ci_status (identical args)                          →  REFUSED: 3x ("called 3 consecutive times…")
turn N+6       get_ci_status (identical args)                          →  REFUSED: 4x
…
turn N+9       get_ci_status (identical args)                          →  REFUSED: 7x
                                                                          (session ended; no recovery attempt)
```

The chain `_cached:true → _cached:true (nested) → REFUSED: Nx` is the exact path designed by [`js/chat/cache-invalidation.js`](../../js/chat/cache-invalidation.js) and the `STATEFUL_READ_TOOLS` bypass (1.7.1, gitea#301). It worked — the editor refused to spend tokens on a duplicate call. The model treated each refusal as an error to push past instead of a signal to change approach.

---

## Grading across the five axes

### 1. Retrieval quality
**N/A for this incident.** No `find_relevant_files` call was issued before the loop began — the model jumped straight from tool-catalog exploration to `get_ci_status`. The indexer-readiness gate ([`indexer_not_ready` envelope](../../CHANGELOG.md), 1.6.11) didn't fire because retrieval was never invoked.

> **Open question** for future traces: is the absence of a retrieval call itself a planning fault we should grade? *Initial template position: yes — note "no retrieval issued" as a planning-axis observation, not a retrieval-axis pass.*

### 2. Tool-call quality
**Logic side: pass.** The 1.7.1 cache-invalidation chain fired correctly — the refusal envelope existed, was structurally well-formed (`{ error: "...", _refused: true }`), and arrived at the model on every duplicate.

**LLM side: fail.** The model failed to extract a behavioral hint from the refusal `error` string. It read *"called N consecutive times with identical args. Use the prior result or pick a different approach"* and re-fired the same tool with the same args. Six consecutive refusals; no escape attempt.

**Logic-vs-LLM split:** the envelope shape was insufficient. There was no `next_action_hint` field telling the model *what* different approach was appropriate. The cure is on the logic side — better hint = better recovery for weak models — even though the *immediate* fault was at the model layer.

**Pre-condition that primed the loop:** `get_ci_status` against a freshly-created branch with no PR returns a structurally-`success` response that's **informationally empty** (no checks have been triggered because no PR exists yet). The model treated empty-but-success as "I haven't called this yet" and re-fired.

### 3. Compression behavior
**Pass.** The session was short (~10 turns) and never crossed the summarizer threshold. `RECENT_COUNT` stayed below the rebuild trigger; no truncation marker fired; the 1.6.2 request-shape validator did not need to drop orphans. Uneventful — exactly as expected for a short session.

### 4. Planning quality
**Fail (the underlying planning fault).** The model never planned. It explored the tool catalog, then on turn N+2 jumped to `get_ci_status` against a branch that had no PR yet — there was no scenario in which CI status was relevant to "implement Minesweeper." A planned approach would have been: read repo conventions → scan an existing game for shape → create new files → commit. None of that happened.

This is a model-tier fault, but the editor amplified it: by being *too willing* to refuse without redirecting, the editor left the model with no path forward.

### 5. Cost-quality tradeoff
**Under-spend, but only because the model self-aborted.** Per-turn token cost stayed cheap-tier. But quality was zero — no game written, no commit made, session abandoned mid-loop. The spend-per-useful-output is effectively infinite for this session. This is the "cheap-tier failure shape" the dogfood matrix warned about: low absolute cost masking total task failure.

> **Trace-template note:** in future traces, capture `prompt_tokens` and `cached_tokens` per turn from the cost dashboard. This trace runs without that data because the cost dashboard's CSV/JSON export ([1.6.6](../../CHANGELOG.md)) wasn't run on this session — write a session-end export to disk before declaring a session complete in future runs.

---

## What this trace produced

1. **A logic fix** — [1.8.2 / PR #307](https://github.com/gobha-me/ai-editor/pull/307) shipped `getRefusalHint(toolName)` in [`js/chat/refusal-hints.js`](../../js/chat/refusal-hints.js). The refusal envelope now concatenates a tool-aware behavioral hint into the `error` string. For `get_ci_status` specifically, the hint is the kind of thing this session needed: *"This branch has no PR yet; create one with `create_pull_request` before checking CI."*

2. **A measurement gap noted** — cost-dashboard export wasn't run at session end. Future traces in this directory should capture the per-turn token data, not just the symptom chain.

3. **A planning-axis observation** — *no-retrieval-issued* should count as a planning-axis finding, not a retrieval-axis pass. Adopted into the template above.

---

## What this trace did *not* produce (deliberately)

- A pre-designed template. Per ROADMAP, "first trace establishes the template; do NOT pre-design it." The structure above is what the post-mortem material naturally yielded; subsequent traces should evolve it where evolution helps and discard sections where they don't. The five axes are the load-bearing skeleton; everything else is up for grabs.
- Automation. ROADMAP: "first ~3-5 sessions are manual; abstract only when a pattern repeats."
- Cross-model siblings. The original cross-model probe is impossible because the editor's branch lifecycle prevents re-running the same task — siblings need to be different tasks of the same archetype across different cheap-tier models. This trace documents *one* sibling; the archetype's full read needs Minesweeper-on-Sonnet-4.6 (anchor, weekly) and one or two more cheap-tier sessions on different "create new minimal game" tasks before the logic-vs-LLM split is statistically legible.

---

## References

- ROADMAP §"Test design under operational constraints" · §"What we measure" — [`docs/ROADMAP.md`](../ROADMAP.md)
- 1.7.1 cache-invalidation infrastructure — [`CHANGELOG.md` §1.7.1](../../CHANGELOG.md), [`js/chat/cache-invalidation.js`](../../js/chat/cache-invalidation.js)
- 1.8.2 `next_action_hint` fix — [`CHANGELOG.md` §1.8.2](../../CHANGELOG.md), [`js/chat/refusal-hints.js`](../../js/chat/refusal-hints.js)
- gitea#301 — `[chat] edit_file ↔ read-cache cross-request deadlock` (closed at 1.7.1)
