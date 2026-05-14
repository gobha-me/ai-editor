// @ts-check
/**
 * Test-query fixture corpus — the queries the comparison harness
 * (1.5.2) drove through both the legacy `js/context-manager.js` path
 * and the new Composer pipeline during the §1.5.0 gate-clearing
 * window. The legacy module retired at 1.5.14; the corpus now drives
 * the production Composer pipeline against `expectedPaths` ground
 * truth (the §1.5.5 reframe). Nineteenth PR in the 1.5.0 stream and
 * the structural input for the next PR:
 *
 *   - **Next PR (1.5.4):** the actual ≥80% legacy-vs-new agreement
 *     *measurement* run that promotes the track to 1.5.0-final. Drives
 *     this corpus through `createComparisonHarness` against a real
 *     wired-up Composer (1.5.1 production wiring) + the live legacy
 *     `ContextManager.findRelevantFiles` and reports the number.
 *
 * **What this PR is.** Pure data + a small accessor helper + a JSDoc
 * typedef. `QUERY_CORPUS` is a flat `string[]` directly consumable by
 * `compareBatch(QUERY_CORPUS)`; `QUERY_FIXTURES` is the parallel richer
 * shape with stable `id`, `category`, and `intent` per query so the
 * 1.5.4 measurement PR can stratify agreement without re-classifying.
 *
 * **What this PR is NOT.** It does not run the measurement; it does
 * not wire up production runners; it does not migrate
 * `find_relevant_files`; it does not weight or filter both-empty
 * result pairs (that concern lives at the measurement-PR call site
 * where it can be tuned against actual numbers — see the CHANGELOG
 * entry for 1.5.2 §"Both-empty agreement" and `comparison.js` lines
 * 60-66). Same restraint posture every retrieval Phase-1 module took:
 * one focused, pure, removable factory or data module per PR.
 *
 * **Public surface:** `QUERY_CORPUS: string[]`,
 * `QUERY_FIXTURES: QueryFixture[]`,
 * `QUERY_CATEGORIES: { [name: string]: string }`,
 * `getQueriesByCategory(category): string[]`.
 *
 * **Phase-1 scope decisions** (called out so future readers don't
 * have to reverse-engineer them from behavior):
 *
 *   1. **Two parallel shapes, not one.** `QUERY_CORPUS` is the
 *      lowest-friction consumer of the harness — `compareBatch` takes
 *      `Iterable<string>` and that's it. `QUERY_FIXTURES` is the
 *      richer object form for the 1.5.4 measurement to bucket
 *      agreement by category. They are built side-by-side
 *      (`QUERY_CORPUS` is `QUERY_FIXTURES.map(f => f.query)`) so they
 *      cannot drift; element order matches index-for-index.
 *
 *   2. **Six categories, ~7 queries each.** `file-discovery`,
 *      `function-discovery`, `topic`, `bug-investigation`,
 *      `onboarding`, `task-related`. Roughly balanced so a stratified
 *      report has comparable per-bucket sample sizes; chosen from the
 *      retrieval shapes the legacy `find_relevant_files` LLM tool
 *      sees in real coder-mode usage today.
 *
 *   3. **Queries reflect AI Editor itself.** A coder using AI Editor
 *      on AI Editor would ask "how does Composer work?" — domain terms
 *      like "Venice", "ChunkRef", "task ledger", "find_relevant_files"
 *      are legitimate query content. The 1.5.4 measurement is a
 *      self-hosted benchmark; portability across other repos is a
 *      future concern (a `tests/fixtures/` cross-repo corpus, if it
 *      ever lands, would sit alongside this one rather than replace
 *      it).
 *
 *   4. **Stable `id` per fixture.** Kebab-case slugs (`auth-discovery`,
 *      `composer-walkthrough`). Once published, never renumbered —
 *      the 1.5.4 measurement PR may reference specific fixtures in its
 *      report ("agreement on `auth-discovery` rose from 0.4 to 0.8
 *      after switching to AST chunker"). Treat the `id` as a public
 *      contract; appending new fixtures is fine, renaming an existing
 *      one breaks downstream reports.
 *
 *   5. **`intent` is human-readable rationale, not machine-consumed.**
 *      One short phrase per fixture ("named entity by domain term",
 *      "thematic with no specific keyword") so a reviewer scanning the
 *      fixture file can tell *why* a query was included without
 *      back-deriving from the text. The 1.5.4 report does not
 *      programmatically gate on it.
 *
 *   6. **`expectedPaths` is hand-curated ground truth (1.5.5 reframe).**
 *      The original 1.5.3 corpus deliberately omitted ground truth on
 *      the theory that "legacy-vs-new agreement" was sufficient to
 *      promote §1.5.0. The 1.5.4-patch canonical run on 2026-05-03
 *      surfaced the flaw: the legacy `js/context-manager.js` pipeline
 *      (retired at 1.5.14) returned `assets/fonts/SOURCES.md` and
 *      `evals/pacing.js` for most queries (file-level summary
 *      embeddings near-degenerate), so "agreement with legacy"
 *      measured alignment with a broken baseline. After T1 + T2 stripped prose from the
 *      new pipeline's results in the same release, the 2026-05-03
 *      re-run reported `meanAgreement = 0.0026` — but the per-query
 *      results showed the new pipeline was returning the *correct*
 *      code files (`js/chat/messages.js` for "where is the chat
 *      history rendered?", `js/diff-viewer.js` for "where is the
 *      diff viewer?"), and agreement crashed because legacy was
 *      returning docs/fonts. The §1.5.0 exit criterion is therefore
 *      reframed: **mean recall@5 ≥ 0.80 against `expectedPaths`** is
 *      the new gate. The harness still computes the legacy-vs-new
 *      Jaccard agreement as a secondary "drift" signal, but it no
 *      longer promotes the track.
 *
 *      Curation methodology: per-fixture grep / read of the
 *      codebase. The 1.5.5 corpus carried three fixtures flagged
 *      `// TODO(jeff)` for low-confidence calls; the 1.5.6 curation
 *      pass cleared all three (and refined two task-related fixtures
 *      that scored 0% in the 1.5.5-patch canonical run). All 42
 *      fixtures are now verified against the codebase as of
 *      2026-05-03; in-line comments on the previously-TODO'd or
 *      refined fixtures record the rationale. 1–7 entries per fixture;
 *      all entries are real in-repo paths verified to exist at
 *      curation time.
 *
 *   7. **Frozen at module load.** `QUERY_CORPUS` and `QUERY_FIXTURES`
 *      are `Object.freeze`'d so a misbehaving consumer cannot mutate
 *      the corpus mid-batch and skew the measurement. The accessor
 *      helper (`getQueriesByCategory`) returns a fresh array each
 *      call.
 *
 *   8. **Defensive accessor.** `getQueriesByCategory(unknown)` returns
 *      `[]`, not throws. Same posture every other retrieval helper
 *      took (the Composer normalizers, the ledger consumer, the
 *      Loader's defensive `detectContentType`).
 *
 * **Out of scope (later PRs):**
 *
 *   - The actual ≥80% measurement run (next PR — 1.5.4).
 *   - Empty-result pair filtering / weighting (1.5.4 — at the call
 *     site, where it can be tuned).
 *   - Stratified report aggregation by category (1.5.4 — uses the
 *     `category` field this PR ships).
 *   - Cross-repo / portable query corpus (post-1.5.0 if at all).
 *   - Ground-truth / hand-labeled correctness corpus (post-1.5.0).
 *
 * **No runtime wire-up.** Nothing imports `QUERY_CORPUS` outside the
 * test suite. With this module deleted, the barrel re-exports
 * removed, and the typedefs removed, no production behavior degrades
 * — `find_relevant_files` keeps running through legacy
 * `ContextManager.findRelevantFiles` exactly as before. Removability
 * holds (Decision §7).
 *
 * @module intelligence/retrieval/test-corpus
 */

