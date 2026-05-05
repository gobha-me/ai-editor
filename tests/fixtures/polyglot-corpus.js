// @ts-check
/**
 * Polyglot retrieval-quality fixtures — Go (Armature) and C++ (Plinth).
 *
 * **Why this file exists.** The existing
 * [QUERY_FIXTURES corpus](../../js/intelligence/retrieval/test-corpus.js)
 * is JS-only — fixtures map to `.js` files under `js/` in *this* repo.
 * The post-1.5.11
 * benchmark on that corpus reports `meanHitAt5 = 1.000`: the regex-based
 * code chunker at
 * [code-chunker.js](../../js/intelligence/retrieval/chunkers/code-chunker.js)
 * is good enough for JS.
 *
 * The roadmap's gated AST-chunker decision turns on whether the regex
 * heuristic shows measurable quality gaps on languages it does NOT have
 * dedicated boundary patterns for. Today `LANG_BY_EXT` covers `js`,
 * `mjs`, `cjs`, `jsx`, `ts`, `tsx`, `py` only. Everything else
 * (`.go`, `.cpp`, `.hpp`, `.h`, `.c`, `.rs`, `.java`, `.rb`, `.pl`, `.pm`)
 * falls into the single-chunk degenerate path with an 8000-char hard-cut.
 *
 * **What this corpus is.** 20 hand-curated query fixtures (10 per repo)
 * across two real-world polyglot codebases:
 *
 *   - **Armature** (Go) — self-hosted extension platform; identity, teams,
 *     workflows, package system. ~780 Go files in `server/`.
 *   - **Plinth** (C++) — same product class as Armature, different impl;
 *     kernel + capability registry + RBAC + realtime. ~2480 source files
 *     across `src/kernel/`, `src/client/`, `tests/`, `benchmarks/`.
 *
 * The two repos pair deliberately: most queries have a parallel question
 * answerable in either codebase ("how is auth handled?" → Go middleware
 * vs. C++ handler+filter). Symmetric questions with asymmetric expected
 * paths stress the chunker's language-symmetric quality without
 * conflating that with question-quality differences.
 *
 * **Path scoping.** `expectedPaths` are relative to the **target repo's
 * root**, not ai-editor. A fixture's `repo` field disambiguates:
 *
 *   - `repo: "armature"` → paths resolve under `<armature_root>/`
 *     (e.g. `/config/Projects/armature/server/auth/github.go`).
 *   - `repo: "plinth"` → paths resolve under `<plinth_root>/`
 *     (e.g. `/config/Projects/plinth/src/kernel/auth/handlers.cpp`).
 *
 * The benchmark runner is responsible for resolving repo roots from
 * config; this module is pure data and never reads the filesystem.
 *
 * **Curation methodology.** Each fixture was authored by reading the
 * directory structure + the named files. Spot-checked by the project
 * author (Jeff Smith — owns both repos). Refinements from review land
 * with the rationale recorded inline so a future reader can reconstruct
 * *why* a path is or isn't on the list.
 *
 * **Categories.** Reuses
 * [QUERY_CATEGORIES](../../js/intelligence/retrieval/test-corpus.js) —
 * the same six-category enum the JS corpus uses, so a stratified report
 * can compare per-category recall across corpora without remapping.
 *
 * **Status.** Data-only. Nothing imports this yet. The companion
 * benchmark runner that would consume it is gated on Jeff approving the
 * embedder + run shape (Venice vs. local Transformers; 1-pass vs. K-fold;
 * indexing budget per repo).
 *
 * **Removability.** Delete this file and the polyglot benchmark goes
 * away; the JS-only `test-corpus.js` benchmark and every production
 * surface keep working unchanged.
 *
 * @module tests/fixtures/polyglot-corpus
 */

import { QUERY_CATEGORIES } from '../../js/intelligence/retrieval/test-corpus.js';

const C = QUERY_CATEGORIES;

/**
 * @typedef {"armature" | "plinth"} TargetRepo
 *
 * @typedef {Object} PolyglotQueryFixture
 * @property {string}      id            Stable kebab-case slug, prefixed
 *                                        `armature-` or `plinth-`. Treat as
 *                                        public contract once published.
 * @property {TargetRepo}  repo          Which repo the `expectedPaths`
 *                                        resolve under. The runner uses
 *                                        this to pick the index + root.
 * @property {string}      query         Natural-language query string.
 * @property {string}      category      One of `QUERY_CATEGORIES`.
 * @property {string}      intent        One-line human-readable rationale.
 * @property {string[]}    expectedPaths Hand-curated ground truth, repo-
 *                                        relative. 1-5 entries; sorted
 *                                        alphabetically so diffs are
 *                                        minimal when a path is added /
 *                                        removed.
 */

