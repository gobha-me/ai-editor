/**
 * AI Editor - Project Tools
 * Tools for project navigation and file creation
 */

import { State, EventBus } from '../core.js';
import { Git } from '../git.js';

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
