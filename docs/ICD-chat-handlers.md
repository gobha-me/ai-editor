# ICD — `chat/handlers.js` + classification axes

> **Status:** initial draft, RE-EVAL following 2.41.0. First subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program". Tracks the contract between `js/chat/handlers.js`, `js/chat/tool-classifications.js`, and `js/chat/cache-invalidation.js` as it stands at 2.41.0. Code-aware findings from authoring this ICD feed back to ROADMAP as `[strong]`-band rows in subsequent code minors — none surfaced this pass.

## Purpose

The chat tool loop in `handleGeneralRequest` ([`js/chat/handlers.js`](../js/chat/handlers.js) lines 366-1190) consults membership in ~8 tool-name sets to decide per-tool behavior at 5 distinct decision points. Those sets live in [`js/chat/tool-classifications.js`](../js/chat/tool-classifications.js); the cache-invalidation helpers that consume the mutation sets live in [`js/chat/cache-invalidation.js`](../js/chat/cache-invalidation.js). The 2.25.0 hoist (audit-2026-Q2 inventory entries [DUP][M] in chat/) inverted an earlier "deliberately NOT hoisted" decision because the inline location was the recurring source of "missed an axis" bugs (per `feedback_prompts_js_parallel_enumeration.md`).

This ICD names each axis, its membership criterion, its trigger point in the loop, and its interactions with the other axes.

## The five axes

Each row names the question a tool must answer to be classified on that axis.

| Axis | Question | Exports |
|---|---|---|
| **Cache axis — dup-detection** | When the model calls this with identical args, should the same-request / cross-request dup-cache short-circuit? | `WRITE_TOOLS`, `STATEFUL_READ_TOOLS`, **`isStatefulRead(name)` + `getStatefulReadToolsLive()` (2.71.0; live union of `STATEFUL_READ_TOOLS` with registry-driven `cache: 'never'` declarations on `ToolDefinition`)** |
| **Cache axis — invalidation on success** | When this succeeds, which cached reads go stale and must be evicted? | `FILE_MUTATING_TOOLS`, `PREVIEW_MUTATING_TOOLS` (paired with `PREVIEW_READ_TOOLS`) |
| **Envelope axis — dup-cache hit messaging** | When a cache hit IS served, is the right reassurance "your prior mutation succeeded" or the generic "don't re-call"? | `MUTATING_TOOLS` |
| **FileOp axis — compression metadata** | For the upcoming Compression Rules (subsumption), does this fully replace a file or only edit a range? | `WHOLE_FILE_WRITE_TOOLS` |
| **Timeout axis — tool-loop scheduling** | How long is the loop willing to wait before treating this as hung? | `LONG_RUNNING_TOOLS`, `USER_PAUSE_TOOLS` |

Eight frozen exports + two live-accessor helpers (`isStatefulRead`/`getStatefulReadToolsLive`, added 2.71.0), plus the `canonicalArgsKey(args)` helper that produces the deep-stable JSON string used as `(toolName, sortedArgs)` cache keys throughout `tool-loop-core.js` and `cache-invalidation.js`. The asymmetry between axis count (5) and surface count (8 exports + 2 accessors) is load-bearing: each axis encodes a distinct *question*, but two axes (Cache(dup), Cache(invalidation), Timeout) carry more than one export because they need to differentiate within the axis (read vs. write, file vs. preview, long-running vs. user-pause).

**The Cache(dup) axis grew a second source at 2.71.0** — gitea#472 was the fourth recurrence of the cache-classification whack-a-mole (after gitea#301 / github#39 / 2.10.0 Tier 3a). The fix lifted classification onto `ToolDefinition.cache: 'by-args' | 'never'` at the registration site in [`js/tools/*.js`](../js/tools/) so the decision lives next to the tool author, not one or two files away in `tool-classifications.js`. The legacy `STATEFUL_READ_TOOLS` const is preserved unchanged as a documented baseline; `isStatefulRead(name)` reads the union (legacy ∪ live-registry-derived) at consumer call-sites in [`tool-loop-core.js:336`](../js/chat/tool-loop-core.js) and [`tool-loop-core.js:511`](../js/chat/tool-loop-core.js). 20 tools migrated to `cache: 'never'` at their registration sites; 27 occurrences across 17 tool files.

## Per-export contract

### `WRITE_TOOLS` ([tool-classifications.js:55](../js/chat/tool-classifications.js))

