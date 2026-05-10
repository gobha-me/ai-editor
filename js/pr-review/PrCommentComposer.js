// @ts-check
/**
 * PR Review — small reusable comment composer.
 *
 * One textarea + Save/Cancel + busy spinner + inline error chip.
 * Reused by:
 *   - per-line `+` button (queues a draft into review-state)
 *   - per-thread `Reply` button (posts immediately via createReviewComment)
 *
 * The dock-level summary uses a plain inline `<textarea>` (one-shot,
 * no Save/Cancel — the dock's Submit button is the commit) so it does
 * NOT use this component.
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 * @module pr-review/PrCommentComposer
 */

import { getPreact } from '../utils/preact-mount.js';

const { html, useState, useEffect, useRef } = await getPreact();

/**
 * @param {{
 *   initialBody?: string,
 *   placeholder?: string,
 *   submitLabel?: string,
 *   onSave: (payload:{body:string}) => Promise<void>|void,
 *   onCancel?: () => void,
 *   busy?: boolean,
 *   error?: string|null,
 *   autoFocus?: boolean
 * }} props
 */
export function PrCommentComposer({
    initialBody = '',
    placeholder = 'Add a comment…',
    submitLabel = 'Save',
    onSave,
    onCancel,
    busy = false,
    error = null,
    autoFocus = true,
}) {
    const [body, setBody] = useState(initialBody);
    const textareaRef = useRef(null);

    useEffect(() => {
        if (autoFocus && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [autoFocus]);

    const trimmed = body.trim();
    const canSave = trimmed.length > 0 && !busy;

    function handleSubmit(e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (!canSave) return;
        onSave({ body: trimmed });
    }

    function handleKeyDown(e) {
        // Cmd+Enter / Ctrl+Enter submits — matches the chat composer convention.
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
        } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
        }
    }

    return html`
        <form class="pr-composer" onSubmit=${handleSubmit}>
            <textarea
                ref=${textareaRef}
                class="pr-composer__textarea"
                placeholder=${placeholder}
                value=${body}
                onInput=${(e) => setBody(e.target.value)}
                onKeyDown=${handleKeyDown}
                disabled=${busy}
                rows=${3}
                aria-label=${placeholder}
            ></textarea>
            ${error && html`<div class="pr-composer__error" role="alert">${error}</div>`}
            <div class="pr-composer__actions">
                ${onCancel && html`
                    <button
                        type="button"
                        class="pr__btn pr__btn--ghost"
                        onClick=${onCancel}
                        disabled=${busy}>
                        Cancel
                    </button>
                `}
                <button
                    type="submit"
                    class="pr__btn pr__btn--primary"
                    disabled=${!canSave}>
                    ${busy ? '⏳ Saving…' : submitLabel}
                </button>
            </div>
        </form>
    `;
}
