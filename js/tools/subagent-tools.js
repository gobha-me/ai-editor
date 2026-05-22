// @ts-check
/**
 * AI Editor — `delegate_task` tool (2.49.0 slice 2 of github#24
 * Phase 1 sub-agents, DESIGN-sub-agents.md).
 *
 * The parent agent calls `delegate_task({task, context_hint?, profile?,
 * tools?, max_tokens?, max_dollars?, run_timeout_ms?})`; the handler
 * computes the resolved profile + per-call narrow + ceilings, builds
 * a capability summary, fires `setPendingSubAgentApproval`, and
 * awaits the user's resolution. The Preact card runs the sub-agent
 * loop (`js/chat/subagent-runner.js`) inside its Approve path and
 * resolves with the structured envelope.
 *
 * Always available — declares `readOnly: true` so Plan Mode keeps it
 * admitted (the side effect is gated by the approval card, not by the
 * tool registration). Profile-side admission via `profile.tools.admit`
 * (gitea#438): `subagent.v1.admit` deliberately omits `delegate_task`
 * (no recursion in slice 2; DESIGN §Phasing Phase 3 covers recursive
 * sub-agents); `coder.v1.admit` and `chat.v1.admit` both include it.
 *
 * @since 2.49.0
 * @module tools/subagent-tools
 */

import { State } from '../core.js';
import { setPendingSubAgentApproval } from '../chat/state.js';
import { buildCapabilitySummary } from '../chat/subagent-runner.js';
import { resolveSubAgentConfig } from '../profiles/resolve.js';

/** Default workspace-wide per-conversation cost cap, mirrored from
 *  `js/settings/tools-tab.js#_readSubAgent`. */
const DEFAULT_SESSION_CAP = 5.0;

/** Generates a transcript ID stable across the handler's awaited Promise
 *  lifetime. Format mirrors `_generateId` in `conversations.js`. */
