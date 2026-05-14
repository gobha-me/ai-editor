# Dogfood trace — qwen-3-6-plus on HTML-Games issue #213

**Date:** 2026-05-14
**Substrate:** [HTML-Games](https://git.gobha.me/xcaliber/HTML-Games) · issue #213
**Model:** qwen-3-6-plus (code-aware tier per the [ROADMAP §"Test design under operational constraints"](../ROADMAP.md) cost matrix)
**Editor version under test:** ai-editor 2.47.0.1 (`dac6369`)
**Outcome:** **Fix landed correctly.** [PR #217](https://git.gobha.me/xcaliber/HTML-Games/pulls/217) merged as commit `6663afb`; the actual code change matches the ticket's fix sketch exactly. Session: ~24 min, 20 requests, $0.19.
**Archetype:** *Bug fix in deeper code* (per [`README.md`](README.md) §"Test-issue archetypes").

---

## Why this trace exists

This is a clean code-aware-tier dogfood run with a successful merge outcome — both the *logic* infrastructure (retrieval, edit, commit, PR seam) and the *LLM* worked. The signal worth capturing is **not** the win itself; it's the four ergonomic friction points the model hit on the way through. They're each small enough to lose in a single session but consistent enough across sessions to merit `[strong] [S]` work the next time the tool-surface band has capacity.

The friction points are the load-bearing artifact of this trace. Positives are recorded for symmetry — the bits that *didn't* break let us isolate the bits that did.

---

## ai-editor friction points

### 1. Tool-schema mismatch on `read_lines`

LLM called `read_lines` with `start` / `end` (the natural parameter names), but the tool requires `start_line` / `end_line`. One wasted round trip. The error message named the missing params clearly, so recovery was fast — but the parameter names are needlessly verbose given the tool is already called `read_lines`.

**Severity:** low. One wasted request per session.
**Logic-vs-LLM split:** logic side (schema is intentionally explicit). Either rename to `start` / `end` on the tool side, or accept both and alias.

### 2. Tool discovery overhead

LLM called `git_status` (which doesn't exist), then had to call `list_tool_categories` → `list_tools_by_category` twice (once for the commit operation, once for the PR operation). That's **~4 discovery calls for two operations** a git-aware editor should expose obviously.

Compare to Claude Code, where `Bash git status` just works because shell-out is the default. Here the LLM has to discover which named tool wraps the desired git verb.

**Severity:** medium. Four discovery calls × n sessions adds up.
**Logic-vs-LLM split:** logic side (tool surface). Either expose `git_status` / `git_diff` as first-class named tools, or expose a generic `git` wrapper.

### 3. `commit_files` auto-generated a terrible commit message

LLM called `commit_files` with `{}` — no message supplied. The tool didn't refuse and didn't prompt; it auto-generated **"chore: update game.js"**. No issue reference, no description of the fix.

The PR body was good because the LLM wrote that explicitly via `create_pull_request`. But `git log` for this commit is useless — a future bisect or `git blame` lands on a no-info message.

**Severity:** medium. Permanent artifact, not just a wasted turn. Affects code history readability.
**Logic-vs-LLM split:** logic side (tool contract). Either require a message and refuse on empty input, or read the staged diff + branch name + linked issue to auto-generate a useful default (which here would have produced something like "fix #213: …").

### 4. `search_in_files` regex behavior unclear

- `"saveUndoState"` returned 5 matches.
- `"saveUndoState\(\)"` (regex-escaped parens) returned **0**.

Two possibilities, neither documented:
- The tool doesn't support regex. Then the backslashes are literal characters in the query, no `()` exists in any file with a backslash in front, and the 0-result is correct.
- The tool does support regex but the escaping is broken / the regex flavor is non-standard.

The LLM picked the second-best query on the first miss, but didn't know whether its regex assumption was wrong or the search itself had no matches. The tool description should say which.

**Severity:** low. One ambiguous moment per regex-shaped query.
**Logic-vs-LLM split:** logic side (tool description). Add one sentence: "Plain substring match; regex not supported." (or whatever the actual semantics are).

---

## ai-editor positives (what worked)

- **`submit_plan_for_approval` flow worked cleanly.** Single approval gate, LLM stayed inside it. No mid-execution re-planning or scope creep.
- **`edit_file` with line-range replacement returned a post-edit context window automatically.** Saved a follow-up `read_lines` round trip — the kind of seam that's invisible when it works but obvious as a missed iteration when absent.
- **`create_pull_request` with explicit title + body produced a clean PR on first try.** Head branch auto-named from the issue. No back-and-forth on naming or formatting.

These are the seams the 1.6.11 / 1.8.x dogfood arc fixed (5/5 edit success echo, branch-naming flow, approval-gate stability). They're load-bearing for the model's ability to ship without re-planning.

---

## Grading across the five axes

### 1. Retrieval quality
**Pass.** `find_relevant_files` landed the right files (game.js + adjacent state files for the undo-save bug). No `indexer_not_ready` envelope this session — index was warm from prior dogfood activity on the same repo.

### 2. Tool-call quality
**Pass with four documented frictions** (above). No stale-line errors fired (the `edit_file` 5/5 success echo carried). No cross-request cache-refused turns. The frictions are surface-level (parameter naming, missing wrappers, commit-message defaults, regex docs) — they cost iterations but didn't cause incorrect output.

### 3. Compression behavior
**N/A.** ~24 minutes / 20 requests / $0.19 doesn't approach the rebuild threshold.

### 4. Planning quality
**Pass.** Single `submit_plan_for_approval` gate; the plan matched the ticket's fix sketch exactly. No hack-style "let me just try this and see" iterations.

### 5. Cost-quality tradeoff
**$0.19 / 20 requests / 24 min on a code-aware-tier model that produced a merged PR matching the spec.** Right side of the knee — this is the kind of per-session cost the dogfood battery wants to live at for an archetype that ships code. Cheaper-tier comparison would test whether a cheap-tier model can also land #213 (sibling task design); if yes, the code-aware tier is over-spend; if no, qwen-3-6-plus is the right floor.

---

## Recommendations (concrete tool-surface work)

These are the action items the friction points imply, sized as next-time-tool-surface-band-has-capacity work:

1. **Rename `start_line`/`end_line` → `start`/`end` on `read_lines`, OR accept both** as aliases. `[strong] [S]`. Logic side: parameter rename; one-line backward-compat.
2. **Add `git_status` / `git_diff` as first-class named tools** so LLMs don't fall back to category discovery. `[strong] [S]`. Logic side: thin wrappers over existing git-tool surface.
3. **Make `commit_files` require a message, or auto-generate from staged diff + branch name** (here would have produced "fix #213: …"). `[strong] [S]`. Logic side: tool contract change + auto-gen heuristic.
4. **Document regex support on `search_in_files` in the tool description.** `[strong] [XS]`. Logic side: docstring + one tool-description sentence; refer to the embedded regex parser if any.

These items are unrelated to the 2.47.0.2 retrieval-docstring sub-patch this commit is part of; they're recorded here for the next tool-surface arc to pick up.

---

## Logic-vs-LLM splits, recap

| Axis | Logic | LLM | Action |
|---|---|---|---|
| Retrieval | Pass — index warm, right files | Pass — used returned set as-is | None |
| Tool-call | Pass with 4 friction items (documented) | Pass — model recovered cleanly from each | File the 4 recommendations |
| Compression | N/A — short session | N/A | None |
| Planning | Pass — single approval gate, plan = ticket | Pass — no hacking | None |
| Cost-quality | $0.19 / 24 min on code-aware tier for a merged PR | N/A | Sibling-task probe at cheap tier to test for over-spend |

---

## Sibling-task proposal

To test whether qwen-3-6-plus (code-aware tier) is over-spend for this archetype, the matching sibling probe would be:
- Same archetype (bug fix in deeper code).
- Different game in HTML-Games, different bug shape but similar depth (3-5 file reads + 1-3 edits + commit + PR).
- Cheap-tier model (deepseek-v4-flash or mistral-small-4 per the budget matrix).

If the cheap-tier sibling also ships a merged PR, qwen-3-6-plus was over-spend for this row. If it fails or produces a flawed PR, the code-aware tier is the right floor for this archetype.

Held for next dogfood slot.
