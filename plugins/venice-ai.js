/**
 * Example Plugin - Venice.ai Integration
 * 
 * Demonstrates plugin structure for AI Editor.
 * This plugin adds Venice.ai-specific model handling.
 */

import { EventBus, State, Plugins } from '../js/core.js';

const VenicePlugin = {
    // ==========================================
    // MANIFEST (Required)
    // ==========================================
    id: 'venice-ai',
    name: 'Venice.ai Integration',
    version: '1.0.0',
    description: 'Adds Venice.ai specific features like image generation hints',
    author: 'Jeff',
    
    // Hooks this plugin wants to intercept
    hooks: [
        'beforeSend',      // Modify request before sending to LLM
        'afterResponse',   // Process response after receiving
        'onModelChange'    // React to model selection changes
    ],
    
    // UI slots this plugin wants to inject into
    slots: [
        'chat-input-left'  // Add buttons to chat input area
    ],

    // ==========================================
    // LIFECYCLE
    // ==========================================
    
    async init() {
        console.log('Venice.ai plugin initialized');
        
        // Return instance data that will be passed to hooks
        return {
            veniceModels: [],
            lastImagePrompt: null
        };
    },

    // ==========================================
    // HOOKS
    // ==========================================
    
    /**
     * Called before sending a message to the LLM
     * Can modify the messages array or add context
     */
    async beforeSend(data, instance) {
        const { messages, model } = data;
        
        // Check if using a Venice model
        if (model && model.includes('venice')) {
            // Add Venice-specific system context
            const systemMsg = messages.find(m => m.role === 'system');
            if (systemMsg) {
                systemMsg.content += '\n\nNote: You have access to Venice.ai capabilities including image generation.';
            }
        }
        
        return data;
    },

    /**
     * Called after receiving a response from the LLM
     * Can process or augment the response
     */
    async afterResponse(data, instance) {
        const { content, model } = data;
        
        // Check for image generation triggers in response
        if (content.includes('[GENERATE_IMAGE:')) {
            const match = content.match(/\[GENERATE_IMAGE:\s*(.+?)\]/);
            if (match) {
                instance.lastImagePrompt = match[1];
                EventBus.emit('venice:imagePromptDetected', { prompt: match[1] });
            }
        }
        
        return data;
    },

    /**
     * Called when user changes the model selection
     */
    async onModelChange(data, instance) {
        const { model } = data;
        
        if (model.includes('venice')) {
            console.log('Venice model selected, enabling Venice features');
            // Could enable/disable UI elements here
        }
        
        return data;
    },

    // ==========================================
    // CUSTOM METHODS
    // ==========================================
    
    /**
     * Custom method exposed to other plugins/UI
     */
    async generateImage(prompt) {
        // This would call Venice.ai image generation API
        console.log('Generating image with prompt:', prompt);
        // Implementation would go here
    }
};

// Register the plugin
Plugins.register(VenicePlugin);

export default VenicePlugin;