function _generateTranscriptId() {
    return 'sa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * @param {{register: Function}} registry
 */
export function registerSubAgentTools(registry) {
    registry.register('delegate_task', async (args) => {
        if (!args || typeof args !== 'object') {
            return { error: 'delegate_task requires an arguments object.' };
        }
        if (typeof args.task !== 'string' || !args.task.trim()) {
            return { error: 'delegate_task requires a non-empty "task" string describing the sub-agent\'s focused goal.' };
        }

        const task = args.task.trim();
        const contextHint = typeof args.context_hint === 'string' ? args.context_hint : '';
        const profileName = (typeof args.profile === 'string' && args.profile.trim())
            ? args.profile.trim()
            : 'subagent.v1';

        // Per-call narrow: parent supplies a subset of the profile's
        // admitted tools to further restrict. `null` means "use the
        // profile's full admission". `buildCapabilitySummary` enforces
        // the intersection (parent cannot raise above the profile).
        const perCallNarrow = Array.isArray(args.tools) ? args.tools : null;

        // Resolved ceilings: parent may clamp DOWN (cannot raise above
        // profile defaults). Read profile defaults via slice 1's resolver.
        const profileCfg = resolveSubAgentConfig(profileName);
        const ceilings = {
            max_tokens: Number.isInteger(args.max_tokens) && args.max_tokens > 0
                ? Math.min(args.max_tokens, profileCfg.max_tokens)
                : profileCfg.max_tokens,
            max_dollars: typeof args.max_dollars === 'number' && args.max_dollars > 0
                ? Math.min(args.max_dollars, profileCfg.max_dollars)
                : profileCfg.max_dollars,
            run_timeout_ms: Number.isInteger(args.run_timeout_ms) && args.run_timeout_ms > 0
                ? Math.min(args.run_timeout_ms, profileCfg.run_timeout_ms)
                : profileCfg.run_timeout_ms,
            recursion_depth: profileCfg.recursion_depth,
        };

        // Phase 1 guards recursion at depth 0 — DESIGN §Phasing line 510
        // ("Phase 3 — Recursive sub-agents"). A future
        // `subagent_recursive.v1` profile would raise this. If a parent
        // somehow nests delegate_task (would require recursion_depth > 0
        // on the sub-agent's profile), reject before mounting a card.
        if (ceilings.recursion_depth < 0) {
            return { error: 'delegate_task: invalid recursion_depth on resolved profile (must be ≥ 0).' };
        }

        // 2.89.0 (gitea#505) — per-call model override. `''` and non-string
        // values normalize to null so the runner's resolver chain falls
        // through cleanly to profile / workspace / primary.
        const modelOverride = typeof args.model === 'string' && args.model.trim()
            ? args.model.trim()
            : null;

        const transcriptId = _generateTranscriptId();
        const capabilitySummary = buildCapabilitySummary({
            profileName,
            perCallNarrow,
            ceilings,
            modelOverride,
        });

        // Reject up-front when the profile is unknown — the resolver's
        // fallback to chat.v1 would silently widen the trust boundary.
        if (!capabilitySummary.profileRegistered) {
            return {
                error: `delegate_task: unknown profile '${profileName}'. The sub-agent must run against a registered profile to bound its tool reach.`,
            };
        }

        // 2.49.0 — workspace per-conversation cost cap check. Rejects
        // before mounting the approval card so the user isn't asked to
        // approve a call that would exceed the cap on completion.
        const overlayCap = Number(State.settings?.subagent?.sessionCap);
        const sessionCap = Number.isFinite(overlayCap) && overlayCap > 0 ? overlayCap : DEFAULT_SESSION_CAP;
        const runningSpend = Number(State.subagents?.session_cost?.dollars) || 0;
        if (runningSpend + ceilings.max_dollars > sessionCap) {
            return {
                error: `delegate_task: per-conversation cost cap of $${sessionCap.toFixed(2)} would be exceeded. ` +
                       `Running spend: $${runningSpend.toFixed(4)}; this call's max: $${ceilings.max_dollars.toFixed(2)}. ` +
                       `Raise the cap in Settings → Tools → Sub-agents, or scope smaller delegations.`,
            };
        }

        return new Promise((resolve) => {
            setPendingSubAgentApproval({
                transcriptId,
                task,
                contextHint,
                profileName,
                modelOverride,
                capabilitySummary,
                resolve,
            });
        });
    }, {
        type: 'function',
        function: {
            name: 'delegate_task',
            description: 'Spawn a bounded sub-agent on a focused investigative sub-task. The sub-agent runs against a restrictive read-only profile by default (`subagent.v1`); the user reviews + approves the delegation before the sub-agent runs. Use when the sub-task takes 5+ planned tool calls and the intermediate results would inflate your context without informing your final answer. Returns a structured `{status, summary, artifacts, cost, transcript_id}` envelope — read `summary` as the answer.',
            parameters: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'A single dense investigative task with one clear returnable answer (e.g., "Find every call site of `parseConfig` across the repo and report file paths + line numbers"). The sub-agent has a fresh context and CANNOT see your conversation — make the task self-contained.',
                    },
                    context_hint: {
                        type: 'string',
                        description: 'Optional. Facts you already know that the sub-agent would otherwise have to re-discover (e.g., relevant file paths, prior search results). Pre-loading the context cuts the sub-agent\'s token spend dramatically.',
                    },
                    profile: {
                        type: 'string',
                        description: 'Optional. The sub-agent profile (default: `subagent.v1`, restrictive read-only). Override only when the task explicitly needs broader tool reach (e.g., `coder.v1` for edits) — the user sees the profile change on the approval card and may reject.',
                    },
                    tools: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional. Per-call narrow — a subset of the profile\'s admitted tools (cannot raise above the profile). Use to tighten further (e.g., a "find call sites" task may want `search_in_files` + `read_lines` only).',
                    },
                    max_tokens: {
                        type: 'integer',
                        description: 'Optional. Token cap for the sub-agent\'s entire run (default: profile\'s ceiling). Cannot raise above the profile default.',
                    },
                    max_dollars: {
                        type: 'number',
                        description: 'Optional. Dollar cap for the sub-agent\'s entire run (default: profile\'s ceiling). Cannot raise above the profile default.',
                    },
                    run_timeout_ms: {
                        type: 'integer',
                        description: 'Optional. Wall-clock timeout in milliseconds for the sub-agent\'s entire run (default: profile\'s ceiling). Cannot raise above the profile default.',
                    },
                    model: {
                        type: 'string',
                        description: 'Optional. Per-call model override (e.g. `claude-haiku-4-5-20251001`). Defaults to the profile\'s `subagent.model`, then the workspace `subagentModelId` setting (Settings → Retrieval → Utility Models), then the paraphrase utility model, then the primary chat model. Provider stays locked to primary. The approval card surfaces the resolved model so the user sees the override before approving.',
                    },
                },
                required: ['task'],
            },
        },
        readOnly: true,
        // USER_PAUSE tool — every invocation mounts an approval card and
        // runs a real sub-agent loop on success. Cache hit would short-
        // circuit both the approval AND the sub-agent run.
        cache: 'never',
    });
}
