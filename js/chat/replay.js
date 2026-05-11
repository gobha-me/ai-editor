// @ts-check
/**
 * Session replay — read-only stepper for `.aieditor.session` archives
 * (1.3.3).
 *
 * Builds on the schema_version:1 contract from 1.3.2. The same
 * `serialize`/`parse` pair from `js/chat/sessions-sync.js` powers both
 * the repo-sync projection and the standalone archive — replay is the
 * second consumer of the shape, validating that it isn't sync-only.
 *
 * Two entry points:
 *   - `exportConversationToFile(id)` — download the named conversation
 *     as a single JSON file (no repo dependency, no IndexedDB on the
 *     destination side).
 *   - `openReplayModal()` — open the modal in empty-drop-zone state.
 *     `loadFromFile(file)` parses the archive and flips into stepper
 *     mode; navigation via prev/next/goto.
 *
 * View-only by construction: replay state lives in this module's
 * closure and never enters `ConversationManager`. There is no path
 * here that mutates `State.chatHistory`, `Storage`, the IDB, or the
 * Git provider.
 *
 * @module chat/replay
 */

import { Storage } from '../core.js';
import { ConversationManager } from './conversations.js';
import { serialize, parse } from './sessions-sync.js';
import { formatMessageContent } from './messages.js';
import { stripThinkBlocks } from '../llm.js';
import { escapeHtml } from '../utils/html.js';
import { showToast } from '../ui-helpers.js';

/* -------------------------------------------------------------------------- */
/* Module state                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ReplayState
 * @property {Object|null} indexEntry — parsed index-entry shape from sessions-sync.parse
 * @property {Object|null} payload    — `{ messages, summaryInfo, pruneStash }`
 * @property {Object|null} meta       — `{ syncedBy, lastSyncedAt }`
 * @property {number}     index       — active turn index into payload.messages
 * @property {string}     sourceLabel — display string for the archive's origin
 */
/** @type {ReplayState} */
let _state = {
    indexEntry: null,
    payload: null,
    meta: null,
    index: 0,
    sourceLabel: '',
};

let _keyHandler = null;
let _dropHandlersWired = false;

/* -------------------------------------------------------------------------- */
/* Public API — export                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the JSON content for a conversation by id, using the same
 * `serialize` path as 1.3.2's repo projection. Returns `null` if the
 * conversation isn't in the local index or has no payload.
 *
 * @param {string} id
 * @returns {{ filename: string, content: string }|null}
 */
export function buildArchiveForConversation(id) {
    if (typeof id !== 'string' || id.length === 0) return null;

    const index = Storage.get('conversations') || [];
    const indexEntry = index.find((c) => c && c.id === id);
    if (!indexEntry) return null;

    const payload = Storage.get(`conv-${id}`);
    if (!payload) return null;

    const content = serialize(indexEntry, payload, {
        syncedBy: 'user:export',
        lastSyncedAt: Date.now(),
    });

    return {
        filename: _suggestFilename(indexEntry),
        content,
    };
}

/**
 * Trigger a browser download of a single conversation as a
 * `.aieditor.session` JSON file. No repo dependency. Wired to the
 * "Download .aieditor.session" entry in the conversation drawer.
 *
 * @param {string} id
 */
