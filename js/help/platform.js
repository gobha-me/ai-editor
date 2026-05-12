/**
 * Platform detection — picks `'mac'` vs `'win'` for hotkey rendering.
 *
 * Help's hotkeys page renders `mod` as ⌘ on mac and `Ctrl` on win/linux.
 * The detected default can be overridden via the platform toggle button
 * on the Hotkeys page; the override persists via Storage across reloads
 * so a user on Linux who works through mac shortcuts in documentation
 * can pin macOS rendering for their session.
 */

import { Storage } from '../core.js';

const STORAGE_KEY = 'help.platform';
const LEGACY_KEY = 'aieditor.help.platform';

/** Detect from navigator.platform / userAgentData; default to 'win'
 *  for non-mac so Linux + Windows share the Ctrl rendering. */
export function detectPlatform() {
    try {
        const ua = navigator.userAgentData;
        if (ua && typeof ua.platform === 'string') {
            return /mac|darwin/i.test(ua.platform) ? 'mac' : 'win';
        }
    } catch { /* ignore — fall through to legacy navigator.platform */ }

    const plat = String(navigator.platform || '').toLowerCase();
    if (plat.includes('mac')) return 'mac';
    return 'win';
}

/** Resolved platform — override (if set) wins over detection. */
export function getPlatform() {
    Storage.migrateLegacyKey(LEGACY_KEY, STORAGE_KEY, { transform: (s) => s });
    const override = Storage.get(STORAGE_KEY);
    if (override === 'mac' || override === 'win') return override;
    return detectPlatform();
}

/** Persist a user-chosen platform. Pass `null` to clear the override. */
export function setPlatform(plat) {
    if (plat === null) Storage.remove(STORAGE_KEY);
    else if (plat === 'mac' || plat === 'win') Storage.set(STORAGE_KEY, plat);
}

export function togglePlatform() {
    const next = getPlatform() === 'mac' ? 'win' : 'mac';
    setPlatform(next);
    return next;
}
