# AI Editor — Roadmap

> Last updated: 2026-05-02 · Current released version: **1.4.16** · Authoring branch: `claude/jolly-volhard-998f9f`

## How to read this doc

- **Now / Next / Later** — where we are at a glance.
- **Active track** — the in-flight work, sized to PRs.
- **Later (sequenced)** — the next two committed tracks (Retrieval, Profiles → 2.0).
- **Deferred / unscheduled** — work that was planned, designed, or partially started but isn't currently scheduled. Some items are paused awaiting metrics; some may be obsolete. Triage owed.
- Shipped releases live in [CHANGELOG.md](../CHANGELOG.md), not here.

## Now / Next / Later

| Phase | Track | Status |
|---|---|---|
| **Now** | Retrieval chunker stream complete (1.4.9 foundation ✓ → 1.4.10 ProseChunker ✓ → 1.4.11 CodeChunker ✓ → 1.4.12 ConversationChunker ✓ → 1.4.13 StructuredChunker ✓), StructureExtractor in (1.4.14 ✓), Semantic strategy in (1.4.15 ✓), and Structural strategy in (1.4.16 ✓) — Phase 1 (1.5.0) is the promotion milestone | Tools track fully shipped through 1.4.8 (Phase 1 at 1.4.0 with 79.5% token reduction live; 1.4.1 semantic `find_tool` ✓, 1.4.2 MCP bridge ✓, 1.4.4 workspace-scoped settings ✓, 1.4.5 test-driven loop ✓, 1.4.6 scan-driven CI logs ✓, 1.4.7 ghost text ✓, 1.4.8 tuning + LRU eviction ✓). 1.4.9 ✓ shipped the Retrieval data foundation (ChunkRef contract + ChunkID hash + module scaffolding); 1.4.10 ✓ added ProseChunker and pinned the `Chunk`/`Chunker`/`ChunkerInput` contract; 1.4.11 ✓ added CodeChunker (Phase 1 heuristic regex for JS/TS/Python; AST deferred to 1.5.5); 1.4.12 ✓ added ConversationChunker (1 turn = 1 chunk over a JSON-serialized HistoryTurn[]); 1.4.13 ✓ added StructuredChunker (per-record over JSON arrays/objects + JSONL; CSV/YAML/TOML deferred); 1.4.14 ✓ added StructureExtractor (post-chunker pass populating `metadata.structural` for prose heading hierarchy + code declaration-kind labeling — pure `(chunks) → chunks`, no runtime wire-up); 1.4.15 ✓ added the Semantic strategy (hybrid k-NN + BM25 + RRF wrapping the shipped 1.1.2 embedder, with the chunk-level vector store as an injected callback until ingest lands); 1.4.16 ✓ adds the Structural strategy (ancestor-walk over `parent_id` metadata, delegating embed → k-NN to a caller-supplied semantic step, with `getChunkByID` as the second injected seam until the ingest PR lands). With Phase-1 chunkers in (`spec` deferred past Phase 1), the structural pass landed, and both Phase-1 strategies in, only the Composer + ledger consumer + migration remain. |
| **Next** | Retrieval Phase 1 (1.5.0) — Composer (PR 9), ledger consumer, migration off `js/context-manager.js` | Designed; chunkers + StructureExtractor + both Phase-1 strategies are in. Promotion to 1.5.0 lands when legacy-vs-new agreement on test queries clears 80%. |
| **Later** | Profiles → 2.0 | Designed; not started. |
| **Deferred** | Foundations (was 1.1.x), Compression (was 1.2.x), various UI items | See *Deferred / unscheduled* — triage owed. |

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

**Branching.** Main is protected. Every change goes through a PR from a topic branch. Gitea CI runs security lint + Docker build on every PR; tag push deploys to production. PR title convention: `feat(track):`, `fix(area):`, `chore(release):`, `docs(...)`. Squash + delete on merge.

**No "preview" or "beta" channels** in 1.x. The `:dev` Docker tag for PRs and `:test` for `main` provide preview environments.

---

## What's in production today (1.4.8)