export function exportConversationToFile(id) {
    const archive = buildArchiveForConversation(id);
    if (!archive) {
        if (typeof showToast === 'function') {
            showToast('Conversation not found', 'warning');
        }
        return;
    }

    const blob = new Blob([archive.content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = archive.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke after the click microtask settles.
    setTimeout(() => URL.revokeObjectURL(url), 0);

    if (typeof showToast === 'function') {
        showToast(`Exported ${archive.filename}`, 'success');
    }
}

/* -------------------------------------------------------------------------- */
/* Public API — modal lifecycle                                               */
/* -------------------------------------------------------------------------- */

/**
 * Open the replay modal. Empty state shows the drop zone; if a payload
 * is already loaded (re-open without close), the stepper layout is
 * preserved.
 */
export function openReplayModal() {
    const modal = document.getElementById('replayModal');
    if (!modal) return;

    _wireDropHandlersOnce();

    // If we have a parsed payload from a previous open(), keep showing it.
    // Otherwise reset to the drop-zone state.
    if (!_state.payload) {
        _resetToEmptyState();
    } else {
        _renderStepper();
    }

    modal.classList.add('active');
    _attachKeyHandler();
}

/**
 * Close the replay modal. Releases the keyboard handler. Does *not*
 * clear the loaded payload — re-opening keeps the same archive in view
 * unless the user drops a different file.
 */
export function closeReplayModal() {
    const modal = document.getElementById('replayModal');
    if (modal) modal.classList.remove('active');
    _detachKeyHandler();
}

/**
 * Bind a delegated click handler for the replay modal's action buttons.
 * Idempotent — safe to call from `init()` multiple times.
 *
 * Phase 2a of the inline-handlers migration (DESIGN-html-inline-handlers-migration.md).
 */
let _wired = false;
export function mountReplayModal({ onClose, onPrev, onNext } = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('#replayModal')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'closeReplayModal' && typeof onClose === 'function') {
            onClose();
        } else if (action === 'replayPrev' && typeof onPrev === 'function') {
            onPrev();
        } else if (action === 'replayNext' && typeof onNext === 'function') {
            onNext();
        }
    });
}

/**
 * Parse a session-archive File object and switch the modal into
 * stepper mode. Surfaces validation failures inline (drop-zone error
 * banner) rather than as toasts so the user sees the reason without
 * having to look elsewhere.
 *
 * @param {File} file
 * @returns {Promise<boolean>} true on successful load
 */
export async function loadFromFile(file) {
    if (!file) return false;

    const errEl = document.getElementById('replayDropError');
    const setError = (msg) => {
        if (errEl) {
            errEl.textContent = msg;
            errEl.style.display = 'block';
        }
    };

    let text;
    try {
        text = await file.text();
    } catch (err) {
        setError(`Could not read file: ${err && err.message ? err.message : err}`);
        return false;
    }

    return loadFromString(text, file.name || 'archive');
}

/**
 * Parse a session-archive string and switch the modal into stepper
 * mode. Used by drag-drop, file picker, and tests.
 *
 * @param {string} content
 * @param {string} [sourceLabel]
 * @returns {boolean}
 */
export function loadFromString(content, sourceLabel = 'archive') {
    const errEl = document.getElementById('replayDropError');
    const setError = (msg) => {
        if (errEl) {
            errEl.textContent = msg;
            errEl.style.display = 'block';
        }
    };

    const parsed = parse(content, { sourcePath: sourceLabel });
    if (!parsed.ok) {
        const w = parsed.warning || {};
        const reason = w.type === 'malformed_json'
            ? `Not valid JSON: ${w.message || 'parse error'}`
            : w.type === 'missing_id'
                ? 'Archive is missing a conversation id.'
                : w.type === 'empty'
                    ? 'File is empty.'
                    : 'Archive could not be parsed.';
        setError(reason);
        return false;
    }

    // 1.3.2 schema version is the only one we know how to render. If a
    // future archive bumps to v2 (additive fields are fine; structural
    // change isn't), surface a clear message rather than rendering a
    // partial view.
    let raw;
    try {
        raw = JSON.parse(content);
    } catch {
        setError('Archive could not be parsed.');
        return false;
    }
    if (Number.isFinite(raw.schema_version) && raw.schema_version > 1) {
        setError(
            `This archive uses schema_version ${raw.schema_version}. ` +
            `Update AI Editor to view it (this build understands schema_version 1).`,
        );
        return false;
    }

    _state.indexEntry = parsed.indexEntry;
    _state.payload = parsed.payload;
    _state.meta = parsed.meta;
    _state.index = 0;
    _state.sourceLabel = sourceLabel;

    _renderStepper();
    return true;
}

/**
 * Move to the next turn (no-op past the end).
 */
export function next() {
    if (!_state.payload) return;
    const total = (_state.payload.messages || []).length;
    if (_state.index < total - 1) {
        _state.index += 1;
        _renderActiveTurn();
        _renderTurnList();
        _renderNav();
    }
}

/**
 * Move to the previous turn (no-op at the start).
 */
