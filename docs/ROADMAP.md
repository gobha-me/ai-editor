# AI Editor — Roadmap

> Last updated: 2026-04-29 · Current released version: **1.2.1** · Authoring branch: `feat/roadmap-1.x`

## TL;DR

The six new design docs in `docs/DESIGN-*.md` describe a complete intelligence layer rebuild — four peer subsystems (retrieval, memory, compression, tools) coordinated by per-surface profiles. The work rests on three load-bearing commitments:

1. **Admissibility, not accumulation** — every byte the model sees has earned its place. The DESIGN docs are the contract; subsystems implement it.
2. **Git-native memory** — memory and conversation state can opt into living in `.aieditor/*` files committed with the repo. The user's notes follow the code across machines and forks, with no backend. **This is a category change, not an incremental improvement** — every other AI-editor's memory either lives in a vendor cloud or dies when you switch machines. (Decision §1.)
3. **Measurement before scale** — the cost dashboard ships in 1.2.x alongside the first eviction subsystem, not at the end of the arc. Each subsequent track lands against measured baselines, not projected savings.

This roadmap sequences the rebuild over the **1.x** line, ships a **2.0** when profiles become the load-bearing abstraction, and interleaves UI work and quick wins along the way. Estimated end-to-end runway: **~6 months** of evening sessions at the historical pace (CHANGELOG suggests 2026-02-12 → 2026-02-23 produced 30+ patch releases — this scope demands less velocity but more depth, so plan calls for biweekly minor releases instead of daily patches).

---

## Cadence and versioning

**Versioning — SemVer with intent.**

| Bump | Triggered by |
|---|---|
| Patch (`1.x.y → 1.x.y+1`) | Bug fixes, doc updates, security, small UI polish, single-rule additions inside an active track |
| Minor (`1.x → 1.(x+1)`) | New subsystem track lands Phase 1 (compression, memory, tools, retrieval), or a self-contained feature spans multiple files |
| Major (`1.x → 2.0`) | The profile contract becomes the load-bearing configuration surface. The current role-based tool filtering decomposes into a profile preset layer; settings schema migrates with a one-shot script |

**Cadence — biweekly minor releases as a target.** Patches as needed, cherry-pickable to `main` once a track lands. Releases tag `vX.Y.Z` and propagate to `:latest` + `:vX.Y.Z` Docker images via the existing `.gitea/workflows/ci.yaml`.

**Branching.** Main is protected. Every change goes through a PR from a topic branch (`feat/...`, `fix/...`, `docs/...`). The Gitea CI runs the security lint + Docker build on every PR; on tag push it deploys to production.

**No "preview" or "beta" channels** in 1.x. The `:dev` Docker tag for PRs and the `:test` tag for `main` already provide preview environments for live testing.

---

## Where we are (v1.0.5)

What's already in production:

- **Editor:** CodeMirror 6 in browser, 19 languages, multi-tab, diff/blame/preview panes, mobile-responsive
- **Git:** 4 providers (Gitea, GitHub, GitLab, in-memory zip), full CRUD, PRs, issues, releases, CI status, branch protection
- **AI:** 52 LLM tools across 16 modules, 5 roles (`full`/`coder`/`pm`/`reviewer`/`plugin-dev`), 4 LLM providers (Venice, OpenRouter, Ollama, generic OpenAI), streaming + tool calls, embedding-based file relevance via `context-manager.js`
- **Plugins:** Manifest registration, lifecycle hooks, modal/button/CSS injection, built-in plugin editor, settings export/import
- **Security:** 1.0.4 hardening pass (DOMPurify bypasses, escape audit), CI security lint
- **Tab isolation:** Multi-tab Storage scoping (1 browser session per tab) — shipped 0.9.40

What's drifted from the design docs:

- `chat/summarizer.js` is **only** Rule 5 (LLM summarization); no Rules 1–4 (eviction).
- `context-manager.js` is single-strategy semantic; no chunker pipeline, no structural/thematic strategies, no Composer.
- All 52 tools are loaded all the time (filtered by role only); no static/sticky/discovery split, no meta-tools.
- "Memory" today is `scratchpad-tools` (in-session key-value, scratchpad cleared per task) — no persistent memory, no scopes, no audit.
- Roles are user-facing presets that filter tools; they are not profiles in the design-doc sense.

---

## What we're building toward

The four DESIGN subsystems, mapped to current modules and the gap each closes:

| Subsystem | Today | Design target | Gap |
|---|---|---|---|
| **Retrieval** | `js/context-manager.js`, `js/embeddings-client.js`, `find_relevant_files` tool | `ChunkRef` contract, ingest pipeline, Composer with semantic + structural + thematic strategies, deterministic chunk identity | Whole rebuild; existing module survives as the legacy single-strategy implementation during migration |
| **Memory** | `js/tools/scratchpad-tools.js` (session-scoped) | Persistent, scoped (`user`/`persona`/`workspace`/`org`), audit log, supersession, hybrid storage with optional `.aieditor/memory/*.md` file layer committed to the repo | New subsystem; scratchpad becomes a degenerate `session` scope inside it |
| **Compression** | `js/chat/summarizer.js` (Rule 5 only) | 5 rules in priority order: Subsumption, Invalidation, Consumption, Resolution, Summarization | Add Rules 1–4 (eviction); fold existing summarizer into Rule 5 of the new pipeline |
| **Tools** | All 52 tools always loaded; filtered by role | Hidden-by-default; static + sticky + discovery; meta-tools (`list_tool_categories`, `list_tools_by_category`, `find_tool`); lazy schema | Reverse the default; add 3 meta-tools; introduce `ToolID` stability |
| **Profiles** | 5 roles (`full`/`coder`/`pm`/`reviewer`/`plugin-dev`) | 5 profiles (`chat.v1`/`chat_multi.v1`/`rp.v1`/`coder.v1`/`kb.v1`) with budget shape, strategy weights, rule sets, tool catalogs, task ledger | Roles become a UI-friendly surface over profiles; profiles do the actual work |

The "Intelligence" umbrella (`docs/DESIGN-intelligence.md`) is the binding architectural commitment, not a runtime component. There is nothing to ship for the umbrella itself — it's the contract every subsystem PR is reviewed against.

---

## Tracks

Five tracks of work. They are sequenced (not parallel), but inside a track minor versions can ship incrementally.

```
[Foundations]──▶[Compression]──▶[Memory]──▶[Tools]──▶[Retrieval]──▶[Profiles]
   1.1.x          1.2.x          1.3.x      1.4.x      1.5.x         2.0.0
```

**Why this order:**

