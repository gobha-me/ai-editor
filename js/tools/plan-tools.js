// @ts-check
/**
 * AI Editor - Plan Mode Tool (github#25)
 *
 * Lets the LLM submit a structured implementation plan to the user
 * during Plan Mode. Behavior identical to ask_user: the handler returns
 * a Promise that the PlanApprovalCard component resolves when the user
 * clicks Approve or Reject. From the chat loop's perspective the call
 * is just a slow-running tool — handlers.js bypasses the 30s timeout
 * (USER_PAUSE_TOOLS), and the cancel path calls cancelPlanApproval()
 * to release the awaited Promise.
 *
 * Contract:
 *   - Takes a single string argument `plan` (markdown).
 *   - Returns one of:
 *       { status: 'approved' }                       — user approved; chat loop calls setPlanMode(false) before next round.
 *       { status: 'rejected', feedback: string }     — user rejected with feedback; chat loop keeps planMode = true so the LLM iterates.
 *       { status: 'cancelled', cancelled: true, ... } — user hit Stop while the card was up.
 *
 * Always available — the registration declares `readOnly: true` so plan
 * mode keeps it admitted, and `roles: 'all'` so any role can use it.
 *
 * @module tools/plan-tools
 */

import { setPendingPlanApproval } from '../chat/state.js';

/**
 * Register the submit_plan_for_approval tool.
 * @param {{register: Function}} registry
 */
export function registerPlanTools(registry) {
    registry.register('submit_plan_for_approval', async (args) => {
        if (!args || typeof args !== 'object') {
            return { error: 'submit_plan_for_approval requires an arguments object.' };
        }
        if (typeof args.plan !== 'string' || !args.plan.trim()) {
            return { error: 'submit_plan_for_approval requires a non-empty "plan" string (markdown).' };
        }
        const plan = args.plan.trim();
        return new Promise((resolve) => {
            setPendingPlanApproval({ plan, resolve });
        });
    }, {
        type: 'function',
        function: {
            name: 'submit_plan_for_approval',
            description: 'Submit a structured implementation plan for the user to review. Use this when Plan Mode is active and you have finished researching — the user approves, rejects with feedback, or cancels. While awaiting the answer the chat loop is paused. After approval, Plan Mode lifts automatically and you regain full tool access for execution.',
            parameters: {
                type: 'object',
                properties: {
                    plan: {
                        type: 'string',
                        description: 'The full implementation plan as markdown. Cover: what files will change and why, what new files will be created, the order of operations, any risks or open questions. The user reads this verbatim before approving.',
                    },
                },
                required: ['plan'],
            },
        },
        roles: 'all',
        readOnly: true,
    });
}
