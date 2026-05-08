# DESIGN — LLM-Authored Ad-Hoc Automation

**Status:** Draft — design pass closing the open question logged in `docs/ROADMAP.md` §"Deferred / unscheduled" → *"LLM-authored ad-hoc automation (parked, design first; gates required)."* No version slot is requested by this doc; the next conversation can decide.
**Depends on:** Plan Mode (`js/tools/plan-mode.js`, `js/chat/plan-approval-card.js`, shipped 1.10.0) as the gate template; the project file API (`js/git.js` — `Git.getFile`, `Git.getFileTree`) as the read surface; the role-gated tool registry (`js/tools/registry.js`) as the trust boundary that this surface must not invert.
**Related memory:** `project_wishlist_llm_authored_automation.md` (load-bearing motivation + second-data-point post-mortem), `project_cost_quality_tradeoff.md` (steering frame).

---

## Problem

ai-editor's tool catalog has no "execute an arbitrary script and read the output" surface. That is a deliberate choice: the role-gating model treats the catalog as the trust boundary — a tool's effects are bounded by its handler, its `roles` declaration, and its `readOnly` flag. Arbitrary script execution would invert that boundary, because a single tool's effects would no longer be bounded by the tool's own definition. Every other gate downstream becomes advisory.

Empirical evidence has now stacked up that this choice is paying for itself in real money on combinatorially-shaped analytical tasks (dead-CSS sweeps, unused-export scans, import-graph audits). On a recent dead-CSS audit against a 1223-line CSS file, the manual path took ~50+ tool calls grepping for selectors one at a time, multiple full reads of the file, and loops repeating the same searches 3–10 times before halting on a single 11-line unused selector. Cost: ~$1–2 per audit. The scripted path (read CSS + HTML + glob `js/*.js`, extract selectors, filter `!html.includes(s) && !js.some(...)`) collapsed the same question to **2 tool calls, ~500 tokens, ~30 seconds, ~$0.05**. The broader incident the post-mortem came out of burned **~6.5M tokens / >$4** across this task shape. That is the X^N-vs-linear case: each `read_file` pulls more references that pull more reads, and the fan-out dominates the bill — but a single grep+aggregate pass collapses it to linear in seconds.

The thesis of this document is that the right answer is neither "add an `eval` tool and live with the inverted trust surface" nor "live forever with the X^N cost on this task shape." The right answer is a **per-invocation gate** — propose script source → human reviews → approve → run → return output — that preserves the catalog-as-trust-boundary by adding *one* well-bounded surface whose blast radius is checked at human-eyeballs latency on every call.

### What this is not

- **Not an `eval` tool.** This document does not propose a tool whose handler executes arbitrary strings. The handler proposes; the user gates; only the gated invocation runs.
- **Not a shell.** Even at higher tiers, the surface does not reach `bash`, `sh`, or anything that constructs a child process. Out of scope, possibly forever (see *Out of Scope*).
- **Not a replacement for dedicated tools.** Recurring script shapes graduate to named tools. This surface is for the long tail.
- **Not a scratchpad.** Script source does not persist across invocations in v1. Each script is its own gated turn.
- **Not a coding agent.** This is *analysis* automation — read project state, compute, return a structured answer the model uses to plan its actual edits. It does not write code into the repo.

---

## Goals

1. **Preserve the trust surface.** The catalog stays the trust boundary at the *tool* level. Per-invocation review of the script source is the new, additional gate that runs on top.
2. **Collapse X^N tool-call shapes to linear.** Tasks that are demonstrably grinding `read_file` / `search_in_files` should be expressible as a single dense pass.
3. **Plan-Mode-shaped approval.** The user already understands `submit_plan_for_approval`; the script-approval surface inherits that mental model — propose markdown-or-source, review, approve / reject / cancel, the chat loop blocks on the user.
4. **Sandbox by default.** The first-ship execution surface cannot reach anything the chat surface couldn't already see. A leaked or careless script causes no new exposure.
5. **Measure for graduation.** A surface that doesn't track repeat shapes will keep paying for the same script over and over. A measurement seam — even a crude one — is part of the design, not a follow-up.
6. **Cost-discoverable.** Every approved invocation records its tokens-saved-vs-counterfactual estimate (script tokens + output tokens vs. an estimated naive `read_file` loop) so the dashboard can show whether the surface is paying off.