**Members:** `replace_lines`, `insert_lines`, `delete_lines`, `create_file`, `edit_file`, `write_file`, `delete_file`, `update_issue`, `add_issue_comment`.

**Trigger points in `handlers.js`:**
- Line 611: skip the cross-request dup envelope (`!WRITE_TOOLS.includes(toolName)`).
- Line 698: skip the same-request cached-result branch (`cachedResult && !skipCache && !WRITE_TOOLS.includes(toolName)`).
- Line 786: skip caching a fresh successful result (`!toolResult?.error && !WRITE_TOOLS.includes(toolName)`).
- Line 764: passed to `invalidateCachesForPath` so it can preserve write-tool log entries as informational history (vs. evicting stale reads).

**Invariant:** Every member appears in `tool-classifications.js`'s `Object.freeze([...])` list. Membership is checked via `.includes()` on the readonly array; `.push` accidents become `TypeError` at the accident site rather than silent drift.

### `STATEFUL_READ_TOOLS` ([tool-classifications.js:213](../js/chat/tool-classifications.js))

**Members:** `read_current_file`, `ask_user`.

**Trigger point:** Line 608 (`skipCache = STATEFUL_READ_TOOLS.includes(toolName)`). Both same-request and cross-request dup-caches are bypassed for these — the dup key `(toolName, sortedArgs)` collides across calls when hidden State changes between them.

**Membership criterion:** Tool result depends on implicit State, not on args alone. `read_current_file` reads `State.currentFile` (changes when the user opens a different file); `ask_user` is included because cross-request log would otherwise synth a stale "you already asked" hit on identical args — but the model may legitimately want to re-ask after the conversation moves on. Surfaced 2026-05-06 testing PR #293 against issue #23 (qwen-3-6-plus).

### `FILE_MUTATING_TOOLS` ([tool-classifications.js:87](../js/chat/tool-classifications.js))

**Members:** the 7 `WRITE_TOOLS` file-modification members **plus** `open_file`.

**Trigger point:** Consulted by `invalidateCachesForPath` ([cache-invalidation.js:52](../js/chat/cache-invalidation.js)) called from `handlers.js:758`. When membership holds, the helper evicts (a) same-request `toolCallCache` entries whose cache key includes `affectedPath` or starts with `read_current_file|`, and (b) cross-request `State.toolActionLog` entries whose `args.path`/`args.file_path` equals `affectedPath` or whose tool is `read_current_file`.

**Distinct from `WRITE_TOOLS` because `open_file` doesn't write disk** but does change which file `read_current_file` returns. The two issue-mutation members of `WRITE_TOOLS` (`update_issue`, `add_issue_comment`) are deliberately absent from `FILE_MUTATING_TOOLS` — they don't stale file-content reads.

