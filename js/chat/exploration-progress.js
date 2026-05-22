/**
 * Exploration-progress predicate for the same-tool streak guard (gitea#517).
 *
 * The agent loop in `./tool-loop-core.js` increments a `sameToolStreak` counter
 * each time the same tool name is invoked consecutively; at `SAME_TOOL_REFUSE_THRESHOLD`
 * (5 as of 2.86.0, gitea#496) the loop refuses further calls. The threshold
 * defends against args-varying loops (where the args-exact guard at threshold
 * 3 would miss), but it also tripped on legit exploration of large files
 * (paging through `read_lines`, narrowing scope via `search_in_files`).
 *
 * This module exports the pure predicate the loop consults to decide whether
 * a same-name call signals progress (hold the streak — no increment, no reset)
 * vs. stuck variation (grow the streak normally). Held tight to the two tools
 * the issue named — wider extension belongs in a later slice with its own
 * rationale per the "don't add abstractions beyond what's needed" rule.
 *
 * Pure data — no DOM, no State, no network. Importable by `node --test`.
 */

export const PAGING_PROGRESS_TOOLS = new Set(['read_lines', 'search_in_files']);

/**
 * Returns true when (toolName, prevArgs → currArgs) signals forward
 * exploration progress vs. stuck variation. Used by the agent loop to
 * decide whether to grow the same-tool streak counter.
 *
 * @param {string} toolName
 * @param {object|null} prevArgs
 * @param {object|null} currArgs
 * @returns {boolean}
 */
export function isExplorationProgress(toolName, prevArgs, currArgs) {
    if (!PAGING_PROGRESS_TOOLS.has(toolName)) return false;
    if (!prevArgs || !currArgs) return false;
    if (toolName === 'read_lines') {
        if (prevArgs.path !== currArgs.path) return false;
        return Number(currArgs.start_line) > Number(prevArgs.start_line);
    }
    if (toolName === 'search_in_files') {
        const prevPath = prevArgs.path || '';
        const currPath = currArgs.path || '';
        if (currPath && (!prevPath || currPath.length > prevPath.length)) return true;
        const prevMax = Number(prevArgs.max_results ?? 20);
        const currMax = Number(currArgs.max_results ?? 20);
        return currMax < prevMax;
    }
    return false;
}
