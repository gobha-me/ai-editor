// @ts-check
/**
 * Pure helpers for the inline `@memory` chip (Memory PR #8).
 *
 * Kept DOM-free and store-free so node:test can exercise the rules
 * without loading Preact or the IDB layer. The chip controller in
 * `js/chat/memory-chip.js` calls into here for trigger detection,
 * filtering, and citation insertion; the input handler in
 * `js/chat/input.js` calls `findActiveTrigger` on every input event.
 *
 * Wire format committed in PR #8: `[memory:<key>]` markdown reference.
 * The token is visible to the LLM as literal text and resolved via the
 * existing `memory_recall` tool — no invisible structured tags, no new
 * render path. See `docs/DESIGN-memory.md` §"Chat Citation Wire Format".
 *
 * @module chat/memory-chip/match
 */

const TRIGGER = '@memory';

/**
 * Decide whether the cursor is inside an active `@memory` trigger
 * substring and, if so, return its bounds plus the user-typed filter
 * suffix. Returns `null` when no trigger is open at the cursor.
 *
 * Rules:
 *   - The trigger token is the literal `@memory`. The chip activates only
 *     when the trigger is preceded by whitespace or by start-of-text — so
 *     we don't open the picker on every word that ends in `memory`.
 *   - The cursor (`cursorOffset`) must lie at or after the trigger's end.
 *   - Between the trigger and the cursor we accept either nothing
 *     (`@memory<cursor>`) or a single space + a non-whitespace filter
 *     (`@memory pref<cursor>`). A second whitespace after the trigger
 *     closes the active range — the user has moved on to other input.
 *
 * @param {string} text          Full textarea value.
 * @param {number} cursorOffset  Character offset of the cursor (caret).
 * @returns {{ start: number, end: number, query: string } | null}
 */
export function findActiveTrigger(text, cursorOffset) {
    if (typeof text !== 'string') return null;
    const c = Math.max(0, Math.min(
        typeof cursorOffset === 'number' ? cursorOffset : text.length,
        text.length,
    ));
    const before = text.slice(0, c);
    const idx = before.lastIndexOf(TRIGGER);
    if (idx < 0) return null;
    if (idx > 0 && !/\s/.test(before[idx - 1])) return null;
    const tail = before.slice(idx + TRIGGER.length);
    if (tail.length === 0) {
        return { start: idx, end: c, query: '' };
    }
    if (!tail.startsWith(' ')) return null;
    const filter = tail.slice(1);
    if (/\s/.test(filter)) return null;
    return { start: idx, end: c, query: filter };
}

/**
 * Score and sort `memories` against the picker's `query`. Returns the
 * top-N matches. When the query is empty, returns the most-recently
 * updated records (so the picker is useful immediately on `@memory `).
 *
 * Scoring:
 *   - 100  key starts with the query
 *   -  50  key contains the query (substring)
 *   -  10  the JSON-stringified value contains the query
 *   -   0  no match (filtered out)
 *
 * Ties broken by `updated_at` descending. Case-insensitive throughout.
 *
 * @param {Array<{key: string, value: any, updated_at?: number}>} memories
 * @param {string} query
 * @param {number} [limit=8]
 * @returns {Array<object>}
 */
export function filterMemories(memories, query, limit = 8) {
    if (!Array.isArray(memories)) return [];
    const cap = typeof limit === 'number' && limit > 0 ? limit : 8;
    const q = (typeof query === 'string' ? query : '').trim().toLowerCase();
    if (q === '') {
        return memories.slice()
            .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
            .slice(0, cap);
    }
    /** @type {Array<{m: object, score: number}>} */
    const scored = [];
    for (const m of memories) {
        if (!m) continue;
        const key = (typeof m.key === 'string' ? m.key : '').toLowerCase();
        const value = _formatValueLower(m.value);
        let score = 0;
        if (key.startsWith(q)) score = 100;
        else if (key.includes(q)) score = 50;
        else if (value.includes(q)) score = 10;
        if (score > 0) scored.push({ m, score });
    }
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.m.updated_at || 0) - (a.m.updated_at || 0);
    });
    return scored.slice(0, cap).map((s) => s.m);
}

/**
 * Format a memory key as the chosen wire-format citation token. The
 * token is what the LLM sees in the user message; `memory_recall` can
 * resolve it back to the record at tool-call time.
 *
 * @param {string} key
 * @returns {string}
 */
export function formatCitation(key) {
    if (typeof key !== 'string' || key.length === 0) return '';
    return `[memory:${key}]`;
}

/**
 * Replace the active trigger range in `text` with a citation token plus
 * a trailing space, returning the new text and the cursor position
 * (right after the inserted space — natural typing flow).
 *
 * @param {string} text
 * @param {{ start: number, end: number } | null} trigger
 * @param {string} key
 * @returns {{ text: string, cursor: number }}
 */
export function applyCitation(text, trigger, key) {
    if (typeof text !== 'string') return { text: '', cursor: 0 };
    if (!trigger || typeof trigger.start !== 'number' || typeof trigger.end !== 'number') {
        return { text, cursor: text.length };
    }
    const citation = formatCitation(key);
    if (citation === '') return { text, cursor: trigger.end };
    const insert = citation + ' ';
    const before = text.slice(0, trigger.start);
    const after = text.slice(trigger.end);
    const newText = before + insert + after;
    return { text: newText, cursor: before.length + insert.length };
}

function _formatValueLower(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.toLowerCase();
    try { return JSON.stringify(v).toLowerCase(); } catch { return String(v).toLowerCase(); }
}