1. **Foundations** unblocks everything. Turn metadata, profile scaffolding, CI test step — none of these change behavior, but compression rules can't fire without `file_ops` and `tool_result_for` on turns.
2. **Compression first** because it's the highest cost-savings-per-line-of-code item. Long sessions today pay full input tokens for the entire history; Rules 1+2 (eviction) cut that without any new UX. Invisible win.
3. **Memory next** because it's the highest *visible* value and unblocks no other subsystem. Users will feel it immediately: workspace-scoped memory committed to `.aieditor/memory/*.md` is a story unique to a Git-native editor.
4. **Tools** cuts every-call cost and starts changing the model's interaction pattern (it has to learn discovery). User-visible via the active-tools chip row.
5. **Retrieval** is the longest, riskiest rebuild. By the time we get here, we have compression handling history and memory handling curated facts — retrieval is now scoped specifically to corpus admission, which makes the rebuild much smaller than it would have been from a clean slate.
6. **Profiles** consolidate everything. By 2.0, we know what each subsystem actually needs from a profile and can settle the contract without speculation.

---

## Versioned plan

Each milestone lists: **what ships**, **why now**, **exit criteria**, **rough size**.

### 1.0.5 — Sync (this PR)

**What ships:** Doc currency (TOOLS, ARCHITECTURE, ROLES_AND_TOOLS, scan-tools-guide, PLAN); ROADMAP.md (this file); DESIGN docs relocated into `docs/`; version bump 1.0.4 → 1.0.5; CHANGELOG entry retroactively documenting the 1.0.5 commits already on `main`.

**Why now:** The released version (1.0.5) is ahead of the version string in code. Docs claim things that aren't true. New design docs need a home. Get the slate clean before adding to it.

**Exit criteria:** PR merges; `js/version.js` matches the production tag; ROADMAP is the canonical source for everything that follows.

**Size:** Single PR, this branch.

---

### 1.1.0 — Foundations [target: ~2 weeks]

**What ships:**