/**
 * @typedef {Object} QueryFixture
 * @property {string}   id            Stable kebab-case slug. Treat as
 *                                    public contract once published;
 *                                    downstream reports may reference
 *                                    fixtures by id.
 * @property {string}   query         The natural-language query string the
 *                                    model would issue. Goes through both
 *                                    retrieval pipelines unchanged.
 * @property {string}   category      One of `QUERY_CATEGORIES`. Lets a
 *                                    measurement consumer stratify by
 *                                    query shape.
 * @property {string}   intent        One-line human-readable rationale for
 *                                    why the query was included in the
 *                                    corpus. Not machine-consumed.
 * @property {string[]} expectedPaths Hand-curated ground truth — the
 *                                    in-repo file paths a knowledgeable
 *                                    developer would say "yes, that's
 *                                    where this lives". Drives the
 *                                    `recall@k` / `precision@k` / `hit@k`
 *                                    / `MRR` metrics in the comparison
 *                                    harness (1.5.5 reframe; see
 *                                    Decision §6 below). Sorted
 *                                    alphabetically so diffs are minimal
 *                                    when a path is added / removed.
 *                                    Length is intentionally variable
 *                                    (1–7 entries per fixture): some
 *                                    queries map to one canonical file
 *                                    (`embeddings-client-location` →
 *                                    `js/embeddings-client.js`); others
 *                                    legitimately span a subsystem
 *                                    (`compression-subsystem` → all
 *                                    seven `js/intelligence/compression/*`
 *                                    files).
 */

