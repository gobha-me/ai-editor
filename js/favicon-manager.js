/**
 * Favicon Manager - Dynamic status indicator for the application favicon
 * Updates the favicon based on application state (idle, loading, error)
 */

import { EventBus } from './core.js';

export const FaviconManager = {
    /**
     * Initialize the favicon manager
     * Sets up event listeners and creates the canvas for favicon generation
     */
    init() {
        // Get or create the favicon link element
        this.faviconLink = document.querySelector('link[rel="icon"]') || document.querySelector('link[rel="shortcut icon"]');
        if (!this.faviconLink) {
            this.faviconLink = document.createElement('link');
            this.faviconLink.rel = 'icon';
            document.head.appendChild(this.faviconLink);
        }

        // Store the original favicon
        this.originalFavicon = this.faviconLink.href;

        // Create canvas for favicon generation
        this.canvas = document.createElement('canvas');
        this.canvas.width = 32;
        this.canvas.height = 32;
        this.ctx = this.canvas.getContext('2d');

        // Set initial state
        this.currentStatus = 'idle';

        // Listen for application events
        this._setupEventListeners();

        // Set initial favicon
        this.setStatus('idle');
    },

    /**
     * Set up event listeners for application state changes
     * @private
     */
    _setupEventListeners() {
        // Listen for LLM generating state changes
        EventBus.on('llm:generating', (isGenerating) => {
            this.setStatus(isGenerating ? 'loading' : 'idle');
        });

        // Listen for errors
        EventBus.on('error', () => {
            this.setStatus('error');
            // Reset to idle after 3 seconds
            setTimeout(() => this.setStatus('idle'), 3000);
        });
    },

    /**
     * Set the favicon status
     * @param {string} status - One of: 'idle', 'loading', 'error'
     */
    setStatus(status) {
        this.currentStatus = status;

        switch (status) {
            case 'loading':
                this._startLoadingAnimation();
                break;
            case 'error':
                this._drawErrorIcon();
                break;
            case 'idle':
            default:
                this._stopLoadingAnimation();
                this._drawIdleIcon();
                break;
        }
    },

    /**
     * Convenience method to set error status
     */
    setError() {
        this.setStatus('error');
    },

    /**
     * Convenience method to set loading status
     */
    setLoading() {
        this.setStatus('loading');
    },

    /**
     * Convenience method to set idle status
     */
    setIdle() {
        this.setStatus('idle');
    },

    /**
     * Draw the idle icon (default application icon)
     * @private
     */
    _drawIdleIcon() {
        const ctx = this.ctx;
        const size = 32;

        // Clear canvas
        ctx.clearRect(0, 0, size, size);

        // Draw a simple code/editor icon
        // Background
        ctx.fillStyle = '#3b82f6'; // Blue color
        ctx.beginPath();
        ctx.roundRect(2, 2, size - 4, size - 4, 6);
        ctx.fill();

        // Draw code brackets
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Left bracket
        ctx.beginPath();
        ctx.moveTo(12, 10);
        ctx.lineTo(8, 16);
        ctx.lineTo(12, 22);
        ctx.stroke();

        // Right bracket
        ctx.beginPath();
        ctx.moveTo(20, 10);
        ctx.lineTo(24, 16);
        ctx.lineTo(20, 22);
        ctx.stroke();

        // Slash in middle
        ctx.beginPath();
        ctx.moveTo(15, 24);
        ctx.lineTo(17, 8);
        ctx.stroke();

        this._updateFavicon();
    },

    /**
     * Draw the error icon
     * @private
     */
    _drawErrorIcon() {
        const ctx = this.ctx;
        const size = 32;

        // Clear canvas
        ctx.clearRect(0, 0, size, size);

        // Draw red background
        ctx.fillStyle = '#ef4444'; // Red color
        ctx.beginPath();
        ctx.roundRect(2, 2, size - 4, size - 4, 6);
        ctx.fill();

        // Draw X symbol
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(10, 10);
        ctx.lineTo(22, 22);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(22, 10);
        ctx.lineTo(10, 22);
        ctx.stroke();

        this._updateFavicon();
    },

    /**
     * Start the loading animation
     * @private
     */
    _startLoadingAnimation() {
        if (this.loadingInterval) {
            clearInterval(this.loadingInterval);
        }

        let rotation = 0;
        this.loadingInterval = setInterval(() => {
            this._drawLoadingIcon(rotation);
            rotation += 30;
        }, 100);
    },

    /**
     * Stop the loading animation
     * @private
     */
    _stopLoadingAnimation() {
        if (this.loadingInterval) {
            clearInterval(this.loadingInterval);
            this.loadingInterval = null;
        }
    },

    /**
     * Draw the loading icon with rotation
     * @param {number} rotation - Current rotation angle in degrees
     * @private
     */
    _drawLoadingIcon(rotation) {
        const ctx = this.ctx;
        const size = 32;
        const center = size / 2;
        const radius = 10;

        // Clear canvas
        ctx.clearRect(0, 0, size, size);

        // Draw background
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.roundRect(2, 2, size - 4, size - 4, 6);
        ctx.fill();

        // Save context for rotation
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.translate(-center, -center);

        // Draw spinner arc
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.arc(center, center, radius, 0, (5 * Math.PI) / 3);
        ctx.stroke();

        // Restore context
        ctx.restore();

        this._updateFavicon();
    },

    /**
     * Update the favicon link with the current canvas content
     * @private
     */
    _updateFavicon() {
        try {
            const dataUrl = this.canvas.toDataURL('image/png');
            this.faviconLink.href = dataUrl;
        } catch (e) {
            console.error('[FaviconManager] Failed to update favicon:', e);
        }
    },

    /**
     * Reset to the original favicon
     */
    reset() {
        this._stopLoadingAnimation();
        if (this.originalFavicon) {
            this.faviconLink.href = this.originalFavicon;
        }
    }
};
