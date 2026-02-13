/**
 * AI Editor - Mobile Layout Controller
 *
 * Bottom tab bar for single-panel mode on mobile (≤768px).
 * Switches between sidebar / editor / chat.
 *
 * Desktop: tab bar is display:none via CSS, this module is inert.
 * Mobile:  tab bar shown, handles panel switching via .mobile-active class.
 */

import { EventBus } from './core.js';

const MOBILE_BREAKPOINT = 768;
let _activePanel = 'editor';
let _isMobile = false;

// ============================================
// PUBLIC API
// ============================================

/**
 * Initialize mobile layout. Call once after DOM ready.
 * Injects the tab bar HTML and wires up listeners.
 */
export function initMobile() {
    _injectTabBar();
    _bindListeners();
    _checkBreakpoint();

    // Re-check on resize (debounced)
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(_checkBreakpoint, 150);
    });
}

/**
 * Programmatically switch to a panel on mobile.
 * No-op on desktop.
 */
export function mobileShowPanel(panel) {
    if (!_isMobile) return;
    _switchTo(panel);
}

// ============================================
// TAB BAR INJECTION
// ============================================

function _injectTabBar() {
    // Add at the end of .app-container (after main-content)
    const app = document.getElementById('app');
    if (!app) return;

    const bar = document.createElement('nav');
    bar.className = 'mobile-tab-bar';
    bar.id = 'mobileTabBar';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', 'Panel navigation');

    bar.innerHTML = `
        <button class="mobile-tab" data-panel="sidebar" role="tab" aria-selected="false" aria-label="Files">
            📁<span>Files</span>
            <span class="mobile-badge" id="mobileBadgeSidebar"></span>
        </button>
        <button class="mobile-tab active" data-panel="editor" role="tab" aria-selected="true" aria-label="Editor">
            ⚡<span>Editor</span>
        </button>
        <button class="mobile-tab" data-panel="chat" role="tab" aria-selected="false" aria-label="Chat">
            💬<span>Chat</span>
            <span class="mobile-badge" id="mobileBadgeChat"></span>
        </button>
    `;

    app.appendChild(bar);
}

// ============================================
// PANEL SWITCHING
// ============================================

function _switchTo(panel) {
    _activePanel = panel;

    const sidebar = document.getElementById('sidebar');
    const chatPanel = document.getElementById('chatPanel');
    const tabs = document.querySelectorAll('.mobile-tab');

    // Remove mobile-active from all panels
    sidebar?.classList.remove('mobile-active');
    chatPanel?.classList.remove('mobile-active');

    // Activate the requested panel
    if (panel === 'sidebar') {
        sidebar?.classList.add('mobile-active');
    } else if (panel === 'chat') {
        chatPanel?.classList.add('mobile-active');
    }
    // 'editor' = neither overlay is active → editor shows as base layer

    // Update tab bar
    tabs.forEach(tab => {
        const isActive = tab.dataset.panel === panel;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
    });

    // Clear badge for the panel we just opened
    _clearBadge(panel);
}

// ============================================
// BADGE NOTIFICATIONS
// ============================================

function _showBadge(panel) {
    if (_activePanel === panel) return;  // don't badge the active panel
    const id = panel === 'sidebar' ? 'mobileBadgeSidebar'
             : panel === 'chat' ? 'mobileBadgeChat' : null;
    if (id) {
        const badge = document.getElementById(id);
        if (badge) badge.style.display = 'block';
    }
}

function _clearBadge(panel) {
    const id = panel === 'sidebar' ? 'mobileBadgeSidebar'
             : panel === 'chat' ? 'mobileBadgeChat' : null;
    if (id) {
        const badge = document.getElementById(id);
        if (badge) badge.style.display = 'none';
    }
}

// ============================================
// EVENT LISTENERS
// ============================================

function _bindListeners() {
    // Tab bar clicks
    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.mobile-tab');
        if (!tab || !_isMobile) return;
        _switchTo(tab.dataset.panel);
    });

    // Auto-switch to editor when a file is opened
    EventBus.on('file:opened', () => {
        if (_isMobile) _switchTo('editor');
    });

    // Auto-switch to editor when a tab is switched
    EventBus.on('tab:switched', () => {
        if (_isMobile) _switchTo('editor');
    });

    // Badge chat when assistant message arrives while not on chat
    EventBus.on('chat:message', (msg) => {
        if (_isMobile && msg?.role === 'assistant') {
            _showBadge('chat');
        }
    });

    // Badge sidebar when tree refreshes while not on sidebar
    EventBus.on('tree:refresh', () => {
        if (_isMobile) _showBadge('sidebar');
    });
}

// ============================================
// BREAKPOINT DETECTION
// ============================================

function _checkBreakpoint() {
    const wasMobile = _isMobile;
    _isMobile = window.innerWidth <= MOBILE_BREAKPOINT;

    if (_isMobile && !wasMobile) {
        // Entered mobile: activate current panel
        _switchTo(_activePanel);
    } else if (!_isMobile && wasMobile) {
        // Left mobile: remove mobile-active from all panels
        // so desktop layout takes over via CSS
        document.getElementById('sidebar')?.classList.remove('mobile-active');
        document.getElementById('chatPanel')?.classList.remove('mobile-active');
    }
}
