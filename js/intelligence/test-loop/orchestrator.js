// @ts-check
/**
 * Test-driven loop orchestrator (1.4.5).
 *
 * Drives a bounded agentic loop that iterates on a failing test until CI
 * passes — or one of the bounds (max iterations, wall-clock, no-progress)
 * exits the loop. Each iteration:
 *
 *   1. Build an iteration prompt (goal + last CI state + log tail).
 *   2. Hand the prompt to `handleGeneralRequest()` — the existing chat
 *      send-path, with all its tooling.
 *   3. Inspect the conversation's TaskLedger for `commit_files` invocations
 *      added during the turn. If the model committed, resolve the new branch
 *      head SHA via `Git.listBranches` and poll `Git.getCommitStatus` until
 *      it reaches a terminal state (or the configured CI poll timeout).
 *   4. CI pass → exit `ci_pass`. CI fail → fetch the failing job's log via
 *      `get_ci_logs`, feed it into the next iteration's prompt.
 *   5. No commit → exit `no_progress` (the loop won't run forever just
 *      because the model is chatting).
 *
 * Bounds:
 *   - `maxIterations` — hard counter, exit `max_iterations`.
 *   - `maxWallClockMs` — checked between iterations, exit `wall_clock`.
 *   - `maxTokensPerIteration` — passed to `handleGeneralRequest` via
 *     `chatOptions.max_tokens` (best-effort; not all providers honor it).
 *
 * No new tools required to call this — the orchestrator is reachable from
 * the chat input "🔁 Loop" trigger. The model itself only needs the static
 * tool set (`commit_files`, `edit_file`, etc., already in `coder.v1`); the
 * loop machinery sits above the chat.
 */

import { State, EventBus } from '../../core.js';
import { Git } from '../../git.js';
import { ConversationManager } from '../../chat/conversations.js';
import { CODER_V1 } from '../../profiles/coder-v1.js';
import {
    getOrCreateLedger,
    recordLoopIteration,
    updateLastLoopIteration,
} from '../../chat/task-state.js';
import { __test__ as ciTools } from '../../tools/ci-tools.js';
import * as CiLogCache from './log-cache.js';
import * as LoopState from './state.js';

const { waitForCi, getCiLogs } = ciTools;

// Drop the per-loop CI log cache when a loop finishes. The 5-entry LRU
// inside log-cache.js is a backstop; this is the primary eviction path.
EventBus.on('loop:finished', () => CiLogCache.evictAll());

/**
 * @typedef {Object} LoopBounds
 * @property {number} maxIterations
 * @property {number} maxWallClockMs
 * @property {number} maxTokensPerIteration
 * @property {number} ciPollTimeoutMs
 *
 * @typedef {Object} LoopResult
 * @property {string}  loopId
 * @property {string}  exitReason         "ci_pass" | "ci_fail" | "no_progress" | "max_iterations" | "wall_clock" | "user_abort" | "error"
 * @property {number}  iterations         Total iterations actually run.
 * @property {number}  durationMs
 * @property {string|null} lastCommitSha
 * @property {string|null} lastCiState
 */

/**
 * Look up the bounds for the current loop. Reads `State.settings.testLoop.*`
 * with safe defaults so a fresh install works without explicit configuration.
 *
 * @returns {LoopBounds}
 */
export function resolveBounds() {
    const cfg = State.settings?.testLoop || {};
    const minutes = (m) => Math.max(1, Number(m) || 0) * 60 * 1000;
    return {
        maxIterations: Math.max(1, Number(cfg.maxIterations) || 10),
        maxWallClockMs: minutes(cfg.maxWallClockMinutes ?? 30),
        maxTokensPerIteration: Math.max(500, Number(cfg.maxTokensPerIteration) || 8000),
        ciPollTimeoutMs: minutes(cfg.ciPollTimeoutMinutes ?? 5),
    };
}

/**
 * Construct the iteration prompt the loop hands off to chat. Stays
 * deliberately short — the loop's job is to inject loop context, not to
 * re-state the codebase. The model already has the active project + tool
 * inventory available.
 *
 * @param {Object} ctx
 * @param {number} ctx.iteration         1-indexed
 * @param {number} ctx.maxIterations
 * @param {string} ctx.goal
 * @param {string|null} ctx.testHint
 * @param {string|null} ctx.lastCiState
 * @param {string|null} ctx.lastCiSummary
 * @param {string|null} ctx.lastLogPath
 */