export function prev() {
    if (!_state.payload) return;
    if (_state.index > 0) {
        _state.index -= 1;
        _renderActiveTurn();
        _renderTurnList();
        _renderNav();
    }
}

/**
 * Jump to a specific turn by index. Out-of-range is clamped.
 *
 * @param {number} idx
 */
export function goto(idx) {
    if (!_state.payload) return;
    const total = (_state.payload.messages || []).length;
    if (total === 0) return;
    const clamped = Math.max(0, Math.min(total - 1, Math.floor(idx)));
    _state.index = clamped;
    _renderActiveTurn();
    _renderTurnList();
    _renderNav();
}

/**
 * Drop the loaded archive and return to the empty drop-zone state.
 * Useful for tests and for users who want to load a different archive
 * without closing the modal first.
 */
export function clearLoaded() {
    _state = {
        indexEntry: null,
        payload: null,
        meta: null,
        index: 0,
        sourceLabel: '',
    };
    _resetToEmptyState();
}

/* -------------------------------------------------------------------------- */
/* Internals — DOM rendering                                                  */
/* -------------------------------------------------------------------------- */

function _resetToEmptyState() {
    const body = document.getElementById('replayBody');
    if (body) body.classList.remove('replay-mode-active');

    const errEl = document.getElementById('replayDropError');
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }

    const meta = document.getElementById('replayMeta');
    if (meta) meta.textContent = '';
    const pos = document.getElementById('replayPos');
    if (pos) pos.textContent = '—';

    const prevBtn = /** @type {HTMLButtonElement|null} */(document.getElementById('btnReplayPrev'));
    const nextBtn = /** @type {HTMLButtonElement|null} */(document.getElementById('btnReplayNext'));
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
}

function _renderStepper() {
    const body = document.getElementById('replayBody');
    if (body) body.classList.add('replay-mode-active');
    _renderTurnList();
    _renderActiveTurn();
    _renderNav();
}

function _renderTurnList() {
    const list = document.getElementById('replayTurnList');
    if (!list || !_state.payload) return;

    const messages = _state.payload.messages || [];
    if (messages.length === 0) {
        list.innerHTML = '<div class="replay-empty">This conversation has no messages.</div>';
        return;
    }

    const rows = messages.map((msg, i) => {
        const role = String(msg.role || 'unknown');
        const icon = _roleIcon(role, msg);
        const label = _shortLabelForTurn(msg, i);
        const activeClass = i === _state.index ? ' replay-turn-active' : '';
        return `
            <button type="button" class="replay-turn-item${activeClass}" data-replay-goto="${i}" aria-current="${i === _state.index ? 'true' : 'false'}">
                <span class="replay-turn-num">${i + 1}</span>
                <span class="replay-turn-icon" aria-hidden="true">${icon}</span>
                <span class="replay-turn-label">${escapeHtml(label)}</span>
            </button>
        `;
    }).join('');

    list.innerHTML = rows;

    list.querySelectorAll('[data-replay-goto]').forEach((el) => {
        el.addEventListener('click', () => {
            const idx = Number(/** @type {HTMLElement} */(el).dataset.replayGoto);
            if (Number.isFinite(idx)) goto(idx);
        });
    });

    // Keep the active row in view when navigation happens via keyboard
    // or the prev/next buttons.
    const activeEl = list.querySelector('.replay-turn-active');
    if (activeEl && typeof /** @type {HTMLElement} */(activeEl).scrollIntoView === 'function') {
        /** @type {HTMLElement} */(activeEl).scrollIntoView({ block: 'nearest' });
    }
}

function _renderActiveTurn() {
    const pane = document.getElementById('replayPane');
    if (!pane || !_state.payload) return;

    const messages = _state.payload.messages || [];
    if (messages.length === 0) {
        pane.innerHTML = '';
        return;
    }
    const msg = messages[_state.index];
    pane.innerHTML = _renderMessageHtml(msg);
}

