// @ts-check
/**
 * Test-loop state singleton.
 *
 * One in-flight loop at a time. The orchestrator writes here; the UI
 * (`./ui.js`) subscribes via `EventBus` to render the progress card live.
 *
 * Lifecycle (each transition emits `loop:state-changed`):
 *   `idle` ──start()──▶ `iterating` ──┬─▶ `awaiting_ci` ──▶ `iterating` ──┐
 *                                     └─────────────────────────────────────┤
 *                                                                          ▼
 *                                                                       `finished`
 *                                                                          │
 *                                                                          ▼
 *                                                                        `idle`
 *
 * On `abort()` the orchestrator transitions to `finished` with
 * `exitReason = 'user_abort'` and emits one final `loop:state-changed`.
 */

import { EventBus } from '../../core.js';

/**
 * @typedef {'idle'|'iterating'|'awaiting_ci'|'finished'} LoopStatus
 *
 * @typedef {Object} LoopState
 * @property {string|null}     loopId
 * @property {LoopStatus}      status
 * @property {string|null}     goal
 * @property {string|null}     testHint
 * @property {number}          iteration             1-indexed; 0 before start.
 * @property {number}          maxIterations
 * @property {number|null}     startedAt
 * @property {number|null}     finishedAt
 * @property {string|null}     lastCommitSha
 * @property {string|null}     lastCiState
 * @property {string|null}     lastCiSummary
 * @property {string|null}     exitReason
 * @property {number}          totalTokens           Approx running total.
 * @property {boolean}         abortRequested
 */

/** @type {LoopState} */
const _state = {
    loopId: null,
    status: 'idle',
    goal: null,
    testHint: null,
    iteration: 0,
    maxIterations: 0,
    startedAt: null,
    finishedAt: null,
    lastCommitSha: null,
    lastCiState: null,
    lastCiSummary: null,
    exitReason: null,
    totalTokens: 0,
    abortRequested: false,
};

/** @returns {LoopState} */
export function getState() {
    return { ..._state };
}

/** @param {Partial<LoopState>} patch */
export function patchState(patch) {
    Object.assign(_state, patch);
    EventBus.emit('loop:state-changed', getState());
}

/**
 * Initialise a fresh loop run. Returns the assigned `loopId`.
 *
 * @param {Object} opts
 * @param {string} opts.goal
 * @param {string|null} [opts.testHint]
 * @param {number} opts.maxIterations
 * @returns {string}
 */
export function startLoop({ goal, testHint, maxIterations }) {
    const loopId = `loop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    Object.assign(_state, {
        loopId,
        status: 'iterating',
        goal,
        testHint: testHint || null,
        iteration: 0,
        maxIterations,
        startedAt: Date.now(),
        finishedAt: null,
        lastCommitSha: null,
        lastCiState: null,
        lastCiSummary: null,
        exitReason: null,
        totalTokens: 0,
        abortRequested: false,
    });
    EventBus.emit('loop:state-changed', getState());
    EventBus.emit('loop:started', { loopId, goal });
    return loopId;
}

/**
 * Mark the loop as finished with an exit reason. The status becomes
 * `finished`; calling `reset()` returns to `idle`.
 *
 * @param {string} exitReason
 */
export function finishLoop(exitReason) {
    _state.status = 'finished';
    _state.exitReason = exitReason;
    _state.finishedAt = Date.now();
    EventBus.emit('loop:state-changed', getState());
    EventBus.emit('loop:finished', { loopId: _state.loopId, exitReason });
}

/** Reset back to idle (e.g., user dismissed the completed card). */
export function reset() {
    Object.assign(_state, {
        loopId: null,
        status: 'idle',
        goal: null,
        testHint: null,
        iteration: 0,
        maxIterations: 0,
        startedAt: null,
        finishedAt: null,
        lastCommitSha: null,
        lastCiState: null,
        lastCiSummary: null,
        exitReason: null,
        totalTokens: 0,
        abortRequested: false,
    });
    EventBus.emit('loop:state-changed', getState());
}

/**
 * Request abort — the orchestrator picks this up between iteration steps.
 * Idempotent.
 */
export function requestAbort() {
    if (_state.status === 'idle' || _state.status === 'finished') return;
    _state.abortRequested = true;
    EventBus.emit('loop:abort-requested', { loopId: _state.loopId });
}

/** Test seam — wipe singleton between tests. */
export function _resetForTests() {
    Object.assign(_state, {
        loopId: null,
        status: 'idle',
        goal: null,
        testHint: null,
        iteration: 0,
        maxIterations: 0,
        startedAt: null,
        finishedAt: null,
        lastCommitSha: null,
        lastCiState: null,
        lastCiSummary: null,
        exitReason: null,
        totalTokens: 0,
        abortRequested: false,
    });
}