export function buildIterationPrompt({
    iteration,
    maxIterations,
    goal,
    testHint,
    lastCiState,
    lastCiSummary,
    lastLogPath,
}) {
    const lines = [
        `[Test-driven loop · iteration ${iteration} of ${maxIterations}]`,
        '',
        `Goal: ${goal}`,
    ];
    if (testHint) {
        lines.push(`Test under repair: \`${testHint}\``);
    }
    if (lastCiState) {
        lines.push('');
        lines.push(`Previous CI: **${lastCiState}** — ${lastCiSummary || '(no summary)'}`);
    }
    if (lastLogPath) {
        lines.push('');
        lines.push(`Failing job log cached at: \`${lastLogPath}\``);
        lines.push(`Inspect it with file tools: \`read_file("${lastLogPath}")\` for a head+tail summary (catches most failures near the start or end), \`scan_file("${lastLogPath}")\` for line_count + size_bytes, \`read_lines("${lastLogPath}", start, end)\` for a specific range, or \`read_file("${lastLogPath}", full=true)\` for the full log.`);
    }
    lines.push('');
    lines.push(
        iteration === 1
            ? 'Diagnose the failure, edit the relevant file(s), then call `commit_files` to push your fix. The loop will wait for CI and feed you the next failure if needed. If the goal is already met, explain that and DO NOT commit.'
            : 'Adjust your patch based on the latest CI feedback. Edit, then `commit_files` again. If you believe further changes will not help, explain why and DO NOT commit — the loop will exit.'
    );
    return lines.join('\n');
}

/**
 * Find the most-recent successful `commit_files` invocation written to the
 * conversation's TaskLedger since `sinceTime`. Returns null if none.
 *
 * @param {string} conversationId
 * @param {number} sinceTime
 */
function findRecentCommit(conversationId, sinceTime) {
    const ledger = getOrCreateLedger(conversationId, CODER_V1.name);
    if (!ledger) return null;
    const inv = [...ledger.tool_invocations].reverse().find(
        i => i.tool_id === 'commit_files' && i.invoked_at >= sinceTime && i.succeeded
    );
    return inv || null;
}

/**
 * Resolve the SHA of the current branch's HEAD via `Git.listBranches`. Used
 * after a `commit_files` lands to know what ref to wait on. Returns null if
 * the branch can't be located (e.g. detached / unknown).
 */
async function resolveCurrentBranchSha() {
    const proj = State.currentProject;
    if (!proj) return null;
    try {
        const branches = await Git.listBranches(proj.owner, proj.repo);
        const branchName = State.currentBranch || 'main';
        const match = branches.find(b => b.name === branchName);
        return match?.sha || null;
    } catch {
        return null;
    }
}

/**
 * Run the test-driven loop end-to-end.
 *
 * @param {Object} opts
 * @param {string} opts.goal
 * @param {string|null} [opts.testHint]
 * @param {LoopBounds} [opts.bounds]            Defaults from `resolveBounds()`.
 * @param {(prompt: string, chatOptions: Object) => Promise<unknown>} opts.runChatTurn
 *        Injected — the orchestrator hands each iteration's prompt to this
 *        callback. Production wires it to `handleGeneralRequest` via the
 *        chat layer; tests inject a stub that mutates the ledger directly.
 * @returns {Promise<LoopResult>}
 */
