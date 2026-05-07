// @ts-check
/**
 * Ask-user card — Preact component (github#33 Phase 1, 1.9.0).
 *
 * Renders the question + UI for whichever pending ask_user request is
 * live in `state.js`. Three modes:
 *   - single_choice  → radio buttons
 *   - multi_select   → checkboxes
 *   - free_text      → textarea only (allow_custom is implicit)
 *
 * On submit, calls `resolveUserResponse(answer)` from `state.js`. The
 * `state.js` resolver fires `ask_user:resolved`; the lifecycle wrapper
 * (`ask-user-card.js`) listens for that and unmounts this tree.
 *
 * UX rules:
 *   - When `type === 'free_text'`, the textarea is the only input.
 *   - When `type !== 'free_text'` and `allow_custom: true`, both choices
 *     and a custom textarea render; either or both can carry the answer.
 *   - When `allow_custom: false`, the textarea is hidden and a choice
 *     selection is required.
 *   - Submit is disabled until at least one input is non-empty.
 *
 * @since 1.9.0 (github#33 Phase 1)
 * @module chat/ask-user-card/AskUserCard
 */

import { getPreact } from '../../utils/preact-mount.js';
import { resolveUserResponse } from '../state.js';

const { html, useState } = await getPreact();

function _buildAnswer(initial, selectedSingle, selectedMulti, customText) {
    const trimmed = (customText || '').trim();
    if (initial.type === 'free_text') {
        return { type: 'free_text', text: trimmed };
    }
    if (initial.type === 'single_choice') {
        return {
            type: 'single_choice',
            value: selectedSingle || null,
            custom_text: trimmed || null,
        };
    }
    // multi_select
    return {
        type: 'multi_select',
        values: Array.from(selectedMulti),
        custom_text: trimmed || null,
    };
}

function _canSubmit(initial, selectedSingle, selectedMulti, customText) {
    const trimmed = (customText || '').trim();
    if (initial.type === 'free_text') return trimmed.length > 0;
    const hasChoice =
        initial.type === 'single_choice' ? !!selectedSingle :
        selectedMulti.size > 0;
    if (initial.allow_custom !== false) {
        return hasChoice || trimmed.length > 0;
    }
    return hasChoice;
}

/**
 * Initial pending bundle is passed in via props from `mountPreact`. The
 * component re-reads from props (not from a global) so the test harness
 * can pass a stub bundle without monkey-patching state.js.
 *
 * @param {{initial: {question: string, type: string, options?: Array, allow_custom?: boolean}}} props
 */
export function AskUserCard({ initial }) {
    const [submitted, setSubmitted] = useState(false);
    const [selectedSingle, setSelectedSingle] = useState('');
    const [selectedMulti, setSelectedMulti] = useState(() => new Set());
    const [customText, setCustomText] = useState('');

    if (!initial || !initial.question) {
        return html`<div class="ask-user-card ask-user-card--error">ask_user card has no pending question.</div>`;
    }

    const allowCustom = initial.allow_custom !== false;
    const showTextarea = initial.type === 'free_text' || allowCustom;
    const canSubmit = !submitted && _canSubmit(initial, selectedSingle, selectedMulti, customText);

    const onSubmit = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (!canSubmit) return;
        setSubmitted(true);
        const answer = _buildAnswer(initial, selectedSingle, selectedMulti, customText);
        resolveUserResponse(answer);
    };

    const onSingleChoice = (value) => () => setSelectedSingle(value);
    const onToggleMulti = (value) => () => {
        setSelectedMulti((prev) => {
            const next = new Set(prev);
            if (next.has(value)) next.delete(value);
            else next.add(value);
            return next;
        });
    };

    const optionsBlock = (initial.type === 'single_choice' || initial.type === 'multi_select')
        ? html`
            <div class="ask-user-card__options" role=${initial.type === 'single_choice' ? 'radiogroup' : 'group'}>
                ${(initial.options || []).map((opt) => html`
                    <label class="ask-user-card__option" key=${opt.value}>
                        <input
                            type=${initial.type === 'single_choice' ? 'radio' : 'checkbox'}
                            name="ask-user-choice"
                            value=${opt.value}
                            checked=${initial.type === 'single_choice'
                                ? selectedSingle === opt.value
                                : selectedMulti.has(opt.value)}
                            disabled=${submitted}
                            onChange=${initial.type === 'single_choice'
                                ? onSingleChoice(opt.value)
                                : onToggleMulti(opt.value)} />
                        <span class="ask-user-card__option-label">${opt.label}</span>
                        ${opt.description
                            ? html`<span class="ask-user-card__option-desc">${opt.description}</span>`
                            : null}
                    </label>
                `)}
            </div>
        `
        : null;

    return html`
        <div class=${'ask-user-card' + (submitted ? ' ask-user-card--submitted' : '')}>
            <div class="ask-user-card__header">
                <span class="ask-user-card__icon" aria-hidden="true">❓</span>
                <span class="ask-user-card__title">Question from the assistant</span>
            </div>
            <div class="ask-user-card__question">${initial.question}</div>
            ${optionsBlock}
            ${showTextarea
                ? html`
                    <label class="ask-user-card__textarea-label">
                        ${initial.type === 'free_text'
                            ? html`<span class="sr-only">Your answer</span>`
                            : html`<span class="ask-user-card__textarea-hint">Or write a custom answer:</span>`}
                        <textarea
                            class="ask-user-card__textarea"
                            rows=${initial.type === 'free_text' ? 4 : 2}
                            placeholder=${initial.type === 'free_text' ? 'Type your answer…' : 'Optional — only fill in if no choice fits.'}
                            value=${customText}
                            disabled=${submitted}
                            onInput=${(e) => setCustomText(e.currentTarget.value)}></textarea>
                    </label>
                `
                : null}
            <div class="ask-user-card__actions">
                <button
                    type="button"
                    class="ask-user-card__submit"
                    disabled=${!canSubmit}
                    onClick=${onSubmit}>
                    ${submitted ? 'Sent ✓' : 'Send answer'}
                </button>
                <span class="ask-user-card__hint">
                    The assistant is paused until you respond. Use the chat Stop button to cancel.
                </span>
            </div>
        </div>
    `;
}
