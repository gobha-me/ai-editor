# Changelog

This file tracks public releases from the GitHub-authoritative project. Older
release notes remain available in Git history, signed/tagged source history, the
GitHub Releases page, and the offline Gitea collaboration archive.

## [Unreleased]

Current source is `2.94.0.1`, an in-flight build targeting the next public
`v2.94.0` release. It includes all source changes on `main` after `v2.93.0`.
The former 2.94–2.96 changelog headings were internal working labels: no matching
Git tags or GitHub Releases were published, so they are not public versions.

### Changed

- Established GitHub as the sole normal code writer with least-privilege PR and
  `main` validation.
- Added locked, reproducible container builds and approved-tag-only GHCR
  publication with no deployment authority.
- Reframed the product roadmap around the core repo-to-PR job and observed
  failures instead of release cadence.
- Consolidated implementation contracts and removed duplicate or historical
  planning context from the active tree.
- Made MCP transport handling fail closed on legacy HTTP+SSE and updated the
  bundled Firecrawl and Linear starters to their Streamable HTTP endpoints.

## [2.93.0] - 2026-05-22

Last verified public release before the GitHub authority transition. See the
[GitHub Release](https://github.com/gobha-me/ai-editor/releases/tag/v2.93.0) and
tagged source for the complete contents.
