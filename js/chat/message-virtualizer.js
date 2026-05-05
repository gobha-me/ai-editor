/**
 * Chat message virtualizer — keeps only a window of messages mounted in DOM.
 *
 * Why: every tool call attaches an expandable <details> with full args+result
 * JSON inline (`addToolCallMessage` in messages.js). At ~138 messages with
 * ~5 tool blocks per assistant turn, eager `renderMessages()` produces
 * thousands of DOM nodes, pinning the browser tab at 100% CPU on
 * layout/paint. Captured 2026-05-05 during a 1.6.4 dogfood session.
 *
 * Approach: render the last BATCH messages on mount; insert a top sentinel
 * sized by the unrendered remainder so the scrollbar reflects true depth.
 * An IntersectionObserver on the sentinel pages older messages in on
 * scroll-up. When the user returns to the bottom, prune the oldest tail of
 * the rendered window so we never hold more than MAX_WINDOW nodes.
 *
 * TODO(ChatHistoryStore): docs/ROADMAP.md §"Other deferred" plans a
 * `ChatHistoryStore` module that fronts `State.chatHistory`. When it lands,
 * subscribe to its append event instead of relying on `addMessage` calling
 * `notifyAppended` directly. The current wiring works because there are
 * only two live-append paths in the renderer (`addMessage` and
 * `addToolCallMessage`), both in messages.js.
 */

import { getChatContainer } from './state.js';

const BATCH = 50;          // messages loaded per scroll-up trigger
const MAX_WINDOW = 150;    // 3 * BATCH — caps mounted node count
const EST_HEIGHT = 80;     // px per unrendered message — sentinel sizing
const SCROLL_BOTTOM_PX = 50;

let _state = null;

/**
 * Mount the virtualizer over `history`. Replaces any previous mount.
 * Renders the trailing BATCH (or the full history if shorter) and sets
 * up the top sentinel + observer.
 *
 * @param {Array} history       Canonical message list (caller passes State.chatHistory)
 * @param {Function} renderOne  (msg, isLastUser) => void; appends one node to chat container
 * @param {number} lastUserIdx  Index of the most recent user message in `history`
 */
export function mountVirtualizer(history, renderOne, lastUserIdx) {
    teardownVirtualizer();

    const container = getChatContainer();
    if (!container) return;

    const start = Math.max(0, history.length - BATCH);

    const sentinel = document.createElement('div');
    sentinel.className = 'chat-messages-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.height = `${start * EST_HEIGHT}px`;
    container.appendChild(sentinel);

    _state = {
        history,
        renderOne,
        lastUserIdx,
        nextOlderIdx: start - 1,   // index of next-older message to load on expand
        sentinel,
        observer: null,
        observerActive: false,
        scrollHandler: null,
        pillEl: null,
        pendingNewCount: 0,
    };

    // Initial window render — tag each emitted node with its source idx
    for (let i = start; i < history.length; i++) {
        _renderTagged(i, history[i], i === lastUserIdx);
    }

    if (start > 0) {
        _state.observer = new IntersectionObserver((entries) => {
            for (const e of entries) if (e.isIntersecting) _expandTop();
        }, { root: container, rootMargin: '200px 0px 0px 0px' });
        _state.observer.observe(sentinel);
        _state.observerActive = true;
    }

    _state.scrollHandler = _onScroll;
    container.addEventListener('scroll', _state.scrollHandler, { passive: true });
}

export function teardownVirtualizer() {
    if (!_state) return;
    const container = getChatContainer();
    if (_state.observer) _state.observer.disconnect();
    if (container && _state.scrollHandler) {
        container.removeEventListener('scroll', _state.scrollHandler);
    }
    if (_state.pillEl) _state.pillEl.remove();
    _state = null;
}

/**
 * Notify the virtualizer that a message was just appended via `renderMessage`
 * or `addToolCallMessage`. Updates pendingNewCount + pill if the user is
 * scrolled away from bottom; otherwise prunes the top to enforce MAX_WINDOW.
 */
export function notifyAppended() {
    if (!_state) return;
    const container = getChatContainer();
    if (!container) return;

    if (_isAtBottom(container)) {
        _hidePill();
        _pruneTopIfNeeded();
    } else {
        _state.pendingNewCount += 1;
        _showPill();
    }
}

