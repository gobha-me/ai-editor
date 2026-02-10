/**
 * AI Editor - Issue Tools
 * Tools for managing issues (provider-agnostic via Git facade)
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';

/**
 * Register all issue-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerIssueTools(registry) {
    
    // ========================================
    // list_issues
    // ========================================
    registry.register('list_issues', async ({ state = 'open', labels = '' } = {}) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const issues = await Git.listIssues(owner, repo, state, labels);
            return {
                project: `${owner}/${repo}`,
                count: issues.length,
                issues: issues.map(i => ({
                    number: i.number,
                    title: i.title,
                    state: i.state,
                    labels: i.labels || [],
                    created: i.createdAt,
                    assignee: i.assignees?.[0] || null
                }))
            };
        } catch (error) {
            return { error: `Failed to list issues: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'list_issues',
            description: 'List issues for the current project. Returns open issues by default.',
            parameters: {
                type: 'object',
                properties: {
                    state: {
                        type: 'string',
                        enum: ['open', 'closed', 'all'],
                        description: 'Filter by issue state (default: open)'
                    },
                    labels: {
                        type: 'string',
                        description: 'Comma-separated label names to filter by'
                    }
                },
                required: []
            }
        },
        roles: 'all'
    });

    // ========================================
    // read_issue
    // ========================================
    registry.register('read_issue', async ({ number }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const issue = await Git.getIssue(owner, repo, number);

            // Also fetch comments
            let comments = [];
            try {
                comments = await Git.getIssueComments(owner, repo, number);
            } catch (e) {
                console.warn(`Could not fetch comments for issue #${number}:`, e.message);
            }

            return {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: issue.labels || [],
                assignee: issue.assignees?.[0] || null,
                created: issue.createdAt,
                comments: comments.slice(0, 20).map(c => ({
                    user: c.user,
                    body: c.body,
                    created: c.createdAt
                }))
            };
        } catch (error) {
            if (error.status === 404) {
                return { error: `Issue #${number} not found. Use list_issues to see available issues.` };
            }
            return { error: `Failed to read issue #${number}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'read_issue',
            description: 'Read a specific issue by number, including its body, labels, and comments.',
            parameters: {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer',
                        description: 'The issue number'
                    }
                },
                required: ['number']
            }
        },
        roles: 'all'
    });

    // ========================================
    // create_issue
    // ========================================
    registry.register('create_issue', async ({ title, body = '', labels = [] }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const issue = await Git.createIssue(owner, repo, title, body, labels);
            EventBus.emit('issues:refresh');
            return {
                success: true,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                message: `Created issue #${issue.number}: ${issue.title}`
            };
        } catch (error) {
            return { error: `Failed to create issue: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'create_issue',
            description: 'Create a new issue in the current project.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Issue title'
                    },
                    body: {
                        type: 'string',
                        description: 'Issue body/description (markdown supported)'
                    },
                    labels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of label names to apply'
                    }
                },
                required: ['title']
            }
        },
        roles: ['pm']
    });

    // ========================================
    // update_issue
    // ========================================
    registry.register('update_issue', async ({ number, title, body, state }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const fields = {};
            if (title !== undefined) fields.title = title;
            if (body !== undefined) fields.body = body;
            if (state !== undefined) fields.state = state;

            const result = await Git.updateIssue(owner, repo, number, fields);
            EventBus.emit('issues:refresh');
            return {
                success: true,
                number: result.number,
                title: result.title,
                state: result.state,
                message: `Updated issue #${result.number}`
            };
        } catch (error) {
            return { error: `Failed to update issue #${number}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'update_issue',
            description: 'Update an existing issue (title, body, state, or labels).',
            parameters: {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer',
                        description: 'The issue number to update'
                    },
                    title: {
                        type: 'string',
                        description: 'New title (optional)'
                    },
                    body: {
                        type: 'string',
                        description: 'New body (optional)'
                    },
                    state: {
                        type: 'string',
                        enum: ['open', 'closed'],
                        description: 'Set issue state (optional)'
                    }
                },
                required: ['number']
            }
        },
        roles: ['pm']
    });

    // ========================================
    // add_issue_comment
    // ========================================
    registry.register('add_issue_comment', async ({ number, body }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const comment = await Git.createIssueComment(owner, repo, number, body);
            return {
                success: true,
                issue_number: number,
                comment_id: comment.id,
                message: `Added comment to issue #${number}`
            };
        } catch (error) {
            return { error: `Failed to add comment to issue #${number}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'add_issue_comment',
            description: 'Add a comment to an existing issue.',
            parameters: {
                type: 'object',
                properties: {
                    number: {
                        type: 'integer',
                        description: 'The issue number'
                    },
                    body: {
                        type: 'string',
                        description: 'Comment text (markdown supported)'
                    }
                },
                required: ['number', 'body']
            }
        },
        roles: ['pm', 'reviewer']
    });
}
