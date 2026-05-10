// @ts-check
/**
 * Parse the LLM's response for the Merge Conflict Resolver "AI resolve
 * per hunk" action.
 *
 * Tolerant parser, same shape as
 * [`js/pr-review/diagnose-parse.js`](../pr-review/diagnose-parse.js):
 *   - Strips ``` / ```json fences.
 *   - Skips leading/trailing prose by extracting the first balanced
 *     `{...}` JSON object.
 *   - Validates that `resolvedLines` is an array of strings.
 *
 * The `_extractJsonObject` body is duplicated rather than imported from
 * the PR Review module so the merge-conflict module tree stays
 * self-contained — the slice-3 revert story is "drop two new files" and
 * a cross-package import would break that.
 *
 * @since 2.21.0 (Touch 3 Merge Conflict Resolver — slice 3)
 * @module merge-conflict/ai-resolve-parse
 */

/**
 * @typedef {{ok:true, resolvedLines:string[], rationale:string}} ParseOk
 * @typedef {{ok:false, error:string}} ParseErr
 */

/**
 * @param {string|null|undefined} raw
 * @returns {ParseOk|ParseErr}
 */
export function parseAiResolveResponse(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
        return { ok: false, error: 'Empty response from model.' };
    }

    const candidate = _extractJsonObject(raw);
    if (!candidate) {
        return { ok: false, error: 'No JSON object found in response.' };
    }

    let parsed;
    try {
        parsed = JSON.parse(candidate);
    } catch (e) {
        return { ok: false, error: `JSON parse failed: ${e?.message || String(e)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'Response is not a JSON object.' };
    }

    if (!Array.isArray(parsed.resolvedLines)) {
        return { ok: false, error: 'Missing or invalid `resolvedLines`: expected an array.' };
    }
    for (let i = 0; i < parsed.resolvedLines.length; i++) {
        if (typeof parsed.resolvedLines[i] !== 'string') {
            return { ok: false, error: `Invalid \`resolvedLines[${i}]\`: expected a string.` };
        }
    }
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';

    return {
        ok: true,
        resolvedLines: parsed.resolvedLines,
        rationale
    };
}

/**
 * Strip code fences and extract the first balanced `{...}` block.
 * Returns null if no plausible object found.
 *
 * @param {string} raw
 * @returns {string|null}
 */
function _extractJsonObject(raw) {
    let stripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');

    const start = stripped.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < stripped.length; i++) {
        const ch = stripped[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return stripped.slice(start, i + 1);
        }
    }
    return null;
}
