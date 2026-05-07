# Dogfood trace — queued user input during a Qwen-3.6-plus run on HTML-Games

**Date:** 2026-05-07
**Substrate:** [HTML-Games](https://git.gobha.me/xcaliber/HTML-Games) · github#108 *"Web Audio sound-effect helper (opt-in module)"*
**Branch under task:** `issue/108-web-audio-sound-effect-helper-opt-in-module`
**Model:** qwen-3-6-plus (cheap tier; per the [ROADMAP §"Test design under operational constraints"](../ROADMAP.md) cheap-tier-rotation row)
**Editor version under test:** ai-editor `feat/1.9.1-queued-user-input` topic branch (pre-tag) — directly validating [PR #313](https://git.gobha.me/xcaliber/ai-editor/pulls/313) before merge
**Chat export reference:** session timestamp `5/7/2026, 9:42:30 PM` (full export pasted into the validating PR thread)
**Archetype:** *Mid-task interjection probe* — first trace of a new archetype: queue a user message **during an in-flight tool loop** and measure whether (a) the queue captures it, (b) the drain seam delivers it at the iteration boundary, and (c) the model treats it as a real user turn.
**Outcome:** **Pass on all three.** Logic infrastructure correct; model engaged coherently with the queued message on the first iteration boundary after enqueue; one planning-axis observation noted but not actionable.

---

## Why this trace exists

This is the first dogfood trace targeting a behavioral feature shipped in the editor itself — github#33 Phase 2 ([CHANGELOG §1.9.1](../../CHANGELOG.md)). Unlike the [grok minesweeper trace](2026-05-07-grok-minesweeper-ci-loop.md), the goal here isn't to find a logic fault — it's to confirm that the *new* logic actually fires under realistic mid-stream conditions on a cheap-tier model running an unrelated task.

The trace also adds a new archetype to the battery: **mid-task interjection**. The four archetypes in [ROADMAP §"Test-issue archetypes"](../ROADMAP.md) all assume the user sends one task and measures the outcome. Queued-input behavior has no acceptance signal in those — you can't tell whether queueing worked from the final PR. This archetype probes the interaction layer directly.

---

## Interaction chain

```
9:39:09 PM    user (idle)            "pick a ticket… wait for me to open"
9:39:09 PM    user (idle, follow-up) "we will be testing queued user input…"
              [single user turn — both sentences sent in one message]
9:40:06 PM    model                  picks github#108; waits.
9:40:06 PM    system                 issue#108 opened by user; auto-branch created.
9:40:06 PM    model                  exploration round 1: scratchpad_write, list_tool_categories, todo_write
9:40:19 PM    model                  exploration round 2: list_tool_categories (refused — _cached)
9:40:25 PM    model                  exploration round 3: find_tool, search_in_files "AudioContext"
9:40:41 PM    model                  exploration round 4: search_in_files (refused — _cached),
                                                          find_relevant_files (indexer_not_ready),
                                                          get_project_tree
              ─────────── ENQUEUE BOUNDARY ─────────────────────────────────
9:40:50 PM    user (mid-run)         "do you see the benefits of it?"   ← QUEUED
              ─────────── DRAIN BOUNDARY ───────────────────────────────────
9:40:57 PM    model                  responds to queued message with 5-point
                                     enumeration of benefits, then asks whether
                                     to continue github#108 or pivot.
9:42:26 PM    user                   "yes continue, the issue is yours"
9:42:30 PM    model                  resumes (●●● — chat export caught it
                                     mid-thinking on the next round)
```

The user's 9:40:50 message landed *while* the model was inside the `get_project_tree` round (the model's `### 🤖 Assistant (00:41)` log block). The next observable model turn was at 9:40:57 — a 7-second gap that's consistent with the round completing, the queue draining at the [`js/chat/handlers.js`](../../js/chat/handlers.js) iteration boundary, and the next LLM call seeing the user turn freshly appended.

---

## Grading across the five axes

### 1. Retrieval quality
**Logic side: pass (correct refusal).** The `find_relevant_files` call at 9:40:41 hit the [1.6.11 indexer-readiness gate](../../CHANGELOG.md) — `indexed: 0 of 210 eligible files (0.0% < 30%)`. Returned the structured `indexer_not_ready` envelope with the `index_project` hint. Model correctly fell back to `get_project_tree`.

**LLM side: pass.** The model honored the hint and pivoted to tree-walk navigation without complaint.

**Not relevant to the queue test, but worth noting:** the indexer-readiness gate fired on a fresh repo session — that's a signal the auto-branch flow doesn't pre-warm the index. Probably fine, but observe across more sessions before filing.

### 2. Tool-call quality
**Two cache-refused calls in this trace** (`list_tool_categories` and `search_in_files "AudioContext"`), both with the [1.7.1 cross-request cache hit](../../CHANGELOG.md) — `_cached: true` envelope with the canonical "[You already called X with these arguments earlier in this conversation]" preamble. Model accepted both refusals without re-firing — different from the [grok minesweeper](2026-05-07-grok-minesweeper-ci-loop.md) refusal-loop pathology. The 1.8.2 `next_action_hint` work helped here too: the cached envelope says "Do NOT call this tool again with the same args" and qwen respected it.

**Logic-vs-LLM split:** logic correct, model compliant. Cheap-tier qwen behaved better than cheap-tier grok did on the same envelope shape — though that's an n=1 model-difference observation, not a logic claim.

### 3. Compression behavior
**Not exercised.** Session length ~96k tokens (per the export footer: `93803↓ 2274↑ · 1301 reasoning`) — well under any rebuild threshold. Uneventful.

### 4. Queued-input behavior (new axis for this archetype)
**Pass on all three sub-checks.**

- **Capture:** the user's mid-run message was visibly held by the queue. (Observable in the editor UI as the queued-input panel; not visible in the chat export, which only renders sent turns.)
- **Drain at boundary, not mid-iteration:** the model did not see the message until *after* `get_project_tree` returned — confirmed by the model's response timing (9:40:57, post-tool-call) and the lack of any tool-call interruption in the export.
- **Treated as a user turn:** the model's response engaged substantively (5 benefits enumerated). It then asked *"Should I continue with issue #108, or would you like to pivot?"* — which is the correct read on an out-of-band user message: it could be a clarifying aside *or* a pivot signal. The model deferred to the user rather than guessing.

**One observation worth recording for future archetype runs:** the model's "should I continue or pivot?" question is a *consequence* of the queue working, not a fault. Out-of-band user input legitimately introduces ambiguity. If we want the model to default to "continue the prior task unless the queued message is an explicit pivot," that's a system-prompt change, not a queue-logic change. Hold on filing until we see the same pattern in 2-3 more sibling traces.

### 5. Cost-quality tradeoff
`$0.0672 / 11 requests / 96k tokens` — this is the cheap-tier-default row of the [ROADMAP cost matrix](../ROADMAP.md), exactly where the dogfood battery wants to live. The session itself didn't *complete* the issue#108 task (the user redirected to test queue behavior, not to ship audio code), so per-task spend-vs-quality isn't gradable here. **What the trace does prove:** the queued-input feature itself does not add per-turn token overhead — the queue is in-memory, the drain is a `messages.push` that the LLM sees as one extra user turn (~30 input tokens), no additional cache invalidation, no compression rebuild triggered.

---

## What this trace produced

1. **Direct validation of [PR #313](https://git.gobha.me/xcaliber/ai-editor/pulls/313) under live cheap-tier conditions.** The unit tests cover state transitions; this trace covers the *interaction* the unit tests can't reach — the model actually sees the queued turn and treats it as user input.

2. **A new battery archetype: mid-task interjection.** Add to the [ROADMAP §"Test-issue archetypes"](../ROADMAP.md) table as the fifth row:

   | Archetype | Example | What it measures |
   |---|---|---|
   | Mid-task interjection | Send a clarifying or pivoting message *during* an in-flight tool loop | Queue capture, boundary-drain timing, whether the model treats out-of-band input as user turn |

3. **A planning-axis observation parked, not filed.** "Model defaults to asking 'continue or pivot?' on queued mid-stream messages." Defer until n≥3 traces.

---

## Logic-vs-LLM splits, recap

| Axis | Logic | LLM | Action |
|---|---|---|---|
| Retrieval | Pass — `indexer_not_ready` gate fired correctly | Pass — model honored the hint | None |
| Tool-call | Pass — cache-hit envelope correct | Pass — qwen respected "do not re-fire" | None |
| Compression | N/A — short session | N/A | None |
| **Queue (new)** | **Pass — capture + boundary drain + visible-as-user-turn all confirmed** | **Pass — coherent engagement, deferred pivot decision to user** | None — feature ships |
| Cost-quality | Cheap-tier as designed; queue adds no overhead | N/A | None |

---

## Reproducibility

To re-run this archetype:

1. Open ai-editor on a topic branch with [PR #313](https://git.gobha.me/xcaliber/ai-editor/pulls/313) merged (or run against the editor's `feat/1.9.1-queued-user-input` branch directly).
2. Pick any HTML-Games issue requiring multi-step exploration (`get_project_tree`-driven retrieval is good — long enough for a mid-stream interjection to land mid-tool-call).
3. Switch model to a cheap-tier choice (qwen-3-6-plus, deepseek-v4-flash, or mistral-small-4 per the budget matrix).
4. Start the issue. Wait until the model is mid-tool-call (the queued-input panel appears as soon as `State.isGenerating === true`).
5. Type a question/comment that's adjacent-but-not-identical to the active task. Press Enter.
6. Confirm the panel shows "1 message queued" and the textarea stays usable.
7. Wait for the current round to end. Confirm the model engages with the queued message at the next iteration boundary.

The interaction chain above is the expected shape; deviations are findings.
