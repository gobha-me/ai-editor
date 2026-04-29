# DESIGN — Compression: Conversation History Compaction

**Status:** Draft
**Depends on:** A turn store with stable turn identity and metadata. Optional: a small utility model for summarization (only required for Phase 3).
**Sibling subsystems:** `DESIGN-retrieval.md`, `DESIGN-memory.md`. All three are coordinated by `DESIGN-intelligence.md`.

---

## Problem

Conversation history grows monotonically. Every turn the user sends, every response the assistant produces, every tool call and tool result — all of it lands in the history buffer and stays there until something explicitly removes it. In a short chat session this is fine. In a long, tool-heavy session it is the dominant consumer of input tokens, and most of what it contains is no longer informationally useful by the time the next call is made.

A worked example, drawn from a real coding session:

- The model reads `style.css` lines 150–165.
- A turn later, it reads `style.css` lines 150–290 (a strict superset).
- A turn later, it edits `style.css` lines 153–289 (replacing 137 lines with 2).
- Three turns later, it reads `map.js` lines 105–120, then 125–140, then 130–145, then 145–155 — four overlapping reads of the same region.
- Several edits later, it edits `map.js` lines 141–148, then re-reads, then edits again to fix a duplicate brace it just introduced, then re-reads again.

By the end of the session, the raw history contains: the original narrow read of `style.css` (now strictly redundant with the wider read); the wider read of `style.css` (now describing content that no longer exists post-edit); four overlapping reads of `map.js` (only the widest contains information not in the others); a sequence of edit-fix-edit-fix turns that, once resolved, can be summarized as "fixed duplicate closing brace after refactor."

Naive history handling pays full input-token cost for every one of those turns on every subsequent call. The cumulative effect across a long session is the bulk of the 12M-input-token sessions that motivated this work in the first place.

The thesis of this document is that **conversation history is not a log; it is a corpus of facts of varying durability, and the compression layer's job is to evict the ones that have ceased to be informationally useful before paying to summarize the rest.** Eviction is cheap. Summarization is expensive. A well-designed compression layer does as much work as possible with the cheap rules and reaches for summarization only when nothing cheaper applies.

This is the admissibility principle (see `DESIGN-intelligence.md`) applied at the conversation buffer: a turn must continue to *earn* its place in the compressed history. Mere chronological position is not a justification for inclusion. The five rules below define the grounds on which a turn can lose its admission, in priority order.

### What this is not

- **Not memory.** The memory subsystem extracts durable facts from interaction with explicit consent. Compression operates on the in-flight conversation buffer and produces a smaller buffer. A compressed history is still conversation; an extracted memory is curated knowledge. Conflating the two is the most common architectural mistake in this space.
- **Not retrieval.** Retrieval selects content from a corpus into the context window. Compression reduces what's already in the context window (specifically, the conversation portion of it). They share infrastructure (vector store, embeddings) but they are distinct operations.
- **Not an editor's audit trail.** If a tool host needs to know "was a recent read of this region performed before this write was authorized," that ledger lives in the tool host, not in the model's history. The compression layer is free to evict a turn from the model's view of history while the tool host continues to track that the underlying event occurred. This separation is non-negotiable; conflating the two is what causes systems to keep stale reads in context for the entire session.
- **Not a guarantee of token savings.** Some compression rules are conditional on the conversation containing the patterns they recognize. A 10-turn conversation about poetry will not benefit from the file-edit invalidation rule. Compression is a contract for *correctness* (no eviction loses information that the model still needs) more than for *savings*.

---

## Goals

1. **Eviction before summarization.** Cheap rules first. Summarization only for what survives them.
2. **Explicit, auditable decisions.** Every turn that is dropped, replaced, or summarized is recorded with the rule and reason. Compression is debuggable.
3. **Profile-driven rule sets.** Different surfaces (chat, multi-user, RP, coder, KB) register different rule sets. The library does not assume one policy fits all.
4. **No silent loss.** The compressed history exposes which turns it covers; downstream code can detect when the model is asked about a turn that was evicted.
5. **Composable with retrieval.** The compression layer's output is the `history` field that retrieval consumes. The two subsystems do not need to know each other's internals.

