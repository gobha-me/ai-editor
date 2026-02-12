// @ts-check
/**
 * Offline Indicator
 *
 * Displays a non-intrusive banner when the browser loses network connectivity.
 * Uses the `online` / `offline` events plus a periodic fetch probe to catch
 * cases where `navigator.onLine` lies (e.g. captive portals, DNS failures).
 *
 * @module offline-indicator
 */

import { EventBus } from './core.js';

/** @type {HTMLElement|null} */
let bannerEl = null;

/** @type {number|null} */
let probeTimer = null;

/** Whether we believe the network is reachable. */
let isOnline = navigator.onLine;

/**
 * Initialize the offline indicator.
 * Call once at boot (from app.js). Injects the banner element and
 * starts listening for connectivity changes.
 */
export function initOfflineIndicator() {
    _createBanner();

    window.addEventListener('offline', () => _setOnline(false));
    window.addEventListener('online', () => {
        // navigator.onLine flipped true — but verify with a real fetch
        _probe();
    });

    // If already offline at boot, show immediately
    if (!navigator.onLine) {
        _setOnline(false);
    }
}

/**
 * Update online state and toggle banner visibility.
 * @param {boolean} online
 */
function _setOnline(online) {
    const changed = isOnline !== online;
    isOnline = online;

    if (bannerEl) {
        bannerEl.style.display = online ? 'none' : 'flex';
    }

    if (changed) {
        EventBus.emit('network:status', { online });
        console.log(`[Offline] Network ${online ? 'restored ✓' : 'lost ✗'}`);
    }

    // When offline, start probing every 10s to detect recovery
    if (!online && !probeTimer) {
        probeTimer = window.setInterval(_probe, 10_000);
    }
    // When back online, stop probing
    if (online && probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
    }
}

/**
 * Probe actual connectivity by fetching a tiny resource.
 * Uses the LLM endpoint's /models or falls back to a HEAD on the app's own origin.
 */
async function _probe() {
    try {
        // Try a lightweight HEAD against the page origin (cache-busted)
        const resp = await fetch(`${location.origin}/?_cb=${Date.now()}`, {
            method: 'HEAD',
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
        });
        if (resp.ok || resp.status === 304) {
            _setOnline(true);
        }
    } catch {
        _setOnline(false);
    }
}

/**
 * Inject the banner element into the DOM.
 * Styled inline to avoid depending on an external CSS file.
 */
function _createBanner() {
    bannerEl = document.createElement('div');
    bannerEl.id = 'offline-banner';
    bannerEl.setAttribute('role', 'alert');
    bannerEl.setAttribute('aria-live', 'assertive');
    Object.assign(bannerEl.style, {
        display: 'none',
        position: 'fixed',
        bottom: '0',
        left: '0',
        right: '0',
        zIndex: '9999',
        padding: '8px 16px',
        background: '#b91c1c',
        color: '#fff',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        boxShadow: '0 -2px 8px rgba(0,0,0,0.3)',
    });
    bannerEl.innerHTML = '⚠️ <strong>Offline</strong> — Network connection lost. Changes are saved locally.';
    document.body.appendChild(bannerEl);
}