function _renderTagged(idx, msg, isLastUser) {
    const container = getChatContainer();
    if (!container) return;
    const before = container.lastElementChild;
    _state.renderOne(msg, isLastUser);
    const after = container.lastElementChild;
    // renderOne may emit zero nodes (skipped: tool-call-only assistant,
    // tool message without _display) — in that case there's nothing to tag.
    if (after && after !== before) {
        after.setAttribute('data-virt-idx', String(idx));
    }
}

function _expandTop() {
    if (!_state || _state.nextOlderIdx < 0) return;
    const container = getChatContainer();
    if (!container) return;

    const to = _state.nextOlderIdx + 1;
    const from = Math.max(0, to - BATCH);

    const prevScrollHeight = container.scrollHeight;
    const prevScrollTop = container.scrollTop;

    // Render the older batch into the container tail (renderOne appends
    // to the bottom), then move the just-emitted nodes to right after the
    // sentinel so they land at the top of the rendered region.
    const newNodes = [];
    for (let i = from; i < to; i++) {
        const before = container.lastElementChild;
        _state.renderOne(_state.history[i], i === _state.lastUserIdx);
        const after = container.lastElementChild;
        if (after && after !== before) {
            after.setAttribute('data-virt-idx', String(i));
            newNodes.push(after);
        }
    }

    const insertPoint = _state.sentinel.nextSibling;
    for (const node of newNodes) container.insertBefore(node, insertPoint);

    _state.nextOlderIdx = from - 1;
    _state.sentinel.style.height = `${Math.max(0, from) * EST_HEIGHT}px`;

    // If we've reached the head of history, stop observing.
    if (_state.nextOlderIdx < 0 && _state.observer && _state.observerActive) {
        _state.observer.unobserve(_state.sentinel);
        _state.observerActive = false;
    }

    // Preserve viewport position: content was added above the visible area.
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
}

function _pruneTopIfNeeded() {
    if (!_state || !_state.sentinel) return;
    const container = getChatContainer();
    if (!container) return;

    const tagged = container.querySelectorAll('[data-virt-idx]');
    if (tagged.length <= MAX_WINDOW) return;

    const dropCount = tagged.length - MAX_WINDOW;
    for (let i = 0; i < dropCount; i++) tagged[i].remove();

    const oldestStillMounted = parseInt(
        tagged[dropCount].getAttribute('data-virt-idx'),
        10,
    );
    _state.nextOlderIdx = oldestStillMounted - 1;
    _state.sentinel.style.height = `${(_state.nextOlderIdx + 1) * EST_HEIGHT}px`;

    // Re-engage the observer — pruning makes older messages reachable again.
    if (_state.nextOlderIdx >= 0 && _state.observer && !_state.observerActive) {
        _state.observer.observe(_state.sentinel);
        _state.observerActive = true;
    }
}

function _onScroll() {
    if (!_state) return;
    const container = getChatContainer();
    if (!container) return;
    if (_isAtBottom(container)) {
        _hidePill();
        _pruneTopIfNeeded();
    }
}

function _isAtBottom(container) {
    const { scrollTop, scrollHeight, clientHeight } = container;
    return (scrollHeight - scrollTop - clientHeight) <= SCROLL_BOTTOM_PX;
}

function _showPill() {
    if (!_state) return;
    const container = getChatContainer();
    if (!container) return;
    if (!_state.pillEl) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'chat-virt-pill';
        pill.addEventListener('click', () => {
            container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            _hidePill();
        });
        container.appendChild(pill);
        _state.pillEl = pill;
    }
    _state.pillEl.textContent = `↓ ${_state.pendingNewCount} new`;
}

function _hidePill() {
    if (!_state) return;
    if (_state.pillEl) {
        _state.pillEl.remove();
        _state.pillEl = null;
    }
    _state.pendingNewCount = 0;
}

// === Test helpers — exported under `_test*` to make intent obvious. ===

/** Force a top-expansion as if the IntersectionObserver fired. */
export function _testTriggerExpand() { _expandTop(); }

/** Force a top-prune as if the user scrolled to bottom past MAX_WINDOW. */
export function _testTriggerPruneTop() { _pruneTopIfNeeded(); }

/** Snapshot of current window state for assertions. */
export function _testGetState() {
    if (!_state) return null;
    return {
        nextOlderIdx: _state.nextOlderIdx,
        observerActive: _state.observerActive,
        pendingNewCount: _state.pendingNewCount,
        hasPill: !!_state.pillEl,
    };
}