---

## Non-Goals

- A general code-execution platform.
- Persisting scripts across invocations as user-managed snippets.
- Allowing scripts to call other tools recursively (no reach back into the registry from inside the sandbox).
- Multi-language support in v1 (JS only — the in-browser Worker eats it natively).
- Auto-graduation from script-shape repeats to actual tool registration. Graduation is human-reviewed.
- Letting the model run a script *without* an approval card. Even an "auto-approve trusted shapes" mode is out of scope until the surface has shipped, run, and produced data.

---

## The Load-Bearing Decision: Per-Invocation Gate, Not Per-Tool Gate

The most common failure mode in any "let the model run code" surface is treating the gate as a *property of the tool*: the tool exists, its `roles` declaration says who can use it, and once admitted it runs without further review. That is the right model for read-only analysis tools (`scan_file`, `search_in_files`, `read_lines`) because the tool's contract bounds the effects. It is the wrong model for a tool whose argument *is* the effect.

The inversion is what makes a naïve `eval` dangerous. The per-tool gate becomes a tautology — "is this tool admitted?" — answered yes once, after which the model can do anything. The catalog is no longer the trust boundary; the model's choice of script is.

The right seam is a **per-invocation gate**. The tool's handler does not execute the script. The handler returns a `Promise` that resolves only after a human reviews the script source and approves. Approval happens at the granularity of the call, not the tool.

This is the same shape Plan Mode landed at 1.10.0 for `submit_plan_for_approval`: the tool's only effect, from the chat loop's perspective, is to block the loop on a `Promise` that the approval-card UI resolves. The card renders the LLM-supplied content (markdown plan in Plan Mode; script source here), the user picks Approve / Reject / Cancel, the resolution flows back as the tool result. The chat loop never sees the tool produce side effects; it only sees a long-running tool call. Side effects (running the script, in our case) happen in the resolution path, which is owned by the approval surface, not by the registry.

The catalog then carries exactly one new tool — `submit_script_for_approval` — which is `readOnly: true` for the same reason `submit_plan_for_approval` is: the *handler* is read-only (it returns a Promise). What the user does on approval is a separate authorization decision happening at a different time and a different surface.

This is the load-bearing decision. Push back on it before building anything else in this design.

---

## Prior Art: Plan Mode Lifecycle Mapping

The 1.10.0 Plan Mode mechanism is the closest existing analogue. Mapping each lifecycle stage gives the script-approval surface a concrete shape.

| Plan Mode (1.10.0) | Script Approval (this doc) | Notes |
|---|---|---|
| Model is in Plan Mode (entered via `setPlanMode(true)`) | No mode equivalent — script approval is always available when the surface is enabled in profile/settings | Script approval is not a *mode*; it is a *tool*. Plan Mode constrains the catalog; script approval lives inside the catalog. |
| Model calls `submit_plan_for_approval({plan: "..."})` | Model calls `submit_script_for_approval({source: "...", description: "...", expected_output: "..."})` | Three args because (a) the user reviews `source`, (b) `description` explains *why* in human-readable terms, (c) `expected_output` is the model's own contract for what it expects back, helping the user spot mismatches at review time. |
| Tool handler validates args, returns `new Promise(resolve => setPendingPlanApproval({plan, resolve}))` | Tool handler validates args, returns `new Promise(resolve => setPendingScriptApproval({source, description, expected_output, resolve}))` | Identical pattern. Reuses the same single-slot guard convention. |
| `EventBus.emit('plan_approval:pending', ...)` mounts `PlanApprovalCard` Preact component | `EventBus.emit('script_approval:pending', ...)` mounts `ScriptApprovalCard` Preact component | New module: `js/chat/script-approval-card.js` + `js/chat/script-approval-card/ScriptApprovalCard.js`, mirroring the existing pair. |
| Card renders plan via `marked.parse()` (markdown) | Card renders source via existing CodeMirror read-only viewer **and** description as markdown above it | The user reviewing source is the security-critical step. Read-only CodeMirror with the existing JS mode reuses the editor's own syntax highlighting; no new render path. |
| User clicks Approve → `resolvePlanApproval({status: 'approved'})` | User clicks Approve → script runs in sandbox → `resolveScriptApproval({status: 'approved', output, stderr, runtime_ms, truncated})` | **The key divergence.** Plan Mode's approval lifts a mode; script approval *executes the side effect*, then resolves with the captured output. The card stays mounted ("Running…") between Approve click and resolution. |
| User clicks Reject → `resolvePlanApproval({status: 'rejected', feedback})` | User clicks Reject → `resolveScriptApproval({status: 'rejected', feedback})` | Identical. The model gets the feedback in the tool result and re-plans. The script does not run. |
| User clicks Cancel / Stop → `cancelPlanApproval()` resolves with `{status: 'cancelled', cancelled: true, ...}` | User clicks Cancel / Stop → `cancelScriptApproval()` resolves with `{status: 'cancelled', cancelled: true, ...}` | Identical. If the script is *running* when Cancel is hit, the worker is terminated and stderr is captured up to the cancel point. |
| Approval lifts Plan Mode automatically (`setPlanMode(false)`) | Approval has no mode-lift. The model is free to call `submit_script_for_approval` again next turn if it wants. | Script approval doesn't gate anything else; each call is its own gate. |
| `handlers.js` bypasses the 30s `USER_PAUSE_TOOLS` timeout while the card is up | Same — script approval reuses the same `USER_PAUSE_TOOLS` allow-listing | One-line addition to the existing list in `handlers.js`. |
| Tool result lands as a `tool_result` turn; compression sees it like any other turn | Tool result lands as a `tool_result` turn containing **structured** output (stdout, stderr, runtime, truncation flag) | Compression Rule 3 (Consumption, when it ships) sees this turn the same way it would see any other tool result. The script's *source* is in the prior `tool_call` turn, also visible to compression. |

