# DESIGN — Tools: Capability Admission and Discovery

**Status:** Draft
**Depends on:** A tool catalog (registry of available tool definitions with embeddings and metadata), the shared embedding pipeline. Optional: an authorization layer for tool-call gating.
**Sibling subsystems:** `DESIGN-retrieval.md`, `DESIGN-memory.md`, `DESIGN-compression.md`. All four are coordinated by `DESIGN-intelligence.md`.

---

## Problem

Tool definitions are not free. A well-described tool occupies 200–500 tokens (name, description, examples, JSON schema for arguments, usage notes). A coder profile with 30 internal tools (file ops, search, run_shell, build, lint, format, test runner, debugger, git, package manager, etc.) plus 20 third-party tools (Asana, Slack, GitHub, calendar, mail, etc.) carries 10,000–15,000 tokens of tool definitions in *every single LLM call*.

Most of those tools are not relevant to most calls. A user asking "what's the LOC count of this project" needs `run_shell` (or a SLOC tool); they don't need the calendar integration. Loading every available tool on every call is the same accumulation pathology that motivates the rest of this architecture, applied to the tool-definitions portion of the context window.

The dominant pattern in current LLM products is the wrong default: tools are *exposed* (always present) unless explicitly withheld. The right default — consistent with the architectural principle in `DESIGN-intelligence.md` — is the inverse: **tools are admitted, not exposed.** A tool definition enters the prompt only when something has justified its admission, the same way every other piece of content does.

This is the admissibility principle applied to capability. Tools must earn their place in the context window.

The thesis of this document is that tool admission is its own subsystem because: (a) tools have different re-admission semantics than content (sticky after use, not suppressed); (b) tools carry an authorization concern that does not apply to chunks; and (c) discovery is the natural mechanism rather than retrieval's query-driven selection.

### What this is not

- **Not tool execution.** Calling a function, marshaling arguments, capturing return values, formatting tool_result turns — that is plumbing owned by the product surface. This subsystem decides *which tools the model can see*; it does not implement the call.
- **Not authorization policy.** The tools subsystem consults an authorization layer at admission time (and again at execution time, in the surface). The policy itself — who can invoke `transfer_funds`, when, with what limits — is upstream of this subsystem and is defined by the product's security model.
- **Not retrieval.** Tools share infrastructure with retrieval (embeddings, similarity search, identity stability) but have their own admission rules. A tools subsystem that delegates to retrieval is doing the wrong job.
- **Not memory.** Tool definitions are not curated user facts; they are a separate catalog with a separate lifecycle.

---

## Goals

1. **Hidden by default.** The bulk of the tool catalog is not loaded into any given LLM call. The model navigates to what it needs via meta-tools.
2. **Explicit discovery contract.** A small, named set of meta-tools is always loaded; their behavior is the documented protocol for finding everything else.
3. **Sticky after first use.** A tool admitted during a task remains admitted for the task's duration. The model does not have to rediscover what it has already used.
4. **Authorization-aware.** Admission is gated by the user's permissions on each tool. Discovery does not surface tools the user cannot use.
5. **Cost-discoverable.** Every admission, suppression, and discovery call records its token cost in diagnostics. The bill is auditable.
6. **Profile-driven.** The profile (`DESIGN-profiles.md`) declares which tools exist for the surface, which are static (always loaded), which strategies are active.

---

## Non-Goals

