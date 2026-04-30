// @ts-check
/**
 * MemoryConsentCard — Preact + htm component for Touch 1 Flow 1
 * (`docs/design/touch-1-memory-ux/project/flow1-consent.jsx`).
 *
 * Renders inline in the chat stream when `memory_remember` returns
 * `{status: 'pending_consent', candidate_id}`. Drives a 4-state machine —
 * `open | editing | saved | dismissed` — and resolves the corresponding
 * candidate via `consentAccept` / `consentDismiss` from the consent queue.
 *
 * Two visual variants per the design: the default inline card and a
 * "quiet" single-line dashed indicator. The variant is selected by the
 * URL flag `?memoryConsentVariant=quiet` (URL-only by design — mirrors the
 * `?compression=off` and `?memoryRepoMode=on` precedents). A Settings
 * toggle is deferred to a 1.3.x patch if real-user feedback asks for it.
 *
 * @since 1.3.0 (Memory PR #6)
 * @module chat/consent-card/MemoryConsentCard
 */

import { State, EventBus } from '../../core.js';
import { getPreact } from '../../utils/preact-mount.js';
import { EmbeddingsClient } from '../../embeddings-client.js';
import {
    consentGet,
    consentAccept,
    consentDismiss,
    softDelete,
    isEnabled as fileLayerIsEnabled,
    MEMORY_EVENTS,
} from '../../intelligence/memory/index.js';

// Resolve Preact + htm once at file load. consent-card.js loads us via
// dynamic import so a bundle failure doesn't break the chat handlers'
// import graph.
const { html, useState, useEffect, useMemo } = await getPreact();

const ACTOR_USER = 'user:chat-consent';

/* -------------------------------------------------------------------------- */
/* Variant selection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Read the variant from `?memoryConsentVariant=quiet` once at module load.
 * Anything other than `quiet` (including absent) means default inline.
 *
 * @returns {"default"|"quiet"}
 */
function _readVariantFlag() {
    try {
        if (typeof window === 'undefined' || !window.location) return 'default';
        const v = new URLSearchParams(window.location.search).get('memoryConsentVariant');
        return v && v.toLowerCase() === 'quiet' ? 'quiet' : 'default';
    } catch {
        return 'default';
    }
}

const VARIANT = _readVariantFlag();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function _formatValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

function _currentBranchName() {
    return State?.currentProject?.branch || '';
}

function _filePathForCategory(category) {
    return `.aieditor/memory/${category}.md`;
}

/* -------------------------------------------------------------------------- */
/* Top-level component                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ candidateId: string }} props
 */
