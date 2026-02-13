# Git Provider Setup

AI Editor connects to your Git host via its REST API. This guide covers the minimum token permissions for each provider and what the editor actually does with them.

## What the Editor Needs

The editor performs these operations through the Git API:

| Operation | Used by |
|-----------|---------|
| List repositories | Project selector |
| Create repository | New Project button |
| List/create/delete branches | Branch management |
| Read/write/delete file contents | Editor, file tree, commits |
| Read file blame | Blame pane |
| Read commit history | History pane, blame |
| List/create/update issues | Issue panel, AI tools |
| Read/write issue comments | Issue triage, AI tools |
| List/create/merge pull requests | PR panel, AI tools |
| Read PR files, diffs, comments | PR detail modal |
| Read CI/CD run status and logs | CI badge in PR modal |

All communication is browser → Git host. No data passes through any backend.

---

## Gitea

### Create a Token

1. Go to **Settings → Applications** (or `https://your-gitea/user/settings/applications`)
2. Under **Manage Access Tokens**, enter a token name
3. Select permissions:

| Permission | Level | Why |
|------------|-------|-----|
| **repository** | Read and Write | Read files, commit changes, manage branches |
| **issue** | Read and Write | List, create, update issues and comments |
| **user** | Read | Test connection, list your repos |

4. Click **Generate Token** and copy it immediately

**Optional permissions:**

| Permission | Level | Why |
|------------|-------|-----|
| **package** | Read | Required only if your Gitea instance gates repo access behind package scopes |
| **organization** | Read | List organization repos (only needed if your repos are in orgs) |

### Connection Settings

| Field | Value |
|-------|-------|
| Provider | Gitea |
| URL | `https://your-gitea-instance.com` (no `/api/v1` suffix) |
| Token | The token you just generated |

### Notes

- Gitea's token scopes are granular. The editor uses `repository`, `issue`, and `user` scopes. The `admin` and `sudo` scopes are never needed.
- Self-hosted Gitea with self-signed certificates: the browser must trust the certificate. Add it to your OS/browser trust store.
- CI/CD status: the editor reads Gitea Actions run status. No additional scope needed beyond `repository`.

---

## GitHub

### Create a Personal Access Token

**Fine-grained tokens (recommended):**

1. Go to **Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set repository access to **All repositories** or select specific repos
4. Set permissions:

| Permission | Level | Why |
|------------|-------|-----|
| **Contents** | Read and Write | Read files, commit changes |
| **Issues** | Read and Write | List, create, update issues |
| **Pull requests** | Read and Write | Create, review, merge PRs |
| **Metadata** | Read | Required — always included automatically |

5. Click **Generate token** and copy it

**Classic tokens (simpler but broader):**

1. Go to **Settings → Developer Settings → Personal Access Tokens → Tokens (classic)**
2. Select scopes:

| Scope | Why |
|-------|-----|
| **repo** | Full repository access (contents, issues, PRs, branches) |
| **read:org** | List organization repos (only if your repos are in orgs) |

### Connection Settings

| Field | Value |
|-------|-------|
| Provider | GitHub |
| URL | `https://api.github.com` (for github.com) or `https://github.example.com` (for GitHub Enterprise) |
| Token | Your personal access token |

### Notes

- GitHub Enterprise Server: the editor automatically appends `/api/v3` to non-api.github.com URLs.
- Fine-grained tokens are scoped per-repository. If you add a new repo later, you may need to update the token's repository access.
- CI/CD status: the editor reads GitHub Actions workflow runs and check runs. Covered by the `repo` scope or the **Actions: Read** fine-grained permission.
- The editor never requests `admin`, `delete_repo`, or `workflow` write permissions.

---

## GitLab

### Create a Personal Access Token

1. Go to **Preferences → Access Tokens** (or `https://gitlab.com/-/user_settings/personal_access_tokens`)
2. Enter a token name and optional expiration date
3. Select scopes:

| Scope | Why |
|-------|-----|
| **api** | Full API access — GitLab doesn't offer granular read/write scopes for repository contents, issues, and merge requests through a single narrower scope |

4. Click **Create personal access token** and copy it

### Why `api` Scope?

GitLab's token system doesn't have separate scopes for "repository contents" vs "issues" vs "merge requests" at the personal token level. The `api` scope is the minimum that covers all operations the editor needs. The `read_api` scope would work for browsing but not for commits, issue updates, or merge request creation.

If you only want read-only access (browse files, view issues, no editing), `read_api` is sufficient.

### Connection Settings

| Field | Value |
|-------|-------|
| Provider | GitLab |
| URL | `https://gitlab.com` or `https://your-gitlab-instance.com` (no `/api/v4` suffix) |
| Token | Your personal access token |

### Notes

- The editor automatically appends `/api/v4` to the URL.
- GitLab project references use `owner%2Frepo` URL encoding internally.
- CI/CD status: the editor reads pipeline status and job logs. Covered by the `api` scope.
- Group/subgroup projects work — the editor URL-encodes the full project path.

---

## Multiple Connections

You can add multiple connections from different providers simultaneously. The project selector shows repos from all active connections, tagged by provider.

Use cases:

- Self-hosted Gitea for private projects + GitHub for open source
- GitLab at work + Gitea homelab
- Multiple Gitea instances (e.g., production vs development)

Each connection has its own URL and token. The editor routes API calls to the correct provider based on which connection owns the current project.

---

## Troubleshooting

**"Connection test failed"** — check that the URL doesn't have a trailing slash or API path suffix. The editor appends `/api/v1`, `/api/v3`, or `/api/v4` automatically.

**"401 Unauthorized"** — token is invalid or expired. Generate a new one.

**"403 Forbidden"** — token doesn't have the required scopes. Check the permissions table above.

**"CORS error"** — your Git host doesn't allow browser requests. Self-hosted instances may need CORS headers configured. For Gitea, set `[cors] ENABLED = true` in `app.ini`.

**Repos not showing** — for organization repos on GitHub, ensure the token has `read:org` scope. For GitLab groups, ensure the token has access to the group's projects.
