// @ts-check
/**
 * MemoryChip — Preact + htm component for the inline `@memory`
 * citation picker (Memory PR #8). Subscribes to the controller in
 * `../memory-chip.js` and re-renders on every state change.
 *
 * The textarea retains focus throughout; this component is presentation
 * only — `js/chat/input.js` drives navigation / selection / dismissal
 * via the controller's exported fns.
 *
 * Visual vocabulary mirrors `.mem-consent` (`js/chat/consent-card/`)
 * and `.mem-tab` (`js/settings/memory-tab/`) so the three Memory
 * surfaces feel consistent.
 *
 * @since 1.3.0 (Memory PR #8)
 * @module chat/memory-chip/MemoryChip
 */

import { getPreact } from '../../utils/preact-mount.js';
import { _getChipState, _subscribeChip } from '../memory-chip.js';

const { html, useState, useEffect } = await getPreact();

function _formatValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * @returns {any}
 */
export function MemoryChip() {
    const [snap, setSnap] = useState({ ..._getChipState() });
    useEffect(() => {
        // Subscribers receive the same mutable state object — wrap with
        // a fresh shallow copy on every notification so useState's
        // referential-equality check actually triggers a re-render.
        const off = _subscribeChip((s) => setSnap({ ...s }));
        return off;
    }, []);

    if (!snap.visible) return null;

    const noResults = snap.results.length === 0;
    const queryShown = snap.query.length > 0;

    return html`
        <div class="mem-chip" role="listbox" aria-label="Memory citations">
            <div class="mem-chip__head">
                <span class="mem-chip__title">◆ Cite memory</span>
                <span class="mem-chip__hint">
                    ${noResults
                        ? 'no matches'
                        : html`${snap.results.length} match${snap.results.length === 1 ? '' : 'es'}${queryShown ? html` for ${html`<code>${snap.query}</code>`}` : null}`}
                </span>
            </div>
            ${noResults
                ? html`<div class="mem-chip__empty">
                    ${queryShown
                        ? html`No memories match <code>${snap.query}</code>.`
                        : html`No memories yet. Add one in Settings → Memory.`}
                </div>`
                : html`<ul class="mem-chip__list">
                    ${snap.results.map((m, i) => html`
                        <${ChipRow}
                            key=${m.id || `${m.scope}:${m.key}`}
                            record=${m}
                            active=${i === snap.selectedIndex} />
                    `)}
                </ul>`}
            <div class="mem-chip__foot">
                <span><kbd class="mem-chip__kbd">↑↓</kbd> navigate</span>
                <span><kbd class="mem-chip__kbd">↵</kbd> insert</span>
                <span><kbd class="mem-chip__kbd">esc</kbd> close</span>
            </div>
        </div>
    `;
}

function ChipRow({ record, active }) {
    return html`
        <li class=${`mem-chip__item${active ? ' is-active' : ''}`}
            role="option"
            aria-selected=${active}>
            <span class="mem-chip__scope">${record.scope}</span>
            <span class="mem-chip__key">${record.key}</span>
            <span class="mem-chip__value">${_formatValue(record.value)}</span>
        </li>
    `;
}