/**
 * Enum-like map of supported query categories. Use these constants when
 * writing new fixtures so the corpus tests can verify every fixture
 * references a known category.
 *
 * @type {Readonly<{
 *   FILE_DISCOVERY: 'file-discovery',
 *   FUNCTION_DISCOVERY: 'function-discovery',
 *   TOPIC: 'topic',
 *   BUG_INVESTIGATION: 'bug-investigation',
 *   ONBOARDING: 'onboarding',
 *   TASK_RELATED: 'task-related',
 * }>}
 */
export const QUERY_CATEGORIES = Object.freeze({
    FILE_DISCOVERY: 'file-discovery',
    FUNCTION_DISCOVERY: 'function-discovery',
    TOPIC: 'topic',
    BUG_INVESTIGATION: 'bug-investigation',
    ONBOARDING: 'onboarding',
    TASK_RELATED: 'task-related',
});

const C = QUERY_CATEGORIES;

/**
 * The frozen fixture corpus. Element order is meaningful only insofar
 * as `QUERY_CORPUS` is derived from it — a measurement consumer that
 * cares about reproducibility can rely on iteration order being
 * stable.
 *
 * @type {ReadonlyArray<QueryFixture>}
 */
export const QUERY_FIXTURES = Object.freeze(/** @type {QueryFixture[]} */ ([
    /* ---------------- file-discovery (~8) ---------------- */
    {
        id: 'chat-history-render',
        query: 'where is the chat history rendered?',
        category: C.FILE_DISCOVERY,
        intent: 'feature-name → component file lookup',
        expectedPaths: [
            'js/chat/handlers.js',
            'js/chat/index.js',
            'js/chat/messages.js',
            'js/chat/state.js',
        ],
    },
    {
        id: 'auth-discovery',
        query: 'where is authentication handled for Git providers?',
        category: C.FILE_DISCOVERY,
        intent: 'cross-cutting concern by domain term',
        expectedPaths: [
            'js/git-providers/base.js',
            'js/git-providers/gitea.js',
            'js/git-providers/github.js',
            'js/git-providers/gitlab.js',
            'js/git-providers/registry.js',
        ],
    },
    {
        id: 'file-tree-component',
        query: 'where is the file tree component?',
        category: C.FILE_DISCOVERY,
        intent: 'UI component by canonical name',
        expectedPaths: ['js/file-tree.js'],
    },
    {
        id: 'llm-provider-settings',
        query: 'where are LLM provider settings stored?',
        category: C.FILE_DISCOVERY,
        intent: 'state location by data shape',
        expectedPaths: [
            'js/core.js',
            'js/providers/registry.js',
            'js/settings/llm-tab.js',
            'js/settings/models-tab.js',
        ],
    },
    {
        id: 'embeddings-client-location',
        query: 'where does the embeddings client live?',
        category: C.FILE_DISCOVERY,
        intent: 'module location by canonical class name',
        expectedPaths: [
            'js/embeddings-client.js',
            'js/intelligence/retrieval/embedder.js',
        ],
    },
    {
        id: 'diff-viewer-location',
        query: 'where is the diff viewer?',
        category: C.FILE_DISCOVERY,
        intent: 'UI surface by feature name',
        expectedPaths: ['js/diff-viewer.js', 'js/secondary-pane.js'],
    },
    {
        id: 'plugin-loader-location',
        query: 'where is the plugin loader?',
        category: C.FILE_DISCOVERY,
        intent: 'subsystem entrypoint by responsibility',
        // `js/core.js` houses `Plugins.register` (the contract); `js/plugin-loader.js` is the loader itself.
        expectedPaths: ['js/core.js', 'js/plugin-loader.js'],
    },
    {
        id: 'tool-definitions-registry',
        query: 'where are tool definitions registered?',
        category: C.FILE_DISCOVERY,
        intent: 'registry lookup by purpose',
        // Two registries: the legacy `js/tools/registry.js` (LLM-tool surface) and the
        // 1.4.x admission catalog (`js/intelligence/tools/catalog.js`).
        expectedPaths: ['js/intelligence/tools/catalog.js', 'js/tools/registry.js'],
    },

    /* ---------------- function-discovery (~7) ---------------- */
    {
        id: 'parse-git-url',
        query: 'find the function that parses a Git URL',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by behavior',
        // No standalone `parseGitUrl` exports; URL parsing is embedded in
        // each provider's connection logic via `new URL(...)` (see
        // `registry.js:277`). All four providers + the base + registry.
        expectedPaths: [
            'js/git-providers/base.js',
            'js/git-providers/gitea.js',
            'js/git-providers/github.js',
            'js/git-providers/gitlab.js',
            'js/git-providers/registry.js',
        ],
    },
    {
        id: 'stream-chat-completions',
        query: 'find the function that streams chat completions',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by I/O verb',
        expectedPaths: ['js/llm/api.js', 'js/llm/completion.js'],
    },
    {
        id: 'compute-chunk-id',
        query: 'find the function that computes ChunkID hashes',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by exact domain term',
        expectedPaths: ['js/intelligence/retrieval/chunk-id.js'],
    },
    {
        id: 'markdown-to-html',
        query: 'find the function that converts markdown to HTML',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by transformation',
        // marked + DOMPurify wrappers; conversion happens at multiple
        // call sites (each module loads marked locally).
        expectedPaths: [
            'js/help/markdown-loader.js',
            'js/markdown-modal.js',
            'js/secondary-pane.js',
        ],
    },
    {
        id: 'mount-settings-sidebar',
        query: 'find the function that mounts the settings sidebar',
        category: C.FUNCTION_DISCOVERY,
        intent: 'lifecycle hook by UI surface',
        expectedPaths: ['js/settings-manager.js'],
    },
    {
        id: 'eventbus-emit',
        query: 'find the function that emits events on the eventbus',
        category: C.FUNCTION_DISCOVERY,
        intent: 'pub/sub primitive by name',
        // EventBus object literal defined at `js/core.js:179`.
        expectedPaths: ['js/core.js'],
    },
    {
        id: 'fetch-embeddings',
        query: 'find the function that fetches embeddings',
        category: C.FUNCTION_DISCOVERY,
        intent: 'IO function by domain term',
        expectedPaths: [
            'js/embeddings-client.js',
            'js/intelligence/retrieval/embedder.js',
        ],
    },

    /* ---------------- topic (~7) ---------------- */
    {
        id: 'rate-limiting-thematic',
        query: 'how does rate limiting work?',
        category: C.TOPIC,
        intent: 'thematic with no exact keyword in code',
        // No "RateLimiter" class; rate limiting is the venice-billing plugin's
        // 429 back-off + the generic retry helper + provider wiring.
        expectedPaths: [
            'js/llm/api.js',
            'js/providers/venice.js',
            'js/retry.js',
            'plugins/venice-billing.js',
        ],
    },
    {
        id: 'memory-consent-flow',
        query: 'how does memory consent flow work?',
        category: C.TOPIC,
        intent: 'multi-step flow spanning multiple files',
        expectedPaths: [
            'js/chat/consent-card.js',
            'js/chat/handlers.js',
            'js/intelligence/memory/consent-queue.js',
            'js/intelligence/memory/index.js',
            'js/intelligence/memory/store.js',
        ],
    },
    {
        id: 'compression-subsystem',
        query: 'how does the compression subsystem work?',
        category: C.TOPIC,
        intent: 'subsystem-level walkthrough',
        expectedPaths: [
            'js/intelligence/compression/compactor.js',
            'js/intelligence/compression/decisions.js',
            'js/intelligence/compression/index.js',
            'js/intelligence/compression/rules/invalidation.js',
            'js/intelligence/compression/rules/subsumption.js',
            'js/intelligence/compression/rules/summarization.js',
            'js/intelligence/compression/tokens.js',
        ],
    },
    {
        id: 'tool-admission-flow',
        query: 'how does tool admission work?',
        category: C.TOPIC,
        intent: 'subsystem-level walkthrough by domain term',
        expectedPaths: [
            'js/chat/handlers.js',
            'js/chat/task-state.js',
            'js/intelligence/tools/composer.js',
            'js/intelligence/tools/index.js',
            'js/profiles/task-ledger.js',
        ],
    },
    {
        id: 'task-state-across-turns',
        query: 'how is task state tracked across turns?',
        category: C.TOPIC,
        intent: 'state-machine walkthrough',
        expectedPaths: [
            'js/chat/handlers.js',
            'js/chat/task-state.js',
            'js/profiles/task-ledger.js',
        ],
    },
    {
        id: 'plugins-register-hooks',
        query: 'how do plugins register hooks?',
        category: C.TOPIC,
        intent: 'plugin API by mechanism',
        expectedPaths: [
            'docs/PLUGIN.md',
            'js/core.js',
            'js/plugin-loader.js',
            'js/tools/plugin-tools.js',
            'plugins/venice-ai.js',
        ],
    },
    {
        id: 'multi-tab-storage-isolation',
        query: 'how does multi-tab storage isolation work?',
        category: C.TOPIC,
        intent: 'cross-cutting infra topic',
        // Verified 2026-05-03: `js/tab-manager.js` is a UI tab/file
        // switcher (no `BroadcastChannel`, no isolation logic). Tab
        // namespacing lives in `js/core.js`'s `Storage` wrapper
        // (`_TAB_SCOPED`, `_initTabId`, `_resolveKey`,
        // `_migrateTabScopedKeys`, `_cleanStaleTabs`); IDB is the backing
        // store.
        expectedPaths: ['js/core.js', 'js/storage/idb.js'],
    },

    /* ---------------- bug-investigation (~7) ---------------- */
    {
        id: 'venice-429-handling',
        query: 'what handles a 429 response from Venice?',
        category: C.BUG_INVESTIGATION,
        intent: 'mixed: provider name + HTTP status + error path',
        expectedPaths: ['js/llm/api.js', 'js/providers/venice.js', 'js/retry.js'],
    },
    {
        id: 'chat-scroll-on-send',
        query: 'what causes the chat panel to scroll on send?',
        category: C.BUG_INVESTIGATION,
        intent: 'UI behavior under specific event',
        expectedPaths: [
            'js/chat/handlers.js',
            'js/chat/index.js',
            'js/chat/messages.js',
        ],
    },
    {
        id: 'embedder-skip-large-files',
        query: 'why might the embedder skip large files?',
        category: C.BUG_INVESTIGATION,
        intent: 'guard / ceiling logic by symptom',
        // Pre-1.5.14 the file-level size limit lived at
        // `js/context-manager.js:27` (`MAX_INDEX_SIZE: 250_000`). After the
        // 1.5.14 retirement, the embedder + ingest controller surface
        // chunk-level skip logic.
        expectedPaths: [
            'js/context-manager.js',
            'js/intelligence/retrieval/embedder.js',
            'js/intelligence/retrieval/ingest-controller.js',
        ],
    },
    {
        id: 'git-push-conflict',
        query: 'what happens when Git push fails with a conflict?',
        category: C.BUG_INVESTIGATION,
        intent: 'error path through provider abstraction',
        expectedPaths: [
            'js/git-providers/base.js',
            'js/git-providers/gitea.js',
            'js/git-providers/github.js',
            'js/git-providers/gitlab.js',
            'js/git.js',
        ],
    },
    {
        id: 'tool-invocation-timeout',
        query: 'what handles tool invocation timeouts?',
        category: C.BUG_INVESTIGATION,
        intent: 'timeout / abort path by feature',
        // Verified 2026-05-03: tool-call timeout (this query) is distinct
        // from the LLM idle timeout (which lives in `js/llm/api.js`; see
        // `idle-timeout-vs-wallclock`). The `Promise.race` on tool
        // execution is at `js/chat/handlers.js:524-535`; default
        // `toolTimeout: 30000` lives at `js/core.js:278`; UI slider in
        // `js/settings-manager.js`; persistence in
        // `js/settings/persistence.js`.
        expectedPaths: [
            'js/chat/handlers.js',
            'js/core.js',
            'js/settings-manager.js',
            'js/settings/persistence.js',
        ],
    },
    {
        id: 'session-replay-rendering',
        query: 'what renders the session replay viewer?',
        category: C.BUG_INVESTIGATION,
        intent: 'specific UI surface by canonical feature name',
        expectedPaths: [
            'js/chat/export.js',
            'js/chat/replay.js',
            'js/chat/sessions-sync.js',
        ],
    },
    {
        id: 'idle-timeout-vs-wallclock',
        query: 'why did we switch from wall-clock to idle LLM timeout?',
        category: C.BUG_INVESTIGATION,
        intent: 'historical decision rationale by outcome',
        // Verified 2026-05-03: the query asks "why" — the historical
        // rationale lives in the 1.1.1 CHANGELOG entry, so include
        // CHANGELOG.md (same precedent as `docs/PLUGIN.md` being on
        // `plugins-register-hooks`). `js/chat/handlers.js` was where the
        // legacy wall-clock `Promise.race` lived; `js/llm/api.js`
        // implements the new idle timer; `js/core.js` carries the
        // one-shot migration `llmTimeout → llmIdleTimeout`;
        // `tests/test-llm-idle-timeout.mjs` is the regression test.
        expectedPaths: [
            'CHANGELOG.md',
            'js/chat/handlers.js',
            'js/core.js',
            'js/llm/api.js',
            'tests/test-llm-idle-timeout.mjs',
        ],
    },

    /* ---------------- onboarding (~7) ---------------- */
    {
        id: 'add-llm-provider',
        query: 'how do I add a new LLM provider?',
        category: C.ONBOARDING,
        intent: 'extension-point walkthrough by surface',
        // Index, registry, one example provider, and the settings tab.
        expectedPaths: [
            'js/providers/index.js',
            'js/providers/openrouter.js',
            'js/providers/registry.js',
            'js/settings/llm-tab.js',
        ],
    },
    {
        id: 'add-git-provider',
        query: 'how do I add a new Git provider?',
        category: C.ONBOARDING,
        intent: 'extension-point walkthrough by surface',
        expectedPaths: [
            'js/git-providers/base.js',
            'js/git-providers/index.js',
            'js/git-providers/registry.js',
            'js/settings/connections-tab.js',
        ],
    },
    {
        id: 'write-new-plugin',
        query: 'how do I write a new plugin?',
        category: C.ONBOARDING,
        intent: 'top-level extension-author entrypoint',
        expectedPaths: [
            'docs/PLUGIN.md',
            'js/core.js',
            'js/plugin-loader.js',
            'plugins/venice-ai.js',
        ],
    },
    {
        id: 'add-new-chunker',
        query: 'how do I add a new chunker?',
        category: C.ONBOARDING,
        intent: 'subsystem-internal extension-point walkthrough',
        expectedPaths: [
            'js/intelligence/retrieval/chunkers/code-chunker.js',
            'js/intelligence/retrieval/chunkers/prose-chunker.js',
            'js/intelligence/retrieval/index.js',
            'js/intelligence/retrieval/pipeline.js',
        ],
    },
    {
        id: 'add-new-role',
        query: 'how do I add a new role?',
        category: C.ONBOARDING,
        intent: 'configuration-surface extension-point',
        // BUILTIN_ROLES live in `js/core.js`; per-role tool gates live in
        // the registry; the Settings → Roles tab edits the live set.
        expectedPaths: [
            'js/core.js',
            'js/settings/roles-tab.js',
            'js/tools/registry.js',
        ],
    },
    {
        id: 'custom-keybinding',
        query: 'how do I add a custom keybinding?',
        category: C.ONBOARDING,
        intent: 'user-facing customization walkthrough',
        expectedPaths: [
            'js/app.js',
            'js/editor/instance.js',
            'js/help/hotkey-registry.js',
            'js/help/kbd.js',
        ],
    },
    {
        id: 'register-mcp-server',
        query: 'how do I register an MCP server?',
        category: C.ONBOARDING,
        intent: 'plugin-API extension-point by canonical name',
        expectedPaths: [
            'js/core.js',
            'js/mcp/registry.js',
            'js/settings/mcp-servers-tab.js',
        ],
    },

    /* ---------------- task-related (~6) ---------------- */
    {
        id: 'files-add-chunker',
        query: 'files I would touch to add a new chunker',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by intent',
        // Differs from `add-new-chunker` (onboarding) by including the
        // wiring file (`wiring.js`) since "touching" implies registration.
        expectedPaths: [
            'js/intelligence/retrieval/chunkers/code-chunker.js',
            'js/intelligence/retrieval/index.js',
            'js/intelligence/retrieval/pipeline.js',
            'js/intelligence/retrieval/wiring.js',
        ],
    },
    {
        id: 'files-wire-tool-category',
        query: 'files I would touch to wire a new tool category',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by feature work',
        // Refined 2026-05-03 (1.5.6 curation pass). Wiring a new category
        // means: (1) create a new `js/tools/<name>-tools.js` file
        // (`ci-tools.js` is the canonical recent example, added in 1.4.5);
        // (2) register the import in `js/app.js`'s tool-modules block;
        // (3) add the new tools to `CATEGORY_BY_NAME` at
        // `js/intelligence/tools/catalog.js:52` (otherwise they fall
        // back to `"misc"`); (4) keep the parallel enumeration in
        // `js/prompts.js` in sync (per the
        // `feedback_prompts_js_parallel_enumeration` rule); (5) the
        // new file calls into `ToolRegistry.register` from
        // `js/tools/registry.js`. Drops `embeddings.js` (the
        // catalog-vector-store seam, still WIP) and `settings/tools-tab.js`
        // (UI, not wiring).
        expectedPaths: [
            'js/app.js',
            'js/intelligence/tools/catalog.js',
            'js/prompts.js',
            'js/tools/ci-tools.js',
            'js/tools/registry.js',
        ],
    },
    {
        id: 'files-add-settings-tab',
        query: 'files I would touch to add a settings tab',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by UI surface',
        expectedPaths: [
            'js/settings-manager.js',
            'js/settings/connections-tab.js',
            'js/settings/persistence.js',
        ],
    },
    {
        id: 'files-ship-memory-scope',
        query: 'files I would touch to ship a new memory scope',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by subsystem extension',
        expectedPaths: [
            'js/intelligence/memory/file-layer.js',
            'js/intelligence/memory/index.js',
            'js/intelligence/workspace-settings/index.js',
        ],
    },
    {
        id: 'files-add-embedding-provider',
        query: 'files I would touch to add a new embedding provider',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by provider abstraction',
        expectedPaths: [
            'js/embeddings-client.js',
            'js/intelligence/retrieval/embedder.js',
            'js/settings/models-tab.js',
        ],
    },
    {
        id: 'files-add-llm-tool',
        query: 'files I would touch to add a new LLM tool',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by tool registration',
        // Refined 2026-05-03 (1.5.6 curation pass). Adding a single
        // tool: define the handler in an existing `*-tools.js` file
        // (`js/tools/file-tools.js` is the canonical "many tools, one
        // file" example); register via `ToolRegistry.register` from
        // `js/tools/registry.js`; keep the parallel enumeration in
        // `js/prompts.js` in sync (per the
        // `feedback_prompts_js_parallel_enumeration` rule); update the
        // write-tool allowlist + executor cache in `js/chat/handlers.js`;
        // expose to the user via `js/settings/tools-tab.js`. Drops
        // `task-state.js` (per-conversation ledger; only touched when
        // changing admission policy) and `composer.js` (admission engine;
        // unchanged when adding a new tool).
        expectedPaths: [
            'js/chat/handlers.js',
            'js/prompts.js',
            'js/settings/tools-tab.js',
            'js/tools/file-tools.js',
            'js/tools/registry.js',
        ],
    },
]));

/**
 * Flat string corpus, derived from `QUERY_FIXTURES`. Element order
 * matches `QUERY_FIXTURES` index-for-index. Directly consumable by
 * `createComparisonHarness(...).compareBatch(QUERY_CORPUS)`.
 *
 * @type {ReadonlyArray<string>}
 */
export const QUERY_CORPUS = Object.freeze(QUERY_FIXTURES.map((f) => f.query));

const VALID_CATEGORIES = new Set(Object.values(QUERY_CATEGORIES));

/**
 * Returns all query strings whose fixture has the given category.
 * Returns a fresh array each call. Unknown / non-string `category` →
 * `[]` (defensive — never throws).
 *
 * @param {string} category One of `QUERY_CATEGORIES` values.
 * @returns {string[]}
 */
export function getQueriesByCategory(category) {
    if (typeof category !== 'string' || !VALID_CATEGORIES.has(category)) {
        return [];
    }
    /** @type {string[]} */
    const out = [];
    for (const f of QUERY_FIXTURES) {
        if (f.category === category) out.push(f.query);
    }
    return out;
}
