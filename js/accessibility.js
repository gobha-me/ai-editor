// ============================================
// ACCESSIBILITY
// ============================================
// Modal focus trapping, keyboard navigation for tree/tabs,
// screen reader announcements, aria-expanded sync.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Element that had focus before a modal opened */
let _previousFocus = null;

/** Active trap teardown function */
let _activeTrap = null;

// ── Screen Reader Announcements ──

let _announceEl = null;

/**
 * Announce a message to screen readers via an sr-only live region.
 * @param {string} message - Text to announce
 * @param {'polite'|'assertive'} priority - Urgency level
 */
export function announce(message, priority = 'polite') {
    if (!_announceEl) {
        _announceEl = document.createElement('div');
        _announceEl.className = 'sr-only';
        _announceEl.setAttribute('aria-live', priority);
        _announceEl.setAttribute('aria-atomic', 'true');
        _announceEl.id = 'a11y-announcer';
        document.body.appendChild(_announceEl);
    }
    _announceEl.setAttribute('aria-live', priority);
    // Clear then set to ensure re-announcement of same message
    _announceEl.textContent = '';
    requestAnimationFrame(() => {
        _announceEl.textContent = message;
    });
}

// ── Modal Focus Trapping ──

/**
 * Trap Tab focus inside a modal. Returns a cleanup function.
 */
function trapFocus(modal) {
    const getFocusable = () => [...modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);

    const handler = (e) => {
        if (e.key !== 'Tab') return;
        const focusable = getFocusable();
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        }
    };

    modal.addEventListener('keydown', handler);

    // Focus the first focusable element (prefer close button or first input)
    requestAnimationFrame(() => {
        const focusable = getFocusable();
        const preferred = modal.querySelector('.modal-close') || modal.querySelector('input, select, textarea') || focusable[0];
        if (preferred) preferred.focus();
    });

    return () => modal.removeEventListener('keydown', handler);
}

/**
 * Watch all modal-overlay elements for active class changes.
 * When a modal opens: save focus, trap Tab inside.
 * When it closes: restore previous focus.
 */
function initModalFocusTrapping() {
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
            const el = m.target;
            if (!el.classList.contains('modal-overlay')) continue;

            const isActive = el.classList.contains('active');

            if (isActive) {
                // Modal opened
                _previousFocus = document.activeElement;
                if (_activeTrap) _activeTrap(); // clean up any existing trap
                _activeTrap = trapFocus(el);
            } else if (_activeTrap) {
                // Modal closed — restore focus
                _activeTrap();
                _activeTrap = null;
                if (_previousFocus && _previousFocus.focus) {
                    _previousFocus.focus();
                    _previousFocus = null;
                }
            }
        }
    });

    // Observe all modal-overlay elements
    document.querySelectorAll('.modal-overlay').forEach(modal => {
        observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    });

    // Also observe dynamically added modals
    const bodyObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType === 1 && node.classList?.contains('modal-overlay')) {
                    observer.observe(node, { attributes: true, attributeFilter: ['class'] });
                }
            }
        }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
}

// ── File Tree Keyboard Navigation ──
// Arrow Up/Down: move between visible items
// Arrow Right: expand directory (or move to first child)
// Arrow Left: collapse directory (or move to parent)
// Enter/Space: open file or toggle directory
// Home/End: jump to first/last visible item

function initFileTreeKeyboard() {
    const container = document.getElementById('fileTree');
    if (!container) return;

    container.addEventListener('keydown', (e) => {
        const current = document.activeElement;
        if (!current?.classList.contains('tree-item')) return;

        const visibleItems = [...container.querySelectorAll('.tree-item')]
            .filter(el => el.offsetParent !== null);
        const idx = visibleItems.indexOf(current);
        if (idx < 0) return;

        switch (e.key) {
            case 'ArrowDown': {
                e.preventDefault();
                const next = visibleItems[idx + 1];
                if (next) _focusTreeItem(next, visibleItems);
                break;
            }
            case 'ArrowUp': {
                e.preventDefault();
                const prev = visibleItems[idx - 1];
                if (prev) _focusTreeItem(prev, visibleItems);
                break;
            }
            case 'ArrowRight': {
                e.preventDefault();
                const path = current.dataset.path;
                const type = current.dataset.type;
                if (type === 'dir') {
                    const children = container.querySelector(`.tree-children[data-parent="${path}"]`);
                    if (children?.classList.contains('collapsed')) {
                        // Expand
                        current.click();
                    } else {
                        // Already expanded — move to first child
                        const firstChild = children?.querySelector('.tree-item');
                        if (firstChild) {
                            const updated = [...container.querySelectorAll('.tree-item')]
                                .filter(el => el.offsetParent !== null);
                            _focusTreeItem(firstChild, updated);
                        }
                    }
                }
                break;
            }
            case 'ArrowLeft': {
                e.preventDefault();
                const path = current.dataset.path;
                const type = current.dataset.type;
                if (type === 'dir') {
                    const children = container.querySelector(`.tree-children[data-parent="${path}"]`);
                    if (children && !children.classList.contains('collapsed')) {
                        // Collapse
                        current.click();
                        break;
                    }
                }
                // Move to parent directory
                const parentGroup = current.closest('.tree-children');
                if (parentGroup) {
                    const parentPath = parentGroup.dataset.parent;
                    const parentItem = container.querySelector(`.tree-item[data-path="${parentPath}"]`);
                    if (parentItem) {
                        const updated = [...container.querySelectorAll('.tree-item')]
                            .filter(el => el.offsetParent !== null);
                        _focusTreeItem(parentItem, updated);
                    }
                }
                break;
            }
            case 'Enter':
            case ' ':
                e.preventDefault();
                current.click();
                break;
            case 'Home': {
                e.preventDefault();
                if (visibleItems.length) _focusTreeItem(visibleItems[0], visibleItems);
                break;
            }
            case 'End': {
                e.preventDefault();
                if (visibleItems.length) _focusTreeItem(visibleItems[visibleItems.length - 1], visibleItems);
                break;
            }
        }
    });
}

