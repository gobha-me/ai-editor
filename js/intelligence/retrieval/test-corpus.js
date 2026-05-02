// @ts-check
/**
 * Test-query fixture corpus — the queries the comparison harness
 * (1.5.2) drives through both legacy `js/context-manager.js` and the
 * new Composer pipeline. Nineteenth PR in the 1.5.0 stream and the
 * structural input for the next PR:
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
 *   6. **No expected_paths / ground_truth slot.** The §1.5.0 exit
 *      criterion is *legacy-vs-new agreement*, not *correctness vs.
 *      a hand-labeled gold set*. Both pipelines being wrong in the
 *      same way still scores 1.0 — that's the contract: we are
 *      measuring whether the new pipeline can replace the old one
 *      without behavior regression, not whether either pipeline is
 *      good at retrieval in absolute terms. A future PR (post-1.5.0)
 *      may ship a separately-measured ground-truth corpus.
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
 * @property {string} id        Stable kebab-case slug. Treat as public
 *                              contract once published; downstream reports
 *                              may reference fixtures by id.
 * @property {string} query     The natural-language query string the model
 *                              would issue. Goes through both retrieval
 *                              pipelines unchanged.
 * @property {string} category  One of `QUERY_CATEGORIES`. Lets a
 *                              measurement consumer stratify agreement by
 *                              query shape.
 * @property {string} intent    One-line human-readable rationale for why
 *                              the query was included in the corpus. Not
 *                              machine-consumed.
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
    },
    {
        id: 'auth-discovery',
        query: 'where is authentication handled for Git providers?',
        category: C.FILE_DISCOVERY,
        intent: 'cross-cutting concern by domain term',
    },
    {
        id: 'file-tree-component',
        query: 'where is the file tree component?',
        category: C.FILE_DISCOVERY,
        intent: 'UI component by canonical name',
    },
    {
        id: 'llm-provider-settings',
        query: 'where are LLM provider settings stored?',
        category: C.FILE_DISCOVERY,
        intent: 'state location by data shape',
    },
    {
        id: 'embeddings-client-location',
        query: 'where does the embeddings client live?',
        category: C.FILE_DISCOVERY,
        intent: 'module location by canonical class name',
    },
    {
        id: 'diff-viewer-location',
        query: 'where is the diff viewer?',
        category: C.FILE_DISCOVERY,
        intent: 'UI surface by feature name',
    },
    {
        id: 'plugin-loader-location',
        query: 'where is the plugin loader?',
        category: C.FILE_DISCOVERY,
        intent: 'subsystem entrypoint by responsibility',
    },
    {
        id: 'tool-definitions-registry',
        query: 'where are tool definitions registered?',
        category: C.FILE_DISCOVERY,
        intent: 'registry lookup by purpose',
    },

    /* ---------------- function-discovery (~7) ---------------- */
    {
        id: 'parse-git-url',
        query: 'find the function that parses a Git URL',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by behavior',
    },
    {
        id: 'stream-chat-completions',
        query: 'find the function that streams chat completions',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by I/O verb',
    },
    {
        id: 'compute-chunk-id',
        query: 'find the function that computes ChunkID hashes',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by exact domain term',
    },
    {
        id: 'markdown-to-html',
        query: 'find the function that converts markdown to HTML',
        category: C.FUNCTION_DISCOVERY,
        intent: 'symbol-level retrieval by transformation',
    },
    {
        id: 'mount-settings-sidebar',
        query: 'find the function that mounts the settings sidebar',
        category: C.FUNCTION_DISCOVERY,
        intent: 'lifecycle hook by UI surface',
    },
    {
        id: 'eventbus-emit',
        query: 'find the function that emits events on the eventbus',
        category: C.FUNCTION_DISCOVERY,
        intent: 'pub/sub primitive by name',
    },
    {
        id: 'fetch-embeddings',
        query: 'find the function that fetches embeddings',
        category: C.FUNCTION_DISCOVERY,
        intent: 'IO function by domain term',
    },

    /* ---------------- topic (~7) ---------------- */
    {
        id: 'rate-limiting-thematic',
        query: 'how does rate limiting work?',
        category: C.TOPIC,
        intent: 'thematic with no exact keyword in code',
    },
    {
        id: 'memory-consent-flow',
        query: 'how does memory consent flow work?',
        category: C.TOPIC,
        intent: 'multi-step flow spanning multiple files',
    },
    {
        id: 'compression-subsystem',
        query: 'how does the compression subsystem work?',
        category: C.TOPIC,
        intent: 'subsystem-level walkthrough',
    },
    {
        id: 'tool-admission-flow',
        query: 'how does tool admission work?',
        category: C.TOPIC,
        intent: 'subsystem-level walkthrough by domain term',
    },
    {
        id: 'task-state-across-turns',
        query: 'how is task state tracked across turns?',
        category: C.TOPIC,
        intent: 'state-machine walkthrough',
    },
    {
        id: 'plugins-register-hooks',
        query: 'how do plugins register hooks?',
        category: C.TOPIC,
        intent: 'plugin API by mechanism',
    },
    {
        id: 'multi-tab-storage-isolation',
        query: 'how does multi-tab storage isolation work?',
        category: C.TOPIC,
        intent: 'cross-cutting infra topic',
    },

    /* ---------------- bug-investigation (~7) ---------------- */
    {
        id: 'venice-429-handling',
        query: 'what handles a 429 response from Venice?',
        category: C.BUG_INVESTIGATION,
        intent: 'mixed: provider name + HTTP status + error path',
    },
    {
        id: 'chat-scroll-on-send',
        query: 'what causes the chat panel to scroll on send?',
        category: C.BUG_INVESTIGATION,
        intent: 'UI behavior under specific event',
    },
    {
        id: 'embedder-skip-large-files',
        query: 'why might the embedder skip large files?',
        category: C.BUG_INVESTIGATION,
        intent: 'guard / ceiling logic by symptom',
    },
    {
        id: 'git-push-conflict',
        query: 'what happens when Git push fails with a conflict?',
        category: C.BUG_INVESTIGATION,
        intent: 'error path through provider abstraction',
    },
    {
        id: 'tool-invocation-timeout',
        query: 'what handles tool invocation timeouts?',
        category: C.BUG_INVESTIGATION,
        intent: 'timeout / abort path by feature',
    },
    {
        id: 'session-replay-rendering',
        query: 'what renders the session replay viewer?',
        category: C.BUG_INVESTIGATION,
        intent: 'specific UI surface by canonical feature name',
    },
    {
        id: 'idle-timeout-vs-wallclock',
        query: 'why did we switch from wall-clock to idle LLM timeout?',
        category: C.BUG_INVESTIGATION,
        intent: 'historical decision rationale by outcome',
    },

    /* ---------------- onboarding (~7) ---------------- */
    {
        id: 'add-llm-provider',
        query: 'how do I add a new LLM provider?',
        category: C.ONBOARDING,
        intent: 'extension-point walkthrough by surface',
    },
    {
        id: 'add-git-provider',
        query: 'how do I add a new Git provider?',
        category: C.ONBOARDING,
        intent: 'extension-point walkthrough by surface',
    },
    {
        id: 'write-new-plugin',
        query: 'how do I write a new plugin?',
        category: C.ONBOARDING,
        intent: 'top-level extension-author entrypoint',
    },
    {
        id: 'add-new-chunker',
        query: 'how do I add a new chunker?',
        category: C.ONBOARDING,
        intent: 'subsystem-internal extension-point walkthrough',
    },
    {
        id: 'add-new-role',
        query: 'how do I add a new role?',
        category: C.ONBOARDING,
        intent: 'configuration-surface extension-point',
    },
    {
        id: 'custom-keybinding',
        query: 'how do I add a custom keybinding?',
        category: C.ONBOARDING,
        intent: 'user-facing customization walkthrough',
    },
    {
        id: 'register-mcp-server',
        query: 'how do I register an MCP server?',
        category: C.ONBOARDING,
        intent: 'plugin-API extension-point by canonical name',
    },

    /* ---------------- task-related (~6) ---------------- */
    {
        id: 'files-add-chunker',
        query: 'files I would touch to add a new chunker',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by intent',
    },
    {
        id: 'files-wire-tool-category',
        query: 'files I would touch to wire a new tool category',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by feature work',
    },
    {
        id: 'files-add-settings-tab',
        query: 'files I would touch to add a settings tab',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by UI surface',
    },
    {
        id: 'files-ship-memory-scope',
        query: 'files I would touch to ship a new memory scope',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by subsystem extension',
    },
    {
        id: 'files-add-embedding-provider',
        query: 'files I would touch to add a new embedding provider',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by provider abstraction',
    },
    {
        id: 'files-add-llm-tool',
        query: 'files I would touch to add a new LLM tool',
        category: C.TASK_RELATED,
        intent: 'cross-file co-occurrence by tool registration',
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