function _renderNav() {
    const messages = (_state.payload && _state.payload.messages) || [];
    const total = messages.length;

    const prevBtn = /** @type {HTMLButtonElement|null} */(document.getElementById('btnReplayPrev'));
    const nextBtn = /** @type {HTMLButtonElement|null} */(document.getElementById('btnReplayNext'));
    if (prevBtn) prevBtn.disabled = _state.index <= 0;
    if (nextBtn) nextBtn.disabled = _state.index >= total - 1;

    const pos = document.getElementById('replayPos');
    if (pos) pos.textContent = total === 0 ? '0 / 0' : `${_state.index + 1} / ${total}`;

    const meta = document.getElementById('replayMeta');
    if (meta && _state.indexEntry) {
        const title = _state.indexEntry.title || 'Untitled';
        const created = _state.indexEntry.createdAt
            ? new Date(_state.indexEntry.createdAt).toLocaleDateString()
            : '';
        const src = _state.sourceLabel ? ` · ${_state.sourceLabel}` : '';
        meta.textContent = `${title}${created ? ' · ' + created : ''}${src}`;
    }

    const title = document.getElementById('replayTitle');
    if (title) {
        const t = _state.indexEntry && _state.indexEntry.title
            ? `▶ ${_state.indexEntry.title}`
            : '▶ Session Replay';
        title.textContent = t;
    }
}

/* -------------------------------------------------------------------------- */
/* Internals — message HTML (read-only)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Render a single message into HTML, modeled after the chat panel's
 * own rendering but stripped of action buttons (no copy / retry /
 * apply / regenerate). Tool messages render their `_display` payload
 * as the chat does; assistants render reasoning + content; users
 * render content + any attached images.
 *
 * @param {Object} msg
 * @returns {string} HTML
 */
function _renderMessageHtml(msg) {
    if (!msg || typeof msg !== 'object') return '<div class="replay-empty">Empty turn.</div>';

    const role = String(msg.role || 'unknown');

    if (role === 'tool') {
        return _renderToolMessageHtml(msg);
    }
    // Assistant tool-call-only messages (no visible content) — surface
    // the tool_calls metadata so replay doesn't show a blank bubble.
    if (role === 'assistant' && !msg.content && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        return _renderAssistantToolCallsHtml(msg);
    }

    const roleIcon = {
        user: '👤',
        assistant: '🤖',
        system: 'ℹ️',
        error: '❌',
    }[role] || '💬';
    const roleName = {
        user: 'You',
        assistant: 'Assistant',
        system: 'System',
        error: 'Error',
    }[role] || role;

    const ts = Number.isFinite(msg.timestamp) ? new Date(msg.timestamp).toLocaleString() : '';
    const elapsed = (role === 'assistant' && Number.isFinite(msg.elapsedTime))
        ? ` · ${Math.round(msg.elapsedTime * 10) / 10}s ⏱️`
        : '';

    let displayContent;
    let images = [];
    if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((c) => c && c.type === 'text').map((c) => c.text || '');
        displayContent = textParts.join('\n');
        images = msg.content
            .filter((c) => c && c.type === 'image_url')
            .map((c) => c.image_url && c.image_url.url)
            .filter(Boolean);
    } else if (typeof msg.content === 'string') {
        displayContent = role === 'assistant' ? stripThinkBlocks(msg.content) : msg.content;
    } else if (msg.content == null) {
        displayContent = '';
    } else {
        displayContent = JSON.stringify(msg.content, null, 2);
    }

    const reasoningHtml = (
        role === 'assistant'
        && msg.reasoning
        && typeof msg.reasoning.content === 'string'
        && msg.reasoning.content.length > 0
    )
        ? _renderReasoningHtml(msg.reasoning)
        : '';

    const imagesHtml = images.length > 0
        ? `<div class="message-images">${images.map((url) =>
            `<img src="${escapeHtml(url)}" alt="Attached image" class="message-image">`).join('')}</div>`
        : '';

    return `
        <article class="chat-message ${escapeHtml(role)} replay-message">
            <div class="message-header">
                <span class="message-role">${roleIcon} ${escapeHtml(roleName)}</span>
                <span class="message-time">${escapeHtml(ts)}${elapsed}</span>
            </div>
            ${imagesHtml}
            ${reasoningHtml}
            <div class="message-content">${formatMessageContent(displayContent || '')}</div>
        </article>
    `;
}

