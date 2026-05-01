// @ts-check
/**
 * Workspace-settings JSON serializer / parser.
 *
 * Owns the on-disk format for `.aieditor/settings.json`:
 *
 *   ```json
 *   {
 *     "theme": "editorial",
 *     "uiScale": 110,
 *     "showLineNumbers": false
 *   }
 *   ```
 *
 * Only safelisted keys ever round-trip. Anything else is stripped at
 * parse time with a diagnostic. The writer emits keys in lexicographic
 * order so two writes of the same data produce identical bytes — the
 * commit modal's diff is meaningful, and git noise stays low when the
 * underlying State.settings dictates the same values.
 *
 * @since 1.4.4
 * @module intelligence/workspace-settings/serializer
 */

import { filterToSafelisted } from './safelist.js';

/** Path under the repo root. */
export const FILE_PATH = '.aieditor/settings.json';

/**
 * Serialize a flat object of safelisted overrides to a string suitable
 * for writing to `.aieditor/settings.json`. Drops any non-safelisted
 * keys silently (this is the writer; the reader is the diagnostic
 * surface, not the writer). Keys are sorted lexicographically.
 *
 * Empty input returns an empty `{}` rather than `''` — leaving an empty
 * file in the repo would be surprising, but `{}` is a valid no-op file
 * that future writes can extend.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {string} JSON text with two-space indentation + trailing newline.
 */
export function serialize(overrides) {
    const { accepted } = filterToSafelisted(overrides || {});
    const sortedKeys = Object.keys(accepted).sort();
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of sortedKeys) out[k] = accepted[k];
    return JSON.stringify(out, null, 2) + '\n';
}

/**
 * Parse `.aieditor/settings.json` content, strip every non-safelisted
 * key, and return the safe override map plus diagnostics. Defense in
 * depth: even if the file ships from a hostile branch with `llmApiKey`
 * baked in, the parsed result never includes it.
 *
 * @param {string} content
 * @param {{ sourcePath?: string }} [opts]
 * @returns {{
 *   overrides: Record<string, unknown>,
 *   warnings: Array<{ type: string, message: string, sourcePath?: string|null, key?: string }>,
 * }}
 */
export function parse(content, opts) {
    const sourcePath = opts && opts.sourcePath ? opts.sourcePath : null;
    /** @type {Array<{ type: string, message: string, sourcePath?: string|null, key?: string }>} */
    const warnings = [];

    if (typeof content !== 'string' || content.trim().length === 0) {
        return { overrides: {}, warnings };
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (err) {
        const msg = err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : String(err);
        warnings.push({ type: 'malformed_json', message: msg, sourcePath });
        return { overrides: {}, warnings };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warnings.push({
            type: 'not_an_object',
            message: 'expected a JSON object at the file root',
            sourcePath,
        });
        return { overrides: {}, warnings };
    }

    const { accepted, rejected } = filterToSafelisted(parsed);
    for (const key of rejected) {
        warnings.push({
            type: 'unsafe_key_stripped',
            key,
            message: `key "${key}" is not safelisted; ignored at load time`,
            sourcePath,
        });
    }

    return { overrides: accepted, warnings };
}