The mapping is dense for a reason: the more lifecycle stages match Plan Mode, the more code is reuse rather than reinvention, and the more the user's existing mental model carries over without retraining.

---

## Scope of "Script" — Tiers, Not a Single Answer

The "what can a script do" question has no single right answer; the right answer is a tier list with explicit risk admission at each step.

| Tier | What it admits | New risk over previous tier | Gate complexity required |
|---|---|---|---|
| **Tier 0** | Pure read-only fs walk over the project's virtual file tree (`Git.getFile`, `Git.getFileTree`) + plain JS evaluation. No deps. No network. No DOM. No `process`. | Script can read project content. **The chat surface already could.** No new exposure relative to the existing tool catalog. | Source review at the approval card. No allowlist needed. |
| **Tier 1** | Tier 0 + outbound `fetch()` against an HTTP allowlist (e.g., `https://api.npmjs.org/`, `https://docs.python.org/`). | Outbound traffic may carry project content as the request body or query string. Tracking-pixel exfiltration is the failure mode. Rate-limit blast on the user's own network. | Source review **plus** explicit URL allowlist surfaced in the approval card ("This script will fetch: `https://api.npmjs.org/...`"). Allowlist is profile-level config, not LLM-determined. |
| **Tier 2** | Tier 1 + ESM dep imports (e.g., `import {parse} from "acorn"` from a CDN). | Supply chain. An imported package can do anything within the sandbox; the user's source review is now insufficient because the user did not review the dep. | Source review + dep-manifest preview ("This script imports: `acorn@8.x` from `esm.sh`") + dep allowlist. Probably gated to a backend bridge (see *Sandbox Seam*) where dep resolution is reviewable, not a CDN-fetch-at-runtime. |
| **Tier 3** | Tier 2 + write to a sandboxed scratch directory (a workspace-local `.aieditor/scratch/` namespace). | Side effects accumulate across invocations. A series of approved scripts can cooperatively build state the user did not intend. | Source review + sandbox-namespace check (writes confined to `.aieditor/scratch/<run_id>/`) + run-isolation policy + cleanup affordance. Substantially more design work; not in v1. |

The empirical case for the surface (the dead-CSS / unused-export / import-graph examples) is **entirely Tier 0**. The first ship targets Tier 0 only. Tiers 1–3 are documented here so the design has a place to grow into without a re-think — but each tier admits a new risk that the gate is responsible for, and adding a tier without adding the corresponding gate complexity is a design bug.

The version-slotting question for Tiers 1–3 is downstream of measurement on Tier 0. If the surface ships, runs, and the dogfood shows Tier 0 is enough for 90%+ of cases, Tiers 1–3 may not earn their gate complexity.

---

## Sandbox Seam

The browser context has no fs and no shell. The script has to run *somewhere*. Two options.

