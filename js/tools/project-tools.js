/**
 * AI Editor - Project Tools
 * Tools for project navigation, switching, and file creation
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';
import { IgnoreManager } from '../ignore.js';

/**
 * Register all project-related tools.
 * @param {Object} registry - ToolRegistry instance
 */
export function registerProjectTools(registry) {

    // ========================================
    // list_projects
    // ========================================
    registry.register('list_projects', async () => {
        try {
            const { repos, errors } = await Git.listAllRepos();
            const current = State.currentProject
                ? `${State.currentProject.owner}/${State.currentProject.repo}`
                : null;

            return {
                current_project: current,
                current_branch: State.currentBranch || null,
                projects: repos.map(r => ({
                    connectionId: r.connectionId,
                    owner: r.owner,
                    repo: r.name,
                    fullName: r.fullName,
                    defaultBranch: r.defaultBranch,
                    private: r.private,
                    provider: r.providerIcon || ''
                })),
                errors: errors.length > 0
                    ? errors.map(e => e.message || String(e))
                    : undefined
            };
        } catch (error) {
            return { error: `Failed to list projects: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'list_projects',
            description: 'List all available projects across all git connections. Shows the currently active project and branch. Use this to find a project before calling set_active_project.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        },
        roles: 'all'
    });

    // ========================================
    // set_active_project
    // ========================================
    registry.register('set_active_project', async ({ connectionId, owner, repo, branch }) => {
        try {
            // Check for unsaved work
            const dirtyTabs = State.openTabs.filter(t => t.dirty);
            if (dirtyTabs.length > 0) {
                return {
                    error: 'Cannot switch projects — there are unsaved changes.',
                    dirty_files: dirtyTabs.map(t => t.path),
                    hint: 'Use commit_files or list_dirty_files to handle uncommitted changes first.'
                };
            }

            // Dynamically import to avoid circular deps
            const { switchProject } = await import('../project-manager.js');
            const result = await switchProject(connectionId, owner, repo, { branch });

            return {
                success: true,
                project: `${result.owner}/${result.repo}`,
                branch: result.branch,
                files: State.fileTree.filter(f => f.type === 'file').length,
                message: `Switched to ${result.owner}/${result.repo} on branch ${result.branch}`
            };
        } catch (error) {
            return { error: `Failed to switch project: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'set_active_project',
            description: 'Switch the active project. Clears open tabs and editor state. Will refuse if there are unsaved changes — commit first. Use list_projects to find connectionId/owner/repo values.',
            parameters: {
                type: 'object',
                properties: {
                    connectionId: {
                        type: 'string',
                        description: 'Connection ID from list_projects result'
                    },
                    owner: {
                        type: 'string',
                        description: 'Repository owner (user or org)'
                    },
                    repo: {
                        type: 'string',
                        description: 'Repository name'
                    },
                    branch: {
                        type: 'string',
                        description: 'Optional branch to switch to (defaults to repo default branch)'
                    }
                },
                required: ['connectionId', 'owner', 'repo']
            }
        },
        roles: 'all'
    });
    
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
        // Filter ignored files/dirs from LLM view (sidebar still shows everything)
        files = files.filter(f => !IgnoreManager.isIgnored(f.path, f.size));
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
        },
        roles: 'all'  // All roles can view project structure
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
            const result = await Git.createFile(owner, repo, path, content, commitMsg, branch);
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
            description: 'Create a new file in the project repository. Commits directly to the current branch. Intermediate directories are created automatically.',
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
        },
        roles: ['coder']  // Only coders can create new files
    });

    // ========================================
    // delete_file
    // ========================================
    registry.register('delete_file', async ({ path, message = '' }) => {
        if (!State.currentProject) {
            return { error: 'No project is currently loaded' };
        }
        const { owner, repo } = State.currentProject;
        const branch = State.currentBranch || 'main';
        
        // Find the file in the tree to get its SHA
        const file = State.fileTree.find(f => f.path === path);
        if (!file) {
            return { error: `File not found in project tree: ${path}` };
        }
        if (file.type === 'dir') {
            return { error: `Cannot delete directory: ${path}. Delete individual files instead.` };
        }
        
        const commitMsg = message || `Delete ${path}`;
        try {
            await Git.deleteFile(owner, repo, path, commitMsg, file.sha, branch);
            
            // Close tab if open
            const tabIndex = State.openTabs.findIndex(t => t.path === path);
            if (tabIndex >= 0) {
                State.openTabs.splice(tabIndex, 1);
                if (State.activeTabIndex >= tabIndex) {
                    State.activeTabIndex = Math.max(0, State.activeTabIndex - 1);
                }
                if (State.openTabs.length > 0 && State.activeTabIndex >= 0) {
                    // Trigger tab switch to update editor
                    EventBus.emit('tab:switched', { 
                        index: State.activeTabIndex, 
                        tab: State.openTabs[State.activeTabIndex] 
                    });
                }
            }
            
            // Refresh file tree
            EventBus.emit('tree:refresh');
            
            return {
                success: true,
                path: path,
                message: `Deleted ${path} from branch ${branch}`
            };
        } catch (error) {
            return { error: `Failed to delete file ${path}: ${error.message}` };
        }
    }, {
        type: 'function',
        function: {
            name: 'delete_file',
            description: 'Delete a file from the project repository. Commits the deletion directly to the current branch.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to repo root (e.g., "src/old-module.js")'
                    },
                    message: {
                        type: 'string',
                        description: 'Git commit message (optional, defaults to "Delete <path>")'
                    }
                },
                required: ['path']
            }
        },
        roles: ['coder']  // Only coders can delete files
    });
}
