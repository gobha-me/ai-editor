// @ts-check
/**
 * Pure log helpers for the PR Review "Diagnose & fix" action.
 *
 * `concatJobLogs` and `tailTruncate` are extracted as a standalone
 * module so node tests can exercise the math without pulling in any
 * surface that depends on `await getPreact()`. Same shape as
 * 2.13.2's `poll-cadence.js`.
 *
 * @since 2.14.0
 * @module pr-review/diagnose-logs
 */

/** Default tail cap for LLM-bound log payloads (256 KB). */
export const DEFAULT_LOG_CAP_BYTES = 256 * 1024;

/**
 * Concatenate per-job logs into a single deterministic blob.
 *
 * Sorts by job id ascending so that `concatJobLogs(shuffled)` is
 * equivalent across input orderings. Each job is preceded by a
 * header line `=== job: <name> ===` so the model can attribute
 * trace lines back to a specific job. Jobs with no log content
 * (null/empty) are skipped silently.
 *
 * @param {Array<{id:number|string, name?:string, log?:string|null}>|null|undefined} jobs
 * @returns {string}
 */
export function concatJobLogs(jobs) {
    if (!Array.isArray(jobs)) return '';
    const sorted = [...jobs]
        .filter(j => j && typeof j.log === 'string' && j.log.length > 0)
        .sort((a, b) => {
            const ai = String(a.id ?? '');
            const bi = String(b.id ?? '');
            return ai < bi ? -1 : ai > bi ? 1 : 0;
        });
    if (sorted.length === 0) return '';
    return sorted
        .map(j => `=== job: ${j.name || 'job'} ===\n\n${j.log}`)
        .join('\n\n');
}

/**
 * Tail-truncate a string to fit under `capBytes`. Keeps the **tail**
 * because CI failures cluster at the end of the log. When truncation
 * fires, prepends a `[... N bytes truncated ...]` marker so the model
 * sees that earlier output was elided.
 *
 * @param {string|null|undefined} text
 * @param {number} [capBytes=DEFAULT_LOG_CAP_BYTES]
 * @returns {{text:string, truncatedAtCap:boolean, totalBytes:number}}
 */
export function tailTruncate(text, capBytes = DEFAULT_LOG_CAP_BYTES) {
    const safe = typeof text === 'string' ? text : '';
    const cap = typeof capBytes === 'number' && capBytes > 0 ? capBytes : DEFAULT_LOG_CAP_BYTES;
    const totalBytes = safe.length;
    if (totalBytes <= cap) {
        return { text: safe, truncatedAtCap: false, totalBytes };
    }
    const droppedBytes = totalBytes - cap;
    const tail = safe.slice(droppedBytes);
    const marker = `[... ${droppedBytes} bytes truncated from head ...]\n\n`;
    return { text: marker + tail, truncatedAtCap: true, totalBytes };
}
