/**
 * AI Editor - Pull Request / Merge Request Tools
 * Provider-agnostic PR/MR management via Git facade.
 * Allows the LLM to document completed work and request reviews.
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
}
