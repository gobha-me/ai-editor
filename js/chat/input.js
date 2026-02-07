/**
 * Input Handling
 * Manages user input, keyboard events, and message sending
 */

import { State, EventBus } from '../core.js';
import { LLM } from '../llm.js';
import { getInputElement, resetToolLoopCancel, cancelToolLoop } from './state.js';
import { addMessage, updateStreamingMessage } from './messages.js';

/**
 * Setup input event handlers
 */
export function setupInputHandlers(inputElement, handleUserInputFn) {
    if (!inputElement) return;

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
 * Send a message programmatically
 */
export function sendMessage(content, handleUserInputFn) {
    const inputElement = getInputElement();
    if (inputElement) {
        inputElement.value = content;
        handleUserInputFn(content);
    }
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

/**
 * Setup LLM event listeners for token streaming
 */
export function setupLLMEventListeners() {
    // Listen for LLM events
    EventBus.on('llm:token', ({ token, content }) => {
        updateStreamingMessage(content);
    });

    EventBus.on('llm:generating', (isGenerating) => {
        const inputElement = getInputElement();
        if (inputElement) {
            inputElement.disabled = isGenerating;
        }
    });
}
