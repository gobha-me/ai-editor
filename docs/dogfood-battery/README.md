# Dogfood battery — framing and operational constraints

> **What this is.** The design of the post-1.6.x dogfood + measurement battery. Per-session traces live alongside this README in `docs/dogfood-battery/YYYY-MM-DD-<task-slug>.md`. **The traces are the artifact**; this README is the *how-we-run-it* framing.
> **Why it's here instead of ROADMAP:** ROADMAP carries the forward cadence; this is operational design for measurement work that runs alongside the cadence. Relocated 2026-05-12 during the methodology adoption (see [`../VERSIONING.md`](../VERSIONING.md), [`../discussion/README.md`](../discussion/README.md)).

---

## Original framing (historical)

The four-issue ai-editor self-test battery (github#20, #15, #23, #21) shipped through 1.6.0–1.6.11. github#21's substance landed in 1.6.11 (untagged on main); the *trace* portion exposed three concrete tool-ergonomics pathologies fixed in PRs [#289](https://github.com/gobha-me/ai-editor/pull/289) / [#293](https://github.com/gobha-me/ai-editor/pull/293): retrieval cold-start silence (`indexer_not_ready` envelope), stateful-read cache collisions (`STATEFUL_READ_TOOLS` bypass), and `edit_file` STALE LINE NUMBERS without surrounding context (`_getStaleWindow` + 5/5 success echo).

## Why we pivoted (2026-05-06)

The 1.6.11 post-mortem made the load-bearing pattern visible: ai-editor's tool loop runs nested inside the same indexing/caching/state system the test was meant to probe, so self-targeting amplifies fragility *into* the test rather than isolating it. Driving the battery against ai-editor itself stopped paying — the noise-to-signal ratio fell below useful, and partial fixes / fix-branches against the editor itself aren't acceptable as test outcomes.

**The north star is still the self-licking ice cream cone.** ai-editor *should* be the editor we use to maintain ai-editor — that's the whole point. HTML-Games is the bridge: a clean external substrate where we can isolate logic faults from runtime fragility, fix them with confidence, and *then* reattempt self-targeting once the fragility budget is paid down. It's also more fun, which matters for sustaining the work.

## New substrate: [HTML-Games](https://git.gobha.me/xcaliber/HTML-Games)

Private xcaliber repo, six standalone games (5 vanilla JS, 1 Cogfall on TS/Vite/Pixi). Modular, well-documented, varied complexity (Snake ~2.2K LOC → Cogfall ~10K LOC). External codebase whose state never feeds back into ai-editor's caches — clean isolation between target and runtime.

## Test-issue archetypes

| Archetype | Example | What it measures |
|---|---|---|
| Add feature to existing game | "Add pause to Space-Invaders" | Retrieval (find main.js + game.js + renderer.js), multi-file edit, stale-line behavior under sequential edits |
| Create new minimal game | "Build a Pong (paddle/ball/score) in vanilla JS matching repo conventions" | Planning, file creation, convention recall, zero-corpus retrieval behavior |
| Cross-game refactor | "Unify high-score `localStorage` between Snake and Forge-Defense" | Cross-file retrieval breadth, refactor proposal quality, compression preserving multi-file context |
| Bug fix in deeper code | "Fix multiplayer collision in Snake" | Root-cause diagnosis, sequential read pattern, tool-call ordering |

Cogfall is the step-up rung when needed: build-step, type errors, framework-shaped retrieval, an existing vitest suite.

## What we measure (logic, not the LLM)

Re-running the same task across a cheap model (Haiku) and a strong one (Opus) is the crux: faults reproducing on **both** are logic faults; faults only on weaker models are LLM faults. Capture per session:

- **Retrieval quality** — for each `find_relevant_files` call: query, returned set, hand-graded "right files?" yes/no. Track whether the indexer-readiness gate fired.
- **Tool-call quality** — did stale-line errors fire? How many recovery turns? Did `edit_file`'s 5/5 success echo carry enough surrounding context? Did `read_*` cache misbehave?
- **Compression behavior** — `localStorage.setItem('debug.dump.summarizerSnapshots', '1')` before starting. Per rebuild: `RECENT_COUNT`, `startIndex`, `info?.summary` presence, dropped count. Did the 1.6.0 truncation marker appear when warranted? 1.6.2 request-shape validator drop orphans (firing once is fine; repeatedly means upstream regression)? 1.6.4 token-based summarization fire when load warranted and not before?
- **Planning quality** — eyeball: did the model plan the work or hack? Sane edit order?
- **Cost-quality tradeoff** — `prompt_tokens` and `cached_tokens` per turn vs. the observed quality of the four axes above. The grading axis the others gate against. Two failure modes: **under-spend** (token cheap but compression / retrieval dropped what the model needed — output is wrong) and **over-spend** (tokens expensive but quality flat above some level — money for context the model never used). Cost-dashboard export via `buildCostExport()` ([`js/settings/cost-tab.js`](../../js/settings/cost-tab.js)) at session end; per-strategy retrieval cost via [`cost-store.js`](../../js/intelligence/cost/cost-store.js).

## Test design under operational constraints

Two real constraints shape how the battery actually runs.

### 1. Branch lifecycle

ai-editor auto-creates a branch when a session "starts" on an issue, with a guard against multi-start on the same issue. So we **cannot rerun the same task** against a different model the way the original cross-model probe assumed. The replacement is **sibling tasks**: pick an archetype, design 2-3 same-shape tasks against different games/features, assign a different model to each. Faults reproducing across all siblings are logic faults; faults visible on a single sibling are model-specific.

| Archetype | Sibling 1 | Sibling 2 | Sibling 3 |
|---|---|---|---|
| Add feature | "Add pause to Snake" | "Add pause to Space-Invaders" | "Add pause to Forge-Defense" |
| Cross-game refactor | "Unify highscore Snake↔Forge" | "Unify audio Snake↔SpaceInv" | (skip unless 1+2 disagree) |

Variation across game adds noise vs. the lab-clean rerun, but it's also a *better* probe — a logic fault that survives codebase variation is a stronger finding.

### 2. Budget — $11/day

The cross-model probe lives in the **cheap tier**. Opus and Sonnet stay out of the daily lineup; reserve Sonnet 4.6 for one anchor probe per week on the smallest archetype.

| Tier | Models | $/M in | $/M out | Per-session est. | Role |
|---|---|---|---|---|---|
| Cheap (default) | DeepSeek V4 Flash, Mistral Small 4, Grok 4.1 Fast | $0.17–$0.23 | $0.35–$0.75 | ~$0.40 | Default rotation across siblings |
| Code-aware | Qwen 3 Coder 480B Turbo | $0.35 | $1.50 | ~$0.60 | When the cheap tier flubs and we want a code-specialist comparison |
| Mid (escalation) | GLM 5, Kimi K2.6 | $0.85–$1.00 | $3.20–$4.66 | ~$1.20 | When cheap+code-aware both fail and we want to confirm logic-vs-LLM before declaring a fault |
| Strong-anchor (rare) | Sonnet 4.6 | $3.60 | $18.00 | ~$5.00 | One probe per week on the smallest archetype, to confirm the upper bound |
| Skip for daily | Opus 4.x, GPT-5.x Codex, Grok 4.20 | — | — | — | Budget killers; only on explicit need |

**Reading the matrix:** if a logic fault shows up on Cheap-tier-A but not Cheap-tier-B against sibling tasks of equivalent shape, that's noise / model-specific. If it shows up on **both** cheap-tier siblings AND survives the code-aware run, escalate one tier and confirm. If it survives mid-tier too, file as a logic fault with high confidence and hold the strong-anchor probe in reserve for next week's verification.

End-of-session deliverable: per-session markdown trace at `docs/dogfood-battery/YYYY-MM-DD-<short-task-slug>.md`. First trace established the template (see existing files in this directory); subsequent traces follow it.

## Grading

**Pass** = trace is legible cold AND surfaces at least one logic-vs-LLM distinction AND the cost-quality tradeoff lands on the right side of the knee (under-spend with quality loss or over-spend with no quality gain both fail, even if every logic axis is clean). Output PR quality (does the editor produce mergeable code) is secondary — it's a lagging proxy.

## Preserved from the old plan: the release-readiness gate

(See [`../ROADMAP.md`](../ROADMAP.md) §"Cadence and versioning" for the canonical wording.) Before any `vX.Y.0` tag push, drive a 10-turn ai-editor session **in this repo** with one `find_relevant_files`, one edit, one commit. Honor-system smoke test that the editor still functions on its own corpus. Unchanged.

## Out of scope for the new battery

- github#18 (cross-device settings sync via QR/P2P) — unbounded; tests product-design instincts more than logic.
- Automation/runners — first ~3-5 sessions are manual; abstract only when a pattern repeats.

---

## Cross-references

- [`../ROADMAP.md`](../ROADMAP.md) §"Cadence and versioning" — release-readiness gate.
- [`../VERSIONING.md`](../VERSIONING.md) — the X.Y.Z.N convention; relevant because long arcs developed in `.N` won't fire the release-readiness gate until the final `.N`-strip.
- Memory: `project_dogfood_test_battery.md` — current operational notes (HTML-Games pivot context).
