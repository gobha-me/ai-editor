# DESIGN — Sub-Agent Architecture for Delegated Task Execution

**Status:** Draft — design pass for [`github#24`](https://github.com/gobha-me/ai-editor/issues/24), filed pre-2.0 and explicitly post-2.0-gated in [`docs/ROADMAP.md`](ROADMAP.md) §"Known open issues — not yet scheduled". No version slot is requested by this doc beyond a parallel-track row to be added in `docs/ROADMAP.md` once Phase 1 is committed to.
**Depends on:** the profile contract ([`DESIGN-profiles.md`](DESIGN-profiles.md)) as the abstraction that child agents inherit — github#24 was specifically gated on 2.0.0 / role-selector removal so this lift could happen against a profile-keyed surface rather than the legacy role-keyed one; the Plan-Mode-shaped per-invocation gate (`js/tools/plan-mode.js`, `js/chat/plan-approval-card.js`, shipped 1.10.0) as the user-pause template; the Tier-0 sandbox Worker security posture (`js/intelligence/script-runner.js`, `js/workers/script-runner-worker.js`, shipped 1.16.0) as the established "delegated execution returns structured result" template; the Tier 3a preview surface (shipped 2.10.0) as the second validated reuse of the same pattern; the role-gated tool registry (`js/tools/registry.js`) as the trust boundary new sub-agent invocations must respect.
**Related memory:** `project_tier0_sandbox_validated.md` (~200× cost-collapse evidence the tier model is reproducing), `project_tier3a_validated.md` (second confirmation that "submit → run elsewhere → return structured result" works), `project_cost_quality_tradeoff.md` (steering frame — cost-collapse is the value case), `project_intelligence_subsystems.md` (four-subsystem rebuild this sub-agent surface coordinates through profiles, not bypasses), `feedback_chat_multi_rp_no_utility_in_aieditor.md` (sub-agent ≠ multi-user; don't conflate with `chat_multi.v1` / `rp.v1`).
**Supersedes:** the [`docs/ROADMAP.md`](ROADMAP.md) §"Known open issues — not yet scheduled" stub for github#24. That entry framed the gating ("commit only if real tasks are measurably bottlenecked on context exhaustion that decomposition would solve"); this design names the seam, slices it, and pre-decides the trust-boundary questions so the next conversation can pick Phase 1 with the gates already drawn.

---

## Problem

ai-editor's chat surface is a single agent in a single tool loop. Every read, every edit, every search, every preview probe charges its tokens to the same conversation. The main agent has to juggle the whole task in one context window, and as the task grows the dominant cost is *re-reading old tool results* rather than *making new decisions*. The two prior validated cost-collapse instances on this codebase — Tier-0 sandbox (1.16.0, ~200× cheaper on combinatorial fs-walk shapes; see `project_tier0_sandbox_validated.md`) and Tier 3a preview (2.10.0, dogfooded successfully on HTML-Games; see `project_tier3a_validated.md`) — both worked by *taking work outside the main loop*. Different mechanisms, same shape: the parent agent ships a task into a constrained surface, the constrained surface returns a structured result, the parent agent reads one tool_result instead of N intermediate states.

github#24 names the next case of the same pattern: a task that fits neither "single dense fs walk" (Tier-0 sandbox is right for that) nor "drive the rendered page" (Tier 3a preview is right for that), but is *agentic* — it needs a tool loop, it needs to decide between several reads, it needs to produce a structured answer. Concrete shapes today, drawn from the dogfood corpus:

- **"Read and summarize these 5 files in parallel."** The main agent ships 5 sub-agent calls, each with `read_file` + structured summary, and parents collect the answers. Today's path: 5 serial `read_file` calls each ~5K tokens of tool result, all dragged through every subsequent turn until summarization fires; with sub-agents, each child returns ~200 tokens of summary and discards its own context.
- **"Audit the import graph of this directory and tell me which exports are unused."** Tier-0 sandbox is right for the *scan* shape; but the *audit* shape — "look at these grep hits, decide which are real usages, summarize the dead ones" — is agentic. A sub-agent on a tightly-scoped read-only tool set produces the final list; the parent never sees the intermediate grep hits.
- **"This PR has 12 files changed; review each and produce a per-file comment."** Parallel sub-agents per file, each constrained to that file's content and the diff context, return structured comments. The PR Review surface (Touch 3 2.12.0–2.14.0) shipped without this affordance; the Diagnose & fix lifecycle is a single-shot LLM call that does not loop and does not delegate.
- **"Investigate why test X started failing on branch Y."** A sub-agent gets the failure context, runs read/scan/preview tools to localize the cause, and returns a finding. Parent agent makes the fix decision based on the finding, not the search.

The thesis of this document is that the right answer is neither "add a `spawn_agent({prompt})` tool that recurses freely into the same tool catalog" — that inverts the trust surface and uncaps cost — nor "wait for a measurable bottleneck that decomposition would solve" (the roadmap's current gate) — that defers the surface forever because the bottleneck is *already* paid every turn in the cost dashboard, just not labeled as such. The right answer is a **delegated sub-agent**: a new tool whose handler spawns a *new conversation*, executes the standard tool loop against a *constrained profile* with a *capped budget*, and returns a *structured result* the parent reads as a single tool_result. The parent's context never sees the child's intermediate tool results. The catalog stays the trust boundary at the tool level (one new tool, `delegate_task`); the *profile* becomes the trust boundary at the sub-agent level (the child runs against a profile-restricted catalog). Costs are explicit and dashboard-discoverable from day one.

### What this is not

- **Not a multi-user surface.** Multi-user (`chat_multi.v1`) is parked behind Phase 4 authoring API per `feedback_chat_multi_rp_no_utility_in_aieditor.md`; sub-agents are an *internal architecture pattern* of the existing single-user surface, not a step toward shared conversations.
- **Not a personality / role-play surface.** `rp.v1` is parked for the same reason. A sub-agent is a same-user-same-product execution context with a constrained tool set, not a different persona.
- **Not a replacement for Tier-0 sandbox.** If the task is a single dense fs walk (dead-CSS, unused-export, import-graph), `submit_script_for_approval` is still the right call: cheaper, faster, no LLM round trip inside the child. Sub-agents are for tasks that need a *tool loop*, not a *script*.
- **Not a replacement for Tier 3a preview.** Driving the page is selector-shaped; sub-agents are task-shaped.
- **Not a code-execution surface.** A sub-agent only invokes admitted tools. It cannot run arbitrary JavaScript (that's Tier-0); it cannot drive the browser (that's Tier 3); it cannot reach any side-effect surface its profile does not admit.
- **Not a long-running background worker.** Phase 1 sub-agents run synchronously inside the parent tool loop's "user pause" budget (same shape as Plan Mode and Tier-0 approval). Background sub-agents that the parent polls for completion are a Phase 5+ concern that requires a `Sessions` substrate this codebase does not yet have.
- **Not a replacement for compression.** The compression subsystem (`DESIGN-compression.md`, shipped 1.2.0+) keeps the parent's main loop economical; sub-agents prevent the parent from accumulating the cost in the first place. They are siblings, not the same lever.

---

## Goals

1. **Preserve the trust surface.** The catalog stays the boundary at the tool level. Sub-agents add *one* new tool, `delegate_task`. The *profile* is the new trust boundary at the sub-agent level: a sub-agent can call only what its profile admits, and profile admission is data the user can audit.
2. **Collapse context cost on agentic sub-tasks.** Tasks whose intermediate tool results inflate the parent's window without informing the parent's final answer should be expressible as a `delegate_task` call whose result is *the answer*, not the trail.
3. **Plan-Mode-shaped approval.** The user already understands `submit_plan_for_approval` and `submit_script_for_approval`; the sub-agent surface inherits the same gate template (a card mounts, the user picks Approve / Reject / Cancel, the chat loop blocks on the resolution). The default approval policy is *configurable per profile*; first-ship default is approval-on, with an explicit graduation path to auto-approve.
4. **Cost-discoverable.** Every sub-agent invocation records its tokens and dollars into the existing cost store under a new tool name; the cost dashboard renders parent vs. sub-agent splits without dashboard changes (the existing per-tool axis already groups by `tool_name`).
5. **Profile-coordinated, not subsystem-coupled.** Sub-agent state is owned by a `subagent.v1` profile (and by argument-override for advanced cases), not by any single subsystem. Retrieval / memory / compression / tools each consult the resolved profile, exactly as the four-subsystem rebuild requires.
6. **One new tool, one new profile, one new state namespace.** No new framework, no build step, no new global. `State.subagents` is the only new top-level slot. The 1.X codebase's "single-global-state" constraint stays intact.
7. **Phased delivery with measured graduation.** Phase 1 (single, non-recursive, approval-gated, on `subagent.v1`) is the only phase this design commits to. Phases 2+ are gated on Phase 1 data; the gates are named so the next implementer cannot conflate them.

---

## Non-Goals

- A general parallel-agent framework. Phase 1 is *one* sub-agent per `delegate_task` call. Phase 2 admits parallel calls; Phase 3 admits recursion.
- Cross-session sub-agent results. Phase 1 sub-agent transcripts live in `State.subagents` for the parent conversation's lifetime and discard on `delete()`. Persistence is its own consent design.
- Sub-agents that can edit the workspace by default. The `subagent.v1` profile ships read-only-tools-only (`read_file`, `read_lines`, `scan_file`, `search_in_files`, plus the retrieval surface). Write tools require explicit per-call opt-in (`tools: [..., 'edit_file']`) and surface a stronger warning on the approval card. The user-facing rationale: sub-agents are *investigators*, not *editors*, until the user proves otherwise.
- A "sub-agent picker" UI mirroring the chat-side profile picker. Sub-agents are *invoked by the parent agent*, not by the user; the profile they run under is a parent-agent argument, defaulting to `subagent.v1`.
- Sub-agent dispatching scripts via `submit_script_for_approval`. The Tier-0 Worker does not call other tools; sub-agents do not call the Worker. They are siblings, not nested.
- Auto-decomposition. The parent agent decides when to delegate; the harness does not detect "this would benefit from a sub-agent" and prompt. Auto-decomposition is a category error of the trust model (it would inject an LLM-authored decomposition step the user did not approve).
- Sub-agent profile creation by users. The four canonical sub-agent profiles (Phase 1 ships `subagent.v1`; Phases 2+ may add `subagent_reviewer.v1`, `subagent_summarizer.v1` if measured) are author-time-curated. The Phase 4 plugin-authored profile API in `DESIGN-profiles.md` is what unlocks user-defined sub-agent profiles, and that is far downstream of github#24's Phase 1.

---

## The Load-Bearing Decision: The Profile Is the Sub-Agent Trust Boundary

The most common failure mode in any "let the agent spawn an agent" surface is treating the gate as a *property of the call*: the parent supplies a `prompt`, the harness spawns an agent with the parent's full tool catalog, and trust transitivity does the rest. That is the wrong model. The parent agent's profile is already an admission decision the user made (via the picker at chat creation, per `ConversationManager.getActiveProfile()` shipped 2.8.0); a sub-agent that inherits the parent's full profile is a sub-agent that can do *anything the parent can*, including spawn its own sub-agent, including invoke `edit_file`, including invoke `submit_script_for_approval`. Trust inflates with depth.

The right seam is a **per-call profile binding**, where the *profile* — a named, data-only object that the user can read — is the trust boundary at the sub-agent level. `delegate_task({task, profile?})` defaults `profile` to `subagent.v1` (a new profile this design adds, read-only-tools-only, ~5 tools, no recursion); the parent may override to any registered profile name, but unknown names fall back to `subagent.v1` with a warn (mirroring `getActiveProfileName`'s pre-existing fallback). The sub-agent's tool admission then flows through *the standard tool admission path* — `Profiles.filterTools(defs, profileName)` — with no special-casing. A sub-agent calling `edit_file` from a `subagent.v1` profile gets the same role-violation envelope every other under-admitted tool call gets today (per `ToolRegistry.checkRoleAccess` at `js/tools/registry.js:159`).

This mirrors the §1.16.0 Tier-0 Worker security posture and the §2.10.0 Tier 3a preview boundary at the *profile* level:

| §1.16.0 Worker | §2.10.0 Preview Tier 3a | This design (sub-agent) | Why mirrored |
|---|---|---|---|
| Curated `globalThis` — forbidden globals throw | Bidirectional postMessage with selector-shaped tools — no `preview_eval` | `subagent.v1` profile's `tools.allowed_groups` — admitted tools only | All three deny the unbounded-effect surface by default; all three let the user widen explicitly via a separate gate. |
| User code runs in a Worker — `self.window` is undefined | User code runs in an iframe — `window.parent` is cross-origin and blocked | Sub-agent runs in a fresh `Conversation`-shaped context — parent's `State.chatHistory` is not in its messages array | All three put a hard boundary between user code's reach and the host's state. |
| Adapter layer (`Git.getFile`) is the *only* reach-back from the Worker | postMessage shim is the *only* reach-back from the iframe | Sub-agent's tool admission is the *only* reach-back into the harness | All three surfaces define a small, named, audited reach-back; nothing else. |
| Trust delta: the script can read what the chat already could | Trust delta: the iframe can render what the chat already could | Trust delta: the sub-agent can call what *its profile* admits — a strict subset of what the parent's profile admits | All three phrase the delta as bounded by a named, data-only declaration the user can read. |

The catalog stays the boundary at the tool level (sub-agent tools must be admitted, declared `readOnly` where applicable, registered in `js/tools/registry.js`). The profile stays the boundary at the sub-agent level (the child's tool catalog is `Profiles.filterTools(defs, 'subagent.v1')`, not `Profiles.filterTools(defs, parent.profile)`). Push back on this before building anything else.

This decision has three load-bearing implications:

1. **The default sub-agent profile is restrictive, not inherited.** `subagent.v1` does *not* inherit from `coder.v1` (`coder.v1` has write tools, plan mode, script automation, preview, all the structural anchors). It inherits from `chat.v1` (`chat.v1` is the lowest-config baseline; read-only tools and the meta-tools). The `subagent.v1` `tools.static` set is the explicit override: ~5 read tools, no editors, no commit ops, no plan/script/preview. (See *Decision §3* below for the exact set.)
2. **Profile override is an argument, not a feature flag.** A parent agent can pass `profile: 'coder.v1'` to `delegate_task` and get a coder-shaped sub-agent — but only if the user has approved that delegation at the approval-card stage, and only if `coder.v1` is a registered profile name. There is no "secret" profile, no plugin-shipped profile until the Phase 4 authoring API lands.
3. **Recursion is profile-bounded, not depth-bounded alone.** A sub-agent running `subagent.v1` cannot call `delegate_task` because `delegate_task` is not in `subagent.v1.tools.static`. Recursion (Phase 3) is unlocked by a different profile (`subagent_recursive.v1` if it earns its slot), not by a depth-counter knob.

These three are the load-bearing implications. The phasing in *Phasing* below is consistent with them; any phase that needs to violate them is a re-design, not a follow-up.

---

## Prerequisites and Gaps

This section names what the codebase currently lacks for sub-agent execution. Each gap is a load-bearing prerequisite for Phase 1; the *Phasing* section slots them.

### Gap 1 — No per-agent `Conversation` factory; the only conversation lifecycle is user-initiated

[`js/chat/conversations.js`](../js/chat/conversations.js) (`ConversationManager`) creates / loads / deletes conversations driven by user actions: `create()` clears `State.chatHistory`, `State.scratchpad`, `State.toolActionLog`, `State.todo` *globally*; `load()` replaces them; `save()` persists them to `conv-{id}` IDB keys. Every read site (system prompt assembly, tool admission, compression config, cost recording) consults `State.chatHistory` and `ConversationManager.getActiveId()` as the single source of truth.

There is no abstraction for "a fresh conversation that exists alongside the active one, has its own message array, its own profile binding, runs its own tool loop, and returns a result *without* becoming the active conversation." Every line of `handleGeneralRequest` in [`js/chat/handlers.js:366`](../js/chat/handlers.js) reads from or writes to `State.chatHistory` directly via `ChatHistoryStore`; the streaming UI (`addStreamingMessage`, `updateStreamingMessage`, `finalizeStreamingMessage`) is bound to DOM elements in the main chat panel; `ChatSummarizer`, `compactor-integration`, `getCompressedContextMessages` all read from `State.chatHistory`.

**Prerequisite for Phase 1:** introduce a `SubAgentContext` (new file: `js/chat/subagent-context.js`) that owns the in-memory state a single sub-agent needs — `messages: ChatMessage[]`, `profileName: string`, `toolActionLog: ToolActionEntry[]`, `cost: {tokens, dollars}`, `transcriptId: string` — without aliasing any of `State`'s global slots. The Phase 1 sub-agent loop reads / writes the context object, not `State`. The harness holds the active context in `State.subagents.tree[transcriptId]`; the UI reads from that namespace by ID.

This is the largest single piece of new code in Phase 1. It is not a fork of `ConversationManager` — `ConversationManager` is for user-facing conversations and stays unchanged. `SubAgentContext` is an inner object whose lifetime is bounded by a `delegate_task` call.

### Gap 2 — `handleGeneralRequest`'s tool loop is hard-bound to the user chat surface

[`js/chat/handlers.js:366-1190`](../js/chat/handlers.js) (`handleGeneralRequest`) is the existing tool loop. It is *also* the function that:

- Calls `addStreamingMessage` / `updateStreamingMessage` to render text into the DOM as it streams (lines 277, 458, 569, 1102–1116).
- Calls `addToolCallMessage` to render each tool result inline in the chat panel (line 792).
- Calls `addConsentCardMessage` for `memory_remember` consent (line 860).
- Records `recordToolInvocation` + `recordDiscoveryAdmissions` into the parent's `TaskLedger` (lines 809, 840).
- Drains the queued-input store between rounds (lines 1069–1078, github#33 Phase 2).
- Builds the message thread via `getCompressedContextMessages()` — which compactor over `State.chatHistory` (line 389).

A sub-agent loop needs *most* of this logic — the API call, the tool dispatch, the duplicate-detection cache, the truncation rules, the no-progress break — but *none* of the DOM coupling, the user-input drain, or the parent-conversation context read.

**Prerequisite for Phase 1:** extract the tool-loop core into a pure-ish function (new file: `js/chat/tool-loop-core.js`) that takes a `SubAgentContext` and a transport (`LLM.chat` is the only one for now), runs the loop, and returns a result. The existing `handleGeneralRequest` becomes a thin wrapper that constructs a parent-conversation context (whose backing store is `State.chatHistory`, mediated through `ChatHistoryStore`) and threads UI hooks (the addStreamingMessage / addToolCallMessage / addConsentCardMessage calls) through opt-in callbacks. This is a refactor sized as **M** in the audit's units (single PR, <500 LOC), but it is *not* in the Phase 1 PR's scope (see *Phasing* below — it is a precursor, Phase 0).

The extraction is the inventory entry [`audit-2026-Q2/inventory.md`](audit-2026-Q2/inventory.md) §"chat" *"Tool-name string-literals dotted around chat module"* names in the abstract — the chat module is over-bound to its single consumer. Subsuming this extraction into the audit sweep would slot the work alongside the 2.33.0–2.36.0 audit minors and produce one Phase 0 PR before Phase 1 starts. **This is the audit entry the design depends on; flag it during scoping.**

### Gap 3 — Tool admission already supports per-profile scoping, but not per-call scoping

The admission filter is well-factored. `LLMTools.getToolsForRole()` at [`js/llm/api.js:1025`](../js/llm/api.js) runs `Profiles.filterTools(defs, profileName)` (with `profileName` resolved via `getActiveProfileName(State.settings)` or `ConversationManager.getEffectiveProfileName()`); `ToolRegistry.checkRoleAccess` at [`js/tools/registry.js:159`](../js/tools/registry.js) runs the same filter at execute time. Both consult `Profiles.filterTools` from [`js/profiles/registry.js:231`](../js/profiles/registry.js).

What does *not* exist is a per-call scoping argument — a sub-agent that wants to run a sub-subset of `subagent.v1`'s already-narrow catalog (say, only `read_file` and `search_in_files`) has no shape today. The parent agent has no way to express "give the child reads but no writes" beyond picking a profile that already disallows writes.

**Prerequisite for Phase 1:** none, in terms of new code. `delegate_task`'s `tools?: string[]` argument is interpreted as an *intersection* with `Profiles.filterTools(defs, resolvedProfileName)`: the sub-agent's effective tool set is `intersect(per-call-allowlist, profile-admitted-set)`. If `tools` is omitted, the sub-agent sees the full profile-admitted set. The intersection happens in the `SubAgentContext` constructor; no change to `Profiles.filterTools`. Per-call argument is a refinement of the profile gate, never a widening of it.

### Gap 4 — No cost-store row for "sub-agent invocation"

The cost store at [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js) `recordTurn()` aggregates by conversation, day, and tool. Sub-agent token costs are naturally per-tool (the parent's `delegate_task` call is the tool), and the existing per-tool aggregation lands the sub-agent's *child* LLM-call tokens under `tool_name: 'delegate_task'` if the sub-agent's `LLM.chat` calls record into the same store with that tool name attached.

**Prerequisite for Phase 1:** the sub-agent's `LLM.chat` invocations need a `tool_name` annotation that flows into `_trackUsage` / `recordTurn`. Today `_trackUsage` reads `LLMDebug._current` for context. Threading a `costAttribution: 'delegate_task'` argument through `LLM.chat` for sub-agent calls (the only new call shape) routes the tokens into the existing dashboard axis. No new dashboard code. (Per-sub-agent-transcript drill-down is a Phase 2+ debug-UI concern; the per-tool axis is enough for v1.)

### Gap 5 — No UI affordance for showing a sub-agent's transcript or live state

The existing chat panel renders `State.chatHistory` via `messages.js`. The Notes tray ([`js/chat/scratchpad-panel.js`](../js/chat/scratchpad-panel.js) — 1.8.4) is the precedent for a slide-over Preact component bound to a `State.*` namespace. Touch 3 Window v2 makes the middle pane a *stage* and one of its modes is "task timeline" (see `docs/ROADMAP.md` §"Touch 3 deliverables"); a sub-agent transcript naturally lives in that mode. Pre-Window-v2 it lives as a slide-over.

**Prerequisite for Phase 1:** a minimal sub-agent transcript reader — a Notes-tray-shaped slide-over that, given a `transcriptId`, renders the sub-agent's messages, tool calls, cost, and final result. Read-only. Bound to `State.subagents.transcripts[transcriptId]`. New file: `js/chat/subagent-transcript-panel.js`. The tool-call card in the parent conversation grows a `[View sub-agent transcript]` button that opens the panel.

This is the smallest UI lift that lets a developer (or an attentive user) debug *why* a sub-agent went off the rails. It is not Window v2; it is a slide-over that Window v2 will subsume when it ships.

### Gap 6 — No per-invocation gate template that doesn't auto-execute on Approve

`submit_plan_for_approval` and `submit_script_for_approval` both have the same lifecycle: tool handler returns a Promise, card mounts, user picks Approve / Reject / Cancel, resolution flows back. The two existing tools differ in what Approve *does*: plan-mode lifts the constraint (`setPlanMode(false)` at [`js/chat/handlers.js:746`](../js/chat/handlers.js)); script-approval *runs the script* in the card's resolve path.

Sub-agents need a third variant: Approve *spawns the sub-agent and runs it to completion*, then resolves with the structured result. The user-pause budget (`USER_PAUSE_TOOLS`, 24h watchdog) covers both the approval wait and the sub-agent's own run time — but the run-time portion is *not* a user pause, it is an LLM run inside the harness. Two timeouts compose:

- **Approval timeout**: same as Plan Mode / Script Approval — `USER_PAUSE_TOOLS` 24h watchdog (`State.settings.userPauseTimeout`).
- **Sub-agent run timeout**: separate, per-call argument with a profile default (`subagent.v1.subagent.run_timeout_ms`, defaults to 5 minutes). If exceeded, the sub-agent's tool loop breaks, returns `partial: true` with whatever it has, and the parent reads a partial result.

**Prerequisite for Phase 1:** the sub-agent variant of the approval card (`js/chat/subagent-approval-card.js` + `js/chat/subagent-approval-card/SubAgentApprovalCard.js`, mirroring `script-approval-card.js`'s pair); the resolve path runs the sub-agent loop and resolves the Promise with the result envelope; the `USER_PAUSE_TOOLS` set gains `delegate_task` (one-line addition to `tool-classifications.js`).

### Gap 7 — Profile registry has no `subagent.v1`

Phase 1 ships `subagent.v1` (new file: `js/profiles/subagent-v1.js`), registered in `Profiles.get`/`has` via `js/profiles/registry.js`. *Not* in `ENTRIES` (the picker list) — same rationale as `chat_multi.v1` / `rp.v1` pre-2.8.0 promotion: a profile a user can pick only from inside a sub-agent invocation doesn't belong in the new-chat picker. `SYNTHETIC_ENTRIES` is the right slot.

The `subagent.v1` profile inherits from `chat.v1` (the lowest-config baseline) with explicit overrides for `tools.static`, `tools.allowed_groups`, `compression.rules`, `budget`, and a new top-level `subagent: {run_timeout_ms, max_tokens, max_dollars, recursion_depth}` block. The `subagent` block is read by the sub-agent loop the same way `scriptAutomation` / `preview` are read by their respective filter sites. (See *Decisions §1, §3, §6* below.)

### Gap 8 — No coordination between sub-agent and parent for in-flight cancellation

[`isToolLoopCancelled`](../js/chat/state.js) is module-scoped in `js/chat/state.js` (`isToolLoopCancelled` / `resetToolLoopCancel`); the parent agent's loop checks it before each round and breaks. A sub-agent loop needs its own cancellation signal — either share the parent's flag (a parent cancel kills the sub-agent too) or carry its own (the user can cancel just the sub-agent).

**Phase 1 decision:** the sub-agent shares the parent's `isToolLoopCancelled`. Cancelling the parent cancels the sub-agent. The approval card has a Cancel button that, when clicked while the sub-agent is *running* (after Approve), terminates the sub-agent and resolves with `{status: 'cancelled', partial: true, summary: '…', cost: {...}}`. Granular "cancel only the sub-agent, keep the parent running" is a Phase 2+ concern (it requires the parent to stay alive at the same moment the user is cancelling, which is the parallel-execution case).

### Gap 9 — Audit-track exposure of the `Tool-name string-literals` entry

[`audit-2026-Q2/inventory.md`](audit-2026-Q2/inventory.md) §"chat" entry *"Tool-name string-literals dotted around chat module"* (line 142) is still open. Today `js/chat/messages.js:725,775`, `js/chat/turn-enrich.js:76,86`, `js/chat/tools.js:29` all consume tool-name strings as keys. Sub-agents do not *create* this gap, but they make it worse: the new `delegate_task` tool name lands in the same blast radius (one of the message-render branches likely needs a `case 'delegate_task'` for the transcript-link button). Phase 1 either accepts the same coupling or graduates it via the audit sweep.

**Phase 1 decision:** accept the coupling; add `case 'delegate_task'` alongside the others; flag a follow-up audit entry if a third reviewer is uncomfortable. The audit row is the right place for that decision; this design names it so it is not silently exported into the sub-agent PR.

---

## Decisions

Resolved from the design pass. Numbered for cross-reference; load-bearing — the implementation honors them.

### Decision §1 — Sub-agent profile is data; `subagent.v1` ships first

A profile, not a runtime knob, names what a sub-agent can do. The first one is `subagent.v1`, a new entry in `js/profiles/subagent-v1.js`, registered through `js/profiles/registry.js` `SYNTHETIC_ENTRIES`. The shape:

```js
export const SUBAGENT_V1 = {
    name: 'subagent.v1',
    version: '1',
    base: 'chat.v1',

    // Lowered output reserve — sub-agents produce summaries, not edits.
    // Lowered history reserve — child contexts stay small; that's the point.
    budget: {
        total_tokens: 32000,
        system_reserve: 1500,
        output_reserve: 2048,
        history_reserve: 4000,
        memory_reserve: 0,   // No memory at sub-agent level — parent's memory is parent's concern.
    },

    retrieval: {
        // Inherited collections from chat.v1; sub-agent reads what the
        // chat surface reads. No memory_collections — sub-agents do not
        // mutate or read user memory by default.
        memory_collections: [],
        strategy_weights: { semantic: 1.0, structural: 0.0, thematic: 0.0 },
        novelty_threshold: 0.4,
    },

    memory: {
        default_scope: 'session',          // No persistent memory writes.
        propose_after_n_turns: null,
        capacity_warnings: { session: 0 }, // Don't admit memory_remember from inside a sub-agent.
    },

    compression: {
        // Rule 5 only — sub-agents are short-lived; subsumption /
        // invalidation are coder-shape rules whose value comes from
        // long tool-call sequences. A sub-agent that ran long enough
        // to need them is probably the wrong shape for delegation.
        rules: [{ name: 'summarization', priority: 50 }],
        preserve_recent: 4,
    },

    tools: {
        catalog: [],
        static: [
            // Read-only catalog. The intersection rule (Decision §4) lets
            // a parent call narrow this further per call.
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
        allowed_groups: ['all', 'subagent'],   // New group tag — see Decision §5.
    },

    task_ledger: {
        enabled: false,                     // No ledger at sub-agent level.
        capacity: 0,
        novelty_threshold: 0.4,
    },

    // Sub-agent-specific block. Mirrors `scriptAutomation` / `preview`
    // structurally; consumed by `resolveSubAgentConfig(profileName)`
    // (new export from `js/profiles/resolve.js`).
    subagent: {
        enabled: true,
        run_timeout_ms: 300000,            // 5 minutes — see Decision §6.
        max_tokens: 50000,                  // Per-call token cap; cumulative across rounds.
        max_dollars: 0.50,                  // Per-call dollar cap.
        recursion_depth: 0,                 // No recursion in v1.
    },
};
```

**Why** `base: 'chat.v1'` not `coder.v1`. `coder.v1` admits `edit_file`, `commit_files`, `submit_plan_for_approval`, `submit_script_for_approval`, all of the preview surface, and the structural-anchor tools (scratchpad / todo / ask_user). A sub-agent inheriting `coder.v1` would default to *the parent agent's full reach*. The point of the trust boundary in *The Load-Bearing Decision* is that the default is restrictive; the parent agent can override per-call.

**How to apply** — when a future profile (e.g. `subagent_reviewer.v1`) is added, it inherits from `subagent.v1` and overrides the slices it needs (different `tools.static`, different `subagent.run_timeout_ms`). The single-inheritance rule from `DESIGN-profiles.md` carries through; no multi-inheritance.

### Decision §2 — Context isolation: clean start with explicit attachments

A sub-agent does *not* see the parent's `State.chatHistory`. It does *not* see the parent's `State.scratchpad`. It does *not* see the parent's `State.toolActionLog`. Its `messages` array starts with:

1. A system prompt assembled from `subagent.v1` (or the per-call profile). Identical assembly path as the main chat — `buildSystemPrompt({admittedDefs, composerActive})` — just with the sub-agent's resolved profile name flowing through `getActiveProfileName` shape.
2. A first user message constructed from the `task` argument plus an optional `context_hint` (a free-form string the parent may use to embed quoted file paths, error snippets, or directives the sub-agent should treat as immediate task scope).
3. *No memory tool calls in the system prompt.* The sub-agent does not see `<MEMORY>` blocks. `.aieditor/memory/*.md` is parent-scoped state by design.

**Why** clean start, not deep-copy. Two reasons:

1. **Cost-collapse is the whole point.** A deep-copy parent context means the sub-agent pays the parent's token bill on every round of its own loop — exactly the inflation `delegate_task` is supposed to escape. Clean start preserves the cost-quality tradeoff lever named in `project_cost_quality_tradeoff.md`.
2. **Trust transitivity.** If a sub-agent saw the parent's prior tool results (including `memory_recall` returns, including untrusted-issue-wrapped GitHub content), the trust delta of a sub-agent invocation would inherit the parent's full security posture. Clean start means the sub-agent's input surface is auditable from one place: the `task` + `context_hint` strings the parent supplied, both visible on the approval card.

**Memory.** The Phase 1 sub-agent has *no* memory-tool admissions (`memory_remember`, `memory_recall`, `memory_revise` are not in `subagent.v1.tools.static`, and the `subagent` group does not admit them at the registration site). If a future profile (`subagent_research.v1`) needs read-only memory, it admits `memory_recall` explicitly. Write tools (`memory_remember`, `memory_revise`) are never admitted to a sub-agent profile in Phase 1; if they are ever admitted, the approval card must surface that fact.

**Tool action log.** The sub-agent runs its own `toolActionLog` inside the `SubAgentContext`. It does *not* write into `State.toolActionLog`. The duplicate-detection cache from the parent's loop (`toolCallCache`, `duplicateStreak`, the cross-request check via `findMatchingCrossRequestEntry`) is implemented in the sub-agent loop the same way, against its own log. Cross-request dup detection between parent and child *does not happen* — the child does not see the parent's log, and the parent does not see the child's. (This is correct: a sub-agent that re-reads a file the parent already read is doing its own work in its own context, and that's fine.)

### Decision §3 — Profile binding is an argument, default `subagent.v1`

`delegate_task({task, profile?, tools?, context_hint?, max_tokens?, max_dollars?, run_timeout_ms?})`:

- `profile`: optional string. Default `subagent.v1`. Must be `Profiles.has(profile)` registered; unknown names fall back to `subagent.v1` with a console.warn. The approval card surfaces the *resolved* profile name (including the fallback case so the user sees the warning).
- `tools`: optional string[]. Per-call allowlist; intersects with `Profiles.filterTools(defs, resolvedProfile).map(d => d.function.name)`. Unknown names are silently dropped (with diagnostic to `LLMDebug`). If omitted, the sub-agent sees the full profile-admitted set.
- `max_tokens` / `max_dollars` / `run_timeout_ms`: per-call overrides on the resolved profile's `subagent.{max_tokens,max_dollars,run_timeout_ms}`. Caller cannot raise above the profile's value; only lower. The minimum of {profile's value, argument's value} wins. Approval card surfaces the effective ceiling.

**Why argument-based, not profile-only.** Two reasons:

1. The parent agent's argument shape is the natural place to express "spawn me three sub-agents on these three different files." Each call carries its own `tools` slice. Encoding that as three profiles (`subagent_for_file_a.v1`, …) is profile inflation.
2. The user reviewing the approval card sees the call's specific arguments, not the profile's data. Per-call narrowing is auditable at the gate point.

**Validation** — the `delegate_task` tool handler validates these before mounting the approval card:

| Argument | Validation | On failure |
|---|---|---|
| `task` | non-empty string | tool returns `{error: '...'}` synchronously |
| `profile` | `Profiles.has(profile)` if set | fallback to `subagent.v1` + warn |
| `tools` | array of strings if set | unknown names dropped silently |
| `max_tokens` | positive integer ≤ profile's `max_tokens` | clamped to profile's value, warn |
| `max_dollars` | positive number ≤ profile's `max_dollars` | clamped to profile's value, warn |
| `run_timeout_ms` | positive integer ≤ profile's `run_timeout_ms` | clamped to profile's value, warn |
| `context_hint` | string, ≤ 16K chars | truncated to 16K with `…` |

### Decision §4 — Tool scoping is intersection, not union

The sub-agent's effective tool set is:

```
effective = Profiles.filterTools(ToolRegistry.getDefinitions(), resolvedProfile)
          ∩ (per-call `tools` allowlist OR [all-of-the-above when omitted])
```

This composes with the existing `ToolRegistry.checkRoleAccess` runtime gate at `js/tools/registry.js:159`. If the sub-agent somehow synthesizes a tool name not in `effective` (e.g. via text-format fallback parsing), the runtime gate catches it: the `checkRoleAccess` call returns `{allowed: false, reason: '...'}` because the resolved profile's `Profiles.filterTools` rejects the name. The sub-agent's tool loop returns that envelope as the tool result; the sub-agent learns it cannot call that tool.

**Composition correctness.** The runtime gate consults `ConversationManager.getEffectiveProfileName()`, which today reads from the *active* conversation. Inside a sub-agent loop, the active conversation is still the parent's (the user-facing one). The check must consult the *sub-agent context's* profile, not the parent's. The sub-agent loop calls `ToolRegistry.execute(toolName, args)` indirectly through `executeToolCall` (from `js/chat/tools.js`); a new entry-point — `ToolRegistry.executeWithProfile(toolName, args, profileName)` — runs the role check against the explicit profile name. The existing `execute` keeps the conversation-binding behavior unchanged.

**This is the minimum invasive change to the registry.** The existing surface stays intact; the new entry point is purely additive. The sub-agent loop is the only caller in Phase 1.

### Decision §5 — Admission tag: new `subagent` group

The profile contract's `tools.allowed_groups` is the user-auditable declaration of "what tag of tools this profile admits." `subagent.v1` declares `['all', 'subagent']`; tools that are explicitly intended for sub-agent use (none in Phase 1 — every tool admitted by `subagent.v1` is already tagged `'all'` or a broader role) carry `roles: ['subagent', ...]` and admit via the tag.

`Profiles.getKnownGroupTags()` (shipped 2.34.0) auto-extends the registration validator with new tags as profiles declare them, so no change to `js/tools/registry.js` validation is needed beyond the new profile literal landing.

**Why a new tag, not just `'all'`.** Two reasons:

1. **Future-proofing.** A future tool that the user wants admitted *only* inside a sub-agent (e.g. `summarize_file_for_parent`) needs a tag that does not appear on the main agent's profile. The `'subagent'` tag is the place.
2. **Documentation.** A grep for `roles: ['subagent']` is the canonical way to find tools intended for delegated use. Naming the tag now even when Phase 1 has no such tool keeps the contract complete.

### Decision §6 — Result aggregation: structured envelope with transcript ID

The sub-agent's tool loop returns:

```js
{
    status: 'completed' | 'partial' | 'cancelled' | 'rejected' | 'errored',
    summary: string,                         // Sub-agent's final text content.
    artifacts: Array<{
        type: 'file_ref' | 'text' | 'finding',
        ...                                  // Type-specific fields.
    }>,
    cost: {
        tokens_in: number,
        tokens_out: number,
        cache_read_tokens: number,
        cache_creation_tokens: number,
        dollars: number,
        rounds: number,
    },
    transcript_id: string,                   // Key into State.subagents.transcripts[].
    partial?: boolean,                       // True when budget/timeout cut the run short.
    error?: string,                          // Only when status === 'errored'.
    feedback?: string,                       // Only when status === 'rejected' (user-supplied at approval card).
}
```

**Why structured, not free-text.** The parent agent reads `summary` as the load-bearing answer; everything else is structured metadata the parent can ignore (and the model has a strong precedent for that shape: every existing tool returns structured JSON). `artifacts` is the seam for the sub-agent to surface "files I looked at" / "findings I want to anchor" without inflating `summary`; in Phase 1 it stays a thin convention (the sub-agent's system prompt asks it to populate `artifacts` when surfacing file references), and the registry-side parsing is permissive.

**Why a transcript_id rather than inline messages.** The parent's context window is the resource sub-agents are *supposed* to save. Putting the sub-agent's full transcript in the tool result throws the cost-collapse argument away. The transcript stays in `State.subagents.transcripts[transcript_id]`; the parent's tool result carries only the ID; the UI surfaces a `[View transcript]` link on the tool-call card; the sub-agent transcript panel reads from the namespace by ID.

**How the parent reads it.** The `delegate_task` tool result is JSON-serialized into the parent's `tool_result` turn the same way every other tool result is (per `js/chat/handlers.js:886-942`). The parent agent reads `summary` and acts. `artifacts` is informational. `cost` is informational (visible to the model so it learns when delegation is paying off). `transcript_id` is intended for the *human reviewer*, not the model.

### Decision §7 — Cost gating: profile cap, per-call cap, per-session aggregate

Three ceilings compose:

1. **Per-call token cap** (`subagent.v1.subagent.max_tokens`, default 50000). The sub-agent's loop checks `cost.tokens_in + cost.tokens_out` before each `LLM.chat` round; if the next round's estimate (via `estimateInputTokens` from `js/llm/pacer.js`) would exceed the cap, the loop breaks and returns `partial: true`.
2. **Per-call dollar cap** (`subagent.v1.subagent.max_dollars`, default 0.50). Same check shape, against the running `cost.dollars`.
3. **Per-session aggregate cap** — `State.subagents.session_cost.dollars`. A simple sum across all sub-agent calls in the current parent conversation. The cap is `State.settings.subagentSessionCap` (default $5.00, user-editable in Settings → Tools alongside the existing `scriptAutomation` and `preview` rows). When exceeded, `delegate_task` *synchronously* returns `{error: 'session_cap_exceeded', message: '...'}` — *before* the approval card mounts, so the parent agent gets the rejection in the tool_result the same turn.

**Why three ceilings.** The per-call caps protect against one runaway sub-agent. The per-session cap protects against ten reasonable sub-agents that compound into a non-reasonable bill. The 24h `userPauseTimeout` watchdog (existing) protects against approval-card mount failures.

**Cost-dashboard integration.** Per-call tokens are recorded into the existing cost store with `tool_name: 'delegate_task'` via the per-tool axis (no dashboard change). Per-sub-agent transcripts are *not* dashboard rows in Phase 1; they live in the debug panel. The cost dashboard surfaces "you spent $X on delegate_task today" by aggregating the existing per-tool series; that is sufficient for the cost-discoverability goal.

### Decision §8 — Debugging surface: transcript panel + tool-call card link

The Phase 1 debug surface is intentionally small:

1. **Tool-call card** (`addToolCallMessage` in `js/chat/messages.js`): grows a `[View sub-agent transcript]` link when `toolName === 'delegate_task'`. The link opens the transcript panel.
2. **Sub-agent transcript panel** (`js/chat/subagent-transcript-panel.js`): a Notes-tray-shaped slide-over, read-only. Renders the sub-agent's messages, tool calls, cost summary, final result envelope. Reads from `State.subagents.transcripts[transcriptId]`.
3. **Cost dashboard** (existing): per-tool axis already groups by `tool_name`; no change.
4. **LLM Debug modal** (existing): the parent agent's `LLMDebug._current` accumulates diagnostics from sub-agent rounds with a `subagent_id` annotation. No new modal; same modal, additional fields. (See *Open Questions* — there is an open question about per-sub-agent isolation of `LLMDebug` that deserves an implementation-time decision.)

**Touch 3 Window v2 (post-2.0):** when the middle pane becomes a stage, "task timeline" is a stage mode that subsumes the slide-over. The Phase 1 panel is a tactical implementation that Window v2 will replace; the namespace (`State.subagents`) is durable.

### Decision §9 — Phasing is profile-gated, not depth-gated

Phase 1: `subagent.v1`, single non-recursive sub-agent per `delegate_task` call. Cannot fan out; the tool is *registered but not admitted* for any profile other than `coder.v1` (Phase 1 ships `delegate_task` admission into `coder.v1.tools.static`). Cannot recurse: `subagent.v1.tools.static` does not include `delegate_task`.

Phase 2: parallel calls. The parent agent issues N `delegate_task` calls in the same round; the harness mounts N approval cards (or one combined card — see *Open Questions*), the user approves them (singly or in batch), each runs against its own `SubAgentContext`, results land as N tool_results in the parent's next round. Same `subagent.v1` profile. No recursion. New profile may or may not be needed (depends on whether the existing per-call args are enough to express the per-call variation).

Phase 3: recursion. New profile `subagent_recursive.v1` inheriting from `subagent.v1` with `delegate_task` in `tools.static` and `subagent.recursion_depth > 0`. The harness enforces depth budget: a sub-agent at depth N cannot delegate further when `N >= profile.subagent.recursion_depth`. The recursion depth is a profile property (auditable), not a runtime flag.

**Why profile-gated.** A depth counter alone is bypassable by a buggy harness or an unaudited follow-up PR; a profile that does not admit `delegate_task` cannot recurse no matter what the harness does. The trust boundary is where the data is, not where the counter is.

### Decision §10 — Approval gate default: ON for Phase 1, configurable for Phase 2+

Phase 1 mounts a `SubAgentApprovalCard` for every `delegate_task` call. The user picks Approve / Reject / Cancel; only Approve runs the sub-agent. Plan Mode applies as well: in Plan Mode, the `delegate_task` tool is admitted (it is `readOnly: true` — the handler returns a Promise; the side effect is the sub-agent's read-only tool loop), and the approval card surfaces the Plan-Mode banner.

Phase 2+ may add `profile.subagent.auto_approve_when` — a list of declarative conditions (e.g. `[{predicate: 'cost.max_dollars <= 0.05', match: 'all'}]`) under which the approval card auto-resolves Approve. This is *exactly* the shape that `submit_script_for_approval`'s `Out of Scope` block (line 213) calls a category error of the trust model — and that is the right framing for a *script* whose source is the effect. For a sub-agent whose tools are admitted-by-profile and whose blast radius is bounded by the profile, the auto-approve case is less radical (the effect is bounded by data the user already approved when picking the parent's profile). But it is still a downstream decision, gated on Phase 1 producing a corpus of cheap, low-risk sub-agent calls where the approval click is just friction. **Phase 1 commits to: approval always on.**

---

## API and Lifecycle

The full mapping, mirroring `DESIGN-llm-authored-automation.md` §"Prior Art: Plan Mode Lifecycle Mapping":

| Plan Mode (1.10.0) | Script Approval (1.16.0) | Sub-Agent Delegation (this doc) | Notes |
|---|---|---|---|
| Model is in Plan Mode (entered via `setPlanMode(true)`) | No mode equivalent — always available when profile enables | No mode equivalent — admission via `coder.v1.tools.static` and `subagent.enabled` profile flag | Sub-agent delegation is not a mode; it is a tool. |
| Model calls `submit_plan_for_approval({plan: "..."})` | Model calls `submit_script_for_approval({source, description, expected_output})` | Model calls `delegate_task({task, profile?, tools?, context_hint?, max_tokens?, max_dollars?, run_timeout_ms?})` | Args validate; on validation failure, tool returns `{error: '...'}` synchronously. |
| Tool handler validates, returns Promise that `PlanApprovalCard` resolves | Tool handler validates, returns Promise that `ScriptApprovalCard` resolves *and runs the script* | Tool handler validates, returns Promise that `SubAgentApprovalCard` resolves *and runs the sub-agent loop* | Identical mechanism; resolve-path difference is what gets run. |
| `EventBus.emit('plan_approval:pending', ...)` mounts the card | `EventBus.emit('script_approval:pending', ...)` mounts the card | `EventBus.emit('subagent_approval:pending', ...)` mounts the card | New `state.js` slot `pendingSubAgentApproval`; new helpers `setPendingSubAgentApproval` / `cancelSubAgentApproval` mirroring the existing pair. |
| Card renders plan as markdown | Card renders source via CodeMirror read-only + description as markdown | Card renders task + context_hint as markdown, plus a *capability summary* (resolved profile name, admitted tools, ceilings) | The capability summary is the security-load-bearing view. The user sees what the sub-agent *can* call, not just what the parent *asked it to do*. |
| User clicks Approve → `resolvePlanApproval({status: 'approved'})` | User clicks Approve → script runs in sandbox → `resolveScriptApproval({status, output, stderr, ...})` | User clicks Approve → sub-agent loop runs → `resolveSubAgentApproval({status, summary, artifacts, cost, transcript_id, ...})` | The card stays mounted between Approve click and resolution; the sub-agent transcript live-updates in the panel as it runs (see Decision §8). |
| User clicks Reject → `resolvePlanApproval({status: 'rejected', feedback})` | User clicks Reject → `resolveScriptApproval({status: 'rejected', feedback})` | User clicks Reject → `resolveSubAgentApproval({status: 'rejected', feedback})` | Sub-agent does not run. Parent agent gets the feedback in the tool_result and re-plans. |
| User clicks Cancel / Stop → `cancelPlanApproval()` resolves with `cancelled` | Cancel during run → terminate Worker → `cancelScriptApproval()` | Cancel pre-run → reject; cancel during run → set `isToolLoopCancelled` (shared with parent) → sub-agent loop breaks → `cancelSubAgentApproval({status: 'cancelled', partial: true, summary, cost, transcript_id})` | Shared cancellation signal in Phase 1 — see Gap 8. |
| Approval lifts Plan Mode automatically | No mode lift | No mode lift; Plan Mode (if active) stays on across the sub-agent call | Sub-agent gates do not gate anything else. |
| `handlers.js` bypasses 30s `USER_PAUSE_TOOLS` timeout while the card is up | Same | Same — `delegate_task` joins `USER_PAUSE_TOOLS` | One-line addition. |
| Tool result lands as a `tool_result` turn | Tool result with structured `{stdout, stderr, runtime_ms, truncated}` | Tool result with structured `{status, summary, artifacts, cost, transcript_id, ...}` | Compression sees this turn the same as any other tool result. The sub-agent's *transcript* (in `State.subagents.transcripts`) is not part of the parent's chat history. |

### Lifecycle, step by step

1. **Parent agent calls `delegate_task({...})`.** The tool handler validates arguments (Decision §3). On validation failure, returns `{error: '...'}` synchronously; the parent agent's tool loop sees the envelope and re-tries with corrections.

2. **Session-cap check.** If `State.subagents.session_cost.dollars + estimated_cost > State.settings.subagentSessionCap`, return `{error: 'session_cap_exceeded', ...}` synchronously. No card mounts.

3. **Profile resolution.** `resolvedProfileName = Profiles.has(args.profile) ? args.profile : 'subagent.v1'`. Resolve config via `resolveSubAgentConfig(resolvedProfileName)` (new export from `js/profiles/resolve.js`, mirroring `resolveScriptAutomationConfig` / `resolvePreviewConfig`).

4. **Per-call clamping.** `effective.max_tokens = min(profile.max_tokens, args.max_tokens ?? profile.max_tokens)`; same for `max_dollars`, `run_timeout_ms`. Each clamp emits a warn if the argument was higher than the profile's.

5. **Tool intersection.** `effectiveTools = intersect(Profiles.filterTools(defs, resolvedProfileName).map(name), args.tools ?? all)`.

6. **Construct `SubAgentContext`.** `{ transcriptId, profileName, effectiveTools, costCeiling, task, contextHint, messages: [], toolActionLog: [], cost: {...zeros}, status: 'pending_approval', parentCancelSignal: <ref to parent's isToolLoopCancelled> }`. Stash it in `State.subagents.tree[transcriptId]` and `State.subagents.transcripts[transcriptId]`.

7. **Mount approval card.** Handler returns `new Promise(resolve => setPendingSubAgentApproval({ transcriptId, resolve }))`. The card reads from `State.subagents.transcripts[transcriptId]` and renders task + context_hint + capability summary (profile, admitted tools, ceilings).

8. **User action.**
   - **Approve** — the card's resolve path:
     1. Sets `context.status = 'running'`.
     2. Constructs the sub-agent's initial `messages`: `[{role: 'system', content: subagentSystemPrompt}, {role: 'user', content: task + (context_hint ? '\n\n' + context_hint : '')}]`.
     3. Runs the tool-loop core (Gap 2 extraction) against the context. Each round: streams response; parses tool calls; intersects against `effectiveTools`; invokes `ToolRegistry.executeWithProfile(toolName, args, resolvedProfileName)` (Decision §4); appends `tool_result` turn; checks cost ceiling; checks timeout; checks no-progress streak.
     4. On natural completion: sets `context.status = 'completed'`, populates `context.summary`, `context.artifacts`, `context.cost`. The card live-updates throughout.
     5. Card resolves with the result envelope. Parent's `delegate_task` Promise resolves; parent's tool loop continues.
   - **Reject** — card resolves immediately with `{status: 'rejected', feedback, transcript_id}`. No sub-agent runs. Parent reads `feedback` in the tool_result.
   - **Cancel pre-run** — same as Reject but `status: 'cancelled', feedback: null`.
   - **Cancel during run** — sets `parentCancelSignal` (shared); the sub-agent loop's per-round `isToolLoopCancelled` check breaks; the card's resolve path finalizes with `{status: 'cancelled', partial: true, summary, cost, transcript_id}`.

9. **Cost recording.** The sub-agent loop's `_trackUsage` calls (inside the extracted tool-loop core) thread `costAttribution: 'delegate_task'` through `LLM.chat`. Costs land in the existing cost store under `tool_name: 'delegate_task'`. The cost-dashboard renders them naturally.

10. **Parent reads result.** The `delegate_task` tool_result turn JSON-serializes the envelope (per `js/chat/handlers.js:886-942`). Parent agent reads `summary` and continues. Compression sees this turn the same way it sees any other tool_result.

11. **Persistence.** On `ConversationManager.save()`, `State.subagents.transcripts` of the active conversation persist into the `conv-{id}` payload (new field: `subagentTranscripts`). On `load()`, they restore. On `delete()`, they discard. Cross-session persistence is out of scope (Decision §9 phasing).

### Approval-card capability summary

The card's load-bearing view is the **capability summary** — what the sub-agent *can do*, not just what the parent *asked it to do*. The summary block contains:

```
Profile:           subagent.v1            (✓ registered)
Admitted tools:    read_file, read_lines, scan_file, search_in_files,
                   list_dirty_files, list_tool_categories,
                   list_tools_by_category, find_tool
Per-call narrow:   (none)                  or: read_file, scan_file
Cost ceiling:      50,000 tokens / $0.50
Run timeout:       5 minutes
Recursion:         disabled
Memory:            ✗ no memory tool admissions
Write access:      ✗ no write tools admitted
```

If the parent agent passed `profile: 'coder.v1'`, the summary changes — and the user can see *exactly* what changed before approving. This is the security-load-bearing UI element.

---

## Phasing

**Phase 0 — Tool-loop extraction.** Refactor `handleGeneralRequest` to factor the tool-loop core into a reusable function (Gap 2). Multi-file refactor, no new tool, no behavior change for the existing chat surface. Sized as **M** in audit units (<500 LOC). This is the prerequisite for Phase 1 and is *not* in the Phase 1 PR. Slotted into the audit sweep track (Now/Next/Later below — *Next*).

**Phase 1 — Single non-recursive sub-agent on `subagent.v1`.** First ship. The smallest useful PR:

| | |
|---|---|
| **Profile** | `js/profiles/subagent-v1.js`, registered in `Profiles.get`/`has` via `js/profiles/registry.js` `SYNTHETIC_ENTRIES`. Not in the picker. |
| **Resolver** | `resolveSubAgentConfig(profileName)` added to `js/profiles/resolve.js`, mirroring `resolveScriptAutomationConfig`. |
| **Tool** | `delegate_task` registered in `js/tools/subagent-tools.js`. `readOnly: true` (the handler returns a Promise; the side effect is gated by the approval card and bounded by the profile). `roles: 'all'`. Admitted into `coder.v1.tools.static` (the only Phase 1 admission). |
| **Sub-agent state** | `State.subagents = {tree: {...}, transcripts: {...}, session_cost: {dollars: 0, tokens: 0}}` new top-level slot in `js/core.js#State`. |
| **Pending-approval state** | `pendingSubAgentApproval` single-slot in `js/chat/state.js`; `setPendingSubAgentApproval` / `cancelSubAgentApproval` helpers. |
| **Approval card** | `js/chat/subagent-approval-card.js` + `js/chat/subagent-approval-card/SubAgentApprovalCard.js`, mirroring `script-approval-card.js`'s pair. Renders task + context_hint + capability summary. |
| **Transcript panel** | `js/chat/subagent-transcript-panel.js`, mirroring `scratchpad-panel.js`'s lifecycle. Read-only slide-over; renders by `transcriptId`. |
| **Tool-call card link** | `js/chat/messages.js` `addToolCallMessage` grows a `[View sub-agent transcript]` button for `toolName === 'delegate_task'`. |
| **Registry entry-point** | `ToolRegistry.executeWithProfile(toolName, args, profileName)` added; existing `execute` unchanged. |
| **Cost integration** | `LLM.chat` accepts `costAttribution?: string`; sub-agent loop passes `'delegate_task'`. `_trackUsage` and `recordTurn` thread it through (one new optional field; default-null preserves the existing per-conversation aggregation). |
| **Classification sets** | `USER_PAUSE_TOOLS` in `js/chat/tool-classifications.js` grows `'delegate_task'`. |
| **Profile gating** | `applySubAgentToolFilter` in `js/llm/api.js` `getToolsForRole` drops `delegate_task` when `subagent.enabled === false` on the resolved profile (`coder.v1.subagent.enabled = true`; `chat.v1.subagent.enabled = false`). Mirror of `applyScriptAutomationFilter` / `applyPreviewToolFilter`. |
| **Settings UI** | One row in Settings → Tools: enable `subagent.enabled` (per-profile overlay), edit `subagentSessionCap` (workspace-wide dollar cap). Two-view contract per `DESIGN-profiles.md` Appendix B. |
| **Persistence** | `conv-{id}` payload grows `subagentTranscripts` field. `ConversationManager.save` / `load` round-trip it. |
| **System prompt addendum** | New `SUBAGENT_INSTRUCTIONS` block in `js/prompts.js`, gated on `delegate_task` admission. Tells the parent agent when to use it (single dense task with one clear answer, not for "do X for me" generalized work). Per `feedback_prompts_js_parallel_enumeration.md` — the addendum is *required* alongside admission, not optional. |
| **Tests** | One Node `tests/test-subagent-tools.mjs` for the registry/handler shape and clamping logic. One Node `tests/test-profile-subagent-resolve.mjs` for `resolveSubAgentConfig`. One browser test for the approval-card round trip with a fixture loop. CI auto-globs the `.mjs` tests. |
| **CHANGELOG** | New `### Feature` block under the version this lands at. |

**PR-size estimate:** *Feature minor.* Same shape as the 1.16.0 / 1.22.0 / 2.7.0 / 2.10.0 PRs. Rough sizing: 10–14 files net new (profile + resolver + tool + 2 state-helper files + approval card pair + transcript panel + registry entry-point + classification update + prompts addendum + 3 tests + docs), ~1200–1800 LOC, no migrations. Target: a single feature minor (bumps the minor version), not a multi-PR arc.

The Phase 0 extraction PR lands *first* (audit-sweep track); Phase 1 lands next as its own feature minor.

**Phase 2 — Parallel sub-agents.** Same `subagent.v1` profile; the parent agent issues N `delegate_task` calls in a single round. The harness aggregates approval (single batched card listing all N pending sub-agents, with per-row Approve / Reject / Cancel; or N independent cards — see *Open Questions*). Each runs in its own `SubAgentContext`; results land as N independent `tool_result` turns in the parent's next round. Cost ceilings still per-call; session cap still applies across all of them.

Gated on Phase 1 dogfood evidence that the bottleneck on a real task shape is *serial* sub-agent calls, not the single-agent case. Without that evidence Phase 2 is premature.

**Phase 3 — Recursive sub-agents.** New profile `subagent_recursive.v1` inheriting from `subagent.v1` with `delegate_task` in `tools.static` and `subagent.recursion_depth > 0`. The harness enforces depth budget; the profile, not the harness, declares the depth ceiling. May or may not ship — gated on Phase 2 surfacing a measured class of task where two-level decomposition outperforms single-level. The current dogfood corpus does not surface such a task; this phase may stay parked.

**Phase 4 — Auto-approve per-profile.** `profile.subagent.auto_approve_when` — a list of declarative predicates over the call's resolved fields (`cost.max_dollars`, `tools` slice, `profile` name). If all predicates pass, the approval card auto-resolves Approve without mounting. Gated on Phase 1 producing a corpus of low-risk, low-cost sub-agent calls where the approval click is friction and the failure mode of a wrong-auto-approve is bounded by the profile's tools.

**Phase 5 — Cross-session sub-agent persistence.** Promote sub-agent transcripts from session-scoped to durable workspace storage; surface a "past sub-agent runs" view. Gated on a consent design. Plausibly subsumed by Touch 3 Window v2 Sessions.

**Phase 6 — Background sub-agents.** Sub-agents that the parent agent "kicks off" and polls for completion, with the user free to keep typing in the parent conversation. Requires Window v2 Sessions (a sub-agent is naturally a session-shaped object); not before. May never ship if Sessions subsumes it.

The phased delivery is intentionally back-loaded with "may never ship" gates, mirroring `DESIGN-llm-authored-automation.md` §"Phased Delivery" and `DESIGN-preview.md` §"Phased Delivery". The first ship is the only one this design commits to; everything else is a question Phase 1's data will answer.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **A sub-agent re-discovers what the parent already knows.** The parent's chat history is invisible to the sub-agent (Decision §2); a sub-agent asked to "read foo.js and tell me X" may re-`read_file` a file the parent has already cached in `State.toolActionLog`. | Medium. Wastes tokens. | The parent agent's prompt is the steering: a well-formed `delegate_task` call includes `context_hint` with the relevant excerpt or path-and-line range. The Phase 1 prompt addendum tells the parent to put pre-computed context in `context_hint` rather than expecting the sub-agent to recompute. Cost-quality tradeoff visible in the dashboard. |
| **The parent agent over-delegates.** A model with `delegate_task` admitted may use it for tasks better served by a direct `read_file`. | Medium. Wastes tokens. | Phase 1 prompt addendum: "Use `delegate_task` for tasks where the intermediate tool results would inflate your context without informing your final answer. For a single read, use `read_file`. For a single grep, use `search_in_files`. For tasks with 5+ planned tool calls whose intermediate results you do not need to retain, delegate." Cost dashboard surfaces over-delegation as a high `delegate_task` row with low total task throughput. |
| **The sub-agent enters an infinite tool loop.** Same risk as the parent loop. | Medium. Bounded by the cost ceiling. | Per-call `max_tokens` / `max_dollars` / `run_timeout_ms` (Decision §7) all break the loop. Plus the existing no-progress-streak break (`NO_PROGRESS_LIMIT = 3` per `handlers.js:412`) applies to the sub-agent loop too (via the extracted core). Plus the cancellation signal. Triple-bounded. |
| **An approved sub-agent runs against a profile the user did not expect.** A model passes `profile: 'coder.v1'` (which admits writes) and the user does not notice on the approval card. | High. Trust failure. | The capability summary on the approval card (Decision §8) is the load-bearing UI element. The user sees the profile name AND the admitted tools list AND a `Write access: ✓` indicator (with color emphasis when ✓). Defaulting to `subagent.v1` (Decision §3) means the "expected" case is read-only. Profile override is the *exception*, surfaced explicitly. |
| **A sub-agent's tool result leaks parent state.** The sub-agent's structured `summary` could include content from a file the parent has not yet been authorized to read (e.g. in a multi-workspace future). | Low for Phase 1 (single workspace). | Phase 1's read tools all read from the same workspace as the parent. Multi-workspace sub-agents are Phase 6+ territory; consent / scope design is part of that phase's design. |
| **The approval card mounts but never resolves (DOM error, Preact crash).** Same risk as Plan Mode / Script Approval. | Low. | `USER_PAUSE_TOOLS` watchdog (`State.settings.userPauseTimeout`, default 24h) covers it. Sub-agent inherits this floor by joining `USER_PAUSE_TOOLS`. |
| **The cost store gets confused about which costs are parent-vs-child.** Records under `tool_name: 'delegate_task'` are unambiguously the *sub-agent's child LLM call cost*; the parent's `delegate_task` *tool result* charges nothing extra to the parent's row (the tool result token cost is normal `tool_result` accounting against the parent's conversation, which the parent already pays for). | Low. | The per-tool axis in the existing dashboard already groups by tool name; this slots in naturally. The transcript panel exposes a per-sub-agent breakdown for human review. |
| **A sub-agent triggers a `submit_plan_for_approval` it should not.** `subagent.v1.tools.static` does not admit `submit_plan_for_approval`, so this cannot happen by default. A custom profile that admits it would surface the call as a Plan Mode approval card *in the parent's UI* (because the approval state is module-scoped in `js/chat/state.js`), confusing the user. | Medium for custom profiles only. | Phase 1 does not ship custom sub-agent profiles. When Phase 4 (plugin-authored profiles) lands, the gate is: sub-agent profiles cannot admit tools whose lifecycle involves a user-pause approval card *other than the sub-agent's own*. Encoded as a profile-validation rule. |
| **Concurrent sub-agents (Phase 2) race on `State.subagents.session_cost`.** Two sub-agents reading-and-incrementing the cost slot simultaneously. | Medium for Phase 2. | The existing `KeyMutex` adoption in `cost-store.js` (`recordTurn` serializes its read-modify-write per storage key) is the precedent. Phase 2 design includes per-session-cost mutex. Phase 1 (single sub-agent) does not need it. |
| **The extracted tool-loop core (Phase 0) regresses on the parent surface.** Refactoring `handleGeneralRequest` is non-trivial; behavior parity is the load-bearing test. | High for Phase 0. | Phase 0 PR ships with a pinning test: a recorded parent-loop session (fixture inputs + recorded LLM responses + expected tool calls + final history shape) replays through the extracted core and asserts byte-for-byte parity. Approach mirrors `tests/test-profile-filter-tools.mjs`'s cross-product equivalence pin. |
| **Sub-agent transcripts grow large.** A 5-minute sub-agent run can accumulate dozens of tool calls and many KB of `tool_result` content. The transcript persists into `conv-{id}` payload. | Medium long-term. | Transcripts persist with a hard cap on retained tool_result content (truncate to 12K chars per turn, same scale as the parent's `TOOL_RESULT_LIMIT`). Full transcript is only retained while the sub-agent is running; on resolve, results are truncated for persistence. The dashboard shows the cost; the panel shows the summary; the full intermediate state is reproducible by re-running the sub-agent. |
| **The `subagent` admission tag gets confused with a future user-facing role.** A new tool registered with `roles: ['subagent']` would not appear in `chat.v1` or `coder.v1` admissions but would silently appear in `subagent.v1`. | Low. | The validator at `js/tools/registry.js:91` (`Profiles.getKnownGroupTags`) auto-extends from profile data, so the tag is known. The `subagent` tag is documented in this design and in `DESIGN-profiles.md` once that doc is updated. New tools must declare their `roles` explicitly; a tool registered with `roles: ['subagent']` is opting in to sub-agent-only admission deliberately. |

---

## Out of Scope (For the First Ship — and Possibly Forever)

The next implementer will be tempted to pull these in. The design says no.

- **Auto-decomposition.** The parent agent decides when to delegate; the harness does not detect "this looks like a sub-agent task" and prompt. Trust inversion.
- **Background sub-agents.** Sub-agents that the parent fires and polls. Requires Sessions (Window v2). Phase 6+ at the earliest.
- **Cross-session sub-agent corpus persistence.** Transcripts discard on `delete()`; a future cross-session view is its own consent design (Phase 5).
- **Sub-agents that authoring users define.** User-shipped sub-agent profiles require the Phase 4 plugin-authored profile API in `DESIGN-profiles.md`. Far downstream.
- **Sub-agents that nest beyond Phase 3's profile-gated depth.** No `recursion_depth: ∞` profile. Hard ceiling.
- **`chat_multi.v1` / `rp.v1` integration.** These are deprioritized for ai-editor per `feedback_chat_multi_rp_no_utility_in_aieditor.md`; sub-agents do not unlock them.
- **Sub-agents with write tools by default.** `subagent.v1` does not admit `edit_file`, `commit_files`, etc. Profile overrides are explicit, audited at the approval card.
- **Sub-agent dispatching scripts via `submit_script_for_approval`.** Tier-0 Worker is a sibling, not a child. A sub-agent that needs a script is asking for the wrong tool.
- **A "sub-agent picker" UI mirroring the chat-side profile picker.** Sub-agents are invoked by the parent agent. The profile is an argument.
- **Per-sub-agent retrieval index.** Sub-agents share the parent's retrieval index (read-only); they do not maintain a separate one.
- **Auto-graduation of recurring sub-agent shapes to dedicated tools.** Mirrors the `submit_script_for_approval` graduation question; deferred until Phase 1 has produced a corpus to measure. Not Phase 1.
- **A `LLMDebug` per-sub-agent isolation.** Phase 1 threads sub-agent diagnostics into the same `LLMDebug._current` with a `subagent_id` annotation. Per-sub-agent isolation is a Phase 2+ debug-UI lift.
- **Sub-agents that can call `ask_user`.** Sub-agents do not have a UI mount to render `AskUserCard` in. The user cannot answer a sub-agent's question because they did not start the sub-agent's conversation. `ask_user` is not in `subagent.v1.tools.static`. A future "interactive sub-agent" is a different design.

---

## Open Questions

What this design pass could not resolve. Each must be answered before code starts.

| Question | Why open | Who answers it |
|---|---|---|
| Should the approval card for parallel sub-agents (Phase 2) batch into one card or mount N? | One card has lower friction (Approve all / Reject all / Approve individually). N cards have stronger per-call visibility. | Phase 2 design pass; not Phase 1. |
| Default `subagent.v1.subagent.run_timeout_ms` | 5 minutes is a guess. Some reading tasks may want longer; the cost ceiling is the harder gate either way. | Implementation default; revisit after Phase 1 dogfood. |
| Default `subagent.v1.subagent.max_tokens` and `max_dollars` | 50K tokens / $0.50 is a guess based on a sub-agent doing ≤10 read tool calls. The actual right number is empirical. | Implementation default; revisit after Phase 1 dogfood. |
| Default `State.settings.subagentSessionCap` | $5/session feels right for a coder workflow with ~10 sub-agent calls. Too low and reasonable workflows error; too high and the cap is decorative. | Implementation default; revisit after Phase 1. |
| Should sub-agents see the parent's `<PROJECT_CONVENTIONS>` block? | The CLAUDE.md analogue is project-wide trusted content, not parent-specific. Including it in the sub-agent's system prompt is the right default; excluding it isolates the sub-agent from project conventions. | Default: include. Revisit if dogfood shows it's misleading the sub-agent. |
| How does `LLMDebug` partition between parent and sub-agent diagnostics? | The current `LLMDebug._current` is single-slot; nested loops will overwrite. | Phase 1 threads `subagent_id` into diagnostic entries; the debug modal groups by it. Per-loop isolation is a Phase 2 UI lift. |
| What does the sub-agent's UI surface look like in Touch 3 Window v2? | Window v2 makes the middle pane a stage; a sub-agent transcript is naturally a stage mode. | Window v2 design pass (post-2.0). Phase 1 ships a slide-over that Window v2 subsumes. |
| Should the per-call `tools` allowlist be model-friendly (full names, fuzzy matching, dropped silently) or strict (exact match, error on unknown)? | Strict is auditable; lenient is forgiving. | Default: silent drop with `LLMDebug` diagnostic. Strict for Phase 2 if Phase 1 dogfood shows the model is dropping admissions through typos. |
| Should `delegate_task` charge the parent conversation's cost row in addition to the sub-agent's `tool_name: 'delegate_task'` row? | Today's per-conversation cost axis aggregates over `tool_name`. The sub-agent's costs already land in the conversation's row via the per-tool group. A separate "delegate_task overhead" line item is double-counting. | Default: no double-count; the per-tool row IS the parent conversation's row aggregated. Revisit if the dashboard's per-conversation view confuses users. |
| Should the transcript panel auto-open when a sub-agent runs, or only on click? | Auto-open is glanceable. Click-only is unobtrusive. | Default: click-only. The tool-call card link is the affordance. Notes-tray precedent agrees. |

---

## Failure Modes

Cataloging what fails and how, mirroring the structure in `DESIGN-llm-authored-automation.md` §"Failure Modes" and `DESIGN-preview.md` §"Failure Modes":

| Failure | Behavior | Surfaced as |
|---|---|---|
| Parent agent calls `delegate_task` with no `task` | Tool returns `{error: 'delegate_task requires a non-empty "task" string'}` synchronously | The parent agent reads the error and re-tries. No card mounts. |
| Parent passes an unknown `profile` name | Falls back to `subagent.v1` with a console.warn; capability summary on the card notes the fallback | The user sees `Profile: subagent.v1 (fell back from 'unknown-profile.v1')` |
| `delegate_task` admitted but `subagent.enabled === false` on the resolved profile | The tool is not registered in the per-turn tool list (filter at `getToolsForRole`); the model never sees it | Same as any other profile-disabled tool. |
| Session cap exceeded | Tool returns `{error: 'session_cap_exceeded', ...}` synchronously; no card mounts | The parent agent reads the rejection and re-plans (typically asks the user to raise the cap or stop delegating). |
| User clicks Approve, sub-agent runs, exceeds `max_tokens` | Sub-agent loop breaks on the cost check; resolves with `{status: 'partial', summary, cost, transcript_id, partial: true}` | The model sees `partial: true` in the tool_result and can re-issue a tighter call. |
| User clicks Approve, sub-agent runs, exceeds `run_timeout_ms` | Same shape as `max_tokens` exceedance; `status: 'partial'`, `partial: true` | Model learns the work was bigger than the budget. |
| User clicks Cancel while sub-agent is running | `parentCancelSignal` flips; sub-agent loop breaks; resolves with `{status: 'cancelled', partial: true, ...}` | Parent agent's loop continues (since the cancel was scoped to the sub-agent via the approval card, not a global parent cancel — see Open Questions for the granular-cancel decision). |
| User clicks Reject with feedback | Sub-agent does not run; resolves with `{status: 'rejected', feedback}` | Parent agent reads `feedback` in the tool_result and re-plans. |
| Sub-agent's tool call hits a forbidden tool (not in profile's admitted set) | `ToolRegistry.executeWithProfile` returns `{error: 'Profile subagent.v1 is not permitted...'}`; sub-agent reads the envelope | Sub-agent learns the limit and re-tries with an admitted tool. No special-case error. |
| Sub-agent calls `delegate_task` (recursion attempt under `subagent.v1`) | Same as forbidden-tool envelope; `delegate_task` is not in `subagent.v1.tools.static` | Sub-agent cannot recurse. |
| Sub-agent's LLM call returns an error (provider outage) | Sub-agent loop's retry logic (same as parent loop) attempts once; on second failure, sub-agent finalizes with `{status: 'errored', error, partial, cost, transcript_id}` | Parent agent reads the error and decides. |
| Approval card fails to mount (DOM error) | `USER_PAUSE_TOOLS` watchdog (24h floor) eventually fires; tool resolves with `{error: 'timeout'}` | Mirrors the existing single-slot guard for `pendingPlanApproval` / `pendingScriptApproval`. Indicates a bug in the chat loop. |
| Two `delegate_task` calls in flight (Phase 1) | The single-slot guard in `state.js` (`pendingSubAgentApproval`) rejects the second with a console warn | Cannot happen in Phase 1 (the chat loop pauses on the first card). If it does, it is a bug. Phase 2 lifts this. |
| Parent conversation switched while a sub-agent is running | The new active conversation's chat loop sees no in-flight `pendingSubAgentApproval`; the original conversation's sub-agent's `parentCancelSignal` is unchanged | The sub-agent continues running against the original conversation's transcript namespace. When the user switches back, the result is in the parent's tool_result turn. (Subtle: this is correct because the sub-agent's resolution path writes the tool_result into the *original* conversation's `messages[]` via the parent loop's continuation, which is suspended by the awaited Promise.) |
| Parent conversation deleted while a sub-agent is running | The sub-agent's transcript namespace cleans up alongside the conversation's `conv-{id}` payload | A `ConversationManager.delete()` extension cancels in-flight sub-agents on the deleted conversation. Phase 1 ships this extension. |
| Sub-agent enters infinite no-progress loop (model loops without making tool calls) | The extracted tool-loop core's `NO_PROGRESS_LIMIT` breaks after 3 stall rounds | Sub-agent finalizes with `{status: 'partial', summary: '*(stalled)*', cost, transcript_id}` |
| Sub-agent's response includes a structured `delegate_task` call (e.g. text-format parsing accidentally surfaces it) | Caught by the per-call profile filter; the tool call is rejected at execution; sub-agent sees the rejection envelope | Reinforces Decision §9: profile gating is the boundary, not depth counting. |

---

## Now / Next / Later

A roadmap stub for `docs/ROADMAP.md` §"2.X path → Parallel 1.X tracks" (or its post-2.0 successor). Three rows, each sized:

**Now (audit-sweep track minor):** *Phase 0 — tool-loop extraction.* Refactor `js/chat/handlers.js`'s `handleGeneralRequest` into `js/chat/handlers.js` (thin user-conversation wrapper) + `js/chat/tool-loop-core.js` (pure-ish loop core taking a `SubAgentContext`-shaped argument). Behavior-preserving for the parent surface. Sized M (<500 LOC). Lands as an audit-sweep minor (slot in the 2.36.x window or successor), pinned by a recorded-session parity test (`tests/test-tool-loop-core-parity.mjs`). Inventory entry: *"Tool-name string-literals dotted around chat module"* and the implied chat-module decoupling. **This row is committed to once a slot opens.** Audit-sweep rationale: the chat module's monolithic design is the gap; sub-agents are *one* of three downstream consumers (the other two being a hypothetical CI-bot mode and the existing scripted-loop infrastructure, neither of which are scheduled).

**Next (feature minor — post-Phase 0):** *Phase 1 — `delegate_task` + `subagent.v1`.* The feature minor described in *Phasing* above. Ships only after Phase 0 lands. Sized large for a feature minor (10–14 files, ~1200–1800 LOC) but well-shaped by the precedents (`submit_script_for_approval` and `preview_start` tool minors). Per-conversation namespace `State.subagents`. Approval-gated. Cost-discoverable. The Touch 3 Window v2 work happening on the post-2.0 track does *not* block this; the transcript panel is a slide-over Window v2 will subsume cleanly. Slot estimate: 2.X+1 feature minor, post-2.0 but pre-Window-v2-Sessions. Aligns with `docs/ROADMAP.md` §"After 2.0.0" → currently-unlabeled feature minors track.

**Later (gated on Phase 1 dogfood):** *Phases 2–6.* Each gated by named, falsifiable conditions in *Phasing* above. Phase 2 (parallel) gated on serial-bottleneck evidence. Phase 3 (recursive) gated on two-level-decomposition-outperforms-single-level evidence. Phase 4 (auto-approve) gated on a corpus of low-risk low-cost approvals where the click is friction. Phase 5 (cross-session persistence) gated on a consent design. Phase 6 (background sub-agents) gated on Window v2 Sessions. **No row in the Roadmap until Phase 1 ships and produces data.** Speculative slotting now would lock in conclusions the design cannot yet justify.

**Dual-tracker note** (per `reference_tea_cli.md`): github#24 is the public ticket. When Phase 1 implementation begins, file a parallel **gitea#N** issue under `xcaliber/ai-editor` to track the code-side work (PRs against the Gitea mirror). The two issues cross-reference; the Gitea issue carries the technical implementation discussion, the GitHub issue carries the user-facing announcement at close time.

---

## What This Document Commits To

- **The profile is the sub-agent trust boundary.** `Profiles.filterTools` is the admission gate, applied at sub-agent profile resolution. The catalog stays the boundary at the tool level (one new tool, `delegate_task`); the profile becomes the boundary at the sub-agent level.
- **Plan-Mode-shaped approval, with a capability summary.** The card mirrors the 1.10.0 / 1.16.0 / 2.10.0 lifecycle file-for-file. The capability summary (profile, admitted tools, ceilings) is the security-load-bearing UI element.
- **Clean-start context, with explicit attachments.** The sub-agent does not see the parent's `chatHistory`, `scratchpad`, `toolActionLog`, or memory. The `task` + `context_hint` arguments are the entire input surface — and both are visible on the approval card.
- **`subagent.v1` profile-bound, read-only by default.** Inherits from `chat.v1`. ~8 tools, no writes, no plan, no script, no preview. Override is explicit and auditable.
- **One new top-level State slot (`State.subagents`).** No new framework, no build step, no schema migration. Phase 1 round-trips cleanly through `conv-{id}` IDB payload extensions.
- **Phased delivery, profile-gated.** Phase 1 single non-recursive. Phase 2 parallel. Phase 3 recursive (different profile). Each phase admits a strictly larger blast radius via a *named profile*, not a runtime knob.
- **Cost-discoverable from day one.** Per-call tokens land in the existing cost store under `tool_name: 'delegate_task'`; per-sub-agent breakdowns surface in the debug panel; no new dashboard code.
- **First-ship size: feature minor + a precursor audit-sweep refactor.** Same shape as Plan Mode / Script Approval / Preview Tier 1 PRs, plus one Phase 0 refactor PR that lands first.
- **Out-of-scope items are out of scope on purpose.** Auto-decomposition, background sub-agents, cross-session persistence, user-defined profiles, recursion beyond profile-gated depth, integration with `chat_multi.v1` / `rp.v1` — each one is a category error of the trust model, a Phase 4+ concern, or a Sessions-substrate dependency.
- **Now/Next/Later slots without speculative scheduling.** Audit-sweep slot for Phase 0; feature-minor slot for Phase 1; no row for Phases 2–6 until Phase 1 produces data.

These are the load-bearing decisions. Push back on any of them before building.