- **Turn metadata enrichment.** Existing chat history entries carry `{role, content, timestamp}`. Add `file_ops` (extracted from `read_*`/`edit_*`/`write_*` tool results), `tool_result_for` (linking tool_result turns back to their tool_call turn), `tool_name`, `tool_args`. **Read-path only** — new turns going forward are enriched; pre-1.1.0 turns persist with the fields absent and compression treats them as `Keep`-by-default. **Touchpoints:** `chat/state.js`, `chat/handlers.js`, `tools/edit-tools.js`, `tools/multifile-tools.js`, `tools/scan-tools.js`, `tools/file-tools.js`.
- **Migration coverage probe.** A read-only consistency check that runs at session load: counts how many history turns are missing each enrichment field and surfaces the result in dev mode (`?debug=metadata` query string flips it on). Tells 1.2.0 what its baseline is *before* rules consult the data, so when compression underperforms its 40% target you know whether the rule is wrong or coverage is incomplete. The probe never mutates history.
- **Unified `TaskLedger` struct (data only).** Lands alongside profile scaffolding — same struct used by tools (1.4.0: `tool_admissions`, `tool_invocations`) and retrieval (1.5.0: chunk `admissions`, `exclusions`). One schema, no migration. Replaces the deferred "tool ledger merges with task ledger" item that previously lived in 1.4.6.
- **Profile scaffolding (data only).** `js/profiles/` directory with the contract typedef and a `coder.v1` profile that mirrors *current* behavior exactly (no behavior change). Lets later tracks have a place to register configuration without retrofitting.
- **CI test step.** Add a `node --test` job to `.gitea/workflows/ci.yaml` running the existing `*.mjs` parallel suites (`test-summarizer.mjs`, `test-retry.mjs`, `test-edit-tracker.mjs`, `test-blame-normalize.mjs`). Failing tests block PR merge alongside the existing security lint. *Note: those .mjs files currently bind to `window.T` and are browser-only — this step ports them to `node:test` first.*
- **Pre-merge version coherence check.** Tiny CI lint that compares the version string in `js/version.js` to the latest `## [X.Y.Z]` heading in `CHANGELOG.md` and fails the build if they disagree. Two release-sync drifts in a row (0.9.42 → 1.0.4 → 1.0.5) is enough; one evening to fix forever.
- **Retire/rewrite `docs/LLM_ERROR_RECOVERY.md`.** Either fold its useful content into a new section in PLUGIN.md / TOOLS.md, or replace with a thin pointer to `js/utils/errors.js`.
- **Plugin SlotManager — design only.** PLAN.md already flags this; implementation deferred to a 1.4.x patch (it's small once we touch settings/UI), but during 1.1 we lock the contract.

**Why now:** Compression Rules 1, 2, 3 require `file_ops` and `tool_result_for` on turns. Without this enrichment, the rules either no-op (graceful but pointless) or false-positive on missing metadata. The migration probe makes the coverage gap *visible* so 1.2.0's diagnostics can distinguish "no rule applied" from "rule skipped because metadata absent" — without that distinction, when compression underperforms you can't tell whether the rules are wrong or the data isn't there yet. The unified TaskLedger lands now so 1.4.0 and 1.5.0 fill in the same struct rather than shipping two ledger schemas and a migration. CI test step prevents regressions during the bigger tracks. Profile scaffolding is the architectural commitment to the design docs without behavior risk.

**Risk note:** Turn-metadata enrichment is the highest-risk PR in 1.1.0 even though it's *labeled* foundational. The failure mode if backwards-compat slips is silent corruption that doesn't surface until 1.2.0 ships and rules consult partially-enriched turns. The probe is the safeguard. Treat the enrichment + probe as one shippable unit, not two.

**Exit criteria:**
- All new chat-history turns carry `file_ops` when applicable; `chat/messages.js` rendering still works on enriched and non-enriched turns mixed in the same history.
- Migration probe surfaces a coverage report in dev mode; `?debug=metadata` makes it visible.
- Unified `TaskLedger` typedef + empty-state struct present in `js/profiles/`; no consumer wires up yet.
- `node --test` runs in CI, all existing `.mjs` suites pass after porting.
- Version coherence check runs in CI and fails when `js/version.js` and `CHANGELOG.md` disagree.
- `docs/PLAN.md` updates reflect what shipped.

**Size:** ~3-5 PRs over 2 weeks. The Turn enrichment is the biggest piece.

**UI impact:** None visible to end users. Dev mode only: coverage probe report at `?debug=metadata`.

---

### 1.1.1 — Idle timeout (since-last-token) [+3 days]

**What ships:** Replace wall-clock LLM timeout with an idle timeout that resets on every SSE chunk. Today `llmTimeout` aborts at fixed wall-clock from fetch start; reasoning models that think for 60s before emitting their first token get falsely aborted. New behavior: AbortController timer resets on each streamed chunk; if no token arrives within the configured window (default 90s), abort. Settings key renamed `llmTimeout` → `llmIdleTimeout` with one-shot migration.

**Why now:** Foundational for everything that comes later — agentic loops, reasoning models, the test-driven loop in 1.4.3 all depend on this. It's a small fix today and unblocks otherwise-flaky long-stream behavior.

**Touchpoints:** `js/llm/api.js` streaming loop, `js/core.js` settings migration, `js/settings/llm-tab.js` label change.

**Size:** Single small PR.

**UI impact:** Settings → LLM label changes from "Request timeout" to "Idle timeout (since last token)" with a help tooltip.

---

### 1.1.2 — Embedder hardening [+1-2 weeks]

**What ships:** Pre-retrieval-rebuild fixes for the indexing layer that's hitting real ceilings today.

- **Provider decoupling.** Formalize embedder as a separate provider from the chat LLM. Today `embeddingModel` is a setting; promote to a full provider definition with URL, auth headers, and OpenAI-compat by default. Self-hosted clusters (the user's planned deployment) point here.
- **Filetype priority and filters.** Gitignore-syntax exclusions plus per-extension weights (e.g., `*.test.js` 0.3, `*.md` 1.5, `dist/` skip). Stops the index from being dominated by tests, lockfiles, and generated content.
- **500-file ceiling.** Measure current usage on real projects; either raise to 5000 with chunked indexing or remove entirely with paging. Decision-by-measurement, not flat-bump.
- **In-browser embedder validation.** The code path exists but is untested. Fix what's broken, document hardware requirements (WebGPU vs WASM fallback), add a manual test in `tests/`. Will need real-hardware validation from Jeff post-merge.
- **Settings → Embeddings tab.** New tab consolidating provider, model, filters, in-browser toggle, indexing controls.

**Why now:** Project growth is hitting these walls today. Retrieval Phase 1 (1.5.0) eventually rebuilds this layer entirely, but that's months out — these are quality-of-life fixes for the meantime.

**Exit criteria:** Self-hosted embedder works against an OpenAI-compat endpoint; filetype filters cut typical project index size by ≥30%; in-browser embedder produces non-zero results on at least one model.

**Size:** ~3-4 PRs over 1-2 weeks.

**UI impact:** New Settings → Embeddings tab. Index indicator shows "skipped: N (filtered)" alongside "indexed: M".

---

### 1.1.3 — Vim keybindings [+3 days]

**What ships:** Bundle `@replit/codemirror-vim` (the maintained CM6 vim extension; the original `@codemirror/vim` package was retired). Toggle in Settings → Appearance between Default / Vim. Single global mode (not per-tab). Persists across reloads. `:w` / `:wq` ex commands wired to the existing commit modal so save behaves the way users expect.

**Why now:** Self-contained, low-risk, broadens audience meaningfully. Easier to land while the bigger tracks are still scoping.

**Emacs deferred — out of scope for this patch.** The roadmap's earlier mention of `@codemirror/legacy-modes/mode/emacs` was a misread — that package is a CM5 syntax-highlighting shim, not keybindings. The maintained CM6 emacs options are third-party (`@replit/codemirror-emacs`) or hand-rolled; neither was demanded enough at scoping time to commit follow-up work. Pick up only if user demand emerges.

**Exit criteria:** Vim mode passes a smoke test (insert/normal/visual transitions; toggle off restores default keymap). Help modal documents the toggle and the common bindings. Settings round-trip persists the mode across reloads.

**Size:** Single PR.

**UI impact:** Settings → Appearance gets a "Keybinding mode" radio (Default / Vim) below the line-number toggle. F1 help modal Hotkeys tab grows a "Vim mode" group.

---

### 1.1.4 — Supply-chain / glassworm protection [+~1 week]

**What ships:**

- **Invisible-Unicode lint** in `.gitea/workflows/ci.yaml` security stage. Extends the existing DOMPurify-bypass lint to also fail PRs that introduce characters in:
  - **Tags block** `U+E0000–U+E007F` (the glassworm carrier — Unicode tag chars that render invisible but execute as code points).
  - **Zero-width** `U+200B–U+200F`, `U+2060–U+206F`, `U+FEFF` (ZWSP/ZWJ/ZWNJ/BOM).
  - **Bidi overrides** `U+202A–U+202E`, `U+2066–U+2069` (RLO/LRO/LRI/RLI/PDI — "Trojan Source" pattern).
  - Scope: `js/`, `plugins/`, `tests/`, and any user-editable JS in the bundled plugin editor.
- **Editor-side scan** in CodeMirror. New decoration that visibly flags the offending characters with a tooltip ("Invisible Unicode — possible supply-chain payload") and a quick-fix to delete. Off by default for languages where these chars are legitimate (e.g. comment-bidi in localized text), on by default for `.js`/`.json`/plugin manifests.
- **Plugin manager review affordance.** When a user pastes/imports a plugin, the install dialog shows a "source contains N invisible characters" warning band before the user clicks Install. Same scanner powers the editor decoration.
- **Settings export/import hardening.** Existing import already validates JSON shape; add the invisible-Unicode scan to the validator and surface findings in the import preview.
- **`docs/SECURITY.md`** new doc describing the threat model (glassworm, Trojan Source, polyglot exfil), the protections shipped, and what remains the user's responsibility.

**Why now:** AI Editor's value prop is *no backend, no build step, no node_modules* — but the plugin system is the analogous attack surface. Glassworm has been observed shipping through npm packages and IDE extensions in 2025–2026; our plugin ecosystem (small as it is today) inherits the same threat model the moment someone shares a plugin file. CI lint + editor decoration + install-time scan is cheap and turns the threat into a visible artifact instead of a hidden payload.

**Exit criteria:**
- A test fixture file containing a Tags-block character fails CI security-lint.
- The editor renders a visible decoration for the same fixture in `tests/index.html`.
- The plugin install dialog blocks/warns on a poisoned manifest.
- `docs/SECURITY.md` is linked from README and PLUGIN.md.

**Size:** ~2-3 PRs over ~1 week. The CI lint is a one-line `grep -P` extension; the editor decoration is the long pole.

**UI impact:** Editor gutter/inline decoration for invisible chars; plugin install dialog warning band; new Settings → Security tab (or fold into an existing tab).

---

### 1.2.0 — Compression Phase 1 [target: ~3 weeks after 1.1]

**What ships:**

- **`js/intelligence/compression/`** — new module tree. `compactor.js` runs the rule pipeline; `rules/subsumption.js` and `rules/invalidation.js` implement Rules 1 and 2; `turn-store.js` holds the canonical session-scoped turn buffer.
- **`preserve_recent` invariant.** Last N turns (default: 4 for chat, 2 for coder per design) never evicted.
- **Diagnostics in LLM debug modal.** New section: "Compression decisions" listing evicted turn IDs with reasons (subsumed_by, invalidated_by). Helps debug false positives.
- **Existing summarizer** stays in place under `chat/summarizer.js`, called as Rule 5 fallback by the new pipeline. No behavior change for users not yet hitting eviction patterns.
- **Coder profile registers** Rules 1, 2 + existing Rule 5. Other roles (Reviewer, PM) keep current Rule-5-only behavior via the profile shim.

**Why now:** Long coding sessions are the cost pathology described in `DESIGN-compression.md`. Phase 1 rules are deterministic, free at inference time, and require no LLM call. The savings are real and immediate.

**Exit criteria:**
- A 50-turn debugging session shows measurable token reduction (target: ≥40% on tool-heavy sessions per design projection; baseline measured before merging).
- Diagnostics expose every eviction *and* distinguish "no rule applied" from "rule skipped because metadata absent" (uses the 1.1.0 coverage probe data).
- No regressions in Rule 5 summarization (existing tests pass, plus new `.mjs` suite for Rules 1/2).
- **Removability check:** With `js/intelligence/compression/` removed and the system reverted to Rule-5-only, what user-visible behavior degrades? If "nothing measurable on a 50-turn session," the subsystem has not yet earned its complexity and 1.2.1 (cost dashboard) is gated on closing that gap.

**Size:** Single big PR (~1500 lines: compactor + rules + tests + diagnostics) plus 2-3 follow-up PRs for tuning.

**UI impact:**
- **Compression diagnostics panel** added to the LLM Debug modal (Ctrl+Shift+I). Shows the eviction trace per turn.
- *Optional:* status-bar pill showing live compression ratio (e.g., "📉 60% kept"). Defer to 1.2.x patch if time-boxed.

---

### 1.2.x — Compression follow-ups [+2-3 weeks]

Each follow-up gates on the previous one delivering measured value, not on a calendar.

- **1.2.1: Cost dashboard.** Cross-provider, per-conversation token-and-cost breakdown — promoted from 1.5.3 because *measurement infrastructure is the first investment, not the last*. Shipping the dashboard immediately after Rules 1+2 land lets us answer the load-bearing question: did Rule 1+2 actually deliver the ≥40% reduction the design projected? If yes, the rest of the roadmap accelerates. If no, we find out in month 2 instead of month 6 and the remaining tracks get re-scoped against measured data, not projected savings. Today the editor has Venice-specific billing in `plugins/venice-billing.js`; this generalizes it. **What ships:** Settings → Cost tab with per-conversation totals (linkable from the conversation drawer), per-tool token spend, per-session totals + 30-day historical, optional budget alerts. Existing Venice plugin stays as a provider-specific overlay. **Gate for 1.2.2:** dashboard produces at least 1 week of real-usage data before Rule 3 ships.
- **1.2.2: Rule 3 (Consumption).** Gated on the dashboard from 1.2.1 showing concrete Rule 1+2 savings *and* the 1.1.0 `tool_result_for` plumbing exhibiting ≥95% coverage on production sessions for ≥1 week. Without the coverage signal, Rule 3 can't reason about consumed tool calls reliably.
- **1.2.3: Rule 4 (Resolution).** Templated marker generation for "debugging spans that ended successfully." Build/test/commit success markers needed; the Git tools already emit success. Gated on Rule 3 diagnostics confirming the consumption pattern fires the way the design predicted — if the 1.2.2 numbers don't match, we re-scope rather than ship Rule 4 against an untrusted base.
- **1.2.4: Rule 5 tuning.** Plug existing summarizer into the pipeline cleanly. Measure: compression latency, summarizer call rate (should drop now that Rules 1-4 evict first). The dashboard from 1.2.1 is the primary witness.
- **1.2.5: Provider rate-limit respect (cross-cutting backlog).** Read `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` headers from `js/providers/*` responses, pace requests with a token-aware sliding window, back off on 429 with `Retry-After`. Surface remaining RPM/TPM quota in the status-bar pill (UI #4) and the cost dashboard (UI #17). Reference algorithm and validation harness already live in `evals/pacing.js` from the NIAH eval; production code reuses the algorithm. **Why:** large-context calls (1.3.x memory recall, 1.5.x retrieval composer) routinely consume single-digit-percent of TPM per request; without provider-side pacing, bursts trip 429s during normal use. **Cross-cutting:** not gated on compression-rule cadence; ships when any track first hits provider rate-limit pressure.

---

### 1.3.0 — Memory Phase 1 [target: ~3 weeks after 1.2]

**What ships:**

- **Persistent memory store.** New `js/intelligence/memory/` module. Phase 1 = `user` scope only.
- **Hybrid storage:**
  - **Structured store** in IndexedDB via `Storage`, indexed by `key+scope`, with embeddings via the existing embeddings client.
  - **Transparent file layer** at `.aieditor/memory/index.md` + per-category files (`preferences.md`, `decisions.md`, `project-context.md`). When a workspace is loaded, the editor reads from these committed files; when memories are created/updated, the files rewrite and become candidates for the next commit. **The killer integration:** memory lives in the repo. A user opens a project on a new machine, memories follow.
- **3 creation paths:** `user_explicit` (Settings UI), `agent_proposed` (consent prompt in chat), `system_inferred` (low-confidence, TTL-bounded).
- **Audit log** in IDB.
- **3 new LLM tools:** `memory_remember`, `memory_recall`, `memory_revise`.
- **Settings → Memory tab** with list/edit/audit views, agent-proposal toggle.

**Why now:** **Git-native memory is the load-bearing feature here, not an incidental win.** Every other AI editor's memory either lives in a vendor cloud (Cursor, Claude.ai, ChatGPT memory), in a local-only store that dies when you switch machines (most plugin-style tools), or in a config file that isn't really memory (Cline, Aider rules). Repo-committed memory that round-trips through Git is a *category change* — the user's notes follow the code across machines, branches, and forks, with no backend. This is the reason memory ships before tools even though tools cuts more cost: memory unlocks an externally-tellable story that the rest of the roadmap then trades on. Pure capability addition with no breaking changes.

**Story-completion gap:** `user` scope (1.3.0) lets users feel "we have memory." `workspace` scope (1.3.1) is what lets us tell the *Git-native* story externally — workspace-scoped facts committed to the repo, cross-machine via push/pull. The gap between 1.3.0 and 1.3.1 is the gap between "we have memory" and "we have the demo." Target ≤2 weeks between them; bundle if 1.3.0's UI work doesn't blow up.

**Exit criteria:**
- `.aieditor/memory/` files round-trip through commit/checkout without corruption.
- Settings → Memory shows all entries with audit trail.
- A memory created in chat survives a page reload and reappears in the next session's context.
- Agent proposals fire only with explicit consent (no silent writes).
- **Removability check:** With `js/intelligence/memory/` removed and `scratchpad-tools` restored, what user-visible behavior degrades? Memory is the most user-visible subsystem — if removability is "nothing user-noticed" then the UI didn't expose memory enough and 1.3.1 is gated on closing that gap.

**Size:** ~6-8 PRs over 3 weeks. UI is the long pole.

**UI impact (significant):**
- **New Settings tab: Memory** — list view with scope filter, edit form, audit log expansion, "agent proposal frequency" setting. *First Preact + `htm` slow-roll target* (per Decision §9). Existing tabs stay vanilla; the new Memory tab is the proving ground for the framework boundary.
- **Inline `@memory` chip in chat** — typing `@memory` shows a fuzzy-matched picker of existing memories for citation. Also Preact-rendered (the chip + picker share state with the Settings tab).
- **Consent prompts** — when an agent proposes a memory, a small inline card in the chat with Accept/Dismiss/Edit buttons. Match the existing themed dialog system. Preact component.

The Memory UX (these three flows) is the scope of the **Touch 1 design engagement** with claude.ai/design (kicked off pre-1.3.0; see Decision §10).

---

### 1.3.x — Memory follow-ups [+3-4 weeks]

- **1.3.1:** `workspace` scope (memories scoped to `connectionId+owner+repo`). Defaults the chat to query both `user` and `workspace` scopes.
- **1.3.2:** `persona` scope (paves the way for future RP profile, but immediately useful for "use the formal voice for work repos, casual for personal").
- **1.3.3:** Self-healing tools — agents can rewrite memory files within guardrails (`memory:revise` accepts a `reason`; revisions become audit entries).
- **1.3.4: Cross-device session sync via Git.** Conversations stored as `.aieditor/sessions/<id>.json`. Opt-in toggle — same setting as memory's repo mode (browser-cache by default, repo-committed when explicitly enabled). When enabled and the current branch isn't protected, sessions auto-stage with the next commit. Open the same project on a second device, conversations appear in the conversation drawer. Unique-to-us — no backend required; Git is the transport.
- **1.3.5: Session replay / shareable transcripts.** Export the active conversation as a `.aieditor.session` archive (JSON: messages + tool calls + tool results + before/after diffs). Drop the file into another instance to view in read-only replay mode (step through turns, see what the model saw at each step). Use cases: bug reports, blog posts, teaching, post-mortems. Builds on the existing conversation persistence.

---

### 1.4.0 — Tools Phase 1 [target: ~3 weeks after 1.3]

**What ships:**

- **`js/intelligence/tools/`** — new admission layer. The existing `ToolRegistry` becomes the **catalog**; the admission layer sits in front of it.
- **`ToolID` stability.** Hash of `(profile_namespace, canonical_name, version)`. Old tool names continue resolving for audit; renaming a tool produces a new ID.
- **Static set per profile.** `coder.v1` static set: meta-tools + `read_file`, `read_lines`, `scan_file`, `edit_file`, `commit_files`, `list_dirty_files`. Everything else is discovery-only.
- **3 meta-tools:** `list_tool_categories`, `list_tools_by_category`, `find_tool` (categorical only in 1.4.0; semantic deferred to 1.4.1).
- **Lazy schema expansion.** Discovery returns name + 1-line description (~50 tokens); first invocation expands to full schema (~250 tokens).
- **Sticky admission** via the **unified `TaskLedger`** scaffolded in 1.1.0. This track fills in `tool_admissions` and `tool_invocations` records on the existing struct — no separate ledger schema, no future merge step. Once a tool is invoked, it stays admitted for the rest of the task. (Task boundaries = explicit `/task` markers in 1.4.0; auto-detection in 2.0.)
- **Diagnostics:** Tool admission decisions surface alongside compression in the LLM debug modal. Cost dashboard from 1.2.1 grows a "tools per turn" line.

**Why now:** Cuts every-call token cost. With 52 tools at ~200 tokens each, a chat profile loading them all is ~10K tokens of tool definitions per call. Static + discovery cuts that to ~1500 baseline + 200-500 per discovered tool.

**Exit criteria:**
- Token cost of tool definitions per call measured before/after via the 1.2.1 cost dashboard; target: 70%+ reduction on a typical coder session.
- Discovery roundtrip works: model calls `list_tools_by_category("file")`, gets `read_file`/`read_lines`/etc. summaries, calls one, it admits in full on the next turn.
- Authorization filter still respects current role gates (the static set is filtered through role first).
- **Removability check:** With `js/intelligence/tools/` removed and all tools loaded all the time again, what user-visible behavior degrades? "Cost dashboard shows tools-line spike but everything still works" is acceptable; "model can't find tools" is failure mode the active-tools chip row must address before merge.

**Size:** ~5-7 PRs over 3 weeks. Most of it is the admission layer; the meta-tools themselves are small.

**UI impact:**
- **Active tools chip row** above the chat input — shows what's currently admitted, with hover showing full description. Removes the "what tools does the model have?" mystery.
- **Tool catalog browser** (in Settings → Tools tab — already on PLAN.md). View all 52 tools, see role/profile assignment, eventually edit static-set membership.

---

### 1.4.x — Tools follow-ups [+5-7 weeks]

- **1.4.1:** Semantic `find_tool` + lazy expansion (k-NN over tool embeddings, threshold-gated to avoid weak matches; admit short form on discovery, full schema on first call).
- **1.4.2: MCP bridge plugin.** New `Plugins.registerMCPServer({ url, auth, transport })` — translates MCP JSON-RPC tool definitions into our `ToolDef` shape so they enter the catalog and play by the new admission rules. Per-server auth (API key or OAuth where supported). Massive ecosystem play with small implementation: we inherit the entire MCP server ecosystem instead of curating tools ourselves.
- **1.4.3: Test-driven loop.** Agentic mode where the AI iterates on a failing test until CI passes. Loop: read failing test → propose fix → edit → commit → wait CI → read result → loop. Bounded by max iterations, max wall-clock, max tokens-per-iteration. Uses existing `commit_files` + `get_ci_status` + the new idle-timeout from 1.1.1 to handle the wait-for-CI step cleanly. UI: progress card showing iteration N/M with abort button. Builds on the existing tool inventory; no new core capabilities required.
- **1.4.4: Workspace-scoped settings.** `.aieditor/settings.json` overrides global settings per repo (subset of overridable keys — never API keys). UI: Settings panel marks workspace-overridden values with a "reset to global" button. Auto-stages on commit when enabled and branch isn't protected (matches the memory commit pattern from 1.3.0). Pairs naturally with the rest of the `.aieditor/` directory convention.
- **1.4.5: Inline AI suggestions (ghost text, hotkey-only).** Pressing a hotkey (default: `Tab`, configurable) requests a single completion at the cursor — never automatic, no idle polling, no API cost without explicit user action. Renders as CodeMirror 6 decoration; `Tab` accepts, `Esc` dismisses. Throttled (one in-flight at a time). The cost-control "hotkeyed not automatic" framing is intentional — automatic ghost text is a Cursor-style cost trap; hotkey-triggered respects the user's intent.
- **1.4.6:** Lazy expansion threshold tuning; eviction LRU on the static set when memory pressure exceeds budget. (The "tool ledger merges with task ledger" item that previously lived here disappeared because the unified `TaskLedger` shipped in 1.1.0 — 1.4.0 fills in fields on the same struct.)

---

### 1.5.0 — Retrieval Phase 1 [target: ~6-8 weeks after 1.4]

**What ships:**

- **`js/intelligence/retrieval/`** — new module tree.
- **`ChunkRef` contract** with deterministic `ChunkID` (hash of `collection || source_uri || normalized_byte_range || chunker_version`).
- **Ingest pipeline:** Loader → Chunker → (StructureExtractor) → Embedder → Store. Phase 1 chunkers: prose, code (regex heuristic for JS/TS/Python — same languages as `scan_file`), conversation (1 turn = 1 chunk), structured (per record).
- **Two strategies:** Semantic (hybrid k-NN + BM25 + RRF) and Structural (ancestor-walk over `parent_id` metadata).
- **Composer** with budget accounting, per-strategy quotas, attention-aware ordering (`task` → tail, `system_context` → head, `retrieved`/`history` → body), dedup by ChunkID.
- **Migration off `js/context-manager.js`.** The legacy module continues to back the existing `find_relevant_files` tool until 1.5.2; the new pipeline runs in parallel during 1.5.0–1.5.1 with feature-flag fallback.
- **Chunk admission ledger.** This track fills in `admissions` and `exclusions` records on the **unified `TaskLedger`** from 1.1.0 — same struct, third consumer.
- **Diagnostics:** What strategies fired, chunks per strategy, tokens used vs budget, cache hits.

**Why now:** This is the biggest rebuild. Doing it last means we already know exactly what compression and memory need from retrieval. The contract becomes concrete instead of speculative.

**Exit criteria:**
- Existing `find_relevant_files` results (legacy) and new Composer results agree for ≥80% of test queries.
- New ingest pipeline indexes a project at startup with measurable progress and resumability.
- Code review on a single attached file ("review src/foo.ts for code smells") matches or beats current behavior on a benchmark set.
- **Removability check:** With `js/intelligence/retrieval/` removed and `context-manager.js` restored, what user-visible behavior degrades? Cost dashboard's retrieval-strategy breakdown disappears; per-call retrieved tokens jump back to baseline. If neither of those is measurably true on the benchmark, the rebuild didn't earn its complexity.

**Size:** ~10-15 PRs over 6-8 weeks. The longest single track. Several `1.5.0-betaN` tag pushes likely.

**UI impact:**
- **Retrieval diagnostics** in LLM debug modal (parallel to compression and tools sections).
- **Index progress indicator** (already exists as `index-indicator.js`) updated to show the new pipeline's progress and per-strategy hit rates after a turn.
- **Status bar:** "📊 8K retrieved / 22K budget" pill (optional polish).

---

### 1.5.x — Retrieval follow-ups [+3-4 weeks]

- **1.5.1:** Thematic strategy (k-means over filtered vectors). Powers "summarize this codebase" properly.
- **1.5.2:** Legacy `context-manager.js` removed; `find_relevant_files` rewritten to call the new Composer.
- **1.5.3: Cost dashboard — retrieval extension.** The dashboard itself shipped in 1.2.1 (cross-provider, per-conversation, per-tool). This patch adds the retrieval-strategy breakdown that 1.5.0's diagnostics now produce: per-strategy hit rates, per-strategy token spend, "this query was expensive because the structural strategy matched 200 chunks" affordances. No new Settings tab — extends the existing Cost tab.
- **1.5.4:** Query cache, structural expansion cache (per `DESIGN-retrieval.md` §Caching).
- **1.5.5 (optional, gated):** AST-based code chunker (tree-sitter) only if the regex heuristic shows measurable quality gaps on the benchmark.

---

### 2.0.0 — Profiles ascend [target: ~3 weeks after 1.5]

**What ships:**

- **Profile contract goes live.** `Profile { name, version, base, budget, retrieval, memory, compression, tools, task_ledger }` is the configuration surface.
- **5 canonical profiles registered:** `chat.v1` (base), `coder.v1`, `kb.v1`. (`chat_multi.v1` and `rp.v1` shipped as stubs — AI Editor's surface is single-user code-focused, but the profiles exist for plugin authors.)
- **Roles → profile presets.** The existing 5 roles become UI-friendly toggles over the profile's tool catalog. The `role` setting persists for UX continuity, but all subsystems read from the resolved profile.
- **Task ledger** with novelty-based re-admission (per `DESIGN-profiles.md` §The Task Ledger).
- **Settings migration script.** One-shot migration runs on first 2.0 load; old `settings.role` translates to `settings.profile.preset`. Audit-logged.
- **Profile picker UI.** New top-bar selector — sits next to or replaces the role selector depending on what feels right after dogfooding.

**Why now:** All four subsystems are shipping. Profiles consolidate them. By postponing 2.0 until everyone has clarity, we avoid baking speculative profile decisions into the 1.x line.

**Be ready to discover the profile contract is lighter than designed.** `DESIGN-profiles.md` describes profiles as the abstraction across five surfaces (chat, multi-user, RP, coder, KB); ai-editor has one. If by 1.5.x the "profile" reduces to `coder.v1` plus a settings struct plus three knobs, that's a finding to celebrate, not a failure — 2.0 ships a profile contract sized to what the editor actually needs, not the design doc's full surface area. Plugin authors targeting other surfaces still get the contract; we just don't pre-build their use cases.

**Exit criteria:**
- Settings export from 1.5.x imports cleanly into 2.0 with the migration applied.
- A user who never touches the profile picker sees no behavior difference (defaults to `coder.v1` or `chat.v1` based on current role).
- Profile-aware diagnostics: every subsystem's diagnostics surface includes the active profile name + version.
- **Removability check:** With the profile layer collapsed back to roles, what user-visible behavior degrades? If "nothing — the picker is gone but the editor still works the same," profiles were over-architected and the contract should ship lighter.

**Size:** ~6-10 PRs over 3 weeks. The migration is the risk; everything else is plumbing.

**UI impact (significant):**
- **Profile picker** in the chat header. Could be a dropdown with previews showing budget shape, active rule set, tool count. Preact (per Decision §9 — third slow-roll target after Memory and active-tools chip row).
- **Settings → Profiles tab** (replaces or augments Roles tab) — view/edit profile presets, see resolved configuration, fork from canonical.
- **Status-bar profile pill** showing active profile + version. Click to switch.

---

### 3.0 — Uniform UI consolidation [stub; not scoped]

**Placeholder, not committed work.** By 2.0 we've shipped Preact + `htm` on a handful of new surfaces (Memory tab, `@memory` chip + consent, active-tools chip row, profile picker) while everything else stays vanilla. The 2.0 → 3.0 arc is the moment to evaluate whether a uniform UI story is worth the migration cost.

**Candidate scope** (to be sized when 2.0 is closer):
- Migrate select high-state existing surfaces to Preact (Settings sidebar, secondary pane, conversation drawer) where the vanilla rebuild patterns have grown brittle.
- **Plugin Component primitive** — let plugins ship Preact components instead of HTML strings; makes the long-deferred plugin marketplace tractable.
- **Mobile UI consolidation** (UI #16) — the existing fullscreen-overlay model for ≤768px is cramped; rework using shared Preact primitives.
- **Theming + design-system pass** — by 3.0 the pile of inline styles in `html/*.html` will deserve a proper component library.

**Why a stub now:** Decision §9 commits Preact-on-new-surfaces only through 2.0; this stub records the future arc so it isn't forgotten, but doesn't pre-scope work that should be designed against measured data after 2.0 ships. Touch 2 of the design engagement (Decision §10) is the natural input here.

---

## UI improvements (cross-cutting)

These slot into patch releases of whatever track is current. Some are enabled by track work, others stand alone.

| # | Improvement | Why | Track to ship in |
|---|---|---|---|
| 1 | **Idle-timeout label change** in Settings → LLM | Makes the new behavior discoverable | 1.1.1 |
| 2 | **Settings → Embeddings tab** | Provider selector, filetype filters, in-browser toggle, indexing stats | 1.1.2 |
| 3 | **Vim keybinding toggle** in Settings → Appearance | Self-contained power-user feature; Emacs deferred (no CM6 official package) | 1.1.3 |
| 4 | **Compression diagnostics pill** in status bar (live ratio) + full trace in LLM debug modal | Surface admissibility decisions; per Decision §3 | 1.2.0 |
| 5 | **Memory management UI** — Settings tab + inline `@memory` chip in chat | Memory is invisible without it | 1.3.0 |
| 6 | **Cross-device session indicator** — small badge in conversation drawer when a conversation is repo-synced | Visibility for the opt-in repo mode | 1.3.4 |
| 7 | **Session replay viewer** — drag-and-drop a `.aieditor.session` file, get read-only step-through | Bug reports, teaching | 1.3.5 |
| 8 | **Active tools chip row** above chat input | Demystify what tools are loaded | 1.4.0 |
| 9 | **MCP server management UI** in Settings → Plugins (or Settings → MCP) | Add/remove/auth MCP servers; see what tools each contributes | 1.4.2 |
| 10 | **Test-driven loop progress card** in chat | Iteration N/M, current step, wall-clock budget, abort | 1.4.3 |
| 11 | **Workspace-overrides indicator** in Settings (badge on overridden values) | Make the .aieditor/settings.json overrides discoverable | 1.4.4 |
| 12 | **Inline AI suggestion (ghost text)** rendered as CM6 decoration | Hotkey-only — no automatic polling, no idle cost | 1.4.5 |
| 13 | **Settings tab UX** — sidebar instead of horizontal tab strip | The strip already overflows; the Embeddings/Memory/Tools/Profile tabs make it worse | 1.3.x or 1.4.x |
| 14 | **In-app help renderer** — currently Markdown in a modal | A persistent sidebar pane would make `read_docs`-driven content far more useful | 1.1.x |
| 15 | **SlotManager (designed but not built)** | Still on PLAN.md; tackling alongside Settings tab UX rework gives plugins the long-promised injection points | 1.4.x |
| 16 | **Mobile secondary pane** rework — diff/blame on mobile is cramped | The current ≤768px layout treats secondary pane as a fullscreen overlay; could be a slide-over | Cross-cutting; tackle alongside whichever track touches secondary-pane.js |
| 17 | **Cost dashboard** — generic cross-provider, per-conversation, per-tool breakdown | Measurement infrastructure ships *with* the first eviction subsystem so 1.2.0's projected savings get verified immediately. Retrieval-strategy breakdown bolts on in 1.5.3. | 1.2.1 |
| 18 | **Status bar at the bottom** — extends pill from #4 with tools + retrieval | "Compression: 60% kept · Tools: 8 loaded · Retrieval: 8K/22K" | 1.5.x |
| 19 | **Profile picker** in chat header (replaces role selector per Decision §2) | One canonical surface | 2.0.0 |
| 20 | **Issue/PR tab visual hierarchy** — long tabs feel busy | Issue tabs render dense walls of metadata; lo-pri | Cross-cutting; lo-pri |
| 21 | **Plugin marketplace UI** | Defer to post-2.0 once the architecture stabilizes | 2.x |
| 22 | **Invisible-Unicode decoration in editor** + plugin install warning band | Surface the glassworm/Trojan-Source attack class as a visible artifact | 1.1.4 |

**One thing I'd push back on if you ever propose it:** *don't* add a wizard/onboarding for profiles. The current onboarding (`js/onboarding.js`) is appropriately scoped (Git + LLM); profiles should default invisibly to `coder.v1` and surface only when the user notices the picker. Profile selection is not a setup decision; it's a workflow decision.

---

## What's out of scope for the 1.x → 2.0 arc

Explicit deferrals so we don't accidentally take them on:

- **Multi-modal context.** Image/audio chunks. Vision models work for images today (paste-to-chat); structured handling is a 3.x topic.
- **Cross-process / distributed state.** Stays single-process per `DESIGN-retrieval.md` §Consistency Model. No sync server, no multi-tab live coordination beyond the existing tab-isolation model.
- **Real-time collaborative editing.** Two users editing the same file simultaneously. Not a context problem; not in scope.
- **Plugin marketplace.** Old PLAN.md item. Defer to a 2.x track after the profile contract is stable.
- **Markdown-as-source AST chunking.** The Phase 1 code chunker is regex-based per the design; a tree-sitter-grade chunker is gated on measured need.
- **Custom embedding model fine-tuning.** Use the user's chosen provider; no fine-tuning loop.
- **Cross-project task ledger.** Task ledgers stay session-scoped per `DESIGN-profiles.md`. If users want continuity, they put it in memory with consent.

---

## Decisions

Resolved from discussion. These are now load-bearing — implementations of the relevant tracks honor them.

1. **Memory storage is two-tier.** Browser cache is the default (stateless, per-tab). Repo-committed (`.aieditor/memory/*.md`) is opt-in per workspace. The opt-in toggle lives in Settings → Memory. *Implications:* Memory subsystem (1.3.0) ships both backends from day one; the structured store is the universal layer, the file layer is the opt-in projection.
2. **Roles get replaced by the profile picker at 2.0.** No dual-surface; one selector. The settings migration script (2.0.0) translates each user's stored `role` to a profile preset.
3. **Compression diagnostics surface as a public status-bar pill.** Live ratio (e.g., "📉 60% kept") visible to all users, not just debug-mode. Full eviction trace stays in the LLM debug modal for power users.
4. **Memory files auto-stage on commit when repo mode is opt-in AND the current branch isn't protected.** The opt-in is the consent gate; auto-staging is the smooth UX. On protected branches, the memory diff surfaces in the commit modal as an unstageable warning ("create a feature branch to persist memory changes").
5. **Tool budget defaults to 5000 tokens (per design)**, exposed as a tunable in Settings → Tools. Measure-and-tune happens from real usage, not pre-launch.
6. **Branching: per-PR feature branches off `main`. Squash + delete on merge.** No long-lived track branches. PR titles convention: `feat(track):`, `fix(area):`, `chore(release):`, `docs(...)`.
7. **Removability is an explicit checkpoint, not a vibe.** Every Phase-1 milestone (1.2.0 / 1.3.0 / 1.4.0 / 1.5.0 / 2.0.0) carries a Removability check in its exit criteria. If "subsystem removed → no user-visible degradation," the subsystem hasn't earned its place and the *next* minor is gated on closing that gap, not on adding more capability.
8. **Measurement before scale.** The cost dashboard ships in 1.2.1 (one minor after the first eviction subsystem) — not in 1.5.3 as the design originally sequenced it. Each 1.2.x follow-up gates on the previous one's measured value showing up in the dashboard. If Rule 3 doesn't produce measurable savings on top of Rules 1+2, Rule 4 is re-scoped before it ships.
9. **Preact + `htm` allowed for new state-heavy surfaces from 1.3.0 onward; vanilla everywhere else through 2.0.** The "no framework" constraint loosens *narrowly*. Existing tabs / sidebar / file tree / editor frame / chat stay vanilla forever; no migration. New surfaces with non-trivial state — Memory tab (1.3.0, first target), inline `@memory` chip + consent prompts (1.3.0), active-tools chip row (1.4.0), profile picker (2.0) — may be implemented in Preact + `htm/preact` loaded via the vendor bundle (no JSX, no build step, ~5KB gzipped). `State` + `EventBus` remain canonical: components subscribe via a thin store hook, `useState` only for ephemeral UI state. Bigger uniform-UI consolidation (potentially migrating select existing surfaces, plugin Component primitive, mobile rework) is a 2.0 → 3.0 arc. *Implications:* the README's "no framework" pitch updates when the first Preact component ships; vendor bundle gains `preact` + `htm` exports alongside CodeMirror.
10. **claude.ai/design engages on a two-touch model.** Touch 1 (pre-1.3.0): Memory UX scoped to the three flows in §1.3.0 (consent prompts, Memory tab, commit-modal warning). Kickoff prompt handed off 2026-04-29; **deliverable received the same day and stored at `docs/design/touch-1-memory-ux/`** — read it (and the chat transcript at `docs/design/touch-1-memory-ux/chats/chat1.md`) before scoping the 1.3.0 implementation. Headline outputs: 7-item pushback (3 model-level pushes including "drop persona scope from 1.3.0"; 3 implementation probes; 1 nit), Flow 1 inline consent card with "quiet line" variant, Flow 2 in-strip placement A recommended over sidebar B (B reserved as a 2.0 forcing function), Flow 3 protected-branch escape hatch. The biggest open question raised by the design: drop persona scope (`1.3.2`) from the Memory track to simplify Flow 1 + Flow 2 + the `.aieditor/memory/` file count? Touch 2 (between 1.4.x winding down and 2.0.0): consolidation pass — profile picker as new top-level primitive, Settings sidebar (UI #13 deferred here), mobile rework (UI #16), unified status bar (UI #18). Touch 2 happens against measured data from the four shipped subsystems, not speculation; don't pre-design it.

---

## What this roadmap commits to

- **Six-month arc** through 2.0, sequenced as foundations → compression → memory → tools → retrieval → profiles.
- **Biweekly minor releases** as the rhythm; patches as needed inside a track.
- **Admissibility, not accumulation** as the architectural principle every PR is reviewed against.
- **Git-native memory and session state** as the externally-tellable story. Memory + sessions opt into living in `.aieditor/*` files committed with the repo; this is the unique feature the rest of the roadmap trades on.
- **Measurement before scale.** The cost dashboard ships in 1.2.1 alongside the first eviction subsystem, not at the end of the arc. Each follow-up gates on the previous one delivering measured value, not on a calendar date.
- **Removability discipline.** Every Phase-1 milestone exit criteria asks: with this subsystem removed, what user-visible behavior degrades? If "nothing measurable," the subsystem has not yet earned its complexity and the next minor is gated on closing that gap. Protects against shipping six well-designed subsystems and discovering in month seven that two of them were architecturally satisfying but didn't change anything users cared about.
- **No major version bumps** until profiles become the load-bearing configuration surface — *and* the contract is sized to what ai-editor actually uses, not the full design surface (see 2.0.0 "Be ready to discover").
- **UI investment proportional to capability investment** — every track that ships new behavior ships the UI that surfaces it.
- **Honest deferrals.** Multi-modal, collaboration, marketplace are not on this roadmap. Adding them would make the arc unrealistic.
- **The DESIGN docs are the contract.** When implementation diverges from a DESIGN doc, the doc updates first, then the code; not the other way around.

Push back on any of this. The roadmap is a hypothesis. The first track that drifts more than two weeks past its target gets the next milestone re-scoped, not the deadline pushed.
