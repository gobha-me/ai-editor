// @ts-check
/**
 * Tools contracts — the typedef surface for the capability-admission and
 * discovery subsystem. Phase 1 (1.4.0) implements static admission +
 * categorical discovery + meta-tools; semantic discovery and lazy schema
 * expansion arrive in 1.4.1.
 *
 * This file is the 1.3.4 foundation: data contracts only. No admission
 * decisions, no model-visible change. The `Catalog` adapter in `catalog.js`
 * is the first consumer.
 *
 * Sources:
 *   - `docs/DESIGN-tools.md` §"Core Contracts" (lines 116-193)
 *   - `docs/DESIGN-tools.md` §"Tool Identity and Stability"
 *   - `docs/DESIGN-tools.md` §"Meta-Tools: The Always-Loaded Discovery Interface"
 *   - `docs/ROADMAP.md` §1.4.0 Tools Phase 1
 *
 * Why JSDoc and not real TS: project constraint
 * (`docs/ARCHITECTURE.md` §"Design Constraints") — no build step, no
 * transpiler. Type safety comes via `jsconfig.json` `checkJs: true`.
 *
 * @module intelligence/tools/contracts
 */

/**
 * Stable identifier for a tool. Hash of
 * `(profile_namespace || canonical_name || version)` per
 * DESIGN-tools.md §"Tool Identity and Stability". A tool's name change is
 * a new ID; the old ID continues to resolve to the deprecated definition
 * for audit. Two profiles defining tools with the same `name` get
 * different IDs via `profile_namespace`, so there is no global tool
 * collision.
 *
 * @typedef {string} ToolID
 */

/**
 * Side-effect classification. Visible to the model so it knows which
 * tools require consent before invocation.
 *
 *   - "read":         pure observation; no state mutation.
 *   - "write":        local mutation (e.g. file edits) reversible by undo / VCS.
 *   - "external":     calls out to a remote system (commit, push, network fetch).
 *   - "irreversible": destructive and/or non-recoverable (delete, force-push).
 *
 * @typedef {"read"|"write"|"external"|"irreversible"} SideEffectClass
 */

/**
 * Authorization spec for a tool. Phase 1 enforces only what
 * `js/tools/registry.js` already enforces (`_registeredRoles` →
 * `required_groups`); `required_consent` and `rate_limit` land with the
 * admission layer in subsequent PRs.
 *
 * @typedef {Object} AuthSpec
 * @property {string[]} required_groups  RBAC groups required to invoke. Mirrors `_registeredRoles` from `js/tools/registry.js`.
 * @property {boolean}  required_consent User must approve each call. Always false in 1.3.4.
 * @property {Object|null} [rate_limit]  Reserved; null in 1.3.4.
 */

/**
 * Per-tool metadata. The cost fields (`cost_estimate`, `short_cost`) make
 * lazy schema expansion possible (Phase 2 / 1.4.1): a tool can be
 * admitted in "short" form (name + description, ~50 tokens) until the
 * model commits to calling it; the full schema loads on first attempted
 * call.
 *
 * @typedef {Object} ToolMetadata
 * @property {string}          version          Semver-ish; Phase 1 uses `'1'`.
 * @property {AuthSpec}        authorization
 * @property {SideEffectClass} side_effects
 * @property {number}          cost_estimate    Tokens for full admission (def + schema).
 * @property {number}          short_cost       Tokens for name + description only.
 * @property {Array<{input: Object, output?: Object}>|null} [examples]
 * @property {boolean}         deprecated
 * @property {ToolID|null}     [superseded_by]  For migrations; old IDs remain referable in the audit trail.
 */

/**
 * The atomic unit of the catalog. Identity is stable; diagnostics and the
 * task ledger reference tools by `id`.
 *
 * `embedding` is null in Phase 1 (1.3.4 / 1.4.0); semantic discovery in
 * 1.4.1 populates it via the existing embeddings client.
 *
 * @typedef {Object} ToolDef
 * @property {ToolID}        id
 * @property {string}        name         Canonical name as the LLM will see it (matches `js/tools/registry.js` key).
 * @property {string}        category     Dot-notation hierarchy, e.g. `"code.git.commit"`.
 * @property {string}        description  1-2 sentences for discovery; long-form lives in `full_doc`.
 * @property {Object}        schema       JSON Schema for arguments — the existing OpenAI-style `function.parameters`.
 * @property {string}        full_doc     Longer doc loaded only when admitted in full. Empty string when unspecified.
 * @property {number[]|null} embedding    Of `(name + description + category)`. Null until 1.4.1.
 * @property {ToolMetadata}  metadata
 */