### Option A: In-browser via Web Worker

A `js/workers/script-runner-worker.js` worker is spawned per-invocation. The main thread posts the source plus a curated `projectFiles` snapshot (`{path: string, content: string}[]` for files the script declares it needs, or the whole tree for shapes that genuinely need it — gated by Tier 0's no-network guarantee). The worker runs the script with a curated `globalThis` (no `window`, no `document`, no `fetch` at Tier 0) and posts back `{stdout, stderr, runtime_ms, truncated}`.

| | Detail |
|---|---|
| **Reach** | Tier 0 only. No `fetch` (Worker globals can be deleted before user code runs). No `process`. No filesystem. No `eval` reach into the main thread's State. |
| **Auth surface** | Zero new auth. The Worker runs in the same origin; the project file content was already in `State.fileTree` and `Git.getFile`'s cache. |
| **Trust delta** | Approximately zero. A Tier 0 script in a Worker can read what the chat could read. It cannot write, cannot phone home, cannot persist. |
| **Limits** | No npm. No multi-language. No real fs (which is fine for Tier 0). Memory and CPU limits are the browser's. Timeout enforced via `Worker.terminate()` in the main thread. |

### Option B: Backend bridge via MCP / dev-server seam

A future MCP server or dev-server endpoint runs the script in a real Node sandbox against the real working dir.

| | Detail |
|---|---|
| **Reach** | Any tier. Real fs, real Node, real deps. |
| **Auth surface** | Substantial. The bridge needs auth (the same auth model the existing MCP plugin shipped with), CORS, transport (Streamable HTTP / SSE per the existing MCP bridge in `plugins/mcp-bridge.js`). |
| **Trust delta** | Larger. The script now runs against the *real* file tree (not the editor's virtual snapshot), can mutate it, and runs in a process that has whatever Node has. |
| **Limits** | Whatever the bridge enforces. The bridge is now load-bearing for the safety story. |

### Recommendation

**Ship Option A first.** The empirical pain is Tier-0-shaped, and the in-browser Worker has approximately-zero new trust surface. Option B is correct for Tier 2+ and correct for "I want to actually run my project's tests" — but those are not what the dead-CSS / unused-export evidence is asking for.

Building Option B first would inflate the v1 PR by an order of magnitude (auth, transport, deployment story) and concentrate the trust-surface argument in a place the user has not yet seen value from. Ship the Worker, run it, see whether Tier 1+ earns its complexity from real usage.

The two options are not mutually exclusive at the design level — the script-approval card and the per-invocation gate are the same shape regardless of where execution happens. A future Option B PR adds a *second* execution backend; the gate pattern doesn't change.

---

## vs Dedicated Tools — The Graduation Threshold

Some "throwaway" scripts are not throwaway. Dead CSS, unused exports, import graph, circular-dependency detection, file-size outliers — these are recurring asks. A script-approval surface that lets the LLM re-author the same script every time is paying review-cost for work that should be a tool.

**The seam:** measure repeat shapes. Surface a graduation prompt.

### What "similar shape" means

Three candidates, in increasing order of robustness and implementation cost:

| Candidate | What it measures | Failure mode |
|---|---|---|
| **Content hash of source** | Byte-exact dedup. | Trivially defeated by whitespace, variable renames, comment changes. Not useful. |
| **AST fingerprint** | Hash of the script's AST shape (function calls, top-level operations, files-touched literals), normalized to ignore identifier names. | Robust. Costs a JS parser at the comparison seam. The retrieval path's AST chunker (Phase 1, 1.7.0) uses tree-sitter; reusing that infrastructure on the editor surface is plausible but a separate seam — not free. |
| **Heuristic fingerprint** | Tuple of `(set of project paths read, set of imported globals, top-level operation type)`. Computable without an AST by combining the script source with the worker's actual `Git.getFile` call log. | Coarse. False positives (two different scripts hitting the same files for different reasons). False negatives (a small refactor of the same script changes the fingerprint). |

**Recommendation for v1: heuristic fingerprint.** It piggybacks on data the worker already produces (the call log) without adding an AST seam. The AST upgrade is a Phase-2 follow-up if the heuristic produces too much noise.

### The surface

After each approved + run script, the surface logs `(fingerprint, run_id, timestamp, tokens_saved_estimate)` to a session-scoped store (not persisted across sessions in v1; the goal is *within-session* graduation, not cross-session learning).

Threshold: when the same fingerprint has run 3+ times *in any session* within a rolling window, the LLM Debug modal surfaces a chip:

> "You've run the 'unused-export sweep' shape 3 times this week. Promote to a tool? [Propose] [Dismiss]"

`Propose` opens a tool-proposal stub: pre-filled tool name (a heuristic from the script's description field), JSON Schema (synthesized from the args the script consumed), handler outline (the script source itself, with TODOs at the ad-hoc parts). The stub lands as a draft PR — not an automatic tool registration. Human review remains the gate for catalog admission.

This keeps the catalog small (admissibility, not accumulation) while routing recurring shapes toward graduation rather than letting them accumulate as duplicate gated invocations forever.

### What this is not

- **Not auto-graduation.** No fingerprint count automatically registers a tool. Catalog admission stays human-gated, always.
- **Not cross-session in v1.** Persistence of fingerprint logs is its own design question (consent, retention, scope) and is not in the first ship.
- **Not a code-suggester.** The tool stub is a starting point for human authoring, not a finished tool. The graduation surface produces a *PR draft*, not a registered tool.

---

## First-Ship Scope

The smallest useful first PR.

| | |
|---|---|
| **Tier** | Tier 0 only. |
| **Sandbox** | In-browser Web Worker (Option A). |
| **Approval surface** | Plan-Mode-shaped: `submit_script_for_approval` tool + `ScriptApprovalCard` component, both mirroring the 1.10.0 Plan Mode shape file-for-file. |
| **Tool definition** | One new tool, `submit_script_for_approval`, registered in `js/tools/script-tools.js`. `readOnly: true`, `roles: 'all'`. |
| **Worker** | One new file, `js/workers/script-runner-worker.js`. Curates `globalThis`. Implements `Git.getFile` and `Git.getFileTree` adapters via `postMessage`. Hard timeout (default 10s). Hard output cap (default 256 KB; truncation is reported). |
| **Card** | `js/chat/script-approval-card.js` + `js/chat/script-approval-card/ScriptApprovalCard.js`. Source rendered via the existing CodeMirror read-only viewer. Description as markdown. Buttons identical to Plan Mode. |
| **Graduation measurement** | **Not** in the first ship. Ships when the surface has produced a real script corpus to measure against — putting it in v1 is premature optimization (no data to threshold). |
| **Cost reporting** | Per-invocation: tokens-of-source + tokens-of-output recorded into the existing cost store (`js/intelligence/cost/cost-store.js`) under a new `tool_name: 'submit_script_for_approval'` row. Tokens-saved-vs-counterfactual is **not** in the first ship — it requires a counterfactual model. Stub in v1; populate in v2. |
| **Profile config** | New `profile.scriptAutomation: {enabled: bool, timeout_ms: number, max_output_bytes: number}` block. Default `enabled: true` for `coder.v1`; `enabled: false` for `chat.v1` and `kb.v1`. |
| **Settings UI** | One row in Settings → Tools (or Settings → Advanced if Tools tab is not present at slot time): toggle `enabled`, edit `timeout_ms`, edit `max_output_bytes`. Two-view contract per `DESIGN-profiles.md` Appendix B applies. |
| **Tests** | One Node `tests/test-script-tools.mjs` for the registry/handler shape; one browser test for the Worker round-trip with a fixture file tree. CI auto-globs the `.mjs` test. |
| **CHANGELOG** | New `### Feature` block under the version this lands at. |

**PR-size estimate (using the roadmap's units):** *Feature minor.* In the same shape as the 1.10.0 Plan Mode PR (#316) — multi-file, new tool + new card + new worker + new test, but well-bounded by the analogue and reusing the lifecycle pattern. Rough sizing: 5–8 files net new, ~600–900 LOC, no migrations, no schema changes outside the profile block. Target: a single feature minor (bumps the minor version), not a multi-PR arc.

---

## Out of Scope (For the First Ship — and Possibly Forever)

The next implementer will be tempted to pull these in. The design says no.

- **Arbitrary shell.** No `bash`, no `sh`, no `child_process`. Probably forever.
- **Persistent script storage.** Each invocation is its own approval. No "save this script as a snippet." If the shape recurs, it goes through *graduation*, not persistence.
- **Scripts that write back into the chat surface.** No `injectMessage(...)`-shaped APIs from the Worker. The script's only output channel is its return value, which lands as a tool_result turn through the normal chat path.
- **Scripts that call other tools recursively.** The Worker has no `Tools.invoke` reach. If the model wants `read_file` *and* a script in the same task, it issues two tool calls, not a script that calls `read_file`. (This avoids "the script becomes a chat-loop runtime inside the chat loop.")
- **Scripts that mutate `State`.** The Worker has no reach into the main thread's State. Read-only adapters only.
- **Scripts that read auth tokens, settings, or memory.** The Worker's adapter layer exposes the project file tree and nothing else. Settings, secrets, memory store, and chat history are not reachable.
- **Tier 2+3 in the first ship.** Dep imports and write-to-sandbox-dir require the backend bridge, and the backend bridge requires its own auth/CORS/transport design. Not this PR.
- **Multi-language support.** JS only. The Worker eats it natively. Python / shell would require a backend bridge or a WebAssembly toolchain, both substantial.
- **Auto-approval of "trusted shapes."** No fingerprint that has been approved 3 times silently auto-approves the 4th. The gate is the gate. Auto-approval is a category-error of the trust model.
- **Auto-graduation from script to tool.** Graduation produces a *PR stub*. Catalog admission stays human-gated.
- **Cross-session fingerprint persistence.** v1 measurement is session-scoped. Persisting fingerprints across sessions is its own consent design.
- **Background scripts.** Scripts run in the foreground, while the chat loop is paused on the approval Promise. No "kick off and notify me when done."

---

## Open Questions

What this design pass could not resolve. Each must be answered before code starts.

| Question | Why open | Who answers it |
|---|---|---|
| Default timeout for the Worker | 10s feels right for the dead-CSS shape; some import-graph audits may want longer. | Pick a default at implementation time after running the dead-CSS and unused-export shapes against fixtures. |
| Output truncation strategy | Hard byte cap is simple but loses tail. Hard-cap with "truncated; first 256 KB shown" is the v1 default; alternatives (head-and-tail, structured-only) are follow-ups. | Implementation default; revisit if dogfood shows the truncated tail mattered. |
| Whether the script can `await` | A synchronous-only Worker is simpler to reason about but rules out scripts that need to fan out reads. | Default to async (Worker is async-native); enforce timeout at the outer boundary. |
| What the `description` field renders as | Markdown is the obvious choice (Plan Mode parallel). But "an LLM-authored description of an LLM-authored script" risks the description hiding what the source actually does. | Render markdown; require the user to also see the source rendered (which is the security-load-bearing view). The description is a hint, not the gate. |
| How `expected_output` is used | The model declares what it expects; the user can spot mismatches at review time. But the *runtime* could also validate the actual output against the declared shape. | v1: for human review only. Runtime validation is a v2 affordance. |
| Cancel-while-running semantics | If the user hits Stop mid-execution, the Worker is terminated. What does the model see? | `{status: 'cancelled', cancelled: true, partial_stdout?, partial_stderr?}`, mirroring the Plan Mode cancellation shape. Decide at implementation time whether partial output is captured or discarded. |
| Whether profile gating is per-profile or per-role | The `coder.v1` profile is the obvious enable target. But Plan Mode is `roles: 'all'`. | Default to per-profile; the tool's `roles: 'all'` matches Plan Mode's pattern, with profile-level enable as the actual switch. |
| Where the fingerprint store lives | Session-scoped is the v1 answer. But the existing cost store is per-conversation; piggybacking on it is tempting. | Standalone session-scoped Map for v1. Persistence is a follow-up. |

---

## Failure Modes

| Failure | Behavior | Surfaced as |
|---|---|---|
| Model submits malformed source (syntax error) | Worker reports the parse error in stderr; tool result includes `{status: 'approved', stdout: '', stderr: '...', exit: 'parse_error'}` | The model sees the parse error and can re-author. No special UI. |
| Script exceeds timeout | Worker terminated; tool result `{status: 'approved', stderr: 'Timeout after 10000ms', truncated: true}` | Card unmounts on resolve. The model sees the timeout in the tool result. |
| Script exceeds output cap | Worker continues briefly, captures up to cap, truncates; tool result includes `truncated: true` | The model can re-author with a tighter aggregation if it cares. |
| User clicks Approve, then Stop while script is running | Worker terminated; tool result `{status: 'cancelled', cancelled: true, partial_stdout?, partial_stderr?}` | Mirrors Plan Mode cancellation shape. |
| Script tries to access a forbidden global (`fetch`, `XMLHttpRequest`, `process`) at Tier 0 | The global is `undefined` in the curated `globalThis`; standard `ReferenceError` lands in stderr | The model learns that global isn't available. No special-case error. |
| Profile has `scriptAutomation.enabled: false` | The tool is not registered in the catalog; the model never sees it | Same as any other profile-disabled tool. |
| Two `submit_script_for_approval` calls in flight (impossible by design — chat loop is paused) | The single-slot guard in `state.js` (mirroring Plan Mode) rejects the second with a console warning | Should never fire; if it does, it's a bug in the chat loop. |
| Worker fails to spawn (e.g., browser denies workers) | Tool returns `{error: 'worker_unavailable'}` synchronously; no card mounts | The model sees the error and can fall back to manual `read_file` loops. |

---

## Cost Model (Projected)

The v1 surface ships without a measured cost model. These are the projections; the dashboard data once it exists will replace them.

| Approach | Tool calls per task | Tokens per task (approx) | Latency |
|---|---|---|---|
| Manual `read_file` / `search_in_files` loop (status quo) for dead-CSS audit | ~50 | ~2M (post-mortem data) | minutes; human read of model loops |
| Plan-Mode-shaped script approval (Tier 0, in-browser Worker) for the same audit | 2 (`submit_script_for_approval` + tool_result) | ~5–10K (script source + structured output) | ~30s including human review of the source |
| Dedicated `find_unused_css_selectors` tool (graduation outcome) | 1 | ~500–1K | ~1s |

Two-orders-of-magnitude tokens-saved on the X^N shape; a third order if the shape graduates to a tool. The argument for shipping the surface is the middle row. The argument for the graduation seam is the gap between the middle and bottom rows.

---

## Phased Delivery

**Phase 1 — Tier 0 + Worker + Plan-Mode-shaped card.** First ship, as scoped above. Multi-file feature minor.

**Phase 2 — Graduation measurement.** Heuristic fingerprint, session-scoped store, debug-modal chip, tool-stub generator. Independent PR, gated on Phase 1 producing a real script corpus.

**Phase 3 — Tier 1 (HTTP allowlist).** Profile-level URL allowlist surfaced in the approval card. Worker-side `fetch` permitted only for allowlisted hosts. Independent PR, gated on a use case that Tier 0 cannot serve. May not earn its slot.

**Phase 4 — Backend bridge (Tier 2+3).** New execution backend for dep imports and sandbox writes. Substantially larger PR; gated on a use case that Phase 3 cannot serve. May never ship.

**Phase 5 — Cross-session fingerprint persistence.** Promote the graduation seam from session-scoped to durable. Gated on a consent design.

The phased delivery is intentionally back-loaded with "may not earn its slot" gates. The first ship is the only one this design commits to; everything else is a question Phase 1's data will answer.

---

## What This Document Commits To

- **The catalog stays the trust boundary.** This surface adds *one* tool whose handler is read-only; the actual side effect (running the script) is gated at the *invocation* level by a human-reviewed approval card.
- **Plan-Mode-shaped approval.** The surface inherits the 1.10.0 mechanism file-for-file: tool returns Promise, card mounts, user picks Approve / Reject / Cancel, resolution flows back as the tool result.
- **Tier 0 first, in-browser Worker.** No new auth surface. No new exposure relative to what the chat already reads. Higher tiers exist as future-proofing, not as v1 commitments.
- **Graduation is a seam, not an accident.** Recurring script shapes route toward named tools via heuristic fingerprinting and a debug-modal chip. Catalog admission stays human-gated.
- **Out-of-scope items are out of scope on purpose.** Arbitrary shell, persistent scripts, recursive tool calls, multi-language, auto-approval, auto-graduation — each one is a category error of the trust model, not a missing feature.
- **First-ship size: feature minor.** Same shape as Plan Mode's PR. No multi-PR arc; no architectural rework.
- **Cost-discoverable from day one.** Per-invocation tokens recorded into the existing cost store under a new tool name; tokens-saved-vs-counterfactual is a stub now and a real metric once Phase 2 ships.

These are the load-bearing decisions. Push back on any of them before building.