**Why the asymmetry matters:** The 1.7.1 cache-invalidation-on-mutation pattern (gitea#301) was the first instance of this class of bug: a `read_lines(P)` entry logged before an `edit_file(P)` would still match on the post-edit retry, returning the synthetic `_cached: true` envelope pointing at pre-mutation content. The 1.6.11 staleness guard then demanded a fresh re-read, deadlocking dogfood sessions. `FILE_MUTATING_TOOLS` is the membership question that gates the eviction.

### `PREVIEW_MUTATING_TOOLS` ([tool-classifications.js:126](../js/chat/tool-classifications.js))

**Members:** `preview_stop`, `preview_click`, `preview_fill`, `preview_resize`.

**Paired with:** `PREVIEW_READ_TOOLS` ([tool-classifications.js:147](../js/chat/tool-classifications.js)) — `preview_start`, `preview_list`, `preview_console_logs`, `preview_errors`, `preview_logs`, `preview_network`, `preview_snapshot`, `preview_click`, `preview_fill`, `preview_inspect`, `preview_resize`.

**Trigger point:** `invalidateCachesForPreviewMutation` ([cache-invalidation.js:166](../js/chat/cache-invalidation.js)) called from `handlers.js:776`. Coarse-grained — evicts **all** `PREVIEW_READ_TOOLS` entries from both caches regardless of args, because `preview_stop({serverId})` doesn't carry the original `preview_start({path})` arg. Bounded by ~1 active server in practice, so coarseness is acceptable.

**Why the overlap is intentional:** `preview_click`, `preview_fill`, `preview_resize` appear in **both** sets. They're driving tools that mutate iframe state (DOM mutations, input value changes, dimension changes) *and* read it (the call returns snapshot/state). Membership in `PREVIEW_MUTATING_TOOLS` triggers cache eviction; membership in `PREVIEW_READ_TOOLS` makes them eligible for that eviction the next time a sibling mutator fires. Validated by 2026-05-10 qwen-3-6-plus dogfood on HTML-Games (Sokoban, Tetris).

**Deliberate non-members of `PREVIEW_MUTATING_TOOLS`:** `preview_inspect` and `preview_snapshot`. Snapshot writes `data-preview-uid` attributes, but uids are deterministic by document order and stable across calls — adding snapshot to the mutator set would invalidate its own cache entry, defeating the dup-refusal guard for legitimate same-args probes.

### `MUTATING_TOOLS` ([tool-classifications.js:183](../js/chat/tool-classifications.js))

**Members:** `commit_files`, `create_issue`, `create_pull_request`, `merge_pull_request`, `add_pr_review`, `memory_remember`, `memory_revise`, `scratchpad_write`, `scratchpad_clear`, `write_plugin_source`.

**Trigger points:** Lines 693, 704 in `handlers.js`. When a dup-cache hit *is* served, the `_cache_note` envelope text branches on `MUTATING_TOOLS.includes(toolName)`:
- Member → `"Your prior {toolName} call already SUCCEEDED earlier in this conversation. Outcome: {summary}. The mutation has happened — treat the prior result as authoritative and continue. Do not retry to confirm; that would re-attempt the mutation or loop on this same cache."`
- Non-member → `"You already called {toolName} with these arguments earlier in this conversation. The result was: {summary}. Do NOT call this tool again with the same args."`

**Why this axis isn't `WRITE_TOOLS`:** `WRITE_TOOLS` is about *whether to short-circuit the cache*; `MUTATING_TOOLS` is about *what reassurance to send when the cache short-circuits anyway*. These have empty intersection by design — `WRITE_TOOLS` members never hit the cache-served branch (they're explicitly skipped at line 698), while `MUTATING_TOOLS` members deliberately stay cached so accidental double-commits / double-comments are caught.

**History:** Surfaced by the qwen-3-6-plus PR #289 trace where the model panicked on the generic don't-retry note for `commit_files` and entered a 3-turn confirmation loop; the targeted envelope here resolved it. github#35.

### `WHOLE_FILE_WRITE_TOOLS` ([tool-classifications.js:76](../js/chat/tool-classifications.js))

**Members:** `write_file`, `create_file`, `delete_file`, `write_plugin_source`.

**Trigger point:** [`js/chat/turn-enrich.js#extractFileOps`](../js/chat/turn-enrich.js). Mints FileOp `op: 'write'` vs `op: 'edit'` for the Compression subsumption rule (DESIGN-compression §Rule 1).

**Strict subset of `WRITE_TOOLS`:** every member also lives in `WRITE_TOOLS`. The question is different — "does this fully replace prior file content?" vs. "should the dup-cache short-circuit a fresh call?" — so the sets stay separate. `replace_lines`, `insert_lines`, `delete_lines`, `edit_file`, `update_issue`, `add_issue_comment` are deliberately excluded: range-scoped or non-file.

### `LONG_RUNNING_TOOLS` ([tool-classifications.js:226](../js/chat/tool-classifications.js))

**Members:** `wait_for_ci`.

**Trigger point:** Line 720-723 in `handlers.js`. When membership holds, the per-tool timeout swaps `settings.toolTimeout` (default 30 s) for `settings.longRunningToolTimeout` (default 300 s).

**Why a separate axis:** the standard 30 s wall is calibrated for read/write ops in human-reaction time; CI polling is bounded only by CI duration. The smallest practical override floor is ~5 minutes.

### `USER_PAUSE_TOOLS` ([tool-classifications.js:243](../js/chat/tool-classifications.js))

**Members:** `ask_user`, `submit_plan_for_approval`, `submit_script_for_approval`.

**Trigger point:** Line 719, 724-728 in `handlers.js`. When membership holds, the timeout swaps to `settings.userPauseTimeout` (default 24 h) — a watchdog floor, not a normal-case timeout. The user can sit with a question or plan as long as they want; the floor exists so a DOM error / Preact crash / conversation-switch race that prevents the card from mounting doesn't deadlock the loop forever.

**`ask_user` appears in both `STATEFUL_READ_TOOLS` and `USER_PAUSE_TOOLS`** — different axes, different questions: "should the dup-cache see this as repeatable?" (yes, dup-skip) and "how long is the timeout?" (24 h watchdog).

