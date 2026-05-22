# Contributing to AI Editor

Conventions for working in this repo. The product itself has its own docs (see [ARCHITECTURE.md](docs/ARCHITECTURE.md), [ROADMAP.md](docs/ROADMAP.md), [DESIGN-*.md](docs/)); this file covers the *workflow* — how PRs reference tickets, how versions get bumped, and how the two trackers (gitea + github) compose.

## Tracker layout

The project lives on two hosts:

- **Gitea (`git.gobha.me/xcaliber/ai-editor`) — primary.** All code, all PRs, and most issues. Use [`tea`](https://gitea.com/gitea/tea) (`tea issues list`, `tea pulls create`) to interact.
- **GitHub (`github.com/gobha-me/ai-editor`) — read-only code mirror + a separate public issue tracker.** Use [`gh`](https://cli.github.com) for issues there.

Tickets carry independent numbering. Prefix as **`gitea#N`** or **`github#N`** in prose (changelog entries, ROADMAP rows, code comments, PR bodies) so the tracker is unambiguous. Reserve the bare `#N` form for one purpose only — the close keyword (next section).

## PR close keywords

Gitea auto-closes a referenced issue when a PR is merged to the default branch, *if* the PR body or a commit message contains one of these forms:

| Form | Closes |
|---|---|
| `Closes #N` (or `Fixes #N`, `Resolves #N`) | Issue `N` in **this same repo**. |
| `Closes xcaliber/ai-editor#N` | Same as above, explicit form. |
| `Closes xcaliber/HTML-Games#N` | Issue `N` in a different repo on the same gitea instance. |

Supported keywords: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` (and `reopen`/`reopens`/`reopened` for the inverse).

**Do not use `Closes gitea#N`.** Gitea parses `gitea` as the owner of a cross-repo reference, finds no repo, and silently skips the close action. Four shipped tickets (#493/#496/#499/#500) stayed open through 2.84.0–2.88.0 because of this exact mistake. The fix landed in 2.89.0 (this PR self-demonstrates by closing all five).

**Reserve `gitea#N` and `github#N` for prose.** In CHANGELOG.md / ROADMAP.md / code comments / the descriptive body of a PR, the prefixed forms are the right disambiguator. In the close-keyword line at the top of the PR body, drop the prefix.

### GitHub issues — manual close

GitHub issues do not auto-close from gitea PR merges (no cross-host hook). After shipping work that resolves a `github#N` ticket, close it manually:

```bash
gh issue close N --repo gobha-me/ai-editor --comment "Shipped at vX.Y.Z (gitea#M)."
```

Batch-closing in admin sweeps is fine — just don't expect the PR merge to do it for you.

## Version + CHANGELOG

- **Feat / fix PRs** bump `js/version.js` and promote the `[Unreleased]` block in [CHANGELOG.md](CHANGELOG.md) to a numbered section in the same PR. Version coherence is gated by [`tests/test-version-coherence.mjs`](tests/test-version-coherence.mjs).
- **Docs-only / measurement-only PRs** accumulate in `[Unreleased]` without a version bump. Examples: re-eval slots, design-doc churn, probe/benchmark code that ships no behavior change. Per `feedback_no_bump_for_measurement_only`.
- **In-track patches** (`X.Y.Z.N`) carry a single tag covering many sub-step closures. See [ROADMAP.md §"2026-Q2 code audit"](docs/ROADMAP.md) for the established shape.

## PR workflow

1. Branch off `main`: `git checkout -b feat/gitea-NNN-short-description` (or `fix/...`, `docs/...`).
2. Implement; add/extend tests under [`tests/`](tests/). The Node suite (`*.mjs` files) runs in CI; browser-only tests live in `tests/index.html` and are manual.
3. Bump `js/version.js` and promote `[Unreleased]` if the PR ships behavior. Both gated by the coherence lint.
4. Commit with `feat(X.Y.Z): description (gitea#N)` or `fix(X.Y.Z): description (gitea#N)` in the subject. The `gitea#N` in the subject is prose (human disambiguation); the close keyword goes in the PR body.
5. Open the PR via `tea pulls create`. PR body leads with `Closes #N.` (bare). Body mirrors the recent PRs' shape — Summary / Test plan / Sibling pattern / CI ticks. See [PR #503](https://git.gobha.me/xcaliber/ai-editor/pulls/503) as a recent example.
6. After merge, verify gitea closed the referenced issues. If any github issues were also addressed, close them manually via `gh`.
