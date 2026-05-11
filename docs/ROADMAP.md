# AI Editor — Roadmap

> Last updated: 2026-05-11 (post-2.32.0) · Current released: v2.22.0 · `main` HEAD: 2.32.0 + [Unreleased].

## How to read this doc

Roadmap = where we're going. Shipped work and per-PR rationale live in [CHANGELOG.md](../CHANGELOG.md) — don't duplicate it here.

- **Now / Next / Later** — where we are at a glance.
- **Active track** — in-flight work, sized to PRs.
- **Later** — committed tracks queued behind the active one.
- **2026-Q2 code audit + sweep** — sustained refactor-candidate burn-down running alongside surface tracks; queue lives at [`docs/audit-2026-Q2/inventory.md`](audit-2026-Q2/inventory.md).
- **Deferred / unscheduled** — work that was planned, designed, or partially started but isn't currently scheduled. Triage owed.

## Now / Next / Later

| Phase | Track |
|---|---|
| **Just shipped** | Shipped through v2.24.0 — see [CHANGELOG.md](../CHANGELOG.md). Recent: 2.11.0 (Touch 3 **Rail v2** sidebar); 2.12.0–2.14.0 (Touch 3 **PR Review** surface — slices 1–5); 2.15.0–2.16.0 (**MCP discovery Phase 2 slices 1+2** — Smithery dynamic catalog + auto-test on add); 2.17.0 (Touch 3 **Files "Now strip"** — 1.x extraction candidate C); 2.17.1 (**Tool-return invisible-Unicode scanning** — registry-level `scanToolReturn`); 2.18.0 (Touch 3 **Merge Conflict Resolver slice 1** — three-pane Theirs / Resolved / Ours + Take theirs / Take ours + push resolved to head branch); 2.19.0 (Touch 3 **Merge Conflict Resolver slice 2** — Take both + minimap + GitLab/Local capability flag); 2.20.0 (Touch 3 **zip-flow bundle** — Project + Branch zip export, segmented Destination control on upload modal, window-wide .zip drop overlay); 2.21.0 (Touch 3 **Merge Conflict Resolver slice 3** — per-hunk AI resolve action + inline approve/reject card, mirrors the v2.14.0 Diagnose & fix lifecycle); 2.22.0 (**Plugin SlotManager rails** — `js/slot-manager.js` against the locked DESIGN §4 contract, 5 catalog `<div data-slot="...">` mount points, `applyProviderContributions()` boot wiring); 2.23.0 (**SlotManager `rail-views` slot kind + Rail v2 consumer + `pr-list.js` extraction** — structured slot contract addition per DESIGN §4 Decision 1); 2.24.0 (**SlotManager body migration** — Files / Issues / PRs / Branches `render(body)` + `view.headerActions` declarative header buttons; static `<div data-rail-view-container>` HTML scaffolding deleted); 2.27.0–2.30.0 (**inline-handlers migration** Phases 1 + 2a + 2b + 3a — 4-phase delegated-action rollout per [`docs/DESIGN-html-inline-handlers-migration.md`](DESIGN-html-inline-handlers-migration.md): pilot commit modal, 8 modals, 3 remaining modals + app-shell, 7 simpler JS renderers); 2.31.0 (**inline-handlers Phase 3b** — `js/chat/messages.js` migrated to `mountChatMessages` delegation: 13 `onclick=` strings retired, 9 callback actions + Decision-5 generic `toggleExpanded`; HTML side of the migration complete — Phase 4 `window.*` cleanup unblocked); 2.32.0 (**inline-handlers Phase 4** — `window.*` exposure block cleanup: 56 dead aliases retired from `js/app.js`, 15 kept with cited consumers; new `tests/test-no-inline-onclick.mjs` anti-regression coverage; 4-phase migration arc closes; future strict-CSP unblocked). |
| **Now** | Touch 3 surface track has Window v2 / Sessions remaining (post-2.0) — the only Touch 3 surface left. zip-flow Session zip + Clone-from-URL parked behind disabled placeholders in the 2.20.0 modal/popover. MCP discovery Phase 2 slices 1+2 shipped 2.15.0–2.16.0; **OAuth flows** are the remaining sized slice in that track. The Phase 2 profiles picker-promotion track closed for ai-editor with `kb.v1` (2.8.0); `chat_multi.v1` / `rp.v1` are deprioritized for this product (no real consumer). |
| **Next** | **Tier 3b in-editor preview (sidecar + build-step support)** — gated on a measured class of bug that needs build-pipeline rendering (Cogfall / Vite-shaped projects). Tier 3a (2.10.0) covers selector-shaped driving on non-build-step projects (vanilla-JS HTML-Games). Per `docs/DESIGN-preview.md` §"Phased Delivery" → Phase 3b: Playwright sidecar (or equivalent) per workspace, container isolation, per-workspace `npm run dev` lifecycle. Substantially larger PR than 3a; commits only when dogfood produces a probe selectors + Tier-1-static cannot serve. Independent of the Profiles arc. **Profiles Phase 2 picker promotion** for `chat_multi.v1` / `rp.v1` is **deprioritized for ai-editor** — those profiles target consumers (multi-user shared chat, role-play personas) that don't exist in this product; promotion needs a different consumer (custom plugin profile or separate product surface) to earn user-observable weight. Picker-list tests stay pinned at `['chat.v1', 'coder.v1', 'kb.v1']`. **Retrieval ingest hardening** shipped through 2.2.0 (delta-indexing) + 2.4.0 (language-stats + token cap) — track closed. |
| **Later** | Open issues #37 (Phase 2), #27 (Phase 2 settings UI; Phase 1 catalog shipped 2.3.0), #24, #18 (see *Known open issues* below) — none currently on the active track. |
| **Deferred** | Foundations (was 1.1.x), Compression (was 1.2.x), various UI items — see *Deferred / unscheduled* below. |

---

## TL;DR — architectural commitments

The four DESIGN subsystems (`docs/DESIGN-*.md`) describe an intelligence layer rebuild — retrieval, memory, compression, tools — coordinated by per-surface profiles. Three load-bearing commitments:

1. **Admissibility, not accumulation** — every byte the model sees has earned its place.
2. **Git-native memory** — memory and conversation state can opt into living in `.aieditor/*` files committed with the repo. No backend; notes follow the code across machines and forks.
3. **Measurement before scale** — the cost dashboard ships with the first eviction subsystem, not at the end of the arc. Each subsequent track lands against measured baselines.

A 2.0 ships when profiles become the load-bearing configuration surface.

---

## Cadence and versioning

**SemVer with intent.**

| Bump | Triggered by |
|---|---|
| Patch (`1.x.y → 1.x.y+1`) | Bug fixes, doc updates, security, small UI polish, single-rule additions inside an active track |
| Minor (`1.x → 1.(x+1)`) | New subsystem track lands Phase 1, or a self-contained feature spans multiple files |
| Major (`1.x → 2.0`) | The profile contract becomes the load-bearing configuration surface |

**Branching.** Main is protected. Every change goes through a PR from a topic branch. Gitea CI runs security lint + Docker build on every PR; tag push deploys to production. PR title convention: `feat(track):`, `fix(area):`, `chore(release):`, `docs(...)`. Squash + delete on merge. No "preview" or "beta" channels in 1.x — `:dev` Docker tag for PRs and `:test` for `main` provide preview environments.

**Release-readiness gate (added 2026-05-04, retroactive from `v1.6.0`).** Gates **release tag pushes**, not merges to main. Code can land in main behind a version bump (e.g. 1.5.14, 1.6.0, 1.6.1, 1.6.2 sit in main untagged) without triggering this gate; the gate fires when the next `vX.Y.0` tag is about to be pushed. **Pass criteria for tagging a minor:** drive a real chat session of ~10 turns with tool calls, run `find_relevant_files` against a query, make a code edit + commit, all in this repo. No silent history truncation; no broken-history 400s; no stale-state regressions in surfaces touched since the previous tag. **Patch tags** are exempt unless they touch the chat loop or the LLM request shape — though in practice patches inside an active track stay untagged until the next minor closes the bundle. **Why this exists:** between 1.5.5 and 1.5.13 the retrieval track shipped seven internally-correct minor versions while the chat surface had a known summarizer regression that made the editor unusable for long sessions. Shipping internally-correct code on top of an unusable surface is a release-criterion bug, not a roadmap-ordering bug. The gate is honor-system today (no automation); the dogfood result is recorded on the release tag annotation alongside the bundled-PR list.

---

## 2.X path — the load-bearing flip and what runs alongside it

> *This section is the output of a 2026-05-08 paper-only planning session per §Decisions 13. Re-run when the path drifts.*

### State of Phase 1

**What's in main (through 1.14.0, tag `v1.14.0`, commit `17c8e35`):**