## Interaction matrix

The axes are *mostly* orthogonal. Asserted invariants and intentional overlaps:

### Asserted by `tests/test-tool-classifications.mjs`

- `WRITE_TOOLS ∩ MUTATING_TOOLS = ∅` — the cache-skip and envelope-messaging axes never collide; if the cache skips, the envelope path is unreachable.
- `WRITE_TOOLS ∩ STATEFUL_READ_TOOLS = ∅` — writes don't read implicit state.
- `WHOLE_FILE_WRITE_TOOLS ⊆ (WRITE_TOOLS ∪ MUTATING_TOOLS)` — every whole-file write is classified in at least one cache-axis set.

### Intentional overlaps

- `FILE_MUTATING_TOOLS ⊇ (WRITE_TOOLS file-ops)` plus `{open_file}` — `open_file` is the file-axis stateful-read coupling that justifies the separate set.
- `PREVIEW_MUTATING_TOOLS ∩ PREVIEW_READ_TOOLS = {preview_click, preview_fill, preview_resize}` — drivers that both mutate and read.
- `STATEFUL_READ_TOOLS ∩ USER_PAUSE_TOOLS = {ask_user}` — two axes that happen to apply to the same tool.

### Open invariants (not asserted today)

- `MUTATING_TOOLS ∩ WRITE_TOOLS` should remain `∅` even as new tools land. If a hypothetical tool truly belongs in both (e.g. a remote write that the model should be allowed to retry), the axis design needs revisiting first.
- `LONG_RUNNING_TOOLS ∩ USER_PAUSE_TOOLS` is currently `∅` but not enforced. If a future tool legitimately needs both (a 24 h CI poll), the longer floor should win.

## The Composer-vs-non-Composer path drift

A second contract this ICD covers: the system-prompt tool enumeration must agree with the API tools-array on every call.

### How both paths derive enumeration

[`buildSystemPrompt`](../js/prompts.js) accepts `{ admittedDefs, composerActive }`. Two branches:

- **`composerActive: true`** — caller (always `handlers.js` line 381-382) passes the already-admitted `admittedDefs` from `LLMTools.getAdmittedTools()`. Enumeration renders directly from that array.
- **`composerActive: false`** — `buildSystemPrompt` derives the enumeration from `Profiles.filterTools(ToolRegistry.getDefinitions(), profileName).map(...)`. The same filter that powers the API tools-array (via `LLMTools.getToolsForRole()` → `ToolRegistry.getDefinitions()` → filtered by role).

**Pre-2.35.0, this was the second source of bugs in the inventory.** The legacy path used a hardcoded `LEGACY_TOOL_ENUMERATION` constant — every tool addition (Tier 3a preview at 2.10.0, CI tools at 1.4.5, `git_log` at 1.5.x, LLM-authored automation at 1.16.0) silently failed to update that constant. The 2.35.0 deletion + same-projection derivation makes both branches read from `ToolRegistry` + `Profiles.filterTools()` — one source, two formats.

### Why this is part of the same ICD

Both `handlers.js`'s admission decision AND `prompts.js`'s enumeration rendering must reflect the same "what tools is this profile actually using right now" question. They're separate code paths today, but the invariant is the same: **the model's view of available tools (system prompt enumeration) must equal the model's actual available tools (API tools-array).**

Drift here is invisible to tests that only run one path. The next ICD slot (per ROADMAP §"Per-subsystem ICD backfill program" line 94: `RE-EVAL following 2.44.0`) covers the Composer seam in isolation — this section serves as the cross-reference.

## Why these axes resist consolidation

A natural-looking refactor is "build one `TOOL_METADATA = { [name]: { write: bool, mutating: bool, statefulRead: bool, ... } }` registry." That has been considered and deferred for two reasons:

1. **Each axis triggers at a different point in the loop.** Cache skip happens before execution (line 608); envelope-messaging happens during cache hit (line 693); FileOp tagging happens after success (in `turn-enrich.js`); timeout selection happens at the `Promise.race` (line 720). A single per-tool record forces every consumer to read the whole record; the current per-axis frozen arrays let each consumer ask *only* the question it cares about.

2. **The 2.25.0 hoist's load-bearing decision was matrix-scan, not consolidation.** The maintainer adding a new tool reads `tool-classifications.js` top-to-bottom and decides axis-by-axis — that's the scan pattern. A consolidated table would make the question "is this row complete?" harder to answer than "does this tool need to be in this list?" The hoist optimized for the scan; consolidation would lose that affordance.

