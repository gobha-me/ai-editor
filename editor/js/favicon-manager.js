/**
 * Favicon Manager - Dynamic status indicator for browser tab
 * Updates favicon based on editor state: idle, processing, error, success
 */

import { EventBus } from './core.js';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // Throttle updates to 100ms minimum
    throttleMs: 100,
    // Canvas size for favicon generation
    canvasSize: 32,
    // Colors for different states
    colors: {
        idle: null,        // Use default favicon
        processing: '#fbbf24', // Yellow/amber
        error: '#ef4444',      // Red
        success: '#22c55e'     // Green
    },
    // Status indicator dot position and size
    indicator: {
        radius: 5,
        offset: 3 // Distance from bottom-right corner
    }
};

// ============================================
// STATE
// ============================================

const State = {
    current: 'idle',
    lastUpdate: 0,
    errorCount: 0,
    successTimeout: null
};

// ============================================
// CANVAS SETUP
// ============================================

let canvas = null;
let ctx = null;
let faviconLink = null;
let baseFaviconData = null;

/**
 * Initialize canvas for favicon generation
 */
function initCanvas() {
    try {
        canvas = document.createElement('canvas');
        canvas.width = CONFIG.canvasSize;
        canvas.height = CONFIG.canvasSize;
        ctx = canvas.getContext('2d');
        
        // Find or create favicon link element
        faviconLink = document.querySelector('link[rel*="icon"]');
        if (!faviconLink) {
            faviconLink = document.createElement('link');
            faviconLink.rel = 'icon';
            faviconLink.type = 'image/png';
            document.head.appendChild(faviconLink);
        }
        
        return true;
    } catch (err) {
        console.warn('[FaviconManager] Canvas initialization failed:', err);
        return false;
    }
}

/**
 * Load base favicon SVG and convert to canvas image
 */
async function loadBaseFavicon() {
    if (!canvas) return false;
    
    try {
        // Try to load the SVG favicon
        const response = await fetch('editor/assets/favicon.svg');
        if (!response.ok) throw new Error('Failed to load favicon.svg');
        
        const svgText = await response.text();
        
        // Create image from SVG
        const img = new Image();
        const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(svgBlob);
        
        return new Promise((resolve) => {
            img.onload = () => {
                URL.revokeObjectURL(url);
                baseFaviconData = img;
                resolve(true);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                // Fallback: draw simple lightning bolt
                drawFallbackFavicon();
                resolve(true);
            };
            img.src = url;
        });
    } catch (err) {
        console.warn('[FaviconManager] Failed to load SVG, using fallback:', err);
        drawFallbackFavicon();
        return true;
    }
}

/**
 * Draw fallback favicon (simple lightning bolt)
 */
function drawFallbackFavicon() {
    if (!ctx) return;
    
    const size = CONFIG.canvasSize;
    const center = size / 2;
    
    // Clear canvas
    ctx.clearRect(0, 0, size, size);
    
    // Background circle
    ctx.beginPath();
    ctx.arc(center, center, center - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#1f2937';
    ctx.fill();
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Lightning bolt
    ctx.beginPath();
    ctx.moveTo(center + 4, center - 8);
    ctx.lineTo(center - 4, center + 2);
    ctx.lineTo(center + 1, center + 2);
    ctx.lineTo(center - 2, center + 8);
    ctx.lineTo(center + 4, center - 2);
    ctx.lineTo(center - 1, center - 2);
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    
    // Store as base
    baseFaviconData = canvas.toDataURL('image/png');
}

// ============================================
// FAVICON GENERATION
// ============================================

/**
 * Generate favicon with status indicator
 */
function generateFavicon(state) {
    if (!ctx || !canvas) return null;
    
    const size = CONFIG.canvasSize;
    
    // Clear canvas
    ctx.clearRect(0, 0, size, size);
    
    // Draw base favicon
    if (baseFaviconData instanceof Image) {
        ctx.drawImage(baseFaviconData, 0, 0, size, size);
    } else {
        // Redraw fallback
        drawFallbackFavicon();
    }
    
    // Add status indicator if not idle
    if (state !== 'idle' && CONFIG.colors[state]) {
        const { radius, offset } = CONFIG.indicator;
        const x = size - radius - offset;
        const y = size - radius - offset;
        
        // Draw indicator dot with border
        ctx.beginPath();
        ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = CONFIG.colors[state];
        ctx.fill();
        
        // Add subtle pulse effect for processing state
        if (state === 'processing') {
            ctx.beginPath();
            ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
            ctx.strokeStyle = CONFIG.colors[state];
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.5;
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        }
    }
    
    // Convert to data URL
    try {
        return canvas.toDataURL('image/png');
    } catch (err) {
        console.warn('[FaviconManager] Failed to generate data URL:', err);
        return null;
    }
}

/**
 * Update favicon with throttling
 */
function updateFavicon(state) {
    // Throttle updates
    const now = Date.now();
    if (now - State.lastUpdate < CONFIG.throttleMs) {
        // Schedule update after throttle period
        setTimeout(() => updateFavicon(state), CONFIG.throttleMs - (now - State.lastUpdate));
        return;
    }
    
    State.lastUpdate = now;
    State.current = state;
    
    // Generate new favicon
    const dataUrl = generateFavicon(state);
    if (dataUrl && faviconLink) {
        faviconLink.href = dataUrl;
    }
}

// ============================================
// STATE HANDLERS
// ============================================

/**
 * Set processing state
 */
function setProcessing(isProcessing) {
    if (isProcessing) {
        updateFavicon('processing');
    } else {
        // Return to idle or show success briefly
        if (State.current === 'processing') {
            setSuccess();
        }
    }
}

/**
 * Set success state (brief flash then return to idle)
 */
function setSuccess() {
    updateFavicon('success');
    
    // Clear any existing timeout
    if (State.successTimeout) {
        clearTimeout(State.successTimeout);
    }
    
    // Return to idle after 2 seconds
    State.successTimeout = setTimeout(() => {
        updateFavicon('idle');
        State.successTimeout = null;
    }, 2000);
}

/**
 * Set error state based on error count
 */
function setErrorCount(count) {
    State.errorCount = count;
    if (count > 0) {
        updateFavicon('error');
    } else if (State.current === 'error') {
        updateFavicon('idle');
    }
}

/**
 * Clear error state
 */
function clearErrors() {
    State.errorCount = 0;
    updateFavicon('idle');
}

// ============================================
// PUBLIC API
// ============================================

export const FaviconManager = {
    /**
     * Initialize the favicon manager
     */
    async init() {
        if (!initCanvas()) {
            console.warn('[FaviconManager] Initialization failed, favicon updates disabled');
            return false;
        }
        
        await loadBaseFavicon();
        
        // Set initial favicon
        updateFavicon('idle');
        
        // Listen for LLM processing state
        EventBus.on('llm:generating', (isGenerating) => {
            setProcessing(isGenerating);
        });
        
        console.log('[FaviconManager] Initialized');
        return true;
    },
    
    /**
     * Manually set processing state
     */
    setProcessing,
    
    /**
     * Manually trigger success indicator
     */
    setSuccess,
    
    /**
     * Update error indicator count
     */
    setErrorCount,
    
    /**
     * Clear error indicator
     */
    clearErrors,
    
    /**
     * Get current state
     */
    getState() {
        return State.current;
    }
};

export default FaviconManager;