function _renderReasoningHtml(reasoning) {
    const elapsed =
        (Number.isFinite(reasoning.started_at) && Number.isFinite(reasoning.ended_at))
            ? Math.max(0, Math.round((reasoning.ended_at - reasoning.started_at) / 100) / 10)
            : null;
    const meta = [
        reasoning.provider || null,
        elapsed != null ? `${elapsed}s` : null,
    ].filter(Boolean).join(' · ');
    return `
        <details class="message-reasoning" open>
            <summary class="reasoning-summary">
                <span class="reasoning-icon">💭</span>
                <span class="reasoning-label">Reasoning</span>
                ${meta ? `<span class="reasoning-meta">${escapeHtml(meta)}</span>` : ''}
            </summary>
            <div class="reasoning-body">${formatMessageContent(reasoning.content || '')}</div>
        </details>
    `;
}

function _renderToolMessageHtml(msg) {
    const display = msg && msg._display;
    if (!display) {
        // Tool result without a display block — show the raw content
        // string. (Pre-1.3.0 history may carry tool turns without
        // _display metadata.)
        const raw = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content, null, 2);
        return `
            <article class="chat-message tool-call replay-message">
                <details class="tool-call-details">
                    <summary class="tool-call-summary">
                        <span class="tool-call-icon">🔧</span>
                        <span class="tool-call-name">tool result</span>
                    </summary>
                    <div class="tool-call-body">
                        <div class="tool-call-section">
                            <div class="tool-call-label">Raw</div>
                            <pre class="tool-call-json">${escapeHtml(raw || '')}</pre>
                        </div>
                    </div>
                </details>
            </article>
        `;
    }

    const toolName = String(display.toolName || 'tool');
    const args = display.args || {};
    const result = display.result || null;
    const isError = Boolean(result && result.error);
    const statusIcon = isError ? '❌' : '✅';
    const argsJson = JSON.stringify(args, null, 2);
    const resultJson = JSON.stringify(result, null, 2);
    return `
        <article class="chat-message tool-call replay-message ${isError ? 'tool-error' : 'tool-success'}">
            <details class="tool-call-details" open>
                <summary class="tool-call-summary">
                    <span class="tool-call-icon">🔧</span>
                    <span class="tool-call-name">${escapeHtml(toolName)}</span>
                    <span class="tool-call-status">${statusIcon}</span>
                </summary>
                <div class="tool-call-body">
                    <div class="tool-call-section">
                        <div class="tool-call-label">Arguments</div>
                        <pre class="tool-call-json">${escapeHtml(argsJson)}</pre>
                    </div>
                    <div class="tool-call-section">
                        <div class="tool-call-label">Result</div>
                        <pre class="tool-call-json">${escapeHtml(resultJson)}</pre>
                    </div>
                </div>
            </details>
        </article>
    `;
}

function _renderAssistantToolCallsHtml(msg) {
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const items = calls.map((c) => {
        const name = c && c.function && c.function.name ? c.function.name : (c && c.name) || 'tool';
        let argText = '';
        try {
            const argRaw = c && c.function && c.function.arguments;
            if (typeof argRaw === 'string') {
                argText = argRaw;
            } else if (argRaw && typeof argRaw === 'object') {
                argText = JSON.stringify(argRaw, null, 2);
            }
        } catch {
            argText = '';
        }
        return `
            <details class="tool-call-details">
                <summary class="tool-call-summary">
                    <span class="tool-call-icon">📨</span>
                    <span class="tool-call-name">${escapeHtml(String(name))}</span>
                    <span class="tool-call-status">requested</span>
                </summary>
                <div class="tool-call-body">
                    <div class="tool-call-section">
                        <div class="tool-call-label">Arguments</div>
                        <pre class="tool-call-json">${escapeHtml(argText)}</pre>
                    </div>
                </div>
            </details>
        `;
    }).join('');

    const ts = Number.isFinite(msg.timestamp) ? new Date(msg.timestamp).toLocaleString() : '';
    return `
        <article class="chat-message assistant replay-message">
            <div class="message-header">
                <span class="message-role">🤖 Assistant</span>
                <span class="message-time">${escapeHtml(ts)}</span>
            </div>
            <div class="message-content"><em>Requested ${calls.length} tool call${calls.length === 1 ? '' : 's'}.</em></div>
            ${items}
        </article>
    `;
}

