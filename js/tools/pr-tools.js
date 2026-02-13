/**
 * AI Editor - Pull Request / Merge Request Tools
 * Provider-agnostic PR/MR management via Git facade.
 * 
 * Enables the full review loop:
 *   1. Coder creates PR after pushing code
 *   2. Reviewer reads PR (diff + CI status + comments)
 *   3. Reviewer posts feedback via add_pr_review
 *   4. Coder reads feedback, fixes, pushes
 *   5. Repeat until merged
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';

/**
 * Register all PR/MR-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerPRTools(registry) {

    // ========================================
    // create_pull_request
    // ========================================
    registry.register('create_pull_request', async ({ title, body = '', head, base }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;

        // Default head to current branch
        const headBranch = head || State.currentBranch;
        // Default base to repo's default branch
        const baseBranch = base || State.currentProject.defaultBranch || 'main';

        if (headBranch === baseBranch) {
            return { error: `Cannot create PR: head branch "${headBranch}" is the same as base "${baseBranch}". Switch to a feature branch first.` };
        }

        try {
            const pr = await Git.createMergeRequest(owner, repo, title, body, headBranch, baseBranch);
            EventBus.emit('pr:created', { owner, repo, number: pr.number });
            EventBus.emit('prs:refresh');
            return {
                success: true,
                number: pr.number,
                title: pr.title,
                url: pr.url,
                head: headBranch,
                base: baseBranch,
                message: `Created PR #${pr.number}: ${pr.title}`
            };
        } catch (error) {
            return { error: `Failed to create pull request: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'create_pull_request',
            description: 'Create a pull/merge request to merge the current branch into the base branch. Use this to document completed work and request review. Head defaults to the current branch, base defaults to the repository default branch (usually main).',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'PR title — summarize the changes concisely'
                    },
                    body: {
                        type: 'string',
                        description: 'PR description — what changed, why, and any testing notes (markdown supported)'
                    },
                    head: {
                        type: 'string',
                        description: 'Source branch (default: current branch)'
                    },
                    base: {
                        type: 'string',
                        description: 'Target branch (default: repository default branch)'
                    }
                },
                required: ['title']
            }
        },
        roles: ['coder', 'pm']
    });

    // ========================================
    // list_pull_requests
    // ========================================
    registry.register('list_pull_requests', async ({ state = 'open' } = {}) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const prs = await Git.listMergeRequests(owner, repo, state);
            return {
                project: `${owner}/${repo}`,
                count: prs.length,
                pull_requests: prs.map(pr => ({
                    number: pr.number,
                    title: pr.title,
                    state: pr.state,
                    head: pr.head,
                    base: pr.base,
                    mergeable: pr.mergeable,
                    url: pr.url
                }))
            };
        } catch (error) {
            return { error: `Failed to list pull requests: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'list_pull_requests',
            description: 'List pull/merge requests for the current project.',
            parameters: {
                type: 'object',
                properties: {
                    state: {
                        type: 'string',
                        enum: ['open', 'closed', 'all'],
                        description: 'Filter by PR state (default: open)'
                    }
                },
                required: []
            }
        },
        roles: 'all'
    });

    // ========================================
    // read_pull_request
    // ========================================
    registry.register('read_pull_request', async ({ number }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const prNum = parseInt(number);
        if (isNaN(prNum)) {
            return { error: 'PR number must be an integer' };
        }

        try {
            // Fetch PR details, changed files, CI status, and comments in parallel
            const [pr, files, comments] = await Promise.all([
                Git.getPullRequest(owner, repo, prNum),
                Git.getPullRequestFiles(owner, repo, prNum).catch(() => []),
                Git.getPullRequestComments(owner, repo, prNum).catch(() => [])
            ]);

            // Fetch CI status for head branch
            let ci = { state: 'unknown', statuses: [] };
            try {
                ci = await Git.getCommitStatus(owner, repo, pr.head);
            } catch { /* no CI */ }

            // Truncate patches if total is too large (keep it under ~8K chars for tool results)
            let totalPatchLen = 0;
            const truncatedFiles = files.map(f => {
                const patch = f.patch || '';
                totalPatchLen += patch.length;
                if (totalPatchLen > 8000) {
                    return { ...f, patch: `[truncated — ${patch.length} chars, ${f.additions}+ ${f.deletions}-]` };
                }
                return f;
            });

            return {
                pr: {
                    number: pr.number,
                    title: pr.title,
                    body: pr.body,
                    state: pr.state,
                    merged: pr.merged,
                    head: pr.head,
                    base: pr.base,
                    mergeable: pr.mergeable,
                    author: pr.user,
                    additions: pr.additions,
                    deletions: pr.deletions,
                    changed_files: pr.changed_files,
                    url: pr.url
                },
                ci: {
                    state: ci.state,
                    checks: ci.statuses.map(s => ({
                        name: s.context,
                        state: s.state,
                        description: s.description
                    }))
                },
                files: truncatedFiles,
                comments: comments.map(c => ({
                    user: c.user,
                    body: c.body,
                    type: c.type,
                    path: c.path || null,
                    line: c.line || null,
                    date: c.createdAt
                }))
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `Pull request #${prNum} not found. Use list_pull_requests to see available PRs.` };
            }
            return { error: `Failed to read PR #${prNum}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_pull_request',
            description: 'Read full details of a pull request including: description, changed files with diffs, CI/CD status, and review comments. Use this to review code changes, check CI failures, or understand what a PR does.',
            parameters: {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer',
                        description: 'PR number'
                    }
                },
                required: ['number']
            }
        },
        roles: 'all'
    });

    // ========================================
    // add_pr_review
    // ========================================
    registry.register('add_pr_review', async ({ number, body }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const prNum = parseInt(number);
        if (isNaN(prNum)) {
            return { error: 'PR number must be an integer' };
        }

        try {
            await Git.addPullRequestComment(owner, repo, prNum, body);
            EventBus.emit('prs:refresh');
            return {
                success: true,
                message: `Posted review comment on PR #${prNum}`
            };
        } catch (error) {
            return { error: `Failed to comment on PR #${prNum}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'add_pr_review',
            description: 'Post a review comment on a pull request. Use this to provide code review feedback, approve changes, or request modifications. The comment is posted as a general PR comment (not line-level).',
            parameters: {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer',
                        description: 'PR number'
                    },
                    body: {
                        type: 'string',
                        description: 'Review comment body (markdown supported). Include specific file references, line numbers, and actionable feedback.'
                    }
                },
                required: ['number', 'body']
            }
        },
        roles: ['reviewer', 'coder', 'pm']
    });

    // ========================================
    // merge_pull_request
    // ========================================
    registry.register('merge_pull_request', async ({ number, merge_type = 'squash', title = '', message = '', delete_branch = false }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const prNum = parseInt(number);
        if (isNaN(prNum)) {
            return { error: 'PR number must be an integer' };
        }

        try {
            // Verify PR is open and mergeable first
            const pr = await Git.getPullRequest(owner, repo, prNum);
            if (pr.merged) {
                return { error: `PR #${prNum} is already merged` };
            }
            if (pr.state === 'closed') {
                return { error: `PR #${prNum} is closed. Reopen it before merging.` };
            }

            const result = await Git.mergePullRequest(owner, repo, prNum, {
                mergeType: merge_type,
                title,
                message,
                deleteBranch: delete_branch
            });

            EventBus.emit('prs:refresh');
            EventBus.emit('branches:refresh');

            // Notify context manager to reindex target branch and clean up deleted branch embeddings
            const files = await Git.getPullRequestFiles(owner, repo, prNum).catch(() => []);
            EventBus.emit('context:prMerged', {
                baseBranch: pr.base,
                headBranch: pr.head,
                changedFiles: files.map(f => f.filename),
                deletedBranch: delete_branch ? pr.head : null
            });

            return {
                success: true,
                merged: result.merged,
                sha: result.sha,
                message: result.message,
                deletedBranch: delete_branch ? pr.head : null
            };
        } catch (error) {
            return { error: `Failed to merge PR #${prNum}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'merge_pull_request',
            description: 'Merge a pull request. Supports squash, merge, and rebase strategies. Optionally deletes the source branch after merge.',
            parameters: {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer',
                        description: 'PR number to merge'
                    },
                    merge_type: {
                        type: 'string',
                        enum: ['squash', 'merge', 'rebase'],
                        description: 'Merge strategy (default: squash)'
                    },
                    title: {
                        type: 'string',
                        description: 'Custom merge commit title (optional)'
                    },
                    message: {
                        type: 'string',
                        description: 'Custom merge commit message body (optional)'
                    },
                    delete_branch: {
                        type: 'boolean',
                        description: 'Delete source branch after merge (default: false)'
                    }
                },
                required: ['number']
            }
        },
        roles: ['coder', 'pm', 'reviewer']
    });

    // ========================================
    // get_ci_status
    // ========================================
    registry.register('get_ci_status', async ({ ref }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const branch = ref || State.currentBranch;

        try {
            const status = await Git.getCommitStatus(owner, repo, branch);
            return {
                ref: branch,
                state: status.state,
                total_checks: status.total,
                checks: status.statuses.map(s => ({
                    name: s.context,
                    state: s.state,
                    description: s.description,
                    url: s.url
                }))
            };
        } catch (error) {
            return { error: `Failed to get CI status for '${branch}': ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'get_ci_status',
            description: 'Get CI/CD pipeline status for a branch or commit. Shows pass/fail status for each check. Defaults to current branch if no ref specified.',
            parameters: {
                type: 'object',
                properties: {
                    ref: {
                        type: 'string',
                        description: 'Branch name or commit SHA (default: current branch)'
                    }
                },
                required: []
            }
        },
        roles: 'all'
    });
}
