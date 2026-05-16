# ICD — Git provider base interface contract

> **Status:** initial draft, RE-EVAL following 2.49.0. Fourth subsystem in the ICD-backfill program per [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" target #4. Tracks the provider abstraction that lives across `js/git-providers/base.js` (55 methods + 1 getter + circuit breaker) and four concrete implementations (`github.js`, `gitea.js`, `gitlab.js`, `local.js`) as it stands at 2.49.0. Prior ICDs ([`ICD-chat-handlers.md`](ICD-chat-handlers.md) target #1, shipped 2.42.0; [`ICD-intelligence-composers.md`](ICD-intelligence-composers.md) target #2, shipped 2.45.0; [`ICD-tool-registry.md`](ICD-tool-registry.md) target #3, shipped 2.46.0) describe orthogonal seams. Code-aware findings from authoring feed back to ROADMAP as `[strong]`-band rows in the next code minor; **three** surface this pass (see §"Code-aware findings").

## Purpose

`Git` is a facade ([`js/git.js`](../js/git.js)) over four concrete providers that hit four different REST shapes (GitHub v3, Gitea/Forgejo v1, GitLab v4, in-memory). The base ([`js/git-providers/base.js`](../js/git-providers/base.js)) defines:

- **A 55-method + 1-getter surface** that every provider sees as its prototype-like default. Providers are plain objects merged into the base at registration via shallow spread (`{ ...BASE_GIT_PROVIDER, ...provider }`) in [`registry.js:36`](../js/git-providers/registry.js) — **not** class inheritance.
- **Three default behaviors:** `notSupported` (throws `EditorError(GIT_NOT_SUPPORTED)`), safe-empty returns (`null` / `[]` for feature-detection paths), and **functional defaults** (methods whose default impl composes other base methods — the composability seam where "subclass must implement" stops).
- **A status-code → ErrorCode → recoveryHint translation** ([`base.js:89–104`](../js/git-providers/base.js)) that the base `request()` applies but the three remote providers' overridden `request()` re-encodes per-provider.
- **A circuit breaker** exported separately (`circuitBreakerGuard` + `markUnreachable` + `markReachable` + `healthProbe`, `CIRCUIT_COOLDOWN_MS = 60_000`, `HEALTH_PROBE_TIMEOUT = 5_000`) that the three remote providers wrap manually inside their `request()` overrides; Local skips it entirely.
- **A declarative `contributes` manifest** (panels / tools / settings / menuItems) deep-merged at registration so partial contributions compose with the base's empty defaults.

Five sub-systems consume this contract: the [`git.js`](../js/git.js) facade (active connection routing), the PR Review surface (`capabilities` matrix gates dock buttons), the Merge Conflict Resolver (`getMergeConflicts` default impl + `mergeConflictResolution` flag), the retrieval delta-indexer (`getChangedFilesBetween` default), and the Touch 3 connections UI (`glyph` field + `contributes.settings`).

The contract was implicit and inline until the 1.1.0 minimum-viable extraction; subsequent slices have grown the surface without an ICD-level pinning of what "implement vs inherit vs functional-default" means per method. **This ICD freezes the inheritance pattern, the three default behaviors, and the capability matrix so a future migration doesn't quietly drop one.**

## The seam at a glance

| | `base.js` | `github.js` | `gitea.js` | `gitlab.js` | `local.js` |
|---|---|---|---|---|---|
| **Path** | [`base.js`](../js/git-providers/base.js) | [`github.js`](../js/git-providers/github.js) | [`gitea.js`](../js/git-providers/gitea.js) | [`gitlab.js`](../js/git-providers/gitlab.js) | [`local.js`](../js/git-providers/local.js) |
| **LOC** | 973 | 1249 | 1238 | 1198 | 334 |
| **Auth header** | `Authorization: token ${token}` (Gitea-shape default) | `Authorization: Bearer ${token}` + `X-GitHub-Api-Version: 2022-11-28` | `Authorization: token ${token}` | `PRIVATE-TOKEN: ${token}` | `{}` (empty) |
| **Base URL shape** | `${url}/api/v1` | `https://api.github.com` (fixed; `+/api/v3` for GHE) | `${url}/api/v1` | `${url}/api/v4` | `local://` |
| **Resource id encoding** | path segments | path segments | path segments | URL-encoded `owner%2Frepo` (single segment) | in-memory `Map<key>` |
| **PR/MR id field** | `number` | `number` | `number` | `iid` (project-internal id) |  no PR concept |
| **State enum (open)** | `'open'` | `'open'` | `'open'` | `'opened'` → normalized to `'open'` | n/a |
| **Health probe endpoint** | n/a | `/rate_limit` | `/version` | `/version` | n/a |
| **Circuit-breaker wrapped?** | no (default `request()` has no breaker) | yes (in override) | yes (in override) | yes (in override) | n/a (no network) |
| **Status-code translation** | `STATUS_TO_GIT_CODE` map ([base.js:89–104](../js/git-providers/base.js)) — 401→AUTH_INVALID_TOKEN, 403→AUTH_FORBIDDEN, 404→GIT_NOT_FOUND, 409→GIT_CONFLICT, 422→GIT_VALIDATION | provider re-encodes (no `EditorError`; `err.status`/`err.rateLimit` instead) | provider re-encodes | provider re-encodes (no `EditorError`; rate-limit header `RateLimit-Remaining`) | n/a |

## The five classification axes

Each axis names a question the seam answers across all four providers. The first three (Implementation, Capability, Error-translation) describe *what gets called and what comes back*; the last two (Circuit-breaker, Contribution) describe *what wraps the call and what the provider declares about itself*.

| Axis | Question | Where it's declared | Where it's read |
|---|---|---|---|
| **Implementation axis** | For a given base method, does the provider override, inherit a functional default, inherit a safe-empty, or inherit `notSupported`? | Per-provider object literal (presence/absence of the method key) | `Git` facade calls the merged method; outcome shape determined by which of the four default modes applies |
| **Capability axis** | What does the provider advertise as supported via the `get capabilities()` getter? | `get capabilities()` getter (override at `github.js:911`, `gitea.js:948`, `gitlab.js:1161`; default at `base.js:610`) — six flags: `reviewSubmission`, `threadResolve`, `viewedFiles`, `merge`, `rerunCi`, `mergeConflictResolution` | `PrReviewDock.js:92–94` (3 flags), `PrReviewSurface.js:544/570/571/650` (1 flag), `PrMergeControls.js:49` (1 flag), `git.js:513,591` (chained reads) |
| **Error-translation axis** | How is an HTTP error mapped to an LLM-actionable shape? | Base `request()` ([base.js:179](../js/git-providers/base.js)) emits `EditorError` with `STATUS_TO_GIT_CODE[response.status]` + `STATUS_TO_GIT_HINT[response.status]`. Three remote provider `request()` overrides emit a plain `Error` with `err.status`/`err.rawBody`/`err.rateLimit` attached. | Tool-registry's `execute()` ([`registry.js:192`](../js/tools/registry.js)) recognizes `EditorError` and threads `recoveryHint` into the LLM-visible `{ error }` envelope. Plain `Error` paths flow through the legacy HTTP-status fallbacks. |
| **Circuit-breaker axis** | Does the provider wrap `request()` with `circuitBreakerGuard` + `markUnreachable`/`markReachable`? | Provider-side: `circuitBreakerGuard(connection)` first line of overridden `request()` (`github.js:91`, `gitea.js:79`, `gitlab.js:111`). Local has no `request()`. | `_unreachable` flag on the connection object; consumed by `Git.getDownConnectionIds()` + the Refresh-Projects button's `forceRetryAll()` |
| **Contribution axis** | What declarative UI surface does the provider contribute? | `contributes: { panels, tools, settings, menuItems }` per-provider literal (`github.js:1200`, `gitea.js:1178`, `gitlab.js:1171`, `local.js:279`); base default is all-empty arrays | `GitProviderRegistry.getAllContributions()` ([`registry.js:248`](../js/git-providers/registry.js)) merges across providers; SlotManager renders panels/menuItems, ToolRegistry registers tools, ConnectionsTab renders settings |

55 methods × 4 providers × 4 default-modes is the surface this ICD pins. The asymmetry (5 axes × 55 methods) mirrors prior ICDs: each axis encodes a distinct *question*, but the methods carry their axis answers as records on the shared base object rather than as separate exports per axis.

## Per-axis contract

### Implementation axis — three default modes

The base declares 55 methods + 1 getter. Three default behaviors exist; a fourth pseudo-mode (`override`) is provider-side. **`notSupported` is the canonical "this provider doesn't support this" signal** — it throws `EditorError(GIT_NOT_SUPPORTED)` with a recovery hint naming the provider. Two narrower modes opt out:

| Default mode | Methods | Why this mode (not `notSupported`) |
|---|---|---|
| **`notSupported` throw** (the rule) | 39 of 55 methods — listRepos, createRepo, getRepo, listBranches, createBranch, deleteBranch, getContents, getFileTree, getFile, getBlame, getFileCommits, getCommits, createFile, updateFile, deleteFile, renameFile, batchCommitFiles, all 7 issues methods, all PR methods except `addPullRequestComment`/`getMergeConflicts`, `submitPullRequestReview`, `createReviewComment`, `getCommitStatus`, `listTags`, `compareRefs`, `listReleases`, `createRelease`, `rerunWorkflowJobs`, `downloadArchive` | Default: caller MUST handle "this provider can't do this" — surfaced through `EditorError(GIT_NOT_SUPPORTED)` with a friendly hint |
| **Safe-empty return** | 6 methods — `getLanguages` (`null`), `listWorkflowRuns` (`[]`), `getWorkflowRun` (`null`), `getWorkflowRunLogs` (`null`), `listWorkflowJobs` (`[]`), `getJobLog` (`null`) | These methods are **feature-detection paths** — `null`/`[]` is a meaningful signal to the caller ("cascade to fallback"), not an error. Used by retrieval ingest's `orderByLanguageStats` cascade and the CI panel's optional render. |
| **Functional default** | 4 methods — `addPullRequestComment` (delegates to `createIssueComment`), `getMergeConflicts` (composes `getPullRequest` + `getPullRequestFiles` + `getFile`), `getBranchAheadBehind` (composes two `compareRefs` calls), `getChangedFilesBetween` (composes two `compareRefs` calls, unions the file lists) | These are *derivable* from other base methods. Providers whose API exposes a single-round-trip version (GitHub's `ahead_by`/`behind_by` on `/compare`) override; others inherit a correct-but-slower default. |
| **`testConnection` default** | 1 method (`testConnection`) | Default does a `GET /user` against the provider — works for both Gitea and GitHub-compatible APIs. GitHub + Gitea + GitLab inherit; Local overrides to `return { ok: true }`. |

**The composability seam.** A provider that inherits a functional default but whose dependency throws `notSupported` produces a silent runtime throw at the inherited-default call site, **not** at registration. Example: Local inherits `getChangedFilesBetween` from the base, which calls `compareRefs`, which Local doesn't override; the call throws `GIT_NOT_SUPPORTED("Local does not support compareRefs")`. The seam is intentional — Local also inherits `mergeConflictResolution: false` (no `get capabilities()` override), so the call site behind `PrMergeControls` never fires. **The invariant is: each functional default's transitive dependencies must be matched by either an override or a `notSupported` that the call-site capability flag guards.** Today this is honored by inspection, not enforced.

### Capability axis — the six PR Review flags

The `get capabilities()` getter is the only way a provider declares optional feature support. **Six flags** ([`base.js:610`](../js/git-providers/base.js)), each a boolean defaulting to `false`:

| Flag | Read site | Production semantic |
|---|---|---|
| `reviewSubmission` | `PrReviewDock.js:92`, `PrReviewSurface.js:544/570/571/650`, `git.js:513` | Enables the Submit Review button + line-anchored comment composer; gates `submitPullRequestReview` + `createReviewComment` |
| `merge` | `PrReviewDock.js:93` | Enables the Merge button in the dock; gates `mergePullRequest` |
| `rerunCi` | `PrReviewDock.js:94`, `git.js:591` | Enables Re-run Failed Jobs button when `ci.state === 'failure'`; gates `rerunWorkflowJobs` |
| `mergeConflictResolution` | `PrMergeControls.js:49` | Shows the Resolve Conflicts button when `pr.mergeable === false`; gates the resolver surface |
| `threadResolve` | **declared but not yet read** | Reserved future-capability slot. The dead `resolveReviewThread` base method that this flag once gated was demoted at 2.60.0 (see code-aware finding #3); the flag itself is retained because a future GraphQL-capable provider can re-add the method behind the flag without re-litigating the 6-slot capability shape pinned by [`test-provider-capabilities-shape.mjs`](../tests/test-provider-capabilities-shape.mjs) |
| `viewedFiles` | **declared but not yet read** | Would enable the GitHub viewed-files preview API integration; no provider implements |

Per-provider declarations:

| Provider | `reviewSubmission` | `threadResolve` | `viewedFiles` | `merge` | `rerunCi` | `mergeConflictResolution` |
|---|---|---|---|---|---|---|
| GitHub | `true` | `false` | `false` | `true` | `true` | `true` |
| Gitea | `true` | `false` | `false` | `true` | `true` | `true` |
| GitLab | undefined (`false` via `?.`) | undefined | undefined | undefined | undefined | `true` |
| Local | `false` (all six, via base default) | `false` | `false` | `false` | `false` | `false` |

**The `undefined → false` invariant.** GitLab's `get capabilities()` ([`gitlab.js:1161`](../js/git-providers/gitlab.js)) declares only `mergeConflictResolution: true`; the other five flags are *not present* on the returned object. Every consumer site reads via optional-chaining (`capabilities?.merge === true`) so `undefined` is semantically `false`. The docstring at `gitlab.js:1155-1158` makes this explicit: each flag flips on per-slice with live testing. **This invariant is load-bearing** — a future consumer that reads `capabilities.merge` (no `?.`) would throw on GitLab. See code-aware finding #2.

### Error-translation axis

**Base `request()` ([base.js:179](../js/git-providers/base.js))** translates non-`ok` HTTP responses to `EditorError`:

```javascript
throw new EditorError(`${this.name}: ${friendlyMsg}`, {
    code: STATUS_TO_GIT_CODE[response.status] || ErrorCode.UNKNOWN,
    recoveryHint: STATUS_TO_GIT_HINT[response.status],
    status: response.status,
    context: { url, endpoint, rawBody: rawBody.slice(0, 500) },
});
```

| HTTP status | `STATUS_TO_GIT_CODE` | `STATUS_TO_GIT_HINT` |
|---|---|---|
| 401 | `AUTH_INVALID_TOKEN` | Check your API token in Settings → Connections. |
| 403 | `AUTH_FORBIDDEN` | Your token lacks permission. Check token scopes. |
| 404 | `GIT_NOT_FOUND` | Resource not found. Use the file tree to verify the path. |
| 409 | `GIT_CONFLICT` | Conflict — the file was modified elsewhere. Refresh and try again. |
| 422 | `GIT_VALIDATION` | Validation error. Check your parameters. |
| other | `ErrorCode.UNKNOWN` | none (`recoveryHint` undefined) |

**The three remote-provider overrides do NOT use `EditorError`.** GitHub/Gitea/GitLab each throw a plain `Error` with `err.status`, `err.url`, `err.endpoint`, `err.rawBody`, and (GitHub/GitLab) `err.rateLimit`. The tool-registry's `execute()` ([`registry.js:192`](../js/tools/registry.js)) discriminates on `err.code` (EditorError path) vs `err.status` (plain-error path); both produce LLM-actionable `{ error: "...", code? }` envelopes, but only the `EditorError` path threads `recoveryHint` automatically. This asymmetry is intentional — provider overrides retain provider-specific metadata (rate-limit reset time) that the base shape doesn't accommodate.

**The `notSupported()` helper ([base.js:111](../js/git-providers/base.js))** unconditionally throws `EditorError(GIT_NOT_SUPPORTED, recoveryHint: "Try a different provider.")`. This path is the one a missing override falls into; it produces an LLM-actionable error without provider-specific code.

### Circuit-breaker axis

Exported separately from `BASE_GIT_PROVIDER` at the bottom of `base.js`:

- **`circuitBreakerGuard(connection)`** ([base.js:885](../js/git-providers/base.js)) — call at the top of every `request()` override. Throws `Error("Connection offline (retry in Ns)")` with `err.circuitOpen = true` when `connection._unreachable` and cooldown hasn't expired. Returns `true` for a single probe request when cooldown expires.
- **`markUnreachable(connection, provider, errorMsg)`** — sets `_unreachable: true` + `_unreachableAt: Date.now()`; emits `EventBus.emit('git:connectionLost', {...})` on first transition (subsequent failures only extend the timestamp).
- **`markReachable(connection, provider)`** — clears `_unreachable`; emits `EventBus.emit('git:connectionRestored', {...})`.
- **`healthProbe(baseUrl, headers, endpoint)`** — raw fetch with `AbortSignal.timeout(HEALTH_PROBE_TIMEOUT)`. Bypasses the circuit breaker and `request()` entirely. Returns `true` if `resp.ok || resp.status === 401` (401 = server up, token issue). Called by remote-provider `request()` overrides on timeout to distinguish "slow" from "dead."
- **`CIRCUIT_COOLDOWN_MS = 60_000`** — 1 minute between probe attempts.

**The breaker is not part of `BASE_GIT_PROVIDER`.** Providers compose it manually inside their override `request()` — they call `circuitBreakerGuard(connection)` first, wrap the fetch in try/catch, and call `markUnreachable`/`markReachable` based on outcome. The base `request()` ([base.js:179](../js/git-providers/base.js)) does NOT wrap the breaker; if a provider inherits the base `request()` without override (Local doesn't even have one), there is no circuit-breaker behavior. **This asymmetry is load-bearing**: Local's in-memory `Map` reads have no notion of "offline"; the breaker would be spurious.

### Contribution axis

`contributes: { panels: [], tools: [], settings: [], menuItems: [] }` on each provider, deep-merged with the base default at registration ([`registry.js:38-41`](../js/git-providers/registry.js)). Consumers:

- **`GitProviderRegistry.getAllContributions()`** ([`registry.js:248`](../js/git-providers/registry.js)) — flattens across all registered providers, annotating each entry with `providerId`.
- **SlotManager** — renders `panels` into the left rail; renders `menuItems` into context menus.
- **ToolRegistry** — `register()` consumes the `tools` array (provider-contributed LLM tools).
- **ConnectionsTab** (`js/settings/connections-tab.js`) — renders `settings` as form fields in the per-connection editor.

Today's contributions: GitHub declares 1 setting (token); Gitea declares 2 (url + token); GitLab declares 2 (url + token); Local declares zero (it's auto-created and `hidden: true`). No provider declares `panels` / `tools` / `menuItems` today — the contribution axis is **active code but not actively used** for those three slots. Documented here so future plugin-authored providers know the slot is open.

The **`glyph` field** (2.26.0) is a non-`contributes` decorative field — a 2-character badge for the connection-row UI ([`connections-tab.js#glyphFor`](../js/settings/connections-tab.js)). Falls back to the first two characters of the provider id uppercased. Informally optional but every shipping provider declares it (`GH` / `GT` / `GL` / `ZP`).

## Interaction matrix

### Shared contract (load-bearing, do not split)

- **Inheritance is shallow spread, not class extension.** `{ ...BASE_GIT_PROVIDER, ...provider }` at registration. Providers that want to "call super" must do so explicitly via `this.someBaseMethod` — but `this` is the merged object, so calling `this.compareRefs` from inside an override of `getBranchAheadBehind` reaches the override if there is one, falling through to base otherwise. **This is the standard prototype-chain semantic implemented via object merge.**
- **`contributes` is deep-merged.** Partial declarations (e.g. only declaring `settings: [...]`) compose with the base's empty arrays without losing the other slots. The merge happens at `register()` ([`registry.js:38-41`](../js/git-providers/registry.js)); subsequent in-place mutation of `merged.contributes` would not affect the source provider object.
- **`get capabilities()` is read via optional-chaining at every call site.** The `undefined → false` invariant lets GitLab's partial declaration ship without breaking dock buttons that gate on flags GitLab hasn't validated. Removing the `?.` at any read site is a silent regression for GitLab.
- **Circuit breaker is opt-in per provider.** Remote providers wrap their `request()` in `circuitBreakerGuard`; Local does not (has no `request()`). The base `request()` is unwrapped; future providers that want breaker semantics must wrap explicitly.

### Disjoint surfaces

- **Functional defaults are independent of `notSupported`.** A method with a functional default (e.g. `getBranchAheadBehind`) is *not* a `notSupported` method — it returns `{ ahead: null, behind: null }` on transitive failure, not a thrown error. Capability flags do not gate these defaults; the `null` return is the gate.
- **`testConnection` is not part of the capability matrix.** Every connection probes via the inherited base `testConnection` (or Local's trivial override). Capability flags describe *what runtime operations are supported*; `testConnection` is a register-time concern.
- **Provider-private helpers are not contracted.** Underscore-prefixed methods (`_walkContents` in GitHub, `_fetchRawDiff`/`_parseUnifiedDiff` in Gitea, `_getPipelineStatus` in GitLab, `_hash` in Local) are implementation details. Other code MUST NOT call them — there's no test pinning them as private.

### Open invariants (not asserted today)

- **No anti-regression test pins the base-interface shape against subclass overrides.** ICD-tool-registry cites two contract tests (`test-tools-registry-legal-groups.mjs`, `test-profile-filter-tools.mjs`) pinning their seam. This subsystem has **none**. A future PR could rename a base method (`getMergeConflicts` → `loadMergeConflicts`) and only the `Git` facade call sites would surface; the inherited functional default at the rename site would silently still exist under the old name and be dead code. The right antibody is a test that asserts `Object.keys(BASE_GIT_PROVIDER).sort()` matches an expected list at the source-of-truth axis grouping. Flagged as queued, not promoted.
- **No test asserts that capability-flag read sites match `get capabilities()` keys.** A future flag rename (`rerunCi` → `rerunFailedJobs`) would update only one side, silently disabling the button across providers. Mirror antibody to the above — pin the keys at test time. Flagged as queued, not promoted.
- **No test asserts the four functional-default transitive dependencies are matched.** Local inherits `getChangedFilesBetween` which calls `compareRefs` which Local doesn't override — runtime throw if ever called. Today the call site is guarded by capability flags, but the invariant is not encoded.

## Code-aware findings (feed back to ROADMAP as 2.50.0+ rows)

Authoring this ICD surfaced **three** drift items worth tracking. Per re-eval methodology, one goes to the next code minor's `[strong]` row; the others stay queued.

### 1. `getCommitDiff` is an informal extension across three providers, missing from the base

[`github.js:755`](../js/git-providers/github.js), [`gitea.js:639`](../js/git-providers/gitea.js), and [`gitlab.js:904`](../js/git-providers/gitlab.js) all declare a public `async getCommitDiff(connection, owner, repo, sha)` method with the same return shape: `{ sha, shortSha, message, author, date, files: [{path, status, additions, deletions, patch}] }`. **It is not declared in `BASE_GIT_PROVIDER`.** Consumers reach it via `provider.getCommitDiff(...)` directly — a typo or missing-provider-method would surface as `TypeError: provider.getCommitDiff is not a function` rather than `EditorError(GIT_NOT_SUPPORTED)`.

**Suggested fix shape for next code minor:** Add `getCommitDiff` to `BASE_GIT_PROVIDER` with a `notSupported` default. Single-file edit; the three existing overrides already conform to the shape. Local would inherit `notSupported`, which is correct (Local has no commits). The shape would also gain documentation symmetry with the other Diff/Compare methods.

**Why this matters:** The ICD describes the seam authoritatively; "this method exists on every remote provider but isn't part of the base" is exactly the kind of drift the program is meant to surface. A future fourth remote provider (e.g. Codeberg, Bitbucket) would currently land without it unless the author noticed the pattern by code-grep.

### 2. GitLab's `get capabilities()` returns only one declared flag

[`gitlab.js:1161`](../js/git-providers/gitlab.js) declares only `mergeConflictResolution: true`. The other five flags are `undefined`. The docstring at lines 1155-1158 explicitly rationalizes this — each flag flips on per-slice with live testing — but the production read sites depend on every consumer using optional-chaining. If a future consumer at e.g. `js/pr-review/some-new-feature.js` reads `capabilities.merge === true` without the `?.`, it throws `TypeError: Cannot read properties of undefined (reading 'merge')` on GitLab.

**Suggested fix shape (queued, not promoted):** Add a test at `tests/test-provider-capabilities-shape.mjs` that asserts every provider's `get capabilities()` returns an object with all six keys explicitly declared (true or false, no `undefined`). Forces GitLab to flip the five undeclared flags to explicit `false`. The behavior change is zero (current readers already see `false` via `?.`); the antibody is against silent regressions when a future read site forgets `?.`.

### 3. ~~`resolveReviewThread` is dead code today~~ ✅ resolved at 2.60.0

~~[`base.js:594`](../js/git-providers/base.js) declares the method; no provider overrides. `threadResolve` capability is `false` everywhere. The `PrReviewDock.js` does not currently read `threadResolve`. The only reference is a docstring at `base.js:582` explaining the dead-code status.~~

**Resolution (2.60.0):** Demote option taken. The `resolveReviewThread` method removed from [`base.js`](../js/git-providers/base.js), the [`git.js`](../js/git.js) facade removed, and the lone `notSupported`-throw test at [`test-pr-review-provider-shape.mjs`](../tests/test-pr-review-provider-shape.mjs) removed. **The `threadResolve` capability flag is retained on the 6-flag matrix** — the slot still documents the intentional gap (Gitea has no first-class thread state; GitHub requires GraphQL), and a future GraphQL-capable provider re-adds the method behind that flag without re-litigating the shape pinned by [`test-provider-capabilities-shape.mjs`](../tests/test-provider-capabilities-shape.mjs). Mirrors the inverse rule applied at 2.50.0: `getCommitDiff` was *promoted* because it had real concrete-provider overrides; `resolveReviewThread` is *demoted* because it had none.

### Other observations (not promoted)

- **GitLab exposes a public `getWebUrl(connection)` not present on the base** ([`gitlab.js:95`](../js/git-providers/gitlab.js)). Used by GitLab's own `getWorkflowRunLogs` + `getCommits` to build web-facing URLs. Documented as provider-private extension; not promoting to base because the URL-stripping logic is GitLab-specific (other providers' base URLs and web URLs are already aligned).
- **Provider-side timeout constants are duplicated** — `REQUEST_TIMEOUT = 15_000`, `WRITE_TIMEOUT = 30_000`, `HEAVY_TIMEOUT = 60_000` declared identically in `github.js`, `gitea.js`, `gitlab.js`. Hoisting to `base.js` would centralize but the values would still be referenced via `this.REQUEST_TIMEOUT`, which is exactly the override pattern. Not drift; documented as pattern.
- **`HEALTH_ENDPOINT` varies by provider** — `/rate_limit` (GitHub), `/version` (Gitea + GitLab). Per-provider constant on the override. Not a base concern.
- **Local declares `hidden: true`** — informally optional field consumed by `connections-tab.js` to hide Local from the provider dropdown. Document as informal pattern; one-line note in the ICD's seam table.

## Why the surface resists consolidation

A natural-looking refactor is "split base.js by axis — auth/transport.js, repos.js, issues.js, prs.js, ci.js." That has been considered and deferred for three reasons:

1. **The seam is the merge target, not the declaration site.** `register()` ([`registry.js:36`](../js/git-providers/registry.js)) does `{ ...BASE_GIT_PROVIDER, ...provider }` — splitting the source would either require composing the base from multiple imports (clutter) or doing the merge per-axis (admission complexity for zero runtime benefit).
2. **Providers are object literals.** Splitting the base by axis would not change how providers are written — they'd still be one big object literal with 30–55 method keys. The split would be invisible to the implementer.
3. **The composability seam is already documented across the boundary.** Each functional-default carries its own rationale + transitive-dependency note inline; the per-method jsdoc + the @since version tags are the contract. An axis-split file structure would obscure the @since cross-references that document slice history (`@since 2.13.0`, `@since 2.18.0`, `@since 2.13.2`).

The split remains a future option if the surface grows past ~75 methods and the file crosses ~1500 LOC; today, 55 methods × 1 file is below the cognitive-load threshold that justifies a split.

## Forward-evolution rules

### When adding a new provider

1. **Create `js/git-providers/<id>.js`** as a plain object literal — no class, no `extends`.
2. **Declare the seven non-callable fields** (`id`, `name`, `icon`, `glyph`, `description`, `fixedUrl`, `contributes`). `glyph` is informally optional but every shipping provider has one.
3. **Override `getHeaders` + `getBaseUrl` + `request`** at minimum. The inherited base `request()` is Gitea-shaped and will not work for non-Gitea APIs. Wrap your override's body in `circuitBreakerGuard(connection)` + `try/catch` + `markUnreachable`/`markReachable` if the provider supports a network breaker.
4. **Implement the methods your provider supports.** Leave the rest inherited. The base's `notSupported` default produces an LLM-actionable error; safe-empty defaults (`getLanguages` → `null`, all `listWorkflow*` → `[]`/`null`) handle feature-detection automatically.
5. **Declare `get capabilities()` if your provider supports any PR Review features.** Six flags, defaulting to `false`. Declare all six explicitly (true or false, no `undefined`) — the optional-chaining invariant is fragile.
6. **Register in [`index.js`](../js/git-providers/index.js).** Import + call `GitProviderRegistry.register(myProvider)`.
7. **Add the test seam.** No test pins the base shape today (open invariant); your new provider should at minimum cover its overrides with happy-path tests at `tests/test-<id>-*.mjs` (Node) or `tests/<id>-tests.js` (browser).

### When adding a new base method

1. **Pick the default mode.** Most additions take `notSupported` — the provider that owns the use case overrides at the same time. Safe-empty (`null`/`[]`) is for feature-detection paths only. Functional defaults are for methods that decompose cleanly into existing base methods.
2. **Document the @since tag in jsdoc.** Mirror existing patterns (`@since 2.13.0` for PR Review slices; `@since 2.18.0` for Merge Conflict slices; `@since 2.26.0` for the `glyph` field).
3. **If the method has a typedef return shape, declare it at the top of `base.js`** alongside `BlameData`, `PullRequestData`, `PRFileChange`, `CommitStatus`.
4. **If the new method gates a UI button via a capability flag, add the flag to `get capabilities()` first.** Default to `false`. Update each concrete provider's `get capabilities()` override in the same PR or a follow-up — the `undefined → false` invariant means a partial rollout is safe, but explicit declarations are preferred.
5. **Update this ICD's "per-axis contract" section.** Failure to surface a new method here is the drift the program is designed to prevent.

### When adding a capability flag

1. **Add the flag to `base.js`'s `get capabilities()` default** with `false` value. All six flags must be declared in the base default; this is the registration-time validation surface.
2. **Update every concrete provider's `get capabilities()` override.** Even providers that don't support the new feature should declare `false` explicitly — the `undefined → false` invariant works but explicit declaration is the safer pattern.
3. **Add the read site with optional-chaining.** `capabilities?.newFlag === true` — never `capabilities.newFlag` without `?.`. The pattern is enforced by inspection, not by a lint rule.
4. **Document the read site in this ICD's Capability axis section.**

### When changing the circuit breaker

1. **`CIRCUIT_COOLDOWN_MS` is per-app, not per-provider.** Changing it affects all providers; per-provider cooldowns would require splitting the breaker module first.
2. **`healthProbe` must NOT call `request()`.** It's a raw `fetch` that bypasses the breaker — calling `request()` would create a recursive guard check.
3. **The breaker is opt-in.** Local doesn't have a `request()`; adding the breaker to the base `request()` would silently affect Local (which inherits the base) — don't.

## References

- **Source:** [`js/git-providers/base.js`](../js/git-providers/base.js) (55 methods + 1 getter + circuit breaker + health probe); concrete providers [`github.js`](../js/git-providers/github.js), [`gitea.js`](../js/git-providers/gitea.js), [`gitlab.js`](../js/git-providers/gitlab.js), [`local.js`](../js/git-providers/local.js); [`registry.js`](../js/git-providers/registry.js) (`register` does the shallow-spread merge + deep-merge `contributes`); [`index.js`](../js/git-providers/index.js) (boot-time registration of the four built-ins).
- **Production consumers:** [`js/git.js`](../js/git.js) (facade resolving active `connection` → `provider`), [`js/pr-review/PrReviewDock.js`](../js/pr-review/PrReviewDock.js) (capability flags 1–3 of 4), [`js/pr-review/PrReviewSurface.js`](../js/pr-review/PrReviewSurface.js) (`reviewSubmission` flag at 4 sites), [`js/pr-review/PrMergeControls.js`](../js/pr-review/PrMergeControls.js) (`mergeConflictResolution` flag), [`js/intelligence/retrieval/`](../js/intelligence/retrieval/) (consumes `getChangedFilesBetween` functional default for delta-indexing), [`js/settings/connections-tab.js`](../js/settings/connections-tab.js) (`glyphFor` + `contributes.settings`).
- **Design contracts:** [`docs/DESIGN-git-providers-and-ui-extensions.md`](DESIGN-git-providers-and-ui-extensions.md) — historical-shape 1.1.0 minimum-viable surface; this ICD is the current-shape source of truth. [`docs/PROFILES_AND_TOOLS.md`](PROFILES_AND_TOOLS.md) — provider-contributed tool admission (renamed from `ROLES_AND_TOOLS.md` at 2.57.0). [`docs/SECURITY.md`](SECURITY.md) — untrusted-issue-content wrap markers (`<UNTRUSTED_*>` from issue/PR bodies pass through provider methods unchanged).
- **Cross-ICD:** [`ICD-tool-registry.md`](ICD-tool-registry.md) §"Per-export contract" → `ToolRegistry.execute` is where `EditorError` from base `request()` becomes the LLM-visible `{ error, code }`. [`ICD-chat-handlers.md`](ICD-chat-handlers.md) §"Envelope contract" pins the downstream shape.
- **Tests:** None pin the base-interface shape today (see §"Open invariants"). Closest existing: [`tests/test-pr-review-submit-payload.mjs`](../tests/test-pr-review-submit-payload.mjs) (pure-mapper tests for GitHub + Gitea review-submit payloads), [`tests/test-git-providers-*.mjs`](../tests) (happy-path coverage per provider).
- **Methodology:** [`ROADMAP.md`](ROADMAP.md) §"Per-subsystem ICD backfill program" (this ICD is target #4; target #5 will be one of editor instance / retrieval manager / profiles registry / MCP bridge / plugin lifecycle at the next re-eval slot).
- **History anchors:** 1.1.0 (provider abstraction extracted from monolithic `js/gitea.js`); 2.13.0 (Touch 3 PR Review slice 2 — `submitPullRequestReview` + `createReviewComment` + `capabilities` flags 1, 4); 2.13.2 (`rerunWorkflowJobs` + `rerunCi` capability); 2.18.0 (Touch 3 Merge Conflict Resolver slice 1 — `getMergeConflicts` functional default + `mergeConflictResolution` capability); 2.19.0 (slice 2 — GitLab flips `mergeConflictResolution: true`); 2.26.0 (`glyph` field for connection-row badges); 2.46.0 (last shipped code minor before this re-eval); 2.47.0+ (retrieval Composer cleanup + tool-loop core extraction + sub-agents Phase 1 — all upstream of this ICD).