/* -------------------------------------------------------------------------- */
/* Internals — drop handlers                                                  */
/* -------------------------------------------------------------------------- */

function _wireDropHandlersOnce() {
    if (_dropHandlersWired) return;
    _dropHandlersWired = true;

    const dropZone = document.getElementById('replayDropZone');
    const fileInput = /** @type {HTMLInputElement|null} */(document.getElementById('replayFileInput'));

    if (dropZone) {
        dropZone.addEventListener('click', () => {
            if (fileInput) fileInput.click();
        });
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('replay-drop-active');
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('replay-drop-active');
        });
        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.classList.remove('replay-drop-active');
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            await loadFromFile(file);
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const target = /** @type {HTMLInputElement} */(e.target);
            const file = target.files && target.files[0];
            if (!file) return;
            await loadFromFile(file);
            target.value = '';
        });
    }
}

/* -------------------------------------------------------------------------- */
/* Internals — keyboard nav                                                   */
/* -------------------------------------------------------------------------- */

function _attachKeyHandler() {
    if (_keyHandler) return;
    _keyHandler = (e) => {
        const modal = document.getElementById('replayModal');
        if (!modal || !modal.classList.contains('active')) return;
        // Don't intercept arrow keys when the user is in a text field.
        const target = /** @type {HTMLElement|null} */(e.target);
        if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeReplayModal(); }
    };
    document.addEventListener('keydown', _keyHandler);
}

function _detachKeyHandler() {
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler);
        _keyHandler = null;
    }
}

/* -------------------------------------------------------------------------- */
/* Internals — small helpers                                                  */
/* -------------------------------------------------------------------------- */

function _roleIcon(role, msg) {
    if (role === 'tool') return '🔧';
    if (role === 'assistant' && !msg.content && Array.isArray(msg.tool_calls)) return '📨';
    return ({ user: '👤', assistant: '🤖', system: 'ℹ️', error: '❌' })[role] || '💬';
}

function _shortLabelForTurn(msg, idx) {
    if (!msg) return `Turn ${idx + 1}`;
    const role = String(msg.role || 'unknown');

    if (role === 'tool') {
        const display = msg._display || {};
        const name = display.toolName || 'tool result';
        return `tool · ${name}`;
    }
    if (role === 'assistant' && !msg.content && Array.isArray(msg.tool_calls)) {
        return `tool calls (${msg.tool_calls.length})`;
    }
    let text = '';
    if (Array.isArray(msg.content)) {
        const textPart = msg.content.find((c) => c && c.type === 'text');
        text = (textPart && textPart.text) || '';
    } else if (typeof msg.content === 'string') {
        text = role === 'assistant' ? stripThinkBlocks(msg.content) : msg.content;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 70) text = text.slice(0, 69) + '…';
    return text || `${role} turn`;
}

function _suggestFilename(indexEntry) {
    const slug = (indexEntry && indexEntry.title || 'conversation')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        || 'conversation';
    const id = indexEntry && indexEntry.id ? indexEntry.id : 'unknown';
    return `${slug}-${id}.aieditor.session`;
}

/* -------------------------------------------------------------------------- */
/* Boot integration — global window bindings for inline onclick handlers      */
/* -------------------------------------------------------------------------- */

/**
 * Wire the global handlers used by the modal's inline `onclick`
 * attributes and by the conversation drawer. Idempotent.
 */
export function installReplay() {
    if (typeof window === 'undefined') return;
    window.openReplayModal = openReplayModal;
    window.closeReplayModal = closeReplayModal;
    window.replayNext = next;
    window.replayPrev = prev;
    window.replayGoto = goto;
    window.replayExportConversation = exportConversationToFile;
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** @returns {ReplayState} a defensive snapshot for tests */
export function _stateSnapshotForTests() {
    return {
        indexEntry: _state.indexEntry,
        payload: _state.payload,
        meta: _state.meta,
        index: _state.index,
        sourceLabel: _state.sourceLabel,
    };
}

/** Reset module state — for tests. */
export function _resetForTests() {
    _state = { indexEntry: null, payload: null, meta: null, index: 0, sourceLabel: '' };
    _dropHandlersWired = false;
    _detachKeyHandler();
}