- **Tools 1.4.7–1.4.8 follow-ups** — ghost text (1.4.7) plus the LRU eviction safety-net + Settings → Tools tuning surface (1.4.8) close the 1.4.x in-track sequence.
- **Editor / Git / providers** — CodeMirror 6, 19 languages, multi-tab, diff/blame/preview; 4 Git providers (Gitea/GitHub/GitLab/in-memory zip); 4 LLM providers (Venice, OpenRouter, Ollama, generic OpenAI).
- **Memory subsystem (1.3.0–1.3.3)** — persistent `user` + `workspace` scopes, hybrid IDB + `.aieditor/memory/*.md` storage, 3 LLM tools (`memory_remember`/`memory_recall`/`memory_revise`), Settings → Memory tab, `@memory` chip, agent-proposal consent flow, cross-device session sync, session replay viewer.
- **Touch 2 facelift (1.3.5–1.3.13)** — frozen `--tk-*` token vocabulary, top-bar restructure, Settings sidebar, Connections panel, Debug + Help slide-outs, Lucide icon family, self-hosted woff2 fonts, rem-based UI scaling.
- **Tools subsystem (1.3.4 / 1.3.14–1.3.17 / 1.4.0, Phase 1 shipped)** — `ToolDef`/`ToolID`/`Catalog` foundation, Composer admission with `?toolsCompose=off` kill-switch, system-prompt admission alignment, meta-tools (`list_tool_categories`/`list_tools_by_category`/`find_tool`), sticky admission via `TaskLedger.tool_admissions[]`/`tool_invocations[]` in `js/chat/task-state.js`, cost-recorder wiring persisting per-turn admitted/baseline/unfiltered tool-definition tokens with the reduction percentage rendered in the LLM Debug modal. **79.5% token reduction observed live** on a coder session in the html-games repo against the role-filter baseline (target: ≥70%).
- **Tools 1.4.x follow-ups (1.4.1 / 1.4.2 / 1.4.4 / 1.4.5 shipped)** — semantic `find_tool` + lazy schema expansion (1.4.1); MCP bridge plugin (`Plugins.registerMCPServer`, 1.4.2); workspace-scoped settings (`.aieditor/settings.json` overrides, 1.4.4); **test-driven loop (1.4.5)** — bounded agentic CI iterator with three new LLM tools (`get_ci_status` / `wait_for_ci` / `get_ci_logs`), in-chat progress card, abort, Settings → Test Loop bounds. Ghost text + lazy-expansion tuning remain (1.4.6).
- **Plugins / security / tab isolation** — manifest registration, lifecycle hooks, modal/button/CSS injection; 1.0.4 hardening pass; multi-tab Storage scoping (since 0.9.40).

## What drifted from the original sequence

The original 1.x → 2.0 plan was **Foundations → Compression → Memory → Tools → Retrieval → Profiles**. What actually shipped:

- **Memory jumped first** (1.3.0–1.3.3) — Touch 1 design landed and the Git-native story was the externally-tellable feature; took priority over compression.
- **Touch 2 facelift inserted** (1.3.5–1.3.13) — whole-app refresh dropped into the 1.3.x slot once the deliverable arrived.
- **Tools shipped via 1.3.x patches → 1.4.0 promotion.** The §1.4.0 milestone label survived while the work flowed as in-track patches (1.3.4 + 1.3.14–1.3.17). Promotion to 1.4.0 landed when the 70%-token-reduction exit criterion measured 79.5% live on a coder session.
- **Foundations (1.1.x) and Compression (1.2.x) skipped.** Several feature branches exist (`feat/1.1.0-*`, `feat/1.1.1-*`, `feat/1.1.2-*`, `feat/1.1.3-*`, `feat/1.2.0-*`, `feat/1.2.x-*`); current status of each item is unclear and needs triage. See *Deferred / unscheduled* below.

Practical consequence: roadmap entries that referenced "the unified `TaskLedger` from 1.1.0" or "the cost dashboard from 1.2.1" are talking about infrastructure that didn't ship as Foundations. The Tools track built its own ledger anyway — `TaskLedger.tool_admissions[]` / `tool_invocations[]` landed in `js/chat/task-state.js` as part of 1.3.17, scoped to tool admissions. Retrieval / Profiles entries that wanted to extend the same struct (chunk admissions, profile-resolved task ledger) now plug into the shipped one rather than waiting on a Foundations item. The cost dashboard remains deferred and still gates the compression track.

---

## Active track: Tools (Phase 1 shipped at 1.4.0 → 1.4.x follow-ups)

Tools Phase 1 shipped at **1.4.0** with the 79.5%-token-reduction observation closing the §1.4.0 exit criterion. 1.4.x follow-ups are sized but not started.

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

