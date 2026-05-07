/**
 * AI Editor — Git Log Tool
 *
 * LLM-facing tool for inspecting commit history.
 * Uses the same git provider connection as other git tools.
 */

import { ToolRegistry } from './registry.js';
import { State } from '../core.js';
import { Git } from '../git.js';

// ============================================
// git_log
// ============================================

async function gitLog({ path, max_count, since, author, sha }) {
    if (!State.currentProject) {
        return { error: 'No project is currently loaded. Open a project first.' };
    }

    const { owner, repo } = State.currentProject;

    // Validate max_count
    if (max_count !== undefined) {
        if (typeof max_count !== 'number' || max_count < 1) {
            return { error: 'max_count must be a positive integer.' };
        }
        if (max_count > 100) {
            return { error: 'max_count cannot exceed 100. Use a smaller value or paginate.' };
        }
    }

    try {
        const commits = await Git.getCommits(owner, repo, {
            path,
            max_count: max_count || 20,
            since,
            author,
            sha
        });

        if (commits.length === 0) {
            const filterDesc = [];
            if (path) filterDesc.push(`path: ${path}`);
            if (author) filterDesc.push(`author: ${author}`);
            if (since) filterDesc.push(`since: ${since}`);
            if (sha) filterDesc.push(`sha: ${sha}`);

            const msg = filterDesc.length > 0
                ? `No commits found matching filters: ${filterDesc.join(', ')}`
                : 'No commits found in this repository.';

            return { commits: [], message: msg };
        }

        return {
            commits: commits.map(c => ({
                sha: c.shortSha,
                fullSha: c.sha,
                author: c.author,
                date: c.date,
                subject: c.subject,
                url: c.url
            })),
            count: commits.length,
            message: `Showing ${commits.length} commit(s) for ${owner}/${repo}`
        };
    } catch (error) {
        // Handle common error cases
        if (error.message?.includes('404')) {
            if (path) {
                return { error: `File not found: ${path}. Check the path and try again.` };
            }
            return { error: 'Repository not found or no access.' };
        }
        if (error.message?.includes('401') || error.message?.includes('403')) {
            return { error: 'Authentication error. Check your git provider connection.' };
        }
        if (error.message?.includes('is not a function') || error.message?.includes('not supported')) {
            return { error: 'Commit history is not supported on this git provider.' };
        }
        return { error: `Failed to fetch commit log: ${error.message}` };
    }
}

ToolRegistry.register('git_log', gitLog, {
    type: 'function',
    function: {
        name: 'git_log',
        description: 'View the commit history of the current repository. Returns compact commit entries with hash, author, date, and subject line. Use this to understand what changed recently, who authored specific changes, or trace the history of a file.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Optional: filter commits that touched this file path (e.g., "js/chat/index.js").'
                },
                max_count: {
                    type: 'number',
                    description: 'Maximum number of commits to return (default: 20, max: 100).'
                },
                since: {
                    type: 'string',
                    description: 'Optional: ISO 8601 date string to show commits after this date (e.g., "2024-01-15T00:00:00Z").'
                },
                author: {
                    type: 'string',
                    description: 'Optional: filter commits by author name or email.'
                },
                sha: {
                    type: 'string',
                    description: 'Optional: branch name, tag, or commit SHA to start the log from.'
                }
            },
            required: []
        }
    },
    roles: 'all',  // Read-only — safe for every role
    readOnly: true
});

export { gitLog };
