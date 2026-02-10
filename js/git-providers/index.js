/**
 * Git Provider Index
 * 
 * Auto-registers built-in git providers. Import this module to ensure
 * all providers are available in the registry.
 * 
 * To add a new provider:
 * 1. Create js/git-providers/my-provider.js (export default { id, name, ... })
 * 2. Import and register it here
 */

import { GitProviderRegistry } from './registry.js';
import giteaProvider from './gitea.js';
import githubProvider from './github.js';
// import gitlabProvider from './gitlab.js';   // Phase 4

// Register built-in providers
GitProviderRegistry.register(giteaProvider);
GitProviderRegistry.register(githubProvider);
// GitProviderRegistry.register(gitlabProvider);

export { GitProviderRegistry };
