# Git Provider Contract

**Status:** Implemented for GitHub, Gitea, GitLab, and local repositories.

`js/git-providers/base.js` defines the provider-neutral operation surface;
provider modules translate remote APIs into that shape. `js/git-providers/registry.js`
owns configured instances and reachability state.

## Invariants

- Provider methods return normalized repositories, branches, files, commits,
  issues, pull requests, reviews, and CI records. Provider-specific fields remain
  optional raw evidence, not required application state.
- Paths, owner/repository identifiers, refs, pagination, draft state, and binary
  content are normalized at the provider boundary.
- Create/update operations distinguish idempotent existing state from genuine
  failure. Events fire only after confirmed mutation.
- Authentication failures, rate limits, unreachable hosts, and malformed
  responses remain distinguishable. A failed health check marks the connection
  unreachable until a successful probe restores it.
- Pull-request mergeability, draft status, reviews, and CI conclusions are not
  inferred from missing provider fields.
- Local repositories implement the same useful subset without pretending to
  support remote-only issue, PR, or CI operations.

UI slots and provider extensions consume normalized results; they do not branch
on host-specific response bodies. Provider tests pin encoding, pagination,
idempotency, response parsing, reachability, and cross-provider parity.
