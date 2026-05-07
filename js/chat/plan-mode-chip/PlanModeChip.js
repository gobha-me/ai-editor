// @ts-check
/**
 * Plan Mode chip — Preact component (github#25, 1.10.0).
 *
 * A small inline chip in the chat input area's chip row that toggles
 * `State` plan mode on/off. When on, the chip lights up and a banner
 * appears advising the user that the LLM has been restricted to read-
 * only tools until it submits a plan for approval.
 *
 * Subscribes to `EventBus('plan-mode:changed')` so the chip stays in
 * sync if plan mode is toggled by another path (the auto-engage hook
 * in `startWorkOnIssue`, or an approval-card click flipping it off).
 *
 * @since 1.10.0 (github#25)
 * @module chat/plan-mode-chip/PlanModeChip
 */

import { getPreact } from '../../utils/preact-mount.js';
import { EventBus } from '../../core.js';
import { getPlanMode, setPlanMode } from '../state.js';

const { html, useState, useEffect } = await getPreact();

export function PlanModeChip() {
    const [active, setActive] = useState(getPlanMode());

    useEffect(() => {
        const handler = (next) => setActive(!!next);
        EventBus.on('plan-mode:changed', handler);
        return () => {
            try {
                if (typeof EventBus.off === 'function') EventBus.off('plan-mode:changed', handler);
            } catch { /* best-effort */ }
        };
    }, []);

    const onToggle = () => setPlanMode(!active);

    const className = 'plan-mode-chip' + (active ? ' plan-mode-chip--active' : '');
    const label = active ? '🛑 Plan Mode — read-only' : '📋 Plan Mode';
    const title = active
        ? 'Plan Mode is active. The LLM is restricted to read-only tools and will submit a plan for approval before executing. Click to turn off.'
        : 'Click to enter Plan Mode. The LLM will plan first, you approve, then it executes.';

    return html`
        <div class="plan-mode-chip-row">
            <button
                type="button"
                class=${className}
                title=${title}
                aria-pressed=${active}
                onClick=${onToggle}>
                ${label}
            </button>
            ${active ? html`
                <span class="plan-mode-banner" role="status">
                    The LLM will read & plan only — no edits or commits — until you approve a plan.
                </span>
            ` : null}
        </div>
    `;
}
