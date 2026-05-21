# Design Changes — 2026-05-21

> **Fold-in status (2026-05-21):** T1 folded into `DESIGN-tools.md` (Core Contracts → new sub-section "Tool-authored failure shape contract", between `ToolDef — the atomic unit` and `ToolRequest / ToolAdmissionResult`). Optional cross-reference sentence added to `DESIGN-agent-loop.md` §"Tool-authored failure shapes". This file is retained as historical evidence and as the record of deferral for W1–W3 (per the pack's own framing).
>
> **Status:** Follow-on to `DESIGN-CHANGES-2026-05-08.md` and its supplement.
> **Pre-condition:** the 18 mechanical items in the original change-pack and the five bookkeeping items (B1–B5) in the supplement are assumed *not yet folded in*. This pack does not depend on them being applied first, but it touches `DESIGN-tools.md` in a section adjacent to B3 (the non-goals correction). When folding, apply this pack's T1 *together with* B3 — they describe the same boundary from opposite sides.
>
> **Source evidence:**
>
> - Architectural review of an article on tree-and-reasoning ("vectorless") RAG (2026-05-21 chat).
> - Architectural review of an after-action report mined from ai-editor / Claude Code session transcripts (2026-05-21 chat).
>
> **Why short:** most of the new evidence validates existing contracts. The architecture already covers structured termination reasons (`DESIGN-agent-loop.md` enumerated `termination_reason`), the cache-stub anti-pattern (cache contract preserves payload on hit), deferred tool catalogs (`DESIGN-tools.md` hidden-by-default), structural metadata in `ChunkRef` (`DESIGN-retrieval.md` `parent_id`/`StructuralMeta`), and budgeted recursive admission as a deferred Phase 3 retrieval strategy. The AAR is largely a record of where the implementation has drifted from the design, not where the design needs to change. One genuine gap surfaced; it is below as **T1**.

---

## T1. `DESIGN-tools.md` — tool-authored failure shape contract

**Section:** Core Contracts → ToolDef (the section currently ending at `superseded_by`'s rationale, line ~158).

**Context for the amendment.** The supplement's B3 establishes that tool-authored failure shapes pass through the loop unchanged inside `success(payload)`. That is correct as a *boundary* statement — it says the loop does not interpret or rewrite them. It does not say anything about what those shapes must *contain*. Field evidence (opaque `edit_file` rejections costing 4 consecutive failures + 2 tool-discovery detours = ~6–8 turns wasted on a 3-line fix; vectorless-RAG verifier emitting structured `failures` arrays specifically so the loop can recover without re-querying the model) makes it clear this is load-bearing: tools that reject input or fail their own preconditions must return failure shapes informative enough to enable recovery without iterative guessing. Otherwise the cost lands on the loop in extra rounds, and the architecture's "no silent envelope shapes" commitment is undermined one layer down.

**Proposed amendment — insert as a new sub-section after `ToolDef — the atomic unit` and before `ToolRequest / ToolAdmissionResult`:**

> ### Tool-authored failure shape contract
>
> A tool that rejects its input or fails its own precondition must return a structured failure shape, not a flat error string. The loop wraps the return in `success(payload)` (per `DESIGN-agent-loop.md` — the tool *ran* and produced a structured outcome) without interpreting it. The shape itself is the tool's own design, but the architecture commits to two contract requirements:
>
> 1. **Named failure reason.** Every failure shape carries a `error` (or `failure_code`) field with a stable, machine-readable identifier — not a free-form sentence. The identifier names the constraint that failed (`stale_lines`, `path_not_found`, `precondition_indexer_not_ready`, `schema_validation_failed`), not the human-readable narration. Stability matters because the loop's per-tool `next_action_hint` registry (`DESIGN-agent-loop.md` §"Envelope Shapes") keys on this identifier.
> 2. **Recovery-sufficient payload.** The shape carries enough additional fields to enable the model (or the loop) to construct a recovery path without re-querying the tool just to learn what went wrong. For schema/validation failures, this means echoing the parsed argument shape the tool actually saw alongside the constraint that failed. For staleness failures, the current value of the staleness predicate (e.g., the actual file content at the rejected line range). For readiness failures, the readiness state (`coverage: 0.06`, `expected_ready_at: ...`). The minimum bar is: a reader of the failure shape can identify the recovery action without a second tool call.
>
> The architecture is deliberately not prescriptive about *which* fields a given tool surfaces — that is the tool's own design. It is prescriptive about the two contract requirements above. A tool that returns `{error: "validation failed"}` with no further structure fails this contract regardless of how technically correct the rejection was. The cost of opaque rejection lands on the loop as extra rounds; the contract pushes that cost back to the tool, where it can be paid once at tool-author time instead of every invocation at runtime.
>
> Tools that *did not run* (the loop intercepted before invocation — cache hit, refused, partial) do not produce these shapes; the loop's envelope shapes (`cached`, `refused`, `partial`) cover those cases. This contract applies only to envelopes the loop emits as `success(payload)` where the payload happens to be a tool-authored failure.

**Why this is the right place.** This sits next to `ToolDef` because it is part of the tool author's contract — what a tool commits to producing. It is not a `ToolDef` schema field (the return shape varies per tool); it is a *requirement on the return*, the way `ToolDef.schema` is a requirement on the input. The pairing makes the symmetry visible: tool authors design the input schema *and* the failure shape, both of which the architecture has now committed to.

**Cross-doc note (no amendment text).** When B3 from the supplement is folded into `DESIGN-tools.md` Non-Goals, the existing wording is still correct: envelope authorship is not a Tools concern. T1 does not conflict — it constrains *what tools must produce when they fail*, not *how the loop wraps that output*. The two amendments are complementary.

**Cross-doc note for `DESIGN-agent-loop.md`.** The doc's §"Envelope Shapes" → §"Tool-authored failure shapes (not envelopes per se)" already acknowledges these shapes exist. After T1 lands, that paragraph may add one sentence: *"Tool-authored failure shapes are subject to the contract in `DESIGN-tools.md` §'Tool-authored failure shape contract.'"* This is informational; no behavior change.

---

## Watchlist (items deferred, with rationale)

Per the project methodology, content is held from inclusion until it meets the required maturity level. These three came up in the same review pass as T1 and were rejected for the change-pack. Recording them here so they are not lost and so the bar for promotion is explicit.

### W1. Verifier-as-emission-gate for the loop's terminal response

**What it would be:** an extension to `DESIGN-agent-loop.md`'s loop iteration contract — between step 8 ("If the LLM response had no tool calls, terminate with reason `complete`") and emission to the user — committing the loop to support an *optional* deterministic verification step. Verification failure produces a structured envelope (the output-side analog of `refused`) and the loop either retries with a corrective prompt or terminates with `verification_failed`.

**Why deferred:** evidence is one-sided. The article's worked example shows it (substring-check citations, ungrounded-number detection); the AAR does not, and field implementations (ai-editor, Claude Code) do not do this. Domain-specific verifiers (RAG-with-citations, code-must-compile) are real, but it is not yet clear whether the architecture should commit to a general slot for them or whether they are a profile-level prompt-assembly concern that doesn't need an architectural surface.

**Promotion criterion:** a second independent piece of evidence that the lack of an architectural slot causes the same class of bug the agent-loop doc was written to prevent (unowned seams). If only one body of evidence supports it, the design risk is over-fitting to one domain (RAG).

### W2. Plan-mode artifacts as references rather than inlined content

**What it would be:** a commitment in either `DESIGN-agent-loop.md` or `DESIGN-profiles.md` that plan-mode artifacts (and similar pre-execution deliverables) admit handles to artifacts, not copies. Concretely: a plan that creates `DESIGN.md` carries a reference to the future artifact, not the full body of the document inline in the plan.

**Why deferred:** on reflection, this is a profile / prompt-assembly concern, not architectural. The four subsystems already commit to atomic-unit-with-references semantics (`MemoryRecord.provenance.chunk_id`, `ChunkRef` for citations); a profile that constructs plans correctly will already produce references. The AAR's #424 (plan-mode payload duplication) is a profile-design failure, not a missing architectural commitment. The architecture supports the pattern; the implementation didn't use it.

**Promotion criterion:** evidence that the failure recurs across multiple profiles built by different teams, indicating the architecture is letting the wrong default through. Single-profile evidence is implementation-level.

### W3. Cross-subsystem signaling via the loop

**What it would be:** a forcing-functions table entry or worked example in `DESIGN-agent-loop.md` showing the canonical pattern for "subsystem A observes a condition that should trigger subsystem B's behavior" — e.g., Retrieval observes an N-th re-read; Memory should be prompted to admit a summary. The architecture's commitment to subsystem decoupling (no direct A→B edges) means the loop must arbitrate. The AAR's "force scratchpad on N-th re-read" proposal is one concrete instance.

**Why deferred:** this is an example/forcing-function, not a commitment. The existing architecture already implies it (subsystems publish diagnostics; the loop reads diagnostics; the loop arranges Memory admission on the next round). Worth recording as an explicit pattern only when a second concrete instance surfaces — currently there is one (Retrieval→Memory via re-read frequency). The principle is correct; it just doesn't earn a section yet.

**Promotion criterion:** a second independent cross-subsystem signaling case that the agent-loop doc does not obviously cover.

---

## What this change-pack does *not* change

- **The four-subsystem commitment.** No new subsystem; no atomic-unit changes; no boundary movements.
- **The Authorship Rule.** Unchanged. T1 sits cleanly on the Tools side of the rule (set by the tool, based on the tool's own state).
- **The supplement's B1–B5.** Still pending fold-in, unchanged by this pack. Recommended order: fold supplement first (it establishes the agent-loop / Tools boundary that T1 reads from), then fold T1.
- **Implementation pacing.** Per project rule: docs land first; implementation aligns on next iteration. T1 is a contract amendment, not a feature ask. No code change is *required* by this pack landing — but implementations of the architecture that ship opaque tool errors are now out of conformance with a documented contract, which is the lever for fixing them.

---

## Handoff notes for the Code session applying this pack

1. **Fold order:** supplement B1–B5 (already drafted) before this pack's T1, since T1 references the agent-loop boundary the supplement establishes. If both are folded in one pass, apply T1 *after* B3 in the same edit to `DESIGN-tools.md`.
2. **T1's home:** insert as a new sub-section in `DESIGN-tools.md` Core Contracts, between `ToolDef — the atomic unit` and `ToolRequest / ToolAdmissionResult`. The exact heading is given above.
3. **`DESIGN-agent-loop.md` cross-reference:** the optional one-sentence update to the "Tool-authored failure shapes" paragraph (noted under T1's cross-doc note) is *not* required for the pack to be complete; it is a nicety. Skip if it would force a re-edit of an already-edited section.
4. **`DESIGN-CHANGES-*.md` files:** archived once their content is folded in. Per the supplement's own framing ("the doc is the contract"), the change-packs are transient; the canonical docs are the artifact.
5. **The watchlist (W1–W3) does not get folded into any canonical doc.** It stays in this change-pack as the record of deferral. If/when a watchlist item is promoted, a future change-pack carries the actual amendment.

---

## What this commits to (rolled up after fold-in)

After this pack lands on top of the 2026-05-08 work, the canonical doc set adds:

- **Tool-authored failure shape contract.** Tools that reject input or fail preconditions return structured failure shapes with a named failure reason and a recovery-sufficient payload. Opaque rejections are out of conformance.

That is the entire surface this pack adds. Everything else in the new evidence either validates an existing commitment or did not pass the maturity gate. The methodology requires that bar; it is being applied here, including to my own proposals from the last two turns.
