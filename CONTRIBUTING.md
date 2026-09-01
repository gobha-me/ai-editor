# Contributing to AI Editor

GitHub [`gobha-me/ai-editor`](https://github.com/gobha-me/ai-editor) is the sole
normal code authority. Gitea remains a supported product-side Git provider, but
the retired `xcaliber/ai-editor` repository is not a code destination.

Historical `gitea#N` references in code, design documents, and the changelog are
stable provenance. New work uses GitHub issues and pull requests. Do not
bulk-import old Gitea issues; promote an item only when it maps to a current,
user-visible outcome and retain its original identifier in the new issue.

## Pull request workflow

1. Create a short-lived `feat/`, `fix/`, `docs/`, or `chore/` branch from
   `main` in an isolated worktree when another session may share the checkout.
2. Make the narrowest evidence-backed change and add regression coverage.
3. Run `node scripts/ci/validate.mjs`, `node --test tests/test-*.mjs`, the locked
   dependency audit, and the relevant container/browser checks.
4. Open a GitHub pull request with a summary, test results, risks, and issue
   references. Use `Fixes #N` only when the PR fully resolves that GitHub issue.
5. Require the `Node and policy` and `Container` checks on the exact head SHA.
   Address review threads before squash-merging and delete the topic branch.
6. Wait for terminal `Validation` success on the exact merge SHA before calling
   the change delivered.

`main` requires a pull request and green checks. A second-person approval is not
mandatory for the solo-maintainer workflow; force-pushes, deletion, and merge
commits are not part of normal delivery.

## Version and changelog

- `js/version.js` and the latest released `CHANGELOG.md` heading must agree for
  a released `X.Y.Z` build.
- Multi-PR work may use `X.Y.Z.N` while its entries remain under `Unreleased`.
  Four-segment versions are never tagged or published.
- Changes that do not alter served behavior stay under `Unreleased` without a
  release. Release timing follows product value and readiness, not cadence.
- Historical versions and tags are immutable.

See [docs/VERSIONING.md](docs/VERSIONING.md) for the release gate.

## Release and image policy

Git tags, GitHub Releases, and GHCR images belong to this repository. Deployment
does not.

1. Merge the release-ready change and wait for both required `Validation` jobs
   to succeed on the exact merge SHA.
2. Confirm `js/version.js`, `CHANGELOG.md`, and the intended annotated
   `vX.Y.Z` tag agree.
3. Create the tag only after that evidence exists. The tag workflow verifies the
   commit is on `main` and rechecks the exact-SHA conclusions before publishing
   `ghcr.io/gobha-me/ai-editor:vX.Y.Z` and `latest` with SBOM and provenance.
4. Confirm the immutable digest and public package visibility, then create the
   GitHub Release from the approved changelog.

Do not publish a release to prove a migration, and do not add cluster credentials
or deployment steps to product workflows.
