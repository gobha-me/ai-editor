// @ts-check
/**
 * Parse the LLM's response for the PR Review "Diagnose & fix" action.
 *
 * Tolerant parser:
 *   - Strips ``` / ```json fences.
 *   - Skips leading/trailing prose by extracting the first balanced
 *     `{...}` JSON object.
 *   - Validates that `path`, `newContent`, and `rationale` exist and
 *     are strings.
 *
 * Pure module — same shape as 2.13.2's poll-cadence helpers.
 *
 * @since 2.14.0
 * @module pr-review/diagnose-parse
 */

/**
 * @typedef {{ok:true, path:string, newContent:string, rationale:string}} ParseOk
 * @typedef {{ok:false, error:string}} ParseErr
 */

/**
 * @param {string|null|undefined} raw
 * @returns {ParseOk|ParseErr}
 */
export function parsePatchResponse(raw) {
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

    if (typeof parsed.path !== 'string' || parsed.path.length === 0) {
        return { ok: false, error: 'Missing or invalid `path`.' };
    }
    if (typeof parsed.newContent !== 'string') {
        return { ok: false, error: 'Missing or invalid `newContent`.' };
    }
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';

    return {
        ok: true,
        path: parsed.path,
        newContent: parsed.newContent,
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
