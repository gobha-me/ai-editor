// @ts-check
/**
 * Apply persisted visual settings to the live DOM. Extracted from
 * `js/app.js` in 1.4.4 so the workspace-settings file layer can re-paint
 * after merging `.aieditor/settings.json` overrides on `project:loaded`.
 *
 * Touches:
 *   - active theme stylesheet (via lazy import of `settings-manager.js`)
 *   - `--ui-font-size` / `--chat-font-size` / `--editor-font-size` CSS
 *     custom properties on `<html>` (uiScale + editorFontSize)
 *   - sidebar issues / PR sections (`showIssues` / `showPullRequests`)
 *   - editor line-number gutter (`showLineNumbers` via the CM6 compartment)
 *
 * Does NOT touch keybinding mode — switching between default and Vim
 * requires reloading the editor; we leave that to existing reload paths
 * (`settings:saved` listener) rather than hot-swapping mid-session.
 *
 * @since 1.4.4
 * @module utils/apply-visual-settings
 */

import { State } from '../core.js';
import { setLineNumbersVisible } from '../editor.js';

/**
 * Re-apply every visual setting that lives in the live DOM. Idempotent.
 * Called at boot from `js/app.js`, on settings save, and after the
 * workspace-settings file layer merges overrides on `project:loaded`.
 *
 * @returns {void}
 */
export function applyVisualSettings() {
    // Theme — swap the active theme stylesheet to match persisted setting.
    // Imported lazily to avoid a circular dep on settings-manager.js
    // during early app boot.
    import('../settings-manager.js').then(({ applyTheme }) => {
        applyTheme(State.settings.theme || 'refined');
    });

    // Font sizes — uiScale (1.3.13) drives both UI and chat font sizes from a 13px base.
    const uiPx = Math.round(13 * (State.settings.uiScale || 100) / 100);
    document.documentElement.style.setProperty('--ui-font-size', uiPx + 'px');
    document.documentElement.style.setProperty('--chat-font-size', uiPx + 'px');
    document.documentElement.style.setProperty('--editor-font-size', (State.settings.editorFontSize || 14) + 'px');

    // Panel visibility — null-safe.
    const issuesSections = document.querySelectorAll('[data-collapse="issuesPanelBody"]');
    const prsSections = document.querySelectorAll('[data-collapse="prsPanelBody"]');

    issuesSections.forEach((el) => {
        const section = /** @type {HTMLElement|null} */ (el.closest('.sidebar-section'));
        if (section) {
            section.style.display = State.settings.showIssues !== false ? '' : 'none';
        }
    });
    prsSections.forEach((el) => {
        const section = /** @type {HTMLElement|null} */ (el.closest('.sidebar-section'));
        if (section) {
            section.style.display = State.settings.showPullRequests !== false ? '' : 'none';
        }
    });

    applyLineNumbersVisibility();
}

/**
 * Apply the persisted `showLineNumbers` setting to the editor gutter.
 * Exported for the toolbar toggle path that wants line-numbers without
 * touching theme / fonts / panels.
 *
 * @returns {void}
 */
export function applyLineNumbersVisibility() {
    const show = State.settings.showLineNumbers !== false;

    // Primary: CM6 compartment-based toggle (reliable with CM6 layout).
    try { setLineNumbersVisible(show); } catch { /* editor not yet ready */ }

    // Fallback: CSS class on the container (covers pre-CM6-ready calls).
    const container = document.getElementById('editorContainer');
    if (!container) return;
    if (show) {
        container.classList.remove('hide-line-numbers');
    } else {
        container.classList.add('hide-line-numbers');
    }
}
