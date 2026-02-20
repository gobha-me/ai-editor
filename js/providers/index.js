/**
 * Provider Index
 * 
 * Auto-registers built-in providers. Import this module to ensure
 * all providers are available in the registry.
 * 
 * To add a new provider:
 * 1. Create js/providers/my-provider.js (export default { id, name, ... })
 * 2. Import and register it here
 */

import { ProviderRegistry, DEFAULT_CAPABILITIES } from './registry.js';
import veniceProvider from './venice.js';
import openRouterProvider from './openrouter.js';
import ollamaProvider from './ollama.js';

// Register built-in providers
ProviderRegistry.register(veniceProvider);
ProviderRegistry.register(openRouterProvider);
ProviderRegistry.register(ollamaProvider);

export { ProviderRegistry, DEFAULT_CAPABILITIES };