export async function runTestLoop({
    goal,
    testHint,
    bounds,
    runChatTurn,
}) {
    if (typeof runChatTurn !== 'function') {
        throw new TypeError('runTestLoop: runChatTurn callback is required');
    }
    if (typeof goal !== 'string' || !goal.trim()) {
        throw new TypeError('runTestLoop: goal must be a non-empty string');
    }

    const b = bounds || resolveBounds();
    const conversationId = ConversationManager.getActiveId();
    const surface = CODER_V1.name;
    const loopId = LoopState.startLoop({
        goal,
        testHint: testHint || null,
        maxIterations: b.maxIterations,
    });
    const startedAt = Date.now();

    let lastCommitSha = /** @type {string|null} */ (null);
    let lastCiState = /** @type {string|null} */ (null);
    let lastCiSummary = /** @type {string|null} */ (null);
    let lastLogPath = /** @type {string|null} */ (null);
    let exitReason = /** @type {string} */ ('error');

    try {
        for (let i = 1; i <= b.maxIterations; i++) {
            if (LoopState.getState().abortRequested) {
                exitReason = 'user_abort';
                break;
            }
            if (Date.now() - startedAt >= b.maxWallClockMs) {
                exitReason = 'wall_clock';
                break;
            }

            LoopState.patchState({ iteration: i, status: 'iterating' });
            const iterStartedAt = Date.now();

            recordLoopIteration({
                conversationId, surface,
                record: {
                    loop_id: loopId,
                    iteration: i,
                    started_at: iterStartedAt,
                    ended_at: null,
                    tokens_used: 0,
                    commit_sha: null,
                    ci_state: null,
                    exit_reason: 'in_flight',
                },
            });

            const prompt = buildIterationPrompt({
                iteration: i,
                maxIterations: b.maxIterations,
                goal,
                testHint: testHint || null,
                lastCiState,
                lastCiSummary,
                lastLogPath,
            });

            const turnStartedAt = Date.now();
            try {
                await runChatTurn(prompt, { max_tokens: b.maxTokensPerIteration });
            } catch (err) {
                console.warn('[test-loop] runChatTurn threw:', err);
                exitReason = 'error';
                updateLastLoopIteration({
                    conversationId, surface,
                    patch: { ended_at: Date.now(), exit_reason: 'error' },
                });
                break;
            }

            // Did the model commit during this iteration?
            const commitInv = findRecentCommit(conversationId || '', turnStartedAt);
            if (!commitInv) {
                exitReason = 'no_progress';
                updateLastLoopIteration({
                    conversationId, surface,
                    patch: { ended_at: Date.now(), exit_reason: 'no_progress' },
                });
                break;
            }

            // Resolve the new branch head SHA so we can target CI polling.
            const sha = await resolveCurrentBranchSha();
            lastCommitSha = sha;
            updateLastLoopIteration({
                conversationId, surface,
                patch: { commit_sha: sha },
            });

            if (LoopState.getState().abortRequested) {
                exitReason = 'user_abort';
                updateLastLoopIteration({
                    conversationId, surface,
                    patch: { ended_at: Date.now(), exit_reason: 'user_abort' },
                });
                break;
            }

            LoopState.patchState({
                status: 'awaiting_ci',
                lastCommitSha: sha,
            });

            // Poll CI. If we couldn't resolve a SHA, fall back to the
            // current branch name as the ref — providers accept both.
            const ciRef = sha || State.currentBranch || 'main';
            const ciResult = await waitForCi({ ref: ciRef, timeoutMs: b.ciPollTimeoutMs });
            if (ciResult.error) {
                lastCiState = 'unknown';
                lastCiSummary = ciResult.error;
                lastLogPath = null;
            } else {
                lastCiState = ciResult.state;
                lastCiSummary = ciResult.summary;
                lastLogPath = null;
                if (ciResult.state === 'failure' || ciResult.state === 'error') {
                    const logResult = await getCiLogs({ ref: ciRef });
                    if (logResult && !logResult.error && logResult.log_path) {
                        lastLogPath = logResult.log_path;
                    }
                }
            }

            LoopState.patchState({
                lastCiState,
                lastCiSummary,
            });
            updateLastLoopIteration({
                conversationId, surface,
                patch: {
                    ended_at: Date.now(),
                    ci_state: lastCiState,
                    exit_reason: lastCiState === 'success' ? 'ci_pass' : 'ci_fail',
                },
            });

            if (lastCiState === 'success') {
                exitReason = 'ci_pass';
                break;
            }

            if (i === b.maxIterations) {
                exitReason = 'max_iterations';
                break;
            }
        }
    } finally {
        LoopState.finishLoop(exitReason);
    }

    const lastIter = LoopState.getState().iteration;
    return {
        loopId,
        exitReason,
        iterations: lastIter,
        durationMs: Date.now() - startedAt,
        lastCommitSha,
        lastCiState,
    };
}

// Test seam — exposed for orchestrator.test.mjs.
export const __test__ = {
    findRecentCommit,
    resolveCurrentBranchSha,
};
