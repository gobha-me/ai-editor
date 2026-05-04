// @ts-check
/**
 * Index Indicator
 * 
 * Compact header widget showing context indexing progress with play/pause control.
 * Auto-pauses when LLM is generating or user initiates file operations,
 * resumes when those operations complete.
 *
 * @module index-indicator
 */

import { EventBus } from './core.js';
import { RetrievalManager } from './intelligence/retrieval/manager.js';

/** @type {HTMLElement|null} */
let containerEl = null;
/** @type {HTMLElement|null} */
let progressEl = null;
/** @type {HTMLButtonElement|null} */
let btnEl = null;
/** @type {number} Auto-resume timer */
let autoResumeTimer = 0;

/**
 * Initialize the index indicator. Call once at boot from app.js.
 * Injects into the header between the cost tracker and the action buttons.
 */
export function initIndexIndicator() {
    _createWidget();
    _bindEvents();
}

// ============================================
// WIDGET CREATION
// ============================================

function _createWidget() {
    containerEl = document.createElement('div');
    containerEl.id = 'indexIndicator';
    containerEl.className = 'index-indicator';
    containerEl.setAttribute('role', 'status');
    containerEl.setAttribute('aria-label', 'Context indexing status');
    containerEl.style.display = 'none'; // Hidden until indexing starts

    btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.className = 'index-indicator-btn';
    btnEl.title = 'Pause indexing';
    btnEl.setAttribute('aria-label', 'Pause context indexing');
    btnEl.textContent = '⏸';
    btnEl.onclick = () => RetrievalManager.togglePause();

    progressEl = document.createElement('span');
    progressEl.className = 'index-indicator-text';
    progressEl.textContent = 'Indexing…';

    containerEl.appendChild(btnEl);
    containerEl.appendChild(progressEl);

    // Insert between cost tracker and nav actions
    const header = document.querySelector('.app-header');
    const nav = document.querySelector('.header-actions');
    if (header && nav) {
        header.insertBefore(containerEl, nav);
    }
}

// ============================================
// EVENT BINDINGS
// ============================================

function _bindEvents() {
    // Indexing lifecycle
    EventBus.on('context:indexStart', () => _show());
    EventBus.on('context:indexProgress', ({ current, total, percent }) => {
        _updateProgress(current, total, percent);
    });
    EventBus.on('context:indexComplete', ({ filesIndexed, eligible }) => {
        if (filesIndexed < eligible) {
            _showPartial(filesIndexed, eligible);
        } else {
            _hide();
        }
    });
    EventBus.on('context:indexError', () => _hide());

    // Pause state changes (manual or auto)
    EventBus.on('context:pauseChanged', ({ paused, manual, auto, indexing }) => {
        if (!indexing) return;
        _updatePauseState(paused, manual, auto);
    });

    // Auto-pause triggers: LLM generating
    EventBus.on('llm:generating', (active) => {
        if (active) {
            _triggerAutoPause();
        } else {
            _triggerAutoResume();
        }
    });

    // Auto-pause triggers: user/LLM file operations via Git facade events
    EventBus.on('git:writeStart', () => _triggerAutoPause());
    EventBus.on('git:writeEnd', () => _triggerAutoResume());
}

// ============================================
// DISPLAY
// ============================================

function _show() {
    if (containerEl) {
        containerEl.style.display = '';
        containerEl.classList.remove('index-partial');
        if (btnEl) btnEl.onclick = () => RetrievalManager.togglePause();
        _updatePauseState(false, false, false);
    }
}

function _hide() {
    if (containerEl) containerEl.style.display = 'none';
}

/**
 * Show partial completion state — indexing finished but not all files made it.
 * Button becomes a "resume" action.
 */
function _showPartial(indexed, total) {
    if (!containerEl || !btnEl || !progressEl) return;
    containerEl.style.display = '';
    containerEl.classList.remove('index-paused', 'index-auto-paused');
    containerEl.classList.add('index-partial');
    btnEl.textContent = '🔄';
    btnEl.title = `${indexed}/${total} indexed — click to resume`;
    btnEl.setAttribute('aria-label', 'Resume incomplete indexing');
    progressEl.textContent = `${indexed}/${total}`;
    containerEl.title = `Partial index: ${indexed} of ${total} files. Click 🔄 to resume.`;

    // Swap click handler to resume
    btnEl.onclick = () => {
        btnEl.onclick = () => RetrievalManager.togglePause(); // Restore normal handler
        RetrievalManager.indexProject(false, true); // resume=true
    };
}

function _updateProgress(current, total, percent) {
    if (!progressEl || !containerEl) return;
    progressEl.textContent = `${current}/${total}`;
    containerEl.title = `Indexing context: ${current} of ${total} files (${percent}%)`;
}

function _updatePauseState(paused, manual, auto) {
    if (!btnEl || !progressEl) return;
    if (paused) {
        btnEl.textContent = '▶';
        btnEl.title = manual ? 'Resume indexing' : 'Indexing paused (auto) — click to resume';
        btnEl.setAttribute('aria-label', 'Resume context indexing');
        containerEl?.classList.add('index-paused');
        if (auto && !manual) {
            containerEl?.classList.add('index-auto-paused');
        } else {
            containerEl?.classList.remove('index-auto-paused');
        }
    } else {
        btnEl.textContent = '⏸';
        btnEl.title = 'Pause indexing';
        btnEl.setAttribute('aria-label', 'Pause context indexing');
        containerEl?.classList.remove('index-paused', 'index-auto-paused');
    }
}

// ============================================
// AUTO-PAUSE LOGIC
// ============================================

function _triggerAutoPause() {
    clearTimeout(autoResumeTimer);
    RetrievalManager.autoPause();
}

function _triggerAutoResume() {
    // Small delay before resuming — avoids flapping during rapid tool calls
    clearTimeout(autoResumeTimer);
    autoResumeTimer = setTimeout(() => RetrievalManager.autoResume(), 2000);
}