export function MemoryConsentCard({ candidateId }) {
    // Read the candidate once on mount. If it's gone (already accepted /
    // dismissed elsewhere — e.g. user clicked "New chat" mid-render), the
    // card renders as already-dismissed so the slot collapses cleanly.
    const initialCandidate = useMemo(() => consentGet(candidateId), [candidateId]);
    const [candidate] = useState(initialCandidate);

    /** @type {[ 'open'|'editing'|'saved'|'dismissed', (s: 'open'|'editing'|'saved'|'dismissed') => void ]} */
    const [state, setState] = useState(initialCandidate ? 'open' : 'dismissed');
    const [draft, setDraft] = useState(initialCandidate ? _formatValue(initialCandidate.value) : '');
    const [savedRecordId, setSavedRecordId] = useState(/** @type {string|null} */ (null));
    const [error, setError] = useState(/** @type {string|null} */ (null));
    const [busy, setBusy] = useState(false);

    // If another mount of the same candidate resolves first, our state
    // should reflect that. CONSENT_RESOLVED carries the candidate_id; only
    // react to events for ours.
    useEffect(() => {
        const off = EventBus.on(MEMORY_EVENTS.CONSENT_RESOLVED, (payload) => {
            if (!payload || payload.candidate_id !== candidateId) return;
            if (state === 'open' || state === 'editing') {
                if (payload.outcome === 'accepted') {
                    setSavedRecordId(payload.record_id || null);
                    setState('saved');
                } else {
                    setState('dismissed');
                }
            }
        });
        return off;
    }, [candidateId, state]);

    // Nothing to render — candidate is gone and we already collapsed.
    if (!candidate) {
        return html`<div class="mem-consent mem-consent--gone" aria-hidden="true"></div>`;
    }

    /* ------------------------------------------------------------------ */
    /* Handlers                                                           */
    /* ------------------------------------------------------------------ */

    const onAccept = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const valueToWrite = state === 'editing' && draft.length > 0
                ? draft
                : candidate.value;
            const rec = await consentAccept(candidateId, {
                value: valueToWrite,
                source: 'user_explicit',
                actor: ACTOR_USER,
                reason: state === 'editing' ? 'user accepted with edit' : 'user accepted proposal',
                embeddings: EmbeddingsClient,
                embedding_model_id: State?.settings?.embeddingModel || '',
            });
            setSavedRecordId(rec.id);
            setState('saved');
        } catch (e) {
            setError(/** @type {Error} */ (e)?.message || String(e));
        } finally {
            setBusy(false);
        }
    };

    const onDismiss = () => {
        if (busy) return;
        try {
            consentDismiss(candidateId, { reason: 'user dismissed proposal' });
        } catch (e) {
            console.warn('[consent-card] dismiss failed:', e);
        }
        setState('dismissed');
    };

    const onEdit = () => {
        if (busy) return;
        setState('editing');
    };

    const onCancelEdit = () => {
        setDraft(_formatValue(candidate.value));
        setState('open');
    };

    const onUndo = async () => {
        if (busy || !savedRecordId) return;
        setBusy(true);
        setError(null);
        try {
            await softDelete(savedRecordId, {
                actor: ACTOR_USER,
                reason: 'user undid consent',
            });
            setState('dismissed');
        } catch (e) {
            setError(/** @type {Error} */ (e)?.message || String(e));
        } finally {
            setBusy(false);
        }
    };

    /* ------------------------------------------------------------------ */
    /* Render                                                             */
    /* ------------------------------------------------------------------ */

    if (state === 'dismissed') {
        return html`<div class="mem-consent is-dismissed" aria-hidden="true"></div>`;
    }

    if (state === 'saved') {
        return html`<${SavedCard}
            candidate=${candidate}
            draft=${draft}
            recordId=${savedRecordId}
            onUndo=${onUndo}
            error=${error}
            busy=${busy}
        />`;
    }

    if (VARIANT === 'quiet' && state !== 'editing') {
        return html`<${QuietLine}
            candidate=${candidate}
            onAccept=${onAccept}
            onDismiss=${onDismiss}
            onEdit=${onEdit}
            error=${error}
            busy=${busy}
        />`;
    }

    return html`<${InlineCard}
        candidate=${candidate}
        state=${state}
        draft=${draft}
        setDraft=${setDraft}
        onAccept=${onAccept}
        onDismiss=${onDismiss}
        onEdit=${onEdit}
        onCancelEdit=${onCancelEdit}
        error=${error}
        busy=${busy}
    />`;
}

/* -------------------------------------------------------------------------- */
/* Sub-components                                                             */
/* -------------------------------------------------------------------------- */

