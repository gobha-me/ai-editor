# AI Editor Roadmap

> Reset 2026-09-01. GitHub is the code authority. The changelog records shipped
> work; this document states product outcomes, evidence, and deliberate deferrals.

## User, job, and promise

The primary user is a self-hosting individual developer who wants to work on a
Git-hosted repository from a browser while retaining control over credentials,
edits, commits, and merges.

The core job is to take a repository task from understanding through an
explicitly approved, reviewed pull request without losing work or leaving the
browser for routine Git operations.

AI Editor promises a Git-native, provider-flexible workspace where the model can
help investigate and edit, but user-visible approval boundaries remain
authoritative.

## Current pain

- The implementation has broad capability, but delivery depended on a privileged
  Gitea workflow that mixed validation, image publication, and deployment.
- The previous roadmap optimized release and review cadence instead of the
  reliability of the core user job.
- Recent dogfood findings concentrated on recovery and visibility in the
  repo-to-PR loop, while several public issues describe speculative future
  capabilities rather than current blockers.
- One browser-only test remains outside automated CI; manual checks must remain
  explicit until that path becomes hermetic.

## Now

### Trustworthy GitHub delivery

Outcome: every pull request and `main` commit receives the same least-privilege
Node, source-policy, dependency, container-build, and runtime checks. Future
release images are produced by a separate tag-only GHCR workflow. Production
deployment is not a repository workflow.

Success signals:

- Required checks pass on the exact PR and merge SHAs.
- Locked dependencies audit cleanly at moderate severity or higher.
- The pinned container builds and serves both `/` and a configured sub-path.
- No PR or `main` validation job receives production secrets or write authority.

### Establish the core-loop baseline

Outcome: use representative issue-to-PR dogfood sessions to identify the first
load-bearing failure in task understanding, approval, editing, verification, or
review. Record the failure before scheduling a repair.

Success signals:

- Representative sessions complete without lost edits or bypassed approvals.
- Failures are reproducible and tied to a user-visible outcome before code is
  refactored.
- Stable complex code is left alone when the baseline finds no defect.

## Next

- Repair the highest-impact reproducible core-loop blocker, with a regression
  test at the narrowest stable boundary.
- Convert critical browser-only coverage to hermetic tests when the missing path
  affects the core job; do not chase a coverage percentage as an objective.
- Curate GitHub issues by observed user impact. Close shipped work promptly and
  preserve historical Gitea identifiers without bulk-importing the old tracker.

Promotion signal: a repeatable dogfood failure or multiple reports showing the
same blocked outcome.

## Later

- [GitHub #27](https://github.com/gobha-me/ai-editor/issues/27): MCP discovery
  and OAuth, after a security contract and demonstrated configuration friction.
- [GitHub #24](https://github.com/gobha-me/ai-editor/issues/24): parallel
  sub-agents, after delegated work repeatedly blocks the core loop.
- [GitHub #18](https://github.com/gobha-me/ai-editor/issues/18): cross-device
  settings sync, after repeated demand and an explicit trust/recovery model.
- User-authored profiles and a larger 3.x product amendment remain preserved
  concepts, not scheduled commitments.

## Deliberate deferrals

- Kubernetes deployment, cluster credentials, environments, rollback, and live
  promotion belong to the cluster authority, not this repository.
- No preview or `edge` image channel; release images are tag-only.
- No wholesale rewrite, framework migration, collaborative editing, plugin
  marketplace, persona system, or multimodal architecture without new evidence.
- Release frequency and scheduled re-evaluation slots are not product outcomes.

Existing DESIGN, ICD, architecture, and security documents remain contracts
where they match the implementation. Version-stamped narratives and methodology
documents are evidence of earlier decisions, not an automatic work queue.
