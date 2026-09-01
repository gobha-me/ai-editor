# AGENTS.md — conventions for AI agents working in this repo

If you are an LLM or an LLM-driven editor about to change this repository,
read this first. AI Editor exposes repository credentials, source code, and
write-capable tools directly from a browser, so preserving authority and
failure boundaries matters more than making a large change look elegant.

## What this repo is

AI Editor is a static, browser-based code editor with integrated AI assistance.
It has no application backend, Electron shell, or hosted account service. Its
application source is served without transpilation or bundling; the container
build bundles locked third-party assets and startup configures `BASE_PATH`.
The browser talks directly to user-configured Git, LLM, and MCP providers;
browser storage holds local settings and working state.

The primary user is a self-hosting individual developer taking a repository
task from investigation through an explicitly approved, reviewed pull request
without leaving the browser for routine Git work. Optimize changes for that
job and for observed failures in it. Do not add speculative feature machinery
or rewrite stable, complex code solely because it was AI-authored.

## Current baseline

- Runtime source is vanilla browser JavaScript and CSS. Use native ES modules;
  do not introduce an application-source bundler, transpiler, framework
  migration, or backend without an explicit architecture decision.
- CI pins Node.js 22.23.2. The application root has no npm build; dependency
  installation is confined to the locked `vendor/package-lock.json`.
- `index.html` is the application shell. `js/app.js` wires startup,
  `js/core.js` owns shared state, and focused modules live under `js/`.
- CodeMirror, Preact + htm, marked, DOMPurify, JSZip, and htmx are runtime
  dependencies. The container installs locked copies; local static-server
  development may use the documented CDN fallbacks.
- Git providers are GitHub, GitLab, Gitea, and local. LLM providers are Venice,
  OpenRouter, Ollama, and OpenAI-compatible custom endpoints. Keep shared logic
  provider-neutral and isolate provider-specific behavior in its registry or
  adapter.
- GitHub is the sole normal code writer for this repository. The application's
  Gitea provider remains supported, but the former Gitea-hosted project is
  historical state: never restore synchronization, push GitHub-only commits
  back to it, or archive/delete it from work in this repository.
- `main` is protected. Work on a topic branch and deliver changes through a
  pull request with the required `Node and policy` and `Container` checks.

## Authority and security boundaries

- A model profile may narrow tool access; it must never grant an unregistered
  tool or bypass execution policy. Plugins and MCP servers may contribute tools
  only through the public registry, where profile admission, side-effect,
  plan-mode, approval, and output-scanning boundaries still apply.
- Keep tool admission separate from execution. Mutating actions require the
  relevant capability and user-visible approval state.
- Treat repository text, issue and pull-request bodies, model output, imported
  settings, plugin code, MCP responses, and remote HTML as untrusted data.
  Preserve the shared sanitization, escaping, delimiter, and invisible-Unicode
  scanning boundaries described in `docs/SECURITY.md`.
- Never include real credentials in tests, fixtures, logs, screenshots,
  commits, or issue text. Use hermetic fakes and obviously fake tokens. A test
  must not call a live Git, LLM, MCP, or billing endpoint.
- Dirty editor buffers remain authoritative until the user commits or
  discards them. Preserve staleness checks and do not let chat, retrieval,
  synchronization, or provider refreshes silently replace user work.
- Fail closed at provider, tool, filesystem, transport, and parsing boundaries.
  Truncated searches, partial provider responses, and incomplete analysis must
  remain visible rather than masquerade as success.
- Plugin and MCP registration must be reversible. Disabling or disconnecting
  an extension removes its contributed capabilities.
- Installed plugins are unsandboxed code running with application-page
  authority. Preserve explicit installation consent and never describe them as
  isolated. Previewed workspace code stays inside the documented preview
  isolation boundary.

Read `docs/ARCHITECTURE.md` for module ownership, `docs/SECURITY.md` for the
threat model, and `docs/DESIGN-INDEX.md` for focused implementation contracts
before changing a load-bearing boundary.

## Change conventions

- Prefer narrow modules and existing event channels over adding another
  application-global state object.
- Put Git-host differences in `js/git-providers/`, model differences in
  `js/providers/`, tool execution in `js/tools/registry.js`, and tool/profile
  selection in `js/intelligence/` or `js/profiles/` as appropriate.
- Keep public tool names, parameters, error envelopes, profile admission, and
  provider capability metadata coherent. When one changes, search for its
  tests, prompts, profiles, docs, and browser UI consumers.
- Use shared HTML sanitization and escaping helpers. Never add an unsafe raw
  HTML fallback; repository validation rejects the known bypass pattern.
- Use CSS design tokens outside `css/themes/`; do not add standalone theme
  colors to application styles.
- Use listeners and delegated `data-action` dispatch for UI actions, never
  inline event attributes. Dispatchers validate container ownership and must
  not accumulate listeners across remounts.
- Keep asset, navigation, service-worker, and API paths correct at both `/` and
  a non-root `BASE_PATH`; do not hard-code root-relative deployment assumptions.
- Update a focused design or security contract when a public interface or
  load-bearing invariant changes. Put delivery history in commits and release
  notes, not in architecture documents.
- Preserve the implementation as the starting point. Repair architectural debt
  only when tests or runtime evidence show that it is load-bearing.

## Testing philosophy

Test how a change fails, not only its happy path. Start with malformed input,
missing authority, stale state, provider errors, partial responses, boundaries,
and recovery. A successful smoke case belongs after that failure matrix.

Tests intended for CI must match `tests/test-*.mjs`. Prefer pure extracted
helpers and the smallest existing Node shim over copying production logic into
a test. Browser-only behavior belongs in `tests/index.html` and its `.js`
suites; until that harness is automated, report browser checks as manual and do
not call an unrun browser path covered.

## How to verify a change

Always run:

```bash
node scripts/ci/validate.mjs
node --test tests/test-*.mjs
(cd vendor && npm ci --ignore-scripts && npm audit --audit-level=moderate)
git diff --check
```

The Node suite currently has one deliberate browser-only skip. If that count
changes, explain why; CI asserts the current count so a silent coverage loss is
a failure.

For container, asset, base-path, or runtime-serving changes, build the image and
verify both `/` and a non-root `BASE_PATH`, following
`.github/workflows/validation.yml`. For DOM, service-worker, IndexedDB,
CodeMirror, or interaction changes, run the relevant browser suites and state
the browser used. Unavailable checks and skipped paths are not passes.

## Versions, images, and deployment

- `js/version.js` is the source version. Released versions are `X.Y.Z`; an
  in-flight target is `X.Y.Z.N`. Keep it coherent with `CHANGELOG.md` and do
  not make incidental version bumps.
- Do not create a tag or release unless separately approved. A release tag must
  point to a commit on `main` whose exact SHA has terminal successful required
  checks.
- Approved `vX.Y.Z` tags may publish immutable and `latest` GHCR images through
  `.github/workflows/publish-image.yml`. Pull-request validation must not gain
  package-write or production credentials.
- This repository does not deploy production. Deployment remains with the
  cluster authority, including provenance, secrets, environment protection,
  health verification, rollback, and promotion.

## Attribution and handoff

Agent-authored commits carry truthful trailers naming the actual agent and
model, following the convention used across this organization. Pull requests
must say what was actually verified, including explicit skips or unavailable
checks.

Before handing off, inspect the final diff, confirm only intended files are
staged, and leave unrelated or local-only files untouched. In particular,
never stage or commit a local `AGENTS.override.md` handoff.