---

## Non-Goals

- Reordering turns. Compression preserves chronological order of what survives.
- Cross-session compression. Compressing across session boundaries is a memory concern (extract durable facts), not a compression concern.
- Streaming compression. Rules run between turns, not during a turn.
- Lossless reconstruction. Once a turn is evicted from the compressed history, the model cannot see it. (The full uncompressed history can be retained in the turn store for audit and replay; the compression layer just doesn't surface it.)
- Multi-modal. Image and audio turns pass through unchanged in v1.

---

## The Load-Bearing Decision: Eviction Before Summarization

The most common mistake in conversation-history compaction is to reach immediately for an LLM summarizer. This is the wrong order of operations.

Summarization is the most expensive option in the rule set:

- It costs an extra inference call (latency and dollars).
- It loses information by construction — what survives is the summarizer's compression of what existed.
- It introduces a second model into the trust boundary.
- It cannot be reversed if the summary turns out to be wrong.

By contrast, **eviction is structural**. If turn B is strictly subsumed by turn C, dropping B preserves all the information that C covers. There is no inference call, no token cost, no information loss relative to what the model already had access to in C.

This produces a strict ordering principle for the rule set:

1. **Subsumption** — drop turns whose information is fully present in a later turn.
2. **Invalidation** — drop turns whose information has been superseded by an action that changed the underlying fact.
3. **Consumption** — drop turns whose only purpose was to authorize a now-completed action.
4. **Resolution** — replace a back-and-forth debugging exchange with a one-line marker once it terminates successfully.
5. **Summarization** — for what survived 1–4 and still exceeds the budget, run an LLM.

The first four are deterministic, structural, and free at inference time. The fifth is the fallback.

This ordering is the discipline. A compression layer that jumps to summarization first is doing five-times the work to get a worse result. A layer that does eviction first reaches summarization only when the surviving content genuinely needs it.

---

## Architecture

```
┌──────────────────────────────────────────┐
│  Caller (provides raw history + budget)  │
└──────────────────┬───────────────────────┘
                   ▼
         ┌───────────────────┐
         │  Compactor        │
         │   ├─ Rule Pipeline│  ← eviction rules in priority order
         │   ├─ Budget Check │
         │   └─ Summarizer   │  ← only if budget still exceeded
         └─────────┬─────────┘
                   │
                   ▼
         ┌───────────────────┐
         │  Compressed       │
         │  History          │  ← consumed by retrieval as `req.history`
         └───────────────────┘
```

The Compactor is the only surface callers use. The rule pipeline and summarizer are internal. The output is consumed by retrieval (`DESIGN-retrieval.md`) as the `history` field of `RetrievalRequest`.

---

## Core Contracts

### Turn — the atomic unit

Every entry in the conversation buffer is represented as a `Turn`. Turn identity is stable; rules reference turns by ID, and diagnostics report decisions by ID.

```
Turn {
  id:         TurnID            // stable across the session
  role:       Role              // user | assistant | tool_call | tool_result | system
  content:    string
  tokens:     int               // precomputed for the target tokenizer family
  timestamp:  timestamp
  metadata:   TurnMetadata
}

Role = "user" | "assistant" | "tool_call" | "tool_result" | "system"

TurnMetadata {
  speaker_id:      string?           // multi-user surfaces
  persona_id:      string?           // RP surfaces
  in_character:    bool?             // RP surfaces
  scene_id:        string?           // RP surfaces (episodic boundary)
  tool_name:       string?           // tool_call, tool_result
  tool_args:       map<string,any>?  // tool_call
  tool_result_for: TurnID?           // tool_result → its tool_call
  file_ops:        []FileOp?         // any file reads/writes performed
  superseded_by:   []TurnID?         // explicit causal supersession from caller
  custom:          map<string,any>   // opaque to the library
}

FileOp {
  path:         string
  op:           "read" | "write" | "edit"
  range:        (int, int)?    // line or byte range; required for read/edit
  content_hash: string?        // for write/edit, the hash of the resulting file
}
```

**Why these fields, specifically:**

- `tokens` is precomputed at turn ingest, not on the hot path. The Compactor does budget math on every call.
- `file_ops` is the field that enables Subsumption and Invalidation. Without it, those rules cannot fire — they are no-ops on conversations that don't carry file metadata. This is intentional: a chat profile that doesn't generate `file_ops` will not pay any cost for the file-related rules.
- `tool_result_for` enables Consumption. A tool result whose tool call has been completed and whose result has been acted upon can be evicted; the link is what makes the rule decidable.
- `superseded_by` is an escape hatch for callers who already know one turn replaces another (e.g., the caller regenerated a tool result after a transient failure). The library trusts caller-supplied supersession.

### CompressionRule — the plug-in seam

Every rule implements the same interface:

```
CompressionRule {
  name:     string
  priority: int                          // lower runs first
  evaluate(turn: Turn, history: []Turn) -> Decision
}

Decision = Keep
         | Drop(reason: string)
         | Replace(marker: string, reason: string)
         | Summarize(reason: string)    // hint to the summarizer
```

The Compactor evaluates rules in priority order. The first non-`Keep` decision wins for a given turn. `Summarize` is a hint, not an immediate action — it marks the turn as eligible for summarization if the budget check still fails after eviction.

### CompressionRequest / CompressionResult

```
CompressionRequest {
  history:          []Turn
  budget_tokens:    int               // target ceiling for compressed history
  rules:            []CompressionRule  // profile-supplied
  summarizer:       SummarizerFn?     // optional
  preserve_recent:  int                // never evict the last N turns
}

CompressionResult {
  history:          []Turn          // compressed; may include synthesized markers
  diagnostics:      Diagnostics
  evicted_ids:      []TurnID        // for caller-side audit
  surviving_ids:    []TurnID
  summarized_spans: []Span          // ranges that were summarized
}
```

`preserve_recent` is not a rule; it is a hard invariant. The most recent N turns are never evicted regardless of what the rules say. This prevents the most embarrassing failure mode: compressing the user's most recent message because some rule misfired.

The result is a list of `Turn` values, not a flat string. The retrieval layer consumes this list and integrates it into the composed prompt. Synthesized markers (from `Replace` decisions) are emitted as turns with `role = "system"` and content like `"[Compactor: 6 turns about duplicate brace fix in map.js — resolved successfully]"`.

---

## Turn Identity and Stability

Like ChunkID in retrieval, TurnID must be stable across operations. A turn that is evicted must be referable by its ID forever (for audit), and a turn that is summarized into a span must still be locatable by ID in the underlying turn store.

```
TurnID = hash(session_id || sequence_number || timestamp_ms)
```

Sequence numbers are session-monotonic. Timestamps are session-millisecond. The hash is deterministic per turn and never reused.

The compression layer never mutates turn IDs. It produces a new list of turns (some surviving, some synthesized) but the original turns remain in the turn store for audit and replay.

---

## The Five Rules

### Rule 1: Subsumption

**Trigger:** A later turn's payload strictly contains an earlier turn's payload.

**Decision:** `Drop` the earlier turn.

**Cost:** Free (set comparison).

**Applicability:** Requires `file_ops` metadata or some equivalent payload identity. A pure prose conversation does not benefit from this rule.

**Algorithm (file-read case):**

For each pair `(A, B)` where `A` precedes `B`, both have `FileOp(read, path P)`, and `B.range ⊇ A.range` and there are no intervening `FileOp(write|edit, P)` turns between them: drop `A` with reason `"subsumed_by:{B.id}"`.

**Edge cases:**

- Intervening write to the same file invalidates the subsumption (the wider read no longer describes the same content). Defer to Rule 2 instead.
- Reads from different file versions are not comparable. The `content_hash` on writes provides the version anchor.

### Rule 2: Invalidation

**Trigger:** A later turn modifies bytes that an earlier turn read.

**Decision:** `Drop` the earlier read.

**Cost:** Free (range overlap check).

**Applicability:** Requires `file_ops` metadata. Most useful in coder profiles.

**Algorithm:**

For each turn `B` with `FileOp(write|edit, P, range R_B)`: any preceding turn `A` with `FileOp(read, P, range R_A)` such that `R_A ∩ R_B ≠ ∅` is dropped with reason `"invalidated_by:{B.id}"`.

A read that overlaps the write is dropped. A read that doesn't overlap survives. A read of file `Q` is unaffected by writes to file `P`.

**Edge cases:**

- A write that fails (the tool returned an error) does not invalidate prior reads. The rule reads the success state from the tool result.
- A read of `P` after the write of `P` is the new authoritative view; both the pre-write read (dropped) and the post-write read (kept) can coexist transiently if Rule 1 hasn't yet run on the pair.
- The combination of Rule 1 and Rule 2 is the critical pair for tool-heavy sessions. Together they handle the dominant pathology — overlapping reads with intervening edits — at zero cost.

### Rule 3: Consumption

**Trigger:** A turn's only purpose was to authorize a now-completed action, and a grace window has elapsed.

**Decision:** `Drop` the authorizing turn.

**Cost:** Free (event match).

**Applicability:** Requires `tool_result_for` linkage between calls and results, plus a profile-supplied notion of "completion."

**Algorithm:**

Consumption is the rule that makes "read this region so I can edit it" turns evictable once the edit succeeds and the next reasoning step has occurred. The pattern:

1. Turn `A` is `read_lines` of `path P`, `range R`.
2. Turn `B` is `edit_file` of `path P`, `range R'` where `R' ⊆ R`, succeeded.
3. Turn `C` is the assistant's next reasoning turn after `B`.

Once `C` exists and `B` succeeded, `A` is evicted with reason `"consumed_by:{B.id}"`.

The grace window (one turn after success, by default) exists because the model often needs the read content during the turn that issues the edit. After the edit lands and the model has moved on, the read has served its purpose.

**Edge cases:**

- Failed edits do not consume their reads. The model needs the read for the retry.
- Reads that fed multiple edits are consumed only after all of them have completed.
- Reads that the model continues to reference (citation in subsequent turns) are not detectable as such; this rule will evict them. If that becomes a problem in practice, add an opt-out marker (`metadata.do_not_consume`) the assistant can set.

### Rule 4: Resolution

**Trigger:** A back-and-forth that ends with success can be replaced with a one-line marker.

**Decision:** `Replace` the span with a marker.

**Cost:** Cheap (template substitution); no LLM call.

**Applicability:** Requires explicit success markers (test pass, build success, commit success, user confirmation). Most useful in coder profiles and any agent-loop surface.

**Algorithm:**

Identify a span `[T_i ... T_j]` such that:

- `T_i` is the first turn raising a problem (an error message, a failing test, a user-reported bug).
- `T_j` is a turn explicitly marking resolution (build_success, test_pass, commit, user confirmation like "ok that works").
- All intervening turns are about the same problem (heuristic: same file paths, same error keywords).

Replace the span with a single synthesized turn:

```
role:    "system"
content: "[Compactor: {summary} — resolved at {T_j.timestamp}]"
```

Where `{summary}` is generated *without* an LLM call by template: `"{N} turns debugging {error_keyword} in {file_paths}"`. Templated summaries are predictable and cheap; LLM-generated summaries are Rule 5's job.

**Edge cases:**

- Spans that haven't yet resolved are left alone. Resolution is past-tense.
- Multi-bug interleavings are tricky. The conservative approach: only resolve a span if a single problem thread can be cleanly identified. When in doubt, leave it for Rule 5.

### Rule 5: Summarization

**Trigger:** Compressed history (after Rules 1–4) still exceeds budget.

**Decision:** `Summarize` the oldest surviving block of turns.

**Cost:** Expensive (LLM inference call).

**Applicability:** Always available as a fallback if a summarizer is configured. Profiles that disable summarization (e.g., short-session KB) skip this rule entirely.

**Algorithm:**

1. Identify the oldest contiguous block of `Keep`-decision turns that, if summarized, would bring history under budget.
2. Pass them to the configured summarizer with a profile-supplied prompt template.
3. Replace them with a single `system`-role turn carrying the summary.
4. Tag the result with `summarized_span: (first_id, last_id)` for diagnostics.

**Constraints:**

- Summarization is bounded by `preserve_recent` — the most recent N turns are never summarized.
- Summarization runs in chronological chunks; never summarize a chunk in the middle of history if the chunk before it survived. (Otherwise the history reads as a non-monotonic narrative, which confuses the model.)
- A failed or timed-out summarization falls back to evicting the oldest turns outright with a warning, rather than blocking the request.

---

## Pipeline Algorithm

```
compress(req: CompressionRequest) -> CompressionResult:

  # 1. Sort rules by priority
  rules = sorted(req.rules, key=lambda r: r.priority)

  # 2. First pass: per-turn rule evaluation (eviction rules only)
  decisions = {}
  for turn in req.history:
    if is_within_preserve_recent(turn, req):
      decisions[turn.id] = Keep
      continue

    for rule in rules:
      if rule.is_summarizer:                # priority skip
        continue
      decision = rule.evaluate(turn, req.history)
      if decision != Keep:
        decisions[turn.id] = decision
        break
    else:
      decisions[turn.id] = Keep

  # 3. Apply non-summarize decisions
  surviving = []
  for turn in req.history:
    d = decisions[turn.id]
    if d is Keep:
      surviving.append(turn)
    elif d is Replace:
      surviving.append(synthesize_marker_turn(turn, d))
    elif d is Drop:
      pass

  # 4. Resolution-rule spans collapse here (cross-turn)
  surviving = apply_span_rules(surviving, rules)

  # 5. Budget check — if still over, summarize oldest
  while sum(t.tokens for t in surviving) > req.budget_tokens:
    if req.summarizer is None:
      break                                  # nothing more to do
    span = select_oldest_summarizable_span(surviving, req)
    if span is None:
      break                                  # nothing left to summarize
    summary_turn = req.summarizer(span)
    surviving = replace_span(surviving, span, summary_turn)

  # 6. Final budget check
  if sum(t.tokens for t in surviving) > req.budget_tokens:
    surviving = drop_oldest_until_under_budget(surviving, req)
    diagnostics.warnings.append("budget_exceeded_after_summarization")

  return CompressionResult(history=surviving, ...)
```

**The order matters.** Per-turn eviction (Rules 1, 2, 3) runs first, on individual turns. Span replacement (Rule 4) runs second, on what survives. Budget-driven summarization (Rule 5) runs last, only if needed.

**Multiple non-`Keep` decisions for one turn:** the lowest-priority (first-evaluated) rule wins. Rules are explicitly ordered by `priority`; ties are resolved by registration order. Diagnostics record which rule fired.

---

## Profile Integration

Compression is consumed via context profiles, the per-surface adapter layer described in `DESIGN-intelligence.md`. Each profile registers a rule set:

| Profile | Rules registered (priority order) | Notes |
|---|---|---|
| Standard chat | 5 | Generic summarization; no file rules apply |
| Multi-user chat | 5 | Summarizer prompt preserves speaker attribution |
| RP / personas | 4 (templated by scene boundary), 5 | Preserve in-character voice; never summarize across scene boundaries |
| Coder | 1, 2, 3, 4, 5 | All rules; aggressive eviction |
| RAG / KB | (none) | Sessions too short to compress; turn this off entirely |

The "Coder" profile is the one the rule set was designed for and where the savings are largest. The "RAG / KB" profile illustrates that compression is opt-in at the profile level — a surface that doesn't need it pays no cost.

Profiles can also supply rule *parameters* (e.g., `consumption_grace_window=2` instead of the default 1) and rule *implementations* (e.g., a domain-specific Resolution detector for an SQL-debugging profile). The library ships defaults for the five rules; profiles override what they need.

---

## Failure Modes

Every seam has a defined behavior on failure. The defaults err toward keeping turns rather than evicting them when in doubt — false positives in eviction (losing a turn the model needed) are worse than false negatives (paying for a turn that was redundant).

| Failure | Behavior | Surfaced as |
|---|---|---|
| A rule throws | Skip the rule for that turn; turn defaults to `Keep` | `diagnostics.rule_errors` |
| Two rules disagree on a turn | Lower-priority rule wins (priority-ordered) | `diagnostics.rule_conflicts` |
| Summarizer times out | Fall back to dropping oldest turns; warn | `diagnostics.warnings` |
| Summarizer returns malformed output | Fall back to dropping the span; warn | `diagnostics.warnings` |
| `preserve_recent` exceeds budget | Compressed history exceeds budget; warn | `diagnostics.warnings` |
| Turn missing required metadata for a rule (e.g., no `file_ops`) | Rule returns `Keep`; no error | `diagnostics.rules_skipped` |
| Span identified by Rule 4 spans a `preserve_recent` boundary | Truncate the span at the boundary; replace only the prefix | `diagnostics.warnings` |
| Caller-supplied `superseded_by` references unknown turn | Drop the supersession; warn | `diagnostics.warnings` |

There are no silent evictions. Every drop, replace, and summarization decision is traceable to a specific rule and reason.

---

## Diagnostics

Every `CompressionResult` carries a `Diagnostics` field with at least:

- `rules_run` — list of rule names that were evaluated
- `rules_skipped` — rules skipped (with reason: missing metadata, no applicable turns)
- `decisions_by_rule` — count of each decision type per rule
- `evicted_ids` — TurnIDs dropped, with reason
- `replaced_ids` — TurnIDs replaced by markers, with reason
- `summarized_spans` — TurnID ranges that were summarized, with model name and latency
- `tokens_in` — input history token count
- `tokens_out` — compressed history token count
- `compression_ratio` — `tokens_out / tokens_in`
- `warnings` — structured warning entries
- `rule_errors` — exceptions thrown by rules (rule name + error)
- `latency_per_rule_ms` — per-rule wall time
- `summarizer_latency_ms` — if summarization ran

These fields are cheap to populate and make compression decisions debuggable in production. The same way retrieval diagnostics enable "why did this chunk make it into context," compression diagnostics enable "why did this turn get evicted."

---

## Worked Example

Replaying the session export referenced in the Problem section through the rule pipeline. The session contains, in order:

1. `read_lines style.css L150-165` — TurnID T1
2. `read_lines style.css L150-290` — T2 (strict superset of T1)
3. `edit_file style.css L153-289` (replace 137 lines with 2; success) — T3
4. `list_dirty_files` — T4
5. `read_file setup.js` — T5
6. `write_file setup.js` (full rewrite; success) — T6
7. `commit_files` (success) — T7
8. *(error appears: FACTIONS.find().getMoveBonus is not a function)* — T8
9. `read_lines units.js L1-20` — T9
10. `edit_file units.js L15-15` (success) — T10
11. `commit_files` (success) — T11
12. *(new error: hex.key is not a function)* — T12
13. `read_lines map.js L105-120` — T13
14. `read_lines map.js L125-140` — T14
15. `read_lines map.js L130-145` — T15 (overlaps T14)
16. `read_lines map.js L145-155` — T16 (overlaps T15)
17. `edit_file map.js L141-148` (introduces duplicate brace) — T17
18. `read_lines map.js L148-155` — T18 (re-read, post-T17)
19. `edit_file map.js L150-152` (still duplicate) — T19
20. `read_lines map.js L148-160` — T20
21. `edit_file map.js L152-155` (resolved) — T21

**Pass 1 — Rule 1 (Subsumption):**

- T1 ⊂ T2 (same file, no intervening write) → `Drop T1, subsumed_by:T2`.
- T13, T14, T15, T16 all overlap. T16 is the widest. Coalesce by canonical superset: `Drop T13, T14, T15, subsumed_by:T16` (after Rule 2 has cleared the post-edit case).

**Pass 2 — Rule 2 (Invalidation):**

- T3 edits `style.css` 153–289. T2 read 150–290. Overlap. → `Drop T2, invalidated_by:T3`.
- T17 edits `map.js` 141–148. T16 read 145–155. Overlap. → `Drop T16, invalidated_by:T17`.
- After T17 invalidates T16, what about T13–T15? They were subsumed by T16, but T16 is now gone. Rule pipeline re-evaluates: T13–T15 also overlap T17's edit range. → `Drop T13, T14, T15, invalidated_by:T17`.

**Pass 3 — Rule 3 (Consumption):**

- T9 was a read that authorized T10 (edit). T10 succeeded. T11 is the next reasoning turn. → `Drop T9, consumed_by:T10`.
- T18 was a read that authorized T19. T19 succeeded? No — T19 introduced another duplicate. The fix didn't work. T18 stays.
- T20 was a read that authorized T21. T21 succeeded. → `Drop T20, consumed_by:T21` (assuming a turn after T21 confirms reasoning).

**Pass 4 — Rule 4 (Resolution):**

- T8 (error) → T9 (read) → T10 (edit) → T11 (commit success). Single problem thread, resolved. → `Replace T8–T11 with marker: "[Compactor: 4 turns fixing FACTIONS.find().getMoveBonus error in units.js — resolved]"`.
- T12 (error) → T13–T21 (the whole map.js / resources.js debugging spiral) → eventual resolution. Single problem thread (the `hex.key` / `getSettlementsByOwner` refactor). Some turns were already evicted by Rules 1–3; the remainder collapse. → `Replace remaining T12–T21 span with marker: "[Compactor: ~10 turns refactoring getSettlementsByOwner to return {hex, ...settlement} — resolved]"`.

**Pass 5 — Summarization:**

After Rules 1–4, the surviving history is roughly: T3, T4, T5, T6, T7, [marker for T8–T11], [marker for T12–T21]. That's perhaps 15–20% of the original token count. If the budget still allows this, summarization doesn't run.

**Diagnostics (abbreviated):**

```
{
  rules_run:           ["subsumption", "invalidation", "consumption", "resolution"],
  decisions_by_rule:   {
    "subsumption":  { Drop: 4 },
    "invalidation": { Drop: 5 },
    "consumption":  { Drop: 2 },
    "resolution":   { Replace: 2 (spans of 4 and ~10 turns) },
  },
  evicted_ids:         [T1, T2, T9, T13, T14, T15, T16, T20, ...],
  replaced_ids:        [T8..T11, T12..T21],
  summarized_spans:    [],
  tokens_in:           ~14000,
  tokens_out:          ~2100,
  compression_ratio:   0.15,
  warnings:            [],
}
```

The 0.15 compression ratio is illustrative, not a guarantee. Real-world ratios depend heavily on how tool-heavy the session is and how well the profile's metadata captures file operations. A pure-prose session would have a ratio close to 1.0 (no rules apply); a tool-heavy debugging session can drop below 0.2.

If an implementation disagrees with any step of this trace, that is the bug.

---

## Cost Model

Projected, not measured. Phase 1 must replace these numbers.

| Approach | Tokens kept | Compression latency | Extra inference calls |
|---|---|---|---|
| No compression | 100% | 0 | 0 |
| Eviction rules only (1–3) | 30–60% (tool-heavy) / 95%+ (prose) | <10ms | 0 |
| Eviction + Resolution (1–4) | 20–40% (tool-heavy) / 95%+ (prose) | <10ms | 0 |
| Full pipeline including Rule 5 | budget-bounded | 100ms–2s if Rule 5 fires | 0–1 |

Caveats: tool-heavy ratios assume the profile registers `file_ops` metadata correctly. Without it, Rules 1 and 2 are no-ops and the savings vanish.

---

## Phased Delivery

**Phase 1 — Core eviction (3–4 weeks):**

- Core contracts (Turn, CompressionRule, CompressionRequest, CompressionResult).
- Rules 1 (Subsumption) and 2 (Invalidation), file-ops only.
- `preserve_recent` invariant.
- Full diagnostics.
- Coder profile registration as the first consumer.

*Explicitly excluded from Phase 1:* Consumption, Resolution, Summarization. These are the cheap wins; ship them first.

**Phase 2 — Event-driven rules (2–3 weeks):**

- Rule 3 (Consumption) requires `tool_result_for` plumbing in the turn metadata producers.
- Rule 4 (Resolution) requires explicit success markers (commit success, build pass).
- Profile-specific resolution heuristics (the templated marker generators).

**Phase 3 — Summarization (gated on measurement):**

- Rule 5 with a configured utility model.
- Profile-supplied summarizer prompts.
- Summarizer fallback behavior.

Phase 3 is gated on Phase 1+2 producing measurable cases where eviction alone is insufficient. If eviction handles the worst sessions, Phase 3 may never need to ship.

**Phase 4 — Advanced rules:**

- Multi-user / RP profile rule sets.
- Cross-session compression hooks for memory extraction (the boundary where compression hands off to memory).
- Per-profile rule customization API.

---

## Open Questions

| Question | Why open | Resolution path |
|---|---|---|
| Default `preserve_recent` value | Trade-off between safety and savings | Start at 4; tune from coder-profile measurements |
| Whether to keep evicted turns in the turn store for replay | Storage cost vs. audit value | Keep by default with TTL; allow profile to opt out |
| Resolution-rule heuristic for "same problem" | Hard to define generically | Ship simple file+keyword heuristic; allow profile override |
| Whether Rule 5 should target oldest or lowest-information span | Simpler vs. smarter | Start oldest; revisit with measured data |
| How to handle turns the model explicitly cited in a later turn | Citation detection is hard | Rely on caller to set `metadata.do_not_consume` |
| Cross-turn embedding-based deduplication for Rule 1 on prose | Could broaden rule applicability beyond `file_ops` | Phase 4; treat as research |

---

## What This Design Commits To

- **Eviction before summarization.** Five rules in priority order; Rule 5 is the fallback.
- **Profile-driven rule sets.** No "one-size-fits-all" policy. Each surface registers what makes sense.
- **Stable turn identity.** Evicted turns remain referable for audit.
- **Hard `preserve_recent` invariant.** The most recent N turns are never evicted.
- **No silent loss.** Every decision is traced through diagnostics.
- **Library, not service.** Embedded in the same process as the rest of the intelligence subsystem; no cross-process state.
- **Conservative defaults.** When in doubt, keep the turn. False-positive evictions are worse than false-negative.
- **Editor audit trails are out of scope.** Tool hosts that need read-before-write tracking maintain their own ledger; the compression layer does not coordinate with them.

These are the load-bearing decisions. Push back on any of them before building.
