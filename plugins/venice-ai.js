/**
 * Plugin: Venice.ai Integration
 * 
 * Adds Venice.ai-specific model handling, image generation hints,
 * and LLM hook augmentation for Venice models.
 */

import { EventBus, State, Plugins } from '../js/core.js';

const VenicePlugin = {
    id: 'venice-ai',
    name: 'Venice.ai Integration',
    version: '1.1.0',
    description: 'Adds Venice.ai specific features like image generation hints and model handling',
    author: 'Jeff',
    
    hooks: [
        'beforeSend',
        'afterResponse',
        'onModelChange'
    ],
    
    slots: [
        'chat-input-left'
    ],

    async init(config) {
        console.log('[venice-ai] Plugin initialized');
        return {
            veniceModels: [],
            lastImagePrompt: null
        };
    },

    async beforeSend(data, instance, config) {
        const { messages, model } = data;
        
        if (model && model.includes('venice')) {
            const systemMsg = messages.find(m => m.role === 'system');
            if (systemMsg) {
                systemMsg.content += '\n\nNote: You have access to Venice.ai capabilities including image generation.';
            }
        }
        
        return data;
    },

    async afterResponse(data, instance, config) {
        const { content, model } = data;
        
        if (content.includes('[GENERATE_IMAGE:')) {
            const match = content.match(/\[GENERATE_IMAGE:\s*(.+?)\]/);
            if (match) {
                instance.lastImagePrompt = match[1];
                EventBus.emit('venice:imagePromptDetected', { prompt: match[1] });
            }
        }
        
        return data;
    },

    async onModelChange(data, instance, config) {
        const { model } = data;
        
        if (model.includes('venice')) {
            console.log('[venice-ai] Venice model selected');
        }
        
        return data;
    },

    async generateImage(prompt) {
        console.log('[venice-ai] Generating image:', prompt);
    }
};

Plugins.register(VenicePlugin);

export default VenicePlugin;