/**
 * The frozen polyglot fixture corpus. 10 Armature (Go) + 10 Plinth (C++).
 *
 * Element order: Armature first, then Plinth. Within each repo, fixtures
 * are roughly grouped by subsystem (auth → identity → packages → infra)
 * so a reviewer scanning the file sees related queries next to each
 * other.
 *
 * @type {ReadonlyArray<PolyglotQueryFixture>}
 */
export const POLYGLOT_QUERY_FIXTURES = Object.freeze(/** @type {PolyglotQueryFixture[]} */ ([
    /* ============================================================== */
    /* Armature (Go) — server/ tree                                    */
    /* ============================================================== */
    {
        id: 'armature-oauth-session-lifecycle',
        repo: 'armature',
        query: 'how does the OAuth flow work for OIDC provider authentication?',
        category: C.TOPIC,
        intent: 'multi-stage OAuth2/OIDC flow through JWT issuance',
        expectedPaths: [
            'server/auth/github.go',
            'server/handlers/auth.go',
            'server/middleware/auth.go',
        ],
    },
    {
        id: 'armature-user-session-cache',
        repo: 'armature',
        query: 'where is the user status cache that prevents repeated DB queries on each request?',
        category: C.FILE_DISCOVERY,
        intent: 'performance optimization cache by responsibility',
        expectedPaths: [
            'server/middleware/auth.go',
        ],
    },
    {
        id: 'armature-websocket-auth-ticket',
        repo: 'armature',
        query: 'how does the WebSocket endpoint authenticate clients — ticket exchange vs. Bearer tokens?',
        category: C.FUNCTION_DISCOVERY,
        intent: 'dual-path auth mechanism by transport context',
        expectedPaths: [
            'server/middleware/auth.go',
        ],
    },
    {
        id: 'armature-vault-initialization',
        repo: 'armature',
        query: 'how does the password vault initialize and unlock for a user on login?',
        category: C.TOPIC,
        intent: 'credential encryption key lifecycle through auth flow',
        expectedPaths: [
            'server/handlers/auth.go',
        ],
    },
    {
        id: 'armature-bootstrap-admin-vault',
        repo: 'armature',
        query: 'when the admin user is created at startup, how is their password vault initialized?',
        category: C.TASK_RELATED,
        intent: 'vault lifecycle during server bootstrap sequence',
        expectedPaths: [
            'server/handlers/auth.go',
        ],
    },
    {
        id: 'armature-starlark-package-manifest',
        repo: 'armature',
        query: 'how can a Starlark extension extract and inspect a package manifest.json?',
        category: C.TASK_RELATED,
        intent: 'sandbox API for package introspection at runtime',
        expectedPaths: [
            'server/handlers/package_validate.go',
            'server/sandbox/packages_module.go',
        ],
    },
    {
        id: 'armature-package-manifest-validation',
        repo: 'armature',
        query: 'what are the rules for validating a package manifest — required fields, type constraints, allowed fields?',
        category: C.TOPIC,
        intent: 'manifest schema enforcement and error diagnostics',
        expectedPaths: [
            'server/handlers/package_validate.go',
        ],
    },
    {
        id: 'armature-notification-delivery',
        repo: 'armature',
        query: 'how does the notification service route messages to users — in-app, email, or both?',
        category: C.TOPIC,
        intent: 'multi-channel notification pipeline by preference resolution',
        expectedPaths: [
            'server/notifications/service.go',
        ],
    },
    {
        id: 'armature-cluster-registry',
        repo: 'armature',
        query: 'how does the cluster registry track replicas and coordinate multi-instance state?',
        category: C.FILE_DISCOVERY,
        intent: 'HA coordination primitive by module',
        expectedPaths: [
            'server/cluster/registry.go',
        ],
    },
    {
        id: 'armature-logging-configuration',
        repo: 'armature',
        query: 'how do I configure structured logging format and level for the server?',
        category: C.ONBOARDING,
        intent: 'slog initialization by environment variable',
        expectedPaths: [
            'server/logging/logger.go',
        ],
    },

    /* ============================================================== */
    /* Plinth (C++) — src/kernel/ tree                                 */
    /* ============================================================== */
    {
        id: 'plinth-session-auth-routes',
        repo: 'plinth',
        query: 'how does the system handle user login and session creation?',
        category: C.TOPIC,
        intent: 'core auth flow entry point',
        expectedPaths: [
            'src/kernel/auth/handlers.cpp',
            'src/kernel/auth/handlers.hpp',
            'src/kernel/auth/middleware.hpp',
        ],
    },
    {
        id: 'plinth-capability-registry-api',
        repo: 'plinth',
        query: 'where do extensions register new capabilities?',
        category: C.TASK_RELATED,
        intent: 'extension capability registration workflow',
        expectedPaths: [
            'src/kernel/capabilities/registration.cpp',
            'src/kernel/capabilities/registration.hpp',
            'src/kernel/capabilities/types.hpp',
        ],
    },
    {
        id: 'plinth-capability-tier-resolution',
        repo: 'plinth',
        query: 'how does the system resolve which handler to call for a given capability signature?',
        category: C.FUNCTION_DISCOVERY,
        intent: 'three-tier capability dispatch and handler lookup',
        expectedPaths: [
            'src/kernel/capabilities/resolution.cpp',
            'src/kernel/capabilities/resolution.hpp',
            'src/kernel/extensions/runtime_registry.hpp',
        ],
    },
    {
        id: 'plinth-rbac-enforcement-filter',
        repo: 'plinth',
        query: 'how does the HTTP request pipeline enforce role-based access control?',
        category: C.TOPIC,
        intent: 'request authorization and rule-matching logic',
        expectedPaths: [
            'src/kernel/rbac/enforcement.cpp',
            'src/kernel/rbac/enforcement.hpp',
            'src/kernel/rbac/rule_registrar.hpp',
        ],
    },
    {
        id: 'plinth-group-bootstrap-rbac-setup',
        repo: 'plinth',
        query: 'how are the initial admin group and kernel.admin rule created at startup?',
        category: C.TASK_RELATED,
        intent: 'kernel bootstrap identity and authorization setup',
        expectedPaths: [
            'src/kernel/groups/handlers.cpp',
            'src/kernel/groups/handlers.hpp',
            'src/kernel/rbac/rule_registrar.hpp',
        ],
    },
    {
        id: 'plinth-realtime-pubsub-broker',
        repo: 'plinth',
        query: 'how are WebSocket subscriptions managed and how do messages fan out?',
        category: C.TOPIC,
        intent: 'realtime message distribution subsystem',
        expectedPaths: [
            'src/kernel/realtime/broker.cpp',
            'src/kernel/realtime/broker.hpp',
            'src/kernel/realtime/listener.hpp',
        ],
    },
    {
        id: 'plinth-websocket-call-dispatch',
        repo: 'plinth',
        query: 'how does a WebSocket client invoke a capability and receive the result?',
        category: C.TOPIC,
        intent: 'WS protocol integration with capability invocation',
        expectedPaths: [
            'src/kernel/ws/call_dispatch.cpp',
            'src/kernel/ws/call_dispatch.hpp',
            'src/kernel/ws/connection_registry.hpp',
        ],
    },
    {
        id: 'plinth-package-install-state-machine',
        repo: 'plinth',
        query: 'what are the stages of package installation and how is state persisted?',
        category: C.TOPIC,
        intent: 'extension install lifecycle and state transitions',
        expectedPaths: [
            'src/kernel/packages/install_lifecycle.cpp',
            'src/kernel/packages/install_lifecycle.hpp',
            'src/kernel/packages/manifest.hpp',
        ],
    },
    {
        id: 'plinth-schema-migrations-runner',
        repo: 'plinth',
        query: 'how do extension packages apply their database schema migrations?',
        category: C.TASK_RELATED,
        intent: 'per-extension PG schema setup and migration tracking',
        expectedPaths: [
            'src/kernel/packages/migration_error.hpp',
            'src/kernel/packages/migrations.cpp',
            'src/kernel/packages/migrations.hpp',
        ],
    },
    {
        id: 'plinth-audit-logging-write',
        repo: 'plinth',
        query: 'where does the system write audit events to the database?',
        category: C.TOPIC,
        intent: 'audit path implementation details',
        expectedPaths: [
            'src/kernel/audit/handlers.hpp',
            'src/kernel/logging.cpp',
            'src/kernel/logging.hpp',
        ],
    },
]));

/**
 * Flat string array of just the queries — drop-in replacement input for
 * any consumer that accepts `Iterable<string>` (mirrors the
 * `QUERY_CORPUS` shape from `test-corpus.js`).
 *
 * @type {ReadonlyArray<string>}
 */
export const POLYGLOT_QUERY_CORPUS = Object.freeze(
    POLYGLOT_QUERY_FIXTURES.map((f) => f.query),
);

/**
 * Filter fixtures by their target repo. Returns a fresh array so callers
 * can sort / mutate without affecting the frozen corpus.
 *
 * @param {TargetRepo} repo
 * @returns {PolyglotQueryFixture[]}
 */
export function getFixturesByRepo(repo) {
    return POLYGLOT_QUERY_FIXTURES.filter((f) => f.repo === repo);
}

/**
 * Filter fixtures by query category. Defensive — unknown categories
 * yield an empty array rather than throwing.
 *
 * @param {string} category
 * @returns {PolyglotQueryFixture[]}
 */
export function getFixturesByCategory(category) {
    return POLYGLOT_QUERY_FIXTURES.filter((f) => f.category === category);
}