- A marketplace of community tools in v1.
- Cross-session tool ledger persistence (tools admitted in yesterday's task are not auto-admitted today).
- Per-user dynamic tool installation. Tools belong to the profile; users do not add tools mid-session.
- **Loop-authored envelope construction.** The agent loop (`DESIGN-agent-loop.md`) wraps tool returns in envelopes (`success` / `refused` / `cached` / `partial`) based on loop state; envelope authorship is not a Tools concern. Tools *may* return structured failure shapes from their own logic (e.g., a tool whose precondition isn't met); those shapes pass through the loop unchanged inside the `success` envelope and are tool internals, not Tools-subsystem-architectural. The envelope-bearing Turn that results from each invocation is admitted into the conversation buffer per the trust contract; subsequent compression of that Turn is governed by `DESIGN-compression.md`.
- A unified tool-call standard. We assume the LLM provider's native tool-calling mechanism. (MCP and similar protocols are concerns at the surface layer, not here.)

---

## The Load-Bearing Decision: Admission, Not Exposure

The most common mistake in tool integration is the default. Most products take "expose all tools to the LLM" as a starting point and then add complexity on top to reduce cost. This is the wrong direction.

The correct starting point is *exclusion*. The model sees, by default:

- The meta-tools (the discovery interface).
- The profile's `static` set (the small core that's always loaded).
- Any persona overlay (optional, per `DESIGN-persona.md`).
- Any tool already admitted during this task (sticky).

Everything else is unseen until something — model action, profile rule, explicit pin — justifies admitting it.

This inverts a load-bearing default and produces a strict ordering:

1. **Static admission** — profile-declared tools, always present.
2. **Persona overlay admission** — tools contributed by the active Persona, if any. Same priority tier as static; admitted alongside profile-static tools, with diagnostics distinguishing the authoring source. Subject to the same authorization filters as any other admission. See `DESIGN-persona.md`.
3. **Sticky admission** — tools used earlier in this task, retained.
4. **Discovery admission** — tools loaded via the model's discovery calls.
5. **Eviction** — when the tool budget is exceeded, the longest-unused non-static, non-persona-overlay tools are evicted with diagnostics.

The first four are deliberate; the fifth is the safety net.

This ordering is the discipline. A tools subsystem that loads everything by default is doing zero useful work — it is just a tool catalog plus a passthrough.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Caller (profile + LLM call orchestrator)    │
└──────────────────┬───────────────────────────┘
                   ▼
         ┌───────────────────┐
         │  Tool Composer    │  ← decide what's in this call
         │   ├─ Static       │
         │   ├─ Sticky       │
         │   ├─ Discovery    │
         │   └─ Budget/Evict │
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │ Discovery Strategies
         │   ├─ Categorical   │
         │   ├─ Semantic      │
         │   └─ Frequency     │
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │  Authorization    │  ← user permissions; filters output
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │  Tool Catalog     │
         │  (defs + meta +   │
         │   embeddings)     │
         └───────────────────┘
```

The Tool Composer is the only surface callers use. Discovery strategies and the authorization gate are internal.

---

## Core Contracts

### ToolDef — the atomic unit

Every entry in the catalog is a `ToolDef`. Identity is stable; the diagnostics and ledger reference tools by ID.

```
ToolDef {
  id:              ToolID
  name:            string             // canonical name as the LLM will see it
  category:        string             // hierarchy via dot-notation: "code.git.commit"
  description:     string             // 1-2 sentences for discovery; full doc separate
  schema:          JSONSchema         // arguments contract
  full_doc:        string             // longer doc loaded only when admitted in full
  embedding:       Vector             // of (name + description + category)
  metadata:        ToolMetadata
}

ToolMetadata {
  version:           string
  authorization:     AuthSpec        // who can use this tool
  side_effects:      SideEffectClass // "read" | "write" | "external" | "irreversible"
  cost_estimate:     int             // tokens for full admission (def + schema)
  short_cost:        int             // tokens for name+description only
  examples:          []Example?      // optional usage examples
  deprecated:        bool
  superseded_by:     ToolID?         // for migrations
}

AuthSpec {
  required_groups:   []string         // RBAC groups required
  required_consent:  bool             // user must approve each call
  rate_limit:        RateLimit?
}
```

**Why these fields, specifically:**

- `short_cost` and `cost_estimate` (full) make the lazy-schema-expansion strategy possible. A tool can be admitted in "short" form (name + description, ~50 tokens) until the model commits to calling it; the full schema loads on first attempted call.
- `category` uses dot-notation hierarchy so the categorical-discovery strategy can navigate a tree without needing a separate tree representation. (Same trick as retrieval's structural metadata: the hierarchy is the transitive closure of the field.)
- `side_effects` is enforced at the authorization layer but is also visible to the model so it knows which tools require consent before invocation.

  The agent loop derives several runtime classifications from `side_effects`: which tools its cache may serve hits for (read-only tools cache cleanly; mutating tools cache to *prevent* unintended re-invocation but the cache-hit narration tells the model "the mutation already happened, do not retry"); which tools bypass cache entirely (none, by side-effects alone — see `DESIGN-agent-loop.md` for the orthogonal stateful-read axis); which tools the loop will *invalidate* cache entries for after invocation (the file-mutating subset). Source of truth is `ToolDef.side_effects`; the loop's lists are derived views.
- `superseded_by` enables tool migrations without breaking existing task ledgers — old tool IDs remain referable in the audit trail.

### Tool-authored failure shape contract

A tool that rejects its input or fails its own precondition must return a structured failure shape, not a flat error string. The loop wraps the return in `success(payload)` (per `DESIGN-agent-loop.md` — the tool *ran* and produced a structured outcome) without interpreting it. The shape itself is the tool's own design, but the architecture commits to two contract requirements:

1. **Named failure reason.** Every failure shape carries a `error` (or `failure_code`) field with a stable, machine-readable identifier — not a free-form sentence. The identifier names the constraint that failed (`stale_lines`, `path_not_found`, `precondition_indexer_not_ready`, `schema_validation_failed`), not the human-readable narration. Stability matters because the loop's per-tool `next_action_hint` registry (`DESIGN-agent-loop.md` §"Envelope Shapes") keys on this identifier.
2. **Recovery-sufficient payload.** The shape carries enough additional fields to enable the model (or the loop) to construct a recovery path without re-querying the tool just to learn what went wrong. For schema/validation failures, this means echoing the parsed argument shape the tool actually saw alongside the constraint that failed. For staleness failures, the current value of the staleness predicate (e.g., the actual file content at the rejected line range). For readiness failures, the readiness state (`coverage: 0.06`, `expected_ready_at: ...`). The minimum bar is: a reader of the failure shape can identify the recovery action without a second tool call.

The architecture is deliberately not prescriptive about *which* fields a given tool surfaces — that is the tool's own design. It is prescriptive about the two contract requirements above. A tool that returns `{error: "validation failed"}` with no further structure fails this contract regardless of how technically correct the rejection was. The cost of opaque rejection lands on the loop as extra rounds; the contract pushes that cost back to the tool, where it can be paid once at tool-author time instead of every invocation at runtime.

Tools that *did not run* (the loop intercepted before invocation — cache hit, refused, partial) do not produce these shapes; the loop's envelope shapes (`cached`, `refused`, `partial`) cover those cases. This contract applies only to envelopes the loop emits as `success(payload)` where the payload happens to be a tool-authored failure.

### ToolRequest / ToolAdmissionResult

```
ToolRequest {
  task:               string              // for diagnostics
  query:              string?             // current user message; informs semantic strategy
  budget_tokens:      int                 // ceiling for tool-definitions section
  profile_static:     []ToolID            // profile-declared always-loaded set
  task_ledger:        TaskLedger?         // for sticky admission
  user_groups:        []string            // RBAC for authorization filter
  discovery_call:     DiscoveryCall?      // present if model called a meta-tool
  expansion_mode:     "short" | "full"    // controls lazy-schema-expansion
}

ToolAdmissionResult {
  admitted:           []AdmittedTool      // ordered for prompt assembly
  suppressed:         []SuppressionRecord // tools that didn't make it
  diagnostics:        Diagnostics
  tokens_used:        int
}

AdmittedTool {
  tool_id:    ToolID
  form:       "short" | "full"
  rendered:   string                      // the text to inject into the prompt
  source:     "static" | "persona_overlay" | "sticky" | "discovery" | "evicted-and-rebid"
}

DiscoveryCall {
  meta_tool:  string                      // "list_categories" | "list_by_category" | "find_tool"
  args:       map<string,any>
}
```

The result is **structured, not a flat string**. The caller assembles the tool definitions into the prompt in the order returned, retaining control over format while letting the subsystem own the admission decisions.

---

## Tool Identity and Stability

Just like ChunkID and TurnID, ToolID must be stable across operations. A tool admitted today must be referable tomorrow (for audit), and a tool deprecated and superseded must remain locatable.

```
ToolID = hash(profile_namespace || canonical_name || version)
```

Consequences:

- A tool's name change is a new tool. The old ID continues to resolve to the deprecated definition for audit.
- Two profiles defining tools with the same `name` get different `ToolID` values via `profile_namespace`. There is no global tool collision.
- Embedding the version in the ID means catalog upgrades during a session don't silently swap tools out from under the model.

---

## The Tool Catalog

The catalog is the registry of all `ToolDef`s available to a profile. It is shared infrastructure — backed by the same vector store as retrieval — but is conceptually separate from the chunk store. The catalog supports:

- Lookup by `ToolID`.
- Lookup by `category` prefix (e.g., `code.git.*`).
- Semantic similarity over the `embedding` field.
- Frequency-of-use queries (per profile, per task, per user — depending on telemetry).

Catalog management (adding, deprecating, upgrading tools) happens at the profile level. Profiles compose their catalogs from their static set plus any discoverable tools they grant access to. A KB profile may have a catalog of 5 tools; a coder profile may have 200.

---

## Meta-Tools: The Always-Loaded Discovery Interface

Three meta-tools constitute the discovery protocol. They are *always* loaded for any profile that enables tool discovery (KB profile may opt out and use a fully static catalog).

```
list_tool_categories() -> []CategoryInfo
list_tools_by_category(category: string) -> []ToolSummary
find_tool(description: string) -> []ToolSummary

CategoryInfo {
  category:    string
  description: string
  tool_count:  int
}

ToolSummary {
  tool_id:      ToolID
  name:         string
  description:  string                 // 1-2 sentence
  short_cost:   int                    // tokens for short admission
  full_cost:    int                    // tokens for full admission with schema
  category:     string
  side_effects: SideEffectClass
}
```

Why three rather than one:

- `list_tool_categories` has the cheapest output (categories + counts).
- `list_tools_by_category` is the "I know roughly what I'm looking for" path.
- `find_tool` is the "I'll describe the capability and find a match" path.

A surface that wants to consolidate to a single parameterized meta-tool can — but the architecture commits to the three-call surface as the canonical default because each call is a different cognitive operation for the model and unifying them tends to confuse the calling pattern.

The meta-tools are themselves tools. They live in the catalog with `category = "meta"`. They are pinned to the static set by the profile. They cost ~100 tokens each (~300 total) — the price of admission to a sub-prompt that lets the model navigate a 200-tool catalog.

When the model invokes a meta-tool, the result lands as a tool_result turn (handled by compression like any other turn) and the tools whose summaries appear in that result become eligible for sticky admission on the *next* turn. This is the canonical discovery flow:

```
Turn N:   model calls list_tools_by_category("code.git")
Turn N:   tool_result: [git_status, git_commit, git_diff, git_log, git_push]
Turn N+1: model calls git_commit(message: "fix nullcheck")
Turn N+1: profile/composer admits git_commit in full form via sticky ledger
Turn N+1: tool executes; tool_result lands
```

Discovery is two turns: one to discover, one to use. After that, the tool is sticky and remains admitted for the task.

---

## Discovery Strategies

The strategies share the catalog the same way retrieval's strategies share the chunk store. They differ only in how they select.

### Static (Phase 1)

Profile-declared. The profile's `static` field lists `ToolID`s that are *always* admitted regardless of query. The Tool Composer admits them first; budget is consumed before any other strategy gets a chance.

Static is what the meta-tools are pinned via. It is also where the small "core" set lives (e.g., `read_file`, `search_files` for coder; `cite_source` for KB).

### Categorical (Phase 1)

Hierarchy navigation via `category` metadata. Powers `list_tool_categories` and `list_tools_by_category`. The strategy is essentially a metadata query — no embedding, no scoring — but it returns short summaries (not full definitions) so the model can pick.

### Semantic (Phase 2)

Powers `find_tool`. Embed the user's description; k-NN against tool embeddings; return top-K summaries. Same shape as retrieval's semantic strategy, but over the tool catalog rather than the chunk store.

The match threshold matters here in a way it doesn't for retrieval. A weak semantic match for a chunk is just a less relevant chunk — the model decides. A weak semantic match for a tool can produce the wrong tool being highlighted. The default threshold is conservative; tools below the threshold do not appear in `find_tool` results. Better to return empty and have the model widen its query than to suggest the wrong capability.

### Frequency (Phase 3)

Top-N tools by usage. Per profile (population-level), per user (personalized), or per task (just-used). The frequency strategy is what populates a profile's "expanded static" — beyond the rigid `profile.static`, an additional ~5-10 tools that get loaded by default because they're empirically what this user reaches for.

Frequency is gated to Phase 3 because it requires telemetry that doesn't exist on day one.

---

## Admission Algorithm

```
admit_tools(req: ToolRequest) -> ToolAdmissionResult:

  # 1. Authorization filter on the candidate space
  authorized_catalog = catalog.filter_by_groups(req.user_groups)

  # 2. Static admission — profile-declared, always loaded
  admitted = []
  budget_used = 0
  for tool_id in req.profile_static:
    tool = authorized_catalog.get(tool_id)
    if tool is None:
      diagnostics.warnings.append(f"static tool {tool_id} not authorized; skipped")
      continue
    admitted.append(AdmittedTool(tool_id, "full", render_full(tool), "static"))
    budget_used += tool.metadata.cost_estimate

  # 3. Sticky admission from task ledger
  if req.task_ledger is not None:
    for record in req.task_ledger.tool_admissions:
      if record.tool_id in {a.tool_id for a in admitted}:
        continue                          # already in static
      tool = authorized_catalog.get(record.tool_id)
      if tool is None:
        # User's authorization changed mid-task; do not silently re-admit.
        diagnostics.warnings.append(f"sticky tool {record.tool_id} no longer authorized")
        continue
      form = record.form                  # respect prior expansion mode
      cost = tool.metadata.cost_estimate if form == "full" else tool.metadata.short_cost
      if budget_used + cost > req.budget_tokens:
        # Don't evict static; mark this sticky as suppressed.
        suppressed.append(SuppressionRecord(record.tool_id, "budget_after_static"))
        continue
      admitted.append(AdmittedTool(record.tool_id, form, render(tool, form), "sticky"))
      budget_used += cost

  # 4. Discovery admission — only if the model just called a meta-tool
  if req.discovery_call is not None:
    discovered = run_discovery(req.discovery_call, authorized_catalog)
    # Discovery results are returned as a tool_result turn; not directly
    # admitted into the prompt. Their effect on subsequent turns is via
    # sticky-admission once the model uses one of them.
    diagnostics.discovery = discovered

  # 5. Eviction if budget still exceeded
  if budget_used > req.budget_tokens:
    admitted, evicted = evict_oldest_non_static(admitted, req.budget_tokens, req.task_ledger)
    for e in evicted:
      suppressed.append(SuppressionRecord(e.tool_id, "evicted_for_budget"))

  return ToolAdmissionResult(admitted, suppressed, diagnostics, budget_used)
```

**Static is privileged.** The static set is admitted first and never evicted. If the static set itself exceeds the tool budget, that is a profile configuration error and surfaces as such — not a graceful runtime degradation.

**Discovery does not directly admit.** The model calls a meta-tool, the result is a tool_result turn (which compression sees and handles like any other turn), and the model decides on the *next* turn what to invoke. Sticky admission then takes effect. This two-turn flow is intentional: it gives the model an explicit moment to choose, and it gives the profile a chance to surface authorization concerns (`requires_consent: true`) before invocation.

**Eviction is LRU-by-task-use.** Within the non-static admitted set, the longest-unused tool is evicted first when budget is exceeded. The `task_ledger.tool_admissions[i].last_used_at` is the eviction key.

---

## Tool Ledger Integration

The `TaskLedger` defined in `DESIGN-profiles.md` is extended with a parallel record array:

```
TaskLedger {
  task_id:           TaskID
  surface:           string
  started_at:        timestamp
  admissions:        []AdmissionRecord       // chunk admissions
  exclusions:        []ExclusionRecord       // chunk exclusions
  tool_admissions:   []ToolAdmissionRecord   // tool admissions (NEW)
  tool_invocations:  []ToolInvocationRecord  // when tools were actually called (NEW)
}

ToolAdmissionRecord {
  tool_id:        ToolID
  admitted_at:    timestamp
  form:           "short" | "full"
  source:         "static" | "sticky" | "discovery"
  cost:           int                    // tokens
  last_used_at:   timestamp?             // null until first invocation
}

ToolInvocationRecord {
  tool_id:        ToolID
  invoked_at:     timestamp
  turn_id:        TurnID
  args_summary:   string?                // truncated for ledger compactness
  succeeded:      bool
}
```

**One ledger, two record types.** The same TaskLedger struct holds both chunk admissions and tool admissions. This is intentional: a single owner per task, two record arrays inside it. Both are queryable for cost analysis ("how many tokens did this task cost in tool definitions?").

**Re-admission semantics are different.** Chunks may be suppressed on re-admission via the novelty score. Tools, once admitted, remain admitted. The model needs the capability to remain callable; suppressing a tool because "you've already seen it" would break tool-call flows. The ledger's role for tools is *retention*, not *suppression*.

**Eviction is the parallel.** What chunks resolve via novelty-score suppression, tools resolve via LRU eviction. Tools that haven't been invoked recently can be evicted to make room. Eviction surfaces in diagnostics so the model can re-discover if needed.

---

## Authorization Gate

Every catalog query passes through an authorization filter before any admission happens. The filter is informed by:

- The user's RBAC groups.
- The tool's `required_groups` from its `AuthSpec`.
- Per-tool consent flags.

Three policies, in priority order:

1. **Filter at discovery.** Tools the user is not authorized for never appear in `list_tools_by_category` or `find_tool` results. The model is unaware they exist. This is the right default — exposing tools the user cannot use both wastes tokens and creates UX confusion ("why won't it use the tool it just told me about?").
2. **Filter at admission.** Even if a tool was authorized when added to the static set or task ledger, re-check authorization at admission time. Permissions can change mid-session.
3. **Gate at execution.** The actual tool call still passes through an authorization check at the surface (this is plumbing, outside this subsystem). Defense in depth.

Tools requiring `required_consent: true` are admitted normally but flagged. The surface is responsible for surfacing a consent prompt to the user before actually executing the call. The model can plan the call; the user authorizes it.

---

## Failure Modes

| Failure | Behavior | Surfaced as |
|---|---|---|
| Static set exceeds tool budget | Reject at session start with structured error | Exception |
| User loses authorization for a sticky tool mid-task | Do not silently re-admit; warn | `diagnostics.warnings` |
| Discovery query (semantic) returns nothing above threshold | Return empty result; do not return weak matches | (none — empty is correct) |
| `list_tools_by_category` called for unknown category | Return empty list; warn | `diagnostics.warnings` |
| Tool catalog version mismatch mid-session | Existing ToolIDs continue to resolve; new tools admissible | `diagnostics.warnings` |
| Deprecated tool with `superseded_by` invoked | Allow the call; warn the model in tool_result | `diagnostics.warnings` |
| Tool's `cost_estimate` understates actual rendered size | Admit anyway; warn; recalibrate `cost_estimate` in catalog | `diagnostics.warnings` |
| Two strategies surface the same tool | Dedupe by ToolID; record source as the higher-priority strategy | (none — dedup is correct) |
| Eviction removes the only non-static tool the model needs next turn | Model rediscovers via meta-tool; one extra discovery turn | (none — graceful by design) |

There are no silent admissions. Every tool in the prompt has a recorded source (static, sticky, or discovery-driven). Every suppression has a reason.

---

## Diagnostics

Every `ToolAdmissionResult` carries a `Diagnostics` field with:

- `admitted_count` — count by source (static / sticky / discovery)
- `tokens_used`, `tokens_budget`, `tokens_evicted`
- `discovery_call` — if a meta-tool drove this call, which one and what it returned
- `suppressed_ids_with_reasons`
- `auth_filtered_count` — how many tools the user was unauthorized for
- `latency_per_strategy_ms`
- `cache_hits` (the catalog has its own caches: category indexes, embedding-search results)
- `warnings`

Per-call cost is auditable. The "how many tokens did my session spend on tool definitions" question is answerable.

---

## Worked Example

A coder profile session. The profile's static set is `[meta_tools, read_file, search_files, write_file]` (~1500 tokens of definitions).

**Turn 1.** User: *"Can you check if the rate limiter has tests and run them?"*

- Tool Composer admits static set. Budget remaining: ~3500 tokens (out of a 5000-token tool slice).
- No sticky ledger entries (new task).
- No discovery call yet.
- Model receives 4 tools: `list_tool_categories`, `list_tools_by_category`, `find_tool`, `read_file`, `search_files`, `write_file`. (Plus the meta-tool internals, ~6 tools total.)

The model issues `search_files("rate.*limit.*test")`. Tool already admitted; call goes through.

**Turn 2.** Search returns paths. Model needs a test runner. It does not have one in the static set. It calls `find_tool("run a test suite")`.

- Tool Composer sees `req.discovery_call` populated.
- Runs the semantic strategy over the catalog; returns top 3 matches: `run_jest`, `run_vitest`, `run_pytest`. Plus a category hint: "see `code.test.*` for more."
- The result lands as a tool_result turn (~300 tokens).
- Note: the actual tool definitions are NOT admitted yet. The model has the *names and descriptions* via the discovery result; if it wants to invoke, the tool gets admitted in full on the next turn (sticky path).

**Turn 3.** Model: *"This is a Jest project."* It issues `run_jest(path: "src/auth/rate-limiter.test.ts")`.

- Tool Composer sees the model is about to call a tool not yet admitted in full.
- Sticky path triggers: `run_jest` gets admitted in `full` form (~250 tokens including schema).
- Ledger updated: `tool_admissions: [..., {tool_id: run_jest, form: full, source: discovery}]`.
- Tool executes. Output lands as tool_result.

**Turn 4.** Model interprets results, reports back.

- Tool Composer admits static + sticky (`run_jest`). No new discovery.
- Cost stays bounded.

**Diagnostics for Turn 3 (admission):**

```
{
  admitted_count: { static: 6, sticky: 1, discovery: 0 },
  tokens_used: 1750,
  tokens_budget: 5000,
  tokens_evicted: 0,
  discovery_call: null,
  suppressed_ids_with_reasons: [],
  auth_filtered_count: 0,
  warnings: [],
}
```

**The principle in action.** A 200-tool catalog produced a session that admits at most 7-8 tools at peak. The model navigated to what it needed via two discovery calls (1 in turn 2, none thereafter), and once a tool was used, sticky admission kept it available without re-discovery. The token cost of the tool slice across the four turns is something like (1500, 1500+300, 1750, 1750) = ~6800 tokens total, vs. (15000 × 4) = 60000 for naive always-load-everything. ~89% reduction.

If an implementation disagrees with any step of this trace, that is the bug.

---

## Cost Model

Projected. Phase 1 must replace these numbers.

| Approach | Tools loaded per call | Token cost per call | Discovery turns per task |
|---|---|---|---|
| Naive always-load (50 tools) | 50 | ~15000 | 0 |
| Static-only profile (small fixed set) | 6–8 | ~1500 | (none — fixed) |
| This design (profile static + sticky + discovery) | 6–10 typical | ~1500–2500 | 1–3 typical |

The savings are in the per-call cost. The discovery turns are the trade — they cost 1–2 extra turns per task to navigate to the right tools. For tasks involving 5+ LLM calls (typical for non-trivial work), the savings dominate.

---

## Phased Delivery

**Phase 1 — Static + Categorical + Authorization (3–4 weeks):**

- ToolDef schema, ToolID stability, catalog.
- Static admission and the authorization filter.
- Categorical discovery (`list_tool_categories`, `list_tools_by_category`).
- Meta-tools as pinned static.
- Profile integration: `coder.v1` and `chat.v1` adopt this.
- Full diagnostics.

*Explicitly excluded from Phase 1:* semantic discovery, frequency strategy, telemetry, lazy schema expansion. The discovery story works with categorical alone in Phase 1; semantic and frequency are improvements gated on measurement.

**Phase 2 — Semantic Discovery + Lazy Expansion (2–3 weeks):**

- `find_tool` semantic strategy.
- Lazy schema expansion (`form: short` for discovery results, `form: full` on first invocation).
- Threshold tuning for semantic match quality.

**Phase 3 — Frequency + Personalization (gated on telemetry):**

- Per-profile frequency strategy.
- Per-user expansion of effective static set based on usage.
- Catalog management UI.

**Phase 4 — Advanced:**

- Cross-profile catalog sharing.
- Tool authoring API for product teams.
- A/B testing harness for tool description quality.

---

## Open Questions

| Question | Why open | Resolution path |
|---|---|---|
| Single parameterized meta-tool vs. three meta-tools | Some surfaces prefer one; some prefer the explicit triad | Default to three; allow profile to consolidate |
| Default tool budget per profile | Depends on typical workload | Start at 5000 tokens for coder, 1500 for chat; tune from data |
| Lazy expansion threshold | When does "short" become "full" — first call attempt, or earlier? | First call attempt in Phase 2; revisit if model hesitates calling |
| Whether tool ledger persists across sessions for the same task | Continuity benefit vs. staleness risk | Keep session-scoped; revisit if users want resumable tasks |
| How to handle tools whose definitions exceed the budget alone | Profile error vs. graceful skip | Profile error in v1; tool authors must keep defs under 1000 tokens |
| Whether the model can pin/unpin tools itself via meta-tools | Useful but powerful; could fragment ledger management | Defer to Phase 4; profile pinning only in v1 |

---

## What This Document Commits To

- **Hidden by default.** Tool admission is the inverted default, parallel to retrieval's admissibility principle.
- **Static + sticky + discovery.** Three sources of admission, in priority order. Eviction is the safety net.
- **Discovery is two turns.** Discover, then use. The architecture commits to this latency cost as the price of cost discipline.
- **Authorization filters at discovery.** Unauthorized tools never appear in discovery results. The model does not learn what it cannot use.
- **One TaskLedger, two record types.** Tools and chunks share lifecycle ownership; their re-admission semantics differ.
- **Profile-driven catalog.** Tools belong to profiles; users do not add tools mid-session in v1.
- **Stable ToolID across versions.** Audit trail survives catalog migrations.

These are the load-bearing decisions. Push back on any of them before building.
