// @ts-check
/**
 * Merge Conflict Resolver — vertical minimap strip.
 *
 * One band per hunk in the active file. Color-coded by resolution state
 * (`unresolved` / `resolved-theirs` / `resolved-ours` / `resolved-both`).
 * Click a band → scroll the corresponding hunk into the main hunk list
 * via the surface-supplied `onJump(id)` handler, which resolves the
 * `mc-hunk-${id}` DOM node and calls `scrollIntoView`.
 *
 * Bands are equally spaced (flex-distributed) — proportional sizing
 * against `mc__main` scroll height is intentionally out of scope until
 * dogfood asks for it. The label inside each band is the 1-based hunk
 * number, matching the `Conflict N` heading in the main pane.
 *
 * @since 2.19.0 (Touch 3 Merge Conflict Resolver — slice 2)
 * @module merge-conflict/Minimap
 */

import { getPreact } from '../utils/preact-mount.js';

const { html } = await getPreact();

/**
 * @param {{
 *   hunks: Array<{id:number, lineNo:number, theirs:string[], ours:string[]}>,
 *   fileResolutions: Object<number, 'theirs'|'ours'|'both'>|null|undefined,
 *   onJump: (hunkId:number) => void,
 * }} props
 */
export function Minimap({ hunks, fileResolutions, onJump }) {
    if (!hunks || hunks.length === 0) return null;
    return html`
        <div class="mc__minimap" role="navigation" aria-label="Conflict navigation">
            ${hunks.map(h => {
                const choice = fileResolutions?.[h.id] || null;
                const status = choice ? 'resolved-' + choice : 'unresolved';
                const cls = `mc__minimap-band mc__minimap-band--${status}`;
                const title = choice
                    ? `Conflict ${h.id + 1} — resolved (took ${choice})`
                    : `Conflict ${h.id + 1} — unresolved (line ${h.lineNo})`;
                return html`
                    <button type="button"
                        key=${h.id}
                        class=${cls}
                        title=${title}
                        aria-label=${title}
                        onClick=${() => onJump(h.id)}>
                        <span class="mc__minimap-band-label">${h.id + 1}</span>
                    </button>
                `;
            })}
        </div>
    `;
}
