# AI Editor Roadmap

GitHub is the code authority. This roadmap states product outcomes and promotion
signals; Git history records how the implementation arrived here.

## User, job, and promise

The primary user is a self-hosting individual developer who wants to work on a
Git-hosted repository from a browser while retaining control over credentials,
edits, commits, and merges.

The core job is to take a repository task from understanding through an
explicitly approved, reviewed pull request without losing work or leaving the
browser for routine Git operations.

AI Editor promises a Git-native, provider-flexible workspace where the model can
help investigate and edit while user-visible approval boundaries remain
authoritative.

## Current pain

- The implementation has broad capability without a current baseline showing
  which parts of the repo-to-PR loop are reliable in representative use.
- Earlier planning generated features and release labels faster than evidence
  about the primary user job.
- One browser-only test remains outside automated CI; manual checks must remain
  explicit until that path becomes hermetic.

## Delivered foundation

GitHub is the sole normal code writer. Every pull request and `main` commit gets
the same least-privilege Node, policy, dependency, container-build, and runtime
checks. Approved release tags have a separate GHCR publication path. Production
deployment remains outside this repository.

## Now: establish the core-loop baseline

Use representative issue-to-PR dogfood sessions to identify the first
load-bearing failure in task understanding, approval, editing, recovery,
verification, or review. Record the failure before scheduling a repair.

Success signals:

- Representative sessions complete without lost edits or bypassed approvals.
- Failures are reproducible and tied to a user-visible outcome before code is
  refactored.
- Stable complex code is left alone when the baseline finds no defect.

## Next

- Repair the highest-impact reproducible core-loop blocker, with a regression
  test at the narrowest stable boundary.
- Convert browser-only coverage to hermetic tests when the uncovered path affects
  the core job; do not chase a coverage percentage as an objective.
- Keep the issue queue actionable: close shipped work promptly and preserve old
  Gitea identifiers as provenance without importing its backlog.

Promotion signal: a repeatable dogfood failure or multiple reports showing the
same blocked outcome.

## Later

- MCP discovery or OAuth after demonstrated configuration friction and an
  explicit credential-authority contract.
- Parallel delegated tasks after the shipped single-child boundary repeatedly
  blocks the core loop and cost/cancellation behavior is specified.
- Cross-device settings transfer after repeated demand and an explicit
  credential, trust, and recovery model.
- User-authored profiles after a concrete extension need cannot be met by the
  shipped registry.

Later concepts do not keep placeholder issues open. Promotion creates a fresh
issue with current evidence and acceptance criteria.

## Deliberate deferrals

- Kubernetes deployment, cluster credentials, environments, rollback, and live
  promotion belong to the cluster authority, not this repository.
- No preview or `edge` image channel; release images are tag-only.
- No wholesale rewrite, framework migration, collaborative editing, plugin
  marketplace, persona system, or multimodal architecture without new evidence.
- Release frequency and scheduled re-evaluation slots are not product outcomes.

Current architecture, DESIGN, and security documents describe implemented
contracts. Git history is the record of superseded plans and rationale.