function _focusTreeItem(item, allItems) {
    // Roving tabindex
    allItems.forEach(el => { el.tabIndex = -1; });
    item.tabIndex = 0;
    item.focus();
}

// ── Editor Tabs Keyboard Navigation ──
// Arrow Left/Right: move between tabs
// Enter/Space: activate tab
// Delete/Backspace: close tab

function initEditorTabsKeyboard() {
    const tablist = document.getElementById('editorTabs');
    if (!tablist) return;

    tablist.addEventListener('keydown', (e) => {
        const current = document.activeElement;
        if (!current?.classList.contains('editor-tab')) return;

        const tabs = [...tablist.querySelectorAll('.editor-tab')];
        const idx = tabs.indexOf(current);
        if (idx < 0) return;

        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowDown': {
                e.preventDefault();
                const next = tabs[(idx + 1) % tabs.length];
                _focusTab(next, tabs);
                next.click();
                break;
            }
            case 'ArrowLeft':
            case 'ArrowUp': {
                e.preventDefault();
                const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
                _focusTab(prev, tabs);
                prev.click();
                break;
            }
            case 'Home': {
                e.preventDefault();
                _focusTab(tabs[0], tabs);
                tabs[0].click();
                break;
            }
            case 'End': {
                e.preventDefault();
                _focusTab(tabs[tabs.length - 1], tabs);
                tabs[tabs.length - 1].click();
                break;
            }
            case 'Delete':
            case 'Backspace': {
                e.preventDefault();
                const closeBtn = current.querySelector('.close');
                if (closeBtn) closeBtn.click();
                break;
            }
        }
    });
}

function _focusTab(tab, allTabs) {
    allTabs.forEach(t => { t.tabIndex = -1; });
    tab.tabIndex = 0;
    tab.focus();
}

// ── Settings Tabs Keyboard Navigation ──
// Arrow Left/Right within the tablist

function initSettingsTabsKeyboard() {
    const observer = new MutationObserver(() => {
        const tablist = document.querySelector('.settings-tabs[role="tablist"]');
        if (!tablist || tablist.dataset.a11yBound) return;
        tablist.dataset.a11yBound = 'true';

        tablist.addEventListener('keydown', (e) => {
            const current = document.activeElement;
            if (!current?.classList.contains('settings-tab')) return;

            const tabs = [...tablist.querySelectorAll('.settings-tab')];
            const idx = tabs.indexOf(current);
            if (idx < 0) return;

            let target = null;
            switch (e.key) {
                case 'ArrowRight':
                    target = tabs[(idx + 1) % tabs.length];
                    break;
                case 'ArrowLeft':
                    target = tabs[(idx - 1 + tabs.length) % tabs.length];
                    break;
                case 'Home':
                    target = tabs[0];
                    break;
                case 'End':
                    target = tabs[tabs.length - 1];
                    break;
            }

            if (target) {
                e.preventDefault();
                target.focus();
                target.click();
            }
        });
    });

    // Settings tabs are injected by template-loader, watch for them
    const container = document.getElementById('settingsTabsContainer');
    if (container) {
        observer.observe(container, { childList: true, subtree: true });
    }
}

// ── Init ──

export function initAccessibility() {
    initModalFocusTrapping();
    initFileTreeKeyboard();
    initEditorTabsKeyboard();
    initSettingsTabsKeyboard();
    console.log('[A11y] Accessibility features initialized');
}
