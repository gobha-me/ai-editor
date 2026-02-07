/**
 * AI Editor - Project Tools
 * Tools for project navigation and file creation
 */

import { State, EventBus } from '../core.js';
import { GiteaAPI } from '../gitea.js';

/**
 * Register all project-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerProjectTools(registry) {
    
    // ========================================
    // get_project_tree
    // ========================================
    registry.register('get_project_tree', async ({ path = '' }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        let files = State.fileTree;
        if (path) {
            files = files.filter(f => f.path.startsWith(path));
        }
        return {
            project: `${State.currentProject.owner}/${State.currentProject.repo}`,
            branch: State.currentBranch,
            files: files.map(f => ({
                path: f.path,
                type: f.type,
                name: f.name
            }))
        };
    }, {
        type: 'function',
        function: {
            name: 'get_project_tree',
            description: 'Get the file tree structure of the current project',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Optional path to filter files (e.g., "src/" to only list files in src directory)'
                    }
                },
                required: []
            }
        }
    });

    // ========================================
    // create_file
    // ========================================
    registry.register('create_file', async ({ path, content = '', message = '' }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        const commitMsg = message || `Create ${path}`;
        try {
            const result = await GiteaAPI.createFile(owner, repo, path, content, commitMsg, branch);
            EventBus.emit('tree:refresh');
            return {
                success: true,
                path: path,
                message: `Created ${path} on branch ${branch}`
            };
        } catch (error) {
            return { error: `Failed to create file ${path}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'create_file',
            description: 'Create a new file in the project repository. Commits directly to the current branch via Gitea API. Intermediate directories are created automatically.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to repo root (e.g., "src/utils/helpers.js")'
                    },
                    content: {
                        type: 'string',
                        description: 'File content to write'
                    },
                    message: {
                        type: 'string',
                        description: 'Git commit message (optional, defaults to "Create <path>")'
                    }
                },
                required: ['path', 'content']
            }
        }
    });
}
