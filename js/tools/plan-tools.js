// @ts-check
/**
 * AI Editor - Plan Mode Tools (github#25, gitea#424)
 *
 * Two tools live here:
 *
 *   - `submit_plan_for_approval` (github#25, 1.10.0) — pauses the chat
 *     loop, mounts the PlanApprovalCard, settles its Promise from the
 *     user's verdict. Behavior identical to ask_user; handlers.js
 *     bypasses the 30s timeout (USER_PAUSE_TOOLS); cancel calls
 *     `cancelPlanApproval()` to release the awaited Promise.
 *
 *   - `read_approved_plan` (gitea#424, 2.52.0) — read-only view of the
 *     plan body the user just approved in this conversation. The
 *     `resolvePlanApproval` writer in `chat/state.js` captures the body
 *     into `State.approvedPlan` on `status='approved'`; this tool
 *     surfaces it back to the model during execution so it doesn't
 *     regenerate deliverable content from working memory. Empty pre-
 *     approval; cleared on new chat / conversation switch.
 *
 * `submit_plan_for_approval` contract:
 *   - Takes a single string argument `plan` (markdown).
 *   - Returns one of:
 *       { status: 'approved' }                       — user approved; chat loop calls setPlanMode(false) before next round.
 *       { status: 'rejected', feedback: string }     — user rejected with feedback; chat loop keeps planMode = true so the LLM iterates.
 *       { status: 'cancelled', cancelled: true, ... } — user hit Stop while the card was up.
 *
 * `read_approved_plan` contract:
 *   - Takes no arguments.
 *   - Returns `{ plan: string, approved_at: number }` post-approval, or
 *     `{ error: '...' }` pre-approval. Always available — `readOnly: true`
 *     so plan mode keeps it admitted; profile admission via
 *     `profile.tools.admit` (gitea#438).
 *
 * Both tools declare `readOnly: true` and are listed in every picker
 * profile's `admit:` array.
 *
 * @module tools/plan-tools
 */

import { State } from '../core.js';
import { setPendingPlanApproval, getApprovedPlan } from '../chat/state.js';

/**
 * Register submit_plan_for_approval + read_approved_plan tools.
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
        // gitea#499 — idempotency guard. If the same plan body was already
        // approved in this conversation AND any non-issue tab still carries
        // uncommitted edits, refuse the re-submission instead of mounting a
        // second approval card. The executor's prior work is in flight; a
        // fresh approval would restart it from step 1 (~2-3M tokens of waste
        // observed in the field session). Mirrors the 2.84.0 / gitea#493
        // dirty-tab idiom in `js/tools/pr-tools.js`.
        const approvedSlot = getApprovedPlan();
        if (approvedSlot && approvedSlot.plan === plan) {
            const dirtyTabs = (State.openTabs || []).filter(t => t.dirty && t.type !== 'issue');
            if (dirtyTabs.length > 0) {
                const dirty_paths = dirtyTabs.map(t => t.path);
                return {
                    error: `Plan already approved at ${new Date(approvedSlot.approvedAt).toISOString()} and ${dirty_paths.length} file(s) carry uncommitted edits (${dirty_paths.join(', ')}). Call read_approved_plan to recover the plan body and continue execution, or call commit_files to flush the in-flight edits. Do not re-submit the same plan.`,
                    code: 'already_approved',
                    dirty_paths,
                    approved_at: approvedSlot.approvedAt,
                };
            }
        }
        return new Promise((resolve) => {
            setPendingPlanApproval({ plan, resolve });
        });
    }, {
        type: 'function',
        function: {
            name: 'submit_plan_for_approval',
            description: 'Submit a structured implementation plan for the user to review. Use this when Plan Mode is active and you have finished researching — the user approves, rejects with feedback, or cancels. While awaiting the answer the chat loop is paused. After approval, Plan Mode lifts automatically, you regain full tool access for execution, and the plan stays readable via read_approved_plan so you do not have to regenerate it. Describe deliverables by intent; do not inline their production-ready text (you will regenerate it during execution, so inlining doubles the token cost).',
            parameters: {
                type: 'object',
                properties: {
                    plan: {
                        type: 'string',
                        description: 'The implementation plan as markdown. Cover: which files will change and why, which new files will be created, the order of operations, risks, and open questions. Describe each deliverable by intent (e.g. "a DESIGN.md following the parent issue\'s structure") — do NOT inline the production-ready body of any file, issue, or PR you will later create; that text is regenerated during execution and inlining it here doubles the token cost.',
                    },
                },
                required: ['plan'],
            },
        },
        readOnly: true,
        // USER_PAUSE tool — every invocation must reach the user; a cache
        // hit would silently short-circuit the approval card.
        cache: 'never',
    });

    registry.register('read_approved_plan', async () => {
        const slot = getApprovedPlan();
        if (!slot || typeof slot.plan !== 'string') {
            return { error: 'No approved plan available. Submit one via submit_plan_for_approval and wait for approval before calling read_approved_plan.' };
        }
        return { plan: slot.plan, approved_at: slot.approvedAt };
    }, {
        type: 'function',
        function: {
            name: 'read_approved_plan',
            description: 'Read the plan that the user just approved in this conversation. Call this at the start of each implementation step during execution so you implement exactly what was approved without regenerating the plan text from working memory. Returns { plan, approved_at } or an error if no plan has been approved yet (e.g. before the first submit_plan_for_approval round, or after a new chat). The slot clears on conversation switch.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        readOnly: true,
        // No args; reads the just-approved plan slot which is set by the
        // companion user-pause tool. Args-keyed cache would collide.
        cache: 'never',
    });
}