/**
 * What a meta-tool returns for one tool — the cheap "short" view used at
 * discovery time before the full schema is admitted. Cost columns let
 * the caller decide whether to admit in `"short"` or `"full"` form.
 *
 * @typedef {Object} ToolSummary
 * @property {ToolID}          tool_id
 * @property {string}          name
 * @property {string}          description
 * @property {number}          short_cost
 * @property {number}          full_cost
 * @property {string}          category
 * @property {SideEffectClass} side_effects
 */

/**
 * What `list_tool_categories` returns per category. The cheapest meta-tool
 * output (categories + counts) per DESIGN-tools.md §"Meta-Tools".
 *
 * @typedef {Object} CategoryInfo
 * @property {string} category
 * @property {string} description
 * @property {number} tool_count
 */

/**
 * A meta-tool invocation captured by the caller and forwarded to the
 * Composer so discovery results become eligible for sticky admission on
 * the next turn.
 *
 * @typedef {Object} DiscoveryCall
 * @property {"list_tool_categories"|"list_tools_by_category"|"find_tool"} meta_tool
 * @property {Object} args
 */

/**
 * What the caller hands the Composer at admission time. Phase 1 (1.4.0)
 * fills `profile_static` and `user_groups`; `task_ledger` and
 * `discovery_call` arrive with sticky admission and meta-tools.
 *
 * @typedef {Object} ToolRequest
 * @property {string}              task            For diagnostics.
 * @property {string|null}         query           Current user message; informs semantic strategy in 1.4.1.
 * @property {number}              budget_tokens   Ceiling for the tool-definitions slice.
 * @property {ToolID[]}            profile_static  Profile-declared always-loaded set.
 * @property {Object|null}         task_ledger     `TaskLedger` reference; null until sticky admission lands.
 * @property {string[]}            user_groups     RBAC for the authorization filter.
 * @property {DiscoveryCall|null}  discovery_call  Present if the model just called a meta-tool.
 * @property {"short"|"full"}      expansion_mode  Default lazy-schema state.
 */

/**
 * One tool the Composer decided to admit. `source` distinguishes how it
 * earned its place in the prompt — useful for diagnostics and
 * regression tracking.
 *
 * @typedef {Object} AdmittedTool
 * @property {ToolID}                                              tool_id
 * @property {"short"|"full"}                                      form
 * @property {string}                                              rendered  The text injected into the prompt.
 * @property {"static"|"sticky"|"discovery"|"evicted-and-rebid"}   source
 */

/**
 * Reason a tool was excluded from this admission. The dual to
 * `AdmittedTool` — diagnostics need to explain *why* a tool isn't there.
 *
 * @typedef {Object} SuppressionRecord
 * @property {ToolID} tool_id
 * @property {"unauthorized"|"over_budget"|"not_discovered"|"deprecated"|"evicted_for_budget"} reason
 * @property {string} [detail]
 */

/**
 * Diagnostic counters surfaced in the LLM debug modal (1.4.0 PR 5).
 * Phase 1 ships at least the four counters below; later phases add more.
 *
 * `unresolved_static` lists names from `ToolRequest.profile_static` that
 * did not resolve via `Catalog.getByName()` — e.g. PR-3 meta-tools
 * (`list_tool_categories`, `list_tools_by_category`, `find_tool`) declared
 * in `coder.v1.tools.static` but not yet registered. The Composer is
 * contractually required to skip-not-throw on these (CHANGELOG §1.3.4)
 * and to surface them here so operators can tell "missing on purpose"
 * apart from "registry forgot to register."
 *
 * @typedef {Object} ToolDiagnostics
 * @property {number}   static_admitted
 * @property {number}   sticky_admitted
 * @property {number}   discovery_admitted
 * @property {number}   suppressed
 * @property {number}   evicted_count    Non-static tools dropped under budget pressure (1.4.8 LRU). Mirrors DESIGN-tools.md §Diagnostics.
 * @property {number}   tokens_evicted   Sum of `cost` for entries the eviction pass dropped. Sums into the same denominator as `tokens_used`.
 * @property {string[]} unresolved_static
 */

/**
 * What the Composer returns. Structured (not a flat string) so the caller
 * assembles tool definitions into the prompt in the order returned,
 * retaining control over format while letting the subsystem own the
 * admission decisions.
 *
 * @typedef {Object} ToolAdmissionResult
 * @property {AdmittedTool[]}      admitted
 * @property {SuppressionRecord[]} suppressed
 * @property {ToolDiagnostics}     diagnostics
 * @property {number}              tokens_used
 */

export {};
