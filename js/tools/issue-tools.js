/**
 * AI Editor - Issue Tools
 * Tools for managing issues (provider-agnostic via Git facade)
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { wrapUntrusted, scanForInvisible, UNTRUSTED_KINDS } from '../security/untrusted-wrap.js';

/**
 * Register all issue-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerIssueTools(registry) {
    
    // ========================================
    // list_issues
    // ========================================
    registry.register('list_issues', async ({ state = 'open', labels = '', page = 1 } = {}) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const issues = await Git.listIssues(owner, repo, state, labels, page);
            const result = {
                project: `${owner}/${repo}`,
                state_filter: state,
                page,
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
            // Tell the LLM if there may be more pages
            if (issues.length >= 100) {
                result.has_more = true;
                result.next_page = page + 1;
                result.hint = `This page returned 100 issues (the maximum). Call list_issues with page=${page + 1} to see more. Use labels parameter to filter.`;
            }
            return result;
        } catch (error) {
            return { error: `Failed to list issues: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'list_issues',
            description: 'List issues for the current project, sorted oldest-first. Returns up to 100 per page. Use page parameter for pagination.',
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
                    },
                    page: {
                        type: 'integer',
                        description: 'Page number for pagination (default: 1, 100 issues per page, oldest first)'
                    }
                },
                required: []
            }
        },
        roles: 'all',
        readOnly: true
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

            const shownComments = comments.slice(0, 20);
            const result = {
                number: issue.number,
                title: issue.title,
                body: wrapUntrusted(UNTRUSTED_KINDS.ISSUE_BODY, issue.body || ''),
                state: issue.state,
                labels: issue.labels || [],
                assignee: issue.assignees?.[0] || null,
                created: issue.createdAt,
                total_comments: comments.length,
                comments: shownComments.map(c => ({
                    user: c.user,
                    body: wrapUntrusted(UNTRUSTED_KINDS.ISSUE_COMMENT, c.body || ''),
                    created: c.createdAt
                }))
            };
            if (comments.length > 20) {
                result.comments_truncated = true;
                result.hint = `Showing oldest 20 of ${comments.length} comments. The newest ${comments.length - 20} are omitted.`;
            }

            // Scan all externally-sourced text for invisible-Unicode (glassworm /
            // Trojan-Source / zero-width steganography). Surface findings on
            // `_security` so the model can warn the user; non-blocking.
            const securityWarnings = [];
            const bodyScan = scanForInvisible(issue.body, `issue #${issue.number} body`);
            if (bodyScan) securityWarnings.push(bodyScan);
            for (const c of shownComments) {
                const cScan = scanForInvisible(c.body, `comment by ${c.user || 'unknown'}`);
                if (cScan) securityWarnings.push(cScan);
            }
            if (securityWarnings.length > 0) {
                result._security = { invisibleUnicode: securityWarnings };
            }

            return result;
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
        roles: 'all',
        readOnly: true
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
    registry.register('update_issue', async ({ number, title, state, labels }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        try {
            const fields = {};
            if (title !== undefined) fields.title = title;
            if (state !== undefined) fields.state = state;
            if (labels !== undefined) fields.labels = labels;

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
            description: 'Update issue METADATA only: title, state (open/close), or labels. This does NOT add content to the issue — to post an update, response, or any new information on an issue, use add_issue_comment instead.',
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
                    state: {
                        type: 'string',
                        enum: ['open', 'closed'],
                        description: 'Set issue state (optional)'
                    },
                    labels: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Replace labels with this list (optional)'
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
            description: 'Post a comment on an issue. Use this to add updates, responses, analysis, questions, status reports, or any new content to an existing issue. This is the correct tool whenever you want to contribute information to an issue — update_issue only changes metadata.',
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
