# PR Review polish — follow-ups parked behind usage signal

> **Status:** Pre-architecture. Not a commitment. See [`discussion/README.md`](README.md).
> **Context:** PR Review surface shipped slices 1–5 across 2.12.0–2.14.0; full per-PR rationale lives in [CHANGELOG.md](../../CHANGELOG.md). The five-slice arc closed the Touch 3 PR Review deliverable; what follows below is the "v1 was a deliberate cut; here's what got deferred and when to revisit."
> **Trigger to promote any of these into a ROADMAP slice:** real usage signal post-2.14.0, not speculation.

---

## What v1 (2.14.0) chose to ship

Single-shot LLM patch proposal: failed CI logs → JSON response → inline approve/reject card. One-file change per proposal. System prompt explicitly constrains to one file change. Mirrors the Merge Conflict slice-3 lifecycle.

## Follow-ups deliberately deferred

### Agentic Diagnose mode

Let the LLM use `read_lines` / `scan_file` to investigate before proposing the patch, instead of single-shot patching from the failed-CI log alone.

**When to promote:** dogfood signal that single-shot output is consistently wrong on the target-file pick, OR consistently right on the file pick but wrong on the fix. Escalation cost is a constrained read-only tool set + a longer tool loop; not free.

**Risk if shipped speculatively:** the agentic version is unilaterally more expensive than v1. Without measurement, the gain isn't visible.

### Multi-file patches

Natural follow-up alongside agentic mode — once the model is reading multiple files to investigate, it can propose changes across multiple files.

**When to promote:** ships in the same slot as agentic Diagnose, or in the immediately-following slot. Not before agentic mode lands; multi-file single-shot patches are even harder to get right than single-file single-shot patches.

### Dock-vs-chat card extraction

Extract `buildEditProposalCard`'s diff-render core (`js/chat/messages.js:538`) into a shared `renderEditProposalDiff` helper used by both the chat surface and the PR Review dock.

**When to promote:** a third consumer surfaces. Today's two consumers (chat-card + preact dock-local component) duplicate ~40 LOC of preact wrapper; not worth a chat refactor.

**Anti-pattern guard:** this is exactly the "speculative abstraction" the methodology warns against — the right time is when the third caller arrives, not before.

### "Diagnose without CI failure"

Entry-point for PRs with red review feedback but no CI run. Speculative; no observed demand. Listed here so it doesn't keep surfacing as a "missing feature" question.

**When to promote:** a real PR review pattern where reviewers consistently ask the author for a fix the agent could draft, AND CI doesn't fail. Unclear if this pattern exists.

### GitLab `rerunCi`

Separate from Diagnose; add the capability when GitLab adds the upstream API. Status: blocked-upstream.

---

## What this doc is NOT

- Not a design for any of the above.
- Not a roadmap commitment. ROADMAP §"Deferred / parked" carries the PR Review polish pointer.

## Cross-references

- [CHANGELOG.md](../../CHANGELOG.md) §2.12.0–§2.14.0 — full slices-1-through-5 detail.
- [`docs/design/touch-3-left-pane-and-window/`](../design/touch-3-left-pane-and-window/) — original Touch 3 design including the PR Review canvas.
