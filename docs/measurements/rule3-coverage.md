# Rule 3/4 coverage — production-session corpus

Running log for the Rule 3 (Consumption) deferral unblock per [`docs/ROADMAP.md`](../ROADMAP.md) §"Deferred / parked" → Compression.

## Gate

> **≥ 95 % `tool_result_for` coverage on production sessions across ≥ 10 coder.v1 sessions.**

Coverage is computed by [`probeRule3Coverage`](../../js/chat/rule3-coverage-probe.js) (shipped at 2.85.0) over `State.chatHistory` — three buckets per `role: 'tool'` turn:

- **a** — `tool_result_for` populated AND resolves to a prior assistant `tool_calls[].id` *(counts toward both numerator and denominator)*
- **b** — `tool_result_for` present but unresolvable *(denominator only)*
- **c** — field absent entirely *(excluded; pre-contract turns)*

Gate fraction = `a / (a + b)` per the 2.85.0 cross-revision-tolerance design (paths absent from the frozen `CURRENT_DISPATCH_PATHS` set are also excluded from the roll-up). Single-session result is not the gate; the gate fires only after **10 sessions** all measure ≥ 95 %.

## Session corpus

| # | Date | Editor version | Profile (assumed) | Turns | Tool turns | a / b / c | Gate % | Verdict |
|---:|---|---|---|---:|---:|---:|---:|:---:|
| 1 | 2026-05-21 | 2.86.0 (build) | mixed (this session used the editor to develop the editor) | 215 | 114 | 114 / 0 / 0 | **100 %** | ✅ |

**1 of 10 sessions** required for Rule 3 unblock.

---

### Session 1 — 2026-05-21

- **Editor revision:** 2.86.0 (in-progress; gitea#496 fix branch)
- **Context:** First-ever run of the 2.85.0 probe against a real session. The session itself was the planning + implementation of the gitea#496 fix (this same PR), driven through the editor's chat with tool calls. Profile track is best characterized as "coder.v1-like" — the model drove `read_file` / `edit_file` / `grep` / `git` tool calls against the ai-editor repository. **Caveat per memory `project_dogfood_test_battery`**: ai-editor self-targeting was noise-blind for retrieval, so this session may or may not qualify as a clean coder.v1 corpus entry; pending a session targeted at `/config/Projects/HTML-Games` for unambiguous coder.v1 measurement.
- **Detected dispatch paths:** `direct`, `cross-request-cache-hit`, `same-request-cache-hit` — all three present in `CURRENT_DISPATCH_PATHS`; zero historical-path flags.

```json
{
  "summary": {
    "turns_total": 215,
    "tool_result_turns": 114,
    "bucket_a_populated_and_resolves": 114,
    "bucket_b_present_unresolvable": 0,
    "bucket_c_absent": 0
  },
  "gate": {
    "eligible_count": 114,
    "passing_count": 114,
    "pct": 100.0,
    "threshold": 95,
    "passes": true
  },
  "by_path": [
    { "path": "cross-request-cache-hit", "a": 4,   "b": 0, "c": 0, "total": 4,   "gate_pct": 100.0, "historical": false },
    { "path": "direct",                  "a": 109, "b": 0, "c": 0, "total": 109, "gate_pct": 100.0, "historical": false },
    { "path": "same-request-cache-hit",  "a": 1,   "b": 0, "c": 0, "total": 1,   "gate_pct": 100.0, "historical": false }
  ],
  "_historical_paths_flagged": []
}
```

**Reading:** every tool turn carried a resolvable `tool_result_for` — the contract is being authored at every emission site this session touched. No b-bucket (real coverage gap) and no c-bucket (pre-contract drift). Strong first data point; the probe itself is now validated end-to-end against a real session.

**Open question for the next sessions:** the absent dispatch paths from this session — `refused-envelope`, `partial-envelope`, `mcp-bridged`, `sub-agent`, `plan-mode-post-approval`, `tier0-sandbox` — have not been measured yet. The 2.86.0 fix specifically introduces a new firing pattern for `refused-envelope` (same-tool streak trip); a follow-up session that exercises that path would close a coverage gap.

---

## How to add a session

1. Run a real chat session against the editor (preferably driving tool calls against a target other than ai-editor itself for coder.v1 cleanliness).
2. In the chat slideout Logs tab, click **Run Rule 3/4 probe**.
3. Copy the JSON output (use the **Copy JSON** chip).
4. Append a new row to the corpus table above (next `#`, today's date, editor `VERSION` from [`js/version.js`](../../js/version.js), turns total, tool-turn count, bucket counts, gate %, verdict).
5. Append a new `### Session N — YYYY-MM-DD` block with context + the raw JSON.
6. Bump the **"X of 10 sessions"** counter under the table.
7. When the counter reaches 10 and all sessions read ≥ 95 %: the Rule 3 deferral in [`docs/ROADMAP.md`](../ROADMAP.md) is cleared. If any session is < 95 %, the leaking dispatch-path is the next slot's target.

Per memory `feedback_no_bump_for_measurement_only`: appending a session entry to this file does **not** require a version bump on its own. Accumulate in `[Unreleased]`.