- **1.4.1:** ✅ **Shipped.** Semantic `find_tool` + lazy expansion (k-NN over tool embeddings, threshold-gated; admit short form on discovery, full schema on first call).
- **1.4.2:** ✅ **Shipped.** MCP bridge plugin — `Plugins.registerMCPServer({ url, auth, transport })` translates MCP JSON-RPC tool definitions into the `ToolDef` shape so they enter the catalog under the new admission rules.
- **1.4.3:** *(slipped — slot consumed by the test-runner IMPORT FAILED hot-fix; planned scope re-sequenced below to 1.4.5).*
- **1.4.4:** ✅ **Shipped.** Workspace-scoped settings — `.aieditor/settings.json` overrides a curated safelist of keys per-repo, with auto-stage on unprotected branches and a "reset to global" affordance.
- **1.4.5:** ✅ **Shipped.** Test-driven loop — bounded agentic CI iterator. Three new LLM tools (`get_ci_status` / `wait_for_ci` / `get_ci_logs`) plus a chat-input "🔁 Loop" trigger that drives "edit → commit → wait CI → read failure log → loop" under user-tunable bounds (iterations, wall-clock, tokens/iter, CI poll). Reuses the 1.1.1 idle-timeout for the wait-for-CI step. Per-iteration records flow through the unified `TaskLedger.loop_iterations[]` (third consumer of the same struct). Roadmap originally sequenced this as 1.4.3.
- **1.4.6:** ✅ **Shipped.** Scan-driven CI logs. `get_ci_logs` downloads the full job log into a virtual in-memory cache under `.aieditor/ci-cache/<runId>-<jobId>-<slug>.log` and returns the path; the model uses regular file tools (`read_file` / `read_lines` / `scan_file`) to inspect it. Single chokepoint hook in `Git.getFile()`; cache evicts on `loop:finished` with a 5-entry LRU + 10MB-per-entry backstop. Replaces the old fixed-size tail (which silently lost top-of-log failures).
- **1.4.7:** ✅ **Shipped.** Inline AI suggestions (ghost text, hotkey-only). Pressing a hotkey (default: `Tab`, configurable) requests a single completion at the cursor — never automatic, no idle polling. Renders as CodeMirror 6 decoration; `Tab` accepts, `Esc` dismisses. Throttled (one in-flight at a time). The cost-control framing is intentional — automatic ghost text is a Cursor-style cost trap; hotkey-triggered respects the user's intent.
- **1.4.8:** ✅ **Shipped.** Lazy expansion threshold tuning + LRU eviction safety net. The Composer now drops the longest-unused non-static admitted entries when `tokens_used > budget_tokens` after sticky packing (LRU keyed on `task_ledger.tool_admissions[i].last_used_at`); static is privileged and never evicted, per `docs/DESIGN-tools.md` §"Static is privileged." `evicted_count` / `tokens_evicted` surface in `ToolDiagnostics` and the LLM Debug modal. Settings → Tools tab exposes `findToolThreshold` / `findToolTopK` / `discoveryAdmissionCap` under the `State.settings.tools.*` subtree (workspace-overridable via the 1.4.4 safelist); the legacy flat `State.settings.findToolThreshold` is honored as fallback. Closes the planned 1.4.x Tools follow-ups; the 1.4.9 Retrieval foundation patch follows in this same minor.
- **1.4.9:** ✅ **Shipped.** Retrieval foundation — `ChunkRef` contract + deterministic `ChunkID` hash + module scaffolding under `js/intelligence/retrieval/`. Mirrors the 1.3.4 tools-foundation precedent: typedefs and the FNV-1a-twice ID hash ship in isolation so the seam is reviewable without implementation noise. The barrel exposes a placeholder `compose()` that throws `"not implemented"` to fail loudly on accidental wire-up. No runtime change: `find_relevant_files`, indexing, embedding, and Tools all behave identically. The `task_ledger.admissions[]` / `exclusions[]` slots scaffolded in 1.1.0 stay empty until the Composer lands; the `ChunkID` typedef in `js/profiles/task-ledger.js` now cross-references the canonical contract. Subsequent PRs (chunkers, semantic + structural strategies, Composer, ledger consumer, `context-manager.js` migration) sequence toward the 1.5.0 promotion when legacy-vs-new agreement on test queries clears 80%.