The collapse remains a future option if a third source of axis-drift bugs surfaces; today the per-axis frozen exports + the disjointness tests in `tests/test-tool-classifications.mjs` are the contract.

## Forward-evolution rules

When adding a new tool to `js/tools/`:

1. **Read `js/chat/tool-classifications.js` top-to-bottom.** For each frozen export, ask the axis question; add the tool's name if-and-only-if the answer is yes.
2. **If the tool is a `MUTATING_TOOLS` candidate, confirm it does NOT belong in `WRITE_TOOLS`** — the cache-skip and envelope-messaging axes are disjoint by design.
3. **Pure-read tools (no `State` access, no side effects) appear in zero exports.** That's the default; no action needed.
4. **If the tool changes file content or the active file selection, add to `FILE_MUTATING_TOOLS` regardless of whether it's also in `WRITE_TOOLS`.** The cache-invalidation eviction is what gates the recurring deadlock pattern.
5. **Cache classification at the registration site (2.71.0 lint guard).** Declare `cache: 'by-args' | 'never'` on the `ToolDefinition` passed to `ToolRegistry.register()`. Default is `'by-args'` (omittable — pure function of args, dup-cache short-circuits + path/preview invalidation applies). Use `'never'` for any tool whose result depends on hidden state, aggregates whole-FS / whole-IDB views, polls remote state, or carries USER_PAUSE semantics. **The lint guard [`test-tool-cache-classifications.mjs`](../tests/test-tool-cache-classifications.mjs) source-scans every `js/tools/*.js` registration block and REQUIRES explicit `cache:` declaration for tool names matching the stale-prone shape regexes `list_*` / `find_*` / `get_*` / `*_status` / `*_logs`** (an aggregating-name allowlist `STALE_PRONE_NAME_ALLOWLIST` is the deliberate escape hatch when a stale-shape name turns out to be a pure args function — authors must add to the allowlist with rationale, the guard rejects silent additions). The guard also pins migration completeness against `STATEFUL_READ_TOOLS` and the gitea#472 fix-lock on `list_dirty_files`.
6. **Run `node --test tests/test-tool-classifications.mjs tests/test-tool-cache-classifications.mjs`** — the disjointness invariants catch axis overlap bugs at CI time; the cache-classifications lint catches stale-prone-name additions that forgot to classify.

When changing axis membership for an existing tool:

1. **The frozen `Object.freeze([...])` exports prevent `.push` accidents at runtime** — a `TypeError` fires at the mutation site. Edit the export-site list.
2. **Update the JSDoc rationale** if the change reflects a behavior shift (e.g., a tool gaining a new side effect that promotes it from `READ` to `WRITE`).
3. **Add a regression test** in `tests/test-tool-classifications.mjs` if the change closes a real incident — the per-incident JSDoc references (github#39, gitea#301, github#35) are the precedent.

## References

- Source: [`js/chat/handlers.js`](../js/chat/handlers.js) (tool loop), [`js/chat/tool-classifications.js`](../js/chat/tool-classifications.js) (axis exports), [`js/chat/cache-invalidation.js`](../js/chat/cache-invalidation.js) (eviction helpers), [`js/chat/turn-enrich.js`](../js/chat/turn-enrich.js) (FileOp axis consumer), [`js/prompts.js`](../js/prompts.js) (Composer-vs-non-Composer enumeration), [`js/llm/api.js`](../js/llm/api.js) (`LLMTools.getAdmittedTools` / `getToolsForRole`).
- Tests: [`tests/test-tool-classifications.mjs`](../tests/test-tool-classifications.mjs) (disjointness + frozen-array invariants), [`tests/test-system-prompt-admission.mjs`](../tests/test-system-prompt-admission.mjs) (2.35.0 Composer-vs-non-Composer projection).
- History anchors: 2.25.0 hoist (audit-2026-Q2 inventory [DUP][M]); 2.35.0 `LEGACY_TOOL_ENUMERATION` deletion; 1.7.1 / gitea#301 (cache-invalidation pattern instance 1); 2.10.0 / Tier 3a + github#39 (pattern instance 2); 2.10.1 (cross-request entry args-matching fix); github#35 (envelope axis introduction).
- Methodology: [ROADMAP.md](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #1; the Composer seam is target #2 at `RE-EVAL following 2.44.0`).
