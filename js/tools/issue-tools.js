/**
 * AI Editor - Issue Tools
 * Tools for managing Gitea issues
 */

import { State, EventBus } from '../core.js';

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
            const params = new URLSearchParams({ state, type: 'issues', limit: '50' });
            if (labels) params.append('labels', labels);
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues?${params}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `token ${State.settings.giteaToken}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issues = await response.json();
            return {
                project: `${owner}/${repo}`,
                count: issues.length,
                issues: issues.map(i => ({
                    number: i.number,
                    title: i.title,
                    state: i.state,
                    labels: (i.labels || []).map(l => l.name),
                    created: i.created_at,
                    assignee: i.assignee?.login || null
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
        }
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
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues/${number}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `token ${State.settings.giteaToken}` }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issue = await response.json();

            // Also fetch comments
            const commentsUrl = `${url}/comments`;
            const commentsResp = await fetch(commentsUrl, {
                headers: { 'Authorization': `token ${State.settings.giteaToken}` }
            });
            const comments = commentsResp.ok ? await commentsResp.json() : [];

            return {
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: (issue.labels || []).map(l => l.name),
                assignee: issue.assignee?.login || null,
                created: issue.created_at,
                comments: comments.slice(0, 20).map(c => ({
                    user: c.user?.login,
                    body: c.body,
                    created: c.created_at
                }))
            };
        } catch (error) {
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
        }
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
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues`;
            const payload = { title, body };
            if (labels.length > 0) payload.labels = labels; // Gitea expects label IDs for creation; names might not work
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `token ${State.settings.giteaToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issue = await response.json();
            // Refresh issues list
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
        }
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
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues/${number}`;
            const payload = {};
            if (title !== undefined) payload.title = title;
            if (body !== undefined) payload.body = body;
            if (state !== undefined) payload.state = state;
            const response = await fetch(url, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${State.settings.giteaToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const issue = await response.json();
            EventBus.emit('issues:refresh');
            return {
                success: true,
                number: issue.number,
                title: issue.title,
                state: issue.state,
                message: `Updated issue #${issue.number}`
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
        }
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
            const url = `${State.settings.giteaUrl}/api/v1/repos/${owner}/${repo}/issues/${number}/comments`;
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `token ${State.settings.giteaToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ body })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const comment = await response.json();
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
        }
    });
}