- **1.4.10:** ✅ **Shipped.** Retrieval Phase 1 — **ProseChunker** (PR 2 of 1.5.0). First chunker on the 1.4.9 foundation. Implements the prose row of `docs/DESIGN-retrieval.md` §"Chunker": paragraph + heading boundaries, 800-1200 char target with 100-char overlap, deterministic split-at-sentence-boundary fallback for oversized blocks, surrogate-safe slicing, UTF-8 byte ranges for ChunkID identity. Pure `(input) → Chunk[]` function; no I/O, no async. Pins the chunker-side typedefs (`Chunk`, `ChunkerInput`, `Chunker`) every follow-up chunker reuses. Why prose first rather than code: prose pins the chunker contract + overlap mechanics + ChunkID stability under review *before* the language-aware regex work in CodeChunker (the design doc's §"On code chunking specifically" warns about its difficulty). No runtime change — the Composer placeholder still throws and nothing outside the test suite imports `chunkProse`. Removability holds (Decision §7).

- **1.4.11:** ✅ **Shipped.** Retrieval Phase 1 — **CodeChunker** (PR 3 of 1.5.0). Second chunker on the 1.4.9 foundation. Implements the code row of `docs/DESIGN-retrieval.md` §"Chunker": top-level declaration boundaries with **no overlap** (per-construct), language-aware regex heuristic for JS/TS/Python per the honest commitment in §"On code chunking specifically" (AST-based chunking deferred to 1.5.5 gated on a measured quality gap). JS/TS boundaries: `function` / `class` / `abstract class` / top-level `const`/`let`/`var` / `type` / `interface` / `enum` / `import` / `export {…}` / `export *` / `export default …`. Python boundaries: `def` / `async def` / `class` / `import` / `from … import …`, with **decorators (`@…`) attaching to their following def/class**. Consecutive imports coalesce into a single boundary (the design's "import blocks"). Adjacent ranges with no overlap (`chunks[i+1].byte_range[0] === chunks[i].byte_range[1]`); leading shebang / file-prefix comments ride with the first chunk. Hard-cut safety valve at next newline past `MAX_CONSTRUCT_CHARS = 8000` so a single huge generated construct still terminates. Unknown extensions degenerate to a single chunk per file. Surrogate-safe slicing + UTF-8 byte ranges reuse the patterns from ProseChunker. ChunkID under `CHUNKER_VERSION.code` (the registry's `'v1'` slot from 1.4.9 goes live). No runtime change — the Composer placeholder still throws and nothing outside the test suite imports `chunkCode`. Removability holds (Decision §7).

- **1.4.12:** ✅ **Shipped.** Retrieval Phase 1 — **ConversationChunker** (PR 4 of 1.5.0). Third chunker on the 1.4.9 foundation. Implements the conversation row of `docs/DESIGN-retrieval.md` §"Chunker": **1 turn = 1 chunk, never split, no overlap.** Input format: `ChunkerInput.bytes` carries a JSON-serialized `HistoryTurn[]`; the chunker parses, validates per-turn `role`+`content` invariants, and emits one Chunk per turn. The contract's `bytes: string` shape is preserved — no per-content-type discriminated union sprawl. Per-chunk `metadata.custom` carries `role`, `turn_index`, plus any non-(role|content) top-level fields and any `turn.metadata` sub-object keys (HistoryTurn shape) — the chunker preserves, never invents. Input-level `metadata.custom` takes precedence on key conflict (loader tagging > turn payload). Byte-range semantics: ranges are computed over the concatenation of canonical per-turn serializations (`JSON.stringify(turn_i)`), not over `input.bytes`, so ChunkIDs stay stable across compact-vs-pretty JSON envelopes. Adjacency holds: `chunks[i+1].byte_range[0] === chunks[i].byte_range[1]`. ChunkID under `CHUNKER_VERSION.conversation` (the registry's `'v1'` slot from 1.4.9 goes live). No runtime change — the Composer placeholder still throws and nothing outside the test suite imports `chunkConversation`. Removability holds (Decision §7).

- **1.4.13:** ✅ **Shipped.** Retrieval Phase 1 — **StructuredChunker** (PR 5 of 1.5.0). Fourth and final Phase-1 chunker on the 1.4.9 foundation. Implements the structured row of `docs/DESIGN-retrieval.md` §"Chunker": **per record over top-level keys / array elements.** Scope decision (resolved ahead of code): v1 covers **JSON + JSONL** (a.k.a. NDJSON); CSV / YAML / TOML deferred until a real consumer asks; **top-level only** for nested-record granularity (deeper expansion belongs to StructureExtractor, not the chunker). Sub-format dispatch via `metadata.custom.format` (`'json'` | `'jsonl'` explicit override) or `metadata.source_uri` extension (`.json` / `.jsonl` / `.ndjson`); unknown / missing → `TypeError`. JSON arrays produce one chunk per element (`record_index`); JSON objects one chunk per key/value pair in `Object.keys()` order with canonical `{[k]: v}` bytes (`record_key` + `record_index`); JSONL one chunk per non-blank line (parse failure on any line rejects the whole input — no partial success). Top-level scalars rejected; empty containers return `[]`. Byte-range semantics mirror Conversation: ranges over the concat of canonical per-record `JSON.stringify`s, not over `input.bytes`, so ChunkIDs stay stable across compact-vs-pretty envelopes and JSONL whitespace variations. ChunkID under `CHUNKER_VERSION.structured` (the registry's `'v1'` slot from 1.4.9 goes live). No runtime change — the Composer placeholder still throws and nothing outside the test suite imports `chunkStructured`. Removability holds (Decision §7). With this PR the Phase 1 chunker stream is complete; 1.5.0 picks up StructureExtractor + strategies + Composer next.

- **1.4.14:** ✅ **Shipped.** Retrieval Phase 1 — **StructureExtractor** (PR 6 of 1.5.0). Sixth PR in the 1.5.0 stream and the first non-chunker piece. Implements `docs/DESIGN-retrieval.md` §"StructureExtractor": a pure post-chunker pass that populates `Chunk.metadata.structural` for content types with meaningful hierarchy. Pure function — `(chunks: Chunk[]) → Chunk[]`, no I/O, no async, returns fresh chunks (input never mutated). Mixed `content_type` in a single batch → `TypeError`. Empty input returns the input unchanged. Dispatch by `content_type`: **prose** walks markdown heading levels (`#`/`##`/`###`...) to build `parent_id` chains + `heading_path` + `node_kind: "section"` + `sibling_order`, with continuation chunks (no leading heading of their own) inheriting the most-recent heading-bearing chunk's metadata; documents with no headings pass through unchanged (`structural` stays null, per the design's "with heading structure" qualifier). **code** does declaration-kind labeling — first non-blank, non-decorator line of each chunk maps to a `node_kind` (`function` for JS/TS function + Python def/async def, `class`, `variable` for const/let/var, `type` for type/interface/enum, `import`, `export` for `export {…}` / `export *`); exported functions still label as `"function"` so the JS/TS function surface is one bucket; code for unknown extensions degrades to generic `"code"`. CodeChunker Phase 1 emits flat top-level declarations, so `parent_id = null`, `heading_path = []`, `sibling_order = chunk index` — the Structural strategy ancestor-walk is a no-op for code in Phase 1 (gains power either at 1.5.5 AST chunking or when the extractor learns to nest function-inside-class). **conversation / structured / spec** pass through unchanged. Overlap-noise suppression for prose: the prose chunker's 100-char overlap can pull earlier chunks' headings forward into chunk N's content (especially when prior chunks were shorter than 100 chars — the leak chains across multiple short chunks); for each chunk the extractor walks every heading candidate and picks the first one whose `(level, text)` hasn't already been emitted in the batch. Known limitation: two genuinely-identical sibling headings collapse to the first; the cost dashboard will surface if it matters. JS/TS / Python boundary regexes deliberately duplicate the patterns from `code-chunker.js`'s `matchJsBoundary` / `matchPyBoundary` rather than importing — a chunker tweak shouldn't silently shift the extractor's labeling. No runtime wire-up: nothing imports `extractStructure` outside the test suite yet, the Composer placeholder still throws, `find_relevant_files` / indexing / embedding / Tools all behave identically. Removability holds (Decision §7).