function InlineCard({ candidate, state, draft, setDraft, onAccept, onDismiss, onEdit, onCancelEdit, error, busy }) {
    const editing = state === 'editing';
    const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onAccept();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancelEdit();
        }
    };

    return html`
        <div class="mem-consent" role="group" aria-label="Memory proposal">
            <div class="mem-consent__head">
                <span class="mem-consent__title">◆ Remember</span>
                <span class="mem-consent__scope">scope: ${candidate.scope}</span>
            </div>
            <div class="mem-consent__body">
                <div class="mem-consent__kv">
                    <span class="mem-consent__key">${candidate.key}</span><span class="mem-consent__colon">: </span>
                    ${editing
                        ? html`<input
                            class="mem-consent__input"
                            type="text"
                            value=${draft}
                            autoFocus
                            onInput=${(e) => setDraft(e.currentTarget.value)}
                            onKeyDown=${onKeyDown} />`
                        : html`<span class="mem-consent__value">${editing ? draft : _formatValue(candidate.value)}</span>`}
                </div>
                <div class="mem-consent__why">
                    Proposed by the agent. Stored as <code>user_explicit</code> if you accept.
                </div>
                ${error ? html`<div class="mem-consent__error">${error}</div>` : null}
            </div>
            <div class="mem-consent__actions">
                <span class="mem-consent__spacer"></span>
                ${editing
                    ? html`
                        <button type="button" class="mem-btn" disabled=${busy} onClick=${onCancelEdit}>Cancel</button>
                        <button type="button" class="mem-btn mem-btn--primary" disabled=${busy} onClick=${onAccept}>
                            Save edit <span class="mem-btn__kbd">↵</span>
                        </button>`
                    : html`
                        <button type="button" class="mem-btn mem-btn--ghost" disabled=${busy} onClick=${onDismiss}>Dismiss</button>
                        <button type="button" class="mem-btn" disabled=${busy} onClick=${onEdit}>Edit</button>
                        <button type="button" class="mem-btn mem-btn--primary" disabled=${busy} onClick=${onAccept}>
                            Remember <span class="mem-btn__kbd">↵</span>
                        </button>`}
            </div>
        </div>
    `;
}

function QuietLine({ candidate, onAccept, onDismiss, onEdit, error, busy }) {
    const preview = _formatValue(candidate.value);
    return html`
        <div class="mem-consent mem-consent--quiet">
            <div class="mem-consent__line"
                role="button"
                tabindex="0"
                onClick=${onEdit}
                onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(); } }}>
                <span class="mem-consent__icon">◆</span>
                <span class="mem-consent__label">Remember as ${candidate.scope} memory?</span>
                <span class="mem-consent__preview">${candidate.key}: ${preview}</span>
                <button type="button" class="mem-btn mem-btn--ghost" disabled=${busy}
                    onClick=${(e) => { e.stopPropagation(); onAccept(); }}>Save</button>
                <button type="button" class="mem-btn mem-btn--ghost" disabled=${busy} aria-label="Dismiss"
                    onClick=${(e) => { e.stopPropagation(); onDismiss(); }}>×</button>
            </div>
            ${error ? html`<div class="mem-consent__error">${error}</div>` : null}
        </div>
    `;
}

function SavedCard({ candidate, draft, recordId, onUndo, error, busy }) {
    // Branch + file path are shown only when the file layer is engaged.
    // Without file mode, "Saved to memory" is the whole story; the
    // branch/staging line would be misleading.
    const branchLine = fileLayerIsEnabled() && candidate.scope === 'workspace';
    const branch = _currentBranchName();
    const path = _filePathForCategory(candidate.category);
    const valueShown = draft && draft.length > 0 ? draft : _formatValue(candidate.value);

    return html`
        <div class="mem-consent is-saved" role="status" aria-live="polite">
            <div class="mem-consent__head">
                <span class="mem-consent__title">✓ Saved to memory</span>
                ${branchLine
                    ? html`<span class="mem-consent__scope"><code>${path}</code></span>`
                    : null}
            </div>
            <div class="mem-consent__body">
                <div class="mem-consent__kv">
                    <span class="mem-consent__key">${candidate.key}</span><span class="mem-consent__colon">: </span>
                    <span class="mem-consent__value">${valueShown}</span>
                </div>
                <div class="mem-consent__why">
                    ${branchLine
                        ? html`Will be staged with your next commit on <code>${branch || 'main'}</code>. `
                        : html`Stored locally as <code>user_explicit</code>. `}
                    ${recordId
                        ? html`<a class="mem-consent__undo"
                            role="button"
                            tabindex="0"
                            onClick=${onUndo}
                            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUndo(); } }}
                          >${busy ? 'Undoing…' : 'Undo'}</a>`
                        : null}
                </div>
                ${error ? html`<div class="mem-consent__error">${error}</div>` : null}
            </div>
        </div>
    `;
}