- **From 1.1.0:** [`js/profiles/profile-contract.js`](../js/profiles/profile-contract.js) (full `Profile` typedef + `isProfile` guard); [`js/profiles/coder-v1.js`](../js/profiles/coder-v1.js) (full `coder.v1` data, `base: null`); [`js/profiles/task-ledger.js`](../js/profiles/task-ledger.js) (typedefs + `createTaskLedger` + `isTaskLedger`, record arrays empty); [`js/profiles/resolve.js`](../js/profiles/resolve.js) (`resolveCompressionConfig(role)` switch wiring `coder.v1`'s rules into `Compactor.compress()` — compression-only, role-keyed).
- **From 1.14.0 (PR #322):** [`js/profiles/chat-v1.js`](../js/profiles/chat-v1.js) data file; [`js/profiles/inheritance.js`](../js/profiles/inheritance.js) (`resolveProfile` deep-merge with cycle detection); [`js/profiles/index.js`](../js/profiles/index.js) barrel.
- **Direct `CODER_V1` reads still live at:** [`js/chat/handlers.js:47, 779, 780, 803`](../js/chat/handlers.js) — these get cleaned up at slice 1.18.0 below.
- **Coder still has `base: null`.** The next slice (1.14.1 patch or fold into 1.15.0) sets `base: 'chat.v1'` and proves the equivalence with a regression test.

### Path to 2.0.0 — pinned slice table

Every slice between here and the load-bearing flip. Each minor rewires *one* subsystem's lookup from a hardcoded role-keyed source to a profile-keyed source; user-visible behavior is unchanged across most slices except where explicitly noted. By 1.19.0 every subsystem is profile-readable internally; 1.20.0 adds the picker UI alongside roles; 2.0.0 removes the role selector. The "Removability check" (per §Decisions 7) is each slice's exit criterion.

| Slice | What it changes | Subsystem contract change | User-visible? |
|---|---|---|---|
| ~~**1.14.0**~~ *(✅ shipped)* | *see [CHANGELOG §1.14.0](../CHANGELOG.md)* | Profile contract gains a working `base`-chain resolver. **Data only — no consumer reads from a resolved profile yet.** | No. |
| ~~**1.14.1**~~ *(✅ shipped)* | *see [CHANGELOG §1.14.0](../CHANGELOG.md)* | None — data-only. The test is the proof that subsequent slices can rely on resolution being sound. | No. |
| ~~**1.15.0**~~ *(✅ shipped)* | *see [CHANGELOG §1.15.0](../CHANGELOG.md)* | Retrieval Composer gains a ledger-consultation step before each admission. | **Yes** — follow-up turns that re-touch already-admitted chunks see a marker instead of re-pasted content. Token savings on multi-turn coder workflows. |
| ~~**1.16.0**~~ *(✅ shipped — parallel 1.X track interleaved per §"Parallel 1.X tracks". **Profiles arc slice numbering shifts by 1 from here.**)* | *see [CHANGELOG §1.16.0](../CHANGELOG.md)* | None — independent of the profiles arc. | **Yes** — coder gets a new tool-loop pause surface. Chat surfaces unaffected. |
| ~~**1.17.0**~~ *(✅ shipped — was 1.16.0 pre-interleave)* | *see [CHANGELOG §1.17.0](../CHANGELOG.md)* | Compression resolver reads from a *resolved* profile (deep-merge consulted at lookup). | **Yes** — chat surfaces (`role !== 'coder'`) drop `preserve_recent` from 24 to 4. Reconciles the divergence noted in [`chat-v1.js:82–89`](../js/profiles/chat-v1.js). |
| ~~**1.18.0**~~ *(✅ shipped — was 1.17.0 pre-interleave)* | *see [CHANGELOG §1.18.0](../CHANGELOG.md)* | Memory subsystem joins compression on the resolved-profile lookup pattern. | No — clamp preserves pre-1.18.0 behavior for coder; chat surfaces gain a `'user'` default that takes effect when chat surfaces gain memory tools. |
| ~~**1.19.0**~~ *(✅ shipped — was 1.18.0 pre-interleave)* | *see [CHANGELOG §1.19.0](../CHANGELOG.md)* | Tools subsystem on the resolved-profile lookup pattern. | No — same static set; just via the resolver. |
| ~~**1.20.0**~~ *(✅ shipped — was 1.19.0 pre-interleave)* | *see [CHANGELOG §1.20.0](../CHANGELOG.md)* | Last subsystem rewire. **Profiles are now load-bearing internally** even though the Settings surface is still role-keyed. | No — same retrieval behavior per role. |
| ~~**1.21.0**~~ *(✅ shipped — was 1.20.0 pre-interleave)* | *see [CHANGELOG §1.21.0](../CHANGELOG.md)* | Settings surface gains a parallel control; role↔profile translator carries the duality. | **Yes** — new picker UI visible in Settings → Roles. Default `(use role)` preserves pre-1.21.0 behavior byte-for-byte. |
| ~~**1.23.0**~~ *(✅ shipped — slice 1 of 3 of the 2.0.0 retirement)* | *see [CHANGELOG §1.23.0](../CHANGELOG.md)* | New parallel admission filter alongside legacy. | No. |
| ~~**1.24.0**~~ *(✅ shipped — slice 2 of 3)* | *see [CHANGELOG §1.24.0](../CHANGELOG.md)* | Profile-keyed reads win at the admission-filter + system-prompt sites; `Roles.filterTools` orphaned in `js/core.js`. | No — byte-equivalent runtime for every existing user. |
| ~~**2.0.0**~~ *(✅ shipped — slice 3 of 3, final)* | *see [CHANGELOG §2.0.0](../CHANGELOG.md)* | **The profile contract is the load-bearing configuration surface.** Role concept gone from the UI and from the lookup paths. | **Yes** — role selector disappears. Existing users get migrated. Behavior identical for any user who never touched the picker. Unblocks github#24 sub-agents and Touch 3 Window v2 / Sessions. |

**Verification footing.** Each pre-2.0 slice carries the §Decisions 7 *Removability check* as its exit criterion: replace the slice's profile-read with the prior hardcode, run the regression suite, confirm zero diff. Slices marked "User-visible: Yes" are the exceptions — their visible change *is* the intended effect (1.15.0 markers; 1.16.0 `preserve_recent` reconciliation; 1.20.0 picker; 2.0.0 role-removal). Each visible slice gets an explicit regression test.

**Sizing.** Five minors + one patch from 1.14.0 to 2.0.0. Lever to compress further: co-ship 1.20.0 picker UI with the 2.0.0 role-removal in a single cut (4 minors + 1 patch + a major). Lever in the other direction: split 1.14.1's equivalence test from a future ledger-driven re-validation (6 minors + 1 patch).

**Settings UI placement.** `DESIGN-profiles.md` Appendix line 587 splits the Settings surface into preset (named profile selection) and advanced (raw `Profile` struct edits). The preset picker is what makes profiles "the load-bearing configuration surface" visible to the user, so it ships at **1.20.0** alongside roles and is the load-bearing surface from **2.0.0** onward when the role selector retires. The advanced view (raw struct edits) is a **2.0.x** stabilization patch — power-user surface, deferrable without breaking the load-bearing claim. Both views inherit the same toggle convention per §Decisions 11.

### Parallel 1.X tracks

Three tracks share the 1.X version space without advancing the Profiles arc. They interleave at any open Now slot; the Profiles slice numbering above shifts only by *count*, not *order*, when these land in between.

> ~~**Sandbox / LLM-authored automation — single feature minor.**~~ *(✅ Phase 1 shipped 1.16.0)* New `submit_script_for_approval` tool (`readOnly: true`) modeled byte-for-byte on the 1.10.0 `submit_plan_for_approval` lifecycle. Handler returns a Promise that resolves only after user approves in an inline approval card; resolution path runs the script in a sandboxed Web Worker that cannot reach `window`, the tool registry, the network, or any write API. Tier 0 scope = read-only fs walk over `Git.getFile` / `Git.getFileTree` adapter. Hard 10s timeout, 256 KB output cap. Per-profile gate via `scriptAutomation.enabled` (coder=on, chat=off) + Settings → Tools overlay. Full per-PR rationale + tests in [CHANGELOG §1.16.0](../CHANGELOG.md). Phases 2–5 (graduation measurement, Tier 1 HTTP allowlist, backend bridge for Tier 2/3, cross-session fingerprint persistence) park behind real Phase-1 usage data per [`docs/DESIGN-llm-authored-automation.md`](DESIGN-llm-authored-automation.md) §"Phased Delivery".

> ~~**Plugin Discoverability — single feature minor.**~~ *(✅ shipped 2.1.0)* Originally framed as closing three rows in [`docs/PLUGIN.md`](PLUGIN.md) §"Works But No Settings UI". Audit during the 2.1.0 work found the LLM-provider dropdown ([`js/settings-manager.js:131-134`](../js/settings-manager.js)) and the git-provider dropdown ([`js/settings/connections-tab.js:179-182`](../js/settings/connections-tab.js)) were *already* dynamic from `Providers.list()` / `GitProviderRegistry.list()` — the doc rows were stale. Real gap was the third row only: plugin-registered tools had no UI surface. The "Plugin Tools" subsection in [`js/settings/plugins-tab.js`](../js/settings/plugins-tab.js) closes it; backed by a `Plugins._toolOrigins` Map populated by `registerTool()` and cleaned by the existing `tools:unregistered` event. PLUGIN.md updated, retiring the section header. The four "❌ Not Currently Possible" items stay parked — Settings-panel tabs and DOM-slot injection are gated on the unbuilt `SlotManager` (already in §"Other deferred"); Tool-config UI and CodeMirror bridge are larger separate minors.

> ~~**In-editor preview & verify (Tier 1) — single feature minor.**~~ *(✅ shipped 1.22.0)* Closed the platform-level gap surfaced by the 2026-05-08 Sokoban dogfood incident on HTML-Games (`xcaliber/HTML-Games` PR #170 shipped a Sokoban whose `bindEvents()` never ran because `updateUI()` threw on a missing `#level-display`; every key was a no-op end-to-end). The agent had no surface to load the page in a browser, so it could not observe the failure. Tier 1 = sandboxed iframe + Service Worker resolving workspace paths via the existing `Git.getFile` adapter + three new tools (`preview_start`, `preview_stop`, `preview_list`) registered in `js/tools/preview-tools.js`, all `readOnly: true`. Build-step projects (Cogfall) return a structured `requires_build_step: true` envelope rather than misleading "broken" output — the Tier 3 sidecar that handles them is downstream. CSP + iframe sandbox is the trust boundary at the *content* level, mirroring §1.16.0's Tier-0 Worker boundary at the *execution* level. Full per-PR rationale + tests in [CHANGELOG §1.22.0](../CHANGELOG.md). Single-origin trust trade-off (iframe runs at editor origin so the SW can intercept) is documented in `js/preview/preview-host.js` and stays open as the multi-origin deploy candidate.

> ~~**In-editor preview & verify (Tier 2) — console + error capture minor.**~~ *(✅ shipped 2.7.0)* Closed the **Sokoban class specifically** — boot-time `TypeError` thrown from inside `loadLevel(0) → updateUI()` now lands in `preview_errors` with `{message, source, line, col, stack}` on the same turn the agent shipped the edit. SW prepends a sealed shim (`js/preview/preview-shim.js`) inside a `<script>` tag at the top of every served HTML response — runs before user code, wraps `console.{log,info,warn,error,debug}` + `window.onerror` + `unhandledrejection`, forwards events over `postMessage`. Host (`js/preview/preview-host.js`) maintains four per-`serverId` ring buffers (capped at 200, drop oldest); listener validates `event.source` against the registered iframe's `contentWindow` before routing. Four new readers — `preview_console_logs`, `preview_errors`, `preview_logs`, `preview_network` — all `readOnly: true`, all join `coder.v1.tools.static` + `applyPreviewToolFilter` + `PREVIEW_READ_TOOLS` (so github#39's dup-cache invalidation auto-extends). Full per-PR rationale + tests in [CHANGELOG §2.7.0](../CHANGELOG.md).

> ~~**In-editor preview & verify (Tier 3a) — driveable preview, selector-shaped.**~~ *(✅ shipped 2.10.0)* Bidirectional `postMessage` extension to the existing shim (`dir: 'req'` / `dir: 'res'` correlated by `requestId`) gives the agent five new tools: `preview_snapshot` (accessibility-tree walk with `data-preview-uid` mutation-stable markers), `preview_click`, `preview_fill` (native-setter so React-controlled inputs fire), `preview_inspect` (computed style + bbox), `preview_resize` (host-only iframe CSS dimensions). All `readOnly: true`. **`preview_eval` decision settled — does not ship**; selector-shaped tools cover the agent's actual probes and arbitrary-JS injection inverts trust unjustified by anything Tier 1+2 surfaced. **`preview_screenshot` deliberately deferred** — needs html2canvas-class lift; not v1. Full per-PR rationale + tests in [CHANGELOG §2.10.0](../CHANGELOG.md). **Independent of the Profiles arc.**

> **In-editor preview & verify (Tier 3b) — sidecar + build-step support, downstream.** Playwright (or equivalent) sidecar per workspace, container/pod isolation, per-workspace `npm run dev` lifecycle. Closes the Cogfall (Vite/TS/Pixi) class — projects that don't run from raw `index.html` and currently return a `requires_build_step: true` envelope at Tier 1. Gated on dogfood producing a measured probe that Tier 3a's selector-shaped tools + Tier 2's capture readers + Tier 1's static iframe cannot serve. **Independent of the Profiles arc.**

> **Retrieval ingest hardening — measurement-first minor.** Pays down two friction points hit on real repos. (a) **Re-embed-on-branch-switch cost.** Today the embedder defaults to re-embedding when switching from main to a child branch, even when most files are unchanged. Delta-indexing keys re-embed off `git diff <merge-base>...HEAD --name-only` plus dirty working-copy files; the parent's embedding cache stays warm and only the diff costs you. Invalidation on `commit_files` and on file save keeps the active branch's index incremental. The deeper lever — extending `chunk_id` (today `path + byte_range + chunker_version`, see [`js/intelligence/retrieval/chunk-id.js`](../js/intelligence/retrieval/chunk-id.js)) to include a content hash so the cache becomes content-addressable and stale-embedding-on-edited-code stops being a class of bug — stays a candidate for promotion if delta-tracking grows complicated. (b) **500-file ceiling becoming a squeeze.** Today's hardcoded file cap is named in the §"Foundations" parking-lot row ("Embedder hardening") but on real repos the limit fires before the user's primary language is fully indexed. Provider language stats (GitHub `/repos/{o}/{r}/languages`, GitLab `/projects/:id/languages`, Gitea `/repos/{o}/{r}/languages` — all expose byte-count-per-language) drive descending-by-percentage ingest order with a Local-provider fallback that scans extensions. Same slot migrates the cap from file-count to token-budget so file-count stops being the squeeze metric. **Baseline recorded; ship-then-validate** per [`project_cost_quality_tradeoff.md`](MEMORY.md). The 2026-05-08 cost-dashboard export establishes the baseline: `search_in_files` is the dominant cost shape (12,380 calls / ~1.3M tokens / >$1 on a single conversation in `mow5xbbvn7m1`), exactly the X^N grep-fallback the model reaches for when retrieval isn't earning its keep — the symptom of a cold embedder after a branch switch. Validation is a re-export of the dashboard a week after delta-indexing lands: the before/after diff on `search_in_files` token spend earns or refutes the slot, no synthetic probe needed. Decision between contained delta-indexing vs. content-addressable `chunk_id` rewrite gates on the diff size — small drop = delta-indexing was sufficient; small drop after delta-indexing implies the deeper lever is needed. **Independent of the Profiles arc** and independent of Sandbox / Plugin Discoverability.

### After 2.0.0 — Phase 2/3/4 continuation

| Slice | Maps to design | What ships |
|---|---|---|
| **2.0.x** | — | Stabilization patches — advanced view of the picker (forked profile definitions, raw `Profile` struct edits per `DESIGN-profiles.md` line 587 Two-View Configuration); migration-script edge cases; per-profile diagnostics polish. |
| ~~**2.1.0**~~ | — | *(consumed by Plugin Discoverability — see "Now" above; profile-arc Phase 2 shifted down a slot)* |
| ~~**2.2.0**~~ *(consumed by retrieval delta-indexing 2.2.0; Phase 2 shifted; **profiles arc Phase 2 shipped 2.6.0 — data + harness coverage only, picker stays at chat + coder** — see [CHANGELOG §2.6.0](../CHANGELOG.md) and the *"Profiles Phase 2 picker promotion"* row below)* | Phase 2 | `chat_multi.v1`, `rp.v1`, `kb.v1` profiles registered as **lookup-only synthetics** (per `DESIGN-profiles.md` line 455). Inheritance through one level (base → leaf); per-profile worked-example test fixtures landed. **Roles shim retirement** (was bundled here) was actually completed at 2.0.0 — `window.AIEditor.Roles` retired with the role-removal slice; the line was stale. Deferred follow-ups (each on its own line below or in the Phase 2 promotion row): per-profile `systemPrompt` addenda, Rule 4, chunker-metadata, voice-preserving Rule 5 prompt, standalone `citation_lookup` tool. |
| **Profiles Phase 2 picker promotion** | — | `kb.v1` shipped 2.8.0 — graduated from `SYNTHETIC_ENTRIES` to `ENTRIES` with the `KB_SYSTEM_PROMPT` addendum (*"answer ONLY from attached docs, cite line ranges, no edits"*); see [CHANGELOG §2.8.0](../CHANGELOG.md). `chat_multi.v1` / `rp.v1` stay in `SYNTHETIC_ENTRIES` and are **deprioritized for ai-editor** — those profiles target consumers (multi-user shared chat, role-play personas) that don't exist in this product, and the underlying retrieval / memory infra they reference (`per_persona`, `per_speaker`, `lore`, `shared_conversation` collections) doesn't exist either. Picker promotion of either would behave indistinguishably from `chat.v1` for any ai-editor user. Promotion needs a different consumer (custom plugin profile inheriting `base: 'rp.v1'` etc., or a separate product surface) — that's the Phase 4 authoring API path (parked). Picker-list assertions in [`tests/test-profiles-registry.mjs`](../tests/test-profiles-registry.mjs) and [`tests/test-profile-filter-tools.mjs`](../tests/test-profile-filter-tools.mjs) stay pinned at `['chat.v1', 'coder.v1', 'kb.v1']` precisely so any future promotion is load-bearing in PR review. |
| **2.3.0** | Phase 3 | Operational maturity — task boundary detection heuristics (replaces explicit markers), novelty-score tuning from real usage, per-profile dashboards. |
| **2.4.0+** | Phase 4 | Extensibility — custom profile authoring API, profile diffing, profile regression testing harness. Unblocks plugin-defined surfaces. |

---

## Track context: post-1.6.x dogfood + measurement

The 1.6.0 chat-stability minor (six PRs sized in [`docs/design/long-chat-stability/findings.md`](design/long-chat-stability/findings.md)) shipped 1.6.0–1.6.5 individually tagged through `v1.6.5`. Follow-on patches 1.6.6–1.6.14 plus the 1.7.x–1.9.x stretch are now all tagged on the release line through `v1.9.1`. **Per-PR rationale and shipped detail live in [CHANGELOG.md](../CHANGELOG.md)** — not duplicated here.

This section is the home for ongoing **dogfood + measurement** work chained off the chat-stability minor. It's not a "track" in the active-PR sense anymore, but the dogfood-battery framing was authored here and stays here for context continuity.

### Post-tag dogfood battery

**Original framing (historical).** The four-issue ai-editor self-test battery (github#20, #15, #23, #21) shipped through 1.6.0–1.6.11. github#21's substance landed in 1.6.11 (untagged on main); the *trace* portion exposed three concrete tool-ergonomics pathologies fixed in PRs [#289](https://github.com/gobha-me/ai-editor/pull/289)/[#293](https://github.com/gobha-me/ai-editor/pull/293): retrieval cold-start silence (`indexer_not_ready` envelope), stateful-read cache collisions (`STATEFUL_READ_TOOLS` bypass), and `edit_file` STALE LINE NUMBERS without surrounding context (`_getStaleWindow` + 5/5 success echo).

**Why we pivoted (2026-05-06).** The 1.6.11 post-mortem made the load-bearing pattern visible: ai-editor's tool loop runs nested inside the same indexing/caching/state system the test was meant to probe, so self-targeting amplifies fragility *into* the test rather than isolating it. Driving the battery against ai-editor itself stopped paying — the noise-to-signal ratio fell below useful, and partial fixes / fix-branches against the editor itself aren't acceptable as test outcomes.

**The north star is still the self-licking ice cream cone.** ai-editor *should* be the editor we use to maintain ai-editor — that's the whole point. HTML-Games is the bridge: a clean external substrate where we can isolate logic faults from runtime fragility, fix them with confidence, and *then* reattempt self-targeting once the fragility budget is paid down. It's also more fun, which matters for sustaining the work.

**New substrate: [HTML-Games](https://git.gobha.me/xcaliber/HTML-Games).** Private xcaliber repo, six standalone games (5 vanilla JS, 1 Cogfall on TS/Vite/Pixi). Modular, well-documented, varied complexity (Snake ~2.2K LOC → Cogfall ~10K LOC). External codebase whose state never feeds back into ai-editor's caches — clean isolation between target and runtime.

**Test-issue archetypes.**

| Archetype | Example | What it measures |
|---|---|---|
| Add feature to existing game | "Add pause to Space-Invaders" | Retrieval (find main.js + game.js + renderer.js), multi-file edit, stale-line behavior under sequential edits |
| Create new minimal game | "Build a Pong (paddle/ball/score) in vanilla JS matching repo conventions" | Planning, file creation, convention recall, zero-corpus retrieval behavior |
| Cross-game refactor | "Unify high-score `localStorage` between Snake and Forge-Defense" | Cross-file retrieval breadth, refactor proposal quality, compression preserving multi-file context |
| Bug fix in deeper code | "Fix multiplayer collision in Snake" | Root-cause diagnosis, sequential read pattern, tool-call ordering |

Cogfall is the step-up rung when needed: build-step, type errors, framework-shaped retrieval, an existing vitest suite.

**What we measure (logic, not the LLM).** Re-running the same task across a cheap model (Haiku) and a strong one (Opus) is the crux: faults reproducing on **both** are logic faults; faults only on weaker models are LLM faults. Capture per session:

- **Retrieval quality** — for each `find_relevant_files` call: query, returned set, hand-graded "right files?" yes/no. Track whether the indexer-readiness gate fired.
- **Tool-call quality** — did stale-line errors fire? How many recovery turns? Did `edit_file`'s 5/5 success echo carry enough surrounding context? Did `read_*` cache misbehave?
- **Compression behavior** — `localStorage.setItem('debug.dump.summarizerSnapshots', '1')` before starting. Per rebuild: `RECENT_COUNT`, `startIndex`, `info?.summary` presence, dropped count. Did the 1.6.0 truncation marker appear when warranted? 1.6.2 request-shape validator drop orphans (firing once is fine; repeatedly means upstream regression)? 1.6.4 token-based summarization fire when load warranted and not before?
- **Planning quality** — eyeball: did the model plan the work or hack? Sane edit order?
- **Cost-quality tradeoff** — `prompt_tokens` and `cached_tokens` per turn vs. the observed quality of the four axes above. The grading axis the others gate against. Two failure modes: **under-spend** (token cheap but compression / retrieval dropped what the model needed — output is wrong) and **over-spend** (tokens expensive but quality flat above some level — money for context the model never used). Cost-dashboard export via `buildCostExport()` ([`js/settings/cost-tab.js`](../js/settings/cost-tab.js)) at session end; per-strategy retrieval cost via [`cost-store.js`](../js/intelligence/cost/cost-store.js). See the **operational constraints** below for how we probe model-vs-logic faults given the editor's branch lifecycle and Jeff's testing budget.

#### Test design under operational constraints

Two real constraints shape how the battery actually runs.

**1. Branch lifecycle.** ai-editor auto-creates a branch when a session "starts" on an issue, with a guard against multi-start on the same issue. So we **cannot rerun the same task** against a different model the way the original cross-model probe assumed. The replacement is **sibling tasks**: pick an archetype, design 2-3 same-shape tasks against different games/features, assign a different model to each. Faults reproducing across all siblings are logic faults; faults visible on a single sibling are model-specific.

| Archetype | Sibling 1 | Sibling 2 | Sibling 3 |
|---|---|---|---|
| Add feature | "Add pause to Snake" | "Add pause to Space-Invaders" | "Add pause to Forge-Defense" |
| Cross-game refactor | "Unify highscore Snake↔Forge" | "Unify audio Snake↔SpaceInv" | (skip unless 1+2 disagree) |

Variation across game adds noise vs. the lab-clean rerun, but it's also a *better* probe — a logic fault that survives codebase variation is a stronger finding.

**2. Budget — $11/day.** The cross-model probe lives in the **cheap tier**. Opus and Sonnet stay out of the daily lineup; reserve Sonnet 4.6 for one anchor probe per week on the smallest archetype.

| Tier | Models | $/M in | $/M out | Per-session est. | Role |
|---|---|---|---|---|---|
| Cheap (default) | DeepSeek V4 Flash, Mistral Small 4, Grok 4.1 Fast | $0.17–$0.23 | $0.35–$0.75 | ~$0.40 | Default rotation across siblings |
| Code-aware | Qwen 3 Coder 480B Turbo | $0.35 | $1.50 | ~$0.60 | When the cheap tier flubs and we want a code-specialist comparison |
| Mid (escalation) | GLM 5, Kimi K2.6 | $0.85–$1.00 | $3.20–$4.66 | ~$1.20 | When cheap+code-aware both fail and we want to confirm logic-vs-LLM before declaring a fault |
| Strong-anchor (rare) | Sonnet 4.6 | $3.60 | $18.00 | ~$5.00 | One probe per week on the smallest archetype, to confirm the upper bound |
| Skip for daily | Opus 4.x, GPT-5.x Codex, Grok 4.20 | — | — | — | Budget killers; only on explicit need |

**Reading the matrix:** if a logic fault shows up on Cheap-tier-A but not Cheap-tier-B against sibling tasks of equivalent shape, that's noise / model-specific. If it shows up on **both** cheap-tier siblings AND survives the code-aware run, escalate one tier and confirm. If it survives mid-tier too, file as a logic fault with high confidence and hold the strong-anchor probe in reserve for next week's verification.

End-of-session deliverable: per-session markdown trace at [`docs/dogfood-battery/`](dogfood-battery/) — filename `YYYY-MM-DD-<short-task-slug>.md`. First trace establishes the template; do not pre-design it. These are the artifact, not throwaway notes.

**Grading.** Pass = trace is legible cold AND surfaces at least one logic-vs-LLM distinction AND the cost-quality tradeoff lands on the right side of the knee (under-spend with quality loss or over-spend with no quality gain both fail, even if every logic axis is clean). Output PR quality (does the editor produce mergeable code) is secondary — it's a lagging proxy.

**Preserved from the old plan: the release-readiness gate (§"Cadence and versioning").** Before any `vX.Y.0` tag push, drive a 10-turn ai-editor session **in this repo** with one `find_relevant_files`, one edit, one commit. Honor-system smoke test that the editor still functions on its own corpus. Unchanged.

**Out of scope for the new battery:** github#18 (cross-device settings sync via QR/P2P) — unbounded; tests product-design instincts more than logic. Automation/runners — first ~3-5 sessions are manual; abstract only when a pattern repeats.

---

## Later (sequenced)

### Decision: AST-based code chunker Phase 1 — shipped 1.7.0 (2026-05-06)

The polyglot benchmark ([PR #290](https://github.com/gobha-me/ai-editor/pull/290), merged 2026-05-05) fired the gate on Plinth/C++ — Hit@5 well below Armature/Go's near-ceiling. The 1.7.0 brace-depth-aware C-family lexer is the response; per-PR rationale and pre/post measurement tables in [CHANGELOG §1.7.0](../CHANGELOG.md).

Phase 1 lifted Hit@5 substantially: two previously-zero fixtures (`realtime-pubsub-broker`, `audit-logging-write`) now hit. Two stay zero (`capability-registry-api`, `rbac-enforcement-filter`) — those are scoring-side failures, not chunker-side: the integration-test files out-score the source files when both contain the query keywords. Phase 2 trigger.

Reproducible benchmark: re-run `tests/run-polyglot-benchmark.mjs` against the same `tests/fixtures/polyglot-corpus.js`. Future Phase 2 lever (vendored tree-sitter for parent-class-signature propagation, cross-file query expansion, or test/source weighting) must move the needle on **recall@5** specifically — Hit@5 is approaching ceiling now.

### Decision: AST Phase 2 lever C (test/source path weighting) — measured 1.7.2; insufficient alone

Cheapest of the three Phase 2 levers — the existing `applyScoreWeights` ([js/intelligence/retrieval/strategies/semantic.js:300](../js/intelligence/retrieval/strategies/semantic.js)) already supports prefix-keyed multipliers post-rank. 1.7.2 swept `tests/` prefix penalties against the polyglot benchmark; full result table in [CHANGELOG §1.7.2](../CHANGELOG.md).

Lift on Plinth was real (+33% relative, no Armature regression) but did not reach the 0.55 floor and did not move the two stuck-zero fixtures off zero. Why: demoting `tests/` only helps when the *correct* `src/` file is already in the top-5 candidate pool to be re-ranked. For `plinth-capability-registry-api` and `plinth-rbac-enforcement-filter` the right files (`registration.cpp/.hpp`, `enforcement.cpp/.hpp`) never enter the candidate pool — query keywords don't BM25-match the file content directly.

**Next lever has to widen the pool, not re-rank within it.** Lever C becomes a useful re-ranker layered on top of whichever of A/B ships, but on its own it doesn't carry past the floor. Production change held; no `defaultCodeScoreWeights` ships in 1.7.2.

### Decision: AST Phase 2 lever B (cross-file query expansion) — shipped 1.8.1 (2026-05-08)

The 2026-05-07 feasibility probe and the 2026-05-08 production wiring shipped together at 1.8.1; full per-PR rationale and result tables in [CHANGELOG §1.8.1](../CHANGELOG.md). The decision context — preserved here for roadmap continuity:

The `lever-B-rrf-alts-only` configuration shipped: RRF over the alt rankings alone (baseline excluded from fusion) matched best-of at the aggregate and lifted both stuck-zero Plinth fixtures off zero, with no Armature regression. Production ships option 1 — simpler than confidence-weighted fusion, no oracle needed, degenerates cleanly when the rewriter emits one alt.

**Lever A stays parked.** The gap closed cleanly under a smarter query — it's rewriteable, not structural. Web-tree-sitter's parent-class-signature propagation isn't justified by current measurement; it stays a candidate only if a future fixture surfaces a chunk-content gap that no rewrite can paper over.

**Lever C** (test/source path weighting) remains opt-in via `MetadataFilter.score_weights` — the post-fusion re-ranker layered on top of lever B. Useful when the alts surface integration tests alongside source files; not the production default for the same reason 1.7.2 didn't ship a `defaultCodeScoreWeights` (insufficient lift on its own without lever B widening the candidate pool first).

### LLM reranker (scoped, not committed)

A candidate next-lever class for retrieval quality. Different in kind from every lever the §1.5.0 track shipped: every prior lever (T1–T5, BM25, paraphrase, Thematic) operated on the *candidate pool*. A reranker re-orders within the already-correct top-K — and `meanHitAt5 = 1.000` post-1.5.11 says the top-K is already correct for every fixture in this corpus.

**Sketch.** New `js/intelligence/retrieval/strategies/reranker.js` exporting `createReranker({ chatFn, modelId, prompt?, parser?, cache? })` and `buildRerankerFromSettings(settings, ...)`, mirroring [`createQueryParaphraser`](../js/intelligence/retrieval/query-paraphraser.js) (pure DI; production wires `chatFn = LLM.chat`; failure modes pass-through). Wiring seam: post-Composer, pre-block-assembly. Settings → Retrieval gains a section mirroring paraphrase (mode picker, `rerankModelId`, top-K).

**Locked default prompt skeleton (corpus-agnostic; subject to T9 measurement before commit).**

> *"You are a relevance-ranking assistant. Given a search query and a numbered list of code-snippet candidates, score each candidate 0–10 for how relevant it is to the query. Output one score per line in the form `N: <score>` matching the candidate index. No commentary. No invented scores."*

**Why deferred.** Cost-vs-lift sanity check before code is written: candidate-set N=20 chunks × ~50 tokens + prompt ~200 + N output scores ~100 = ~55k tokens per measurement pass. The budget impact on the live `find_relevant_files` path is the limiting factor. Decision to ship is Jeff's call against measured numbers.

### 3.0 / Post-2.0 candidates [unscoped]

- **Uniform UI consolidation** — by 2.0 we'll have shipped Preact + `htm` on a handful of new surfaces (Memory, `@memory` chip, active-tools chip row, profile picker). 3.0 evaluates whether to migrate select existing surfaces (Settings sidebar, secondary pane, conversation drawer), introduce a Plugin Component primitive, and rework mobile.
- **Sub-agents** — bounded child conversations with their own context/tool catalog/budget. Tractable post-2.0 because profiles make "child profile" a real abstraction. Commit only if real tasks are measurably bottlenecked on context exhaustion that decomposition would solve.
- ~~**Browser-in-browser preview**~~ *(superseded 2026-05-08 — pulled forward as Tier 1 in §"Parallel 1.X tracks" → "In-editor preview & verify"; full design at [`docs/DESIGN-preview.md`](DESIGN-preview.md))* — Service Worker intercepting iframe `fetch` to serve in-memory files; multi-file static web apps render correctly. StackBlitz-classic / CodeSandbox-v1 pattern. Originally framed as a 3.x maybe; the 2026-05-08 Sokoban dogfood incident on HTML-Games made the gap load-bearing for the agent feedback loop, not just for human convenience. The §"Parallel 1.X tracks" entry is the current home; this stub stays here for cross-reference.

All three get scoped post-2.0 against measured signal, not speculation.

---

## 2026-Q2 code audit + sweep track

> *Started 2026-05-11 post-2.23.0 SlotManager migration. Measurement-first sweep — read the codebase, catalog refactor candidates, burn them down at ~1 entry per spare slot.*

The 2.22.0 / 2.23.0 SlotManager work surfaced enough deferred-but-known refactor candidates (hardcode walls, missing event wiring, duplicate implementations, should-be-registered-isn't, style drift) to justify a sustained sweep track alongside the surface tracks. Each candidate is small enough that none would individually earn a roadmap slot; collectively they're the kind of fragility that ages a codebase if left alone.

### The queue

Living inventory: [`docs/audit-2026-Q2/inventory.md`](audit-2026-Q2/inventory.md). Categories (**HC** hardcode wall · **EV** missing event wiring · **DUP** duplicate implementation · **REG** should-be-registered-isn't · **ST** style drift), system buckets (sidebar / chat / tools / git-providers / slot-manager / events / plumbing-storage / settings / app-boot / prompts / profiles / editor / preview / help / html-shell), confidence tags (likely / needs-investigation / maybe-intentional), and per-entry touch points all live there. Strike-through as entries ship; the queue closes when fewer than ~5 entries remain that survive triage.

ROADMAP does **not** enumerate entries — that defeats the point of the separate inventory. ROADMAP surfaces the track; the inventory holds the queue.

### Sizing — one entry per slot

- **[S]** (single PR, <100 LOC) — folds into in-track patches; co-ship with whatever surface work is open.
- **[M]** (multi-PR sequence, <500 LOC) — earns its own minor slot.
- **[L]** (architectural, design doc + multi-minor) — earns a design doc first.

### Triage policy

Lives in the inventory under §"Triage policy." Confidence-tag rules (likely → ship, needs-investigation → audit-first, maybe-intentional → designate as public extension API or delete) and the §"Triage notes (additional candidates exist)" deferred-from-deferred list both stay in the inventory. ROADMAP only points.

### Cross-references into the inventory

Where a sweep entry is the same work as an item already on this roadmap, the existing roadmap row links into the inventory (single source of truth for refactor-candidate state):

- ~~**SlotManager body migration**~~ *(✅ closed at 2.24.0)* — was matched by the `[ST][S] Sidebar uses static [data-rail-view-container] blocks while rail v2 wants dynamic` entry; both struck through in the [inventory](audit-2026-Q2/inventory.md) alongside the related `[EV][S]` issues count parallel-update entry.

Other overlaps surface as the queue burns down.

---

## Deferred / unscheduled (needs triage)

> **Why this section exists.** Foundations (1.1.x) and Compression (1.2.x) were sequenced before Memory + Tools jumped ahead. Some items are gated on metrics from the cost dashboard (which has shipped — but its export affordance has not; see the Compression bucket). Some may be obsolete now that Tools shipped its own equivalents (e.g. the `TaskLedger` landed in 1.3.17). Sorting paused-vs-abandoned is owed.
>
> **Triage policy (2026-05-05).** Each item below gets one of two scheduled actions: a **code audit** (read the relevant module + branch, decide whether the work is still needed in light of what shipped since) or a **formal test** (when an audit can't determine relevance — e.g. compression Rules 1+2 effectiveness only shows up under measured load). Items determined to be **OBE** ("Overcome By Events" — superseded by later work) get removed from this doc; items determined to be still needed get re-slotted with a track. Audits/tests run as their own small PRs; the disposition note lands in this section's row before removal or re-slotting.

### Foundations (was 1.1.x)

| Item | Branch | Rationale |
|---|---|---|
| Turn metadata enrichment | `feat/1.1.0-turn-enrichment` | Needed by compression Rules 1–3 (`file_ops`, `tool_result_for`). Read-path-only; new turns enriched, old ones absent. |
| Migration coverage probe | `feat/1.1.0-metadata-coverage-probe` | Read-only consistency check; `?debug=metadata` flips it on. Distinguishes "no rule applied" from "rule skipped because metadata absent." |
| Profile scaffolding (data only) | `feat/1.1.0-profile-scaffolding` | `js/profiles/coder.v1` mirroring current behavior, no behavior change. |
| CI `node --test` step | `feat/1.1.0-ci-node-test` | Port `*.mjs` suites to `node:test`. Likely abandoned; we're well past 1.1.0. |
| Pre-merge version coherence check | (none) | Lint comparing `js/version.js` to latest `## [X.Y.Z]` heading in `CHANGELOG.md`. Two release-sync drifts is enough; one evening to fix forever. |
| Embedder hardening | `feat/1.1.2-embedder-provider-decoupling` | Provider decoupling, filetype filters, 500-file ceiling, in-browser embedder validation, Settings → Embeddings tab. |
| Vim keybindings | `feat/1.1.3-vim-keybindings` | `@replit/codemirror-vim`; toggle in Settings → Appearance. Self-contained. |
| Glassworm / Trojan-Source protection | (none) | Invisible-Unicode lint in CI; editor decoration; plugin install warning band; `docs/SECURITY.md`. |

### Compression (was 1.2.x)

> **The whole track is gated on cost-dashboard export.** The dashboard itself shipped at 1.2.1 ([`js/settings/cost-tab.js`](../js/settings/cost-tab.js)) — cross-provider, per-conversation, per-tool, 30-day chart, budget tracking. It is currently *read-only*: the data lives in [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js) but cannot leave the browser. Without an export affordance (Copy / JSON / CSV), the question "did Rules 1+2 actually save the projected 40%?" can be eyeballed in the chart but not analyzed offline. Each compression follow-up gates on the previous one's measured value showing up in the dashboard *and* being capturable for comparison.

| Item | Branch | Rationale |
|---|---|---|
| Rules 1+2 (Subsumption, Invalidation) | `feat/1.2.0-compression-phase-1`, `feat/1.2.x-compression-off-flag`, `feat/1.2.x-synthetic-savings` | New `js/intelligence/compression/` module tree. `preserve_recent` invariant. Diagnostics in LLM debug modal. Existing `chat/summarizer.js` stays as Rule 5 fallback. |
| Cost dashboard *(shipped 1.2.1)* | (n/a) | Cross-provider, per-conversation, per-tool token + cost breakdown lives at [`js/settings/cost-tab.js`](../js/settings/cost-tab.js); store at [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js). Venice + OpenRouter remote dashboards in `plugins/`. **Status:** ✅ shipped; the listed-here legacy line said "(none)" — that was stale. |
| **Cost-dashboard export** *(✅ shipped 1.6.6)* | (n/a) | JSON-download from [`js/settings/cost-tab.js`](../js/settings/cost-tab.js) via `buildCostExport()` + Export button. Lives at [CHANGELOG.md](../CHANGELOG.md) §1.6.6. Unblocks the compression-track measurement loop and the 1.6.7 retrieval extension. |
| Rule 3 (Consumption) | (none) | Gated on export + ≥95% `tool_result_for` coverage on production sessions. |
| Rule 4 (Resolution) | (none) | Templated marker generation for "debugging spans that ended successfully." Gated on Rule 3 numbers matching the design. |
| Rule 5 tuning | (none) | Plug existing summarizer into the pipeline cleanly; measure compression latency and summarizer call rate. |
| Settings → Compression panel refresh | (none) | Replaces Settings → Chat Summarizer. Establishes the **preset / advanced toggle pattern** (Decision §11) that subsequent panels inherit. Gated on Rules 1–5 live. |
| ~~Provider rate-limit respect~~ *(✅ shipped 2.9.0)* | *see [CHANGELOG §2.9.0](../CHANGELOG.md)* | New [`js/llm/pacer.js`](../js/llm/pacer.js) production wrapper around the eval-canonical pacer — process-global `RateLimiterPool` singleton (per-call delay forced to 0 ms in production) + conservative `estimateInputTokens` estimator + three-step insertion (`await sleep(msUntilNextSend)` → `markSent` → `ingest(headers)`) at the two real fetch chokepoints ([`js/llm/api.js:436`](../js/llm/api.js) chat-completions, [`js/llm/completion.js:129`](../js/llm/completion.js) ghost-text). Per-model bucketing keeps quota state isolated across model switches. Ollama / OpenRouter publish no `x-ratelimit-*` → null caps → no added latency. **Touch 3 Window v2 / Sessions hard-prerequisite cleared.** |

### Touch 3 deliverables (received 2026-05-07; dominantly post-2.0)

> **Bundle:** [`docs/design/touch-3-left-pane-and-window/`](design/touch-3-left-pane-and-window/) — README + 2 chat transcripts (`chat1.md` is the historical Touch 1+2 thread; **`chat2.md` is the Touch 3 work**, started 2026-05-01) + `Facelift.html` design canvas + JSX/CSS deliverables. Repo dumps and design-canvas sidecar state pruned. Read `chat2.md` and `pushback.jsx` before implementing anything from this touch.
>
> **Why post-2.0.** The user explicitly tied this to 2.X profiles in the design conversation (`chat2.md` line 141: *"claude code and I are wrapping up 1.X and are about to cut 2.X profiles, this is intelligence layer stuff"*). The Window v2 architecture is **load-bearing on the profile contract** — a "session" is naturally a profile instance, so building Sessions before profiles ship doubles the rework risk; see §"2.X path" for which slice unblocks this (2.0.0). PR Review and Merge Conflict are surface-sized minors that could ship pre-2.0 if a slot opens, but they're independent of the Sessions work.

| Item | Bundle file(s) | Scope shape | Notes |
|---|---|---|---|
| **Window v2 / Sessions / chat-as-spine** | `window-v2.jsx`, `window-v2.css`, `Facelift.html#window-v2` section | Architectural rework | Middle pane becomes a **stage** that swaps mode (welcome / file / diff / PR review / conflict / task timeline). Chat earns the center-right column full-height (gets a focus mode with rail collapsed). **Sessions tabs** in the top bar — each tab = self-contained branch + task + chat + open files; multi-branch / multi-project concurrent in one window. **Hard prerequisite:** production rate-limit pacer (see Compression bucket §"Provider rate-limit respect") — multiple concurrent agents in one window saturate per-provider caps faster than the single-chat case. Reference: [`evals/pacing.js`](../evals/pacing.js). |
| ~~**PR Review surface**~~ *(✅ shipped 2.12.0–2.14.0; slices 1–5)* | `pr-review.jsx`, `Facelift.html#prreview` section | New surface, minor-sized | Full editor takeover. Slices: 1 (read-only file-tree + side-by-side diff + comment threads, 2.12.0); 2 (review submission + sticky dock with Comment / Request changes / Approve + merge folded into the dock, 2.13.0); 3 (rail badge race fix, 2.13.1); 4 (per-surface CI polling + Re-run failed jobs, 2.13.2); 5 (Diagnose & fix from failed CI logs — single-file LLM patch proposal as inline approve/reject card, 2.14.0). PR Review polish follow-ups (agentic Diagnose, multi-file patches, dock-vs-chat card extraction) parked under *Other deferred* below. |
| ~~**Merge Conflict Resolver**~~ *(✅ slices 1+2+3 shipped 2.18.0–2.19.0 + 2.21.0)* | `merge-conflict.jsx`, `Facelift.html#merge` section | New surface, minor-sized | Slice 1 (2.18.0): three-pane + Take theirs/ours + push resolved. Slice 2 (2.19.0): Take both + conflict minimap + GitLab/Local capability flag. Slice 3 (2.21.0): per-hunk AI resolve action + inline approve/reject card; mirrors the v2.14.0 PR Review Diagnose & fix lifecycle (single-shot `LLM.chat` → JSON response → in-row approval card). Follow-up patches (Resolved-pane direct edit, proportional minimap bands, agentic AI resolve, multi-hunk batch resolve, conflict-marker preservation in Take both) parked under *Other deferred* below. Independent of Sessions. |
| ~~**Left-pane Rail v2 (full conversion)**~~ *(✅ shipped 2.11.0)* | `left-pane-v2.jsx`, `Facelift.html#leftpane-v2` section | Full pane rework | Activity-rail (B) + view switcher; **Tasks** / **Releases** / **▶ Start** on issues / branch switcher with ↑/↓ counts / Files with hover-actions. Files "Now strip" (candidate **C** below) deferred from this conversion — read-only indicator, ~1 small patch. |
| ~~**Zip Up / Zip Down — three scopes, three homes**~~ *(✅ Project + Branch zip shipped 2.20.0; Session zip parked behind Sessions, post-2.0)* | `zip-flow.jsx`, `zip-flow.css`, `Facelift.html#zip-flow` section | UX rework of an existing feature | Shipped 2.20.0: **Project zip** lives in a kebab popover (`#btnProjectActions`) next to the project selector (Clone from URL stubbed disabled · Import .zip · Export project · Export branch). **Branch zip** lives as a per-row Export button in the Branches rail. **Window-wide drop zone** materializes on `.zip` drag; drops always create a new branch by default. **Upload modal** segmented Destination (`current` / `new branch` / `new session` [disabled]) with auto-named branch from filename. Atomic-batch-commit semantics preserved. **Session zip parked** — disabled placeholder in the segmented control; ships alongside Window v2 / Sessions (post-2.0). **Clone-from-URL** stubbed disabled (URL probing + provider inference deferred). Closed the [`docs/design/OPEN-QUESTIONS.md`](design/OPEN-QUESTIONS.md) zip-flow entry filed 2026-05-07. |

**1.x extraction candidates (small, feasible without the full rework — not committed; pick when a slot wants UX polish):**

| Candidate | Scope | Source | Why it's tractable now |
|---|---|---|---|
| ~~**A. Branch switcher upgrade**~~ *(✅ shipped 1.12.0)* | *shipped — see [CHANGELOG §1.12.0](../CHANGELOG.md)* | `left-pane-v2.jsx` "branches" view | Out — shipped. |
| ~~**B. ▶ Start prominence on issues**~~ *(✅ shipped 1.13.0)* | *shipped — see [CHANGELOG §1.13.0](../CHANGELOG.md)* | `left-pane-v2.jsx` "issues" view | Out — shipped. |
| ~~**C. Files "Now strip"**~~ *(✅ shipped 2.17.0)* | *shipped — see [CHANGELOG §2.17.0](../CHANGELOG.md)* | `left-pane-v2.jsx` "files" view | Out — shipped. |

### Other deferred

- **PR Review polish (deferred from 2.14.0)** — follow-ups parked behind real usage signal:
  - **Agentic Diagnose mode** — let the LLM use `read_lines` / `scan_file` to investigate before proposing. Gated on v1 quality data: if single-shot output is consistently wrong on the target-file pick, escalate to an agentic loop with a constrained read-only tool set.
  - **Multi-file patches** — natural follow-up alongside agentic mode. v1 system prompt explicitly constrains to one file change per proposal.
  - **Dock-vs-chat card extraction** — extract `buildEditProposalCard`'s diff-render core ([`js/chat/messages.js:538`](../js/chat/messages.js)) into a shared `renderEditProposalDiff` helper. Gated on a third consumer surfacing; with one chat consumer plus one preact dock-local component, the duplication is ~40 LOC of preact wrapper, not worth a chat refactor.
  - **GitLab `rerunCi`** — separate from Diagnose; add the capability when GitLab adds the upstream API.
  - **"Diagnose without CI failure"** — entry-point for PRs with red review feedback but no CI run. Speculative.
- ~~**`ChatHistoryStore` encapsulation**~~ *(✅ shipped 1.11.0)* — Single owner at [`js/chat/history-store.js`](../js/chat/history-store.js) exposes `append / splice / setLength / replace / clear`; sixteen direct mutations + persistence calls across `messages.js`, `handlers.js`, `summarizer.js`, `index.js`, `conversations.js`, `storage-metrics.js` consolidated to one. All methods mutate `State.chatHistory` in place to preserve any captured array reference. Tests in [`tests/test-history-store.mjs`](../tests/test-history-store.mjs). The quota-aware eviction strategy this unblocks (embeddings-first → old chats → never active) stays a separate slot.
- **Chat panel facelift** — three Touch 2 variants (Polish, Restructure, Reskin); direction not locked. Will get a slot once a direction is picked or roll into 2.0 with the profile picker.
- **Persona memory scope** — deferred indefinitely. Workspace + user scopes cover the demand seen so far.
- ~~**Plugin SlotManager**~~ *(✅ rails 2.22.0; `rail-views` slot kind + Rail v2 consumer + pr-list extraction 2.23.0; body migration 2.24.0; contract locked 2026-05-11 — see [`DESIGN §4`](DESIGN-git-providers-and-ui-extensions.md) Decision 1)* — `js/slot-manager.js` ships against the locked contract; 5 catalog `<div data-slot="...">` mount points; `applyProviderContributions()` fires at boot. **Sidebar migration is complete for the four built-in rail views** — Files / Issues / PRs / Branches now render entirely from `BUILTIN_VIEWS` contributions in [`js/ui/left-pane-rail.js`](../js/ui/left-pane-rail.js), `view.headerActions` carries the per-view header buttons declaratively, and the static `<div data-rail-view-container>` HTML scaffolding in `html/sidebar.html` deleted at 2.24.0. The corresponding [`[ST][S]`](audit-2026-Q2/inventory.md) entry in the [2026-Q2 audit + sweep](#2026-q2-code-audit--sweep-track) inventory is closed accordingly. Settings connection cards (still flat) and top-bar pills (still flat per Decision 1) migrations remain deferred. See [CHANGELOG §2.22.0](../CHANGELOG.md), [§2.23.0](../CHANGELOG.md), [§2.24.0](../CHANGELOG.md).
- **In-app help renderer** — sidebar pane instead of modal; would make `read_docs`-driven content far more useful. (`js/help/` exists today — modal-based; the deferred work is the sidebar variant.)
- **Mobile secondary pane rework** — current ≤768px layout treats secondary pane as a fullscreen overlay; could be a slide-over.
- **Issue/PR tab visual hierarchy** — long tabs feel busy; lo-pri.
- **Plugin marketplace** — defer to 2.x once the architecture stabilizes.
- **LLM-authored ad-hoc automation** — Design at [`docs/DESIGN-llm-authored-automation.md`](DESIGN-llm-authored-automation.md) (shipped 1.13.0); sized as a 1.X.0 minor in §"2.X path" → "Parallel 1.X tracks" above (Tier 0 read-only fs-walk + in-browser Web Worker + Plan-Mode-shaped approval card). Captured in memory `project_wishlist_llm_authored_automation.md`.

**Migrated from retired `docs/PLAN.md` (2026-05-06; triage owed):**

- **Plugin settings panel tab** — Allow plugins to register a dedicated tab in the Settings modal for richer configuration UI beyond auto-generated `configSchema` fields.
- **CodeMirror extension bridge** — Expose the CodeMirror `EditorView` to plugins for keybindings, decorations, and custom syntax highlighting.
- **Tools settings page** — Dedicated tab showing all registered tools with name, description, role assignments, and enable/disable toggles.
- **Custom role creation UI** — Create new roles with name, icon, description, and checkbox list of tools. `Roles.register()` exists but has no UI.
- **Cross-project tools** — `peek_scan_file` (cross-repo function/class outline; requires extracting scan parsing into a shared module), `peek_search_in_files` (cross-repo grep; needs tree iteration or provider search API), `peek_read_function` (combines `peek_scan_file` + `peek_read_lines`).
- **More languages in `scan_file`** — Today only JS/TS and Python parse into a structured outline. Add Go, Rust, Java, C/C++ patterns so `scan_file` is useful in polyglot repos.
- **Expand `.mjs` test coverage** — The `node --test` CI step (1.0.6) runs only the ported subset (`test-smoke`, `test-retry`, `test-edit-tracker`, `test-summarizer`, `test-blame-normalize`, `test-metadata-coverage`, `test-turn-enrich`). The browser-only `.js` suites still run only under `tests/index.html`. Port them so CI exercises the full surface.
- **Generic / custom git provider** — A "custom" option where users map endpoint URLs to the base interface for any Git API.
- **Offline / PWA support** — Service Worker for offline editing with sync-on-reconnect.
- **Untrusted issue/PR content delimiter wrapping (security-track patch)** — Wrap external issue/PR/comment text in `<UNTRUSTED_*>` markers in `js/prompts.js`; add a system-prompt instruction that imperatives inside markers are data not commands; ~~extend `js/security/invisible-unicode.js` to scan tool returns~~ (shipped 2.17.1 — registry-level `scanToolReturn` covers every dispatch; findings attach to `result._security.invisibleUnicode` and surface inline in the tool-call card). The first two sub-items shipped 1.6.12 / PR #296. Audited 2026-05-06; see `docs/SECURITY.md` §"Untrusted issue / PR / comment content" and memory `project_untrusted_issue_content_gap.md`.

### Known open issues — not yet scheduled

User-facing gaps tracked as filed issues but not yet slotted into a track. Listed here so a roadmap reader can see them without diff'ing against the issue tracker. **Issue trackers split by audience:** internal/dogfood-only on Gitea (`git.gobha.me/xcaliber/ai-editor`); public-facing on the GitHub mirror (`github.com/gobha-me/ai-editor`).

**Open — slotted but not on the active track:**

- **github#37 Phase 2** — Re-scope the eight deferred design questions (listed inline under the closed Phase-1 entry below) once dogfood surfaces real friction around conventions. No active work; not gated. Phase 1 may turn out to be the whole answer.
- **github#27 Phase 2 — `MCP Server Discovery & Easy Configuration`** — Phase 2 **slice 1** (Smithery dynamic catalog + search/chip filter + lazy detail fetch) shipped 2.15.0; **slice 2** (auto-test on add — `testConnection` fires after Save with a skip-policy for label-only edits and disabled saves) shipped 2.16.0. Phase 1 (curated 8-server bundled catalog) shipped 2.3.0. Remaining open slice: **OAuth flows** (formerly "Phase 1.5"). Custom catalog sources + Phase 3 self-hosted templates remain deferred.
- **github#24 — `Sub-agent architecture for delegated task execution`** — Bounded child conversations with their own context / tool catalog / budget. **Post-2.0.0** — gated specifically on the role-selector removal; profile contract becomes the abstraction child profiles inherit from. See §"2.X path" for which slice unblocks this. Commit only if real tasks are measurably bottlenecked on context exhaustion that decomposition would solve.
- **github#18 — `Cross-device settings sync via QR codes / P2P`** — Designed in [`docs/DESIGN-cross-device-sync.md`](DESIGN-cross-device-sync.md) (draft). Roadmap §"What's out of scope for the 1.x → 2.0 arc" lists "cross-process / distributed state" as out of scope; this issue is the design-on-paper edge of that line. Stay parked through 2.0; revisit post-profile-contract.

**Closed:**

- ~~**github#38 — `Approval card surfaces 'Edit rejected' with no tool name, args, or diff context`**~~ *(✅ closed — shipped 2.1.1 / [PR #343](https://github.com/gobha-me/ai-editor/pull/343))*. New `buildEditProposalCard` helper in [`js/chat/messages.js`](../js/chat/messages.js) renders a `tool-call`-styled card mirroring the existing `addToolCallMessage` chrome, with a full unified diff when path + originalContent are present; falls back to a `<pre>` proposed-code render when there's no baseline. Three rendering tiers cover the path / no-baseline / null-pendingEdit cases. See [CHANGELOG §2.1.1](../CHANGELOG.md). The `detectIntent` *"change"-keyword false-positive* that funneled commit-and-PR prompts into the legacy edit path stays a separate latent bug; flagged for a follow-up.
- ~~**github#27 Phase 1 — `Curated MCP server catalog`**~~ *(✅ Phase 1 closed — shipped 2.3.0)*. See [CHANGELOG §2.3.0](../CHANGELOG.md). Phase 2 (settings UI for discovery + per-server config) remains open above.
- ~~**github#25 — `Plan Mode — read-only planning phase with approval gate`**~~ *(✅ closed — shipped 1.10.0 / [PR #316](https://github.com/gobha-me/ai-editor/pull/316))*. Read-only planning phase layered on top of the `pendingUserResponse` seam introduced for `ask_user` (1.9.0): tool catalog filter via `ToolDefinition.readOnly` + `ToolRegistry.filterReadOnly`, a `submit_plan_for_approval` tool that pauses the loop, an inline plan-approval card mirroring the ask-user-card lifecycle, a Plan Mode chip + system-prompt addendum that drops out automatically on approval. Optional `autoPlanOnIssueStart` setting wires Plan Mode on at session start. See [CHANGELOG.md](../CHANGELOG.md) §1.10.0.
- ~~**gitea#188 — `[storage] cost-daily graph data lost after refresh`**~~ *(✅ closed at 1.6.7)*. `KeyMutex` adoption in [`js/intelligence/cost/cost-store.js`](../js/intelligence/cost/cost-store.js) — `recordTurn` now serializes its read-modify-write per storage key. See [CHANGELOG.md](../CHANGELOG.md) §1.6.7.
- ~~**github#23 — `Bug: Disabling an MCP plugin should remove its tools from listings and notify the LLM`**~~ *(✅ closed — shipped 1.6.10)*. Diff-based state messages, `tools:unregistered` event for embeddings cache eviction, actionable error string. See [CHANGELOG.md](../CHANGELOG.md) §1.6.10. Investigation found most of the issue's stated concerns were already structurally correct (registry cleanup is complete, system prompt rebuilds per-turn) — the real gaps were the silent toggle, the embeddings cache leak, and the unhelpful error.
- ~~**github#20 — `Feature: Add git log tool`**~~ *(✅ closed — shipped PR #278)*. `git_log` bundled with the git-tool-wrappers wishlist items.
- ~~**github#30 — `[storage] cost-daily graph data lost after refresh`**~~ *(✅ closed — fixed in 1.6.7 / PR #280)*. Same `KeyMutex` cure as gitea#188.
- ~~**github#31 — `Duplicate tool definitions in role settings`**~~ *(✅ closed — shipped 1.6.8)*. `register()` now splices the old entry before pushing; dedup mirrors `unregister()`.
- ~~**github#32 — `Should git_log be available to all roles?`**~~ *(✅ closed — shipped 1.6.8)*. Changed to `roles: 'all'`; read-only, no side effects.
- ~~**github#29 — `Retrieval discoverability + edit_file fragility (post-mortem of PR #278)`**~~ *(✅ closed — shipped 1.6.11 / PR #293)*. The three sized levers landed: `find_relevant_files` indexer-readiness gate (`indexer_not_ready` envelope + soft budget), `edit_file` post-edit context widened from 3/3 to 5/5 with a `_getStaleWindow` on STALE LINE NUMBERS errors, and `MUTATING_TOOLS` cache-hit messaging. See [CHANGELOG.md](../CHANGELOG.md) §1.6.11 and [PR #293](https://github.com/gobha-me/ai-editor/pull/293).
- ~~**github#21 — `MCP role-based tool access`**~~ *(✅ closed — shipped via PR #289)*. Three-part proposed solution landed: per-server roles in MCP settings; backward-compatible default of `'all'` when no roles set; integration through the role-based access path. Bundled into 1.6.11.
- ~~**github#37 Phase 1 — `Design: project-conventions file (CLAUDE.md analogue)`**~~ *(✅ Phase 1 closed — shipped 1.6.13)*. Repo-root `CLAUDE.md` autoloads on `git:projectLoaded` into `State.projectConventions` and renders as a `<PROJECT_CONVENTIONS>` block in the editor system prompt — committed by the project maintainer and therefore trusted (NOT wrapped in `<UNTRUSTED_*>`). See [CHANGELOG.md](../CHANGELOG.md) §1.6.13. **Phase 2 still open** — re-scoped from real dogfood signal, not speculation. The eight deferred design questions: (a) location (repo-root vs `.aieditor/conventions.md` vs `docs/CONVENTIONS.md`), (b) loading lifecycle (session-start vs every-turn vs lazy), (c) role interaction (per-role sections vs undifferentiated), (d) memory-subsystem boundary (project-memory vs user-memory line), (e) project-switch behavior (active-project vs branch-scoped), (f) versioning (active branch vs local checkout; mid-session branch switch), (g) length cap / compression integration, (h) system-prompt enumeration parity (per `feedback_prompts_js_parallel_enumeration.md`), (i) empty-state UX. Trigger: dogfood signal — do conventions stay short and uncontroversial (Phase 1 is the whole answer), or does friction surface around any of these knobs?
- ~~**github#26 — `Feature: TodoRead/TodoWrite tools for persistent task tracking`**~~ *(✅ closed — shipped 1.8.0)*. Structured per-conversation task list re-injected into the system prompt every turn (same survival mechanism as scratchpad); shape mirrors Claude Code's TodoWrite. Conversation-scoped persistence via the existing `conv-{id}` payload — no new storage keys. UI panel from the issue's open-questions block stays deferred (read-only first cut against the system prompt is enough to learn whether the structured-anchor hypothesis holds). See [CHANGELOG.md](../CHANGELOG.md) §1.8.0.
- ~~**gitea#301 — `[chat] edit_file ↔ read-cache cross-request deadlock`**~~ *(✅ closed — shipped 1.7.1 / PR #302)*. Cross-request dup cache (`State.toolActionLog`) now invalidates on file mutation, breaking the `STALE LINE NUMBERS` ↔ `_cached: true` deadlock. Logic refactored into `js/chat/cache-invalidation.js` for testability. See [CHANGELOG.md](../CHANGELOG.md) §1.7.1.
- ~~**github#34 — `Feature: Scratchpad visibility panel — real-time user view of LLM notes`**~~ *(✅ closed — shipped 1.8.4)*. New `EventBus('scratchpad:changed')` channel emitted from [`js/tools/scratchpad-tools.js`](../js/tools/scratchpad-tools.js); collapsed-by-default Notes tray inside `.chat-input-area` reads `State.scratchpad` reactively. Read-only scope; editing deferred (issue's "user-editable?" question stays open — conflict resolution unsolved). Lifecycle wrapper [`js/chat/scratchpad-panel.js`](../js/chat/scratchpad-panel.js) mirrors the Memory-tab precedent. See [CHANGELOG.md](../CHANGELOG.md) §1.8.4.
- ~~**github#33 — `Feature: Structured question tool (ask_user) + queued user input during long runs`**~~ *(✅ closed — Phase 1 shipped 1.9.0 / [PR #312](https://github.com/gobha-me/ai-editor/pull/312); Phase 2 shipped 1.9.1 / [PR #313](https://github.com/gobha-me/ai-editor/pull/313))*. **Phase 1** added the `ask_user` tool: an inline question card pauses the tool loop and supports single-select / multi-select / free-text answer types, landing replies via a new `pendingUserResponse` chat-state seam in [`js/chat/state.js`](../js/chat/state.js). **Phase 2** added a module-level `pendingMessageQueue` (FIFO, `MAX_QUEUE = 5`, oldest-dropped on overflow) drained inside [`js/chat/handlers.js`](../js/chat/handlers.js) *before* the forward-progress check (so a stalling model can't be killed before it sees the queued user input); the queued-input panel ([`js/chat/queued-input-panel.js`](../js/chat/queued-input-panel.js)) mirrors the scratchpad-panel lifecycle and joins the Decision §9 Preact + htm allow-list; the textarea is no longer disabled during generation; cancellation preserves the queue. Validated by [`docs/dogfood-battery/2026-05-07-queued-input-qwen-html-games.md`](dogfood-battery/2026-05-07-queued-input-qwen-html-games.md). See [CHANGELOG.md](../CHANGELOG.md) §1.9.0 and §1.9.1.

---

## Decisions

Resolved from discussion. Load-bearing — implementations honor them.

1. **Memory storage is two-tier.** Browser cache default (per-tab); repo-committed `.aieditor/memory/*.md` opt-in per workspace. Toggle in Settings → Memory.
2. **Roles get replaced by the profile picker at 2.0.** No dual-surface; one selector. Migration script translates stored `role` to a profile preset.
3. **Compression diagnostics surface as a public status-bar pill** (e.g., "📉 60% kept"), not just debug-mode. Full eviction trace stays in the LLM debug modal for power users.
4. **Memory files auto-stage on commit when repo mode is opt-in AND the current branch isn't protected.** On protected branches, the memory diff surfaces in the commit modal as an unstageable warning.
5. **Tool budget defaults to 5000 tokens** (per design), exposed as a tunable in Settings → Tools.
6. **Branching: per-PR feature branches off `main`. Squash + delete on merge.** No long-lived track branches.
7. **Removability is an explicit checkpoint, not a vibe.** Every Phase-1 milestone carries a Removability check in its exit criteria. If "subsystem removed → no user-visible degradation," the next minor is gated on closing that gap.
8. **Measurement before scale.** Cost dashboard shipped at 1.2.1 with cross-provider, per-conversation, and per-tool breakdowns ([`js/settings/cost-tab.js`](../js/settings/cost-tab.js)); the export affordance to make it useful for offline analysis is the open gap (see Compression bucket).
9. **Preact + `htm` allowed for new state-heavy surfaces from 1.3.0; vanilla everywhere else through 2.0.** Existing tabs / sidebar / file tree / editor frame / chat stay vanilla forever; no migration. Bigger uniform-UI consolidation is a 2.0 → 3.0 arc.
10. **claude.ai/design engages on a three-touch model.** Touches 1 + 2 shipped (Memory UX → 1.3.0; whole-app facelift → 1.3.5–1.3.13); deliverables at `docs/design/touch-{1,2}-*/`. Touch 3 (left pane + window architecture, received 2026-05-07) → Rail v2, PR Review surface, Merge Conflict Resolver, Window v2 / Sessions; deliverable at `docs/design/touch-3-left-pane-and-window/`; **dominantly post-2.0** per the design transcript and the Sessions ↔ profile-contract dependency. Code-session ↔ design-session backfeed runs through [`docs/design/OPEN-QUESTIONS.md`](design/OPEN-QUESTIONS.md): implementers append open questions, Jeff routes them to claude.ai/design with screenshots, answers land as addendum / new chat transcripts in the relevant touch directory.
11. **Two-view configuration for every settings panel.** Preset view (intent) + advanced view (parameters), reachable via the same toggle name and position in every panel. Editing in advanced flips the preset selector to "Custom"; switching back to a named preset snaps every knob to that preset's defaults. **No separate "Developer mode" sections.** Full contract in `docs/DESIGN-profiles.md` §"Two-View Configuration."
12. **Release-readiness gate (2026-05-04).** Release tag pushes (not merges to main) require a passing 10-turn dogfood in this repo. Patches inside an active track stay untagged until the next minor closes the bundle. See §"Cadence and versioning" for full criteria.
13. **Paper-only planning sessions are scheduled, not ad-hoc.** When the path forward grows vague — sessions answer roadmap questions with "n-z more changes" instead of pinned slices, or the same question gets re-asked across sessions — a **docs-only re-layout pass** holds the active queue before any implementation continues. Output: an updated ROADMAP section with pinned version slices, a verification footing, and a sizing call-out. No code is written in a planning session. The trigger is *"reader asks 'what's next' and gets a shoulder shrug"* — that's the signal, not a calendar interval. Re-run as often as needed; the lift is small (one docs PR), the cost of skipping is the kind of rediscovery that produced this Decision in the first place. **First applied 2026-05-08** in the path-to-2.0.0 re-layout (§"2.X path").

---

## What's out of scope for the 1.x → 2.0 arc

- **Multi-modal context.** Image/audio chunks. Vision models work for images today (paste-to-chat); structured handling is a 3.x topic.
- **Cross-process / distributed state.** Stays single-process. No sync server, no multi-tab live coordination beyond the existing tab-isolation model.
- **Real-time collaborative editing.** Two users editing the same file simultaneously. Not a context problem; not in scope.
- **Plugin marketplace.** Defer to 2.x after the profile contract stabilizes.
- **Markdown-as-source AST chunking.** Phase 1 code chunker is regex-based; tree-sitter-grade is gated on measured need.
- **Custom embedding model fine-tuning.** Use the user's chosen provider.
- **Cross-project task ledger.** Task ledgers stay session-scoped. Continuity goes through memory with consent.

---

## What this roadmap commits to

- **Now / Next / Later** at the top — the doc's first job is to answer *what's being worked on, what's queued, what's not*.
- **Admissibility, not accumulation** as the architectural principle every PR is reviewed against.
- **Git-native memory and session state** as the externally-tellable story.
- **Measurement before scale.** Cost dashboard is gating infrastructure; tracks that nominally depend on it stay deferred until it ships.
- **Removability discipline.** Every Phase-1 milestone exit criteria asks: with this subsystem removed, what user-visible behavior degrades?
- **No major version bumps** until profiles become the load-bearing configuration surface — *and* the contract is sized to what ai-editor actually uses.
- **The DESIGN docs are the contract.** When implementation diverges from a DESIGN doc, the doc updates first, then the code.
- **Honest deferrals.** Multi-modal, collaboration, marketplace are not on this roadmap.
- **Shipped work goes in [CHANGELOG.md](../CHANGELOG.md), not here.** This doc describes where we're going. The changelog is the authoritative running history.

Push back on any of this. The roadmap is a hypothesis. The first track that drifts more than two weeks past its target gets the next milestone re-scoped, not the deadline pushed.