- **1.4.16:** ✅ **Shipped.** Retrieval Phase 1 — **Structural strategy** (PR 8 of 1.5.0). Eighth PR in the 1.5.0 stream and the second retrieval *strategy* — implements `docs/DESIGN-retrieval.md` §"Structural (Phase 1: ancestor-walk)": candidate semantic chunks → walk one step up to immediate parent if parent fits per-chunk budget → dedup by ChunkID → return top `quota`. Factory `createStructuralStrategy({ runSemanticRetrieve, getChunkByID })` returns a `Strategy`-shaped `{ name: "structural", applies_to, retrieve }`. **Algorithm interpretation:** "smallest fitting ancestor" read literally → one step up to immediate parent; if the parent fits, return it, else no larger ancestor will either (ancestors only get bigger), return original chunk. Multi-step climbing for the worked example's "fragment → function → class" case is gated on richer code chunking (deferred to 1.5.5). For Phase 1 prose, paragraph fragments expand to their heading-bearing parent chunk; for Phase 1 code, `extractCode` emits flat top-level declarations with `parent_id = null`, so structural is a **no-op for code in Phase 1** (chunks pass through with semantic provenance preserved). **DI mirrors Semantic (1.4.15).** Two required deps: `runSemanticRetrieve(req, k)` is the caller-supplied semantic step, delegated entirely so the strategy doesn't reinvent embed/k-NN logic — production callers wire `(req, k) => createSemanticStrategy({...}).retrieve(req, k)` at the Composer call site (PR 9), tests inject deterministic fakes; `getChunkByID(id)` resolves a chunk by ID for the parent lookup, real impl lands with the chunk-store ingest PR. Per-chunk budget = `(total - system - output - history) / quota`, floored; non-positive disables expansion (semantic candidates pass through). Headroom: `k = quota * 3` (mirrors Semantic's k-NN headroom). **Provenance for expanded chunks:** `retrieved_by: "structural"` / `score_kind: "structural_expanded"` / `score` carried from the original semantic candidate / `byte_range` + `line_range` + `source_uri` from the parent. **Provenance for non-expanded (degraded) chunks:** preserved verbatim from the semantic candidate (per design's graceful-degrade rule). **`applies_to(req)`** returns score 0 when `query` is null/empty/whitespace, score 0.8 otherwise (the design's full ">20% structural-meta corpus" gate is router-level, deferred to PR 9 — same simplification Semantic took). **Failure modes match the design:** structural=null / parent_id=null / stale parent ref (`getChunkByID` returns null) / `parent.tokens > perChunkBudget` all leave the candidate unchanged; `quota ≤ 0` / empty collections / empty query / empty semantic result all return `[]`. No runtime wire-up: nothing imports `createStructuralStrategy` outside the test suite, the Composer placeholder still throws, `find_relevant_files` keeps running through the legacy file-level path. Removability holds (Decision §7); the migration of `find_relevant_files` to the new Composer lands with 1.5.2.

- **1.4.15:** ✅ **Shipped.** Retrieval Phase 1 — **Semantic strategy** (PR 7 of 1.5.0). Seventh PR in the 1.5.0 stream and the first retrieval *strategy* — a first concrete consumer of the `Strategy` typedef pinned at 1.4.9. Implements `docs/DESIGN-retrieval.md` §"Semantic (Phase 1)": embed query → k-NN (k = quota × 3) → optional BM25 over the candidate set → reciprocal rank fusion (textbook RRF, K = 60) → metadata filter → top `quota`. Factory `createSemanticStrategy({ embedQuery, chunkVectorSearch, getBM25Index? })` returns a `Strategy`-shaped `{ name: "semantic", applies_to, retrieve }`. **Wraps the shipped 1.1.2 embedder, doesn't reinvent embedding** — the editor has had `EmbeddingsClient.embed()` for four releases; what's new is **chunk-level** retrieval that pairs with the chunkers landed in 1.4.10–1.4.13 (today's `find_relevant_files` runs file-level via `js/context-manager.js`, untouched until the migration PR). To keep the strategy a pure function of injected deps and node-test-safe (the embedder pulls in browser-only `core.js`), `embedQuery` is a required factory parameter rather than a default-import — production callers wire `(text) => EmbeddingsClient.embed(text)` at the Composer call site (PR 9). The chunk-level vector store stays an injected seam (`chunkVectorSearch`) too, since chunk ingest hasn't shipped — the strategy is "given a query embedding and a way to k-NN over chunks, do RRF fusion and metadata filtering correctly." **Three algorithm paths, score_kind-labeled** so the design's "scores aren't comparable across kinds" rule stays honest: `"cosine"` (no BM25 index supplied), `"hybrid"` (k-NN candidates re-scored against BM25 + RRF-fused; BM25 only sees `quota × 3` chunks per call, not the corpus), `"bm25"` (fallback when embedder returns null *or* query < 3 tokens; iterates the index's full chunk corpus). BM25 math (`tokenizeBM25` + `scoreBM25Doc` + `reciprocalRankFusion` + `applyMetadataFilter`) lives in the strategy file as exported helpers — no other strategy needs them today (Structural is cosine-fed ancestor walk, Thematic is k-means), so promotion to a shared `scoring.js` is deferred until a second consumer arrives. Failure modes per design: short query (<3 tokens) → BM25 fallback if index, else empty; embedder unavailable → BM25 fallback if index, else empty; empty k-NN result / empty collections / quota ≤ 0 → empty (no errors). `applies_to(req)` returns score 0 when `query` is null/empty/whitespace (thematic territory, deferred to Phase 2), score 0.9 otherwise. `MetadataFilter` honored across every path: `content_types` accept-list + `custom` per-key predicate (function or strict-equal). No runtime wire-up: nothing imports `createSemanticStrategy` outside the test suite, the Composer placeholder still throws, `find_relevant_files` keeps running through the legacy file-level path. Removability holds (Decision §7); the migration of `find_relevant_files` to the new Composer lands with 1.5.2.

---

## Later (sequenced)

### 1.5.0 — Retrieval Phase 1 [target: ~6-8 weeks after Tools track promotes]

**What ships:**
- `js/intelligence/retrieval/` — new module tree.
- **`ChunkRef` contract** with deterministic `ChunkID` (hash of `collection || source_uri || normalized_byte_range || chunker_version`).
- **Ingest pipeline:** Loader → Chunker → (StructureExtractor) → Embedder → Store. Phase 1 chunkers: prose, code (regex heuristic for JS/TS/Python), conversation (1 turn = 1 chunk), structured (per record).
- **Two strategies:** Semantic (hybrid k-NN + BM25 + RRF) and Structural (ancestor-walk over `parent_id` metadata).
- **Composer** with budget accounting, per-strategy quotas, attention-aware ordering, dedup by ChunkID.
- **Migration off `js/context-manager.js`.** Legacy module continues to back `find_relevant_files` until 1.5.2; new pipeline runs in parallel during 1.5.0–1.5.1 with feature-flag fallback.
- **Chunk admission ledger.** Adds `admissions` / `exclusions` records to the `TaskLedger` shipped in 1.3.17 (`js/chat/task-state.js`); same struct, second consumer.
- **Diagnostics:** What strategies fired, chunks per strategy, tokens used vs budget, cache hits.

**Why last:** Biggest rebuild. Doing it after compression + memory + tools means we know exactly what the other subsystems need from retrieval; the contract becomes concrete instead of speculative.

**Exit criteria:**
- Existing `find_relevant_files` results (legacy) and new Composer results agree for ≥80% of test queries.
- New ingest pipeline indexes a project at startup with measurable progress and resumability.
- Code review on a single attached file matches or beats current behavior on a benchmark set.
- **Removability check:** With `js/intelligence/retrieval/` removed and `context-manager.js` restored, what user-visible behavior degrades?

**Size:** ~10-15 PRs over 6-8 weeks. Several `1.5.0-betaN` tag pushes likely.

### 1.5.x — Retrieval follow-ups
- **1.5.1:** Thematic strategy (k-means over filtered vectors). Powers "summarize this codebase" properly.
- **1.5.2:** Legacy `context-manager.js` removed; `find_relevant_files` rewritten to call the new Composer.
- **1.5.3:** Cost-dashboard retrieval extension (per-strategy hit rates, per-strategy token spend) — *gated on cost dashboard shipping*.
- **1.5.4:** Query cache, structural expansion cache.
- **1.5.5 (optional, gated):** AST-based code chunker (tree-sitter) only if the regex heuristic shows measurable quality gaps on the benchmark.

---

### 2.0.0 — Profiles ascend [target: ~3 weeks after 1.5]

**What ships:**
- **Profile contract goes live.** `Profile { name, version, base, budget, retrieval, memory, compression, tools, task_ledger }` is the configuration surface.
- **5 canonical profiles registered:** `chat.v1` (base), `coder.v1`, `kb.v1`. (`chat_multi.v1` and `rp.v1` shipped as stubs for plugin authors.)
- **Roles → profile presets.** The existing 5 roles become UI-friendly toggles over the profile's tool catalog. `role` setting persists for UX continuity; subsystems read from the resolved profile.
- **Task ledger** with novelty-based re-admission.
- **Settings migration script.** One-shot migration on first 2.0 load; `settings.role` translates to `settings.profile.preset`. Audit-logged.
- **Profile picker UI.** New top-bar selector — sits next to or replaces the role selector after dogfooding.

**Be ready to discover the profile contract is lighter than designed.** `DESIGN-profiles.md` describes profiles as the abstraction across five surfaces; ai-editor has one. If by 1.5.x the "profile" reduces to `coder.v1` plus a settings struct plus three knobs, that's a finding to celebrate — 2.0 ships a contract sized to what the editor actually needs.

**Exit criteria:**
- Settings export from 1.5.x imports cleanly into 2.0 with the migration applied.
- A user who never touches the profile picker sees no behavior difference.
- Profile-aware diagnostics: every subsystem's diagnostics surface includes the active profile name + version.
- **Removability check:** With the profile layer collapsed back to roles, what user-visible behavior degrades?

**Size:** ~6-10 PRs over 3 weeks. Migration is the risk; everything else is plumbing.

---

### 3.0 / Post-2.0 candidates [unscoped]

- **Uniform UI consolidation** — by 2.0 we'll have shipped Preact + `htm` on a handful of new surfaces (Memory, `@memory` chip, active-tools chip row, profile picker). 3.0 evaluates whether to migrate select existing surfaces (Settings sidebar, secondary pane, conversation drawer), introduce a Plugin Component primitive, and rework mobile. Touch 2 of the design engagement is the natural input.
- **Sub-agents** — bounded child conversations with their own context/tool catalog/budget. Tractable post-2.0 because profiles make "child profile" a real abstraction. Commit only if real tasks are measurably bottlenecked on context exhaustion that decomposition would solve.
- **Browser-in-browser preview** — Service Worker intercepting iframe `fetch` to serve in-memory files; multi-file static web apps render correctly. StackBlitz-classic / CodeSandbox-v1 pattern. Commit if real users hit the multi-file wall often enough.

All three get scoped post-2.0 against measured signal, not speculation.

---

## Deferred / unscheduled (needs triage)

> **Why this section exists.** Foundations (1.1.x) and Compression (1.2.x) were sequenced before Memory + Tools jumped ahead. Some items are gated on metrics from the cost dashboard (which itself is deferred). Some may be obsolete now that Tools shipped its own equivalents (e.g. the `TaskLedger` landed in 1.3.17). Sorting paused-vs-abandoned is owed.

### Foundations (was 1.1.x)

| Item | Branch | Rationale |
|---|---|---|
| Turn metadata enrichment | `feat/1.1.0-turn-enrichment` | Needed by compression Rules 1–3 (`file_ops`, `tool_result_for`). Read-path-only; new turns enriched, old ones absent. |
| Migration coverage probe | `feat/1.1.0-metadata-coverage-probe` | Read-only consistency check; `?debug=metadata` flips it on. Distinguishes "no rule applied" from "rule skipped because metadata absent." |
| ~~Unified `TaskLedger` (data only)~~ | n/a | **Shipped in 1.3.17** as `js/chat/task-state.js` with `tool_admissions[]` / `tool_invocations[]`. Retrieval / Profiles will extend the same struct. Foundations row obsolete. |
| Profile scaffolding (data only) | `feat/1.1.0-profile-scaffolding` | `js/profiles/coder.v1` mirroring current behavior, no behavior change. |
| CI `node --test` step | `feat/1.1.0-ci-node-test` (worktree `ecstatic-aryabhata-1b4990` — likely abandoned; we're well past 1.1.0) | Port `*.mjs` suites to `node:test`. |
| Pre-merge version coherence check | (none) | Lint comparing `js/version.js` to latest `## [X.Y.Z]` heading in `CHANGELOG.md`. Two release-sync drifts is enough; one evening to fix forever. |
| Idle timeout (since-last-token) | `feat/1.1.1-llm-idle-timeout` | Replaces wall-clock LLM timeout. Foundational for reasoning models, agentic loops, test-driven loop. |
| Embedder hardening | `feat/1.1.2-embedder-provider-decoupling` | Provider decoupling, filetype filters, 500-file ceiling, in-browser embedder validation, Settings → Embeddings tab. |
| Vim keybindings | `feat/1.1.3-vim-keybindings` | `@replit/codemirror-vim`; toggle in Settings → Appearance. Self-contained. |
| Glassworm / Trojan-Source protection | (none) | Invisible-Unicode lint in CI; editor decoration; plugin install warning band; `docs/SECURITY.md`. |

### Compression (was 1.2.x)

> **The whole track is gated on the cost dashboard.** Without it, "did Rules 1+2 actually save the projected 40%?" is unanswerable. Each follow-up gates on the previous one's measured value showing up in the dashboard.

| Item | Branch | Rationale |
|---|---|---|
| Rules 1+2 (Subsumption, Invalidation) | `feat/1.2.0-compression-phase-1`, `feat/1.2.x-compression-off-flag`, `feat/1.2.x-synthetic-savings` | New `js/intelligence/compression/` module tree. `preserve_recent` invariant. Diagnostics in LLM debug modal. Existing `chat/summarizer.js` stays as Rule 5 fallback. |
| Cost dashboard | (none) | **Gating item.** Cross-provider, per-conversation, per-tool token + cost breakdown. Promoted from 1.5.3 because measurement infrastructure ships first, not last. Today the editor has Venice-specific billing in `plugins/venice-billing.js`; this generalizes it. |
| Rule 3 (Consumption) | (none) | Gated on dashboard + ≥95% `tool_result_for` coverage on production sessions. |
| Rule 4 (Resolution) | (none) | Templated marker generation for "debugging spans that ended successfully." Gated on Rule 3 numbers matching the design. |
| Rule 5 tuning | (none) | Plug existing summarizer into the pipeline cleanly; measure compression latency and summarizer call rate. |
| Settings → Compression panel refresh | (none) | Replaces Settings → Chat Summarizer. Establishes the **preset / advanced toggle pattern** (Decision §11) that subsequent panels inherit. Gated on Rules 1–5 live. The full design rationale (rule-toggle contract, policy-vs-resolution, scope-outs) belongs in `docs/DESIGN-compression.md`; the inline essay was moved out for readability. |
| Provider rate-limit respect | (none) | Read `x-ratelimit-*` headers; pace requests; back off on 429. Cross-cutting; ships when any track hits rate-limit pressure. |

### Other deferred

- **Chat panel facelift** — three Touch 2 variants (Polish, Restructure, Reskin); direction not locked. Will get a slot once a direction is picked or roll into 2.0 with the profile picker.
- **Persona memory scope** — deferred indefinitely. Workspace + user scopes cover the demand seen so far.
- **Plugin SlotManager** — designed but not built; on PLAN.md.
- **In-app help renderer** — sidebar pane instead of modal; would make `read_docs`-driven content far more useful.
- **Mobile secondary pane rework** — current ≤768px layout treats secondary pane as a fullscreen overlay; could be a slide-over.
- **Issue/PR tab visual hierarchy** — long tabs feel busy; lo-pri.
- **Plugin marketplace** — defer to 2.x once the architecture stabilizes.

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
8. **Measurement before scale.** Cost dashboard ships with the first eviction subsystem, not at the end. *(Currently deferred — see Compression bucket.)*
9. **Preact + `htm` allowed for new state-heavy surfaces from 1.3.0; vanilla everywhere else through 2.0.** Existing tabs / sidebar / file tree / editor frame / chat stay vanilla forever; no migration. Bigger uniform-UI consolidation is a 2.0 → 3.0 arc.
10. **claude.ai/design engages on a two-touch model.** Touch 1 (Memory UX, 2026-04-29) → 1.3.0 Memory flows; deliverable at `docs/design/touch-1-memory-ux/`. Touch 2 (whole-app facelift, 2026-04-30) → top-bar Restructure + Settings sidebar + Connections / Debug / Help panels; deliverable at `docs/design/touch-2-facelift/`.
11. **Two-view configuration for every settings panel.** Preset view (intent) + advanced view (parameters), reachable via the same toggle name and position in every panel. Editing in advanced flips the preset selector to "Custom"; switching back to a named preset snaps every knob to that preset's defaults. **No separate "Developer mode" sections.** Full contract in `docs/DESIGN-profiles.md` §"Two-View Configuration." Pattern was scheduled to debut in compression 1.2.5 — that panel is currently deferred, so the first panel to actually ship the toggle will be whichever subsequent panel lands first.

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

Push back on any of this. The roadmap is a hypothesis. The first track that drifts more than two weeks past its target gets the next milestone re-scoped, not the deadline pushed.
