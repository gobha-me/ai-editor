/**
 * Input Handling
 * Manages user input, keyboard events, and message sending
 */

import { State, EventBus } from '../core.js';
import { LLM } from '../llm.js';
import { cancelToolLoop } from './state.js';
import { addMessage } from './messages.js';

/**
 * Setup input event handlers
 */
export function setupInputHandlers(inputElement, handleUserInputFn) {
    if (!inputElement || !handleUserInputFn) {
        console.error('[setupInputHandlers] Missing required parameters');
        return;
    }

    // Use keydown to detect Enter, but defer reading value until after the key is processed
    inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            
            // Capture input value IMMEDIATELY before any async operations
            const inputValue = inputElement.value.trim();
            inputElement.value = '';
            
            // Process the captured value
            if (inputValue && !State.isGenerating) {
                handleUserInputFn(inputValue);
            }
        }
    });
}

/**
 * Stop generation
 */
export function stopGeneration() {
    // Cancel any in-flight tool loop
    cancelToolLoop();
    
    LLM.stop();
    State.isGenerating = false;
    EventBus.emit('llm:generating', false);
    
    const streamingEl = document.getElementById('streaming-message');
    if (streamingEl) {
        const content = streamingEl.querySelector('.message-content').textContent;
        streamingEl.remove();
        addMessage('assistant', content + '\n\n*(generation stopped)*');
    }
}
